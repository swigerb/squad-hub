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

const { GitHubApp } = require('../src/service/github-app');
const { RateLimiter } = require('../src/service/rate-limiter');
const { DispatchTracker } = require('../src/service/dispatch-tracker');
const { sanitizeDispatchRequest, buildWorkflowInputs } = require('../src/aca-dispatch');
const { Authenticator, MODES } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');

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

/**
 * A stand-in for api.github.com covering exactly the endpoints a GitHub App
 * calls: `/app/installations`, `/app/installations/:id/access_tokens`,
 * `/installation/repositories`, repo contents/metadata, issues, and the
 * Actions dispatch/runs endpoints. Counts calls per path so caching claims
 * can be asserted rather than asserted-about.
 */
function fakeGitHubApp({ installations = [{ id: 1, login: 'acme' }], reposByInstallation = { 1: ['acme/widgets'] }, hasWorkflow = true, now = () => Date.now() } = {}) {
  const calls = { total: 0, byPath: {} };
  const seenAuthHeaders = [];
  const state = { tokenMints: 0, dispatches: [], createdIssues: [] };

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
        return json(200, installations.map((i) => ({ id: i.id, account: { login: i.login } })));
      }

      const tokenMatch = req.url.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (tokenMatch && req.method === 'POST') {
        state.tokenMints += 1;
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
        // a single installation.
        const all = Object.values(reposByInstallation).flat();
        return json(200, { repositories: all.map((full_name) => ({ full_name })) });
      }

      if (req.url.includes('/contents/.github/workflows/squad-dispatch.yml')) {
        if (hasWorkflow === 'error') return json(500, { message: 'internal error' });
        return hasWorkflow ? json(200, { sha: 'deadbeef' }) : json(404, { message: 'Not Found' });
      }

      const repoMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)$/);
      if (repoMatch && req.method === 'GET') {
        return json(200, { default_branch: 'main' });
      }

      const issuesMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/issues$/);
      if (issuesMatch && req.method === 'POST') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        state.createdIssues.push(parsed);
        const number = 100 + state.createdIssues.length;
        return json(201, { number, html_url: `https://github.com/${issuesMatch[1]}/${issuesMatch[2]}/issues/${number}` });
      }

      const dispatchMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/squad-dispatch\.yml\/dispatches$/);
      if (dispatchMatch && req.method === 'POST') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        state.dispatches.push({ owner: dispatchMatch[1], repo: dispatchMatch[2], ...parsed });
        res.writeHead(204);
        return res.end();
      }

      const runsMatch = req.url.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/squad-dispatch\.yml\/runs/);
      if (runsMatch && req.method === 'GET') {
        return json(200, {
          workflow_runs: [
            {
              id: 555, status: 'in_progress', conclusion: null,
              html_url: 'https://github.com/acme/widgets/actions/runs/555',
              created_at: new Date().toISOString(),
            },
          ],
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
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'not-installed/here', issue: 1, prompt: 'do it' },
    });
    await svc.close();
    server.close();
    assert.strictEqual(r.status, 403, JSON.stringify(r));
    assert.match(r.body.error, /not installed/);
  });

  // =========================================================================
  // The dispatch route, end to end against the fake
  // =========================================================================

  await checkAsync('a dispatch against an installed repo succeeds and returns {issue, runUrl}', async () => {
    const { server, state } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', issue: 42, prompt: 'do the thing', model: 'claude', publishPr: true },
    });
    await svc.close();
    server.close();
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.body.issue.number, 42);
    assert.strictEqual(r.body.runUrl, 'https://github.com/acme/widgets/actions/workflows/squad-dispatch.yml');
    assert.strictEqual(state.dispatches.length, 1);
    assert.strictEqual(state.dispatches[0].inputs.issue, '42');
    assert.strictEqual(state.dispatches[0].inputs.prompt, 'do the thing');
    assert.strictEqual(state.dispatches[0].inputs.model, 'claude');
    assert.strictEqual(state.dispatches[0].inputs.publish_pr, 'true');
  });

  await checkAsync('a newIssue request creates the issue first, then dispatches against its number', async () => {
    const { server, state } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
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

  await checkAsync('a repo with no squad-dispatch.yml refuses the dispatch', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, hasWorkflow: false });
    const port = await listen(server);
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
    const r = await apiRequest(addr.port, '/api/aca/dispatch', token, {
      method: 'POST', body: { repo: 'acme/widgets', issue: 1, prompt: 'go' },
    });
    await svc.close();
    server.close();
    assert.notStrictEqual(r.status, 200);
    assert.match(r.body.error, /squad-dispatch\.yml/);
  });

  await checkAsync('GET /api/aca/repos reports hasDispatchWorkflow honestly', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, hasWorkflow: true });
    const port = await listen(server);
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
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
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
    const r = await apiRequest(addr.port, '/api/aca/repos', token);
    await svc.close();
    server.close();
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.body.repos[0].hasDispatchWorkflow, false);
  });

  await checkAsync('a non-404 error checking for squad-dispatch.yml surfaces as an error, not a silent false', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] }, hasWorkflow: 'error' });
    const port = await listen(server);
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
    const r = await apiRequest(addr.port, '/api/aca/repos', token);
    await svc.close();
    server.close();
    assert.ok(r.status >= 500, `expected a clear error status, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await checkAsync('a device token can never reach /api/aca/dispatch', async () => {
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
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

  check('reviewer must be a valid GitHub username', () => {
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
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });
    let now = 0;
    const svc = new HubService({
      auth, serveWeb: false, persistAccess: false, persistStore: false, persistDeviceTokens: false, persistPrefs: false,
      githubApp: new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` }),
      acaRateLimiter: new RateLimiter({ limit: 2, windowMs: 60000, now: () => now }),
    });
    const addr = await svc.listen(0, '127.0.0.1');
    const token = auth.mintDevToken('local', 'me', 'me');
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

  // =========================================================================
  // DispatchTracker: per-user partitioning, and status resolution
  // =========================================================================

  await checkAsync('each user only ever sees their own recorded dispatches', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const tracker = new DispatchTracker();
    tracker.record('alice', { owner: 'acme', repo: 'widgets', installationId: 1, workflowFile: 'squad-dispatch.yml' });
    tracker.record('bob', { owner: 'acme', repo: 'widgets', installationId: 1, workflowFile: 'squad-dispatch.yml' });
    const aliceList = await tracker.listWithStatus('alice', app);
    const bobList = await tracker.listWithStatus('bob', app);
    server.close();
    assert.strictEqual(aliceList.length, 1);
    assert.strictEqual(bobList.length, 1);
  });

  await checkAsync('resolveRunStatus matches the run created at-or-after the dispatch timestamp', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, dispatchedAt: Date.now() - 60000,
    });
    server.close();
    assert.strictEqual(status.state, 'in_progress');
    assert.strictEqual(status.runId, 555);
  });

  await checkAsync('a dispatch with no run yet reports pending rather than throwing', async () => {
    const { server } = fakeGitHubApp({ reposByInstallation: { 1: ['acme/widgets'] } });
    const port = await listen(server);
    const app = new GitHubApp({ appId: '1', privateKey: FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${port}` });
    // A dispatch timestamped far in the FUTURE relative to the one run the
    // fake always returns -- so nothing matches "at or after".
    const status = await app.resolveRunStatus({
      owner: 'acme', repo: 'widgets', installationId: 1, dispatchedAt: Date.now() + 10 * 60 * 1000,
    });
    server.close();
    assert.strictEqual(status.state, 'pending');
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
    const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex'), owner: ['me'] });

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
    const token = auth.mintDevToken('local', 'me', 'me');

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
