'use strict';
/**
 * The hub's own GitHub App identity -- issue #177.
 *
 * Previously (see docs/security.md, "Starting a cloud job from the hub"), the
 * hub held no GitHub credential at all: it emitted a prefilled-issue URL, and
 * the user's own GitHub session created the issue and triggered the workflow.
 * That is still exactly how an unconfigured repository works, and nothing
 * about it changes here -- see github-link.js, untouched.
 *
 * This is the OTHER path, for repositories the operator has installed the
 * app on: the hub calls `workflow_dispatch` on `squad-dispatch.yml` directly,
 * authenticated as a GitHub App, so a signed-in hub user can start a job
 * without needing their own collaborator access on the target repository.
 * The trust boundary moves from "is this person a collaborator on THIS repo"
 * to "did whoever installed the app choose to install it on THIS repo" --
 * documented plainly in docs/security.md because it is a real, new rule, not
 * an implementation detail.
 *
 * Three things this module is careful about, because a GitHub App credential
 * is strictly more powerful than the token a browser sign-in produces:
 *
 *   THE PRIVATE KEY NEVER LEAVES THIS PROCESS. It is parsed into a `KeyObject`
 *   in the constructor and the original PEM string is not retained anywhere
 *   reachable afterward. No endpoint returns it, no error message quotes it,
 *   and `util.inspect`/`JSON.stringify` on an instance of this class show
 *   neither it nor a live installation token (see the custom inspect/toJSON
 *   below) -- the whole point of `test/github-app-unit.js`'s secret-leak test.
 *
 *   EVERY DISPATCH IS ALLOW-LISTED AGAINST REAL INSTALLATIONS. `findInstallation`
 *   is the only path from a caller-supplied `owner/repo` to a token, and it
 *   answers strictly from what `GET /app/installations` and
 *   `GET /installation/repositories` report -- never from the request.
 *
 *   NOT CONFIGURED FAILS CLOSED, LOUDLY. `SQUAD_HUB_GH_APP_ID` /
 *   `SQUAD_HUB_GH_APP_PRIVATE_KEY` absent, or a private key that does not
 *   parse, both set `enabled = false` with a short human reason -- the three
 *   routes in hub-service.js turn that into 501 and nothing else about them
 *   runs. This is expected to be the normal state until the real app exists
 *   (see the issue).
 *
 * House style: raw HTTPS with no library (see `src/service/github-oauth.js`),
 * and an injectable clock + API base so `test/github-app-unit.js` can run
 * this against a real local HTTP server standing in for api.github.com,
 * rather than mocking Node's `https` module internals.
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const util = require('util');
const { URL } = require('url');
const { buildWorkflowInputs, requestedInputNames } = require('../aca-dispatch');

/** The workflow this whole feature dispatches. Named once, so a rename does
 * not have to be found by grepping literal strings through this file. */
const WORKFLOW_FILE = 'squad-dispatch.yml';

/** GitHub's App JWT requires `exp - iat <= 600` (10 minutes). Backdating
 * `iat` by a minute absorbs ordinary clock drift between this process and
 * GitHub's servers -- GitHub's own docs recommend this. The lifetime is kept
 * well under the cap so a clock running a little fast never produces a JWT
 * GitHub considers to already be in the future. */
const JWT_BACKDATE_SEC = 60;
const JWT_TTL_SEC = 540; // 9 minutes from the backdated `iat`.

/** An installation token is refreshed this long before its real expiry,
 * rather than at the instant it lapses -- a request that started a few
 * milliseconds before expiry must not fail with the previous token. */
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

/** `resolveRunStatus` floors the recorded dispatch timestamp to whole
 * seconds (GitHub's own `created_at` has no sub-second precision, so
 * comparing millisecond-precise would reject a run GitHub reports as created
 * in the very same second as the dispatch) and then subtracts this much
 * more, to absorb ordinary clock drift between this process and GitHub's --
 * a run GitHub timestamps a couple of seconds before this process believes
 * it made the call must still match. */
const RUN_MATCH_TOLERANCE_MS = 5000;

/**
 * Upstream GitHub status -> the status this hub reports for it. A 401 or 403
 * from GitHub means the APP'S OWN credential was rejected, not that the
 * signed-in hub user failed to authenticate -- passed straight through it
 * would look exactly like the caller's own sign-in failing, which it is not.
 * A 3xx is GitHub asking this server to follow a redirect it never should
 * blindly follow with an Authorization header attached. Both become 502:
 * clearly this hub's problem talking to GitHub, never the caller's.
 */
function upstreamStatus(status) {
  if (status === 401 || status === 403) return 502;
  if (status >= 300 && status < 400) return 502;
  return status || 502;
}

/**
 * The input names declared under a `squad-dispatch.yml`'s own
 * `on.workflow_dispatch.inputs:` block, read with a narrow, purpose-built
 * scan rather than a general YAML parser (house style: no dependency where a
 * few lines of plain text handling does the job -- see the JWT above).
 * GitHub Actions workflow YAML is well-defined enough that this is safe:
 * this only ever needs to tell `name:` keys apart from everything else, by
 * indentation, inside one specific block.
 *
 * Returns the array of declared names, or `null` if the file does not
 * declare `workflow_dispatch` at all (a workflow that triggers only on
 * `push`, say -- a caller cannot dispatch it either way, but that is a
 * different refusal than "every input is undeclared").
 */
function parseDeclaredWorkflowInputs(yamlText) {
  const lines = String(yamlText).replace(/\r\n/g, '\n').split('\n');
  const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

  let wfIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === 'workflow_dispatch:') { wfIdx = i; break; }
  }
  if (wfIdx === -1) return null;
  const wfIndent = indentOf(lines[wfIdx]);

  let inputsIdx = -1;
  let inputsIndent = -1;
  for (let i = wfIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (indentOf(line) <= wfIndent) break; // left the workflow_dispatch block
    if (line.trim() === 'inputs:') { inputsIdx = i; inputsIndent = indentOf(line); break; }
  }
  if (inputsIdx === -1) return []; // workflow_dispatch declared, but no inputs block at all

  const names = [];
  let childIndent = -1;
  for (let i = inputsIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ind = indentOf(line);
    if (ind <= inputsIndent) break; // left the inputs block
    if (childIndent === -1) childIndent = ind;
    if (ind !== childIndent) continue; // a nested key (description:, required:, ...), not an input name
    const m = line.trim().match(/^([A-Za-z0-9_-]+):/);
    if (m) names.push(m[1]);
  }
  return names;
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/**
 * A single HTTPS (or HTTP, for a test double) JSON request. Picks the
 * transport from the URL's own protocol, exactly as `src/notify/teams.js`'s
 * `postJson` does, so a test can point `apiBase` at `http://127.0.0.1:<port>`
 * without this file needing to know it is under test.
 */
function httpRequest(urlString, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch { return reject(new Error('not a valid GitHub API URL')); }
    const lib = url.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const reqHeaders = { ...headers };
    if (data) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = data.length;
    }
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: reqHeaders,
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = null;
        if (raw) { try { json = JSON.parse(raw); } catch { /* not JSON: e.g. a 204, or an HTML error page */ } }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out talking to GitHub')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class GitHubApp {
  constructor(opts = {}) {
    this.appId = opts.appId || process.env.SQUAD_HUB_GH_APP_ID || null;
    const rawKey = opts.privateKey !== undefined ? opts.privateKey : process.env.SQUAD_HUB_GH_APP_PRIVATE_KEY;
    this.apiBase = opts.apiBase || 'https://api.github.com';
    this._now = opts.now || (() => Date.now());
    this.log = opts.log || (() => {});

    this._privateKey = null;
    this._disabledReason = null;

    if (!this.appId || !rawKey) {
      this._disabledReason = 'the GitHub App is not configured (SQUAD_HUB_GH_APP_ID / SQUAD_HUB_GH_APP_PRIVATE_KEY are not set)';
    } else {
      try {
        // A key pasted into a single-line env var commonly carries literal
        // backslash-n rather than real newlines; PEM parsing needs the real
        // thing. The parsed KeyObject is kept; the PEM string itself is not
        // assigned to any property this class retains past this block.
        const pem = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
        this._privateKey = crypto.createPrivateKey(pem);
      } catch {
        this._disabledReason = 'the GitHub App private key could not be parsed';
      }
    }

    this.enabled = !this._disabledReason;

    /** installationId -> {token, expiresAtMs}. The only place a live
     * installation token is held. */
    this._tokenCache = new Map();
  }

  /** A short, human reason the app is disabled, or `null` when it is not. */
  disabledReason() {
    return this._disabledReason;
  }

  // -- secret hygiene ---------------------------------------------------
  //
  // `this._tokenCache` holds live installation tokens. Node's default
  // inspection of a class instance walks every own property, so logging this
  // object -- an accident one `console.log(githubApp)` away -- would print
  // them. Overriding both the customary inspection hooks closes that off
  // without relying on every caller remembering not to.
  [util.inspect.custom]() {
    return `GitHubApp { enabled: ${this.enabled}${this.appId ? `, appId: ${this.appId}` : ''} }`;
  }

  toJSON() {
    return { enabled: this.enabled, appId: this.appId || null };
  }

  _err(status, message) {
    return Object.assign(new Error(message), { status: status || 502 });
  }

  async _request(args) {
    return httpRequest(`${this.apiBase}${args.path}`, {
      method: args.method,
      body: args.body,
      headers: {
        Authorization: `Bearer ${args.token}`,
        'User-Agent': 'squad-hub',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }

  /**
   * The App-level JWT, RS256-signed with Node's own `crypto.sign` (no JWT
   * library). `iss` is the App id; `iat`/`exp` sit inside GitHub's 10-minute
   * cap with the backdating described above.
   */
  _appJwt() {
    if (!this.enabled) throw this._err(501, this._disabledReason);
    const nowSec = Math.floor(this._now() / 1000);
    const iat = nowSec - JWT_BACKDATE_SEC;
    const exp = iat + JWT_TTL_SEC;
    const signingInput = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat, exp, iss: String(this.appId) })}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), this._privateKey);
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  /** Every installation this App is on: `[{id, login}]`. */
  async _listInstallations() {
    const jwt = this._appJwt();
    const res = await this._request({ method: 'GET', path: '/app/installations?per_page=100', token: jwt });
    if (res.status !== 200) throw this._err(upstreamStatus(res.status), `could not list GitHub App installations (GitHub returned ${res.status})`);
    return (res.json || []).map((i) => ({ id: i.id, login: i.account && i.account.login }));
  }

  /**
   * An installation access token, minted fresh only when the cached one is
   * missing or close to expiry -- `TOKEN_REFRESH_BUFFER_MS` early, never
   * late. Reused across calls in between, which is the whole reason a cache
   * exists here rather than minting one per request.
   */
  async _installationToken(installationId) {
    const now = this._now();
    const cached = this._tokenCache.get(installationId);
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_BUFFER_MS > now) {
      return cached.token;
    }
    const jwt = this._appJwt();
    const res = await this._request({
      method: 'POST', path: `/app/installations/${installationId}/access_tokens`, token: jwt,
    });
    if (res.status !== 201) {
      throw this._err(upstreamStatus(res.status), `could not mint an installation token for installation ${installationId} (GitHub returned ${res.status})`);
    }
    const token = res.json.token;
    const expiresAtMs = new Date(res.json.expires_at).getTime();
    this._tokenCache.set(installationId, { token, expiresAtMs });
    this.log(`github-app: refreshed the installation token for installation ${installationId}`);
    return token;
  }

  async _listInstallationRepos(token) {
    const res = await this._request({ method: 'GET', path: '/installation/repositories?per_page=100', token });
    if (res.status !== 200) throw this._err(upstreamStatus(res.status), `could not list repositories for this installation (GitHub returned ${res.status})`);
    return (res.json.repositories || []).map((r) => r.full_name);
  }

  /**
   * Every repository the App's installations can see -- the allow-list a
   * dispatch is checked against, and what `GET /api/aca/repos` reports.
   * `[{installationId, owner, repo, fullName}]`.
   */
  async listInstalledRepos() {
    const installations = await this._listInstallations();
    const out = [];
    for (const inst of installations) {
      const token = await this._installationToken(inst.id);
      const repos = await this._listInstallationRepos(token);
      for (const fullName of repos) {
        const [owner, repo] = fullName.split('/');
        out.push({ installationId: inst.id, owner, repo, fullName });
      }
    }
    return out;
  }

  /** `{installationId, owner, repo, fullName}` for `owner/repo`, or `null` if
   * the App is not installed there. The ONLY path from caller input to a
   * token -- a repo that does not appear here is refused, never guessed at. */
  async findInstallation(owner, repo) {
    const repos = await this.listInstalledRepos();
    const target = `${owner}/${repo}`.toLowerCase();
    return repos.find((r) => r.fullName.toLowerCase() === target) || null;
  }

  async _hasDispatchWorkflow(owner, repo, token) {
    const { exists } = await this._dispatchWorkflowFile(owner, repo, token);
    return exists;
  }

  /**
   * Reads `squad-dispatch.yml` off the repository's own default branch (no
   * `ref` is passed, so GitHub's contents API answers from whatever the
   * repository itself calls its default branch) and reports both whether it
   * exists and which `workflow_dispatch` inputs it declares.
   *
   * `declaredInputs` is `null` when the file exists but does not declare
   * `workflow_dispatch` at all (nothing to dispatch against either way), and
   * `[]` when it declares the trigger with no inputs block.
   */
  async _dispatchWorkflowFile(owner, repo, token) {
    const res = await this._request({
      method: 'GET', path: `/repos/${owner}/${repo}/contents/.github/workflows/${WORKFLOW_FILE}`, token,
    });
    // A missing file is an ordinary, expected answer -- NOT an error, and
    // must not be conflated with one: a repo without this workflow yet is not
    // the same fact as "GitHub could not be reached".
    if (res.status === 404) return { exists: false, declaredInputs: null };
    if (res.status !== 200) {
      throw this._err(upstreamStatus(res.status), `could not check for ${WORKFLOW_FILE} in ${owner}/${repo} (GitHub returned ${res.status})`);
    }
    let declaredInputs = null;
    if (res.json && typeof res.json.content === 'string') {
      const yamlText = Buffer.from(res.json.content, 'base64').toString('utf8');
      declaredInputs = parseDeclaredWorkflowInputs(yamlText);
    }
    return { exists: true, declaredInputs };
  }

  async _defaultBranch(owner, repo, token) {
    const res = await this._request({ method: 'GET', path: `/repos/${owner}/${repo}`, token });
    if (res.status !== 200) throw this._err(upstreamStatus(res.status), `could not read ${owner}/${repo} (GitHub returned ${res.status})`);
    return res.json.default_branch || 'main';
  }

  async _createIssue(owner, repo, { title }, token) {
    const res = await this._request({ method: 'POST', path: `/repos/${owner}/${repo}/issues`, token, body: { title } });
    if (res.status !== 201) throw this._err(upstreamStatus(res.status), `could not create an issue in ${owner}/${repo} (GitHub returned ${res.status})`);
    return { number: res.json.number, htmlUrl: res.json.html_url };
  }

  async _dispatchWorkflow(owner, repo, ref, inputs, token) {
    const res = await this._request({
      method: 'POST', path: `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, token, body: { ref, inputs },
    });
    // workflow_dispatch returns 204 with no body -- there is no run id to
    // hand back synchronously, which is why `runUrl` below is the workflow's
    // Actions page rather than a specific run.
    if (res.status !== 204) {
      throw this._err(upstreamStatus(res.status), `GitHub refused the workflow dispatch for ${owner}/${repo} (status ${res.status})`);
    }
  }

  /** Every repo the App can see, with whether each has `squad-dispatch.yml`.
   * `GET /api/aca/repos`. A 404 from the contents check is "no"; anything
   * else is a clear error rather than a silent false, per the issue. */
  async listReposWithDispatchStatus() {
    const repos = await this.listInstalledRepos();
    const out = [];
    for (const r of repos) {
      const token = await this._installationToken(r.installationId);
      const hasDispatchWorkflow = await this._hasDispatchWorkflow(r.owner, r.repo, token);
      out.push({ fullName: r.fullName, owner: r.owner, repo: r.repo, hasDispatchWorkflow });
    }
    return out;
  }

  /**
   * Dispatch `squad-dispatch.yml` on `owner/repo`, already-validated and
   * already allow-listed by the caller (see `hub-service.js`'s
   * `/api/aca/dispatch`, which resolves `installationId` via
   * `findInstallation` before this is ever called).
   *
   * Every precondition -- the workflow existing, and every requested option
   * being one the workflow actually declares -- is checked BEFORE `newIssue`
   * ever creates anything. If the dispatch call itself still fails after an
   * issue was created for it, the thrown error carries `.issue` so the
   * caller is not left unable to find an issue this call already made.
   *
   * Returns `{issue, runUrl, installationId, workflowFile, ref, dispatchedAt}`
   * -- the last four kept so `DispatchTracker` can resolve a run's status
   * later without re-doing the allow-list lookup.
   */
  async dispatch({
    owner, repo, installationId, baseBranch, issue, newIssue, prompt, model, publishPr, reviewer, watchOnly,
  }) {
    const token = await this._installationToken(installationId);

    const { exists: hasWorkflow, declaredInputs } = await this._dispatchWorkflowFile(owner, repo, token);
    if (!hasWorkflow) {
      throw this._err(422, `${owner}/${repo} has no .github/workflows/${WORKFLOW_FILE}`);
    }

    // GitHub's `workflow_dispatch` API answers 422 for an input the workflow
    // does not declare -- it does not ignore it. Refusing it here, before any
    // side effect, gives a caller a clear reason naming the field, instead of
    // a 422 from GitHub that never says which input it meant, reached only
    // after an issue may already have been created for nothing.
    const requested = requestedInputNames({
      model, baseBranch, publishPr, reviewer, watchOnly,
    });
    const declared = declaredInputs || [];
    const unsupported = requested.filter((name) => !declared.includes(name));
    if (unsupported.length) {
      throw this._err(
        422,
        `${owner}/${repo}'s ${WORKFLOW_FILE} does not declare the input(s): ${unsupported.join(', ')}. `
          + 'Add them to the workflow\'s workflow_dispatch.inputs (see swigerb/squad-on-aca#135), or omit them from this request.',
      );
    }

    // ALWAYS the repository's own default branch -- never the
    // caller-supplied `baseBranch`, which travels only as the `base_branch`
    // INPUT above (and only when the workflow declares it, per the check
    // just above). Dispatching on anything else would let any signed-in hub
    // user run an App-scoped workflow_dispatch against an arbitrary ref of
    // their own choosing. See docs/security.md.
    const ref = await this._defaultBranch(owner, repo, token);

    let issueNumber = issue;
    let issueUrl = issue != null ? `https://github.com/${owner}/${repo}/issues/${issue}` : null;
    if (issueNumber == null && newIssue) {
      const created = await this._createIssue(owner, repo, newIssue, token);
      issueNumber = created.number;
      issueUrl = created.htmlUrl;
    }

    const inputs = buildWorkflowInputs(
      { prompt, model, baseBranch, publishPr, reviewer, watchOnly },
      { issueNumber },
    );

    // Captured immediately before the call that actually starts the run --
    // see `resolveRunStatus`, which matches a run no older than this.
    const dispatchedAt = this._now();
    try {
      await this._dispatchWorkflow(owner, repo, ref, inputs, token);
    } catch (e) {
      if (newIssue) e.issue = { number: issueNumber, url: issueUrl };
      throw e;
    }

    return {
      issue: { number: issueNumber, url: issueUrl },
      runUrl: `https://github.com/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}`,
      installationId,
      workflowFile: WORKFLOW_FILE,
      ref,
      dispatchedAt,
    };
  }

  /** A single Actions run by id, for refreshing a dispatch already bound to
   * one -- see `DispatchTracker.listWithStatus`, which must never re-run the
   * matching search (and so never risk re-binding) once a run is known. */
  async _getRun(owner, repo, installationId, runId) {
    const token = await this._installationToken(installationId);
    const res = await this._request({ method: 'GET', path: `/repos/${owner}/${repo}/actions/runs/${runId}`, token });
    if (res.status !== 200) {
      throw this._err(upstreamStatus(res.status), `could not read Actions run ${runId} for ${owner}/${repo} (GitHub returned ${res.status})`);
    }
    return {
      state: res.json.status,
      conclusion: res.json.conclusion || null,
      runId: res.json.id,
      htmlUrl: res.json.html_url,
    };
  }

  /**
   * The Actions run status for one tracked dispatch, for
   * `GET /api/aca/dispatches`. Matches the earliest-created run of this
   * workflow that:
   *   - was triggered by `workflow_dispatch` (never a run some other trigger
   *     started, which would otherwise look like this dispatch's own run),
   *   - was created no earlier than the dispatch's own timestamp, floored to
   *     whole seconds (GitHub's `created_at` has no finer resolution) minus
   *     `RUN_MATCH_TOLERANCE_MS` of slack for ordinary clock drift,
   *   - ran on the same `ref` this dispatch actually used (never a
   *     coincidentally-close run on a different branch),
   *   - is not already `excludeRunIds` -- a run id some OTHER recorded
   *     dispatch has already been bound to, so two close dispatches on one
   *     repo never both claim the same run.
   */
  async resolveRunStatus({
    owner, repo, installationId, dispatchedAt, ref, excludeRunIds,
  }) {
    const token = await this._installationToken(installationId);
    const res = await this._request({
      method: 'GET',
      path: `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=20`,
      token,
    });
    if (res.status !== 200) {
      throw this._err(upstreamStatus(res.status), `could not read Actions runs for ${owner}/${repo} (GitHub returned ${res.status})`);
    }
    const flooredDispatchedAt = Math.floor(dispatchedAt / 1000) * 1000;
    const minCreatedAt = flooredDispatchedAt - RUN_MATCH_TOLERANCE_MS;
    const runs = (res.json.workflow_runs || [])
      .filter((r) => new Date(r.created_at).getTime() >= minCreatedAt)
      .filter((r) => !ref || r.head_branch === ref)
      .filter((r) => !excludeRunIds || !excludeRunIds.has(r.id))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    if (!runs.length) return { state: 'pending', reason: 'no run has appeared yet' };
    const run = runs[0];
    return {
      state: run.status, // queued | in_progress | completed
      conclusion: run.conclusion || null,
      runId: run.id,
      htmlUrl: run.html_url,
    };
  }
}

module.exports = {
  GitHubApp, WORKFLOW_FILE, parseDeclaredWorkflowInputs, upstreamStatus,
};
