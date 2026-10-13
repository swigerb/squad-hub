'use strict';
/**
 * The hub's own GitHub App -- issue #177.
 *
 * Runs against a local stand-in for api.github.com (same technique as
 * github-auth-unit.js), so this stays offline and deterministic. The real
 * app does not exist yet (see the issue); every test here is written so it
 * remains correct once it does, by faking exactly the REST surface GitHub
 * documents for Apps: JWT-authenticated `/app/*` endpoints, and installation-
 * token-authenticated everything else.
 *
 * Four things this suite is built to catch, because they are the ones a
 * GitHub App credential makes dangerous if they are ever wrong:
 *   - a JWT with a bad `iss`, or an `iat`/`exp` outside GitHub's 10-minute cap
 *   - an installation token minted on every call instead of reused
 *   - a dispatch reaching a repository the App is not installed on
 *   - the private key, a JWT, or an installation token ending up somewhere
 *     it can be read back -- a log line or an API response.
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const {
  GitHubApp, HUB_CORRELATION_INPUT, EXEC_RECEIPT_NAME_RE, parseDeclaredWorkflowInputs, upstreamStatus,
} = require('../src/service/github-app');
const { RateLimiter } = require('../src/service/rate-limiter');
const { DispatchTracker, MAX_UNMATCHED_RECORD_AGE_MS } = require('../src/service/dispatch-tracker');
const { sanitizeDispatchRequest, buildWorkflowInputs } = require('../src/aca-dispatch');
const { Authenticator, MODES } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');
const { readWebSource } = require('./helpers/web-source');

// The New ACA job dialog's own request builder, loaded from the shipped
// `web/js/aca.js` so the browser-side half of a dispatch is the real code.
const dialog = { exports: {} };
new Function('module', `${readWebSource()}\nmodule.exports = { acaBuildDispatchBody, acaRepoDeclaredInputs, acaCreatedIssueOf };`)(dialog);
const { acaBuildDispatchBody, acaRepoDeclaredInputs, acaCreatedIssueOf } = dialog.exports;

let pass = 0; let fail = 0;
function check(name, fn) {
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// A real RSA key pair, generated once -- this is the "fake private key" the
// secret-leak test below greps the captured output for.
// ---------------------------------------------------------------------------
const { privateKey: FAKE_PRIVATE_KEY_OBJ } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const FAKE_PRIVATE_KEY_PEM = FAKE_PRIVATE_KEY_OBJ.export({ type: 'pkcs1', format: 'pem' });
// A substring distinctive enough that it could ONLY appear if the actual PEM
// body leaked -- not just the "-----BEGIN..." header every PEM shares.
const FAKE_KEY_SECRET_SUBSTRING = FAKE_PRIVATE_KEY_PEM.split('\n')[1];
assert.ok(FAKE_KEY_SECRET_SUBSTRING && FAKE_KEY_SECRET_SUBSTRING.length > 20,
  'the fake private key fixture did not produce a usable distinctive substring');

function b64urlDecode(s) {
  return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
}

// ---------------------------------------------------------------------------
// Identity fixtures (#258). Every `/api/aca/*` call is made as a GitHub account
// the REAL Authenticator verified through its GitHub mode -- the only mode that
// produces a verified GitHub identity -- against a stand-in for `GET /user`
// (the same seam test/github-auth-unit.js uses). The dev fixture these tests
// used before is not a substitute any more: a dev token can claim anything.
// ---------------------------------------------------------------------------
const TEST_USER = { login: 'me', id: 4242 };
const tokenFor = (user) => `gho_test_${user.login}`;
const TEST_TOKEN = tokenFor(TEST_USER);

function githubAuth({ users = [TEST_USER], owner = [TEST_USER.login], githubFetch } = {}) {
  const byToken = new Map(users.map((u) => [tokenFor(u), u]));
  return new Authenticator({
    mode: MODES.GITHUB,
    owner,
    githubFetch: githubFetch || (async (token) => {
      const u = byToken.get(token);
      if (!u) throw Object.assign(new Error('GitHub returned 401'), { status: 401 });
      return { id: u.id, login: u.login, email: null };
    }),
  });
}

/** The verified identity the hub hands the App for TEST_USER. */
const TEST_ACTOR = { id: String(TEST_USER.id), login: TEST_USER.login };

/**
 * A minimal `squad-dispatch.yml` body declaring exactly `inputNames` under
 * `workflow_dispatch.inputs`, with enough surrounding structure (a `name:`
 * key, a `jobs:` block after `on:`) to exercise the indentation-boundary
 * logic in `parseDeclaredWorkflowInputs` the same way a real workflow file
 * would, not just a single trivial block.
 */
function squadDispatchYaml(inputNames, inputDefaults = {}) {
  const lines = ['name: Squad dispatch', 'on:', '  workflow_dispatch:'];
  if (inputNames && inputNames.length) {
    lines.push('    inputs:');
    for (const name of inputNames) {
      lines.push(`      ${name}:`);
      lines.push('        description: auto-generated for tests');
      lines.push(`        required: ${name === 'issue' || name === 'prompt'}`);
      lines.push('        type: string');
      if (Object.prototype.hasOwnProperty.call(inputDefaults, name)) lines.push(`        default: ${inputDefaults[name]}`);
    }
  }
  lines.push('jobs:', '  dispatch:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo hi');
  return `${lines.join('\n')}\n`;
}

/** A workflow file around `blockLines` (the lines under `workflow_dispatch:`), for the parser tests. */
function wfYamlLines(blockLines, onLine = 'on:', dispatchLine = '  workflow_dispatch:') {
  return `${['name: Squad dispatch', onLine, dispatchLine, ...blockLines, 'jobs:', '  dispatch:', '    runs-on: ubuntu-latest'].join('\n')}\n`;
}

const LEGACY_DECLARED_INPUTS = ['issue', 'prompt'];
const MODERN_DECLARED_INPUTS = ['issue', 'prompt', 'model', 'base_branch', 'publish_pr', 'reviewer', 'watch_only', HUB_CORRELATION_INPUT];

function correlationTitle(id) {
  return `Squad dispatch [corr:${id}]`;
}

/**
 * A stand-in for api.github.com covering exactly the endpoints a GitHub App
 * calls: `/app/installations`, `/app/installations/:id/access_tokens`,
 * `/installation/repositories`, repo contents/metadata, issues, and the
 * Actions dispatch/runs endpoints. Counts calls per path so caching claims
 * can be asserted rather than asserted-about.
 */
function fakeGitHubApp({
  installations = [{ id: 1, login: 'acme' }],
  reposByInstallation = { 1: ['acme/widgets'] },
  hasWorkflow = true,
  declaredInputs = MODERN_DECLARED_INPUTS,
  inputDefaults = {},
  workflowYaml = null,
  defaultBranch = 'main',
  dispatchStatus = 204,
  issueStatus = 201,
  installationsStatus = 200,
  runsStatus = 200,
  runs = null,
  runsTotalCount = null,
  artifacts = [],
  artifactsStatus = 200,
  artifactsTotalCount = null,
  // The fake's user table (lowercase login -> numeric id) and who may use which
  // repository. `repoAccess: null` means "every known user has write
  // everywhere", which is what the pre-#258 fixtures assumed; a test that cares
  // passes `{ 'acme/widgets': { alice: 'write', bob: 'read' } }`. A value may
  // also be `{ permission, roleName, id, status, body }` to shape the answer.
  // Both are live objects on `state`, so a test can revoke access mid-flight.
  users = { [TEST_USER.login]: TEST_USER.id },
  repoAccess = null,
  // What the repository itself offers (#257). `branches` is every branch name;
  // `issues` is `[{number, title, state, pull_request}]`, or `null` for "any
  // number is an open issue" (what the pre-#257 fixtures assumed); `files`
  // overrides the repository files read for model and reviewer choices
  // (`null` is a 404, `{status}` an HTTP failure, `{raw}` a literal body).
  branches = ['main', 'release', 'feature-x'],
  issues = null,
  files = {},
  now = () => Date.now(),
} = {}) {
  const calls = { total: 0, byPath: {} };
  const seenAuthHeaders = [];
  const state = {
    tokenMints: 0, dispatches: [], createdIssues: [], tokenMintBodies: [], permissionChecks: [], users, repoAccess, searches: [], branches, issues, files,
  };
  const defaultFiles = {
    '.squad/config.json': { defaultModel: 'claude', agentModelOverrides: { scribe: 'a-model' } },
    '.squad/casting/registry.json': {
      agents: {
        someone: { status: 'active', role: 'Reviewer' }, octocat: { status: 'active' }, alice: { status: 'active' }, retired: { status: 'retired' },
      },
    },
  };
  const defaultRuns = () => [{
    id: 555, status: 'in_progress', conclusion: null, head_branch: defaultBranch, created_at: new Date().toISOString(), display_title: 'Squad dispatch (run 555)',
  }];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.total += 1;
      const key = `${req.method} ${req.url.split('?')[0]}`;
      calls.byPath[key] = (calls.byPath[key] || 0) + 1;
      seenAuthHeaders.push(req.headers.authorization || '');

      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };

      if (req.url.startsWith('/app/installations') && req.method === 'GET') {
        if (installationsStatus !== 200) return json(installationsStatus, { message: 'upstream refused in fake' });
        // Paginated by `page`/`per_page`, same contract as the real API --
        // a page past the end of `installations` answers an empty array, the
        // signal `_listInstallations` stops on (#213).
        const q = new URL(req.url, 'http://x').searchParams;
        const perPage = Number(q.get('per_page')) || installations.length || 1;
        const page = Number(q.get('page')) || 1;
        const slice = installations.slice((page - 1) * perPage, page * perPage);
        return json(200, slice.map((i) => ({ id: i.id, account: { login: i.login } })));
      }

      const tokenMatch = req.url.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (tokenMatch && req.method === 'POST') {
        state.tokenMints += 1;
        let parsedBody = {};
        try { parsedBody = body ? JSON.parse(body) : {}; } catch { /* no body sent */ }
        state.tokenMintBodies.push({ installationId: Number(tokenMatch[1]), body: parsedBody });
        return json(201, {
          token: `ghs_fake_${state.tokenMints}`,
          expires_at: new Date(now() + 60 * 60 * 1000).toISOString(),
        });
      }

      if (req.url.startsWith('/installation/repositories') && req.method === 'GET') {
        // Every real request in this fake carries SOME installation token;
        // which installation it belongs to is not recoverable from the
        // token string alone in this simplified fake, so it returns the
        // union -- tests that care about per-installation scoping configure
        // a single installation. Paginated the same way as installations
        // above (#213).
        const all = Object.values(reposByInstallation).flat();
        const q = new URL(req.url, 'http://x').searchParams;
        const perPage = Number(q.get('per_page')) || all.length || 1;
        const page = Number(q.get('page')) || 1;
        const slice = all.slice((page - 1) * perPage, page * perPage);
        return json(200, { repositories: slice.map((full_name) => ({ full_name })) });
      }

      if (req.url.includes('/contents/.github/workflows/squad-dispatch.yml')) {
        if (hasWorkflow === 'error') return json(500, { message: 'internal error' });
        if (!hasWorkflow) return json(404, { message: 'Not Found' });
        // `workflowYaml` is the file as written (comments, odd layouts); `declaredInputs` is then
        // what GitHub itself would accept, which is the truth the hub's own reading is tested against.
        const yaml = workflowYaml || squadDispatchYaml(declaredInputs, inputDefaults);
        return json(200, { sha: 'deadbeef', content: Buffer.from(yaml, 'utf8').toString('base64'), encoding: 'base64' });
      }

      const artifactsMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/artifacts(\?.*)?$/);
      if (artifactsMatch && req.method === 'GET') {
        if (artifactsStatus !== 200) return json(artifactsStatus, { message: 'artifact listing refused in fake' });
        const list = typeof artifacts === 'function' ? artifacts(Number(artifactsMatch[3])) : artifacts;
        return json(200, {
          total_count: artifactsTotalCount != null ? artifactsTotalCount : list.length,
          artifacts: list,
        });
      }

      const singleRunMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)$/);
      if (singleRunMatch && req.method === 'GET') {
        const id = Number(singleRunMatch[3]);
        const list = runs || defaultRuns();
        const match = list.find((r) => r.id === id);
        if (!match) return json(404, { message: 'not found' });
        return json(200, {
          id: match.id,
          status: match.status,
          conclusion: match.conclusion || null,
          run_attempt: match.run_attempt || 1,
          html_url: match.html_url || `https://github.com/${singleRunMatch[1]}/${singleRunMatch[2]}/actions/runs/${match.id}`,
        });
      }

      const permissionMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)\/permission$/);
      if (permissionMatch && req.method === 'GET') {
        const [, owner, repo] = permissionMatch;
        const login = decodeURIComponent(permissionMatch[3]);
        state.permissionChecks.push({ owner, repo, login, authorization: req.headers.authorization || '' });
        const knownId = state.users[login.toLowerCase()];
        if (knownId === undefined) return json(404, { message: 'Not Found' });
        const grants = state.repoAccess
          ? ((state.repoAccess[`${owner}/${repo}`] || {})[login.toLowerCase()] || 'none')
          : 'write';
        const grant = typeof grants === 'string' ? { permission: grants } : grants;
        if (grant.status && grant.status !== 200) return json(grant.status, { message: 'permission lookup refused in fake' });
        if (grant.destroy) return req.socket.destroy();
        if (grant.raw !== undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(grant.raw); }
        if (grant.body !== undefined) return json(200, grant.body);
        return json(200, {
          permission: grant.permission,
          role_name: grant.roleName || grant.permission,
          user: { login, id: grant.id !== undefined ? grant.id : knownId },
        });
      }

      const contentsMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(\.squad\/[^?]+)/);
      if (contentsMatch && req.method === 'GET') {
        const filePath = decodeURIComponent(contentsMatch[3]);
        const all = { ...defaultFiles, ...state.files };
        const entry = Object.prototype.hasOwnProperty.call(all, filePath) ? all[filePath] : null;
        if (entry === null) return json(404, { message: 'Not Found' });
        if (entry.status) return json(entry.status, { message: 'contents refused in fake' });
        const text = entry.raw !== undefined ? entry.raw : JSON.stringify(entry);
        return json(200, { type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') });
      }

      const branchListMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/branches(\?.*)?$/);
      if (branchListMatch && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const perPage = Number(q.get('per_page')) || 30;
        const page = Number(q.get('page')) || 1;
        if (state.branches === 'error') return json(500, { message: 'branches refused in fake' });
        return json(200, state.branches.slice((page - 1) * perPage, page * perPage).map((name) => ({ name })));
      }
      const branchOneMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/);
      if (branchOneMatch && req.method === 'GET') {
        if (state.branches === 'error') return json(500, { message: 'branch lookup refused in fake' });
        const name = branchOneMatch[3].split('/').map(decodeURIComponent).join('/');
        return state.branches.includes(name) ? json(200, { name }) : json(404, { message: 'Branch not found' });
      }

      const issueOneMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
      if (issueOneMatch && req.method === 'GET') {
        const number = Number(issueOneMatch[3]);
        if (state.issues === 'error') return json(500, { message: 'issue lookup refused in fake' });
        if (state.issues === null) return json(200, { number, state: 'open', title: `Issue ${number}` });
        const hit = state.issues.find((i) => i.number === number);
        return hit ? json(200, hit) : json(404, { message: 'Not Found' });
      }

      if (req.url.startsWith('/search/issues') && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const query = q.get('q') || '';
        state.searches.push(query);
        if (state.issues === 'error') return json(500, { message: 'search refused in fake' });
        const phrase = (query.match(/"([^"]*)"/) || [])[1] || '';
        const perPage = Number(q.get('per_page')) || 30;
        const page = Number(q.get('page')) || 1;
        // Real search honors is:issue and is:open; `searchLeaksPrs` fixtures
        // can set `state.leakPrs` to prove the hub does not rely on that.
        const matching = (state.issues || [])
          .filter((i) => (state.leakPrs || (!i.pull_request && i.state === 'open')))
          .filter((i) => !phrase || i.title.toLowerCase().includes(phrase.toLowerCase()));
        return json(200, { total_count: matching.length, items: matching.slice((page - 1) * perPage, page * perPage) });
      }

      const repoMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)$/);
      if (repoMatch && req.method === 'GET') {
        return json(200, { default_branch: defaultBranch });
      }

      const issuesMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/issues$/);
      if (issuesMatch && req.method === 'POST') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        if (issueStatus !== 201) return json(issueStatus, { message: 'issue creation refused in fake' });
        state.createdIssues.push(parsed);
        const number = 100 + state.createdIssues.length;
        return json(201, { number, html_url: `https://github.com/${issuesMatch[1]}/${issuesMatch[2]}/issues/${number}` });
      }

      const dispatchMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/squad-dispatch\.yml\/dispatches$/);
      if (dispatchMatch && req.method === 'POST') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        // GitHub answers 422 for an input the workflow does not declare; it
        // does not ignore it, and nothing is dispatched.
        const undeclared = Object.keys(parsed.inputs || {}).filter((k) => !declaredInputs.includes(k));
        if (undeclared.length) return json(422, { message: `Unexpected inputs provided: ${JSON.stringify(undeclared)}` });
        state.dispatches.push({ owner: dispatchMatch[1], repo: dispatchMatch[2], ...parsed });
        // A function answers per attempt (1-based), so a test can fail one dispatch and accept the next.
        const status = typeof dispatchStatus === 'function' ? dispatchStatus(state.dispatches.length) : dispatchStatus;
        if (status !== 204) {
          return json(status, { message: 'dispatch refused in fake' });
        }
        res.writeHead(204);
        return res.end();
      }

      const runsMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/squad-dispatch\.yml\/runs/);
      if (runsMatch && req.method === 'GET') {
        if (runsStatus !== 200) return json(runsStatus, { message: 'run listing refused in fake' });
        const list = runs || defaultRuns();
        const withDefaults = list.map((r) => ({
          id: r.id,
          status: r.status,
          conclusion: r.conclusion || null,
          run_attempt: r.run_attempt || 1,
          html_url: r.html_url || `https://github.com/acme/widgets/actions/runs/${r.id}`,
          created_at: r.created_at || new Date().toISOString(),
          head_branch: r.head_branch || defaultBranch,
          display_title: r.display_title || '',
        }));
        // Real GitHub supports `created=>=<ISO>` on this endpoint, bounding
        // BOTH the returned page and `total_count` to runs created at or
        // after that instant. `resolveRunStatus`'s dispatch-time candidate
        // window relies on exactly this real-server behavior (#247, finding
        // 2) -- so the fake reproduces it rather than always returning the
        // whole fixture regardless of the query, which would hide the bug
        // the production code was fixed to avoid.
        const q = new URL(req.url, 'http://x').searchParams;
        const created = q.get('created');
        const cutoffMatch = created && created.match(/^>=(.+)$/);
        const windowed = cutoffMatch
          ? withDefaults.filter((r) => new Date(r.created_at).getTime() >= new Date(cutoffMatch[1]).getTime())
          : withDefaults;
        // Real pagination too (newest first, same convention GitHub itself
        // uses): `total_count` reflects every run matching the query
        // (`event` + `created`, when given), while `workflow_runs` is only
        // this one `per_page`-sized page of it. A fixture with more
        // in-window runs than `per_page` genuinely gets truncated here, the
        // same way a real `per_page=20` repository history would.
        const perPage = Number(q.get('per_page')) || windowed.length || 1;
        const page = Number(q.get('page')) || 1;
        const sorted = [...windowed].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        const pageItems = sorted.slice((page - 1) * perPage, page * perPage);
        return json(200, {
          total_count: runsTotalCount != null ? runsTotalCount : windowed.length,
          workflow_runs: pageItems,
        });
      }

      return json(404, { message: 'not found in fake' });
    });
  });
  return { server, calls, state, seenAuthHeaders };
}


function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function apiRequest(port, path, token, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: b });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

(async () => {
  // =========================================================================
  // Not configured: the 501 path, both ways it can happen
  // =========================================================================

  check('with no appId/privateKey at all, the App is disabled with a clear reason', () => {
    const app = new GitHubApp({ appId: null, privateKey: null });
    assert.strictEqual(app.enabled, false);
    assert.match(app.disabledReason(), /not configured/);
  });

  check('an appId with no private key is still disabled', () => {
    const app = new GitHubApp({ appId: '123', privateKey: null });
    assert.strictEqual(app.enabled, false);
  });

  check('a private key with no appId is still disabled', () => {
    const app = new GitHubApp({ appId: null, privateKey: FAKE_PRIVATE_KEY_PEM });
    assert.strictEqual(app.enabled, false);
  });

  check('a garbage private key disables the App with a clear reason, not a throw', () => {
    const app = new GitHubApp({ appId: '123', privateKey: 'this is not a PEM key at all' });
    assert.strictEqual(app.enabled, false);
    assert.match(app.disabledReason(), /could not be parsed/);
  });

  check('a real-looking but structurally invalid PEM also disables rather than throws', () => {
    const app = new GitHubApp({
      appId: '123',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nbm90IHJlYWxseSBhIGtleQ==\n-----END RSA PRIVATE KEY-----\n',
    });
    assert.strictEqual(app.enabled, false);
  });

  check('a valid key and appId enable the App', () => {
    const app = new GitHubApp({ appId: '123', privateKey: FAKE_PRIVATE_KEY_PEM });
    assert.strictEqual(app.enabled, true);
    assert.strictEqual(app.disabledReason(), null);
  });

  check('a private key env var with literal backslash-n newlines still parses', () => {
    const escaped = FAKE_PRIVATE_KEY_PEM.replace(/\n/g, '\\n');
    const app = new GitHubApp({ appId: '123', privateKey: escaped });
    assert.strictEqual(app.enabled, true, 'a key pasted into a single-line env var was rejected');
  });

  await checkAsync('GET /api/aca/repos answers 501 with a reason when the App env vars are absent', async () => {
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: null, privateKey: null }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
    const r = await apiRequest(addr.port, '/api/aca/repos', token);
    await svc.close();
    assert.strictEqual(r.status, 501, JSON.stringify(r));
    assert.ok(r.body && typeof r.body.reason === 'string' && r.body.reason.length > 0,
      'a 501 must carry a short human reason');
    assert.ok(!('error' in r.body), 'the 501 path uses `reason`, not `error`, per the issue');
  });

  // #233, a fix-up from #180's review: the web UI's status card must never
  // call GET /api/aca/repos or GET /api/aca/dispatches on an unconfigured
  // hub, so it needs a route that answers 200 either way to decide that
  // first. GET /api/aca/status is that route -- always 200, never 501.
  await checkAsync('GET /api/aca/status answers 200 with enabled: false and a reason when the App is not configured', async () => {
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: null, privateKey: null }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
    const r = await apiRequest(addr.port, '/api/aca/status', token);
    await svc.close();
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.body.enabled, false);
    assert.ok(typeof r.body.reason === 'string' && r.body.reason.length > 0,
      'a disabled status must still carry a short human reason');
  });

  await checkAsync('GET /api/aca/status answers 200 with enabled: true and a null reason when the App is configured', async () => {
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '123', privateKey: FAKE_PRIVATE_KEY_PEM }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
    const r = await apiRequest(addr.port, '/api/aca/status', token);
    await svc.close();
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.body.enabled, true);
    assert.strictEqual(r.body.reason, null);
  });

  await checkAsync('GET /api/aca/status never spends the shared read rate-limit budget', async () => {
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '123', privateKey: FAKE_PRIVATE_KEY_PEM }),
      acaReadRateLimiter: new RateLimiter({ limit: 1, windowMs: 60000 }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
    // The read limiter above allows only ONE call/minute. If GET
    // /api/aca/status spent that budget, the second and third calls here
    // would 429; since it spends no GitHub API call, it must never check
    // (let alone exhaust) that limiter at all.
    const r1 = await apiRequest(addr.port, '/api/aca/status', token);
    const r2 = await apiRequest(addr.port, '/api/aca/status', token);
    const r3 = await apiRequest(addr.port, '/api/aca/status', token);
    await svc.close();
    assert.strictEqual(r1.status, 200, JSON.stringify(r1));
    assert.strictEqual(r2.status, 200, JSON.stringify(r2));
    assert.strictEqual(r3.status, 200, JSON.stringify(r3));
  });

  await checkAsync('POST /api/aca/dispatch also answers 501 when a garbage key disabled the App', async () => {
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: 'garbage' }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', issue: 1, prompt: 'hi' },
    });
    await svc.close();
    assert.strictEqual(r.status, 501, JSON.stringify(r));
    assert.match(r.body.reason, /could not be parsed/);
  });

  await checkAsync('GET /api/aca/dispatches answers 501 the same way', async () => {
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: null, privateKey: null }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
    const r = await apiRequest(addr.port, '/api/aca/dispatches', token);
    await svc.close();
    assert.strictEqual(r.status, 501, JSON.stringify(r));
  });

  // =========================================================================
  // The App JWT: claims, clock-drift backdating, GitHub's 10-minute cap
  // =========================================================================

  check('the JWT carries iss = the App id, in the payload', () => {
    const app = new GitHubApp({ appId: '98765', privateKey: FAKE_PRIVATE_KEY_PEM, now: () => 1_700_000_000_000 });
    const jwt = app._appJwt();
    const [, payloadPart] = jwt.split('.');
    const payload = b64urlDecode(payloadPart);
    assert.strictEqual(payload.iss, '98765');
  });

  check('iat is backdated to absorb clock drift, not set to "now"', () => {
    const nowMs = 1_700_000_000_000;
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, now: () => nowMs });
    const [, payloadPart] = app._appJwt().split('.');
    const payload = b64urlDecode(payloadPart);
    const nowSec = Math.floor(nowMs / 1000);
    assert.ok(payload.iat < nowSec, 'iat was not backdated at all');
    assert.ok(nowSec - payload.iat <= 120, `iat was backdated by more than two minutes: ${nowSec - payload.iat}s`);
  });

  check('exp - iat stays within GitHub\'s 10-minute cap', () => {
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, now: () => Date.now() });
    const [, payloadPart] = app._appJwt().split('.');
    const payload = b64urlDecode(payloadPart);
    assert.ok(payload.exp > payload.iat, 'exp must be after iat');
    assert.ok(payload.exp - payload.iat <= 600, `exp-iat exceeded GitHub's 600s cap: ${payload.exp - payload.iat}`);
  });

  check('the JWT is RS256-signed and verifies against the matching public key', () => {
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, now: () => Date.now() });
    const jwt = app._appJwt();
    const [headerPart, payloadPart, sigPart] = jwt.split('.');
    const header = b64urlDecode(headerPart);
    assert.strictEqual(header.alg, 'RS256');
    const signingInput = `${headerPart}.${payloadPart}`;
    const sig = Buffer.from(sigPart, 'base64url');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(signingInput), FAKE_PRIVATE_KEY_OBJ, sig);
    assert.strictEqual(ok, true, 'the JWT signature does not verify against the App\'s own key');
  });

  check('a JWT signed by this App does NOT verify against a different App\'s key', () => {
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, now: () => Date.now() });
    const jwt = app._appJwt();
    const [headerPart, payloadPart, sigPart] = jwt.split('.');
    const signingInput = `${headerPart}.${payloadPart}`;
    const sig = Buffer.from(sigPart, 'base64url');
    const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ok = crypto.verify('RSA-SHA256', Buffer.from(signingInput), otherKey, sig);
    assert.strictEqual(ok, false, 'a JWT verified against the wrong key -- the signature is not doing its job');
  });

  // =========================================================================
  // Installation token caching: reused until near expiry, refreshed after
  // =========================================================================

  await checkAsync('the same installation token is reused across calls, not re-minted', async () => {
    let nowMs = 1_700_000_000_000;
    const { server, state } = fakeGitHubApp({ now: () => nowMs });
    const port = await listen(server);
    const app = new GitHubApp({
      appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}`, now: () => nowMs,
    });
    const t1 = await app._installationToken(1);
    const t2 = await app._installationToken(1);
    server.close();
    assert.strictEqual(t1, t2, 'a second call within the token\'s lifetime minted a new one');
    assert.strictEqual(state.tokenMints, 1, `expected exactly one mint, got ${state.tokenMints}`);
  });

  await checkAsync('a token close to expiry is refreshed, not reused', async () => {
    let nowMs = 1_700_000_000_000;
    const { server, state } = fakeGitHubApp({ now: () => nowMs });
    const port = await listen(server);
    const app = new GitHubApp({
      appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}`, now: () => nowMs,
    });
    await app._installationToken(1);
    // The fake mints a token good for one hour. Jump to 59 minutes and
    // 10 seconds later -- inside the refresh buffer -- and the SAME call
    // must mint a new one rather than hand back the stale token.
    nowMs += 59 * 60 * 1000 + 10 * 1000;
    const second = await app._installationToken(1);
    server.close();
    assert.strictEqual(state.tokenMints, 2, `expected a refresh near expiry, got ${state.tokenMints} mints`);
    assert.ok(second.startsWith('ghs_fake_2'), 'the refreshed token was not the newly minted one');
  });

  await checkAsync('a token well inside its lifetime is NOT refreshed early', async () => {
    let nowMs = 1_700_000_000_000;
    const { server, state } = fakeGitHubApp({ now: () => nowMs });
    const port = await listen(server);
    const app = new GitHubApp({
      appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}`, now: () => nowMs,
    });
    await app._installationToken(1);
    nowMs += 30 * 60 * 1000; // 30 minutes into a 60-minute token
    await app._installationToken(1);
    server.close();
    assert.strictEqual(state.tokenMints, 1, 'a token was refreshed well before it needed to be');
  });

  await checkAsync('two different installations get two independently-cached tokens', async () => {
    const { server, state } = fakeGitHubApp({ installations: [{ id: 1, login: 'acme' }, { id: 2, login: 'other' }] });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}`, now: () => Date.now() });
    const a = await app._installationToken(1);
    const b = await app._installationToken(2);
    await app._installationToken(1);
    await app._installationToken(2);
    server.close();
    assert.notStrictEqual(a, b);
    assert.strictEqual(state.tokenMints, 2, 'each installation should mint exactly once, then be cached');
  });

  // =========================================================================
  // Repo allow-listing
  // =========================================================================

  await checkAsync('a repo the App IS installed on is found', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets', 'acme/gadgets'] } });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}`, now: () => Date.now() });
    const found = await app.findInstallation('acme', 'widgets');
    server.close();
    assert.ok(found, 'a genuinely installed repo was not found');
    assert.strictEqual(found.installationId, 1);
  });

  await checkAsync('a repo the App is NOT installed on is refused, not guessed at', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}`, now: () => Date.now() });
    const found = await app.findInstallation('someone-else', 'unrelated-repo');
    server.close();
    assert.strictEqual(found, null);
  });

  await checkAsync('the dispatch route refuses a repo the App is not installed on, with 403', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'not-installed/here', issue: 1, prompt: 'do it' },
    });
    await svc.close();
    server.close();
    assert.strictEqual(r.status, 403, JSON.stringify(r));
    assert.match(r.body.error, /not available to your GitHub account.*installed/);
  });

  // =========================================================================
  // The dispatch route, end to end against the fake
  // =========================================================================

  await checkAsync('a dispatch against an installed repo succeeds, sends a hub correlation id, and keeps it off the API response', async () => {
    const { server, state } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', issue: 42, prompt: 'do the thing', model: 'claude', publishPr: true },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.body.issue.number, 42);
    assert.strictEqual(r.body.runUrl, 'https://github.com/acme/widgets/actions/workflows/squad-dispatch.yml');
    assert.strictEqual(state.dispatches.length, 1);
    assert.strictEqual(state.dispatches[0].inputs.issue, '42');
    assert.strictEqual(state.dispatches[0].inputs.prompt, 'do the thing');
    assert.strictEqual(state.dispatches[0].inputs.model, 'claude');
    assert.strictEqual(state.dispatches[0].inputs.publish_pr, 'true');
    assert.match(state.dispatches[0].inputs.hub_correlation_id, /^[0-9a-f]{32}$/);
    assert.ok(!Object.prototype.hasOwnProperty.call(r.body, 'correlationId'));
    const stored = [...svc.dispatchTracker._byUser.values()][0][0];
    assert.strictEqual(stored.correlationId, state.dispatches[0].inputs.hub_correlation_id);
    assert.strictEqual(stored.correlationSupported, true);
    // trackerId: the hub's own stable, opaque identifier for this dispatch --
    // distinct from the internal correlationId used to match the Actions run
    // (never returned here) -- and the SAME id a later GET /api/aca/dispatches
    // exposes as `.id`, so a client can bind its own pending row to this
    // exact record (see #245's foundation for #178/#237's trackAcaDispatch).
    assert.match(r.body.trackerId, /^[0-9a-f-]{36}$/, 'trackerId is a stable opaque id');
    assert.strictEqual(r.body.trackerId, stored.id);
    const getR = await apiRequest(addr.port, '/api/aca/dispatches', token);
    await svc.close();
    server.close();
    assert.strictEqual(getR.status, 200, JSON.stringify(getR));
    assert.strictEqual(getR.body.dispatches[0].id, r.body.trackerId, 'GET /api/aca/dispatches rows carry the same id the POST returned');
  });

  await checkAsync('two concurrent same-repo same-issue POST dispatches each get a distinct trackerId, correctly mapped by GET', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const [r1, r2] = await Promise.all([
      apiRequest(addr.port, '/api/aca/dispatch', token, { method: 'POST', body: { repo: 'acme/widgets', issue: 7, prompt: 'first' } }),
      apiRequest(addr.port, '/api/aca/dispatch', token, { method: 'POST', body: { repo: 'acme/widgets', issue: 7, prompt: 'second' } }),
    ]);
    assert.strictEqual(r1.status, 200, JSON.stringify(r1));
    assert.strictEqual(r2.status, 200, JSON.stringify(r2));
    assert.notStrictEqual(r1.body.trackerId, r2.body.trackerId, 'two concurrent dispatches must never share a trackerId');
    const getR = await apiRequest(addr.port, '/api/aca/dispatches', token);
    await svc.close();
    server.close();
    assert.strictEqual(getR.status, 200, JSON.stringify(getR));
    const ids = getR.body.dispatches.map((d) => d.id).sort();
    assert.deepStrictEqual(ids, [r1.body.trackerId, r2.body.trackerId].sort(), 'GET maps each distinct id back to exactly one dispatch');
  });

  await checkAsync('a newIssue request creates the issue first, then dispatches against its number', async () => {
    const { server, state } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', newIssue: { title: 'A new issue' }, prompt: 'go' },
    });
    await svc.close();
    server.close();
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(state.createdIssues.length, 1);
    assert.strictEqual(state.createdIssues[0].title, 'A new issue');
    assert.strictEqual(r.body.issue.number, 101);
    assert.strictEqual(state.dispatches[0].inputs.issue, '101');
  });

  await checkAsync('a repo still on the older workflow dispatches successfully without sending hub_correlation_id', async () => {
    const { server, state } = fakeGitHubApp({
      reposByInstallation: { 1: ['acme/widgets'] }, declaredInputs: LEGACY_DECLARED_INPUTS,
    });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const result = await app.dispatch({
      owner: 'acme', repo: 'widgets', installationId: 1, issue: 7, prompt: 'go', actor: TEST_ACTOR,
    });
    server.close();
    assert.strictEqual(result.correlationId, null);
    assert.strictEqual(result.correlationSupported, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(state.dispatches[0].inputs, 'hub_correlation_id'));
  });

  // =========================================================================
  // #251 (F3): the dialog's default options against the workflow's capabilities
  // =========================================================================

  /**
   * The real `GitHubApp` and `HubService` over the faked GitHub REST surface,
   * driven the way the dialog does: read `GET /api/aca/repos`, build the body
   * with the shipped `acaBuildDispatchBody` from the dialog's checkboxes, POST it.
   */
  async function dialogDispatch(fake, { publishPr = true, watchOnly = false } = {}) {
    const port = await listen(fake.server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    try {
      const repos = await apiRequest(addr.port, '/api/aca/repos', token);
      assert.strictEqual(repos.status, 200, JSON.stringify(repos));
      const built = acaBuildDispatchBody({
        repo: 'acme/widgets',
        prompt: 'Update the docs',
        issueMode: 'new',
        publishPr,
        watchOnly,
        declaredInputs: acaRepoDeclaredInputs(repos.body.repos, 'acme/widgets'),
      });
      assert.strictEqual(built.ok, true, JSON.stringify(built));
      const response = await apiRequest(addr.port, '/api/aca/dispatch', token, { method: 'POST', body: built.value });
      return { repos: repos.body.repos, body: built.value, response };
    } finally {
      await svc.close();
      fake.server.close();
    }
  }

  await checkAsync('GET /api/aca/repos reports which workflow_dispatch inputs each workflow declares, null when unknown', async () => {
    const legacy = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, declaredInputs: LEGACY_DECLARED_INPUTS });
    const modern = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const missing = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, hasWorkflow: false });
    const lists = [];
    for (const fake of [legacy, modern, missing]) {
      const port = await listen(fake.server);
      const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
      lists.push(await app.listReposWithDispatchStatus(TEST_ACTOR));
      fake.server.close();
    }
    assert.deepStrictEqual(lists[0][0].declaredInputs, LEGACY_DECLARED_INPUTS);
    assert.deepStrictEqual(lists[1][0].declaredInputs, MODERN_DECLARED_INPUTS);
    assert.strictEqual(lists[2][0].hasDispatchWorkflow, false);
    assert.strictEqual(lists[2][0].declaredInputs, null);
  });

  await checkAsync('the untouched dialog dispatches to a legacy workflow through the real GitHubApp and creates exactly one issue', async () => {
    const fake = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, declaredInputs: LEGACY_DECLARED_INPUTS });
    const { body, response } = await dialogDispatch(fake);
    assert.strictEqual(body.publishPr, null);
    assert.strictEqual(body.watchOnly, null);
    assert.strictEqual(response.status, 200, JSON.stringify(response));
    assert.strictEqual(fake.state.createdIssues.length, 1);
    assert.strictEqual(fake.state.dispatches.length, 1);
    assert.deepStrictEqual(Object.keys(fake.state.dispatches[0].inputs).sort(), ['issue', 'prompt']);
  });

  await checkAsync('an explicit no-publish choice on a legacy workflow is refused with 422 naming publish_pr before any issue is created', async () => {
    const fake = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, declaredInputs: LEGACY_DECLARED_INPUTS });
    const { response } = await dialogDispatch(fake, { publishPr: false });
    assert.strictEqual(response.status, 422, JSON.stringify(response));
    assert.match(response.body.error, /publish_pr/);
    assert.doesNotMatch(response.body.error, /watch_only/);
    assert.strictEqual(fake.state.createdIssues.length, 0, 'an issue was created for a request that was always going to be refused');
    assert.strictEqual(fake.state.dispatches.length, 0);
  });

  await checkAsync('an explicit watch-only choice on a legacy workflow is refused with 422 naming watch_only before any issue is created', async () => {
    const fake = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, declaredInputs: LEGACY_DECLARED_INPUTS });
    const { response } = await dialogDispatch(fake, { watchOnly: true });
    assert.strictEqual(response.status, 422, JSON.stringify(response));
    assert.match(response.body.error, /watch_only/);
    assert.strictEqual(fake.state.createdIssues.length, 0);
    assert.strictEqual(fake.state.dispatches.length, 0);
  });

  await checkAsync('a modern workflow whose own defaults differ from the dialog still receives the chosen booleans', async () => {
    const fake = fakeGitHubApp({
      reposByInstallation: { 1: ['acme/widgets'] }, inputDefaults: { publish_pr: 'false', watch_only: 'true' },
    });
    const { response } = await dialogDispatch(fake);
    assert.strictEqual(response.status, 200, JSON.stringify(response));
    assert.strictEqual(fake.state.dispatches[0].inputs.publish_pr, 'true');
    assert.strictEqual(fake.state.dispatches[0].inputs.watch_only, 'false');
    const other = fakeGitHubApp({
      reposByInstallation: { 1: ['acme/widgets'] }, inputDefaults: { publish_pr: 'true', watch_only: 'false' },
    });
    const flipped = await dialogDispatch(other, { publishPr: false, watchOnly: true });
    assert.strictEqual(flipped.response.status, 200, JSON.stringify(flipped.response));
    assert.strictEqual(other.state.dispatches[0].inputs.publish_pr, 'false');
    assert.strictEqual(other.state.dispatches[0].inputs.watch_only, 'true');
  });

  await checkAsync('the always-send request is still refused by a legacy workflow, naming both inputs, with no issue created', async () => {
    const fake = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, declaredInputs: LEGACY_DECLARED_INPUTS });
    const port = await listen(fake.server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', newIssue: { title: 'T' }, prompt: 'go', publishPr: true, watchOnly: false },
    });
    await svc.close();
    fake.server.close();
    assert.strictEqual(r.status, 422, JSON.stringify(r));
    assert.match(r.body.error, /publish_pr, watch_only/);
    assert.strictEqual(fake.state.createdIssues.length, 0);
  });


  // --- #251 (F3 revision): a comment-aware reading, and uncertainty that is never a "not declared" ---

  const wfYaml = (inputsBlock, { onLine = 'on:', dispatchLine = '  workflow_dispatch:' } = {}) => [
    'name: Squad dispatch', onLine, dispatchLine, ...inputsBlock,
    'jobs:', '  dispatch:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo hi', '',
  ].join('\n');

  // A custom workflow whose watch_only DEFAULTS TO TRUE, declared after a column-0 comment, with the
  // mandatory issue/prompt before it -- the layout the first F3 parser cut off after `issue`.
  const COMMENTED_YAML = wfYaml([
    '    inputs:',
    '      issue:',
    '        description: Issue number',
    '        required: false',
    '      prompt:',
    '        description: Prompt',
    '        required: true',
    '# supervised by default; uncheck to run unattended',
    '      watch_only:',
    '        description: Watch only',
    '        type: boolean',
    '        default: true',
  ]);
  const COMMENTED_TRUTH = ['issue', 'prompt', 'watch_only'];

  const HEADER_COMMENT_YAML = wfYaml([
    '    inputs:   # options',
    '      issue:        # the issue',
    '        required: false',
    '      prompt:',
    '        required: true',
    '      publish_pr:',
    '        type: boolean',
    '        default: false',
    '      watch_only:',
    '        type: boolean',
    '        default: true',
  ], { onLine: 'on:  # triggers', dispatchLine: '  workflow_dispatch:   # manual' });
  const HEADER_COMMENT_TRUTH = ['issue', 'prompt', 'publish_pr', 'watch_only'];

  await checkAsync('a column-0 comment inside the inputs block does not hide a later watch_only: the unchecked box is sent as false, not left to the workflow default of true', async () => {
    const fake = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, workflowYaml: COMMENTED_YAML, declaredInputs: COMMENTED_TRUTH });
    const { repos, body, response } = await dialogDispatch(fake);
    assert.deepStrictEqual(repos[0].declaredInputs, COMMENTED_TRUTH);
    assert.strictEqual(body.watchOnly, false, 'the unchecked Watch-only choice was dropped');
    assert.strictEqual(body.publishPr, null, 'a default Publish PR was sent to a workflow that does not declare it');
    assert.strictEqual(response.status, 200, JSON.stringify(response));
    assert.strictEqual(fake.state.createdIssues.length, 1);
    assert.strictEqual(fake.state.dispatches[0].inputs.watch_only, 'false', 'the workflow default (true) would have run with the box unchecked');
    assert.ok(!('publish_pr' in fake.state.dispatches[0].inputs));
  });

  await checkAsync('a supported custom default is still overridden only by the choice: Watch-only checked reaches a commented workflow as true', async () => {
    const fake = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, workflowYaml: COMMENTED_YAML, declaredInputs: COMMENTED_TRUTH });
    const { response } = await dialogDispatch(fake, { watchOnly: true });
    assert.strictEqual(response.status, 200, JSON.stringify(response));
    assert.strictEqual(fake.state.dispatches[0].inputs.watch_only, 'true');
  });

  await checkAsync('an unsupported non-default choice on a commented workflow is still refused with 422 naming only that input, before any issue is created', async () => {
    const fake = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, workflowYaml: COMMENTED_YAML, declaredInputs: COMMENTED_TRUTH });
    const { response } = await dialogDispatch(fake, { publishPr: false });
    assert.strictEqual(response.status, 422, JSON.stringify(response));
    assert.match(response.body.error, /publish_pr/);
    assert.doesNotMatch(response.body.error, /watch_only/);
    assert.strictEqual(fake.state.createdIssues.length, 0);
    assert.strictEqual(fake.state.dispatches.length, 0);
  });

  await checkAsync('trailing comments on on:, workflow_dispatch: and inputs: do not make a declaring workflow read as declaring nothing', async () => {
    const fake = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, workflowYaml: HEADER_COMMENT_YAML, declaredInputs: HEADER_COMMENT_TRUTH });
    const { repos, body, response } = await dialogDispatch(fake);
    assert.deepStrictEqual(repos[0].declaredInputs, HEADER_COMMENT_TRUTH);
    assert.strictEqual(body.publishPr, true);
    assert.strictEqual(body.watchOnly, false);
    assert.strictEqual(response.status, 200, JSON.stringify(response));
    assert.strictEqual(fake.state.dispatches[0].inputs.publish_pr, 'true', 'the workflow default (false) would have decided Publish PR');
    assert.strictEqual(fake.state.dispatches[0].inputs.watch_only, 'false', 'the workflow default (true) would have decided Watch-only');
  });

  const AMBIGUOUS_LAYOUTS = {
    'a quoted input name': wfYaml(['    inputs:', '      issue:', '      prompt:', '      "watch_only":', '        default: true']),
    'a flow-style inputs block': wfYaml(['    inputs: {issue: {}, prompt: {}, watch_only: {default: true}}']),
    'tab indentation': wfYaml(['    inputs:', '      issue:', '      prompt:', '\twatch_only:', '        default: true']),
  };
  for (const [layout, yaml] of Object.entries(AMBIGUOUS_LAYOUTS)) {
    await checkAsync(`${layout}: the inputs are unknown, the dialog sends its explicit choices, and the hub refuses before any issue exists, without claiming an input is undeclared`, async () => {
      const fake = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, workflowYaml: yaml, declaredInputs: COMMENTED_TRUTH });
      const { repos, body, response } = await dialogDispatch(fake);
      assert.strictEqual(repos[0].declaredInputs, null);
      assert.strictEqual(body.publishPr, true);
      assert.strictEqual(body.watchOnly, false);
      assert.strictEqual(response.status, 422, JSON.stringify(response));
      assert.match(response.body.error, /could not determine which workflow_dispatch inputs/);
      assert.doesNotMatch(response.body.error, /does not declare/);
      assert.strictEqual(fake.state.createdIssues.length, 0, 'an issue was created for a workflow the hub could not read');
      assert.strictEqual(fake.state.dispatches.length, 0);
    });
  }

  await checkAsync('a direct API dispatch against a workflow whose inputs are unknown is a clean 422 with nothing created, never a 500 or a success', async () => {
    const fake = fakeGitHubApp({
      reposByInstallation: { 1: ['acme/widgets'] }, workflowYaml: AMBIGUOUS_LAYOUTS['a flow-style inputs block'], declaredInputs: COMMENTED_TRUTH,
    });
    const port = await listen(fake.server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', newIssue: { title: 'T' }, prompt: 'go' },
    });
    await svc.close();
    fake.server.close();
    assert.strictEqual(r.status, 422, JSON.stringify(r));
    assert.match(r.body.error, /could not determine/);
    assert.strictEqual(fake.state.createdIssues.length, 0);
    assert.strictEqual(fake.state.dispatches.length, 0);
  });

  // =========================================================================
  // Must-fix #1 (re-dispatch review): send only inputs the workflow declares
  // =========================================================================

  await checkAsync('an option the workflow does not declare is refused with 4xx, before any side effect', async () => {
    const { server, state } = fakeGitHubApp({
      reposByInstallation: { 1: ['acme/widgets'] }, declaredInputs: LEGACY_DECLARED_INPUTS,
    });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', issue: 1, prompt: 'go', model: 'claude' },
    });
    await svc.close();
    server.close();
    assert.ok(r.status >= 400 && r.status < 500, `expected a 4xx, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /model/);
    assert.strictEqual(state.dispatches.length, 0, 'the undeclared-input refusal still dispatched the workflow');
  });

  await checkAsync('the undeclared-input refusal runs before newIssue ever creates anything', async () => {
    const { server, state } = fakeGitHubApp({
      reposByInstallation: { 1: ['acme/widgets'] }, declaredInputs: LEGACY_DECLARED_INPUTS,
    });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', newIssue: { title: 'should never exist' }, prompt: 'go', reviewer: 'alice' },
    });
    await svc.close();
    server.close();
    assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(r));
    assert.strictEqual(state.createdIssues.length, 0, 'an issue was created despite the request being refused');
    assert.strictEqual(state.dispatches.length, 0);
  });

  await checkAsync('a dispatch that fails after creating a newIssue returns the created issue in the error body', async () => {
    const { server, state } = fakeGitHubApp({
      reposByInstallation: { 1: ['acme/widgets'] }, dispatchStatus: 500,
    });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', newIssue: { title: 'orphaned on failure' }, prompt: 'go' },
    });
    await svc.close();
    server.close();
    assert.notStrictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(state.createdIssues.length, 1, 'the issue should still have been created before the dispatch call');
    assert.ok(r.body.issue, 'the error response does not carry the issue the hub already created');
    assert.strictEqual(r.body.issue.number, 101);
    assert.match(r.body.issue.url, /\/issues\/101$/);
  });

  // =========================================================================
  // #253 (F4): a dispatch that failed after creating an issue is retried on it
  // =========================================================================

  /** The real `GitHubApp` and `HubService` over `fake`, and a `post(body)` to `/api/aca/dispatch`. */
  async function dispatchHarness(fake) {
    const port = await listen(fake.server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    return {
      post: (body) => apiRequest(addr.port, '/api/aca/dispatch', token, { method: 'POST', body }),
      async close() { await svc.close(); fake.server.close(); },
    };
  }

  const retryForm = () => ({
    repo: 'acme/widgets',
    baseBranch: 'release',
    prompt: 'Update the docs',
    model: 'a-model',
    reviewer: 'someone',
    publishPr: false,
    watchOnly: true,
    issueMode: 'new',
    declaredInputs: MODERN_DECLARED_INPUTS,
  });
  const asClientError = (response) => ({ status: response.status, body: response.body });

  await checkAsync('a failed dispatch that created an issue is retried on that issue, with the same options and no second issue (#253 F4)', async () => {
    const fake = fakeGitHubApp({ dispatchStatus: (attempt) => (attempt === 1 ? 500 : 204) });
    const hub = await dispatchHarness(fake);
    try {
      const first = acaBuildDispatchBody(retryForm());
      assert.strictEqual(first.ok, true, JSON.stringify(first));
      assert.ok(first.value.newIssue && first.value.issue === null, 'the first request was not a New-issue request');
      const failed = await hub.post(first.value);
      assert.strictEqual(failed.status, 500, JSON.stringify(failed));
      assert.strictEqual(fake.state.createdIssues.length, 1, 'the first request did not create exactly one issue');

      const created = acaCreatedIssueOf(asClientError(failed), first.value);
      assert.ok(created, 'the client did not recover the issue the failed dispatch created');
      assert.strictEqual(created.number, 101);
      assert.strictEqual(created.repo, 'acme/widgets');
      assert.strictEqual(created.link, 'https://github.com/acme/widgets/issues/101');

      const retry = acaBuildDispatchBody({ ...retryForm(), issueMode: 'existing', issueNumber: String(created.number) });
      assert.strictEqual(retry.ok, true, JSON.stringify(retry));
      assert.strictEqual(retry.value.issue, 101);
      assert.strictEqual(retry.value.newIssue, null);
      const second = await hub.post(retry.value);
      assert.strictEqual(second.status, 200, JSON.stringify(second));
      assert.strictEqual(second.body.issue.number, 101);
      assert.strictEqual(fake.state.createdIssues.length, 1, 'the retry created a second issue');
      assert.strictEqual(fake.state.dispatches.length, 2);
      assert.deepStrictEqual(fake.state.dispatches.map((d) => d.repo), ['widgets', 'widgets']);
      assert.strictEqual(fake.state.dispatches[1].inputs.issue, '101', 'the retry was not dispatched against the created issue');
      const { hub_correlation_id: c1, ...firstInputs } = fake.state.dispatches[0].inputs;
      const { hub_correlation_id: c2, ...secondInputs } = fake.state.dispatches[1].inputs;
      assert.ok(c1 && c2 && c1 !== c2, 'each dispatch carries its own correlation id');
      assert.deepStrictEqual(secondInputs, firstInputs, 'the retry changed the options the person chose');
    } finally {
      await hub.close();
    }
  });

  await checkAsync('a failure with no created issue (issue creation refused) carries no metadata and claims nothing (#253 F4)', async () => {
    const fake = fakeGitHubApp({ issueStatus: 500 });
    const hub = await dispatchHarness(fake);
    try {
      const built = acaBuildDispatchBody(retryForm());
      const failed = await hub.post(built.value);
      assert.ok(failed.status >= 400, JSON.stringify(failed));
      assert.strictEqual(fake.state.createdIssues.length, 0);
      assert.strictEqual(fake.state.dispatches.length, 0);
      assert.ok(!('issue' in failed.body), `an issue was reported though none was created: ${JSON.stringify(failed.body)}`);
      assert.strictEqual(acaCreatedIssueOf(asClientError(failed), built.value), null);
    } finally {
      await hub.close();
    }
  });

  await checkAsync('a failed dispatch on an Existing issue creates nothing and is never described as a creation (#253 F4)', async () => {
    const fake = fakeGitHubApp({ dispatchStatus: 500 });
    const hub = await dispatchHarness(fake);
    try {
      const built = acaBuildDispatchBody({ ...retryForm(), issueMode: 'existing', issueNumber: '7' });
      const failed = await hub.post(built.value);
      assert.strictEqual(failed.status, 500, JSON.stringify(failed));
      assert.strictEqual(fake.state.createdIssues.length, 0, 'an Existing-issue request created an issue');
      assert.strictEqual(fake.state.dispatches.length, 1, 'the dispatch was not attempted');
      assert.strictEqual(acaCreatedIssueOf(asClientError(failed), built.value), null);
      // Even a response that did name an issue is not a creation by this request.
      assert.strictEqual(acaCreatedIssueOf({ body: { issue: { number: 9 } } }, built.value), null);
    } finally {
      await hub.close();
    }
  });
  // =========================================================================
  // Must-fix #3 (re-dispatch review): never dispatch on baseBranch as ref
  // =========================================================================

  await checkAsync('the dispatch always runs on the repo default branch, never the caller-supplied baseBranch', async () => {
    const { server, state } = fakeGitHubApp({
      reposByInstallation: { 1: ['acme/widgets'] }, defaultBranch: 'develop',
    });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', issue: 1, prompt: 'go', baseBranch: 'feature-x' },
    });
    await svc.close();
    server.close();
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(state.dispatches[0].ref, 'develop', 'the dispatch ref must be the repo default branch, never baseBranch');
    assert.strictEqual(state.dispatches[0].inputs.base_branch, 'feature-x', 'baseBranch should still travel as the base_branch INPUT');
  });

  await checkAsync('parseDeclaredWorkflowInputs reads workflow_dispatch.inputs from real workflow YAML', () => {
    const yaml = [
      'name: Squad dispatch',
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      issue:',
      '        required: true',
      '      prompt:',
      '        required: true',
      'jobs:',
      '  dispatch:',
      '    runs-on: ubuntu-latest',
    ].join('\n');
    assert.deepStrictEqual(parseDeclaredWorkflowInputs(yaml), ['issue', 'prompt']);
  });

  check('parseDeclaredWorkflowInputs returns null when the workflow has no workflow_dispatch trigger at all', () => {
    const yaml = 'name: CI\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
    assert.strictEqual(parseDeclaredWorkflowInputs(yaml), null);
  });

  check('parseDeclaredWorkflowInputs ignores a column-0 comment inside the inputs block and keeps every name after it', () => {
    const yaml = wfYamlLines([
      '    inputs:', '      issue:', '        required: false', '      prompt:', '        required: true',
      '# a comment at column 0', '      watch_only:', '        default: true',
    ]);
    assert.deepStrictEqual(parseDeclaredWorkflowInputs(yaml), ['issue', 'prompt', 'watch_only']);
  });

  check('parseDeclaredWorkflowInputs reads past trailing comments on the on/workflow_dispatch/inputs lines and input names', () => {
    const yaml = wfYamlLines([
      '    inputs:   # options', '      issue:  # the issue', '        required: false', '      prompt:', '        required: true',
    ], 'on:  # triggers', '  workflow_dispatch:   # manual');
    assert.deepStrictEqual(parseDeclaredWorkflowInputs(yaml), ['issue', 'prompt']);
    assert.deepStrictEqual(parseDeclaredWorkflowInputs(wfYamlLines([], 'on:', '  workflow_dispatch:  # nothing to ask')), []);
  });

  check('parseDeclaredWorkflowInputs does not mistake comment or block-scalar text for an input name', () => {
    const yaml = wfYamlLines([
      '    inputs:', '      issue:', '        description: |', '          # watch_only: true',
      '          publish_pr: not an input', '          ', '        required: false',
      '      prompt:', '        description: "# model: also not one"',
    ]);
    assert.deepStrictEqual(parseDeclaredWorkflowInputs(yaml), ['issue', 'prompt']);
  });

  check('parseDeclaredWorkflowInputs answers null, never a shorter list, whenever it cannot read the block with certainty', () => {
    const layouts = {
      'quoted key': wfYamlLines(['    inputs:', '      issue:', '      "watch_only":']),
      'single-quoted key': wfYamlLines(['    inputs:', "      'issue':", '      prompt:']),
      'flow-style inputs': wfYamlLines(['    inputs: {issue: {}, prompt: {}}']),
      'inputs with a trailing value': wfYamlLines(['    inputs: &shared', '      issue:']),
      'inputs as a list': wfYamlLines(['    inputs:', '      - issue', '      - prompt']),
      'tab indentation': wfYamlLines(['    inputs:', '      issue:', '\tprompt:']),
      'a dedent below the block indentation': wfYamlLines(['    inputs:', '        issue:', '      prompt:']),
      'a name with a space before the colon': wfYamlLines(['    inputs:', '      issue :', '      prompt:']),
      'a non-inputs child of workflow_dispatch': wfYamlLines(['    branches: [main]', '    inputs:', '      issue:']),
      'flow-style on': 'name: x\non: [push, workflow_dispatch]\njobs: {}\n',
      'scalar on': 'name: x\non: workflow_dispatch\njobs: {}\n',
      'workflow_dispatch not under on': 'name: x\nenv:\n  workflow_dispatch:\n    inputs:\n      issue:\n',
      'two workflow_dispatch headers': `${wfYamlLines(['    inputs:', '      issue:'])}  other:\n    workflow_dispatch:\n`,
      'empty file': '',
    };
    for (const [name, yaml] of Object.entries(layouts)) {
      assert.strictEqual(parseDeclaredWorkflowInputs(yaml), null, name);
    }
  });

  check('upstreamStatus maps GitHub 401/403 and redirects to 502, never passed through as-is', () => {
    assert.strictEqual(upstreamStatus(401), 502);
    assert.strictEqual(upstreamStatus(403), 502);
    assert.strictEqual(upstreamStatus(301), 502);
    assert.strictEqual(upstreamStatus(302), 502);
    assert.strictEqual(upstreamStatus(404), 404);
    assert.strictEqual(upstreamStatus(422), 422);
    assert.strictEqual(upstreamStatus(500), 500);
  });

  await checkAsync('a GitHub 403 while listing installations never reaches the caller as a 403 of their own', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, installationsStatus: 403 });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', issue: 1, prompt: 'go' },
    });
    await svc.close();
    server.close();
    // GitHub's own 403 (the App credential rejected) must not be passed
    // straight through as this hub's 403 -- that status already means
    // something specific here ("the App is not installed on this repo"),
    // and reusing it for an unrelated upstream failure would look exactly
    // like the signed-in caller's own authorization failing.
    assert.strictEqual(r.status, 502, JSON.stringify(r));
  });

  await checkAsync('a repo with no squad-dispatch.yml refuses the dispatch', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, hasWorkflow: false });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', issue: 1, prompt: 'go' },
    });
    await svc.close();
    server.close();
    assert.notStrictEqual(r.status, 200);
    // Specifically "has no .../squad-dispatch.yml at all" -- NOT the
    // separate "does not declare this input" refusal below, which also
    // happens to mention the same filename and would otherwise mask this
    // mutation.
    assert.match(r.body.error, /has no \.github\/workflows\/squad-dispatch\.yml/);
  });

  await checkAsync('GET /api/aca/repos reports hasDispatchWorkflow honestly', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, hasWorkflow: true });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/repos', token);
    await svc.close();
    server.close();
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.body.repos.length, 1);
    assert.strictEqual(r.body.repos[0].fullName, 'acme/widgets');
    assert.strictEqual(r.body.repos[0].hasDispatchWorkflow, true);
  });

  await checkAsync('GET /api/aca/repos reports hasDispatchWorkflow: false for a real 404, not assumed', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, hasWorkflow: false });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/repos', token);
    await svc.close();
    server.close();
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.body.repos[0].hasDispatchWorkflow, false);
  });

  await checkAsync('a non-404 error checking for squad-dispatch.yml surfaces as an error, not a silent false', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, hasWorkflow: 'error' });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r = await apiRequest(addr.port, '/api/aca/repos', token);
    await svc.close();
    server.close();
    assert.ok(r.status >= 500, `expected a clear error status, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await checkAsync('a device token can never reach /api/aca/dispatch', async () => {
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const deviceToken = auth.mintDeviceToken({ key: 'me', name: 'a device' });
    const r = await apiRequest(addr.port, '/api/aca/dispatch', deviceToken, {
      method: 'POST', body: { repo: 'acme/widgets', issue: 1, prompt: 'go' },
    });
    await svc.close();
    assert.strictEqual(r.status, 403, JSON.stringify(r));
  });

  // =========================================================================
  // Input validation (src/aca-dispatch.js)
  // =========================================================================

  check('a well-formed request validates', () => {
    const r = sanitizeDispatchRequest({ repo: 'acme/widgets', issue: 1, prompt: 'do the thing' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  });

  check('repo must be owner/repo', () => {
    for (const bad of ['not-a-repo', '', 'a/b/c', '../../etc/passwd', null, 42, 'a/..']) {
      const r = sanitizeDispatchRequest({ repo: bad, issue: 1, prompt: 'x' });
      assert.strictEqual(r.ok, false, `expected ${JSON.stringify(bad)} to be refused`);
    }
  });

  check('exactly one of issue or newIssue is required', () => {
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', prompt: 'x' }).ok, false, 'neither given');
    assert.strictEqual(
      sanitizeDispatchRequest({ repo: 'a/b', issue: 1, newIssue: { title: 't' }, prompt: 'x' }).ok, false,
      'both given',
    );
  });

  check('issue must be a strict integer, not a coerced truthy/numeric-looking value', () => {
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 42, prompt: 'x' }).ok, true, 'a real integer must still pass');
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: true, prompt: 'x' }).ok, false, 'true must not become 1');
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: false, prompt: 'x' }).ok, false, 'false must not become 0');
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: '0x10', prompt: 'x' }).ok, false, 'hex strings must not coerce');
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: '42', prompt: 'x' }).ok, false, 'numeric strings must not coerce');
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: [42], prompt: 'x' }).ok, false, 'a single-element array must not coerce');
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1.5, prompt: 'x' }).ok, false, 'a non-integer number must be refused');
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: null, prompt: 'x' }).ok, false);
  });

  check('prompt is required and size-capped', () => {
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: '' }).ok, false);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1 }).ok, false);
    const huge = 'x'.repeat(20001);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: huge }).ok, false);
    const justUnder = 'x'.repeat(20000);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: justUnder }).ok, true);
  });

  check('prompt rejects control-character injection but allows newlines', () => {
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'line one\nline two' }).ok, true);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'bell\x07here' }).ok, false);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'esc\x1b[31mhere' }).ok, false);
  });

  check('newIssue.title rejects injection-shaped strings, same as pull-request.js/device-meta.js', () => {
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', newIssue: { title: 'a fine title' }, prompt: 'x' }).ok, true);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', newIssue: { title: '<script>bad</script>' }, prompt: 'x' }).ok, false);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', newIssue: { title: 'x'.repeat(201) }, prompt: 'y' }).ok, false);
  });

  check('baseBranch must look like a real git ref', () => {
    for (const good of ['main', 'feature/thing', 'release-1.2.3']) {
      assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', baseBranch: good }).ok, true, good);
    }
    for (const bad of ['/leading-slash', 'has space', '..', 'a//b', 'a.lock', 'a\x1b[31m']) {
      assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', baseBranch: bad }).ok, false, bad);
    }
  });

  check('model must be a short slug', () => {
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', model: 'claude-sonnet-5.5' }).ok, true);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', model: 'bad model!' }).ok, false);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', model: 'x'.repeat(65) }).ok, false);
  });

  check('reviewer must be a valid identifier (the Squad member id, not an arbitrary GitHub username)', () => {
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', reviewer: 'octocat' }).ok, true);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', reviewer: 'oct-o-cat' }).ok, true);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', reviewer: '-bad' }).ok, false);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', reviewer: 'bad-' }).ok, false);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', reviewer: 'bad--name' }).ok, false);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', reviewer: 'x'.repeat(40) }).ok, false);
  });

  check('publishPr and watchOnly must be real booleans, not truthy strings', () => {
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', publishPr: 'true' }).ok, false);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', publishPr: true }).ok, true);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', watchOnly: 1 }).ok, false);
    assert.strictEqual(sanitizeDispatchRequest({ repo: 'a/b', issue: 1, prompt: 'x', watchOnly: false }).ok, true);
  });

  check('the body must be a JSON object, not an array or a primitive', () => {
    for (const bad of [null, undefined, 'a string', 42, []]) {
      assert.strictEqual(sanitizeDispatchRequest(bad).ok, false);
    }
  });

  // =========================================================================
  // Mapping onto squad-dispatch.yml's workflow_dispatch inputs
  // =========================================================================

  check('only fields actually provided become workflow inputs', () => {
    const inputs = buildWorkflowInputs({ prompt: 'p', model: null, baseBranch: null, publishPr: null, reviewer: null, watchOnly: null }, { issueNumber: 7 });
    assert.deepStrictEqual(inputs, { issue: '7', prompt: 'p' });
  });

  check('every additive field maps to the #135 input name', () => {
    const inputs = buildWorkflowInputs({
      prompt: 'p', model: 'gpt', baseBranch: 'main', publishPr: true, reviewer: 'octocat', watchOnly: false,
    }, { issueNumber: 7 });
    assert.deepStrictEqual(inputs, {
      issue: '7', prompt: 'p', model: 'gpt', base_branch: 'main', publish_pr: 'true', reviewer: 'octocat', watch_only: 'false',
    });
  });

  // =========================================================================
  // Rate limiting
  // =========================================================================

  check('the limit allows exactly N requests, then refuses the (N+1)th', () => {
    let now = 0;
    const rl = new RateLimiter({ limit: 3, windowMs: 1000, now: () => now });
    assert.strictEqual(rl.check('u').allowed, true);
    assert.strictEqual(rl.check('u').allowed, true);
    assert.strictEqual(rl.check('u').allowed, true);
    const fourth = rl.check('u');
    assert.strictEqual(fourth.allowed, false);
    assert.ok(fourth.retryAfterMs > 0);
  });

  check('a refusal does not extend by being retried while still refused', () => {
    let now = 0;
    const rl = new RateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    assert.strictEqual(rl.check('u').allowed, true);
    now = 500;
    const first = rl.check('u');
    now = 600;
    const second = rl.check('u');
    assert.strictEqual(first.allowed, false);
    assert.strictEqual(second.allowed, false);
    // Both refusals must be counted from the SAME original hit (t=0), not
    // from each other -- otherwise retrying while refused would keep
    // pushing the retry window out indefinitely.
    assert.strictEqual(first.retryAfterMs, 500);
    assert.strictEqual(second.retryAfterMs, 400);
  });

  check('the window actually slides: after it elapses, the caller is allowed again', () => {
    let now = 0;
    const rl = new RateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    assert.strictEqual(rl.check('u').allowed, true);
    now = 999;
    assert.strictEqual(rl.check('u').allowed, false, 'allowed one millisecond too early');
    now = 1001;
    assert.strictEqual(rl.check('u').allowed, true, 'still refused after the window elapsed');
  });

  check('different keys have independent limits', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    assert.strictEqual(rl.check('alice').allowed, true);
    assert.strictEqual(rl.check('bob').allowed, true);
    assert.strictEqual(rl.check('alice').allowed, false);
  });

  await checkAsync('the dispatch route actually enforces the rate limit end to end', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = githubAuth();
    let now = 0;
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
      acaRateLimiter: new RateLimiter({ limit: 2, windowMs: 60000, now: () => now }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const body = { repo: 'acme/widgets', issue: 1, prompt: 'go' };
    const r1 = await apiRequest(addr.port, '/api/aca/dispatch', token, { method: 'POST', body });
    const r2 = await apiRequest(addr.port, '/api/aca/dispatch', token, { method: 'POST', body });
    const r3 = await apiRequest(addr.port, '/api/aca/dispatch', token, { method: 'POST', body });
    await svc.close();
    server.close();
    assert.strictEqual(r1.status, 200, JSON.stringify(r1));
    assert.strictEqual(r2.status, 200, JSON.stringify(r2));
    assert.strictEqual(r3.status, 429, JSON.stringify(r3));
    assert.ok(typeof r3.body.retryAfterMs === 'number');
  });

  await checkAsync('a malformed body is rejected without ever consuming rate-limit quota', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = githubAuth();
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
      acaRateLimiter: new RateLimiter({ limit: 1, windowMs: 60000 }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    // Two invalid requests in a row -- if validation consumed quota, the
    // second would 429 instead of repeating the same validation error.
    const bad1 = await apiRequest(addr.port, '/api/aca/dispatch', token, { method: 'POST', body: { repo: 'not-a-repo' } });
    const bad2 = await apiRequest(addr.port, '/api/aca/dispatch', token, { method: 'POST', body: { repo: 'not-a-repo' } });
    // The limiter's one slot of quota must still be free for a valid request.
    const good = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', issue: 1, prompt: 'go' },
    });
    await svc.close();
    server.close();
    assert.strictEqual(bad1.status, 400, JSON.stringify(bad1));
    assert.strictEqual(bad2.status, 400, JSON.stringify(bad2));
    assert.strictEqual(good.status, 200, JSON.stringify(good));
  });

  // =========================================================================
  // DispatchTracker: per-user partitioning, exact correlation matching, and
  // status refresh
  // =========================================================================

  await checkAsync('each user only ever sees their own recorded dispatches', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const tracker = new DispatchTracker();
    tracker.record('alice', { owner: 'acme', repo: 'widgets', installationId: 1, correlationSupported: false });
    tracker.record('bob', { owner: 'acme', repo: 'widgets', installationId: 1, correlationSupported: false });
    const aliceList = await tracker.listWithStatus('alice', app);
    const bobList = await tracker.listWithStatus('bob', app);
    server.close();
    assert.strictEqual(aliceList.length, 1);
    assert.strictEqual(bobList.length, 1);
  });

  await checkAsync('resolveRunStatus matches exactly one run by the dispatch correlation token in display_title', async () => {
    const corr = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const runs = [
      { id: 600, status: 'in_progress', conclusion: null, head_branch: 'other-branch', display_title: correlationTitle(corr) },
      { id: 601, status: 'queued', conclusion: null, head_branch: 'main', display_title: correlationTitle(corr) },
    ];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, correlationId: corr, correlationSupported: true, ref: 'main',
    });
    server.close();
    assert.strictEqual(status.state, 'queued');
    assert.strictEqual(status.runId, 601, 'the run on a different branch should never match');
  });

  await checkAsync('a dispatch with a correlation id and no run yet reports pending rather than throwing', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs: [] });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1,
      correlationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', correlationSupported: true, ref: 'main',
    });
    server.close();
    assert.strictEqual(status.state, 'pending');
  });

  await checkAsync('a bound dispatch refreshes queued -> in_progress -> completed without re-searching', async () => {
    const corr = 'cccccccccccccccccccccccccccccccc';
    const runs = [{
      id: 950, status: 'queued', conclusion: null, head_branch: 'main', display_title: correlationTitle(corr),
    }];
    const { server, calls } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: corr, correlationSupported: true, dispatchedAt: Date.now() - 1000,
    });
    const first = await tracker.listWithStatus('alice', app);
    const searchCallsAfterFirst = calls.byPath['GET /repos/acme/widgets/actions/workflows/squad-dispatch.yml/runs'] || 0;
    runs[0].status = 'in_progress';
    const second = await tracker.listWithStatus('alice', app);
    runs[0].status = 'completed';
    runs[0].conclusion = 'success';
    const third = await tracker.listWithStatus('alice', app);
    server.close();
    assert.strictEqual(first[0].status.state, 'queued');
    assert.strictEqual(second[0].status.state, 'in_progress');
    assert.strictEqual(third[0].status.state, 'completed');
    assert.strictEqual(
      calls.byPath['GET /repos/acme/widgets/actions/workflows/squad-dispatch.yml/runs'] || 0,
      searchCallsAfterFirst,
      'a bound dispatch re-ran the matching search instead of refreshing its own run',
    );
    assert.ok(calls.byPath['GET /repos/acme/widgets/actions/runs/950'] >= 1, 'the bound run was never refreshed by id');
  });

  await checkAsync('two same-target dispatches with distinct correlation ids each bind to their own run', async () => {
    const corrA = 'dddddddddddddddddddddddddddddddd';
    const corrB = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const runs = [
      { id: 900, status: 'completed', conclusion: 'success', head_branch: 'main', display_title: correlationTitle(corrA) },
      { id: 901, status: 'in_progress', conclusion: null, head_branch: 'main', display_title: correlationTitle(corrB) },
    ];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: corrA, correlationSupported: true, dispatchedAt: Date.now() - 1000,
    });
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: corrB, correlationSupported: true, dispatchedAt: Date.now() - 900,
    });
    const list = await tracker.listWithStatus('alice', app);
    server.close();
    assert.deepStrictEqual(list.map((r) => r.status.runId), [901, 900]);
  });

  await checkAsync('reversed run creation order still binds each dispatch to its own correlation id', async () => {
    const corrOld = '11111111111111111111111111111111';
    const corrNew = '22222222222222222222222222222222';
    const runs = [
      { id: 920, status: 'queued', conclusion: null, head_branch: 'main', created_at: new Date(Date.now() + 1000).toISOString(), display_title: correlationTitle(corrOld) },
      { id: 921, status: 'in_progress', conclusion: null, head_branch: 'main', created_at: new Date().toISOString(), display_title: correlationTitle(corrNew) },
    ];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: corrOld, correlationSupported: true, dispatchedAt: Date.now() - 2000,
    });
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: corrNew, correlationSupported: true, dispatchedAt: Date.now() - 1000,
    });
    const list = await tracker.listWithStatus('alice', app);
    server.close();
    assert.deepStrictEqual(list.map((r) => r.status.runId), [921, 920]);
  });

  await checkAsync('a manual or unrelated run with no exact correlation title never matches a hub dispatch', async () => {
    const corr = '33333333333333333333333333333333';
    const runs = [
      { id: 930, status: 'queued', conclusion: null, head_branch: 'main', display_title: 'Squad dispatch (run 930)' },
      { id: 931, status: 'in_progress', conclusion: null, head_branch: 'main', display_title: '' },
    ];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, correlationId: corr, correlationSupported: true, ref: 'main',
    });
    server.close();
    assert.strictEqual(status.state, 'pending');
  });

  await checkAsync('a forged or substring look-alike correlation receipt never matches', async () => {
    const corr = '44444444444444444444444444444444';
    const runs = [
      { id: 940, status: 'queued', conclusion: null, head_branch: 'main', display_title: `Squad dispatch [corr:${corr.slice(0, 31)}]` },
      { id: 941, status: 'queued', conclusion: null, head_branch: 'main', display_title: `Squad dispatch [corr:${corr}extra]` },
      { id: 942, status: 'queued', conclusion: null, head_branch: 'main', display_title: `prefix ${correlationTitle(corr)} suffix` },
    ];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, correlationId: corr, correlationSupported: true, ref: 'main',
    });
    server.close();
    assert.strictEqual(status.state, 'pending');
  });

  await checkAsync('an ambiguous duplicate correlation receipt returns error instead of guessing', async () => {
    const corr = '55555555555555555555555555555555';
    const runs = [
      { id: 960, status: 'queued', conclusion: null, head_branch: 'main', display_title: correlationTitle(corr) },
      { id: 961, status: 'in_progress', conclusion: null, head_branch: 'main', display_title: correlationTitle(corr) },
    ];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, correlationId: corr, correlationSupported: true, ref: 'main',
    });
    server.close();
    assert.strictEqual(status.state, 'error');
    assert.match(status.reason, /ambiguous correlation match/);
  });

  await checkAsync('a single matching run found on a truncated (bounded) run-list page fails closed instead of claiming uniqueness', async () => {
    const corr = '59595959595959595959595959595959';
    const runs = [
      { id: 962, status: 'in_progress', conclusion: null, head_branch: 'main', display_title: correlationTitle(corr) },
    ];
    // GitHub reports more runs exist in total than this one bounded
    // `per_page=20` page fetched -- a second, unfetched run could carry the
    // same correlation id, so a single match on this page is not provably
    // unique.
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs, runsTotalCount: 25 });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, correlationId: corr, correlationSupported: true, ref: 'main',
    });
    server.close();
    assert.strictEqual(status.state, 'error', 'truncation must fail closed, not silently trust the single match');
    assert.match(status.reason, /refusing to assume this match is unique/);
  });

  await checkAsync('zero matches on a truncated run-list page stays an honest pending, not an error', async () => {
    // Truncation with NO match found yet is the acceptable "unknown" case
    // (the run may simply be on a page this bounded lookup did not fetch):
    // claiming uniqueness is the thing that must fail closed, not every
    // truncated page.
    const corr = '58585858585858585858585858585858';
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs: [], runsTotalCount: 30 });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, correlationId: corr, correlationSupported: true, ref: 'main',
    });
    server.close();
    assert.strictEqual(status.state, 'pending');
  });

  await checkAsync('more than 20 historical unrelated workflow_dispatch runs never permanently block a uniquely correlated new dispatch from resolving (#247)', async () => {
    // Exact reproduction of the #247 finding-2 bug: GitHub's `total_count`
    // on the plain `?event=workflow_dispatch` listing counts EVERY manual
    // dispatch run this workflow has ever had, for the whole repository's
    // history -- not just runs that could plausibly be this dispatch. 24
    // unrelated, completed, days-old runs plus one uniquely correlated
    // brand-new run add up to 25 total: without a dispatch-time candidate
    // window bounding what `total_count` is checked against, the truncation
    // check below used to trip FOREVER on every future dispatch, once a
    // repository's all-time manual-dispatch history passed `per_page=20`,
    // even though the real match sat right there on the fetched page.
    const corr = 'f00df00df00df00df00df00df00df00d';
    const dispatchedAt = Date.now();
    const oldUnrelatedRuns = Array.from({ length: 24 }, (_, i) => ({
      id: 3000 + i,
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      // Real, unrelated manual dispatch history: each one days before this
      // dispatch, well outside any reasonable dispatch-time window.
      created_at: new Date(dispatchedAt - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
      display_title: 'Squad dispatch (manual run)',
    }));
    const matchingRun = {
      id: 4000,
      status: 'in_progress',
      conclusion: null,
      head_branch: 'main',
      created_at: new Date(dispatchedAt).toISOString(),
      display_title: correlationTitle(corr),
    };
    const runs = [...oldUnrelatedRuns, matchingRun];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, correlationId: corr, correlationSupported: true, ref: 'main', dispatchedAt,
    });
    server.close();
    assert.strictEqual(
      status.state,
      'in_progress',
      `expected the uniquely correlated new run to resolve despite 25 total historical runs, got ${JSON.stringify(status)}`,
    );
    assert.strictEqual(status.runId, 4000);
  });

  await checkAsync('a dispatch-time-bounded lookup still fails closed on a genuinely ambiguous truncated page within the window (#247)', async () => {
    // The fix narrows what `total_count` counts against to this dispatch's
    // own time window -- it must not become a blanket "trust the single
    // match" once that narrowing is in place. If GitHub reports MORE runs
    // exist within the SAME bounded window than this page fetched, that is
    // still a genuine, un-ruled-out ambiguity and must still fail closed.
    const corr = 'ab0dab0dab0dab0dab0dab0dab0dab0d';
    const dispatchedAt = Date.now();
    const runs = [{
      id: 5000, status: 'in_progress', conclusion: null, head_branch: 'main', created_at: new Date(dispatchedAt).toISOString(), display_title: correlationTitle(corr),
    }];
    // Forces GitHub's reported total (for whatever query was actually sent)
    // to exceed what this one page fetched, the same technique the
    // pre-existing truncation tests above use.
    const { server } = fakeGitHubApp({
      reposByInstallation: { 1: ['acme/widgets'] }, runs, runsTotalCount: 22,
    });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, correlationId: corr, correlationSupported: true, ref: 'main', dispatchedAt,
    });
    server.close();
    assert.strictEqual(status.state, 'error', 'an in-window truncated page must still fail closed, not be waved through by the time bound');
    assert.match(status.reason, /refusing to assume this match is unique/);
  });

  await checkAsync('the dispatch-time candidate window is a search bound only, never an identity substitute (#247)', async () => {
    // A run created well within the window but with NO correlation match
    // must still be an honest pending, never accidentally promoted to a
    // match just because it falls inside the time bound -- correlationId in
    // display_title remains the only proof of identity.
    const corr = 'de0ade0ade0ade0ade0ade0ade0ade0a';
    const dispatchedAt = Date.now();
    const runs = [{
      id: 6000, status: 'in_progress', conclusion: null, head_branch: 'main', created_at: new Date(dispatchedAt).toISOString(), display_title: 'Squad dispatch (unrelated manual run)',
    }];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, correlationId: corr, correlationSupported: true, ref: 'main', dispatchedAt,
    });
    server.close();
    assert.strictEqual(status.state, 'pending', 'timing proximity alone must never stand in for the correlation id proof');
  });

  await checkAsync('resolveRunStatus never binds a run id already bound to another recorded dispatch', async () => {
    const corrA = '66666666666666666666666666666666';
    const corrB = '77777777777777777777777777777777';
    const runs = [
      { id: 970, status: 'completed', conclusion: 'success', head_branch: 'main', display_title: correlationTitle(corrA) },
      { id: 971, status: 'in_progress', conclusion: null, head_branch: 'main', display_title: correlationTitle(corrB) },
    ];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1,
      correlationId: corrA, correlationSupported: true, ref: 'main', excludeRunIds: new Set([970]),
    });
    server.close();
    assert.strictEqual(status.state, 'pending', 'an already-bound matching run must be skipped, not re-bound');
  });

  await checkAsync('a failed Actions run-list call becomes an error status for just that dispatch', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runsStatus: 500 });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: '88888888888888888888888888888888', correlationSupported: true, dispatchedAt: Date.now() - 1000,
    });
    const list = await tracker.listWithStatus('alice', app);
    server.close();
    assert.strictEqual(list[0].status.state, 'error');
    assert.match(list[0].status.reason, /could not read Actions runs/);
  });

  // =========================================================================
  // Issue #213 / #245: exact-match hardening and compatibility behavior
  // =========================================================================

  await checkAsync('cross-user binding matches owner/repo case-insensitively', async () => {
    const corr = '99999999999999999999999999999999';
    const runs = [{ id: 980, status: 'in_progress', conclusion: null, head_branch: 'main', display_title: correlationTitle(corr) }];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const tracker = new DispatchTracker();
    tracker.record('bob', {
      owner: 'Acme', repo: 'Widgets', installationId: 1, ref: 'main',
      correlationId: corr, correlationSupported: true, dispatchedAt: Date.now() - 1000,
    });
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: corr, correlationSupported: true, dispatchedAt: Date.now() - 900,
    });
    const aliceList = await tracker.listWithStatus('alice', app);
    server.close();
    assert.strictEqual(aliceList[0].status.state, 'pending', 'the later differently-cased dispatch must not double-claim the earlier run');
    assert.strictEqual(tracker.list('bob')[0].boundRunId, 980, 'the earlier differently-cased dispatch keeps the shared run');
  });

  await checkAsync('when two dispatches contend for one run, the older dispatch claims it first, for one user or across two', async () => {
    // One correlation id on two records is the contention `_resolveOrder`
    // settles. Distinct ids never contend -- a run title matches exactly one
    // record -- so they cannot show the resolution order at all. A user's own
    // list() is newest first, so the older record winning is not list order.
    const corr = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
    const runs = [{ id: 985, status: 'in_progress', conclusion: null, head_branch: 'main', display_title: correlationTitle(corr) }];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const target = {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main', correlationId: corr, correlationSupported: true,
    };
    const oneUser = new DispatchTracker();
    const olderId = oneUser.record('alice', { ...target, dispatchedAt: Date.now() - 1000 });
    const newerId = oneUser.record('alice', { ...target, dispatchedAt: Date.now() - 900 });
    const own = await oneUser.listWithStatus('alice', app);
    const twoUsers = new DispatchTracker();
    twoUsers.record('bob', { ...target, dispatchedAt: Date.now() - 1000 });
    twoUsers.record('alice', { ...target, dispatchedAt: Date.now() - 900 });
    const aliceList = await twoUsers.listWithStatus('alice', app);
    server.close();
    const byId = new Map(own.map((r) => [r.id, r]));
    assert.strictEqual(byId.get(olderId).status.runId, 985, 'the older of two same-user dispatches must claim the run');
    assert.strictEqual(byId.get(newerId).status.state, 'pending', 'the newer same-user dispatch must not double-claim it');
    assert.strictEqual(aliceList[0].status.state, 'pending', 'the newer dispatch must not claim the run ahead of another user\'s older one');
    assert.strictEqual(twoUsers.list('bob')[0].boundRunId, 985, 'the other user\'s older dispatch keeps the run');
  });

  await checkAsync('an unmatched record older than the cap is reported as errored, never searched again', async () => {
    const { server, calls } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: 'abababababababababababababababab', correlationSupported: true,
      dispatchedAt: Date.now() - (MAX_UNMATCHED_RECORD_AGE_MS + 60000),
    });
    const list = await tracker.listWithStatus('alice', app);
    server.close();
    assert.strictEqual(list[0].status.state, 'error');
    assert.strictEqual(calls.byPath['GET /repos/acme/widgets/actions/workflows/squad-dispatch.yml/runs'] || 0, 0);
  });

  await checkAsync('a missing receipt stays pending until the age cap, then errors', async () => {
    let now = 1_700_000_000_000;
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs: [] });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const tracker = new DispatchTracker({ now: () => now });
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: 'bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc', correlationSupported: true, dispatchedAt: now,
    });
    const pending = await tracker.listWithStatus('alice', app);
    now += MAX_UNMATCHED_RECORD_AGE_MS + 1;
    const errored = await tracker.listWithStatus('alice', app);
    server.close();
    assert.strictEqual(pending[0].status.state, 'pending');
    assert.strictEqual(errored[0].status.state, 'error');
  });

  await checkAsync('an old unmatched record past the cap never steals a newer dispatch run', async () => {
    const corrOld = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
    const corrNew = 'dededededededededededededededede';
    const runs = [{ id: 990, status: 'in_progress', conclusion: null, head_branch: 'main', display_title: correlationTitle(corrNew) }];
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, runs });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: corrOld, correlationSupported: true, dispatchedAt: Date.now() - (MAX_UNMATCHED_RECORD_AGE_MS + 60000),
    });
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: corrNew, correlationSupported: true, dispatchedAt: Date.now() - 1000,
    });
    const list = await tracker.listWithStatus('alice', app);
    server.close();
    const newer = list.find((r) => r.status.runId === 990);
    const older = list.find((r) => r !== newer);
    assert.strictEqual(newer.status.runId, 990);
    assert.strictEqual(older.status.state, 'error');
  });

  await checkAsync('an older installed workflow is reported as unsupported forever and never searched', async () => {
    const { server, calls } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    let resolveCalls = 0;
    app.resolveRunStatus = async () => {
      resolveCalls += 1;
      throw new Error('listWithStatus must short-circuit unsupported records before resolveRunStatus');
    };
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: null, correlationSupported: false, dispatchedAt: Date.now(),
    });
    const list = await tracker.listWithStatus('alice', app);
    server.close();
    assert.strictEqual(list[0].status.state, 'unsupported');
    assert.strictEqual(resolveCalls, 0);
    assert.strictEqual(calls.byPath['GET /repos/acme/widgets/actions/workflows/squad-dispatch.yml/runs'] || 0, 0);
  });

  await checkAsync('a concurrent poll that already bound a record is never overwritten by a slower, stale search result', async () => {
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: 'efefefefefefefefefefefefefefefef', correlationSupported: true, dispatchedAt: Date.now() - 1000,
    });
    const liveRecord = tracker.list('alice')[0];
    const CONCURRENTLY_BOUND_RUN_ID = 4242;
    const STALE_RUN_ID = 9999;
    const fakeApp = {
      resolveRunStatus: async () => {
        liveRecord.boundRunId = CONCURRENTLY_BOUND_RUN_ID;
        return { state: 'queued', runId: STALE_RUN_ID, htmlUrl: 'https://example.invalid/stale' };
      },
      _getRun: async (owner, repo, installationId, runId) => {
        assert.strictEqual(runId, CONCURRENTLY_BOUND_RUN_ID, 'must defer to the concurrently-bound run, not its own stale search result');
        return { state: 'in_progress', runId, htmlUrl: 'https://example.invalid/real' };
      },
    };
    const list = await tracker.listWithStatus('alice', fakeApp);
    assert.strictEqual(list[0].status.runId, CONCURRENTLY_BOUND_RUN_ID);
    assert.strictEqual(liveRecord.boundRunId, CONCURRENTLY_BOUND_RUN_ID);
  });

  // =========================================================================
  // Confirmed ACA execution receipt (artifact NAME via the Artifacts List API)
  // =========================================================================

  const newReceiptApp = async (opts) => {
    const fake = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, ...opts });
    const port = await listen(fake.server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    return { app, ...fake };
  };
  const receiptArgs = (runAttempt = 1, runId = 700) => ({
    owner: 'acme', repo: 'widgets', installationId: 1, runId, runAttempt,
  });
  const art = (name, extra = {}) => ({ id: 9000 + Math.floor(Math.random() * 1000), name, expired: false, ...extra });

  check('EXEC_RECEIPT_NAME_RE accepts only attempt-number plus a DNS-label-like execution name', () => {
    const m = EXEC_RECEIPT_NAME_RE.exec('aca-exec-attempt2-squad-job-abc123');
    assert.ok(m && m[1] === '2' && m[2] === 'squad-job-abc123');
    for (const bad of ['aca-exec-attempt-x', 'aca-exec-attemptx-job', 'aca-exec-attempt1--job', 'aca-exec-attempt1-job-',
      'aca-exec-attempt1-jo_b', 'aca-exec-attempt1-job.x', 'xaca-exec-attempt1-job', 'aca-exec-attempt1-job\n', `aca-exec-attempt1-${'a'.repeat(129)}`]) {
      assert.ok(!EXEC_RECEIPT_NAME_RE.test(bad), `should reject ${JSON.stringify(bad)}`);
    }
  });

  await checkAsync('resolveExecutionReceipt returns the execution name for exactly one current-attempt receipt', async () => {
    const { app, server, calls } = await newReceiptApp({ artifacts: [art('unrelated-artifact'), art('aca-exec-attempt1-job-abc123', { id: 4711 })] });
    const r = await app.resolveExecutionReceipt(receiptArgs(1));
    server.close();
    assert.deepStrictEqual(r, { executionName: 'job-abc123', artifactId: 4711 });
    assert.strictEqual(calls.byPath['GET /repos/acme/widgets/actions/runs/700/artifacts'], 1);
  });

  await checkAsync('resolveExecutionReceipt with no receipt yet is an honest null, not an error', async () => {
    const { app, server } = await newReceiptApp({ artifacts: [art('something-else')] });
    const r = await app.resolveExecutionReceipt(receiptArgs(1));
    server.close();
    assert.strictEqual(r, null);
  });

  await checkAsync('resolveExecutionReceipt refuses to guess between two current-attempt receipts', async () => {
    const { app, server } = await newReceiptApp({ artifacts: [art('aca-exec-attempt1-job-a'), art('aca-exec-attempt1-job-b')] });
    let err = null; let r;
    try { r = await app.resolveExecutionReceipt(receiptArgs(1)); } catch (e) { err = e; }
    server.close();
    assert.ok(err, `expected an error, got ${JSON.stringify(r)}`);
    assert.ok(/ambiguous execution receipt/.test(err.message), err.message);
  });

  await checkAsync('a single matching artifact on a truncated (bounded) artifact-list page fails closed instead of claiming uniqueness', async () => {
    const { app, server } = await newReceiptApp({
      artifacts: [art('aca-exec-attempt1-job-abc123', { id: 4711 })],
      artifactsTotalCount: 150,
    });
    let err = null; let r;
    try { r = await app.resolveExecutionReceipt(receiptArgs(1)); } catch (e) { err = e; }
    server.close();
    assert.ok(err, `expected an error, got ${JSON.stringify(r)}`);
    assert.ok(/refusing to assume this receipt match is unique/.test(err.message), err.message);
  });

  await checkAsync('no matching artifact on a truncated artifact-list page is still an honest null', async () => {
    const { app, server } = await newReceiptApp({
      artifacts: [art('unrelated-artifact')],
      artifactsTotalCount: 150,
    });
    const r = await app.resolveExecutionReceipt(receiptArgs(1));
    server.close();
    assert.strictEqual(r, null);
  });

  await checkAsync('resolveExecutionReceipt ignores a receipt left by a prior attempt after a rerun', async () => {
    const { app, server } = await newReceiptApp({ artifacts: [art('aca-exec-attempt1-job-old')] });
    const stale = await app.resolveExecutionReceipt(receiptArgs(2));
    server.close();
    assert.strictEqual(stale, null, 'a stale-attempt artifact must never be reported');
    const both = await newReceiptApp({ artifacts: [art('aca-exec-attempt1-job-old'), art('aca-exec-attempt2-job-new', { id: 5 })] });
    const r = await both.app.resolveExecutionReceipt(receiptArgs(2));
    both.server.close();
    assert.deepStrictEqual(r, { executionName: 'job-new', artifactId: 5 });
  });

  await checkAsync('resolveExecutionReceipt ignores an expired receipt', async () => {
    const { app, server } = await newReceiptApp({ artifacts: [art('aca-exec-attempt1-job-gone', { expired: true })] });
    const r = await app.resolveExecutionReceipt(receiptArgs(1));
    server.close();
    assert.strictEqual(r, null);
  });

  await checkAsync('resolveExecutionReceipt ignores a malformed execution name in an artifact name', async () => {
    const { app, server } = await newReceiptApp({ artifacts: [art('aca-exec-attempt1-job_bad'), art('aca-exec-attempt1--x')] });
    const r = await app.resolveExecutionReceipt(receiptArgs(1));
    server.close();
    assert.strictEqual(r, null);
  });

  await checkAsync('resolveExecutionReceipt surfaces a provider failure instead of returning null', async () => {
    const { app, server } = await newReceiptApp({ artifactsStatus: 500 });
    let err = null; let r;
    try { r = await app.resolveExecutionReceipt(receiptArgs(1)); } catch (e) { err = e; }
    server.close();
    assert.ok(err, `a non-200 must not look like "no receipt": ${JSON.stringify(r)}`);
    assert.ok(/artifacts for Actions run 700/.test(err.message), err.message);
  });

  await checkAsync('_getRun and resolveRunStatus both report the run_attempt', async () => {
    const corr = 'abababababababababababababababab';
    const runs = [{ id: 710, status: 'in_progress', head_branch: 'main', display_title: correlationTitle(corr), run_attempt: 3 }];
    const { app, server } = await newReceiptApp({ runs });
    const got = await app._getRun('acme', 'widgets', 1, 710);
    const matched = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, correlationId: corr, correlationSupported: true, ref: 'main',
    });
    server.close();
    assert.strictEqual(got.runAttempt, 3);
    assert.strictEqual(matched.runAttempt, 3);
  });

  const receiptTracker = () => {
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', correlationSupported: true, dispatchedAt: Date.now() - 1000,
    });
    return tracker;
  };
  const fakeReceiptApp = (receipt, calls) => ({
    resolveRunStatus: async () => ({ state: 'in_progress', runId: 800, runAttempt: 2, htmlUrl: 'https://example.invalid/r' }),
    _getRun: async (o, r, i, runId) => ({ state: 'in_progress', runId, runAttempt: 2, htmlUrl: 'https://example.invalid/r' }),
    resolveExecutionReceipt: async (args) => {
      calls.push(args);
      if (typeof receipt === 'function') return receipt(args);
      return receipt;
    },
  });

  await checkAsync('tracker surfaces a resolved executionName through the public record and passes the run attempt', async () => {
    const tracker = receiptTracker(); const calls = [];
    const list = await tracker.listWithStatus('alice', fakeReceiptApp({ executionName: 'job-xyz', artifactId: 1 }, calls));
    assert.strictEqual(list[0].executionName, 'job-xyz');
    assert.strictEqual(list[0].status.executionName, 'job-xyz');
    assert.deepStrictEqual(calls[0], { owner: 'acme', repo: 'widgets', installationId: 1, runId: 800, runAttempt: 2 });
    assert.ok(!('artifactId' in list[0]) && !('artifactId' in list[0].status), 'the artifact id is not exposed');
  });

  await checkAsync('tracker leaves executionName null, with no error, while no receipt is published', async () => {
    const tracker = receiptTracker(); const calls = [];
    const list = await tracker.listWithStatus('alice', fakeReceiptApp(null, calls));
    assert.strictEqual(list[0].executionName, null);
    assert.strictEqual(list[0].status.state, 'in_progress');
    assert.ok(!list[0].status.reason, 'no receipt yet is not an error');
    await tracker.listWithStatus('alice', fakeReceiptApp(null, calls));
    assert.strictEqual(calls.length, 2, 'an unresolved receipt is looked up again on the next poll');
  });

  await checkAsync('tracker never looks up a receipt for a queued, pending or unsupported dispatch', async () => {
    const calls = [];
    const queuedApp = { ...fakeReceiptApp(null, calls), resolveRunStatus: async () => ({ state: 'queued', runId: 801, runAttempt: 1 }) };
    await receiptTracker().listWithStatus('alice', queuedApp);
    const pendingApp = { ...fakeReceiptApp(null, calls), resolveRunStatus: async () => ({ state: 'pending', reason: 'none yet' }) };
    await receiptTracker().listWithStatus('alice', pendingApp);
    const unsupported = new DispatchTracker();
    unsupported.record('alice', { owner: 'acme', repo: 'widgets', installationId: 1, correlationSupported: false });
    await unsupported.listWithStatus('alice', fakeReceiptApp(null, calls));
    assert.strictEqual(calls.length, 0);
  });

  await checkAsync('tracker caches executionName and never re-resolves it on a later poll', async () => {
    const tracker = receiptTracker(); const calls = [];
    await tracker.listWithStatus('alice', fakeReceiptApp({ executionName: 'job-first', artifactId: 1 }, calls));
    const again = await tracker.listWithStatus('alice', fakeReceiptApp({ executionName: 'job-second', artifactId: 2 }, calls));
    assert.strictEqual(calls.length, 1, 'a cached name must not trigger another lookup');
    assert.strictEqual(again[0].executionName, 'job-first');
    assert.strictEqual(again[0].status.executionName, 'job-first');
  });

  await checkAsync('tracker drops a cached executionName when a rerun bumps the run attempt and re-resolves for the new attempt', async () => {
    const tracker = receiptTracker(); const calls = [];
    let attempt = 1;
    const app = {
      resolveRunStatus: async () => ({ state: 'in_progress', runId: 800, runAttempt: attempt }),
      _getRun: async (o, r, i, runId) => ({ state: 'in_progress', runId, runAttempt: attempt }),
      resolveExecutionReceipt: async (args) => {
        calls.push(args);
        if (args.runAttempt === 1) return { executionName: 'job-attempt1', artifactId: 1 };
        return calls.length >= 3 ? { executionName: 'job-attempt2', artifactId: 2 } : null;
      },
    };
    const first = await tracker.listWithStatus('alice', app);
    assert.strictEqual(first[0].executionName, 'job-attempt1');
    attempt = 2;
    const rerun = await tracker.listWithStatus('alice', app);
    assert.strictEqual(calls.length, 2, 'a rerun must trigger a fresh lookup');
    assert.strictEqual(calls[1].runAttempt, 2);
    assert.strictEqual(calls[1].runId, 800);
    assert.strictEqual(rerun[0].executionName, null, 'the stale attempt-1 name must not survive');
    assert.strictEqual(rerun[0].status.executionName, undefined);
    const resolved = await tracker.listWithStatus('alice', app);
    assert.strictEqual(resolved[0].executionName, 'job-attempt2');
    assert.strictEqual(resolved[0].status.executionName, 'job-attempt2');
    const stable = await tracker.listWithStatus('alice', app);
    assert.strictEqual(stable[0].executionName, 'job-attempt2');
    assert.strictEqual(calls.length, 3, 'the same attempt is never re-resolved');
  });

  await checkAsync('tracker never keeps a stale executionName while a rerun is queued, pending or errored', async () => {
    for (const later of [
      { state: 'queued', runId: 8, runAttempt: 2 },
      { state: 'pending', runId: 8, runAttempt: 2 },
      { state: 'error', runId: 8, runAttempt: 2, reason: 'boom' },
      { state: 'error', reason: 'no runId at all' },
    ]) {
      const tracker = receiptTracker(); let current = { state: 'in_progress', runId: 8, runAttempt: 1 };
      const app = {
        resolveRunStatus: async () => current,
        _getRun: async () => current,
        resolveExecutionReceipt: async () => ({ executionName: 'old', artifactId: 1 }),
      };
      const first = await tracker.listWithStatus('alice', app);
      assert.strictEqual(first[0].executionName, 'old');
      current = later;
      const second = await tracker.listWithStatus('alice', app);
      assert.strictEqual(second[0].executionName, null, `stale name leaked for ${later.state}`);
      assert.strictEqual(second[0].status.executionName, undefined);
    }
  });

  await checkAsync('a rerun clears the cached executionName and its attempt from the tracker record, in every rerun state', async () => {
    // The public list cannot show this. The attempt comparison in
    // _withExecutionReceipt and the one in _publicRecord each hide a name cached
    // for another attempt, so a record that kept it would still read null. The
    // record is what a later poll starts from, and the one thing that can tell
    // the drop happened.
    for (const rerun of [
      { state: 'queued', runId: 8, runAttempt: 2 },
      { state: 'pending', runId: 8, runAttempt: 2 },
      { state: 'error', runId: 8, runAttempt: 2, reason: 'boom' },
      { state: 'in_progress', runId: 8, runAttempt: 2 },
    ]) {
      const tracker = receiptTracker(); const calls = [];
      const live = tracker.list('alice')[0];
      let current = { state: 'in_progress', runId: 8, runAttempt: 1 };
      const app = {
        resolveRunStatus: async () => current,
        _getRun: async () => current,
        resolveExecutionReceipt: async (args) => {
          calls.push(args);
          return args.runAttempt === 1 ? { executionName: 'job-attempt1', artifactId: 1 } : null;
        },
      };
      await tracker.listWithStatus('alice', app);
      assert.deepStrictEqual([live.executionName, live.executionAttempt], ['job-attempt1', 1],
        'the fixture must cache attempt 1\'s name before the rerun, or the check below proves nothing');
      current = rerun;
      await tracker.listWithStatus('alice', app);
      assert.deepStrictEqual([live.executionName, live.executionAttempt], [null, null],
        `a ${rerun.state} rerun left attempt 1's name cached on the tracker record`);
      // Only a run that has started is looked up, for exactly this run and attempt.
      assert.deepStrictEqual(calls.slice(1), rerun.state === 'in_progress'
        ? [{ owner: 'acme', repo: 'widgets', installationId: 1, runId: 8, runAttempt: 2 }] : [],
      `a ${rerun.state} rerun made the wrong receipt lookups: ${JSON.stringify(calls.slice(1))}`);
    }
  });

  await checkAsync('overlapping polls share one receipt lookup and agree on executionName', async () => {
    const tracker = receiptTracker(); const calls = [];
    let release; const gate = new Promise((r) => { release = r; });
    const app = fakeReceiptApp(async () => { await gate; return { executionName: 'job-shared', artifactId: 3 }; }, calls);
    // bind first so both polls take the already-bound path
    await tracker.listWithStatus('alice', { ...app, resolveExecutionReceipt: async () => null });
    calls.length = 0;
    const a = tracker.listWithStatus('alice', app);
    const b = tracker.listWithStatus('alice', app);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [la, lb] = await Promise.all([a, b]);
    assert.strictEqual(calls.length, 1, 'concurrent polls must not both query GitHub');
    assert.strictEqual(la[0].executionName, 'job-shared');
    assert.strictEqual(lb[0].executionName, 'job-shared');
  });

  await checkAsync('a concurrent poll that already cached executionName is never overwritten by a slower lookup', async () => {
    const tracker = receiptTracker(); const calls = [];
    const live = tracker.list('alice')[0];
    const app = fakeReceiptApp(async () => { live.executionName = 'job-winner'; live.executionAttempt = 2; return { executionName: 'job-late', artifactId: 4 }; }, calls);
    const list = await tracker.listWithStatus('alice', app);
    assert.strictEqual(live.executionName, 'job-winner');
    assert.strictEqual(list[0].executionName, 'job-winner');
  });

  await checkAsync('a failed receipt lookup keeps the run status and never hides another record', async () => {
    const tracker = receiptTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'gadgets', installationId: 1, ref: 'main',
      correlationId: 'dededededededededededededededede', correlationSupported: true, dispatchedAt: Date.now() - 500,
    });
    const calls = [];
    const app = fakeReceiptApp((args) => {
      if (args.repo === 'widgets') throw Object.assign(new Error('boom'), { status: 502 });
      return { executionName: 'job-gadgets', artifactId: 5 };
    }, calls);
    const list = await tracker.listWithStatus('alice', app);
    const widgets = list.find((x) => x.repo === 'widgets');
    const gadgets = list.find((x) => x.repo === 'gadgets');
    assert.strictEqual(widgets.status.state, 'in_progress', 'the run status survives a receipt failure');
    assert.ok(/execution receipt lookup failed: boom/.test(widgets.status.reason), widgets.status.reason);
    assert.strictEqual(widgets.executionName, null);
    assert.strictEqual(gadgets.executionName, 'job-gadgets');
  });

  await checkAsync('a user never sees another user\'s executionName', async () => {
    const tracker = receiptTracker(); const calls = [];
    tracker.record('bob', { owner: 'acme', repo: 'widgets', installationId: 1, correlationSupported: false });
    await tracker.listWithStatus('alice', fakeReceiptApp({ executionName: 'job-alice', artifactId: 6 }, calls));
    const bob = await tracker.listWithStatus('bob', fakeReceiptApp(null, calls));
    assert.strictEqual(bob.length, 1);
    assert.strictEqual(bob[0].executionName, null);
  });

  await checkAsync('cross-attempt overlapping receipt lookups: a stale attempt-1 resolution must not clobber or block a newer attempt-2 receipt', async () => {
    // Exact reproduction of the #245/#247 overlapping-refresh race: poll A
    // observes attempt 1 and starts its own receipt lookup; before that
    // lookup resolves, poll B observes the SAME run has already rerun to
    // attempt 2 and starts its own lookup. Poll A's (now stale) lookup is
    // made to resolve FIRST, then poll B's resolves.
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', correlationSupported: true, dispatchedAt: Date.now() - 1000,
    });
    const receiptCalls = [];
    const resolvers = [];
    const app = {
      resolveRunStatus: async () => ({ state: 'in_progress', runId: 42, runAttempt: 1, htmlUrl: 'https://example.invalid/r' }),
      _getRun: async () => ({ state: 'in_progress', runId: 42, runAttempt: 2, htmlUrl: 'https://example.invalid/r' }),
      resolveExecutionReceipt: (args) => {
        receiptCalls.push(args);
        return new Promise((resolve) => { resolvers.push(resolve); });
      },
    };

    const p1 = tracker.listWithStatus('alice', app);
    // Let p1 run past resolveRunStatus and reach its own (still-pending)
    // receipt lookup before poll B starts.
    await new Promise((r) => setTimeout(r, 0));
    const p2 = tracker.listWithStatus('alice', app);
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(receiptCalls.length, 2, 'both the stale attempt-1 and current attempt-2 lookups were started');
    assert.strictEqual(receiptCalls[0].runAttempt, 1);
    assert.strictEqual(receiptCalls[1].runAttempt, 2);

    // The attempt-1 lookup resolves FIRST, well after poll B already
    // observed attempt 2.
    resolvers[0]({ executionName: 'synthetic-attempt-one', artifactId: 1 });
    const list1 = await p1;
    resolvers[1]({ executionName: 'synthetic-attempt-two', artifactId: 2 });
    const list2 = await p2;

    assert.strictEqual(list1[0].executionName, null, 'the superseded attempt-1 lookup must be discarded, not published as current');
    assert.strictEqual(list2[0].executionName, 'synthetic-attempt-two', 'the current attempt-2 poll must get its own correct name, not null and not the stale one');
    assert.strictEqual(list2[0].status.runAttempt, 2);

    // A later poll for the same (still current) attempt must see the
    // correct cached name and must not re-resolve it.
    const list3 = await tracker.listWithStatus('alice', {
      ...app,
      resolveExecutionReceipt: () => { throw new Error('must not be called again: already cached for this attempt'); },
    });
    assert.strictEqual(list3[0].executionName, 'synthetic-attempt-two');
  });

  await checkAsync('cross-attempt overlapping receipt lookups: reversed completion order (newer attempt resolves first) is also fenced correctly', async () => {
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', correlationSupported: true, dispatchedAt: Date.now() - 1000,
    });
    const resolvers = [];
    const app = {
      resolveRunStatus: async () => ({ state: 'in_progress', runId: 43, runAttempt: 1, htmlUrl: 'https://example.invalid/r' }),
      _getRun: async () => ({ state: 'in_progress', runId: 43, runAttempt: 2, htmlUrl: 'https://example.invalid/r' }),
      resolveExecutionReceipt: () => new Promise((resolve) => { resolvers.push(resolve); }),
    };
    const p1 = tracker.listWithStatus('alice', app);
    await new Promise((r) => setTimeout(r, 0));
    const p2 = tracker.listWithStatus('alice', app);
    await new Promise((r) => setTimeout(r, 0));
    // Newer attempt (2) resolves FIRST this time, older attempt (1) resolves after.
    resolvers[1]({ executionName: 'synthetic-newer', artifactId: 2 });
    const list2 = await p2;
    resolvers[0]({ executionName: 'synthetic-older', artifactId: 1 });
    const list1 = await p1;
    assert.strictEqual(list2[0].executionName, 'synthetic-newer');
    assert.strictEqual(list1[0].executionName, null, 'the stale attempt-1 result must not overwrite the already-cached newer attempt');
  });

  await checkAsync('a stale deferred run-status arriving after a newer attempt is already cached must not clear the cache or re-query (#247)', async () => {
    // Exact reproduction of the #247 finding-1 bug: this is NOT the
    // #245 receipt-lookup race the two tests above already cover -- this one
    // is about the run STATUS itself (from a bound record's own `_getRun`),
    // arriving late, after a concurrent poll has already observed and fully
    // CACHED a newer attempt's executionName.
    const tracker = new DispatchTracker();
    tracker.record('alice', {
      owner: 'acme', repo: 'widgets', installationId: 1, ref: 'main',
      correlationId: 'c0ffeec0ffeec0ffeec0ffeec0ffeec0', correlationSupported: true, dispatchedAt: Date.now() - 2000,
    });

    // Seed: a first, uncontested poll binds the run and fully caches
    // attempt 2's executionName.
    const seedApp = {
      resolveRunStatus: async () => ({ state: 'in_progress', runId: 42, runAttempt: 2, htmlUrl: 'https://example.invalid/r' }),
      resolveExecutionReceipt: async () => ({ executionName: 'synthetic-attempt-2', artifactId: 9 }),
    };
    const seeded = await tracker.listWithStatus('alice', seedApp);
    assert.strictEqual(seeded[0].executionName, 'synthetic-attempt-2', 'seed poll must have cached attempt 2');

    // oldPoll: its own `_getRun` is deferred (never resolves until released,
    // below) -- simulating a slow read that started before, but is only
    // observed after, a concurrent fresher read.
    let releaseOld;
    const oldGate = new Promise((resolve) => { releaseOld = resolve; });
    const oldPoll = tracker.listWithStatus('alice', {
      ...seedApp,
      _getRun: () => oldGate,
      resolveExecutionReceipt: () => { throw new Error('a stale, superseded status must never start its own receipt lookup'); },
    });
    await new Promise((r) => setTimeout(r, 0));

    // newPoll: its own `_getRun` resolves immediately, confirming the SAME
    // (already cached) attempt 2 -- the ordinary, correct refresh path.
    const newPoll = await tracker.listWithStatus('alice', {
      ...seedApp,
      _getRun: async () => ({ state: 'in_progress', runId: 42, runAttempt: 2, htmlUrl: 'https://example.invalid/r' }),
      resolveExecutionReceipt: () => { throw new Error('already cached for this attempt; must not be re-resolved'); },
    });
    assert.strictEqual(newPoll[0].executionName, 'synthetic-attempt-2', 'the fresh same-attempt poll must still see the cached name');

    // NOW release the deferred old `_getRun`, reporting the STALE attempt 1
    // -- after attempt 2 is already fully cached and confirmed above.
    releaseOld({ state: 'in_progress', runId: 42, runAttempt: 1, htmlUrl: 'https://example.invalid/r' });
    const oldResult = await oldPoll;

    // The stale attempt-1 status is allowed to report itself as stale (it
    // genuinely does not match attempt 2), but it must NOT have destroyed
    // the record's cache: a poll running right after it must still see
    // attempt 2's cached name, not null, and must not re-query GitHub for it.
    assert.strictEqual(oldResult[0].executionName, null, 'a status for an attempt behind the fence legitimately withholds its own name');
    const afterStale = await tracker.listWithStatus('alice', {
      ...seedApp,
      _getRun: async () => ({ state: 'in_progress', runId: 42, runAttempt: 2, htmlUrl: 'https://example.invalid/r' }),
      resolveExecutionReceipt: () => { throw new Error('the stale attempt-1 status must not have cleared the cache for attempt 2'); },
    });
    assert.strictEqual(afterStale[0].executionName, 'synthetic-attempt-2', 'a late stale status must never clobber an already-cached newer attempt');
  });

  await checkAsync('a minted installation token for a dispatch is scoped to just the target repository', async () => {
    const { server, state } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets', 'acme/other'] } });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    await app.dispatch({
      owner: 'acme', repo: 'widgets', installationId: 1, issue: 1, prompt: 'go', actor: TEST_ACTOR,
    });
    server.close();
    const scopedMint = state.tokenMintBodies.find((m) => m.body && Array.isArray(m.body.repositories));
    assert.ok(scopedMint, 'a dispatch must mint a token scoped with `repositories`');
    assert.deepStrictEqual(scopedMint.body.repositories, ['widgets'], 'the token must be scoped to only the dispatched repository, by name');
  });

  await checkAsync('listing installed repos mints an unscoped installation token, not repo-scoped', async () => {
    const { server, state } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    await app.listInstalledRepos();
    server.close();
    assert.ok(state.tokenMintBodies.length >= 1, 'listInstalledRepos must mint at least one installation token');
    assert.ok(
      state.tokenMintBodies.every((m) => !m.body || !m.body.repositories),
      'enumerating every installed repository needs the whole installation\'s token, not one scoped to a single repository',
    );
  });

  await checkAsync('listInstalledRepos pages past 100 installations and 100 repositories', async () => {
    const manyInstallations = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, login: `org${i + 1}` }));
    const manyRepos = Array.from({ length: 150 }, (_, i) => `acme/repo-${i + 1}`);
    const { server } = fakeGitHubApp({
      installations: manyInstallations,
      // Only installation 1 actually gets repos in this fake (it unions
      // across every key) -- enough to prove `_listInstallationRepos`
      // itself pages correctly, alongside `_listInstallations` above.
      reposByInstallation: { 1: manyRepos },
    });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const installations = await app._listInstallations();
    server.close();
    assert.strictEqual(installations.length, 120, 'every installation past the first 100 must still be listed');
  });

  await checkAsync('_listInstallationRepos pages past 100 repositories on one installation', async () => {
    const manyRepos = Array.from({ length: 150 }, (_, i) => `acme/repo-${i + 1}`);
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: manyRepos } });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const repos = await app._listInstallationRepos('ghs_fake_token');
    server.close();
    assert.strictEqual(repos.length, 150, 'every repository past the first 100 must still be listed');
    assert.ok(repos.includes('acme/repo-150'), 'the very last repository must not be dropped');
  });

  await checkAsync('GET /api/aca/repos is rate-limited per signed-in user', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = githubAuth();
    const githubApp = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp,
      acaReadRateLimiter: new RateLimiter({ limit: 2, windowMs: 60000 }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r1 = await apiRequest(addr.port, '/api/aca/repos', token);
    const r2 = await apiRequest(addr.port, '/api/aca/repos', token);
    const r3 = await apiRequest(addr.port, '/api/aca/repos', token);
    await svc.close();
    server.close();
    assert.strictEqual(r1.status, 200, JSON.stringify(r1));
    assert.strictEqual(r2.status, 200, JSON.stringify(r2));
    assert.strictEqual(r3.status, 429, JSON.stringify(r3));
  });

  await checkAsync('GET /api/aca/dispatches is rate-limited per signed-in user', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = githubAuth();
    const githubApp = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp,
      acaReadRateLimiter: new RateLimiter({ limit: 2, windowMs: 60000 }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r1 = await apiRequest(addr.port, '/api/aca/dispatches', token);
    const r2 = await apiRequest(addr.port, '/api/aca/dispatches', token);
    const r3 = await apiRequest(addr.port, '/api/aca/dispatches', token);
    await svc.close();
    server.close();
    assert.strictEqual(r1.status, 200, JSON.stringify(r1));
    assert.strictEqual(r2.status, 200, JSON.stringify(r2));
    assert.strictEqual(r3.status, 429, JSON.stringify(r3));
  });

  await checkAsync('GET /api/aca/repos and GET /api/aca/dispatches share one read rate-limit budget', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = githubAuth();
    const githubApp = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp,
      acaReadRateLimiter: new RateLimiter({ limit: 2, windowMs: 60000 }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;
    const r1 = await apiRequest(addr.port, '/api/aca/repos', token);
    const r2 = await apiRequest(addr.port, '/api/aca/dispatches', token);
    const r3 = await apiRequest(addr.port, '/api/aca/repos', token);
    await svc.close();
    server.close();
    assert.strictEqual(r1.status, 200, JSON.stringify(r1));
    assert.strictEqual(r2.status, 200, JSON.stringify(r2));
    assert.strictEqual(r3.status, 429, JSON.stringify(r3));
  });

  // =========================================================================
  // #258: repository authorization. "The App is installed there" says the
  // OPERATOR chose the repository; it says nothing about the person calling.
  // Every case below is the real GitHub-mode Authenticator, the real HubService
  // and the real GitHubApp over the faked GitHub REST surface; the signed-in
  // GitHub account is what decides, per request, and nothing else.
  // =========================================================================

  const ALICE = { login: 'alice', id: 1001 };
  const BOB = { login: 'bob', id: 2002 };
  const aliceToken = tokenFor(ALICE);
  const bobToken = tokenFor(BOB);
  const WORKFLOW_CONTENTS = 'GET /repos/acme/beta/contents/.github/workflows/squad-dispatch.yml';
  const trackedCount = (svc) => [...svc.dispatchTracker._byUser.values()].reduce((n, l) => n + l.length, 0);
  const sideEffects = (fake, svc) => ({
    issues: fake.state.createdIssues.length, dispatches: fake.state.dispatches.length, tracked: trackedCount(svc),
  });
  const NO_SIDE_EFFECTS = { issues: 0, dispatches: 0, tracked: 0 };

  /** Two different GitHub users on ONE hub and ONE App, both on the owner list
   * (so both land in the SAME partition -- which must confer no repository
   * authority), each with a disjoint private repository plus one shared. */
  async function twoUserHub({ repoAccess, users, auth, fakeOptions = {}, serviceOptions = {} } = {}) {
    const fake = fakeGitHubApp({
      reposByInstallation: { 1: ['acme/alpha', 'acme/beta', 'acme/shared'] },
      users: users || { alice: ALICE.id, bob: BOB.id },
      repoAccess: repoAccess || {
        'acme/alpha': { alice: 'write' },
        'acme/beta': { bob: 'admin' },
        'acme/shared': { alice: 'write', bob: 'write' },
      },
      ...fakeOptions,
    });
    const port = await listen(fake.server);
    const svc = new HubService({
      auth: auth || githubAuth({ users: [ALICE, BOB], owner: ['alice', 'bob'] }),
      serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
      ...serviceOptions,
    });
    const addr = await svc.listen(0, '127.0.0.1');
    return {
      fake, svc, port: addr.port,
      async close() { await svc.close(); fake.server.close(); },
    };
  }
  const fullNames = (r) => r.body.repos.map((x) => x.fullName).sort();

  await checkAsync('two verified GitHub users on one hub and one App see disjoint repository lists, though both share the owner partition (#258)', async () => {
    const hub = await twoUserHub();
    const meA = await apiRequest(hub.port, '/api/me', aliceToken);
    const meB = await apiRequest(hub.port, '/api/me', bobToken);
    const a = await apiRequest(hub.port, '/api/aca/repos', aliceToken);
    const b = await apiRequest(hub.port, '/api/aca/repos', bobToken);
    const beforeContentsReads = hub.fake.calls.byPath[WORKFLOW_CONTENTS];
    await hub.close();
    assert.strictEqual(meA.body.subject, meB.body.subject, 'the fixture is meant to put both users in ONE partition');
    assert.deepStrictEqual(fullNames(a), ['acme/alpha', 'acme/shared'], JSON.stringify(a));
    assert.deepStrictEqual(fullNames(b), ['acme/beta', 'acme/shared'], JSON.stringify(b));
    assert.strictEqual(beforeContentsReads, 1, 'the workflow file is read only for a repository the caller was authorized on (beta: bob only)');
  });

  await checkAsync('the repository list stays disjoint across warm caches and when both users list at once (#258)', async () => {
    const hub = await twoUserHub({ serviceOptions: { acaReadRateLimiter: new RateLimiter({ limit: 1000, windowMs: 60000 }) } });
    const warmA = await apiRequest(hub.port, '/api/aca/repos', aliceToken);
    const afterA = await apiRequest(hub.port, '/api/aca/repos', bobToken);
    const burst = await Promise.all([
      ...Array.from({ length: 4 }, () => apiRequest(hub.port, '/api/aca/repos', aliceToken)),
      ...Array.from({ length: 4 }, () => apiRequest(hub.port, '/api/aca/repos', bobToken)),
    ]);
    await hub.close();
    assert.deepStrictEqual(fullNames(warmA), ['acme/alpha', 'acme/shared']);
    assert.deepStrictEqual(fullNames(afterA), ['acme/beta', 'acme/shared'], 'user B was served from user A\'s warm state');
    burst.forEach((r, i) => {
      assert.deepStrictEqual(fullNames(r), i < 4 ? ['acme/alpha', 'acme/shared'] : ['acme/beta', 'acme/shared'], `concurrent request ${i}: ${JSON.stringify(r)}`);
    });
  });

  await checkAsync('a forged cross-user POST is refused 403 with zero issues, zero dispatches and nothing tracked -- existing issue and new issue (#258)', async () => {
    const hub = await twoUserHub();
    // Warm the shared installation-token cache with alice's own successful use first.
    const ok = await apiRequest(hub.port, '/api/aca/dispatch', aliceToken, {
      method: 'POST', body: { repo: 'acme/alpha', issue: 3, prompt: 'mine' },
    });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok));
    const baseline = sideEffects(hub.fake, hub.svc);
    const existing = await apiRequest(hub.port, '/api/aca/dispatch', aliceToken, {
      method: 'POST', body: { repo: 'acme/beta', issue: 9, prompt: 'steal' },
    });
    const fresh = await apiRequest(hub.port, '/api/aca/dispatch', aliceToken, {
      method: 'POST', body: { repo: 'acme/beta', newIssue: { title: 'planted' }, prompt: 'steal' },
    });
    const reverse = await apiRequest(hub.port, '/api/aca/dispatch', bobToken, {
      method: 'POST', body: { repo: 'acme/alpha', newIssue: { title: 'planted' }, prompt: 'steal' },
    });
    const contentsReadOfBeta = hub.fake.calls.byPath[WORKFLOW_CONTENTS];
    const after = sideEffects(hub.fake, hub.svc);
    await hub.close();
    for (const r of [existing, fresh, reverse]) {
      assert.strictEqual(r.status, 403, JSON.stringify(r));
      assert.match(r.body.error, /not available to your GitHub account/);
    }
    assert.deepStrictEqual(after, baseline, 'a refused request must have no side effect at all');
    assert.strictEqual(contentsReadOfBeta, undefined, 'a refused request must not even read the repository\'s workflow');
  });

  await checkAsync('the same cross-user POSTs, fired concurrently with each user\'s own, never leak (#258)', async () => {
    const hub = await twoUserHub({ serviceOptions: { acaRateLimiter: new RateLimiter({ limit: 1000, windowMs: 60000 }) } });
    const results = await Promise.all([
      apiRequest(hub.port, '/api/aca/dispatch', aliceToken, { method: 'POST', body: { repo: 'acme/alpha', issue: 1, prompt: 'a' } }),
      apiRequest(hub.port, '/api/aca/dispatch', bobToken, { method: 'POST', body: { repo: 'acme/alpha', issue: 2, prompt: 'x' } }),
      apiRequest(hub.port, '/api/aca/dispatch', bobToken, { method: 'POST', body: { repo: 'acme/beta', issue: 3, prompt: 'b' } }),
      apiRequest(hub.port, '/api/aca/dispatch', aliceToken, { method: 'POST', body: { repo: 'acme/beta', issue: 4, prompt: 'x' } }),
    ]);
    const dispatched = hub.fake.state.dispatches.map((d) => `${d.owner}/${d.repo}#${d.inputs.issue}`).sort();
    await hub.close();
    assert.deepStrictEqual(results.map((r) => r.status), [200, 403, 200, 403]);
    assert.deepStrictEqual(dispatched, ['acme/alpha#1', 'acme/beta#3']);
  });

  await checkAsync('access revoked after a successful listing is refused at POST, with no side effect, and drops off the next listing (#258)', async () => {
    const hub = await twoUserHub();
    const listed = await apiRequest(hub.port, '/api/aca/repos', aliceToken);
    assert.ok(fullNames(listed).includes('acme/alpha'));
    delete hub.fake.state.repoAccess['acme/alpha'].alice;
    const post = await apiRequest(hub.port, '/api/aca/dispatch', aliceToken, {
      method: 'POST', body: { repo: 'acme/alpha', newIssue: { title: 'late' }, prompt: 'go' },
    });
    const relisted = await apiRequest(hub.port, '/api/aca/repos', aliceToken);
    const effects = sideEffects(hub.fake, hub.svc);
    await hub.close();
    assert.strictEqual(post.status, 403, JSON.stringify(post));
    assert.deepStrictEqual(effects, NO_SIDE_EFFECTS);
    assert.deepStrictEqual(fullNames(relisted), ['acme/shared']);
  });

  await checkAsync('a login reassigned to a different GitHub account is denied: the numeric id decides, not the login (#258)', async () => {
    // The hub verified `carol` as id 9999 (GitHub told it so at sign-in). By now the name `carol`
    // belongs to account 3003, which does hold write access: the answer's user.id gives it away.
    const carol = { login: 'carol', id: 9999 };
    const hub = await twoUserHub({
      users: { carol: 3003 },
      repoAccess: { 'acme/alpha': { carol: 'write' } },
      auth: githubAuth({ users: [carol], owner: [] }),
    });
    const list = await apiRequest(hub.port, '/api/aca/repos', tokenFor(carol));
    const post = await apiRequest(hub.port, '/api/aca/dispatch', tokenFor(carol), {
      method: 'POST', body: { repo: 'acme/alpha', newIssue: { title: 'x' }, prompt: 'go' },
    });
    const effects = sideEffects(hub.fake, hub.svc);
    await hub.close();
    assert.strictEqual(list.status, 200, JSON.stringify(list));
    assert.deepStrictEqual(list.body.repos, []);
    assert.strictEqual(post.status, 403, JSON.stringify(post));
    assert.deepStrictEqual(effects, NO_SIDE_EFFECTS);
  });

  await checkAsync('write and admin may use a repository (maintain reports as write); read, triage, none and anything unrecognised may not (#258)', async () => {
    const cases = [
      ['write', undefined, true],
      ['admin', undefined, true],
      ['write', 'maintain', true],
      ['read', undefined, false],
      ['read', 'triage', false],
      ['none', undefined, false],
      ['maintain', undefined, false],
      ['triage', undefined, false],
      ['superuser', undefined, false],
      // role_name is never an authorization input, whatever it is called.
      ['read', 'admin', false],
      ['none', 'write', false],
      ['', undefined, false],
    ];
    for (const [permission, roleName, expected] of cases) {
      const fake = fakeGitHubApp({ users: { alice: ALICE.id }, repoAccess: { 'acme/widgets': { alice: { permission, roleName } } } });
      const port = await listen(fake.server);
      const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
      const verdict = await app.authorizeRepoAccess({ owner: 'acme', repo: 'widgets', installationId: 1 }, { id: String(ALICE.id), login: 'alice' });
      fake.server.close();
      assert.strictEqual(verdict.allowed, expected, `permission=${JSON.stringify(permission)} role_name=${roleName}`);
    }
  });

  await checkAsync('the check asks GitHub about the verified login with a repository-scoped installation token (#258)', async () => {
    const fake = fakeGitHubApp({ users: { alice: ALICE.id }, repoAccess: { 'acme/widgets': { alice: 'write' } } });
    const port = await listen(fake.server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    await app.authorizeRepoAccess({ owner: 'acme', repo: 'widgets', installationId: 1 }, { id: String(ALICE.id), login: 'alice' });
    fake.server.close();
    assert.deepStrictEqual(fake.state.permissionChecks.map((c) => `${c.owner}/${c.repo}:${c.login}`), ['acme/widgets:alice']);
    assert.match(fake.state.permissionChecks[0].authorization, /ghs_fake_/, 'must use an installation token');
    assert.deepStrictEqual(fake.state.tokenMintBodies[0].body.repositories, ['widgets'], 'the token must be scoped to the one repository');
  });

  const failures = [
    ['GitHub 401', { status: 401 }],
    ['GitHub 403', { status: 403 }],
    ['GitHub 429 rate limit', { status: 429 }],
    ['GitHub 500', { status: 500 }],
    ['GitHub 503', { status: 503 }],
    ['a dropped connection', { destroy: true }],
    ['a 200 that is not JSON', { raw: '<html>not json</html>' }],
    ['a 200 JSON that is not an object', { raw: '[]' }],
    ['a 200 with no permission field', { body: { user: { id: ALICE.id, login: 'alice' } } }],
    ['a 200 with a non-string permission', { body: { permission: 5, user: { id: ALICE.id } } }],
  ];
  await checkAsync('any failure while verifying access fails closed: the list answers 502 with no repos and the POST answers 502 with no side effect (#258)', async () => {
    for (const [label, grant] of failures) {
      const hub = await twoUserHub({ repoAccess: { 'acme/alpha': { alice: grant }, 'acme/shared': { alice: 'write' } } });
      const list = await apiRequest(hub.port, '/api/aca/repos', aliceToken);
      const post = await apiRequest(hub.port, '/api/aca/dispatch', aliceToken, {
        method: 'POST', body: { repo: 'acme/alpha', newIssue: { title: 'x' }, prompt: 'go' },
      });
      const effects = sideEffects(hub.fake, hub.svc);
      await hub.close();
      assert.strictEqual(list.status, 502, `${label}: ${JSON.stringify(list)}`);
      assert.ok(!list.body.repos, `${label}: a verification failure must never return any repository, filtered or not`);
      assert.match(list.body.error, /could not verify your access/, label);
      assert.strictEqual(post.status, 502, `${label}: ${JSON.stringify(post)}`);
      assert.deepStrictEqual(effects, NO_SIDE_EFFECTS, label);
    }
  });
  await checkAsync('a 404 from the permission lookup is "not available", not an error: the repo is simply absent (#258)', async () => {
    // carol signed in fine, but GitHub's permission lookup does not know her at all -> 404.
    const carol = { login: 'carol', id: 3003 };
    const hub = await twoUserHub({ repoAccess: { 'acme/alpha': { alice: 'write' } }, auth: githubAuth({ users: [carol], owner: [] }) });
    const list = await apiRequest(hub.port, '/api/aca/repos', tokenFor(carol));
    const post = await apiRequest(hub.port, '/api/aca/dispatch', tokenFor(carol), {
      method: 'POST', body: { repo: 'acme/alpha', issue: 1, prompt: 'go' },
    });
    await hub.close();
    assert.strictEqual(list.status, 200, JSON.stringify(list));
    assert.deepStrictEqual(list.body.repos, []);
    assert.strictEqual(post.status, 403, JSON.stringify(post));
  });

  await checkAsync('a session without a GitHub-verified identity is refused with an explanation, and GitHub is never called (#258)', async () => {
    const fake = fakeGitHubApp();
    const port = await listen(fake.server);
    // A dev token CAN claim tid "github" and the owner's login -- exactly the spoof this refuses.
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const spoof = auth.mintDevToken('github', String(TEST_USER.id), TEST_USER.login);
    const list = await apiRequest(addr.port, '/api/aca/repos', spoof);
    const post = await apiRequest(addr.port, '/api/aca/dispatch', spoof, {
      method: 'POST', body: { repo: 'acme/widgets', newIssue: { title: 'x' }, prompt: 'go' },
    });
    const dispatches = await apiRequest(addr.port, '/api/aca/dispatches', spoof);
    const status = await apiRequest(addr.port, '/api/aca/status', spoof);
    await svc.close();
    fake.server.close();
    for (const r of [list, post, dispatches]) {
      assert.strictEqual(r.status, 403, JSON.stringify(r));
      assert.match(r.body.error, /verified GitHub sign-in/);
    }
    assert.strictEqual(status.status, 200, 'the discovery route stays a cheap, always-200 answer');
    assert.strictEqual(fake.calls.total, 0, 'no GitHub call may be spent on a session that cannot be authorized');
  });

  check('only the GitHub verification yields a verified GitHub identity -- never a dev token, an owner entry or a tenant name (#258)', () => {
    const dev = new Authenticator({ mode: MODES.DEV, devSecret: 's'.repeat(16), owner: ['me', 'github:4242'] });
    const spoofed = dev._principal({ tid: 'github', oid: '4242', name: 'me' });
    assert.strictEqual(spoofed.github, null);
    assert.strictEqual(spoofed.isOwner, true, 'the spoofed session is even an owner -- which must still not matter');
  });

  await checkAsync('GitHub mode exposes the id and login GitHub itself returned, from the cache too (#258)', async () => {
    const auth = githubAuth({ users: [ALICE], owner: ['alice'] });
    const first = await auth.verify(`Bearer ${aliceToken}`);
    const cached = await auth.verify(`Bearer ${aliceToken}`);
    assert.deepStrictEqual(first.github, { id: '1001', login: 'alice' });
    assert.deepStrictEqual(cached.github, { id: '1001', login: 'alice' });
  });

  await checkAsync('a tracked dispatch is shown only to the GitHub account that made it, even inside one shared partition (#258)', async () => {
    const hub = await twoUserHub({ serviceOptions: { acaRateLimiter: new RateLimiter({ limit: 1000, windowMs: 60000 }), acaReadRateLimiter: new RateLimiter({ limit: 1000, windowMs: 60000 }) } });
    const made = await apiRequest(hub.port, '/api/aca/dispatch', aliceToken, {
      method: 'POST', body: { repo: 'acme/shared', issue: 1, prompt: 'go' },
    });
    const mine = await apiRequest(hub.port, '/api/aca/dispatches', aliceToken);
    const theirs = await apiRequest(hub.port, '/api/aca/dispatches', bobToken);
    delete hub.fake.state.repoAccess['acme/shared'].alice;
    const afterRevoke = await apiRequest(hub.port, '/api/aca/dispatches', aliceToken);
    await hub.close();
    assert.strictEqual(made.status, 200, JSON.stringify(made));
    assert.deepStrictEqual(mine.body.dispatches.map((d) => d.id), [made.body.trackerId]);
    assert.deepStrictEqual(theirs.body.dispatches, [], 'bob shares the partition but never made this dispatch');
    assert.deepStrictEqual(afterRevoke.body.dispatches, [], 'a run on a repository the account can no longer use is not reported');
  });

  await checkAsync('GitHubApp.dispatch and the list refuse to run for a caller with no verified identity, before any GitHub call (#258)', async () => {
    const fake = fakeGitHubApp();
    const port = await listen(fake.server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const bad = [undefined, null, {}, { id: '12', login: '' }, { id: 'abc', login: 'alice' }, { id: '0', login: 'alice' }, { id: '1', login: 'a/b' }, { id: '1', login: '../x' }];
    for (const actor of bad) {
      await assert.rejects(app.dispatch({ owner: 'acme', repo: 'widgets', installationId: 1, issue: 1, prompt: 'x', actor }), (e) => e.status === 403, JSON.stringify(actor));
      await assert.rejects(app.listReposWithDispatchStatus(actor), (e) => e.status === 403, JSON.stringify(actor));
    }
    fake.server.close();
    assert.strictEqual(fake.calls.total, 0);
  });

  // =========================================================================
  // Secret hygiene: the private key, a JWT, and an installation token must
  // never appear in a log line or any API response.
  // =========================================================================

  check('util.inspect on a GitHubApp instance never shows the private key or any cached token', () => {
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM });
    app._tokenCache.set(1, { token: 'ghs_should_never_be_printed', expiresAtMs: Date.now() + 1e9 });
    const inspected = require('util').inspect(app, { depth: 10 });
    assert.ok(!inspected.includes(FAKE_KEY_SECRET_SUBSTRING), 'util.inspect leaked the private key material');
    assert.ok(!inspected.includes('ghs_should_never_be_printed'), 'util.inspect leaked a cached installation token');
  });

  check('JSON.stringify on a GitHubApp instance never shows the private key or any cached token', () => {
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM });
    app._tokenCache.set(1, { token: 'ghs_should_never_be_printed', expiresAtMs: Date.now() + 1e9 });
    const json = JSON.stringify(app);
    assert.ok(!json.includes(FAKE_KEY_SECRET_SUBSTRING), 'JSON.stringify leaked the private key material');
    assert.ok(!json.includes('ghs_should_never_be_printed'), 'JSON.stringify leaked a cached installation token');
  });

  await checkAsync('an end-to-end dispatch leaks no secret into any captured log line or HTTP response body', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = githubAuth();

    const capturedLogs = [];
    const githubApp = new GitHubApp({
      appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}`,
      log: (line) => capturedLogs.push(line),
    });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp,
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = TEST_TOKEN;

    const r1 = await apiRequest(addr.port, '/api/aca/repos', token);
    const r2 = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', issue: 1, prompt: 'go do things', model: 'claude', reviewer: 'octocat' },
    });
    const r3 = await apiRequest(addr.port, '/api/aca/dispatches', token);

    await svc.close();
    server.close();

    const haystack = [
      ...capturedLogs,
      r1.raw, r2.raw, r3.raw,
      JSON.stringify(githubApp), require('util').inspect(githubApp, { depth: 10 }),
    ].join('\n');

    assert.ok(!haystack.includes(FAKE_KEY_SECRET_SUBSTRING),
      'the fake private key appeared in a log line or an API response');
    assert.ok(!haystack.includes('ghs_fake_'),
      'a live installation token appeared in a log line or an API response');
  });

  // =========================================================================
  // #257: known-value choices. What the New ACA job dialog offers comes from
  // the TARGET repository, is authorized per request like everything else, and
  // is checked again at dispatch so a posted value the catalog does not hold
  // never causes a side effect.
  // =========================================================================

  const choices = require('../src/service/aca-choices');
  const { checkSpawnChoices } = require('../src/service/spawn-choices');
  const choiceGet = (hub, p, token = aliceToken) => apiRequest(hub.port, p, token);
  const choiceDispatch = (hub, body, token = aliceToken) => apiRequest(hub.port, '/api/aca/dispatch', token, { method: 'POST', body });
  const repoReads = (fake) => Object.keys(fake.calls.byPath)
    .filter((k) => /\/branches|\/search\/|\/issues\/\d|contents\/\.squad|contents\/\.github/.test(k));
  const ids = (list) => list.map((c) => c.id);
  const numbered = (n, make) => Array.from({ length: n }, (_, i) => make(i + 1));

  check('model choices come from the repository configuration: default first, overrides after, bad slugs dropped, de-duplicated (#257)', () => {
    const out = choices.modelsFromConfig({
      defaultModel: 'claude-x',
      agentModelOverrides: { scribe: 'small-1', lead: 'claude-x', bad: 'has space', worse: 42, 'also bad': '../etc' },
      modelPolicy: { executorModel: 'exec-1', advisorModel: 'small-1', scribeModel: '' },
    });
    assert.deepStrictEqual(ids(out.choices), ['claude-x', 'small-1', 'exec-1']);
    assert.strictEqual(out.default, 'claude-x');
    assert.ok(!out.choices.some((c) => /\s|\.\./.test(c.id)), 'a value that is not a model slug must never become a choice');
    assert.ok(choices.modelsFromConfig(null).malformed, 'a config that is not an object is malformed, not empty');
    assert.ok(choices.modelsFromConfig({ agentModelOverrides: 'x' }).malformed);
    assert.deepStrictEqual(choices.modelsFromConfig({ defaultModel: ['x'] }).choices, []);
  });

  check('model choices are capped, never silently trimmed to look complete (#257)', () => {
    const overrides = {};
    for (let i = 0; i < 400; i += 1) overrides[`a${i}`] = `model-${i}`;
    const out = choices.modelsFromConfig({ defaultModel: 'base', agentModelOverrides: overrides });
    assert.strictEqual(out.choices.length, choices.MAX_CHOICES);
    assert.strictEqual(out.choices[0].id, 'base');
    assert.strictEqual(out.truncated, true, 'the list says it was cut');
  });

  check('modelState: the four honest states, and none of them invents a model (#257)', () => {
    const wf = (declaredInputs, modelOptions) => ({ declaredInputs, modelOptions, config: { state: 'missing' } });
    assert.strictEqual(choices.modelState(wf(['issue', 'prompt'], null)).state, 'unsupported');
    const missing = choices.modelState(wf(['issue', 'model'], null));
    assert.strictEqual(missing.state, 'default-only');
    assert.deepStrictEqual(missing.choices, []);
    const viaConfig = choices.modelState({ declaredInputs: ['model'], modelOptions: null, config: { state: 'ok', value: { defaultModel: 'm1' } } });
    assert.deepStrictEqual([viaConfig.state, viaConfig.source, ids(viaConfig.choices)], ['ok', 'repository-config', ['m1']]);
    const viaWorkflow = choices.modelState({ declaredInputs: ['model'], modelOptions: ['w1', 'w2'], config: { state: 'ok', value: { defaultModel: 'm1' } } });
    assert.deepStrictEqual([viaWorkflow.source, ids(viaWorkflow.choices)], ['workflow', ['w1', 'w2']], 'a workflow enum is the stricter, more authoritative list');
    const broken = choices.modelState({ declaredInputs: ['model'], modelOptions: null, config: { state: 'error', status: 422, reason: 'config is not JSON' } });
    assert.deepStrictEqual([broken.state, broken.status, broken.reason], ['unavailable', 422, 'config is not JSON']);
    const external = choices.modelState({ declaredInputs: ['model'], modelOptions: null, config: { state: 'ok', value: { defaultModel: 'm1', teamRoot: '/srv/team' } } });
    assert.deepStrictEqual([external.state, ids(external.choices)], ['ok', ['m1']], 'only what the repository itself names is listed');
    assert.match(external.reason, /outside this repository/, 'and it says the rest is not known');
    const externalEmpty = choices.modelState({ declaredInputs: ['model'], modelOptions: null, config: { state: 'ok', value: { stateLocation: 'elsewhere' } } });
    assert.strictEqual(externalEmpty.state, 'default-only');
  });

  check('reviewer choices are the ACTIVE registered members, not GitHub logins and not retired members (#257)', () => {
    const out = choices.reviewersFromRegistry({ agents: {
      alice: { status: 'active', role: 'Lead' }, bob: { status: 'retired' }, 'bad id!': { status: 'active' }, carol: { status: 'ACTIVE' }, dave: 'active', erin: { status: 'active' },
    } });
    assert.deepStrictEqual(ids(out.choices), ['alice', 'erin']);
    assert.ok(choices.reviewersFromRegistry({ agents: [] }).malformed);
    assert.ok(choices.reviewersFromRegistry('nope').malformed);
  });

  check('parseWorkflowChoiceInputs reads only a plain block-style choice enum for the model input (#257)', () => {
    const wf = (body) => wfYamlLines(['    inputs:', '      model:', ...body]);
    assert.deepStrictEqual(choices.parseWorkflowChoiceInputs(wf(['        type: choice', '        options:', '          - a-1', '          - "b-2"', '          - \'c-3\''])), { model: ['a-1', 'b-2', 'c-3'] });
    assert.deepStrictEqual(choices.parseWorkflowChoiceInputs(wf(['        type: string'])), { model: null });
    assert.deepStrictEqual(choices.parseWorkflowChoiceInputs(wf(['        type: choice', '        options: [a, b]'])), { model: null }, 'a flow list is not guessed at');
    assert.deepStrictEqual(choices.parseWorkflowChoiceInputs(wfYamlLines(['    inputs:', '      prompt:', '        type: string'])), { model: null });
    assert.deepStrictEqual(choices.parseWorkflowChoiceInputs(''), { model: null });
  });

  check('search text and page numbers are bounded before they reach GitHub (#257)', () => {
    assert.deepStrictEqual(choices.parseSearchText(null), { ok: true, value: '' });
    assert.strictEqual(choices.parseSearchText('  hello  ').value, 'hello');
    assert.strictEqual(choices.parseSearchText('a\u0000b').ok, false);
    assert.strictEqual(choices.parseSearchText('x'.repeat(101)).ok, false);
    assert.deepStrictEqual(choices.parsePage(null), { ok: true, value: 1 });
    for (const bad of ['0', '-1', 'abc', '1.5', '51', '99999']) assert.strictEqual(choices.parsePage(bad).ok, false, bad);
    assert.strictEqual(choices.parsePage('50').value, 50);
  });

  check('a New session request may only name what the target device offered, and unknown capabilities are not checked (#257)', () => {
    const device = { agents: ['squad', 'plain'], models: ['m-a', 'm-b'], modes: ['https://agentclientprotocol.com/protocol/session-modes#agent', 'plan'] };
    assert.strictEqual(checkSpawnChoices(device, { agent: 'squad', model: 'm-a', mode: 'agent' }), null);
    assert.strictEqual(checkSpawnChoices(device, { prompt: 'x' }), null);
    assert.strictEqual(checkSpawnChoices(device, { mode: 'default', agent: '', model: null }), null);
    assert.strictEqual(checkSpawnChoices(device, { mode: 'PLAN' }), null);
    for (const [body, field, status] of [
      [{ agent: 'other' }, 'agent', 422], [{ model: 'm-z' }, 'model', 422], [{ mode: 'autopilot' }, 'mode', 422],
      [{ mode: 'yolo' }, 'mode', 422], [{ model: 5 }, 'model', 400], [{ agent: 'x'.repeat(300) }, 'agent', 400],
    ]) {
      const r = checkSpawnChoices(device, body);
      assert.ok(r, JSON.stringify(body));
      assert.deepStrictEqual([r.status, r.body.field, r.body.code], [status, field, 'choice-unsupported'], JSON.stringify(body));
    }
    assert.strictEqual(checkSpawnChoices({ agents: null, models: null, modes: null }, { agent: 'anything', model: 'anything' }), null);
    assert.strictEqual(checkSpawnChoices({ agents: [], models: [] }, { agent: 'anything' }), null);
    assert.strictEqual(checkSpawnChoices({ modes: null }, { mode: 'yolo' }).body.field, 'mode', 'a mode the protocol itself does not define is refused even when the device listed none');
  });

  await checkAsync('GET /api/aca/choices answers the repository-configured model and registered reviewer choices (#257)', async () => {
    const hub = await twoUserHub();
    const r = await choiceGet(hub, '/api/aca/choices?repo=acme/alpha');
    await hub.close();
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.body.repo, 'acme/alpha');
    assert.strictEqual(r.body.defaultBranch, 'main');
    assert.deepStrictEqual([r.body.model.state, r.body.model.source, ids(r.body.model.choices)], ['ok', 'repository-config', ['claude', 'a-model']]);
    assert.deepStrictEqual(ids(r.body.reviewer.choices), ['someone', 'octocat', 'alice'], 'the retired member is not offered');
    assert.strictEqual(r.body.reviewer.state, 'ok');
  });

  await checkAsync('the three choice routes are authorized per user: bob is refused on alice\'s repository before ANY repository data is read (#257, #258)', async () => {
    const hub = await twoUserHub();
    const results = [];
    for (const p of ['/api/aca/choices?repo=acme/alpha', '/api/aca/branches?repo=acme/alpha&q=rel', '/api/aca/issues?repo=acme/alpha&q=fix', '/api/aca/issues?repo=acme/alpha&q=12']) {
      results.push(await choiceGet(hub, p, bobToken));
    }
    const reads = repoReads(hub.fake);
    const unknown = await choiceGet(hub, '/api/aca/branches?repo=acme/nowhere', aliceToken);
    await hub.close();
    for (const r of results) {
      assert.strictEqual(r.status, 403, JSON.stringify(r));
      assert.strictEqual(r.body.error, require('../src/service/github-app').repoNotAvailableMessage('acme/alpha'));
      assert.ok(!r.body.model && !r.body.branches && !r.body.issues, 'a refusal carries no partial data');
    }
    assert.deepStrictEqual(reads, [], `repository data was read for an unauthorized caller: ${reads}`);
    assert.strictEqual(unknown.status, 403, 'a repository the App is not installed on looks exactly like one the caller may not use');
    assert.strictEqual(unknown.body.error, require('../src/service/github-app').repoNotAvailableMessage('acme/nowhere'));
  });

  await checkAsync('the choice routes re-ask GitHub on every call: access revoked between two requests ends the second (#257, #258)', async () => {
    const hub = await twoUserHub();
    const before = await choiceGet(hub, '/api/aca/branches?repo=acme/alpha');
    hub.fake.state.repoAccess['acme/alpha'] = { alice: 'none' };
    const after = await choiceGet(hub, '/api/aca/branches?repo=acme/alpha');
    const afterChoices = await choiceGet(hub, '/api/aca/choices?repo=acme/alpha');
    await hub.close();
    assert.strictEqual(before.status, 200, JSON.stringify(before));
    assert.strictEqual(after.status, 403, JSON.stringify(after));
    assert.strictEqual(afterChoices.status, 403);
    assert.ok(!after.raw.includes('release'), 'no branch name leaks after revocation');
  });

  await checkAsync('a failure verifying access on a choice route answers 502 with no data, never a guess (#257, #258)', async () => {
    const hub = await twoUserHub({ repoAccess: { 'acme/alpha': { alice: { status: 500 } } } });
    const rs = [];
    for (const p of ['/api/aca/choices?repo=acme/alpha', '/api/aca/branches?repo=acme/alpha', '/api/aca/issues?repo=acme/alpha']) rs.push(await choiceGet(hub, p));
    const reads = repoReads(hub.fake);
    await hub.close();
    rs.forEach((r) => { assert.strictEqual(r.status, 502, JSON.stringify(r)); assert.match(r.body.error, /could not verify your access/); });
    assert.deepStrictEqual(reads, []);
  });

  await checkAsync('a session without a verified GitHub identity cannot use any choice route, and GitHub is never called (#257, #258)', async () => {
    const fake = fakeGitHubApp();
    const port = await listen(fake.server);
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const spoof = auth.mintDevToken('github', String(TEST_USER.id), TEST_USER.login);
    const rs = [];
    for (const p of ['choices', 'branches', 'issues']) rs.push(await apiRequest(addr.port, `/api/aca/${p}?repo=acme/widgets`, spoof));
    await svc.close();
    fake.server.close();
    rs.forEach((r) => { assert.strictEqual(r.status, 403, JSON.stringify(r)); assert.match(r.body.error, /verified GitHub sign-in/); });
    assert.strictEqual(fake.calls.total, 0);
  });

  await checkAsync('a hub with no GitHub App answers 501 on the choice routes, and malformed queries are 400 before any upstream call (#257)', async () => {
    const svc = new HubService({ auth: githubAuth(), serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false });
    const addr = await svc.listen(0, '127.0.0.1');
    const off = await apiRequest(addr.port, '/api/aca/branches?repo=acme/widgets', TEST_TOKEN);
    await svc.close();
    assert.strictEqual(off.status, 501, JSON.stringify(off));

    const hub = await twoUserHub();
    const bad = [];
    for (const p of ['repo=nope', 'repo=a/b/c', 'repo=acme/alpha&q=%00', `repo=acme/alpha&q=${'x'.repeat(101)}`, 'repo=acme/alpha&page=0', 'repo=acme/alpha&page=abc', 'repo=acme/alpha&page=999']) {
      bad.push([p, await choiceGet(hub, `/api/aca/branches?${p}`), await choiceGet(hub, `/api/aca/issues?${p}`)]);
    }
    const total = hub.fake.calls.total;
    await hub.close();
    for (const [p, b, i] of bad) {
      assert.strictEqual(b.status, 400, `${p}: ${JSON.stringify(b)}`);
      assert.strictEqual(i.status, 400, `${p}: ${JSON.stringify(i)}`);
    }
    assert.strictEqual(total, 0, 'a request that is not well-formed spends nothing upstream');
  });

  await checkAsync('the choice routes draw on the SAME read budget as the repository list, so search cannot be used to exhaust GitHub (#257)', async () => {
    const hub = await twoUserHub({ serviceOptions: { acaReadRateLimiter: new RateLimiter({ limit: 2, windowMs: 60000 }) } });
    const a = await choiceGet(hub, '/api/aca/repos');
    const b = await choiceGet(hub, '/api/aca/branches?repo=acme/alpha');
    const c = await choiceGet(hub, '/api/aca/issues?repo=acme/alpha&q=x');
    const d = await choiceGet(hub, '/api/aca/choices?repo=acme/alpha');
    await hub.close();
    assert.deepStrictEqual([a.status, b.status, c.status, d.status], [200, 200, 429, 429]);
    assert.ok(c.body.retryAfterMs > 0);
  });

  await checkAsync('discovery that cannot answer says so: missing is default-only, malformed or failing is unavailable with a reason, and none of it is a guess (#257)', async () => {
    const cases = [
      ['config file absent', { '.squad/config.json': null, '.squad/casting/registry.json': null }, 'default-only', 'default-only'],
      ['config malformed', { '.squad/config.json': { raw: '{ not json' }, '.squad/casting/registry.json': { raw: '[1,' } }, 'unavailable', 'unavailable'],
      ['GitHub failing', { '.squad/config.json': { status: 500 }, '.squad/casting/registry.json': { status: 403 } }, 'unavailable', 'unavailable'],
      ['team state kept elsewhere', { '.squad/config.json': { stateLocation: 'external' } }, 'default-only', 'default-only'],
      ['registry with no active member', { '.squad/casting/registry.json': { agents: { gone: { status: 'retired' } } } }, 'ok', 'default-only'],
    ];
    for (const [label, files, modelState, reviewerState] of cases) {
      const hub = await twoUserHub({ fakeOptions: { files } });
      const r = await choiceGet(hub, '/api/aca/choices?repo=acme/alpha');
      await hub.close();
      assert.strictEqual(r.status, 200, `${label}: ${JSON.stringify(r)}`);
      assert.strictEqual(r.body.model.state, modelState, `${label}: ${JSON.stringify(r.body.model)}`);
      assert.strictEqual(r.body.reviewer.state, reviewerState, `${label}: ${JSON.stringify(r.body.reviewer)}`);
      if (modelState === 'unavailable') assert.ok(r.body.model.reason, `${label}: an unavailable state explains itself`);
      if (modelState !== 'ok') assert.deepStrictEqual(r.body.model.choices, [], `${label}: no invented models`);
      if (reviewerState !== 'ok') assert.deepStrictEqual(r.body.reviewer.choices, [], `${label}: no invented reviewers`);
    }
  });

  await checkAsync('a repository whose workflow lacks the model or reviewer input reports it unsupported, and a workflow choice enum is the model source (#257)', async () => {
    const legacy = await twoUserHub({ fakeOptions: { declaredInputs: LEGACY_DECLARED_INPUTS } });
    const a = await choiceGet(legacy, '/api/aca/choices?repo=acme/alpha');
    await legacy.close();
    assert.strictEqual(a.body.model.state, 'unsupported');
    assert.strictEqual(a.body.reviewer.state, 'unsupported');

    const yaml = wfYamlLines([
      '    inputs:', '      issue:', '        type: string', '      prompt:', '        type: string',
      '      model:', '        type: choice', '        options:', '          - wf-a', '          - wf-b',
    ]);
    const hub = await twoUserHub({ fakeOptions: { workflowYaml: yaml, declaredInputs: ['issue', 'prompt', 'model'] } });
    const b = await choiceGet(hub, '/api/aca/choices?repo=acme/alpha');
    const ok = await choiceDispatch(hub, { repo: 'acme/alpha', issue: 1, prompt: 'go', model: 'wf-b' });
    const notInEnum = await choiceDispatch(hub, { repo: 'acme/alpha', issue: 1, prompt: 'go', model: 'claude' });
    const effects = sideEffects(hub.fake, hub.svc);
    await hub.close();
    assert.deepStrictEqual([b.body.model.source, ids(b.body.model.choices)], ['workflow', ['wf-a', 'wf-b']]);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok));
    assert.strictEqual(notInEnum.status, 422, 'the repository-configured model is not in this workflow\'s enum, so it is refused');
    assert.strictEqual(effects.dispatches, 1);
  });

  await checkAsync('branch search finds a branch BEYOND the first page of GitHub results, and says when it stopped early instead of claiming it is exhaustive (#257)', async () => {
    const branches = ['main', ...numbered(449, (n) => `branch-${String(n).padStart(3, '0')}`)];
    const hub = await twoUserHub({ fakeOptions: { branches } });
    const first = await choiceGet(hub, '/api/aca/branches?repo=acme/alpha&q=branch-4');
    const next = await choiceGet(hub, `/api/aca/branches?repo=acme/alpha&q=branch-4&page=${first.body.nextPage}`);
    const exact = await choiceGet(hub, '/api/aca/branches?repo=acme/alpha&q=branch-449');
    const absent = await choiceGet(hub, '/api/aca/branches?repo=acme/alpha&q=no-such-branch');
    const noQuery = await choiceGet(hub, '/api/aca/branches?repo=acme/alpha');
    await hub.close();
    assert.strictEqual(first.status, 200, JSON.stringify(first));
    assert.deepStrictEqual(first.body.branches, [], 'the first 300 branches hold no match');
    assert.ok(first.body.nextPage > 1, 'it must report that more could be scanned');
    assert.strictEqual(next.body.branches.length, 50, JSON.stringify(next.body));
    assert.ok(next.body.branches.every((b) => b.name.startsWith('branch-4')));
    assert.strictEqual(next.body.nextPage, null, 'the scan reached the end');
    assert.deepStrictEqual(ids(exact.body.branches.map((b) => ({ id: b.name }))), ['branch-449'], 'an exact name is verified directly, even deep in the list');
    assert.deepStrictEqual(absent.body.branches, []);
    assert.strictEqual(noQuery.body.branches.length, 100);
    assert.ok(noQuery.body.nextPage, 'an unfiltered list is a page, with a way to ask for more');
  });

  await checkAsync('issue search offers real OPEN issues only: pull requests and closed issues are excluded even when GitHub returns them, and results page past the first (#257)', async () => {
    const issues = [
      ...numbered(75, (n) => ({ number: n, title: `Fix login bug ${n}`, state: 'open' })),
      { number: 200, title: 'Fix login PR', state: 'open', pull_request: {} },
      { number: 201, title: 'Fix login closed', state: 'closed' },
      { number: 5000, title: 'Unrelated', state: 'open' },
    ];
    const hub = await twoUserHub({ fakeOptions: { issues } });
    const p1 = await choiceGet(hub, '/api/aca/issues?repo=acme/alpha&q=login');
    const p3 = await choiceGet(hub, '/api/aca/issues?repo=acme/alpha&q=login&page=3');
    hub.fake.state.leakPrs = true;
    const leaky = await choiceGet(hub, '/api/aca/issues?repo=acme/alpha&q=login&page=3');
    hub.fake.state.leakPrs = false;
    const byNumber = await choiceGet(hub, '/api/aca/issues?repo=acme/alpha&q=5000');
    const prNumber = await choiceGet(hub, '/api/aca/issues?repo=acme/alpha&q=200');
    const closedNumber = await choiceGet(hub, '/api/aca/issues?repo=acme/alpha&q=%23201');
    await hub.close();
    assert.strictEqual(p1.body.issues.length, 30, JSON.stringify(p1.body));
    assert.strictEqual(p1.body.nextPage, 2);
    assert.strictEqual(p3.body.issues.length, 15);
    assert.strictEqual(p3.body.nextPage, null);
    const nums = (r) => r.body.issues.map((i) => i.number);
    for (const r of [p1, p3, leaky]) assert.ok(!nums(r).some((n) => n === 200 || n === 201), `a pull request or closed issue was offered: ${nums(r)}`);
    assert.deepStrictEqual(nums(byNumber), [5000], 'a number is looked up exactly, not only searched for in titles');
    assert.deepStrictEqual(nums(prNumber), [], 'a pull request number is not an issue');
    assert.deepStrictEqual(nums(closedNumber), []);
  });

  await checkAsync('issue search text cannot add search qualifiers: it is quoted and repository-scoped by the server (#257)', async () => {
    const hub = await twoUserHub({ fakeOptions: { issues: [{ number: 1, title: 'x', state: 'open' }] } });
    await choiceGet(hub, `/api/aca/issues?repo=acme/alpha&q=${encodeURIComponent('x" repo:acme/beta is:pr OR "y')}`);
    const searches = hub.fake.state.searches.slice();
    await hub.close();
    assert.deepStrictEqual(searches, ['"x repo acme beta is pr OR y" in:title repo:acme/alpha is:issue is:open']);
  });

  await checkAsync('branch and issue listing that GitHub cannot answer is an error, never an empty list that looks like "none" (#257)', async () => {
    const hub = await twoUserHub({ fakeOptions: { branches: 'error', issues: 'error' } });
    const b = await choiceGet(hub, '/api/aca/branches?repo=acme/alpha&q=x');
    const i = await choiceGet(hub, '/api/aca/issues?repo=acme/alpha&q=x');
    await hub.close();
    for (const r of [b, i]) {
      assert.ok(r.status >= 500 && r.status < 600, JSON.stringify(r));
      assert.ok(r.body.error);
      assert.ok(!r.body.branches && !r.body.issues);
    }
  });

  await checkAsync('POST /api/aca/dispatch accepts values the catalog holds and refuses every other explicit value with a field-named 422 and ZERO side effects (#257)', async () => {
    const issues = [
      { number: 7, title: 'Real open issue', state: 'open' }, { number: 8, title: 'A pull request', state: 'open', pull_request: {} },
      { number: 9, title: 'Closed', state: 'closed' },
    ];
    const hub = await twoUserHub({ fakeOptions: { issues, branches: ['main', 'release'] }, serviceOptions: { acaRateLimiter: new RateLimiter({ limit: 1000, windowMs: 60000 }) } });
    const good = await choiceDispatch(hub, { repo: 'acme/alpha', issue: 7, prompt: 'go', model: 'a-model', reviewer: 'octocat', baseBranch: 'release' });
    const goodEffects = sideEffects(hub.fake, hub.svc);
    const goodInputs = hub.fake.state.dispatches[0] && hub.fake.state.dispatches[0].inputs;
    hub.fake.state.dispatches.length = 0;
    const refusals = [
      ['model', { model: 'gpt-nonexistent' }], ['reviewer', { reviewer: 'retired' }], ['reviewer', { reviewer: 'someone-else' }],
      ['reviewer', { reviewer: 'me' }], ['baseBranch', { baseBranch: 'no-such-branch' }], ['baseBranch', { baseBranch: 'Release' }],
      ['issue', { issue: 8 }], ['issue', { issue: 9 }], ['issue', { issue: 123456 }],
    ];
    const out = [];
    for (const [field, extra] of refusals) {
      const before = sideEffects(hub.fake, hub.svc);
      const viaIssue = await choiceDispatch(hub, { repo: 'acme/alpha', issue: 7, prompt: 'go', ...extra });
      const viaNew = await choiceDispatch(hub, { repo: 'acme/alpha', prompt: 'go', ...(field === 'issue' ? extra : { newIssue: { title: 'brand new' }, ...extra }) });
      out.push({ field, extra, viaIssue, viaNew, before, after: sideEffects(hub.fake, hub.svc) });
    }
    await hub.close();
    assert.strictEqual(good.status, 200, JSON.stringify(good));
    assert.deepStrictEqual([goodInputs.model, goodInputs.reviewer, goodInputs.base_branch], ['a-model', 'octocat', 'release']);
    assert.strictEqual(goodEffects.dispatches, 1);
    for (const o of out) {
      for (const r of [o.viaIssue, o.viaNew]) {
        assert.strictEqual(r.status, 422, `${o.field} ${JSON.stringify(o.extra)}: ${JSON.stringify(r)}`);
        assert.strictEqual(r.body.field, o.field, JSON.stringify(r));
      }
      assert.deepStrictEqual(o.after, o.before, `${o.field} ${JSON.stringify(o.extra)}: a refused value caused a side effect`);
    }
  });

  await checkAsync('with a new issue requested, an unsupported model never creates the issue, and an unreadable catalog is 502, not a pass (#257)', async () => {
    const hub = await twoUserHub();
    const bad = await choiceDispatch(hub, { repo: 'acme/alpha', newIssue: { title: 'x' }, prompt: 'go', model: 'nope' });
    const afterBad = sideEffects(hub.fake, hub.svc);
    await hub.close();
    assert.strictEqual(bad.status, 422);
    assert.deepStrictEqual(afterBad, NO_SIDE_EFFECTS);

    for (const [label, fakeOptions, extra, status] of [
      ['config GitHub failure', { files: { '.squad/config.json': { status: 500 } } }, { model: 'claude' }, 502],
      ['config malformed', { files: { '.squad/config.json': { raw: '{ nope' } } }, { model: 'claude' }, 422],
      ['branch lookup failure', { branches: 'error' }, { baseBranch: 'release' }, 502],
      ['issue lookup failure', { issues: 'error' }, { issue: 3 }, 502],
      ['repository with no config', { files: { '.squad/config.json': null } }, { model: 'claude' }, 422],
    ]) {
      const h = await twoUserHub({ fakeOptions });
      const r = await choiceDispatch(h, { repo: 'acme/alpha', issue: 3, prompt: 'go', ...extra });
      const effects = sideEffects(h.fake, h.svc);
      await h.close();
      assert.strictEqual(r.status, status, `${label}: ${JSON.stringify(r)}`);
      assert.deepStrictEqual(effects, NO_SIDE_EFFECTS, label);
    }
  });

  await checkAsync('dispatch authorizes BEFORE it looks at the catalog: a caller without access learns nothing about branches, issues or models (#257, #258)', async () => {
    const hub = await twoUserHub();
    const r = await choiceDispatch(hub, { repo: 'acme/alpha', issue: 7, prompt: 'go', model: 'nope', baseBranch: 'nope' }, bobToken);
    const reads = repoReads(hub.fake);
    const effects = sideEffects(hub.fake, hub.svc);
    await hub.close();
    assert.strictEqual(r.status, 403, JSON.stringify(r));
    assert.ok(!r.body.field, 'the refusal does not say which value was wrong');
    assert.deepStrictEqual(reads, []);
    assert.deepStrictEqual(effects, NO_SIDE_EFFECTS);
  });

  await checkAsync('a dispatch that fails after the issue was created still reports it so the retry reuses it, with validated choices (#257)', async () => {
    const hub = await twoUserHub({ fakeOptions: { dispatchStatus: 500 } });
    const r = await choiceDispatch(hub, { repo: 'acme/alpha', newIssue: { title: 'keep me' }, prompt: 'go', model: 'claude', baseBranch: 'release' });
    const effects = sideEffects(hub.fake, hub.svc);
    await hub.close();
    assert.ok(r.status >= 400, JSON.stringify(r));
    assert.strictEqual(effects.issues, 1);
    assert.ok(acaCreatedIssueOf({ body: r.body }, { repo: 'acme/alpha', newIssue: { title: 'keep me' } }), `the created issue must be reported: ${JSON.stringify(r.body)}`);
  });

  await checkAsync('a New session request naming an agent, model or mode the device does not offer is refused before the device is asked (#257)', async () => {
    const hub = await twoUserHub();
    const me = await apiRequest(hub.port, '/api/me', aliceToken);
    const subject = me.body.subject;
    hub.svc.store.registerDevice(subject, {
      deviceId: 'laptop', name: 'laptop', platform: 'win32', agents: ['squad'], models: ['m-a'], modes: ['agent', 'plan'],
    });
    hub.svc._devices.set(subject, new Map([['laptop', { close() {} }]]));
    const sent = [];
    hub.svc.command = async (...args) => { sent.push(args); return { id: 'session-1' }; };
    const spawn = (body) => apiRequest(hub.port, '/api/devices/laptop/spawn', aliceToken, { method: 'POST', body });
    const ok = await spawn({ prompt: 'p', agent: 'squad', model: 'm-a', mode: 'plan' });
    const none = await spawn({ prompt: 'p' });
    const sentOk = sent.length;
    const bad = [await spawn({ prompt: 'p', model: 'm-z' }), await spawn({ prompt: 'p', agent: 'other' }), await spawn({ prompt: 'p', mode: 'autopilot' })];
    await hub.close();
    assert.strictEqual(ok.status, 200, JSON.stringify(ok));
    assert.strictEqual(none.status, 200, JSON.stringify(none));
    assert.strictEqual(sentOk, 2);
    assert.deepStrictEqual(bad.map((r) => [r.status, r.body.field, r.body.code]), [[422, 'model', 'choice-unsupported'], [422, 'agent', 'choice-unsupported'], [422, 'mode', 'choice-unsupported']]);
    assert.strictEqual(sent.length, sentOk, 'nothing reached the device for a refused value');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
