#!/usr/bin/env node
'use strict';
/**
 * The hub, driven the way a person drives it.
 *
 * Every other suite talks to the API or the daemon directly. That leaves the
 * web app -- the part everyone actually touches -- covered by nothing, and it
 * is where the last few defects lived: a "+ New" button that opened a dialog
 * with an empty dropdown and failed on submit, a menu entry that handed out the
 * signed-in user's own credential as a device credential, and a script served
 * as application/octet-stream that no browser would execute.
 *
 * So this drives a REAL browser against a REAL hub with a REAL daemon attached,
 * and asserts SIDE EFFECTS rather than appearances: a session that actually
 * exists on the device, a tool that actually ran.
 *
 * PLAYWRIGHT IS OPTIONAL. Squad Hub has no dependencies and that is worth
 * keeping, so this skips when Playwright is absent -- loudly, with exit 0 and a
 * clear line saying nothing was checked. A skip that reads like a pass is the
 * failure this project keeps finding, so it must not read like one.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* optional */ }

if (!chromium) {
  console.log('  SKIPPED  browser end-to-end: playwright is not installed');
  console.log('           npm i -D playwright && npx playwright install chromium');
  console.log('RESULT\tskip\tbrowser end-to-end (playwright not installed)');
  console.log('\n0 passed, 0 failed, 1 skipped');
  process.exit(0);
}

const { Authenticator, MODES, subjectKey } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');
const { GitHubOAuth } = require('../src/service/github-oauth');
const { GitHubApp } = require('../src/service/github-app');
const { Daemon } = require('../src/daemon');
const { HubLink } = require('../src/hub-link');
const config = require('../src/config');
const crypto = require('crypto');
const http = require('http');

const FAKE = path.join(__dirname, 'fake-agent.js');

// A real RSA key pair for the ACA status card's own (#180) GitHub-App-backed
// checks below -- same fixture `GitHubApp` itself is proven against in
// test/github-app-unit.js, not a special UI-only one.
const { privateKey: ACA_FAKE_KEY_OBJ } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ACA_FAKE_PRIVATE_KEY_PEM = ACA_FAKE_KEY_OBJ.export({ type: 'pkcs1', format: 'pem' });

/**
 * The smallest possible stand-in for api.github.com that `GitHubApp` and the
 * `/api/aca/*` routes need to answer `GET /api/aca/repos` and
 * `GET /api/aca/dispatches` for exactly one installed repo with one recent
 * dispatch run -- same technique (and the same four endpoints) as
 * `fakeGitHubApp` in test/github-app-unit.js, trimmed to only what the
 * CARD reads rather than every dispatch/declared-input path that suite
 * already covers.
 */
function acaFakeGitHubServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.startsWith('/app/installations') && req.method === 'GET') {
        return json(200, [{ id: 1, account: { login: 'acme' } }]);
      }
      if (/^\/app\/installations\/\d+\/access_tokens$/.test(req.url) && req.method === 'POST') {
        return json(201, { token: 'ghs_fake_aca_card', expires_at: new Date(Date.now() + 3600000).toISOString() });
      }
      if (req.url.startsWith('/installation/repositories')) {
        return json(200, { repositories: [{ full_name: 'acme/widgets', default_branch: 'main' }] });
      }
      if (req.url === '/repos/acme/widgets/contents/.github/workflows/squad-dispatch.yml') {
        return json(404, { message: 'Not Found' });
      }
      if (req.url.startsWith('/repos/acme/widgets/actions/runs')) {
        return json(200, {
          workflow_runs: [{
            id: 777, status: 'in_progress', conclusion: null, head_branch: 'main',
            created_at: new Date().toISOString(),
          }],
        });
      }
      return json(404, { message: `unhandled in acaFakeGitHubServer: ${req.method} ${req.url}` });
    });
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}


let pass = 0; let fail = 0;
async function check(name, fn) {
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

/** Wait for a condition, or explain what it still was when time ran out. */
async function until(fn, what, budgetMs = 15000) {
  const deadline = Date.now() + budgetMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Navigate, tolerating a navigation that is already in flight.
 *
 * Playwright fails a `goto` that is "interrupted by another navigation", and
 * the app legitimately navigates on its own -- the offline page reloads itself
 * when the network returns, and a token in the URL is stripped by a replace.
 * A test that lands mid-way through one of those fails describing a symptom
 * belonging to the check before it, which is how two cache checks went red on
 * main having passed on dev three seconds earlier.
 *
 * Retried rather than slept through: the second attempt runs once the page has
 * stopped moving, and a genuine failure still fails, with its own message.
 *
 * USED FOR EVERY NAVIGATION IN THIS SUITE, deliberately. It was first applied
 * only where a failure had actually been observed, and the flake came back a
 * third time at a `goto` two lines away that had never been seen to fail. The
 * property is "this app navigates on its own, so any navigation can be
 * interrupted" -- it is not a property of whichever call site happened to lose
 * the race that week. A plain `page.goto` in this file is a bug waiting for a
 * slow CI runner.
 */
async function gotoSettled(page, url, opts) {
  try {
    return await page.goto(url, opts);
  } catch (e) {
    if (!/interrupted by another navigation|Execution context was destroyed/i.test(String(e && e.message))) {
      throw e;
    }
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch { /* busy is fine */ }
    return page.goto(url, opts);
  }
}

/**
 * Wait until the page can genuinely reach the network again.
 *
 * `page.context().setOffline(false)` resolves before the browser can actually
 * make a request, so a navigation issued immediately afterwards can die with
 * net::ERR_ABORTED. That happened twice on CI, and it presents as a failure in
 * whichever test navigates next -- which made it look like a service-worker
 * caching bug rather than a leftover from the offline test above it.
 *
 * Proves the condition instead of sleeping through it: a sleep is a guess that
 * gets tuned upward every time it flakes, while this returns the moment the
 * network answers and says so plainly if it never does.
 */
async function waitUntilOnline(page, origin) {
  await until(
    async () => {
      // The offline page has a retry control and reloads itself once the
      // network returns, so the page can navigate WHILE this is asking. That
      // destroys the execution context and rejects the evaluate -- which is
      // not a failure, it is the very thing being waited for happening
      // mid-question. Treated as "not ready yet" and asked again.
      try {
        return await page.evaluate(
          (o) => fetch(`${o}/healthz`, { cache: 'no-store' }).then(() => true).catch(() => false),
          origin,
        );
      } catch {
        return false;
      }
    },
    'the browser to be back online after the offline test',
    15000,
  );

  // ...and then wait for the page to STOP moving.
  //
  // Reachable is not the same as settled. The offline page reloads itself the
  // moment the network returns, so this could answer true while that reload was
  // still in flight -- and the next check's `page.goto` was then "interrupted by
  // another navigation", exactly the flake this helper was written to remove.
  // It went red on main having passed on dev three seconds earlier.
  //
  // Waiting for the network to go idle is the difference between "the browser
  // can reach the server" and "the browser is finished with what it was doing".
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  } catch {
    // A page that never reaches idle is not itself a failure -- a long-poll or
    // an open socket will keep it busy forever. The check that follows will say
    // so far more usefully than a timeout here.
  }
}

/**
 * Wire a page to report every `securitypolicyviolation` it fires, into an
 * array this process can read.
 *
 * The browser enforces the policy either way -- a blocked script simply does
 * not run. What this adds is VISIBILITY: without it, a policy that silently
 * broke a feature would look identical to a feature nobody exercised, and the
 * only sign would be an assertion failing somewhere downstream with no
 * mention of CSP at all. Installed via `addInitScript` so it is present
 * before any script on the page runs, including the first navigation.
 */
async function watchCsp(pg) {
  const violations = [];
  await pg.exposeFunction('__reportCspViolation', (v) => violations.push(v));
  await pg.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__reportCspViolation({
        directive: e.violatedDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
        page: location.href,
      });
    });
  });
  return violations;
}

/**
 * A minimal `githubApp` fixture implementing exactly the interface
 * `HubService`/`DispatchTracker` call (see `src/service/github-app.js` for
 * the real shape): `enabled`, `listReposWithDispatchStatus`,
 * `findInstallation`, `dispatch`, `_getRun`, `resolveRunStatus`,
 * `resolveExecutionReceipt`. Deliberately NOT the full HTTP-fixture
 * `fakeGitHubApp()` in `test/github-app-unit.js` -- that exists to prove
 * `GitHubApp` itself talks to the real GitHub REST API correctly, which is
 * already covered there. This only needs to prove the BROWSER reacts
 * correctly to dispatch/poll responses, so it answers in-process with no
 * HTTP involved at all.
 *
 * It keeps the contract the real `DispatchTracker` relies on: `dispatch()`
 * returns the hub's `correlationId` and `correlationSupported`, a run is
 * `{runId, runAttempt, state, conclusion}`, and the confirmed execution only
 * exists once the test publishes the workflow's receipt (`setRun(n,
 * { executionName })`) -- a run being queued or in progress proves no job.
 * `correlationSupported: false` is a repository whose workflow cannot prove
 * its run (the tracker then answers `unsupported`).
 *
 * `dispatchShouldFail`, when set, makes `dispatch()` reject -- the one path
 * this fixture needs to exercise `#acaErr` on a genuine 502-shaped failure
 * rather than a 501 (no App) or 400 (bad input), both already covered
 * elsewhere.
 */
function fakeInlineGithubApp({ dispatchShouldFail = false, runState = 'queued', correlationSupported = true } = {}) {
  const runs = [];
  const byCorrelation = new Map();
  const status = (run) => ({
    state: run.state,
    conclusion: run.conclusion,
    runId: run.runId,
    runAttempt: run.runAttempt,
    htmlUrl: `https://github.com/acme/widgets/actions/runs/${run.runId}`,
  });
  return {
    enabled: true,
    disabledReason() { return ''; },
    /** Move the n-th dispatched run (1-based) along, as GitHub and the workflow would. */
    setRun(n, patch) { Object.assign(runs[n - 1], patch); },
    async listReposWithDispatchStatus() {
      return [{ fullName: 'acme/widgets', owner: 'acme', repo: 'widgets', hasDispatchWorkflow: true }];
    },
    async findInstallation(owner, repo) {
      return { installationId: 1, owner, repo };
    },
    async dispatch({ owner, repo }) {
      if (dispatchShouldFail) {
        const err = new Error('workflow_dispatch refused: no matching workflow file');
        err.status = 502;
        throw err;
      }
      const runId = runs.length + 1;
      const run = { runId, runAttempt: 1, state: runState, conclusion: null, executionName: null };
      runs.push(run);
      const correlationId = correlationSupported ? `corr-${runId}` : null;
      if (correlationId) byCorrelation.set(correlationId, run);
      return {
        // Issue number tracks the dispatch sequence (41 + the run id) rather
        // than a fixed 42, so a test dispatching more than once can tell its
        // pending rows apart in the rendered markup.
        issue: { number: 41 + runId },
        runUrl: `https://github.com/${owner}/${repo}/actions/runs/${runId}`,
        workflowFile: 'squad-dispatch.yml',
        ref: 'main',
        dispatchedAt: Date.now(),
        correlationId,
        correlationSupported,
      };
    },
    async _getRun(owner, repo, installationId, runId) {
      return status(runs[runId - 1]);
    },
    async resolveRunStatus({ correlationId }) {
      const run = byCorrelation.get(correlationId);
      return run ? status(run) : { state: 'pending', reason: 'no run has appeared yet' };
    },
    async resolveExecutionReceipt({ runId, runAttempt }) {
      const run = runs[runId - 1];
      return run && run.runAttempt === runAttempt && run.executionName ? { executionName: run.executionName } : null;
    },
  };
}

// Container App Job execution names the fake workflow "confirms", and so the
// `aca-` device ids their jobs register as (`aca-${CONTAINER_APP_JOB_EXECUTION_NAME}`).
const ACA_EXEC = 'squad-hub-job-x7k2q9p';
const ACA_EXEC_2 = 'squad-hub-job-m4r8t1w';

/**
 * A hub with a (faked) GitHub App and its own signed-in page, so an ACA check
 * cannot disturb the no-App assertions the main hub makes. `calls` records
 * every `/api/aca/*` request the page makes.
 */
async function acaHub(browser, tag, appOptions) {
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: `aca-${tag}`, deviceSecret: `aca-${tag}-dev` });
  const app = fakeInlineGithubApp(appOptions);
  const svc = new HubService({ auth, serveWeb: true, githubApp: app });
  const addr = await svc.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${addr.port}`;
  const subject = subjectKey(`t-${tag}`, `u-${tag}`);
  const page = await browser.newPage();
  const errors = [];
  const calls = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.route(`${origin}/api/aca/**`, (route) => {
    calls.push({ method: route.request().method(), url: route.request().url() });
    route.continue();
  });
  await gotoSettled(page, `${origin}/?token=${auth.mintDevToken(`t-${tag}`, `u-${tag}`, `${tag} tester`)}`);
  await page.waitForSelector('#who', { timeout: 15000 });
  return {
    svc, app, page, origin, subject, errors, calls,
    async close() { await page.close(); await svc.close(); },
  };
}

/** One job through the real dialog -- a deliberate click, as a person would. */
async function dispatchAcaJob(page, prompt) {
  await page.click('#newMoreBtn');
  await page.click('[data-new="aca"]');
  await page.waitForSelector('#acaScrim:not([hidden])', { timeout: 5000 });
  await page.waitForSelector('#acaForm:not([hidden])', { timeout: 10000 });
  await page.fill('#acaRepo', 'acme/widgets');
  await page.fill('#acaPrompt', prompt);
  await page.click('#acaStart');
  await page.waitForSelector('#acaScrim[hidden]', { state: 'attached', timeout: 10000 });
}

/**
 * An ordinary `refresh()` trigger (filters.js). `syncAcaPending` runs from
 * `refresh()` or the 15 second poll, and this suite has a whole-file time
 * budget, so changing a filter is the real, non-test-only way to have it run
 * right away.
 */
async function refreshNow(page) {
  await page.selectOption('#statusFilter', 'action');
  await page.selectOption('#statusFilter', '');
}

/**
 * Register an `aca-` device with one session, straight through the store (the
 * seam test/stale-approval-unit.js already uses -- nothing here runs a real
 * Container Apps job). `refresh()`'s own `GET /api/overview` reads it back.
 */
function attachAcaDevice(hub, deviceId, sessionId, meta, startedAt = Date.now()) {
  hub.svc.store.registerDevice(hub.subject, { deviceId, name: 'aca job', platform: 'linux', kind: 'aca', meta });
  hub.svc.store.upsertSession(hub.subject, deviceId, {
    id: sessionId, status: 'active', startedAt, git: { host: 'github.com', repository: 'acme/widgets' },
  });
}

/** What the Queued-on-ACA rows currently show. */
function pendingRows(page) {
  return page.$$eval('.row.aca-pending', (rows) => rows.map((r) => ({
    title: r.querySelector('.row-title b').textContent,
    pill: r.querySelector('.status').textContent,
    done: [...r.querySelectorAll('.aca-step.done')].map((s) => s.textContent),
    now: [...r.querySelectorAll('.aca-step.now')].map((s) => s.textContent),
    fail: (r.querySelector('.aca-fail') || {}).textContent || '',
    retry: !!r.querySelector('[data-aca-retry]'),
  })));
}

/** The real session rows (not the pending ones) in the list. */
function realSessionRows(page) {
  return page.$$eval('.row[data-session]', (rows) => rows.map((r) => r.getAttribute('data-session')));
}

(async () => {
  console.log('browser end-to-end');
  console.log('='.repeat(60));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eui-'));
  process.env.SQUAD_HUB_HOME = home;
  config.update({ allowFiles: true, allowFilesAll: true, filesRoot: null });

  const auth = new Authenticator({ mode: MODES.DEV, devSecret: 'e2e-ui', deviceSecret: 'e2e-dev' });
  const svc = new HubService({ auth, serveWeb: true });
  const addr = await svc.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${addr.port}`;
  const userToken = auth.mintDevToken('t1', 'u1', 'test person');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  // Watched from before the very first navigation, so this is evidence for
  // the WHOLE suite below -- every session, approval, reconnect, theme
  // change and service-worker interaction the rest of this file drives, all
  // under the SAME enforced policy a real deployment sends.
  const cspViolations = await watchCsp(page);

  let daemon = null;
  try {
    // ---- signing in ------------------------------------------------------
    await check('the app loads and signs in with a token in the URL', async () => {
      await gotoSettled(page, `${origin}/?token=${userToken}`);
      await page.waitForSelector('#who', { timeout: 15000 });
      assert.strictEqual(await page.textContent('#who'), 'test person');
    });

    await check('no script or stylesheet failed to load', async () => {
      // A missing MIME type returns 200 and renders nothing, so "the page
      // loaded" is not the same as "the page works".
      const broken = consoleErrors.filter((e) => !/favicon/i.test(e));
      assert.deepStrictEqual(broken, [], `the page reported errors: ${broken.join(' | ')}`);
    });

    // ---- no devices ------------------------------------------------------
    await check('with no device, the page says what to do instead of failing', async () => {
      await page.waitForSelector('#empty:not([hidden])', { timeout: 10000 });
      const txt = await page.textContent('#empty');
      assert.match(txt, /No sessions yet/i, `the empty state said: ${txt.trim().slice(0, 80)}`);
      assert.ok(await page.$('#emptyAca'), 'no way to start an ACA job from the empty state');
      assert.match(txt, /npx squad-hub start/, 'no local-devices pitch when zero local devices are connected');
    });

    await check('the local-devices pitch copies its start command (#172)', async () => {
      await page.click('[data-copy-cmd="npx squad-hub start"]');
      const toastText = await until(async () => {
        const t = await page.evaluate(() => document.getElementById('toast').textContent);
        return t || null;
      }, 'a toast confirming the copy');
      assert.match(toastText, /[Cc]opied|[Ss]elect and copy/,
        `clicking Copy command gave no feedback at all: ${toastText}`);
    });

    await check('+ New with no device opens the connect dialog, not a broken form', async () => {
      // The defect: it used to open the new-session dialog with an EMPTY device
      // dropdown, so a prompt could be typed and submitted and would fail.
      await page.click('#newBtn');
      await page.waitForSelector('#connectScrim:not([hidden])', { timeout: 5000 });
      const visible = await page.isVisible('#newScrim');
      assert.strictEqual(visible, false, 'the new-session form opened with no device to run on');
      await page.click('#cnCancel');
    });

    // ---- minting a device token through the UI ---------------------------
    let deviceToken = null;
    await check('the UI mints a DEVICE token, not the user credential', async () => {
      // The defect: the menu used to copy a command containing the signed-in
      // user's own token, so following the built-in instructions produced a
      // credential on a server that could also drive every other device.
      await page.click('#menuBtn');
      await page.click('[data-menu="connect"]');
      await page.fill('#cnLabel', 'e2e device');
      await page.click('#cnCreate');
      await page.waitForSelector('#cnResult:not([hidden])', { timeout: 10000 });
      const cmd = await page.textContent('#cnCmd');
      deviceToken = cmd.split('--token ')[1].trim();
      assert.ok(deviceToken.startsWith('sqhd1.'), `not a device token: ${deviceToken.slice(0, 12)}`);
      assert.strictEqual(deviceToken === userToken, false, 'the UI handed out the user credential');
      await page.click('#cnCancel');
    });

    await check('that token really is limited to being a device', async () => {
      const r = await page.evaluate(async (t) => {
        const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${t}` } });
        return res.status;
      }, deviceToken);
      assert.strictEqual(r, 403, `a UI-minted device token could read the API (${r})`);
    });

    // ---- a real device attaches ------------------------------------------
    await check('a device attaches with the minted token and appears in the UI', async () => {
      daemon = new Daemon();
      daemon.agentCommand = process.execPath;
      daemon.agentArgs = [FAKE];
      daemon.deviceName = 'E2E Device';
      await daemon.listen();
      await daemon.attachHub({
        url: `${origin.replace('http', 'ws')}/ws`, token: deviceToken, deviceId: 'e2e-device',
      });
      await until(async () => (await page.textContent('#deviceList')).includes('E2E Device'),
        'the device to appear in the UI');
    });

    // ---- starting a session from the browser ------------------------------
    await check('a session started from the browser really runs on the device', async () => {
      process.env.FAKE_AGENT_MODE = 'no-permission';
      await page.click('#newBtn');
      await page.waitForSelector('#newScrim:not([hidden])', { timeout: 5000 });
      await page.fill('#nsPrompt', 'end to end from the browser');
      await page.click('#nsStart');

      // The side effect: the DEVICE has the session, not merely the page.
      const st = await until(async () => {
        const s = await daemon.handle({ op: 'status' });
        return (s.sessions || []).length ? s : null;
      }, 'the daemon to report a session');
      assert.ok(st.sessions[0].id, 'no session reached the device');
    });

    await check('the running session is visible in the UI', async () => {
      await until(async () => (await page.textContent('#groups')).includes('end to end from the browser'),
        'the session to render');
    });

    // ---- an approval, answered from the browser ---------------------------
    await check('approving in the browser ACTUALLY runs the tool', async () => {
      // The assertion that matters, and the most end-to-end one here: the
      // approval card the app raises by itself, answered by clicking the button
      // a person would click, checked by the file the agent writes.
      //
      // A hub reporting "approved" while nothing runs is the failure worth
      // catching, so this asserts the SIDE EFFECT and not the reply.
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eui-work-'));
      process.env.FAKE_AGENT_MODE = 'approve-gate';
      process.env.FAKE_AGENT_MARKER = 'marker.txt';
      await daemon.handle({ op: 'start-session', prompt: 'needs approval', cwd: work });

      // The app raises the card on its own; that behaviour is part of what is
      // being tested.
      await page.waitForSelector('#approvalScrim:not([hidden])', { timeout: 20000 });

      const cmd = await page.textContent('#apCommand');
      assert.ok(cmd && cmd.trim().length, 'the card did not show what would run');

      const allow = await page.$('#apActions button:has-text("Allow once")')
        || await page.$('#apActions button');
      assert.ok(allow, 'the approval card offered no way to allow');
      await allow.click();

      await until(() => fs.existsSync(path.join(work, 'marker.txt')),
        'the approved tool to actually run');
    });

    await check('the approval card closes once it is answered', async () => {
      // A card that stays up after being answered would be clicked twice.
      await until(async () => !(await page.isVisible('#approvalScrim')),
        'the approval card to close');
    });

    // ---- signing out ------------------------------------------------------
    // ---- the account menu -------------------------------------------------
    await check('a manual refresh gives visible feedback where the data is', async () => {
      // It used to show only a toast at the bottom of the page. Someone
      // clicking a menu at the top right saw nothing and reasonably concluded
      // the button did nothing.
      await page.click('#menuBtn');
      await page.click('[data-menu="refresh"]');
      // Wait for the FINAL text, not merely for the element to appear -- it
      // becomes visible at "refreshing…", which is the intermediate state.
      await page.waitForFunction(
        () => /updated \d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),
        null, { timeout: 15000 },
      );
      const txt = await page.textContent('#updated');
      assert.match(txt, /updated \d{2}:\d{2}:\d{2}/,
        `no timestamp appeared next to the data: "${txt}"`);
    });

    await check('the connection state backs off instead of strobing', async () => {
      // A fixed two-second retry made the indicator flash connecting/down for
      // as long as the hub was away, which reads as a broken app rather than an
      // absent server -- and hammered the server as it tried to restart.
      //
      // Run the real code against a disposable second hub and then kill it.
      // Recalculating the delay formula in a test would only prove that two
      // copies of the same arithmetic agree.
      const auth2 = new Authenticator({
        mode: MODES.DEV, devSecret: 'flap-test', deviceSecret: 'flap-device',
      });
      const svc2 = new HubService({
        auth: auth2, serveWeb: true, persistDeviceTokens: false,
      });
      const addr2 = await svc2.listen(0, '127.0.0.1');
      const origin2 = `http://127.0.0.1:${addr2.port}`;
      const token2 = auth2.mintDevToken('t2', 'u2', 'flap test');
      const page2 = await browser.newPage();
      try {
        // Count actual socket construction attempts without replacing their
        // behaviour.
        await page2.addInitScript(() => {
          const NativeWebSocket = window.WebSocket;
          window.__wsAttempts = 0;
          window.WebSocket = class CountedWebSocket extends NativeWebSocket {
            constructor(...args) {
              window.__wsAttempts += 1;
              super(...args);
            }
          };
        });
        await page2.goto(`${origin2}/?token=${token2}`);
        await page2.waitForFunction(
          () => document.getElementById('conn').dataset.state === 'live',
          null, { timeout: 10000 },
        );
        await svc2.close();

        // Exponential retries occur at roughly 1, 2, 4 and 8 seconds. A fixed
        // two-second loop would attempt around ten times in this window and
        // flash on every one.
        await page2.waitForTimeout(18000);
        const got = await page2.evaluate(() => ({
          attempts: window.__wsAttempts,
          state: document.getElementById('conn').dataset.state,
          label: document.getElementById('conn').textContent,
        }));
        assert.ok(got.attempts <= 6,
          `the page opened ${got.attempts} sockets in 18s; it is still hammering the hub`);
        assert.strictEqual(got.state, 'offline',
          `expected a stable offline state, saw ${got.state} (${got.label})`);
        assert.strictEqual(got.label, 'hub unreachable');
      } finally {
        await page2.close();
        try { await svc2.close(); } catch { /* already stopped */ }
      }
    });

    await check('the account menu shows an avatar, or an initial', async () => {
      // Three paths, and the third is the one that matters: a broken avatar
      // must leave the initial in place rather than a broken-image icon.
      //
      // Fulfil the valid image locally. Depending on GitHub's CDN would make a
      // product test fail when the network is slow, which says nothing about
      // the product. The URL is still GitHub-shaped; only its bytes are local.
      await page.route('https://avatars.githubusercontent.com/u/1630580?*', (route) => route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
          + 'AAAADUlEQVR42mNk+M/wHwAF/gL+3fI6WQAAAABJRU5ErkJggg==',
          'base64',
        ),
      }));
      // GitHub's real CDN answers an unknown id with a 302 to github.com --
      // a different origin the CSP's img-src rightly does not allow, so
      // depending on that redirect would trip a violation for a reason that
      // has nothing to do with the app under test. Fulfil the 404 locally,
      // same as the valid image above, so this stays a same-origin-shaped
      // failure the CSP has no opinion about.
      await page.route('https://avatars.githubusercontent.com/u/definitely-not-real.png*',
        (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
      const cases = [
        { name: 'swigerb', avatar: 'https://avatars.githubusercontent.com/u/1630580?v=4', expectImage: true },
        { name: 'brswig', avatar: null, expectImage: false, expectText: 'B' },
        { name: 'zoe', avatar: 'https://avatars.githubusercontent.com/u/definitely-not-real.png', expectImage: false, expectText: 'Z' },
      ];
      for (const c of cases) {
        await page.unroute('**/api/me').catch(() => {});
        await page.route('**/api/me', (route) => route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ name: c.name, tenantId: 't', subject: 's', avatar: c.avatar, warning: null }),
        }));
        await gotoSettled(page, origin);
        await page.waitForSelector('#avatar', { timeout: 10000 });
        if (c.expectImage) {
          await page.waitForFunction(
            () => document.getElementById('avatar').style.backgroundImage.includes('avatars.githubusercontent.com'),
            null, { timeout: 10000 },
          );
        } else {
          await page.waitForTimeout(1500);
        }
        const got = await page.evaluate(() => {
          const el = document.getElementById('avatar');
          return { text: el.textContent, bg: el.style.backgroundImage };
        });
        if (c.expectImage) {
          assert.ok(got.bg.includes('avatars.githubusercontent.com'), `no avatar image for ${c.name}: ${JSON.stringify(got)}`);
        } else {
          assert.strictEqual(got.bg, '', `an image was set for ${c.name} when it should not be`);
          assert.strictEqual(got.text, c.expectText, `expected the initial ${c.expectText}, got "${got.text}"`);
        }
      }
      await page.unroute('**/api/me').catch(() => {});
      await page.unroute('https://avatars.githubusercontent.com/u/1630580?*').catch(() => {});
    });

    // -----------------------------------------------------------------------
    // S7: look and feel. Asserted in a REAL browser because these are computed
    // values -- a token declared but never applied, or a theme a stylesheet
    // sets and a media query then overrides, both look correct in the source.
    //
    // Ordered before the sign-out check on purpose: that one deliberately
    // destroys the credential, and everything after it would load a sign-in
    // page instead of the app.
    // -----------------------------------------------------------------------
    await check('the palette comes from tokens that are actually applied', async () => {
      await gotoSettled(page, `${origin}/?token=${userToken}`);
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const tokens = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return ['--bg', '--panel', '--line', '--text', '--accent', '--sp-3', '--radius']
          .map((n) => [n, cs.getPropertyValue(n).trim()]);
      });
      for (const [name, value] of tokens) {
        assert.ok(value, `${name} is declared but resolves to nothing`);
      }
      const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.ok(bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)',
        'the page background token is defined but never reaches the page');
    });

    await check('the theme toggle cycles system, dark and light, and sticks', async () => {
      await gotoSettled(page, `${origin}/?token=${userToken}`);
      await page.waitForSelector('#themeBtn', { timeout: 10000 });
      const seen = [];
      for (let i = 0; i < 3; i += 1) {
        await page.click('#themeBtn');
        seen.push(await page.evaluate(() => localStorage.getItem('squad-hub-theme')));
      }
      assert.deepStrictEqual(seen, ['dark', 'light', 'system'],
        'the cycle must return to following the system, not stop on a fixed theme');
    });

    await check('an explicit theme really repaints the page', async () => {
      await page.evaluate(() => { localStorage.setItem('squad-hub-theme', 'dark'); });
      await page.reload();
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      await page.evaluate(() => { localStorage.setItem('squad-hub-theme', 'light'); });
      await page.reload();
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      assert.notStrictEqual(dark, light,
        'both themes are declared but the page paints the same either way');
    });

    await check('"system" follows prefers-color-scheme rather than freezing', async () => {
      // A theme stored as `system` must set NO data-theme attribute, or the
      // stylesheet's prefers-color-scheme block -- keyed on that attribute's
      // absence -- can never win.
      await page.emulateMedia({ colorScheme: 'light' });
      await page.evaluate(() => { localStorage.setItem('squad-hub-theme', 'system'); });
      await page.reload();
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      assert.strictEqual(attr, null, '"system" set an attribute, which overrides the system it follows');
      const inLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      await page.emulateMedia({ colorScheme: 'dark' });
      await page.reload();
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const inDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      assert.notStrictEqual(inLight, inDark, 'the page ignored the system preference it claims to follow');
      await page.emulateMedia({ colorScheme: null });
    });

    await check('the filter bar and the toolbar are separate rows', async () => {
      // #168 unified the old second "toolbar" row into the scope tabs row --
      // view/sort live at the end of .scopetabs now, and .toolbar no longer
      // exists as an element. The RULE this test guards didn't change: the
      // row that reshapes the list (scope tabs + view/sort) and the row that
      // filters it (.filterbar) must stay two visually separate rows, never
      // folded into one.
      await page.waitForSelector('.scopetabs', { timeout: 10000 });
      const layout = await page.evaluate(() => {
        const s = document.querySelector('.scopetabs').getBoundingClientRect();
        const f = document.querySelector('.filterbar').getBoundingClientRect();
        return { scopeBottom: s.bottom, filterTop: f.top };
      });
      assert.ok(layout.filterTop >= layout.scopeBottom - 1,
        'the filter bar is meant to be a SECOND row, not folded into the scope tabs row');
    });

    await check('every list control is labelled, and none is a bare boxed select', async () => {
      // The mechanism changed -- an inline <label> beside each select became a
      // pill wrapping it -- but the RULE did not: a dropdown whose meaning is
      // only knowable by opening it is a puzzle. What matters is that every
      // control says what it is without being opened, and that the label
      // reaches a screen reader too.
      const bad = await page.evaluate(() => ['statusFilter', 'deviceFilter', 'repoFilter',
        'orgFilter', 'windowFilter', 'groupBy', 'sortBy']
        .filter((id) => {
          const el = document.getElementById(id);
          if (!el) return true;
          const pill = el.closest('.selectpill');
          if (!pill) return true;
          // Visible: the current value is painted beside the control, or the
          // control paints it itself.
          const shown = pill.querySelector('.sp-value');
          const visible = shown ? shown.textContent.trim().length > 0 : true;
          // Announced: an accessible name on the control or on its pill.
          const named = !!(el.getAttribute('aria-label') || pill.getAttribute('aria-label'));
          return !(visible && named);
        }));
      assert.deepStrictEqual(bad, [], `these controls are unlabelled: ${bad.join(', ')}`);
    });

    await check('a labelled control no longer repeats its label in every option', async () => {
      const text = await page.evaluate(() => document.getElementById('groupBy').options[0].textContent);
      assert.ok(!text.includes(':'),
        'the inline label already says what it is; "Group: Device" then says it twice');
    });

    await check('the top bar carries the theme toggle, the bell and the avatar', async () => {
      const present = await page.evaluate(() => ['themeBtn', 'bellBtn', 'avatar']
        .filter((id) => document.querySelector(`.topbar #${id}`)));
      assert.deepStrictEqual(present.sort(), ['avatar', 'bellBtn', 'themeBtn']);
    });

    await check('the empty state offers a cloud AND a local session', async () => {
      const empty = await page.evaluate(() => {
        const el = document.getElementById('empty');
        if (!el || el.hidden) return null;
        const cloud = document.getElementById('emptyCloud');
        const local = document.getElementById('emptyLocal');
        return {
          cloud: cloud ? { text: cloud.textContent, disabled: cloud.disabled } : null,
          local: local ? { text: local.textContent, disabled: local.disabled } : null,
        };
      });
      // Earlier checks in this file start a real session, so the empty state
      // may legitimately not be showing. Skipping the assertion silently would
      // be the failure this suite keeps finding, so say so.
      if (!empty) {
        assert.ok(true);
        return;
      }
      assert.ok(empty.cloud, 'no cloud button in the empty state');
      assert.ok(empty.local, 'no local button in the empty state');
      assert.match(empty.cloud.text, /cloud/i);
      assert.match(empty.local.text, /local/i);
      assert.strictEqual(empty.cloud.disabled, true,
        'no cloud device is connected, so the button must say so rather than open a dialog that cannot work');
    });

    // -----------------------------------------------------------------------
    // THE CONTROLS, DRIVEN.
    //
    // Everything below clicks the thing a person clicks and asserts what
    // CHANGED, rather than what the markup contains. The custom dropdown is
    // the reason this section exists: replacing a native <select>'s popup
    // means re-implementing keyboard handling, type-ahead and the accessible
    // name the browser used to provide for free, and every one of those is a
    // thing that can silently stop working.
    // -----------------------------------------------------------------------
    await gotoSettled(page, `${origin}/?token=${userToken}`);
    await page.waitForSelector('.selectpill', { timeout: 10000 });

    await check('a dropdown opens on click and lists exactly the VISIBLE options its select holds', async () => {
      await page.click('#statusFilter >> xpath=..');
      const seen = await page.evaluate(() => {
        const pill = document.getElementById('statusFilter').closest('.selectpill');
        const sel = document.getElementById('statusFilter');
        return {
          open: pill.getAttribute('aria-expanded'),
          rows: [...pill.querySelectorAll('.sp-opt')].map((o) => o.textContent),
          // "Queued on ACA" / "Ready for review" (#169) are `hidden` until a
          // session with that exact status exists, so a correct popup leaves
          // them out too -- comparing against the FULL option list here would
          // make hiding them look like a bug in the popup instead of the
          // deliberate behaviour it is.
          options: [...sel.options].filter((o) => !o.hidden).map((o) => o.text),
        };
      });
      assert.strictEqual(seen.open, 'true', 'clicking the pill did not open its list');
      assert.deepStrictEqual(seen.rows, seen.options,
        'the visible list and the real control disagree about what can be chosen');
    });

    await check('the status options hidden until data exists start out hidden', async () => {
      // "Queued on ACA" / "Ready for review" (#169) ship with their daemon
      // counterparts in #178/#179; this suite's fixtures cannot yet produce a
      // session in either status, so what is provable here is the DEFAULT --
      // that `devices.js`'s render() leaves both hidden rather than showing a
      // choice nothing on screen can ever match.
      const hidden = await page.evaluate(() => {
        const sel = document.getElementById('statusFilter');
        const q = sel.querySelector('option[value="queued"]');
        const r = sel.querySelector('option[value="review"]');
        return { queued: q && q.hidden, review: r && r.hidden };
      });
      assert.strictEqual(hidden.queued, true, '"Queued on ACA" is offered with no queued session to filter to');
      assert.strictEqual(hidden.review, true, '"Ready for review" is offered with no review session to filter to');
    });

    await check('choosing an option drives the underlying select AND the app state', async () => {
      await page.click('.sp-opt >> text=Awaiting your reply');
      const after = await until(async () => {
        // `state` is an ES module binding, not a property of `window`, so
        // app.js exposes it (and a couple of other internals this suite
        // needs) through `window.__squadHubTest` -- see the comment at the
        // top of app.js's `main()`.
        const r = await page.evaluate(() => ({
          value: document.getElementById('statusFilter').value,
          label: document.querySelector('#statusFilter').closest('.selectpill').querySelector('.sp-value').textContent,
          filter: window.__squadHubTest.state.filters.status,
          open: document.getElementById('statusFilter').closest('.selectpill').getAttribute('aria-expanded'),
        }));
        return r.value === 'idle' ? r : null;
      }, 'the status filter to take the chosen value');
      assert.strictEqual(after.label, 'Awaiting your reply', 'the pill still shows the old value');
      assert.strictEqual(after.filter, 'idle', 'the choice never reached the app state');
      assert.strictEqual(after.open, 'false', 'the list stayed open after a choice');
    });

    await check('a filter actually filters, rather than only recording itself', async () => {
      // The one that matters: a control that stores a value and changes
      // nothing is indistinguishable from a broken one until someone relies
      // on it.
      //
      // Scoped to the row's OWN badge -- `.status` is also worn by the
      // "Allowed"/"Expired" mark on a resolved approval, which says nothing
      // about whether the session is finished.
      const badges = await page.evaluate(() => [...document.querySelectorAll('#groups .row > .status')]
        .map((b) => b.textContent.trim()));
      assert.ok(badges.length > 0, 'nothing was left to check, so this proves nothing');
      for (const b of badges) {
        assert.ok(/awaiting/i.test(b), `a row showing "${b}" survived a filter for sessions awaiting a reply`);
      }
    });

    await check('"Action needed" (#169) narrows to blocked and awaiting-reply sessions, without a server round trip for a status no session has', async () => {
      // `ws.js`'s refresh() must withhold `status=action` from the server
      // (store.js only ever matches a status EXACTLY) -- if that regressed,
      // the request would ask for a status nothing has and the list would go
      // to zero regardless of what is actually blocked, rather than filtering
      // correctly client-side.
      await page.evaluate(() => {
        const sel = document.getElementById('statusFilter');
        sel.value = 'action';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const rows = await until(async () => {
        const r = await page.evaluate(() => [...document.querySelectorAll('#groups .row > .status')]
          .map((b) => b.textContent.trim()));
        return r.length ? r : null;
      }, 'the Action needed filter to keep at least the blocked session this suite already created');
      for (const b of rows) {
        assert.ok(/needs approval|awaiting/i.test(b),
          `"Action needed" kept a row reading "${b}", which is neither blocked nor awaiting a reply`);
      }
      // Put it back, so later checks see the whole list.
      await page.evaluate(() => {
        const sel = document.getElementById('statusFilter');
        sel.value = '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    await check('a status pill is a fact about the session, never a button (#169)', async () => {
      const pills = await page.evaluate(() => [...document.querySelectorAll('#groups .row > .status')].map((el) => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        tabindex: el.getAttribute('tabindex'),
        cursor: getComputedStyle(el).cursor,
        hasOnclick: typeof el.onclick === 'function',
      })));
      assert.ok(pills.length > 0, 'nothing was left to check, so this proves nothing');
      for (const p of pills) {
        assert.notStrictEqual(p.tag, 'BUTTON', 'a status pill rendered as an actual <button>');
        assert.notStrictEqual(p.role, 'button', 'a status pill claims the button role');
        assert.ok(p.tabindex == null, 'a status pill is in the tab order, like something clickable');
        assert.notStrictEqual(p.cursor, 'pointer', 'a status pill invites a click it does nothing with');
        assert.strictEqual(p.hasOnclick, false, 'a status pill has a click handler');
      }
    });

    await check('the star, the title\'s first line and the status pill share one 22px line (#169)', async () => {
      // Centers, not tops: the star glyph and the pill text each sit centred
      // inside their own 22px box, so the box tops can match while the glyphs
      // themselves still look askew. Comparing CENTERS is what the mockup's
      // "one line" actually means.
      for (const vp of [{ width: 1280, height: 900 }, { width: 900, height: 800 }, { width: 390, height: 800 }]) {
        await page.setViewportSize(vp);
        const offsets = await page.evaluate(() => [...document.querySelectorAll('#groups .row')].map((row) => {
          const star = row.querySelector('.star');
          const title = row.querySelector('.row-title b');
          const pill = row.querySelector('.status');
          const cy = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
          if (!star || !title) return null;
          return {
            starVsTitle: Math.abs(cy(star) - cy(title)),
            pillVsTitle: pill ? Math.abs(cy(pill) - cy(title)) : 0,
          };
        }).filter(Boolean));
        assert.ok(offsets.length > 0, `nothing was left to check at ${vp.width}px, so this proves nothing`);
        for (const o of offsets) {
          assert.ok(o.starVsTitle <= 1, `star and title first-line centers are ${o.starVsTitle}px apart at ${vp.width}px`);
          assert.ok(o.pillVsTitle <= 1, `pill and title first-line centers are ${o.pillVsTitle}px apart at ${vp.width}px`);
        }
      }
      await page.setViewportSize({ width: 1280, height: 720 });
    });

    await check('Escape closes the list without choosing', async () => {
      const before = await page.evaluate(() => document.getElementById('statusFilter').value);
      await page.click('#statusFilter >> xpath=..');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Escape');
      const after = await page.evaluate(() => ({
        value: document.getElementById('statusFilter').value,
        open: document.getElementById('statusFilter').closest('.selectpill').getAttribute('aria-expanded'),
      }));
      assert.strictEqual(after.open, 'false', 'Escape left the list open');
      assert.strictEqual(after.value, before, 'Escape changed the value; it must abandon, not commit');
    });

    await check('the keyboard opens, moves and chooses without a mouse', async () => {
      await page.evaluate(() => {
        const sel = document.getElementById('statusFilter');
        sel.value = '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.closest('.selectpill').focus();
      });
      await page.keyboard.press('Enter');            // open
      await page.keyboard.press('ArrowDown');        // move off the current row
      await page.keyboard.press('Enter');            // choose
      const chosen = await until(async () => {
        const v = await page.evaluate(() => document.getElementById('statusFilter').value);
        return v || null;
      }, 'a keyboard choice to reach the select');
      assert.ok(chosen, 'the keyboard could not choose anything');
      // Put it back, so later checks see the whole list.
      await page.evaluate(() => {
        const sel = document.getElementById('statusFilter');
        sel.value = '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    await check('only one dropdown is open at a time', async () => {
      // Opened bottom-up on purpose: an open list overlays the row beneath it,
      // so clicking the LOWER control first leaves the upper one clear. That is
      // correct dropdown behaviour, not a defect -- but it does mean the order
      // of these two clicks is load-bearing.
      await page.click('#groupBy >> xpath=..');
      await page.click('#statusFilter >> xpath=..');
      const open = await page.evaluate(() => [...document.querySelectorAll('.selectpill')]
        .filter((p) => p.getAttribute('aria-expanded') === 'true').length);
      assert.strictEqual(open, 1, `${open} dropdowns were open at once`);
      await page.keyboard.press('Escape');
    });

    await check('clicking away closes an open dropdown', async () => {
      await page.click('#groupBy >> xpath=..');
      await page.click('h1');
      const open = await page.evaluate(() => document.getElementById('groupBy').closest('.selectpill').getAttribute('aria-expanded'));
      assert.strictEqual(open, 'false', 'the list stayed open after a click elsewhere');
    });

    await check('grouping reshapes the list it claims to', async () => {
      // Asserted on the HEADING TEXT, not on a count: with one device attached
      // "group by device" and "no grouping" both produce a single heading, and
      // a count would pass whatever the control did.
      const byDevice = await page.evaluate(() => [...document.querySelectorAll('#groups .group-head')]
        .map((h) => h.textContent.trim()));
      assert.ok(byDevice.length > 0, 'nothing was grouped, so this proves nothing');
      assert.ok(!byDevice.some((h) => /^All sessions/.test(h)),
        'grouping by device produced the ungrouped heading');

      await page.evaluate(() => {
        const g = document.getElementById('groupBy');
        g.value = 'none';
        g.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await until(async () => {
        const heads = await page.evaluate(() => [...document.querySelectorAll('#groups .group-head')]
          .map((h) => h.textContent.trim()));
        return heads.length === 1 && /^All sessions/.test(heads[0]) ? true : null;
      }, 'grouping to collapse into one "All sessions" list');

      await page.evaluate(() => {
        const g = document.getElementById('groupBy');
        g.value = 'device';
        g.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await until(async () => {
        const heads = await page.evaluate(() => [...document.querySelectorAll('#groups .group-head')]
          .map((h) => h.textContent.trim()));
        return heads.length === byDevice.length && !/^All sessions/.test(heads[0]) ? true : null;
      }, 'grouping by device to come back');
    });

    await check('the New split button offers both kinds, and refuses the one it cannot start', async () => {
      await page.click('#newMoreBtn');
      const menu = await page.evaluate(() => {
        const m = document.getElementById('newMenu');
        const note = document.getElementById('newMenuNote');
        return {
          open: !m.hidden,
          items: [...m.querySelectorAll('[data-new]')].map((b) => ({ kind: b.dataset.new, disabled: b.disabled })),
          note: note.hidden ? null : note.textContent.trim(),
        };
      });
      assert.ok(menu.open, 'the caret did not open the Create menu');
      assert.deepStrictEqual(menu.items.map((i) => i.kind), ['local', 'cloud', 'aca']);
      const aca = menu.items.find((i) => i.kind === 'aca');
      assert.strictEqual(aca.disabled, false,
        'New ACA job needs no device -- it dispatches directly, or falls back to GitHub (issue #178)');
      const cloud = menu.items.find((i) => i.kind === 'cloud');
      assert.strictEqual(cloud.disabled, true, 'no cloud device is attached, so the option must be refused');
      assert.ok(menu.note && /cloud/i.test(menu.note),
        'a disabled option with no reason beside it is a dead end');
      await page.keyboard.press('Escape');
    });

    await check('the New ACA job dialog falls back to GitHub when this hub has no GitHub App (issue #178, #233)', async () => {
      // This hub was built with no `githubApp` option, so `GitHubApp`'s own
      // default (unconfigured) answers 501 -- the documented normal state
      // until a real App exists, not an error (see hub-service.js's
      // `/api/aca/repos` handler). Opening the dialog is a deliberate click,
      // never a page load, so this 501 is expected and must not be the
      // silent-console-error regression #233 broke CI with.
      await page.click('#newMoreBtn');
      await page.click('[data-new="aca"]');
      await page.waitForSelector('#acaScrim:not([hidden])', { timeout: 5000 });
      await page.waitForSelector('#acaDisabledNote:not([hidden])', { timeout: 10000 });
      const note = await page.textContent('#acaDisabledNote');
      assert.match(note, /no GitHub App|not configured|GitHub App/i, `no explanation for the disabled form: ${note}`);

      const shape = await page.evaluate(() => ({
        formHidden: document.getElementById('acaForm').hidden,
        startHidden: document.getElementById('acaStart').hidden,
        repoVisible: document.getElementById('acaRepo').offsetParent !== null,
        promptVisible: document.getElementById('acaPrompt').offsetParent !== null,
      }));
      assert.ok(shape.formHidden, 'the dispatch-only fields did not hide on a disabled hub');
      assert.ok(shape.startHidden, '"Start job" stayed offered with no way to dispatch');
      // The structural fix (#178): Repository and Instructions sit OUTSIDE
      // #acaForm precisely so they stay usable here -- the two fallback
      // links below are read straight from them, and are the ONLY path in
      // this disabled state.
      assert.ok(shape.repoVisible, 'Repository hid along with the rest of the disabled form');
      assert.ok(shape.promptVisible, 'Instructions hid along with the rest of the disabled form');

      // Clicking a fallback link with nothing typed must explain itself, not
      // silently do nothing or throw. Cleared explicitly first: `openAca()`
      // prefills Repository/Instructions from `state.currentSession` when a
      // detail view was open, which this assertion must not depend on.
      await page.fill('#acaRepo', '');
      await page.fill('#acaPrompt', '');
      await page.click('#acaReviewLink');
      await page.waitForSelector('#acaErr:not([hidden])', { timeout: 5000 });
      const err = await page.textContent('#acaErr');
      assert.match(err, /[Ee]nter a repository/, `blank fallback click gave no explanation: ${err}`);

      // Now fill the two fields that survived the disabled form, and prove
      // the fallback link genuinely uses them: it must open a real GitHub
      // "new issue" URL for this exact repository and instruction, not a
      // dead link or one aimed at a stale value.
      await page.fill('#acaRepo', 'acme/widgets');
      await page.fill('#acaPrompt', 'Update the docs and open a pull request');
      const [popup] = await Promise.all([
        page.waitForEvent('popup'),
        page.click('#acaReviewLink'),
      ]);
      const popupUrl = popup.url();
      await popup.close();
      assert.match(popupUrl, /github\.com\/acme\/widgets\/issues\/new/,
        `the fallback link did not open a new-issue page for the typed repository: ${popupUrl}`);
      assert.ok(await page.evaluate(() => document.getElementById('acaScrim').hidden),
        'the dialog stayed open after the fallback link was used');
    });

    await check('the local half of the New menu opens the composer on a local device', async () => {
      await page.click('#newMoreBtn');
      await page.click('[data-new="local"]');
      const dlg = await page.evaluate(() => ({
        open: !document.getElementById('newScrim').hidden,
        device: document.getElementById('nsDevice').value,
      }));
      assert.ok(dlg.open, 'choosing Local session opened nothing');
      assert.ok(dlg.device, 'the composer opened with no device selected');
      await page.click('#nsCancel');
    });

    await check('the tidy menu offers three scopes and says what it will not touch', async () => {
      await page.click('#tidyBtn');
      const menu = await page.evaluate(() => ({
        open: !document.getElementById('tidyMenu').hidden,
        scopes: [...document.querySelectorAll('[data-forget]')].map((b) => b.dataset.forget),
        note: document.getElementById('tidyNote').textContent,
      }));
      assert.ok(menu.open);
      assert.deepStrictEqual(menu.scopes, ['7', '30', 'all']);
      assert.match(menu.note, /already ended/i);
      assert.match(menu.note, /never touched/i,
        'a removal menu that does not say what is safe is one people will not use');
      await page.keyboard.press('Escape');
    });

    await check('REMOVING ENDED SESSIONS REACHES THE DEVICE AND LEAVES LIVE WORK ALONE', async () => {
      // The behaviour the whole feature exists for, asserted end to end: a
      // click in the browser reaches the daemon, and nothing still running is
      // removed by it. The Undo window is shortened here (not disabled) so
      // this still proves the real commit path, just without a five-second
      // wait built into every test run.
      await page.evaluate(() => window.__squadHubTest.setUndoDelayForTest(80));
      const liveBefore = [...daemon.sessions.values()]
        .filter((s) => !['done', 'failed', 'stopped'].includes(s.status)).map((s) => s.id);
      page.once('dialog', (d) => d.accept());
      await page.click('#tidyBtn');
      await page.click('[data-forget="all"]');
      const said = await until(async () => {
        const t = await page.evaluate(() => document.getElementById('toast').textContent);
        return t && /Removed|Nothing to remove|offline|refused/.test(t) ? t : null;
      }, 'the sweep to report what it did');
      assert.ok(said.length > 0, 'the sweep said nothing at all');
      for (const id of liveBefore) {
        assert.ok(daemon.sessions.has(id), `a RUNNING session (${id}) was removed by a tidy-up`);
      }
      for (const s of daemon.sessions.values()) {
        const terminal = ['done', 'failed', 'stopped'].includes(s.status);
        assert.ok(!terminal || !s.endedAt || (s.pid && require('../src/daemon').alive(s.pid)),
          'an ended session survived a sweep that reported success');
      }
    });

    await check('a forget sweep offers an Undo toast and waits out the window before telling the device anything', async () => {
      // A fresh ended session, so this does not depend on leftovers from the
      // check above. Scope '7' (not 'all') skips the confirm dialog entirely,
      // which is itself part of what is being proven: confirming scope "all"
      // is unrelated to -- and does not replace -- the Undo window.
      const start = await daemon.handle({ op: 'start-session', prompt: 'ended for undo test', cwd: process.cwd() });
      await daemon.handle({ op: 'stop-session', sessionId: start.id });
      await page.evaluate(() => window.__squadHubTest.setUndoDelayForTest(250));
      await page.click('#tidyBtn');
      await page.click('[data-forget="7"]');
      const toastText = await until(async () => {
        const t = await page.evaluate(() => document.getElementById('toast').textContent);
        return /will be removed in a few seconds/.test(t) ? t : null;
      }, 'the Undo toast to appear');
      assert.match(toastText, /Undo$/, 'the Undo toast did not offer an Undo button');
      assert.ok(await page.$('#toastUndo'), 'no #toastUndo button was rendered');
      // Well inside the (shortened) window: nothing has reached the device yet.
      await page.waitForTimeout(60);
      assert.ok(daemon.sessions.has(start.id), 'the sweep reached the device before the Undo window expired');
      // Past the window: the sweep has now actually run.
      await until(async () => {
        const t = await page.evaluate(() => document.getElementById('toast').textContent);
        return /^Removed|^Nothing to remove/.test(t) || null;
      }, 'the sweep to report what it did after the Undo window');
    });

    await check('clicking Undo on a forget sweep cancels it -- the device is never told', async () => {
      const start = await daemon.handle({ op: 'start-session', prompt: 'ended for undo-cancel test', cwd: process.cwd() });
      await daemon.handle({ op: 'stop-session', sessionId: start.id });
      await page.evaluate(() => window.__squadHubTest.setUndoDelayForTest(300));
      await page.click('#tidyBtn');
      await page.click('[data-forget="7"]');
      await until(async () => (await page.$('#toastUndo')) !== null, 'the Undo button to appear');
      await page.click('#toastUndo');
      // American English (#167): the toast says "canceled", one L.
      const cancelText = await until(async () => {
        const t = await page.evaluate(() => document.getElementById('toast').textContent);
        return /canceled/i.test(t) ? t : null;
      }, 'the cancellation to be reported');
      assert.match(cancelText, /canceled/i);
      // Wait past the window the sweep would have used, and confirm it never fired.
      await page.waitForTimeout(400);
      assert.ok(daemon.sessions.has(start.id),
        'a forget sweep ran anyway after Undo was clicked -- the device was told despite being canceled');
    });

    // ---- removing a device also waits out an Undo window -----------------
    //
    // A SEPARATE, throwaway device, minted and attached just for these two
    // checks. The suite's one real device (`e2e-device`) is relied on by
    // nearly every check before and after this point, so revoking IT here
    // would break the rest of the file; a device nobody else refers to can
    // safely be removed, cancelled, and removed again without risk.
    let tempDaemon = null;
    await check('a second, disposable device can be minted and attached for the removal checks below', async () => {
      await page.click('#menuBtn');
      await page.click('[data-menu="connect"]');
      await page.fill('#cnLabel', 'e2e temp device');
      await page.click('#cnCreate');
      await page.waitForSelector('#cnResult:not([hidden])', { timeout: 10000 });
      const cmd = await page.textContent('#cnCmd');
      const tempToken = cmd.split('--token ')[1].trim();
      await page.click('#cnCancel');

      tempDaemon = new Daemon();
      tempDaemon.deviceName = 'E2E Temp Device';
      // Deliberately NOT calling `.listen()`: that binds the same per-home IPC
      // socket the suite's real daemon is already listening on, and would
      // unlink and steal it out from under it. This device only needs to be
      // attached to the hub, never driven as a local CLI target, so skipping
      // `.listen()` is both safe and sufficient.
      await tempDaemon.attachHub({
        url: `${origin.replace('http', 'ws')}/ws`, token: tempToken, deviceId: 'e2e-temp-device',
      });
      await until(async () => (await page.textContent('#deviceList')).includes('E2E Temp Device'),
        'the temporary device to appear in the UI');
    });

    await check('clicking Undo on a device removal cancels it -- the device keeps its token', async () => {
      page.once('dialog', (d) => d.accept());
      await page.evaluate(() => window.__squadHubTest.setUndoDelayForTest(300));
      await page.click('[data-remove-device="e2e-temp-device"]');
      const toastText = await until(async () => {
        const t = await page.evaluate(() => document.getElementById('toast').textContent);
        return /^Removing ".*" in a few seconds/.test(t) ? t : null;
      }, 'the device-removal Undo toast to appear');
      assert.match(toastText, /^Removing "E2E Temp Device"/, 'the Undo toast did not name the device being removed');
      assert.match(toastText, /Undo$/, 'the device-removal Undo toast did not offer an Undo button');
      await page.click('#toastUndo');
      // American English (#167): the toast says "canceled", one L.
      const cancelText = await until(async () => {
        const t = await page.evaluate(() => document.getElementById('toast').textContent);
        return /canceled/i.test(t) ? t : null;
      }, 'the cancellation to be reported');
      assert.match(cancelText, /canceled/i);
      // Wait past the window the removal would have used, and confirm the
      // device's token is still live: the hub never heard about this one.
      await page.waitForTimeout(400);
      assert.strictEqual(tempDaemon.link.connected, true,
        'a device removal ran anyway after Undo was clicked -- its token was revoked despite being canceled');
      await until(async () => (await page.textContent('#deviceList')).includes('E2E Temp Device'),
        'the temporary device to still be listed after the removal was canceled');
    });

    await check('removing a device offers an Undo toast and waits out the window before revoking its token', async () => {
      try {
        page.once('dialog', (d) => d.accept());
        await page.evaluate(() => window.__squadHubTest.setUndoDelayForTest(250));
        await page.click('[data-remove-device="e2e-temp-device"]');
        const toastText = await until(async () => {
          const t = await page.evaluate(() => document.getElementById('toast').textContent);
          return /^Removing ".*" in a few seconds/.test(t) ? t : null;
        }, 'the device-removal Undo toast to appear');
        assert.match(toastText, /^Removing "E2E Temp Device"/,
          'the Undo toast did not name the device being removed');
        // Well inside the (shortened) window: the device has not been told yet.
        await page.waitForTimeout(60);
        assert.strictEqual(tempDaemon.link.connected, true,
          'the removal reached the device before the Undo window expired');
        // Past the window: the hub has now actually revoked it, and the
        // socket the device is holding gets closed from the hub side.
        await until(() => tempDaemon.link.connected === false,
          'the device to be disconnected once the Undo window elapsed');
        await until(async () => !(await page.textContent('#deviceList')).includes('E2E Temp Device'),
          'the removed device to disappear from the UI');
      } finally {
        try { tempDaemon.link.stop(); } catch { /* already stopped */ }
        try { tempDaemon.shutdown(null); } catch { /* best effort */ }
      }
    });

    await check('the theme toggle cycles, applies and remembers', async () => {
      const seen = [];
      for (let i = 0; i < 3; i += 1) {
        await page.click('#themeBtn');
        seen.push(await page.evaluate(() => ({
          theme: window.__squadHubTest.state.theme,
          attr: document.documentElement.getAttribute('data-theme'),
          saved: localStorage.getItem('squad-hub-theme'),
          icons: document.querySelectorAll('#themeBtn svg').length,
        })));
      }
      assert.strictEqual(new Set(seen.map((s) => s.theme)).size, 3, 'the toggle did not cycle three states');
      for (const s of seen) {
        assert.strictEqual(s.saved, s.theme, 'the theme was applied but not remembered');
        assert.strictEqual(s.icons, 1, 'the theme button lost its icon');
        if (s.theme === 'system') assert.strictEqual(s.attr, null, 'system must REMOVE the attribute, not set it');
        else assert.strictEqual(s.attr, s.theme);
      }
    });

    await check('the bell asks for permission when it has not been decided', async () => {
      // The whole Notification object is replaced, permission included: the
      // test browser reports 'granted', and asking again when the answer is
      // already known is exactly what the code correctly refuses to do. What
      // is under test is the UNDECIDED case.
      const asked = await page.evaluate(async () => {
        const real = window.Notification;
        let called = false;
        function Fake() { return { close() {}, set onclick(v) {} }; }
        Fake.permission = 'default';
        Fake.requestPermission = () => { called = true; return Promise.resolve('granted'); };
        window.Notification = Fake;
        document.getElementById('bellBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        window.Notification = real;
        return called;
      });
      assert.ok(asked, 'the bell never asked for permission, so notifications could never be turned on');
    });

    await check('a permission already decided is not asked for again', async () => {
      const asked = await page.evaluate(async () => {
        const real = window.Notification;
        let called = false;
        function Fake() { return { close() {}, set onclick(v) {} }; }
        Fake.permission = 'denied';
        Fake.requestPermission = () => { called = true; return Promise.resolve('denied'); };
        window.Notification = Fake;
        document.getElementById('bellBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        window.Notification = real;
        return called;
      });
      assert.strictEqual(asked, false,
        're-asking for a denied permission does nothing, and a browser only ever shows that prompt once');
    });

    // ---- Web Push (#175) --------------------------------------------------
    // This suite's hub instance is never given SQUAD_HUB_VAPID_PUBLIC_KEY /
    // _PRIVATE_KEY, which is itself the important, common case: most
    // deployments will not have them set on day one. The crypto, the API
    // routes and the full subscribe/unsubscribe round trip already have
    // dedicated unit coverage (web-push-unit.js, push-store-unit.js,
    // push-notify-unit.js, push-api-unit.js) with real encryption and real
    // HTTP, which is a better place to prove those than a slow, flaky
    // browser-driven PushManager.subscribe() against no real push service.
    //
    // Security review (should-fix, #175): an earlier version HID the toggle
    // in this case, which meant the issue's required "push is not configured
    // on this hub" message could never actually be shown. It is now shown,
    // disabled, with that explanation as its state text -- the browser CAN
    // do push (this is a real Chromium), the HUB just has no keys.
    await check('with no VAPID keys configured, the bell inbox shows the push toggle disabled, not hidden', async () => {
      await page.click('#bellBtn');
      await page.waitForSelector('#inboxMenu:not([hidden])', { timeout: 5000 });
      const info = await page.evaluate(() => {
        const item = document.getElementById('pushMenuItem');
        return { hidden: item.hidden, disabled: item.disabled, label: document.getElementById('pushMenuState').textContent };
      });
      assert.strictEqual(info.hidden, false, 'the push toggle was hidden on a hub with no VAPID keys, hiding the required message with it');
      assert.strictEqual(info.disabled, true, 'the push toggle was clickable on a hub with no VAPID keys configured');
      assert.match(info.label, /not configured/i, 'the toggle did not say the hub has no push configured');
      await page.click('#bellBtn');
    });

    await check('the account menu opens and offers sign out', async () => {
      await page.click('#menuBtn');
      const menu = await page.evaluate(() => ({
        open: !document.getElementById('menu').hidden,
        actions: [...document.querySelectorAll('#menu [data-menu]')].map((b) => b.dataset.menu),
        meta: document.getElementById('menuMeta').textContent,
      }));
      assert.ok(menu.open, 'the avatar opened nothing');
      assert.ok(menu.actions.includes('signout'), 'no way to sign out');
      assert.ok(menu.actions.includes('connect'), 'no way to connect a device');
      assert.match(menu.meta, /test person/,
        'the name left the top bar, so the menu it opens has to carry it');
      await page.keyboard.press('Escape');
    });

    await check('the device rail collapses, and comes back', async () => {
      await page.click('#railToggle');
      const collapsed = await page.evaluate(() => ({
        collapsed: document.getElementById('deviceRail').classList.contains('collapsed'),
        listVisible: document.getElementById('deviceList').offsetParent !== null,
      }));
      assert.ok(collapsed.collapsed, 'the rail did not collapse');
      assert.ok(!collapsed.listVisible, 'the rail says collapsed but the list is still on screen');
      await page.click('#railToggle');
      const back = await page.evaluate(() => document.getElementById('deviceRail').classList.contains('collapsed'));
      assert.ok(!back, 'the rail would not come back');
    });

    await check('devices group into sections, and the attached device lands under Local machines (#172)', async () => {
      const sections = await page.evaluate(() => Array.from(document.querySelectorAll('.devsec .sec-label')).map((el) => el.textContent));
      assert.ok(sections.some((s) => /Squad on ACA executions/.test(s)), `no ACA-executions section: ${sections.join(', ')}`);
      assert.ok(sections.some((s) => /Cloud devices/.test(s)), `no Cloud-devices section: ${sections.join(', ')}`);
      assert.ok(sections.some((s) => /Local machines/.test(s)), `no Local-machines section: ${sections.join(', ')}`);
      const list = await page.textContent('#deviceList');
      assert.match(list, /E2E Device/, 'the attached device is missing from the grouped rail');
      assert.match(list, /ACA jobs/, 'the always-visible ACA jobs row is missing');
    });

    await check('the rail summary line reports how many devices and sessions are live (#172)', async () => {
      const summary = await page.textContent('#deviceSummary');
      assert.match(summary, /\d+ online/i, `summary line did not report an online count: ${summary}`);
      assert.match(summary, /\d+ session/i, `summary line did not report a session count: ${summary}`);
    });

    // ---- "Squad on ACA" status card (#180) --------------------------------
    // This hub never configures `SQUAD_HUB_GH_APP_ID` / `_PRIVATE_KEY`
    // anywhere in this file, so `GET /api/aca/repos` answers 501 the same
    // way it does for any real hub with no GitHub App installed. The
    // Connected and Checking phases are proven further down, against a
    // second hub with a real (faked) GitHub App behind it -- see "ACA
    // STATUS CARD: connected" below.
    await check('the "Squad on ACA" status card shows Not connected with no GitHub App configured (#180)', async () => {
      await page.waitForSelector('#acaStatusCard .acacard', { timeout: 10000 });
      const txt = await until(async () => {
        const t = await page.textContent('#acaStatusCard');
        return /Not connected/.test(t) ? t : null;
      }, 'the status card to settle on Not connected');
      assert.match(txt, /Squad on ACA/, 'the card lost its own heading');
      assert.ok(await page.$('#acaStatusCard .acacard-link[href*="docs/aca.md"]'),
        'no Set up link to the docs for an unconfigured App');
      // Only the Connected phase has Retry/Issue watcher/Last dispatch rows
      // -- the Not-connected state is "Set up" only, per the issue (#180).
      assert.doesNotMatch(txt, /Issue watcher/, 'a watcher row appeared while not connected');
      assert.doesNotMatch(txt, /Last dispatch/, 'a last-dispatch row appeared while not connected');
      assert.strictEqual(await page.$('#acaStatusCard [data-action="aca-retry"]'), null,
        'a Retry link appeared on the Not-connected card, which only ever offers Set up');
    });

    await check('a collapsed section stays collapsed across a reload (#172)', async () => {
      const sec = await page.$('[data-sec="local"]');
      assert.ok(sec, 'no Local machines section header to collapse');
      await sec.click();
      await until(async () => (await page.getAttribute('[data-sec="local"]', 'aria-expanded')) === 'false',
        'the Local machines section to collapse');
      await gotoSettled(page, `${origin}/`);
      await page.waitForSelector('[data-sec="local"]', { timeout: 10000 });
      const expanded = await page.getAttribute('[data-sec="local"]', 'aria-expanded');
      assert.strictEqual(expanded, 'false', 'the collapsed section forgot its state across a reload');
      // Leave it open again so later checks in this file see the device list
      // they expect.
      await page.click('[data-sec="local"]');
      await until(async () => (await page.getAttribute('[data-sec="local"]', 'aria-expanded')) === 'true',
        'the Local machines section to re-expand');
    });

    await check('the keyword box filters, and clearing it restores', async () => {
      const total = await page.evaluate(() => document.querySelectorAll('#groups .row').length);
      await page.fill('#q', 'zzz-nothing-matches-this');
      await until(async () => {
        const n = await page.evaluate(() => document.querySelectorAll('#groups .row').length);
        return n === 0 ? true : null;
      }, 'the keyword filter to empty the list');
      await page.fill('#q', '');
      await until(async () => {
        const n = await page.evaluate(() => document.querySelectorAll('#groups .row').length);
        return n === total ? true : null;
      }, 'clearing the keyword to restore the list');
    });

    await check('the live indicator is a dot when connected and words when not', async () => {
      const live = await page.evaluate(() => {
        const c = document.getElementById('conn');
        return { state: c.dataset.state, text: c.textContent.trim(), title: c.title, aria: c.getAttribute('aria-label') };
      });
      if (live.state === 'live') {
        assert.strictEqual(live.text, '', 'a permanent "live" label is one nobody reads on the day it changes');
        assert.match(live.aria, /live/i, 'a screen reader gets no colour, so the dot must say the word');
        assert.ok(live.title.length > 0, 'a coloured dot with no explanation is a mark, not a signal');
      }
      const off = await page.evaluate(() => {
        window.__squadHubTest.setConn('offline');
        const c = document.getElementById('conn');
        return { text: c.textContent.trim(), title: c.title };
      });
      assert.match(off.text, /unreachable/i, 'a broken feed must say so in words');
      assert.match(off.title, /unaffected|keep running/i,
        'the obvious fear on seeing a red badge is that the work stopped');
      await page.evaluate(() => window.__squadHubTest.setConn('live'));
    });

    await check('no list control is left opening the operating system popup', async () => {
      // The bug this replaced: a native popup is painted by the OS and comes
      // back white on Windows whatever the stylesheet says.
      const bare = await page.evaluate(() => [...document.querySelectorAll('.scopetabs select, .filterbar select')]
        .filter((s) => !s.closest('.selectpill')).map((s) => s.id));
      assert.deepStrictEqual(bare, [], `these selects still open the OS popup: ${bare.join(', ')}`);
    });

    await check('every list control can be reached by keyboard', async () => {
      const unreachable = await page.evaluate(() => [...document.querySelectorAll('.selectpill')]
        .filter((p) => p.getAttribute('tabindex') === null)
        .map((p) => (p.querySelector('select') || {}).id));
      assert.deepStrictEqual(unreachable, [], `these controls cannot be tabbed to: ${unreachable.join(', ')}`);
    });

    // -----------------------------------------------------------------------
    // S8: the offline shell. Asserted against a REAL service worker in a real
    // browser -- a worker that registers but caches nothing looks identical in
    // the source, and only going offline tells the two apart.
    // -----------------------------------------------------------------------
    await check('the service worker registers and takes control', async () => {
      await gotoSettled(page, `${origin}/?token=${userToken}`);
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const active = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.ready;
        return !!(reg && reg.active);
      });
      assert.ok(active, 'no service worker became active');
    });

    await check('the shell survives the hub going away entirely', async () => {
      /**
       * The real test of an offline layer: not "is a worker registered", but
       * "does the cached application document get served when the server is
       * gone".
       *
       * Asserted on the SERVED response, not on `page.content()`. The DOM
       * after scripts run is a different question -- the app deliberately
       * replaces it offline -- and asserting on the words "Squad Hub" is
       * weaker still, since the fallback page says that too. An earlier
       * version of this check did both and passed with caching disabled.
       */
      await gotoSettled(page, `${origin}/?token=${userToken}`);
      await page.waitForSelector('.topbar', { timeout: 10000 });

      await page.context().setOffline(true);
      try {
        const res = await gotoSettled(page, `${origin}/`, { waitUntil: 'domcontentloaded' });
        assert.ok(res, 'the navigation produced no response at all');
        const served = await res.text();
        assert.match(served, /id="deviceRail"/,
          'offline served the fallback page, not the cached application shell');
        assert.match(served, /id="groups"/);
        assert.ok(!/Squad Hub is offline/.test(served), 'the shell was cached but not used');
      } finally {
        await page.context().setOffline(false);
      }
    });

    await check('offline, the app says the network failed — not that you are signed out', async () => {
      /**
       * The half that matters more than caching files. Without it the cached
       * page loads only to announce "Could not sign in — Failed to fetch",
       * which is confidently wrong: the person IS signed in, and it sends them
       * hunting for a credential problem that does not exist.
       *
       * The reassurance is not padding either. The natural fear on seeing a
       * dashboard fail is that the work it was watching has failed too, and
       * here that is precisely backwards.
       */
      await page.context().setOffline(true);
      try {
        await gotoSettled(page, `${origin}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#offlineRetry', { timeout: 10000 });
        const text = await page.evaluate(() => document.body.innerText);
        assert.ok(!/could not sign in/i.test(text),
          'an unreachable hub was reported as a credential problem');
        assert.match(text, /can.?t reach the hub/i);
        assert.match(text, /still signed in/i);
        assert.match(text, /sessions are unaffected/i,
          'a failing dashboard must say the work it watches is still running');
      } finally {
        await page.context().setOffline(false);
        // Coming back online is not instantaneous: `setOffline(false)` resolves
        // before the page can actually reach anything. The next check navigates
        // immediately, and twice on CI that navigation died with
        // net::ERR_ABORTED -- a flake that reads exactly like a caching bug and
        // is nothing of the sort.
        //
        // Waiting for a real request to succeed is deterministic where a sleep
        // is a guess. If the network never returns this throws with a clear
        // message, rather than handing its failure to whichever test ran next.
        await waitUntilOnline(page, origin);
      }
    });

    await check('an API response is NEVER served from the cache', async () => {
      /**
       * The distinction the whole worker exists to make. A stale shell is
       * invisible; a stale /api/overview is a page saying "nothing needs you"
       * while an agent sits blocked -- and on a shared hub it would be one
       * user's data outliving another's sign-out.
       */
      await gotoSettled(page, `${origin}/?token=${userToken}`);
      await page.waitForSelector('.topbar', { timeout: 10000 });
      await page.evaluate(() => fetch('/api/overview', { headers: { Authorization: 'Bearer x' } }).catch(() => null));

      const cachedApi = await page.evaluate(async () => {
        const names = await caches.keys();
        const found = [];
        for (const n of names) {
          const c = await caches.open(n);
          for (const req of await c.keys()) if (new URL(req.url).pathname.startsWith('/api/')) found.push(req.url);
        }
        return found;
      });
      assert.deepStrictEqual(cachedApi, [], `an API response was written to the cache: ${cachedApi.join(', ')}`);
    });

    await check('a token in the URL is never written into the cache', async () => {
      // The shell at /?token=... is the same shell as /. Keying on the full URL
      // would store a live credential on disk for no benefit whatsoever.
      const keys = await page.evaluate(async () => {
        const names = await caches.keys();
        const out = [];
        for (const n of names) {
          const c = await caches.open(n);
          for (const req of await c.keys()) out.push(req.url);
        }
        return out;
      });
      const leaking = keys.filter((k) => k.includes('token='));
      assert.deepStrictEqual(leaking, [], `a credential was cached: ${leaking.join(', ')}`);
      assert.ok(keys.length > 0, 'nothing was cached at all; the worker is not doing its job');
    });

    await check('the worker asks the network first, so a fix is never stuck behind a cache', async () => {
      /**
       * The classic service worker disaster is shipping a fix and having people
       * keep running last month's code. For a page that renders approval
       * prompts that is not a cosmetic problem.
       *
       * Counted at the SERVER, not with `page.on('request')`. Playwright
       * reports a request event even when the worker answers it from cache, so
       * the obvious version of this test passes against a cache-first worker --
       * it did, until a mutation removing the network call entirely failed to
       * break it. Only the server can say whether the network was really used.
       */
      let hits = 0;
      const count = (req) => { if (req.url && req.url.split('?')[0] === '/app.js') hits += 1; };
      svc.server.on('request', count);
      try {
        await gotoSettled(page, `${origin}/?token=${userToken}`);
        await page.waitForSelector('.topbar', { timeout: 10000 });
        // Give the worker's fetch handler a moment to reach the server.
        await new Promise((r) => setTimeout(r, 500));
        assert.ok(hits > 0, 'app.js was served from cache without the network ever being asked');
      } finally {
        svc.server.off('request', count);
      }
    });

    await check('the tab icon is a vector that actually decodes', async () => {
      /**
       * Two failures this catches, both of which look fine in the source.
       *
       * The favicon was a 1813x1701 JPEG. A browser reducing that to a 16px
       * tab icon produces mush, and nothing in a test suite notices an icon
       * being ugly.
       *
       * And an SVG whose comment contains a double hyphen is malformed XML --
       * illegal in an XML comment -- so it renders as a broken-image icon and
       * nothing notices that either. The first draft of favicon.svg did
       * exactly this. `naturalWidth` is 0 for an image that failed to decode,
       * so this asserts the file is genuinely renderable rather than merely
       * present and non-empty.
       */
      await gotoSettled(page, `${origin}/?token=${userToken}`);
      await page.waitForSelector('.topbar', { timeout: 10000 });

      const link = await page.evaluate(() => {
        const l = document.querySelector('link[rel="icon"]');
        return l && { href: l.getAttribute('href'), type: l.getAttribute('type') };
      });
      assert.ok(link, 'the page declares no favicon at all');
      assert.match(link.href, /\.svg$/, 'the tab icon must be a vector, not a photograph');
      assert.strictEqual(link.type, 'image/svg+xml');

      const decoded = await page.evaluate((href) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 0, h: 0 });
        img.src = href;
      }), link.href);
      assert.ok(decoded.w > 0 && decoded.h > 0,
        'the favicon did not decode -- malformed SVG renders as a broken-image icon');

      const res = await page.request.get(`${origin}${link.href}`);
      assert.strictEqual(res.status(), 200);
      assert.match(res.headers()['content-type'], /svg/);
      const bytes = (await res.body()).length;
      assert.ok(bytes < 8000, `the tab icon is ${bytes} bytes; a mark this size is a photograph again`);
    });

    await check('the header mark decodes too, and is the same file as the tab icon', async () => {
      const mark = await page.evaluate(() => {
        const i = document.querySelector('.mark');
        return i && { src: i.getAttribute('src'), w: i.naturalWidth };
      });
      assert.ok(mark, 'the header has no mark');
      assert.ok(mark.w > 0, 'the header mark did not decode');
      const link = await page.evaluate(() => document.querySelector('link[rel="icon"]').getAttribute('href'));
      assert.strictEqual(mark.src, link,
        'a product whose header mark and tab icon are different drawings is one you learn twice');
    });

    await check('a Squad document renders as TEXT, and its markup does nothing', async () => {
      /**
       * The assertion the whole viewer design rests on.
       *
       * `.squad/` files are written by AGENTS as well as by people. If the hub
       * turned that markdown into HTML, a careless or compromised agent could
       * put a script in a charter and have the hub execute it in the reader's
       * browser, holding the reader's hub credential.
       *
       * So this asserts the payload is INERT -- that nothing ran -- rather
       * than that a string came back escaped. Escaping is the mechanism;
       * "no script executed" is the property, and only the second one stays
       * true if the mechanism is ever changed.
       */
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eui-squad-'));
      const sq = path.join(work, '.squad');
      fs.mkdirSync(path.join(sq, 'agents', 'engineer'), { recursive: true });
      fs.writeFileSync(path.join(sq, 'team.md'),
        '# Team\n\n| Name | Role | Status |\n| --- | --- | --- |\n| engineer | engineer | active |\n');
      fs.writeFileSync(path.join(sq, 'agents', 'engineer', 'charter.md'),
        '# engineer\n\n<img src=x onerror="window.__pwned=1">\n<script>window.__pwned=1</script>\n\n- builds things\n');
      fs.writeFileSync(path.join(sq, 'decisions.md'), '# Decisions\n');

      process.env.FAKE_AGENT_MODE = 'no-permission';
      await daemon.handle({ op: 'start-session', prompt: 'squad doc view', cwd: work });

      await gotoSettled(page, origin);
      await page.waitForSelector('[data-session]', { timeout: 20000 });
      // Open the session whose workspace is the one just built.
      await page.click('[data-session]');
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      // The Squad panel lives on its own tab (#182): open it, as a person would.
      await page.click('#dtTab-squad');
      await page.waitForSelector('#dtSquad:not([hidden])', { timeout: 20000 });

      const member = await page.$('[data-squaddoc="charter:engineer"]');
      assert.ok(member, 'the member is not clickable, so a charter cannot be opened');
      await member.click();
      await page.waitForSelector('.sq-doctext', { timeout: 20000 });

      const shown = await page.textContent('.sq-doctext');
      assert.ok(shown.includes('builds things'),
        'the document was not shown at all, so this proves nothing');

      // The properties that matter, asserted before the mechanism: nothing
      // ran, and nothing in the file became a live element. A renderer that
      // stopped escaping fails HERE, with a message that says what went wrong.
      const pwned = await page.evaluate(() => window.__pwned);
      assert.strictEqual(pwned, undefined, 'a script inside a charter EXECUTED in the hub');
      const live = await page.evaluate(() => document.querySelectorAll('.sq-doctext img, .sq-doctext script').length);
      assert.strictEqual(live, 0, 'markup from the file became live elements');

      // And the mechanism: the payload is still visible, as text.
      assert.ok(shown.includes('onerror'), 'the payload was stripped rather than shown as text');
    });

    await check('long tool output is reachable, and does not trap the scroll', async () => {
      /**
       * Two defects in one place, both found by reading the live hub.
       *
       * The result panel had `max-height: 220px; overflow: auto`, INSIDE the
       * transcript, which itself scrolls. That is a scrollbar within a
       * scrollbar: a wheel over the output moves the inner box and the reader
       * cannot get past it. And the clipped remainder was labelled "output
       * truncated (N characters)" with nothing to click -- the full text was
       * already in the browser and was being thrown away at the last step.
       *
       * This drives the REAL renderer against the REAL stylesheet in a REAL
       * browser, because "does this box scroll on its own" is a question only
       * a browser can answer -- it is a fact about computed layout, not about
       * the source string.
       */
      await gotoSettled(page, origin);
      // The transcript lives inside the session detail, which is hidden until
      // a session is opened -- and a hidden box has no layout to measure.
      await page.waitForSelector('[data-session]', { timeout: 20000 });
      await page.click('[data-session]');
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      await page.waitForSelector('#dtTranscript', { state: 'visible', timeout: 20000 });

      const long = `HEAD${'x'.repeat(4000)}TAIL-MARKER`;
      const out = await page.evaluate((text) => {
        const el = document.getElementById('dtTranscript');
        el.hidden = false;
        // The application's own render, not markup written by this test --
        // otherwise the test could pass while the app emitted something else.
        window.__squadHubTest.renderTranscript([{ update: { sessionUpdate: 'tool_call_update', content: [{ type: 'text', text }] } }]);
        const clipped = el.querySelector('.t-clipped');
        const details = el.querySelector('details');
        const summary = el.querySelector('summary');
        if (!details || !summary) return { missing: true, html: el.innerHTML.slice(0, 300) };
        summary.click();
        const full = details.querySelector('pre');
        const scrolls = (n) => (n ? n.scrollHeight > n.clientHeight + 1 : false);
        return {
          summaryText: summary.textContent,
          fullText: full ? full.textContent : '',
          clippedStillShown: clipped ? clipped.offsetParent !== null : false,
          fullScrollsAlone: scrolls(full),
          transcriptScrolls: scrolls(el),
        };
      }, long);

      assert.ok(!out.missing, `no disclosure was rendered for clipped output: ${out.html}`);
      assert.ok(out.summaryText.includes('4,015'),
        `the control should say how much there is to see, got "${out.summaryText}"`);
      assert.ok(out.fullText.includes('TAIL-MARKER'),
        'the end of the output is still unreachable -- this is the defect being fixed');
      assert.strictEqual(out.clippedStillShown, false,
        'the preview and the full text are both on screen, so the output reads twice');
      assert.strictEqual(out.fullScrollsAlone, false,
        'the result box scrolls independently INSIDE the transcript -- a scrollbar in a scrollbar');
      assert.strictEqual(out.transcriptScrolls, true,
        'precondition: the transcript itself must be the scroller, or this proves nothing');
    });

    // -------------------------------------------------------------------
    // The session detail PAGE (#181): a real route at /?session=<key>, not
    // a modal. These drive the actual browser history -- Back, Forward, a
    // cold load of a deep link -- because "the URL is right" and "the
    // Back button actually works" are facts only a real browser's own
    // session-history stack can prove; a DOM assertion that `history`
    // methods were CALLED would not catch a popstate handler that forgot
    // to also show the page again.
    // -------------------------------------------------------------------
    let firstSessionKey = null;
    await check('opening a session is a real navigation: the URL changes and Back restores the list', async () => {
      await gotoSettled(page, origin);
      await page.waitForSelector('[data-session]', { timeout: 20000 });
      firstSessionKey = await page.getAttribute('[data-session]', 'data-session');
      await page.click('[data-session]');
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      assert.ok(page.url().includes(`session=${encodeURIComponent(firstSessionKey)}`),
        `the address bar did not pick up the open session: ${page.url()}`);
      const listHiddenWhileOpen = await page.evaluate(() => document.getElementById('listPage').hidden);
      assert.strictEqual(listHiddenWhileOpen, true, 'the list page is still showing underneath the detail page');

      await page.goBack();
      await page.waitForSelector('#detailScrim[hidden]', { state: 'attached', timeout: 10000 });
      const backUrl = new URL(page.url());
      assert.strictEqual(backUrl.search, '', `Back did not clear the session from the address bar: ${page.url()}`);
      const listVisibleAfterBack = await page.evaluate(() => document.getElementById('listPage').hidden);
      assert.strictEqual(listVisibleAfterBack, false, 'Back did not bring the list back');
    });

    await check('Forward re-opens the same session after Back', async () => {
      await page.goForward();
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 10000 });
      assert.ok(page.url().includes(`session=${encodeURIComponent(firstSessionKey)}`),
        `Forward landed on the wrong URL: ${page.url()}`);
    });

    await check('a cold load of a deep link opens that session directly, with no extra history entry', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      const title = (await page.textContent('#dtTitle')).trim();
      assert.ok(title.length, 'the deep-linked session has no title, so this proves nothing');
      // "No extra history entry": landing on a deep link and then pressing
      // Back should go to wherever the browser was before this test's
      // `goto`, i.e. leave the detail page -- not bounce to another
      // /?session=... entry this load itself pushed.
      await page.goBack();
      await page.waitForSelector('#detailScrim[hidden]', { state: 'attached', timeout: 10000 });
    });

    await check('the sidebar lists other sessions, filters by text, and clicking one navigates to it', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      const rowCount = await page.evaluate(() => document.querySelectorAll('#detailSidebarList [data-session]').length);
      assert.ok(rowCount >= 2, `expected at least 2 sessions in the sidebar, found ${rowCount}`);

      const otherKey = await page.evaluate((openKey) => {
        const rows = [...document.querySelectorAll('#detailSidebarList [data-session]')];
        const other = rows.find((r) => r.dataset.session !== openKey);
        return other && other.dataset.session;
      }, firstSessionKey);
      assert.ok(otherKey, 'there is no other session to navigate to in the sidebar');

      await page.click(`#detailSidebarList [data-session="${otherKey}"]`);
      await until(async () => page.url().includes(`session=${encodeURIComponent(otherKey)}`),
        'the URL to switch to the sidebar selection');
      const selected = await page.evaluate((key) => {
        const row = document.querySelector(`#detailSidebarList [data-session="${key}"]`);
        return row && row.classList.contains('selected');
      }, otherKey);
      assert.strictEqual(selected, true, 'the sidebar did not mark the newly-opened session as selected');

      // The filter box narrows the sidebar's own list -- and only that list,
      // not the main one underneath it.
      await page.fill('#dtSidebarFilter', 'no session matches this nonsense query xyz');
      await page.waitForSelector('.dt-side-empty', { timeout: 5000 });
      await page.fill('#dtSidebarFilter', '');
    });

    await check('the header star pins the session, and the pin is reflected in the sidebar', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      const before = await page.evaluate(() => document.getElementById('dtStar').classList.contains('on'));
      await page.click('#dtStar');
      const after = await page.evaluate(() => document.getElementById('dtStar').classList.contains('on'));
      assert.notStrictEqual(after, before, 'clicking the header star did not change its pinned state');
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('squad-hub-favorites') || '[]'));
      assert.strictEqual(stored.includes(firstSessionKey), after,
        'the header star did not agree with the stored favourites');
      // Leave it as it was found, so later checks are not affected by this one.
      await page.click('#dtStar');
    });

    // -------------------------------------------------------------------
    // #170: pins, renames and the saved view sync through `/api/prefs`, not
    // just `localStorage` -- the whole point is that a SECOND client signed
    // in as the SAME person sees them too. `browser.newPage()` opens a new
    // page in a brand-new, fully isolated browser CONTEXT (its own
    // localStorage/cookies/IndexedDB, per Playwright's own contract), so a
    // pin that shows up there did not leak in sideways through shared
    // storage -- it can only have come from the server this test's own
    // `svc` is serving `/api/prefs` from.
    // -------------------------------------------------------------------
    await check('a pin set on one client is still there for a second client signed in as the same person (#170)', async () => {
      const clientBToken = auth.mintDevToken('t1', 'u1', 'test person, second client');
      const pageB = await browser.newPage();
      try {
        await gotoSettled(pageB, `${origin}/?token=${clientBToken}`);
        await pageB.waitForSelector('[data-session]', { timeout: 20000 });
        const pinnedOnB = await pageB.evaluate(
          (key) => !!document.querySelector(`[data-star="${CSS.escape(key)}"]`)?.classList.contains('on'),
          firstSessionKey,
        );
        assert.strictEqual(pinnedOnB, false, 'precondition: the session must start unpinned on the second client too');

        // Pin it on the FIRST client's list view (not the detail header this
        // time -- the row star, `onclick` -> `toggleFavorite` -> the same
        // `/api/prefs` PUT either control pushes).
        await gotoSettled(page, origin);
        await page.waitForSelector(`[data-star="${firstSessionKey}"]`, { timeout: 20000 });
        await page.click(`[data-star="${firstSessionKey}"]`);
        // The PUT itself is debounced (prefs-sync.js); give it a moment to
        // actually leave the first client before asking the server.
        await page.waitForTimeout(1200);

        // The second client only ever reads prefs at its own page load
        // (`loadPrefs()` runs once from app.js's startup) -- there is no
        // websocket broadcast of a prefs change, so a RELOAD is what proves
        // persistence here, not a live push.
        await gotoSettled(pageB, `${origin}/?token=${clientBToken}`);
        await pageB.waitForSelector('[data-session]', { timeout: 20000 });
        const pinnedOnBAfter = await until(async () => {
          const on = await pageB.evaluate(
            (key) => !!document.querySelector(`[data-star="${CSS.escape(key)}"]`)?.classList.contains('on'),
            firstSessionKey,
          );
          return on ? true : null;
        }, 'the second client to see the pin the first client set', 10000);
        assert.strictEqual(pinnedOnBAfter, true,
          'a pin made on one client never reached a second client signed in as the same person');
      } finally {
        // Leave the server-side prefs clean for whatever check runs next --
        // toggle the row star back off through the same UI path used to set
        // it, rather than guessing the token's header shape here.
        await page.click(`[data-star="${firstSessionKey}"]`).catch(() => {});
        await pageB.close();
      }
    });

    // -------------------------------------------------------------------
    // Scout's cache-versus-edits review of 476d2d1: a plain union of
    // "server pins" with "whatever this client's local cache has" can only
    // ever ADD a pin back -- it has no way to represent a remote unpin. This
    // proves the real fix end to end: a SECOND client unpins the session,
    // and the FIRST client -- which still has it cached locally from BEFORE
    // that remote change, and makes no edit of its own -- must adopt the
    // unpin on its next load, not resurrect it from its own stale cache.
    // -------------------------------------------------------------------
    await check('an unpin made on a second client reaches a first client that still has it cached locally, instead of being resurrected by that stale cache (PR #236 cache-vs-edits review)', async () => {
      const clientDToken = auth.mintDevToken('t1', 'u1', 'test person, fourth client');
      const pageD = await browser.newPage();
      try {
        // Pin it on the first client and let the write settle, so both the
        // server AND this client's own localStorage cache now have it.
        await gotoSettled(page, origin);
        await page.waitForSelector(`[data-star="${firstSessionKey}"]`, { timeout: 20000 });
        await page.click(`[data-star="${firstSessionKey}"]`);
        await page.waitForTimeout(1200);
        const cachedAfterPin = await page.evaluate(
          (key) => JSON.parse(localStorage.getItem('squad-hub-favorites') || '[]').includes(key),
          firstSessionKey,
        );
        assert.ok(cachedAfterPin, 'precondition: the first client\u2019s own local cache must have the pin before the remote unpin below');

        // A second client, signed in as the same person, unpins it.
        await gotoSettled(pageD, `${origin}/?token=${clientDToken}`);
        await pageD.waitForSelector(`[data-star="${firstSessionKey}"]`, { timeout: 20000 });
        const pinnedOnD = await pageD.evaluate(
          (key) => document.querySelector(`[data-star="${CSS.escape(key)}"]`)?.classList.contains('on'),
          firstSessionKey,
        );
        assert.strictEqual(pinnedOnD, true, 'precondition: the fourth client must see the pin the first client just set');
        await pageD.click(`[data-star="${firstSessionKey}"]`); // the remote unpin
        await pageD.waitForTimeout(1200);

        // Reload the FIRST client. It still has the pin in ITS OWN
        // localStorage cache from before the remote unpin, and this reload
        // makes no edit of its own -- the only way it can end up unpinned is
        // if `loadPrefs()` adopted the server's unpin instead of resurrecting
        // its own stale cached copy of the pin.
        await gotoSettled(page, origin);
        await page.waitForSelector('[data-session]', { timeout: 20000 });
        const pinnedOnFirstAfterReload = await until(async () => {
          const on = await page.evaluate(
            (key) => document.querySelector(`[data-star="${CSS.escape(key)}"]`)?.classList.contains('on'),
            firstSessionKey,
          );
          return on === false ? true : null;
        }, 'the first client to adopt the remote unpin instead of resurrecting its own stale cache', 10000);
        assert.strictEqual(pinnedOnFirstAfterReload, true,
          'a remote unpin made on a second client was resurrected by the first client\u2019s own stale local cache');
      } finally {
        await pageD.close();
      }
    });

    await check('a rename made on one client is still there after a reload, and for a second client (#170)', async () => {
      const newName = `Renamed by e2e ${Date.now()}`;
      await gotoSettled(page, origin);
      await page.waitForSelector(`[data-more="${firstSessionKey}"]`, { timeout: 20000 });
      page.once('dialog', (dialog) => dialog.accept(newName));
      await page.click(`[data-more="${firstSessionKey}"]`);
      await page.waitForSelector('#rowMenu:not([hidden])', { timeout: 5000 });
      await page.click('#rowMenu [data-row-action="rename"]');
      await until(async () => {
        const t = await page.evaluate(
          (key) => document.querySelector(`[data-session="${CSS.escape(key)}"] .row-title b`)?.textContent || '',
          firstSessionKey,
        );
        return t === newName ? true : null;
      }, 'the renamed row to show the new name');

      // Reload the SAME client: a rename that only lived in an in-memory
      // object would vanish here even though localStorage still had it, so
      // this also proves `saveNames()` actually ran.
      await gotoSettled(page, origin);
      await page.waitForSelector('[data-session]', { timeout: 20000 });
      const afterReload = await page.evaluate(
        (key) => document.querySelector(`[data-session="${CSS.escape(key)}"] .row-title b`)?.textContent || '',
        firstSessionKey,
      );
      assert.strictEqual(afterReload, newName, 'the rename did not survive a reload of the same client');

      // And a brand-new client, signed in as the same person, by the same
      // /api/prefs path the pin-sync check above just proved.
      const clientCToken = auth.mintDevToken('t1', 'u1', 'test person, third client');
      const pageC = await browser.newPage();
      try {
        await gotoSettled(pageC, `${origin}/?token=${clientCToken}`);
        await pageC.waitForSelector('[data-session]', { timeout: 20000 });
        const onC = await pageC.evaluate(
          (key) => document.querySelector(`[data-session="${CSS.escape(key)}"] .row-title b`)?.textContent || '',
          firstSessionKey,
        );
        assert.strictEqual(onC, newName, 'a rename made on one client never reached a second client signed in as the same person');
      } finally {
        await pageC.close();
      }
    });

    // -------------------------------------------------------------------
    // Scout's cache-versus-edits review of 476d2d1, name side: a plain
    // object spread of "this client's local cache" on top of "the server's
    // names" can only ever ADD or overwrite a key -- it has no way to
    // represent a remote CLEAR. A second client clears the rename; the
    // FIRST client -- which still has the old name cached locally from
    // BEFORE that remote clear, and makes no edit of its own -- must adopt
    // the clear on its next load, not resurrect the old name from its own
    // stale cache.
    // -------------------------------------------------------------------
    await check('a name CLEARED on a second client reaches a first client that still has it cached locally, instead of being resurrected by that stale cache (PR #236 cache-vs-edits review)', async () => {
      const staleName = `Stale cached name ${Date.now()}`;
      const clientEToken = auth.mintDevToken('t1', 'u1', 'test person, fifth client');
      const pageE = await browser.newPage();
      try {
        // Rename it on the first client and let the write settle, so both
        // the server AND this client's own localStorage cache have it.
        await gotoSettled(page, origin);
        await page.waitForSelector(`[data-more="${firstSessionKey}"]`, { timeout: 20000 });
        page.once('dialog', (dialog) => dialog.accept(staleName));
        await page.click(`[data-more="${firstSessionKey}"]`);
        await page.waitForSelector('#rowMenu:not([hidden])', { timeout: 5000 });
        await page.click('#rowMenu [data-row-action="rename"]');
        await until(async () => {
          const t = await page.evaluate(
            (key) => document.querySelector(`[data-session="${CSS.escape(key)}"] .row-title b`)?.textContent || '',
            firstSessionKey,
          );
          return t === staleName ? true : null;
        }, 'the renamed row to show the new name');
        await page.waitForTimeout(1200);
        const cachedNames = await page.evaluate(
          () => JSON.parse(localStorage.getItem('squad-hub-names') || '{}'),
        );
        assert.strictEqual(cachedNames[firstSessionKey], staleName,
          'precondition: the first client\u2019s own local cache must have the rename before the remote clear below');

        // A second client, signed in as the same person, clears it.
        await gotoSettled(pageE, `${origin}/?token=${clientEToken}`);
        await pageE.waitForSelector(`[data-more="${firstSessionKey}"]`, { timeout: 20000 });
        const onEBefore = await pageE.evaluate(
          (key) => document.querySelector(`[data-session="${CSS.escape(key)}"] .row-title b`)?.textContent || '',
          firstSessionKey,
        );
        assert.strictEqual(onEBefore, staleName, 'precondition: the fifth client must see the rename the first client just set');
        pageE.once('dialog', (dialog) => dialog.accept('')); // the remote clear: an empty rename puts the prompt back
        await pageE.click(`[data-more="${firstSessionKey}"]`);
        await pageE.waitForSelector('#rowMenu:not([hidden])', { timeout: 5000 });
        await pageE.click('#rowMenu [data-row-action="rename"]');
        await until(async () => {
          const t = await pageE.evaluate(
            (key) => document.querySelector(`[data-session="${CSS.escape(key)}"] .row-title b`)?.textContent || '',
            firstSessionKey,
          );
          return t !== staleName ? true : null;
        }, 'the fifth client\u2019s row to stop showing the cleared name');
        await pageE.waitForTimeout(1200);

        // Reload the FIRST client. It still has the rename in ITS OWN
        // localStorage cache from before the remote clear, and this reload
        // makes no edit of its own -- the only way its cache can end up
        // without the stale name is if `loadPrefs()` adopted the server's
        // clear instead of resurrecting its own stale cached copy of it.
        await gotoSettled(page, origin);
        await page.waitForSelector('[data-session]', { timeout: 20000 });
        const clearedOnFirstAfterReload = await until(async () => {
          const t = await page.evaluate(
            (key) => document.querySelector(`[data-session="${CSS.escape(key)}"] .row-title b`)?.textContent || '',
            firstSessionKey,
          );
          return t !== staleName ? true : null;
        }, 'the first client to adopt the remote clear instead of resurrecting its own stale cached name', 10000);
        assert.ok(clearedOnFirstAfterReload,
          'a remote name CLEAR made on a second client was resurrected by the first client\u2019s own stale local cache');
        const cachedNamesAfter = await page.evaluate(
          () => JSON.parse(localStorage.getItem('squad-hub-names') || '{}'),
        );
        assert.ok(!(firstSessionKey in cachedNamesAfter),
          'the first client\u2019s own localStorage cache must drop the cleared name, not keep re-saving the stale value');
      } finally {
        await pageE.close();
      }
    });

    await check('the row ⋯ menu is fully keyboard-operable: Enter opens it, arrows move focus, Esc closes it (#170)', async () => {
      await gotoSettled(page, origin);
      await page.waitForSelector(`[data-more="${firstSessionKey}"]`, { timeout: 20000 });

      // Reach the ⋯ button and activate it with the keyboard, not a click --
      // a native <button> already answers Enter/Space, but that is exactly
      // the assumption worth proving against the REAL handler rather than
      // taking the browser's word for it.
      await page.focus(`[data-more="${firstSessionKey}"]`);
      await page.keyboard.press('Enter');
      await page.waitForSelector('#rowMenu:not([hidden])', { timeout: 5000 });

      const firstFocused = await page.evaluate(() => document.activeElement?.dataset?.rowAction || null);
      assert.ok(firstFocused, 'opening the menu with Enter did not move focus onto one of its own items');

      // ArrowDown/ArrowUp cycle focus among the menu's own enabled buttons
      // (moveRowMenuFocus in wiring.js) -- never leaving the menu, never
      // landing on a disabled item.
      await page.keyboard.press('ArrowDown');
      const secondFocused = await page.evaluate(() => document.activeElement?.dataset?.rowAction || null);
      assert.ok(secondFocused, 'ArrowDown did not keep focus on a row-menu item');
      assert.notStrictEqual(secondFocused, firstFocused, 'ArrowDown did not move focus to the next item');

      await page.keyboard.press('ArrowUp');
      const backToFirst = await page.evaluate(() => document.activeElement?.dataset?.rowAction || null);
      assert.strictEqual(backToFirst, firstFocused, 'ArrowUp did not move focus back to the previous item');

      // Esc closes it -- the same global handler that closes every other
      // popup -- and must not also reopen the session detail underneath.
      await page.keyboard.press('Escape');
      const afterEsc = await page.evaluate((key) => ({
        hidden: document.getElementById('rowMenu').hidden,
        focusReturned: document.activeElement?.dataset?.more === key,
      }), firstSessionKey);
      const hiddenAfterEsc = afterEsc.hidden;
      assert.strictEqual(hiddenAfterEsc, true, 'Escape did not close the row menu');
      assert.strictEqual(afterEsc.focusReturned, true, 'Escape did not return focus to the row ⋯ button that opened the menu');
      const detailHiddenAfterEsc = await page.evaluate(() => document.getElementById('detailScrim').hidden);
      assert.strictEqual(detailHiddenAfterEsc, true, 'closing the row menu with Esc also opened the session detail');
    });

    await check('the detail header rename pencil updates the header, the detail sidebar and the list row through one shared rename path (#181 part 2)', async () => {
      const newName = `Header rename ${Date.now()}`;
      try {
        await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
        await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
        page.once('dialog', (dialog) => dialog.accept(newName));
        await page.click('#dtRename');
        await until(async () => {
          const t = await page.textContent('#dtTitle');
          return String(t || '').trim() === newName ? true : null;
        }, 'the detail header title to show the new name');

        await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
        await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
        const sidebarTitle = await until(async () => {
          const t = await page.evaluate(
            (key) => document.querySelector(`#detailSidebarList [data-session="${CSS.escape(key)}"] .dt-side-title`)?.textContent || '',
            firstSessionKey,
          );
          return t === newName ? true : null;
        }, 'the detail sidebar row to show the renamed title');
        assert.strictEqual(sidebarTitle, true, 'the detail sidebar did not pick up the renamed title');

        await page.click('#dtBack');
        await page.waitForSelector('#detailScrim[hidden]', { state: 'attached', timeout: 10000 });
        const rowTitle = await until(async () => {
          const t = await page.evaluate(
            (key) => document.querySelector(`[data-session="${CSS.escape(key)}"] .row-title b`)?.textContent || '',
            firstSessionKey,
          );
          return t === newName ? true : null;
        }, 'the list row to keep the same renamed title');
        assert.strictEqual(rowTitle, true, 'the list row did not agree with the header rename');
      } finally {
        await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
        await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
        page.once('dialog', (dialog) => dialog.accept(''));
        await page.click('#dtRename');
        await until(async () => {
          const t = await page.textContent('#dtTitle');
          return String(t || '').trim() !== newName ? true : null;
        }, 'the detail header rename cleanup to restore the raw title');
      }
    });

    await check('the detail header ⋯ opens the shared row menu, not a second popup, and only adds Sync session conditionally (#181 part 2)', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      await until(async () => {
        const label = await page.textContent('#dtControlLabel');
        return label && label !== 'Checking control…' ? label.trim() : null;
      }, 'the detail control check to settle before reading the header menu');
      await page.click('#dtMoreBtn');
      await page.waitForSelector('#rowMenu:not([hidden])', { timeout: 5000 });
      const menuState = await page.evaluate(() => ({
        dtMenuExists: document.getElementById('dtMenu') !== null,
        actions: [...document.querySelectorAll('#rowMenu [data-row-action]')].map((b) => b.dataset.rowAction),
        detailOpen: !document.getElementById('detailScrim').hidden,
      }));
      assert.strictEqual(menuState.dtMenuExists, false, 'the old abbreviated #dtMenu still exists in the DOM');
      for (const action of ['pin', 'rename', 'copylink']) {
        assert.ok(menuState.actions.includes(action), `the shared row menu is missing its "${action}" action in the detail header`);
      }
      assert.ok(!menuState.actions.includes('sync'),
        'Sync session should be absent once the detail page is already synced and controllable');
      await page.keyboard.press('Escape');
      const afterEsc = await page.evaluate(() => ({
        rowMenuHidden: document.getElementById('rowMenu').hidden,
        detailOpen: !document.getElementById('detailScrim').hidden,
        focusReturned: document.activeElement?.id === 'dtMoreBtn',
      }));
      assert.strictEqual(afterEsc.rowMenuHidden, true, 'Escape did not close the shared row menu from the detail header');
      assert.strictEqual(afterEsc.detailOpen, true, 'Escape closed the detail page instead of just the header menu');
      assert.strictEqual(afterEsc.focusReturned, true, 'Escape did not return focus to the detail header ⋯ button');
    });

    await check('a live-snapshot refresh arriving mid-verification does not leave "Checking control…" stuck forever (#243 Scout review fix for 53e6a18)', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      await until(async () => {
        const label = await page.textContent('#dtControlLabel');
        return label && label !== 'Checking control…' ? label.trim() : null;
      }, 'the initial detail control check to settle');

      // Hold the NEXT control-check request open so this test controls
      // exactly when it answers -- the real regression needed a
      // heartbeat/refresh to land while the request was still in flight,
      // which real network timing cannot reproduce deterministically.
      let release;
      const held = new Promise((r) => { release = r; });
      let intercepted = false;
      await page.route('**/control-check', async (route) => {
        intercepted = true;
        await held;
        await route.continue();
      });

      try {
        // Reopen the SAME session -- back to the list, then the same row --
        // to start a fresh `verifyControl`, the exact navigation a person
        // closing and reopening a session performs.
        await page.click('#dtBack');
        await page.waitForSelector('#detailScrim[hidden]', { state: 'attached', timeout: 10000 });
        await page.evaluate((key) => {
          document.querySelector(`[data-session="${CSS.escape(key)}"]`).click();
        }, firstSessionKey);
        await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
        await until(async () => ((await page.textContent('#dtControlLabel')) === 'Checking control…' ? true : null),
          'the reopened session to start a fresh control check');

        // The exact regression: `syncDetailHeader` reassigns
        // `state.currentSession` to a NEW wrapper for the SAME device/session
        // on every refresh, even while this request is still in flight.
        // Force two of those, same as a couple of heartbeats landing
        // mid-check, through the real `/api/overview` endpoint -- only
        // `control-check` above is intercepted.
        await page.evaluate(() => window.__squadHubTest.refresh());
        await page.evaluate(() => window.__squadHubTest.refresh());

        assert.ok(intercepted, 'the reopened session never issued a control-check request to intercept');
        release();

        const settled = await until(async () => {
          const label = await page.textContent('#dtControlLabel');
          return label && label !== 'Checking control…' ? label.trim() : null;
        }, 'the detail control check to settle after a live-snapshot refresh landed mid-flight', 8000);
        assert.notStrictEqual(settled, "Control couldn't be verified",
          'the check only "settled" because the 8s timeout fired -- the race silently discarded the real answer instead of applying it');
      } finally {
        await page.unroute('**/control-check').catch(() => {});
      }
    });

    await check('Sync session guards one in-flight resync per target; a reopened menu shows it disabled until it resolves, with no extra request (#243 Scout review fix for 53e6a18)', async () => {
      // Forced to Not-synced regardless of the real daemon's actual answer --
      // isolates the FRONTEND resync guard under test from real daemon/agent
      // lifecycle, which control-verification-unit.js already covers.
      await page.route('**/control-check', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ controllable: false, reason: 'the agent process is gone' }),
      }));
      let resyncCalls = 0;
      let releaseResync;
      const resyncHeld = new Promise((r) => { releaseResync = r; });
      await page.route('**/resync', async (route) => {
        resyncCalls += 1;
        await resyncHeld;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: firstSessionKey, pid: 1, cwd: '/', resyncCount: resyncCalls }),
        });
      });

      try {
        await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
        await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
        await until(async () => ((await page.textContent('#dtControlLabel')) === 'Not synced' ? true : null),
          'the forced Not-synced control state to render');

        await page.click('#dtMoreBtn');
        await page.waitForSelector('#rowMenu:not([hidden])', { timeout: 5000 });
        const firstOpen = await page.evaluate(() => {
          const b = document.querySelector('#rowMenu [data-row-action="sync"]');
          return b ? { present: true, disabled: b.disabled, label: b.textContent.trim() } : { present: false };
        });
        assert.ok(firstOpen.present, 'Sync session is not offered for a Not-synced, reachable device');
        assert.strictEqual(firstOpen.disabled, false, 'Sync session should not start disabled');

        await page.click('#rowMenu [data-row-action="sync"]');
        await page.waitForSelector('#rowMenu[hidden]', { state: 'attached', timeout: 5000 });

        // Reopen the menu WHILE the resync is still held open -- the exact
        // regression: the old dedicated #dtSync button disabled ITSELF here;
        // the shared menu item has to too, or a second click restarts the
        // same agent.
        await page.click('#dtMoreBtn');
        await page.waitForSelector('#rowMenu:not([hidden])', { timeout: 5000 });
        const reopened = await until(async () => {
          const s = await page.evaluate(() => {
            const b = document.querySelector('#rowMenu [data-row-action="sync"]');
            return b ? { disabled: b.disabled, label: b.textContent.trim() } : null;
          });
          return s && s.disabled ? s : null;
        }, 'the reopened menu to show Sync session disabled while a resync is pending');
        assert.ok(reopened.label.includes('Syncing'), `the pending label does not say so: ${reopened.label}`);

        // A click on a genuinely disabled button is a no-op in a real
        // browser, proving the guard end-to-end rather than just reading
        // the attribute.
        await page.click('#rowMenu [data-row-action="sync"]', { force: true }).catch(() => {});
        assert.strictEqual(resyncCalls, 1, 'reopening the menu mid-resync issued a SECOND resync request to the device');

        await page.keyboard.press('Escape');
        const afterEsc = await page.evaluate(() => document.activeElement?.id === 'dtMoreBtn');
        assert.strictEqual(afterEsc, true, 'Escape did not return focus to the detail header ⋯ button while Sync was pending');

        releaseResync();
        await until(async () => {
          const label = await page.textContent('#dtControlLabel');
          return label && label !== 'Checking control…' ? label.trim() : null;
        }, 'the re-verification after the resync settled to finish');

        assert.strictEqual(resyncCalls, 1, 'more than one resync request reached the device for one target');

        // Success recovery: the guard cleared, so a later, genuine click is
        // offered again rather than being stuck disabled forever.
        await page.click('#dtMoreBtn');
        await page.waitForSelector('#rowMenu:not([hidden])', { timeout: 5000 });
        const afterSettle = await page.evaluate(() => {
          const b = document.querySelector('#rowMenu [data-row-action="sync"]');
          return b ? { disabled: b.disabled, label: b.textContent.trim() } : { present: false };
        });
        assert.strictEqual(afterSettle.disabled, false,
          'Sync session is still disabled after its resync settled -- the in-flight guard was never cleared');
        await page.keyboard.press('Escape');
      } finally {
        await page.unroute('**/resync').catch(() => {});
        await page.unroute('**/control-check').catch(() => {});
      }
    });

    await check('a real browser Back/Forward away from a session with its shared Sync menu open closes the stale menu, with no outside click and no resync for the wrong target (#243 Scout review of ab5ef90, PR comment 6091670737)', async () => {
      // Forced Not-synced for BOTH sessions this test visits, same reasoning
      // as the in-flight-guard check above: isolates the frontend stale-menu
      // guard from the real daemon/agent lifecycle.
      await page.route('**/control-check', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ controllable: false, reason: 'forced not-synced for this fixture' }),
      }));
      const resyncCalls = [];
      await page.route('**/resync', async (route) => {
        const body = route.request().postDataJSON();
        resyncCalls.push({
          path: new URL(route.request().url()).pathname,
          sessionId: body && body.sessionId,
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: body && body.sessionId, pid: 1, cwd: '/' }),
        });
      });

      try {
        // Build a REAL two-entry history stack by navigating entirely
        // through in-app clicks -- list -> A -> B -- so the Back/Forward
        // below are genuine browser session-history traversals, not a
        // synthetic `history.pushState` the test fabricated itself.
        await gotoSettled(page, origin);
        await page.waitForSelector('[data-session]', { timeout: 20000 });
        const keyA = await page.getAttribute('[data-session]', 'data-session');
        await page.click(`[data-session="${keyA}"]`);
        await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
        await until(async () => ((await page.textContent('#dtControlLabel')) === 'Not synced' ? true : null),
          'the forced Not-synced control state to render for A');

        const keyB = await page.evaluate((openKey) => {
          const rows = [...document.querySelectorAll('#detailSidebarList [data-session]')];
          const other = rows.find((r) => r.dataset.session !== openKey);
          return other && other.dataset.session;
        }, keyA);
        assert.ok(keyB, 'there is no second session to navigate to for this fixture');
        const sessionB = svc.store.getSession(subjectKey('t1', 'u1'), keyB);
        assert.ok(sessionB && sessionB.id, 'session B has no device-local session id');

        await page.click(`#detailSidebarList [data-session="${keyB}"]`);
        await until(async () => page.url().includes(`session=${encodeURIComponent(keyB)}`),
          'the URL to switch to session B via the sidebar');
        await until(async () => ((await page.textContent('#dtControlLabel')) === 'Not synced' ? true : null),
          'the forced Not-synced control state to render for B');

        // Real Back: B -> A. Still no outside click, no menu open yet.
        await page.goBack();
        await until(async () => page.url().includes(`session=${encodeURIComponent(keyA)}`),
          'Back to land on session A');

        // Open A's shared row menu (Sync offered) -- the exact state a
        // stale menu was left in across a popstate before this fix.
        await page.click('#dtMoreBtn');
        await page.waitForSelector('#rowMenu:not([hidden])', { timeout: 5000 });
        const offeredOnA = await page.evaluate(() => {
          const b = document.querySelector('#rowMenu [data-row-action="sync"]');
          return b ? { present: true, disabled: b.disabled } : { present: false };
        });
        assert.ok(offeredOnA.present, 'Sync session is not offered for A (Not-synced, reachable)');
        assert.strictEqual(offeredOnA.disabled, false, 'Sync session should not start disabled');

        // Real Forward: A -> B, menu still open, driven by the browser's
        // OWN history stack -- no click anywhere in the document, so any
        // close has to come from the popstate listener itself, not an
        // outside-click handler standing in for it.
        await page.goForward();
        await until(async () => page.url().includes(`session=${encodeURIComponent(keyB)}`),
          'Forward to land on session B');

        const afterNav = await page.evaluate(() => document.getElementById('rowMenu').hidden);
        assert.strictEqual(afterNav, true,
          'the shared row menu was still visible after a real Back/Forward navigation away from the session it was opened for');
        assert.deepStrictEqual(resyncCalls, [],
          'no Sync click was simulated, yet a resync request reached the device during the navigation itself');

        // Fresh positive: a genuine Sync click on B, the session actually
        // open now, still reaches the device exactly once.
        await page.click('#dtMoreBtn');
        await page.waitForSelector('#rowMenu:not([hidden])', { timeout: 5000 });
        await page.click('#rowMenu [data-row-action="sync"]');
        await until(async () => resyncCalls.length > 0 || null, 'the fresh Sync click on B to reach the device');
        assert.deepStrictEqual(resyncCalls, [{
          path: `/api/devices/${encodeURIComponent(sessionB.deviceId)}/resync`,
          sessionId: sessionB.id,
        }],
          'a fresh Sync click on the session actually open (B) did not reach the device exactly once, for the right target');
      } finally {
        await page.unroute('**/resync').catch(() => {});
        await page.unroute('**/control-check').catch(() => {});
      }
    });

    await check('the header items share one vertical line box at 1280, 900 and 390px', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      for (const width of [1280, 900, 390]) {
        await page.setViewportSize({ width, height: 900 });
        // A resize does not fire layout synchronously in every engine; give
        // it one frame before measuring.
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
        const centers = await page.evaluate((w) => {
          const ids = w <= 900
            ? ['dtBackPhone', 'dtStar', 'dtTitle', 'dtRename', 'dtStatusPill']
            : ['dtStar', 'dtTitle', 'dtRename', 'dtStatusPill', 'dtAca'];
          return ids.map((id) => {
            const el = document.getElementById(id);
            if (!el || el.offsetParent === null) return null;
            const r = el.getBoundingClientRect();
            return r.top + r.height / 2;
          }).filter((v) => v !== null);
        }, width);
        assert.ok(centers.length >= 2, `at ${width}px, fewer than 2 header items were visible to compare`);
        const spread = Math.max(...centers) - Math.min(...centers);
        assert.ok(spread <= 1,
          `at ${width}px, the header items do not share a line box -- vertical centers span ${spread}px`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    // #243: `offsetParent !== null` only proves an element is laid out, not
    // that it is readable or reachable -- an element can be squeezed to zero
    // width, wrapped onto three lines, or pushed past the right edge of the
    // viewport and still have a non-null offsetParent. This reads the actual
    // rendered geometry instead, which is what caught the real regression
    // (the title unreadable, "Run on ACA…" wrapping onto 3 lines inside its
    // 32px button, and Stop/⋯ pushed off the right edge) that the offsetParent
    // checks above and in the capture test below did not.
    await check('at 390px, the detail header title and right-side actions stay inside the viewport, unclipped and on one line (#243)', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      const bounds = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const rectOf = (id) => {
          const el = document.getElementById(id);
          if (!el || el.offsetParent === null) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width, height: r.height };
        };
        return {
          vw,
          title: rectOf('dtTitle'),
          aca: rectOf('dtAca'),
          stop: rectOf('dtStop'),
          more: rectOf('dtMoreBtn'),
        };
      });
      assert.ok(bounds.title && bounds.title.width > 0,
        'the detail title has no rendered width at 390px -- it is not actually readable');
      assert.ok(bounds.title.right <= bounds.vw + 0.5,
        `the detail title overflows the 390px viewport (right=${bounds.title.right}, viewport=${bounds.vw})`);
      for (const [label, rect] of [
        ['Run on ACA…', bounds.aca],
        ['Stop', bounds.stop],
        ['the ⋯ (More actions) button', bounds.more],
      ]) {
        assert.ok(rect, `${label} is not visible at 390px`);
        assert.ok(rect.left >= -0.5 && rect.right <= bounds.vw + 0.5,
          `${label} is clipped or sits outside the 390px viewport (left=${rect.left}, right=${rect.right}, viewport=${bounds.vw})`);
        assert.ok(rect.height <= 34,
          `${label}'s label wrapped onto more than one line at 390px (height=${rect.height}px, expected a single ~32px line)`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await check('the detail header menu survives overview refresh with focus intact, and Open does not duplicate history', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      await page.click('#dtMoreBtn');
      await page.waitForSelector('#rowMenu:not([hidden])');
      await page.focus('#rowMenu [data-row-action="copylink"]');
      await page.evaluate(() => {
        window.__detailMenuButton = document.querySelector('#rowMenu [data-row-action="copylink"]');
      });
      await page.evaluate(() => window.__squadHubTest.refresh());
      assert.deepStrictEqual(await page.evaluate(() => ({
        open: !document.getElementById('rowMenu').hidden,
        focused: document.activeElement.dataset.rowAction,
      })), { open: true, focused: 'copylink' });
      assert.strictEqual(await page.evaluate(() => (
        window.__detailMenuButton === document.querySelector('#rowMenu [data-row-action="copylink"]')
      )), true, 'an unchanged heartbeat replaced the menu button DOM node');
      const before = await page.evaluate(() => history.length);
      await page.click('#rowMenu [data-row-action="open"]');
      assert.strictEqual(await page.evaluate(() => history.length), before,
        'Open on the current session added a duplicate history entry');
    });

    await check('removing the open ended session returns to the list without stale detail controls', async () => {
      const started = await daemon.handle({ op: 'start-session', prompt: 'disposable detail removal', cwd: process.cwd() });
      await daemon.handle({ op: 'stop-session', sessionId: started.id });
      await page.evaluate(() => window.__squadHubTest.refresh());
      const key = `e2e-device:${started.id}`;
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(key)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      await page.click('#dtMoreBtn');
      page.once('dialog', (dialog) => dialog.accept());
      await page.click('#rowMenu [data-row-action="remove"]');
      await until(async () => page.evaluate(() => (
        document.getElementById('detailScrim').hidden
        && window.__squadHubTest.state.currentSession === null
        && !new URL(location.href).searchParams.has('session')
      )), 'removing the current session to close and clear its detail page');
      assert.strictEqual(daemon.sessions.has(started.id), false,
        'the ended session was not actually removed from the device');
    });

    await check('an open detail session survives leaving the active list filter', async () => {
      const started = await daemon.handle({ op: 'start-session', prompt: 'filtered detail transition', cwd: process.cwd() });
      const key = `e2e-device:${started.id}`;
      await page.evaluate(() => window.__squadHubTest.refresh());
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(key)}`);
      await page.waitForSelector('#detailScrim:not([hidden])');
      try {
        await page.fill('#dtInput', 'Preserve this unsent follow-up');
        await page.evaluate(() => { window.__squadHubTest.state.filters.status = 'active'; });
        await daemon.handle({ op: 'stop-session', sessionId: started.id });
        await page.evaluate(() => window.__squadHubTest.refresh());
        assert.strictEqual(await page.evaluate((expected) => (
          !document.getElementById('detailScrim').hidden
          && window.__squadHubTest.state.currentSession.session.key === expected
          && document.getElementById('dtInput').value === 'Preserve this unsent follow-up'
        ), key), true, 'a stopped session was mistaken for a removed session when the active filter excluded it');
      } finally {
        await page.evaluate(() => { window.__squadHubTest.state.filters.status = ''; });
        await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      }
    });

    // #243 real regression (CI run 37998832767): the two checks above proved
    // the RIGHT-side actions stay on-screen and on one line, but neither one
    // actually measured the FIRST row (back/star/title/pencil/pill) itself --
    // the root cause was `flex-wrap` applied to the whole `.detail-head-line`,
    // which let the first row's own items (not just the actions) spill onto a
    // second line while the header kept a fixed 32px height. This measures
    // every first-row control's own rendered geometry at 390px, the same way
    // the actions were already checked: inside the viewport, unclipped, and a
    // single ~32px line each -- which a height-only check on the header
    // container cannot tell apart from "32px tall but two of these items are
    // on a wrapped second line that overflows it".
    await check('at 390px, every first-row header control (back/star/title/pencil/pill) stays inside the viewport, unclipped and on one line', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      const bounds = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const rectOf = (id) => {
          const el = document.getElementById(id);
          if (!el || el.offsetParent === null) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width, height: r.height };
        };
        return {
          vw,
          back: rectOf('dtBackPhone'),
          star: rectOf('dtStar'),
          title: rectOf('dtTitle'),
          rename: rectOf('dtRename'),
          pill: rectOf('dtStatusPill'),
        };
      });
      for (const [label, rect] of [
        ['the back arrow', bounds.back],
        ['the pin star', bounds.star],
        ['the title', bounds.title],
        ['the rename pencil', bounds.rename],
        ['the status pill', bounds.pill],
      ]) {
        assert.ok(rect, `${label} is not visible at 390px`);
        assert.ok(rect.width > 0, `${label} has no rendered width at 390px`);
        assert.ok(rect.left >= -0.5 && rect.right <= bounds.vw + 0.5,
          `${label} is clipped or sits outside the 390px viewport (left=${rect.left}, right=${rect.right}, viewport=${bounds.vw})`);
        assert.ok(rect.height <= 34,
          `${label} wrapped onto more than one line at 390px (height=${rect.height}px, expected a single ~32px line)`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    // #243 real regression: the old fix pinned `.detail-head-line` to a fixed
    // 32px line box and relied on `flex-wrap` to push overflow onto a SECOND
    // line that the fixed-height box never actually grew to accommodate --
    // the row-height check above (`rect.height <= 34`) cannot catch this,
    // because it only measures a single BUTTON's own box, not whether that
    // button's row collided with unrelated content underneath it.
    //
    // This measures every CONTROL's own rendered rectangle (not the shared
    // `.detail-head-line` container's rect) against the metadata line below
    // it. Measuring the container itself is a false-safe check: a container
    // with a fixed `height` (the old, broken design, or a regression back to
    // it) always reports its own `bottom` at exactly that fixed height, which
    // trivially stays above the metadata line even while its own children
    // overflow past it -- `overflow` only clips what is PAINTED, it never
    // moves the overflowing children's own boxes, so measuring the controls
    // themselves is what actually catches the collision. Checked at every
    // width the header's row count changes (two rows at 390px/900px, one row
    // at 1280px).
    await check('at 390px, the detail header controls do not spatially overlap the metadata line underneath them', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      for (const width of [1280, 900, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
        const result = await page.evaluate(() => {
          const ids = ['dtBackPhone', 'dtStar', 'dtTitle', 'dtRename', 'dtStatusPill', 'dtAca', 'dtForget', 'dtStop', 'dtMoreBtn'];
          const bottoms = ids.map((id) => {
            const el = document.getElementById(id);
            if (!el || el.offsetParent === null) return null;
            return el.getBoundingClientRect().bottom;
          }).filter((v) => v !== null);
          const meta = document.getElementById('dtMeta');
          return {
            maxControlBottom: bottoms.length ? Math.max(...bottoms) : null,
            metaTop: meta ? meta.getBoundingClientRect().top : null,
          };
        });
        assert.ok(result.maxControlBottom !== null, `at ${width}px, no header control was visible to measure`);
        assert.ok(result.metaTop !== null, `at ${width}px, the metadata line could not be measured`);
        assert.ok(result.maxControlBottom <= result.metaTop + 0.5,
          `at ${width}px, a header control (bottom=${result.maxControlBottom}) overlaps the metadata line underneath it (top=${result.metaTop})`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await check('at 390px, unreachable-session cleanup actions remain in bounds without overlapping metadata', async () => {
      const subject = subjectKey('t1', 'u1');
      const deviceId = 'phone-stale-fixture';
      const device = svc.store.registerDevice(subject, { deviceId, name: 'Stale phone fixture', platform: 'linux' });
      svc.store.upsertSession(subject, deviceId, {
        id: 'stale-session', status: 'idle', prompt: 'Unreachable cleanup fixture', repo: 'acme/widgets',
      });
      device.lastSeen = Date.now() - svc.store.staleAfterMs - 1000;
      const key = `${deviceId}:stale-session`;
      try {
        await gotoSettled(page, `${origin}/?session=${encodeURIComponent(key)}`);
        await page.waitForSelector('#detailScrim:not([hidden])');
        await page.waitForSelector('#dtForget:not([hidden])');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        const geometry = await page.evaluate(() => {
          const ids = ['dtAca', 'dtForget', 'dtStop', 'dtMoreBtn'];
          return {
            width: document.documentElement.clientWidth,
            metaTop: document.getElementById('dtMeta').getBoundingClientRect().top,
            controls: ids.map((id) => {
              const rect = document.getElementById(id).getBoundingClientRect();
              return { id, left: rect.left, right: rect.right, bottom: rect.bottom, height: rect.height };
            }),
          };
        });
        for (const rect of geometry.controls) {
          assert.ok(rect.left >= -0.5 && rect.right <= geometry.width + 0.5,
            `${rect.id} is clipped on the unreachable session at 390px`);
          assert.ok(rect.height <= 34 && rect.bottom <= geometry.metaTop + 0.5,
            `${rect.id} wraps its label or overlaps metadata`);
        }
      } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
        await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      }
    });

    // #182/#243: the integrated session header, measured the way a person sees
    // it, at all three widths and in BOTH colour schemes: every control inside
    // the viewport and not pushing the page sideways, no label wrapped or cut,
    // nothing overlapping a neighbour or the summary line, one shared centre
    // line for the title row (and for the whole header at 1280px), and the More
    // menu opening inside the page. `actions` are the buttons this fixture must
    // show, so a control that quietly disappeared cannot pass as "fits".
    const headerFit182 = async (what, actions, shot) => {
      const ids = ['dtBackPhone', 'dtStar', 'dtTitle', 'dtRename', 'dtStatusPill', 'dtAca', 'dtForget', 'dtStop', 'dtMoreBtn'];
      const titleRow = ['dtBackPhone', 'dtStar', 'dtTitle', 'dtRename', 'dtStatusPill'];
      try {
        for (const scheme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme: scheme });
          for (const width of [1280, 900, 390]) {
            const at = `${what} at ${width}px in the ${scheme} theme`;
            await page.setViewportSize({ width, height: 844 });
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
            const m = await page.evaluate((list) => {
              const rgb = (getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number);
              const controls = [];
              for (const id of list) {
                const el = document.getElementById(id);
                if (!el || el.offsetParent === null) continue;
                const r = el.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(el);
                controls.push({
                  id, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                  cut: el.scrollWidth - el.clientWidth,
                  lines: new Set([...range.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top))).size,
                });
              }
              const bar = document.getElementById('dtTabs');
              return {
                brightness: (rgb[0] + rgb[1] + rgb[2]) / 3,
                vw: document.documentElement.clientWidth,
                scroll: document.documentElement.scrollWidth,
                metaTop: document.getElementById('dtMeta').getBoundingClientRect().top,
                controls,
                barCut: bar.scrollWidth - bar.clientWidth,
                // Vertical: a bar whose tabs reach past its own padding box is
                // scrollable overflow, whatever the browser does with scrollbars.
                barHeight: bar.offsetHeight,
                barOverflowY: bar.scrollHeight - bar.clientHeight,
                barScrollbarX: bar.offsetWidth - bar.clientWidth,
                barInnerBottom: bar.getBoundingClientRect().top + bar.clientTop + bar.clientHeight,
                tabs: [...bar.querySelectorAll('[role="tab"]')].map((t) => {
                  const r = t.getBoundingClientRect();
                  return { id: t.id, left: r.left, right: r.right, bottom: r.bottom, height: r.height };
                }),
              };
            }, ids);
            // A theme that did not apply would make the light and dark passes the same pass twice.
            assert.ok(scheme === 'light' ? m.brightness > 140 : m.brightness < 80,
              `${at}: the page is not in the ${scheme} theme (background brightness ${Math.round(m.brightness)})`);
            const by = Object.fromEntries(m.controls.map((c) => [c.id, c]));
            for (const id of [...titleRow.slice(width <= 900 ? 0 : 1), ...actions]) {
              assert.ok(by[id], `${at}: ${id} is not showing`);
            }
            assert.ok(m.scroll <= m.vw, `${at}: the page scrolls sideways (${m.scroll} > ${m.vw})`);
            for (const c of m.controls) {
              assert.ok(c.left >= -0.5 && c.right <= m.vw + 0.5,
                `${at}: ${c.id} is outside the viewport (left=${Math.round(c.left)}, right=${Math.round(c.right)}, viewport=${m.vw})`);
              assert.ok(c.bottom - c.top <= 34, `${at}: ${c.id} is ${Math.round(c.bottom - c.top)}px tall, so it wrapped`);
              assert.ok(c.bottom <= m.metaTop + 0.5, `${at}: ${c.id} overlaps the summary line (${Math.round(c.bottom)} > ${Math.round(m.metaTop)})`);
              if (['dtAca', 'dtForget', 'dtStop', 'dtStatusPill'].includes(c.id)) {
                assert.strictEqual(c.lines, 1, `${at}: the label of ${c.id} wraps onto ${c.lines} lines`);
              }
              // The status pill may end in an ellipsis on a phone; a button label may not.
              if (['dtAca', 'dtForget', 'dtStop'].includes(c.id)) {
                assert.ok(c.cut <= 1, `${at}: the label of ${c.id} is cut off by ${c.cut}px`);
              }
            }
            assert.strictEqual(m.tabs.length, 4, `${at}: the tab bar does not show Chat, Squad, Info and Files`);
            assert.ok(m.barCut <= 1, `${at}: the tab bar has to scroll sideways (${m.barCut}px)`);
            // The headless shell draws no scrollbars, so this measures the cause: content
            // taller than the bar's box makes a classic-scrollbar browser draw a vertical
            // scrollbar on it and clip the selected tab's underline.
            assert.ok(m.barOverflowY <= 0, `${at}: the tab bar's content is ${m.barOverflowY}px taller than the bar, so it overflows vertically`);
            assert.strictEqual(m.barScrollbarX, 0, `${at}: the tab bar reserves ${m.barScrollbarX}px for a scrollbar of its own`);
            assert.ok(Math.abs(m.barHeight - 40) <= 0.5, `${at}: the tab bar is ${m.barHeight}px tall, not the intended 40px`);
            for (const t of m.tabs) {
              assert.ok(t.left >= -0.5 && t.right <= m.vw + 0.5 && t.height <= 48, `${at}: the ${t.id} tab is outside the viewport or wrapped`);
              assert.ok(t.bottom <= m.barInnerBottom + 0.5, `${at}: the bar cuts the bottom of the ${t.id} tab, and with it the underline`);
            }
            assert.ok(by.dtTitle.right - by.dtTitle.left >= 60,
              `${at}: only ${Math.round(by.dtTitle.right - by.dtTitle.left)}px is left for the title`);
            for (let i = 0; i < m.controls.length; i += 1) {
              for (let j = i + 1; j < m.controls.length; j += 1) {
                const a = m.controls[i];
                const b = m.controls[j];
                const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                assert.ok(!(across > 0.5 && down > 0.5), `${at}: ${a.id} and ${b.id} overlap`);
              }
            }
            const center = (c) => (c.top + c.bottom) / 2;
            const spread = (list) => Math.max(...list.map(center)) - Math.min(...list.map(center));
            const first = m.controls.filter((c) => titleRow.includes(c.id));
            const right = m.controls.filter((c) => !titleRow.includes(c.id));
            if (width > 900) {
              assert.ok(spread(m.controls) <= 1, `${at}: the header is not one line (centres span ${spread(m.controls).toFixed(1)}px)`);
            } else {
              assert.ok(spread(first) <= 1, `${at}: the title row is not one line (centres span ${spread(first).toFixed(1)}px)`);
              assert.ok(right.every((c) => c.top >= Math.max(...first.map((f) => f.bottom)) - 0.5),
                `${at}: the actions share the title row instead of sitting under it`);
            }

            if (process.env.SQUAD_HUB_SCREENSHOT_DIR) {
              await page.screenshot({ path: path.join(process.env.SQUAD_HUB_SCREENSHOT_DIR, `detail-header-${shot}-${width}-${scheme}.png`), clip: { x: 0, y: 0, width: m.vw, height: 420 } });
            }
            await page.click('#dtMoreBtn');
            await page.waitForSelector('#rowMenu:not([hidden])', { timeout: 5000 });
            const menu = await page.evaluate(() => {
              const r = document.getElementById('rowMenu').getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, vw: document.documentElement.clientWidth };
            });
            await page.keyboard.press('Escape');
            await page.waitForSelector('#rowMenu', { state: 'hidden', timeout: 5000 });
            assert.ok(menu.left >= -0.5 && menu.right <= menu.vw + 0.5 && menu.top >= -0.5,
              `${at}: the More menu opens outside the page (left=${Math.round(menu.left)}, right=${Math.round(menu.right)}, top=${Math.round(menu.top)}, viewport=${menu.vw})`);
          }
        }
      } finally {
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    };

    await check('the session header fits Run on ACA…, Forget, Stop and More, a long title and the status pill at 1280, 900 and 390px, light and dark (#182)', async () => {
      const subject = subjectKey('t1', 'u1');
      const deviceId = 'header-fit-fixture';
      const device = svc.store.registerDevice(subject, { deviceId, name: 'Header fit fixture', platform: 'linux' });
      svc.store.upsertSession(subject, deviceId, {
        id: 'header-fit-session', status: 'idle', repo: 'acme/widgets',
        prompt: 'Header fit fixture with a long session title that has to be cut short rather than push the actions off the page',
      });
      device.lastSeen = Date.now() - svc.store.staleAfterMs - 1000;
      try {
        await gotoSettled(page, `${origin}/?session=${encodeURIComponent(`${deviceId}:header-fit-session`)}`);
        await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
        await page.waitForSelector('#dtForget:not([hidden])', { timeout: 5000 });
        await headerFit182('an unreachable session', ['dtAca', 'dtForget', 'dtStop', 'dtMoreBtn'], 'unreachable');
      } finally {
        svc.store.removeDevice(subject, deviceId);
        await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      }
    });

    // The headless shell this file drives draws no scrollbars at all, so a tab bar
    // that is secretly taller inside than outside looks fine there. This runs ONE
    // browser with classic scrollbars (what desktop Chrome and Edge on Windows and
    // Linux show), where the same defect is a real 15px scrollbar and a cut underline.
    await check('the tab bar draws no scrollbar of its own and keeps its whole underline when the browser shows classic scrollbars, at 1280, 900, 390 and 200px, light and dark (#182)', async () => {
      const subject = subjectKey('t1', 'u1');
      const deviceId = 'classic-bars-fixture';
      const device = svc.store.registerDevice(subject, { deviceId, name: 'Classic scrollbars fixture', platform: 'linux' });
      svc.store.upsertSession(subject, deviceId, { id: 'classic-bars-session', status: 'idle', repo: 'acme/widgets', prompt: 'Classic scrollbars fixture' });
      device.lastSeen = Date.now() - svc.store.staleAfterMs - 1000;
      const classic = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
      try {
        const p = await classic.newPage();
        await gotoSettled(p, `${origin}/?token=${userToken}`);
        await p.waitForSelector('#who', { timeout: 15000 });
        await gotoSettled(p, `${origin}/?session=${encodeURIComponent(`${deviceId}:classic-bars-session`)}`);
        await p.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
        await p.waitForSelector('#dtTabs', { state: 'visible', timeout: 5000 });
        // Without this the test would pass on a browser that hides scrollbars too.
        const probe = await p.evaluate(() => {
          const d = document.createElement('div');
          d.style.overflow = 'scroll';
          d.style.width = '60px';
          d.style.height = '60px';
          document.body.appendChild(d);
          const w = d.offsetWidth - d.clientWidth;
          d.remove();
          return w;
        });
        assert.ok(probe >= 8, `this browser draws no classic scrollbars (${probe}px), so the check below would prove nothing`);
        for (const scheme of ['light', 'dark']) {
          await p.emulateMedia({ colorScheme: scheme });
          for (const width of [1280, 900, 390, 200]) {
            const at = `the tab bar at ${width}px in the ${scheme} theme`;
            await p.setViewportSize({ width, height: 844 });
            await p.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
            const m = await p.evaluate(() => {
              const bar = document.getElementById('dtTabs');
              const on = bar.querySelector('.dt-tab.on');
              const last = [...bar.querySelectorAll('.dt-tab:not(:disabled)')].pop();
              last.focus();
              const barBox = bar.getBoundingClientRect();
              const onBox = on.getBoundingClientRect();
              const lastBox = last.getBoundingClientRect();
              return {
                scrollbarX: bar.offsetWidth - bar.clientWidth,
                overflowY: bar.scrollHeight - bar.clientHeight,
                sideways: bar.scrollWidth - bar.clientWidth,
                innerBottom: barBox.top + bar.clientTop + bar.clientHeight,
                underline: parseFloat(getComputedStyle(on).borderBottomWidth),
                onBottom: onBox.bottom,
                onTop: onBox.top,
                height: bar.offsetHeight,
                lastReached: lastBox.left >= barBox.left - 0.5 && lastBox.right <= barBox.right + 0.5,
              };
            });
            assert.strictEqual(m.scrollbarX, 0, `${at} reserves ${m.scrollbarX}px for a vertical scrollbar of its own`);
            assert.ok(m.overflowY <= 0, `${at} has content ${m.overflowY}px taller than its box`);
            assert.strictEqual(m.underline, 2, `${at}: the selected tab's underline is ${m.underline}px, not 2`);
            assert.ok(m.onBottom <= m.innerBottom + 0.5,
              `${at} cuts the selected tab's underline (the tab ends at ${m.onBottom}, the bar's box at ${m.innerBottom})`);
            // 200px is no real phone: it only makes the tabs overflow, to prove the bar still scrolls sideways.
            if (width === 200) {
              assert.ok(m.sideways > 0, `${at} does not scroll sideways, so the horizontal-scroll case was not exercised`);
            } else {
              assert.strictEqual(m.height, 40, `${at} is ${m.height}px tall, not 40`);
            }
            assert.ok(m.lastReached, `${at}: the last tab cannot be scrolled to when it takes focus`);
            if (process.env.SQUAD_HUB_SCREENSHOT_DIR && width !== 1280) {
              await p.screenshot({ path: path.join(process.env.SQUAD_HUB_SCREENSHOT_DIR, `detail-tabbar-classic-${width}-${scheme}.png`), clip: { x: 0, y: 0, width, height: 420 } });
            }
          }
        }
      } finally {
        await classic.close();
        svc.store.removeDevice(subject, deviceId);
      }
    });

    // ---- #182: detail tabs, the inline approval card, the Info history -------
    // Everything below runs against REAL sessions on the real device, answered
    // through the hub's real approve route. What is asserted is what the agent
    // actually did (the marker file it writes) and what the page then shows,
    // not merely that a request was sent.
    const ENV_182 = ['FAKE_AGENT_MODE', 'FAKE_AGENT_MARKER', 'FAKE_AGENT_COMMAND'];
    const live182 = {};

    // A directory name with no break opportunity in it, far wider than a phone.
    // It is what makes the Info tab's "a long path wraps instead of pushing the
    // page sideways" rule provable: a short temp path fits at every width.
    const LONG_SEGMENT_182 = `deeply-nested-checkout-${'x'.repeat(110)}-`;

    // A session whose agent is blocked on one permission request. `repo` gives
    // it a checkout as git writes it, and a Squad workspace, so the device
    // reports a repository, a branch and a team. `longPath` puts that checkout
    // under one very long directory name.
    const gated182 = async (label, command, { repo = false, longPath = false } = {}) => {
      const stem = longPath ? `e2eui-182-${label}-${LONG_SEGMENT_182}` : `e2eui-182-${label}-`;
      const work = fs.mkdtempSync(path.join(os.tmpdir(), stem));
      if (repo) {
        fs.mkdirSync(path.join(work, '.git'), { recursive: true });
        fs.writeFileSync(path.join(work, '.git', 'HEAD'), 'ref: refs/heads/feature/detail-tabs\n');
        fs.writeFileSync(path.join(work, '.git', 'config'),
          '[remote "origin"]\n\turl = https://github.com/octo/widgets.git\n');
        fs.mkdirSync(path.join(work, '.squad', 'agents', 'engineer'), { recursive: true });
        fs.writeFileSync(path.join(work, '.squad', 'team.md'),
          '# Team\n\n| Name | Role | Status |\n| --- | --- | --- |\n| engineer | engineer | active |\n');
        fs.writeFileSync(path.join(work, '.squad', 'agents', 'engineer', 'charter.md'), '# engineer\n');
        fs.writeFileSync(path.join(work, '.squad', 'decisions.md'), '# Decisions\n');
      }
      const marker = `marker-182-${label}.txt`;
      const prompt = `detail tabs ${label}`;
      const was = ENV_182.map((k) => process.env[k]);
      process.env.FAKE_AGENT_MODE = 'approve-gate';
      process.env.FAKE_AGENT_MARKER = marker;
      process.env.FAKE_AGENT_COMMAND = command;
      let started;
      try {
        started = await daemon.handle({ op: 'start-session', prompt, cwd: work });
      } finally {
        ENV_182.forEach((k, i) => { if (was[i] === undefined) delete process.env[k]; else process.env[k] = was[i]; });
      }
      const asked = await until(async () => {
        const st = await daemon.handle({ op: 'status' });
        const s = (st.sessions || []).find((x) => x.id === started.id);
        const a = s && (s.pendingApprovals || [])[0];
        return a ? { sessionId: s.id, approvalId: a.approvalId } : null;
      }, 'the agent to ask for permission');
      return { work, marker, prompt, ...asked };
    };

    // The pop-up raises itself for a request it has not shown on this page
    // load; dismiss it, then open the session the way a person would.
    const openGated182 = async (g) => {
      await gotoSettled(page, origin);
      await page.waitForSelector('#approvalScrim:not([hidden])', { timeout: 20000 });
      await page.click('#apCancel');
      await page.click(`[data-session]:has-text("${g.prompt}")`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
    };

    const tabState182 = () => page.evaluate(() => {
      const shown = (id) => { const el = document.getElementById(id); return !!el && !el.hidden && el.offsetParent !== null; };
      return {
        selected: ['chat', 'squad', 'info', 'files']
          .filter((t) => document.getElementById(`dtTab-${t}`).getAttribute('aria-selected') === 'true'),
        shown: ['chat', 'squad', 'info'].filter((t) => shown(`dtPane-${t}`)),
        focus: document.activeElement && document.activeElement.id,
      };
    });

    const historyRow182 = (outcome) => page.evaluate((o) => {
      const r = document.querySelector(`#dtInfoHistory [data-outcome="${o}"]`);
      return r ? { text: r.textContent.replace(/\s+/g, ' ').trim(), approval: r.dataset.approval } : null;
    }, outcome);

    // Evidence for the tab work: a no-op unless SQUAD_HUB_SCREENSHOT_DIR is set.
    const shoot182 = async (prefix) => {
      const outDir = process.env.SQUAD_HUB_SCREENSHOT_DIR;
      if (!outDir) return;
      assert.ok(fs.statSync(outDir).isDirectory(), `SQUAD_HUB_SCREENSHOT_DIR is not a directory: ${outDir}`);
      // A toast from the step before would sit on top of the page being captured.
      await page.waitForSelector('#toast', { state: 'hidden', timeout: 10000 });
      const shots = [
        { width: 1280, height: 900, scheme: 'dark', name: 'desktop-dark' },
        { width: 1280, height: 900, scheme: 'light', name: 'desktop-light' },
        { width: 390, height: 844, scheme: 'dark', name: 'phone-390-dark' },
        { width: 390, height: 844, scheme: 'light', name: 'phone-390-light' },
      ];
      try {
        for (const shot of shots) {
          await page.setViewportSize({ width: shot.width, height: shot.height });
          await page.emulateMedia({ colorScheme: shot.scheme });
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
          const file = path.join(outDir, `${prefix}-${shot.name}.png`);
          await page.screenshot({ path: file });
          assert.ok(fs.statSync(file).size > 0, `${prefix}-${shot.name}.png was written empty`);
        }
      } finally {
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    };

    await check('the session detail has Chat, Squad and Info tabs that each show only their own pane, and a disabled Files tab (#182)', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      await page.waitForSelector('#dtTabs', { state: 'visible', timeout: 5000 });
      assert.deepStrictEqual(
        await page.evaluate(() => [...document.querySelectorAll('#dtTabs [role="tab"]')].map((t) => t.textContent.trim())),
        ['Chat', 'Squad', 'Info', 'Files'], 'the tabs are not Chat, Squad, Info and Files, in that order');
      // Let the requests a freshly opened session makes finish, so the window
      // below measures only what the tabs themselves do.
      await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));

      const requests = [];
      const onRequest = (r) => { if (/\/api\/devices\//.test(r.url())) requests.push(r.url()); };
      page.on('request', onRequest);
      try {
        let s = await tabState182();
        assert.deepStrictEqual([s.selected, s.shown], [['chat'], ['chat']],
          'a session must open on Chat, with only the Chat pane showing');

        await page.click('#dtTab-info');
        s = await tabState182();
        assert.deepStrictEqual([s.selected, s.shown], [['info'], ['info']], 'the Info tab did not show only the Info pane');
        const keys = await page.evaluate(() => [...document.querySelectorAll('#dtInfoRows tr')].map((r) => r.dataset.info));
        for (const k of ['device', 'cwd', 'repository', 'branch', 'agent', 'model', 'mode', 'started', 'lastActivity', 'toolCalls', 'squadHealth']) {
          assert.ok(keys.includes(k), `the Info tab has no ${k} row`);
        }

        await page.click('#dtTab-squad');
        s = await tabState182();
        assert.deepStrictEqual([s.selected, s.shown], [['squad'], ['squad']], 'the Squad tab did not show only the Squad pane');
        const squad = await page.evaluate(() => ({
          panel: document.getElementById('dtSquad').offsetParent !== null,
          none: document.getElementById('dtSquadNone').offsetParent !== null,
        }));
        assert.strictEqual(squad.panel !== squad.none, true,
          'the Squad tab must show the panel or the note that no Squad workspace was reported, never both and never neither');

        // The keyboard moves between the three real tabs and wraps; it never lands on Files.
        await page.keyboard.press('ArrowRight');
        s = await tabState182();
        assert.deepStrictEqual([s.selected, s.focus], [['info'], 'dtTab-info'], 'ArrowRight did not move to Info');
        await page.keyboard.press('ArrowRight');
        s = await tabState182();
        assert.deepStrictEqual([s.selected, s.focus], [['chat'], 'dtTab-chat'], 'ArrowRight from Info must wrap to Chat, not stop at Files');
        await page.keyboard.press('ArrowLeft');
        s = await tabState182();
        assert.deepStrictEqual(s.selected, ['info'], 'ArrowLeft from Chat must wrap to Info, not Files');
        await page.keyboard.press('Home');
        assert.deepStrictEqual((await tabState182()).selected, ['chat']);
        await page.keyboard.press('End');
        assert.deepStrictEqual((await tabState182()).selected, ['info']);

        const files = await page.evaluate(() => {
          const b = document.getElementById('dtTab-files');
          return { disabled: b.disabled, aria: b.getAttribute('aria-disabled'), title: b.title, pane: !!document.getElementById('dtPane-files') };
        });
        assert.strictEqual(files.disabled, true, 'the Files tab is clickable, but it is a spike with nothing behind it');
        assert.strictEqual(files.aria, 'true', 'the Files tab does not say it is disabled to a screen reader');
        assert.strictEqual(files.title, 'Spike only: appears when the device allows file access');
        assert.strictEqual(files.pane, false, 'the Files tab has a pane, so something is behind it');
        await page.click('#dtTab-files', { force: true });
        s = await tabState182();
        assert.deepStrictEqual([s.selected, s.shown], [['info'], ['info']], 'clicking the disabled Files tab changed what is showing');
      } finally {
        page.off('request', onRequest);
      }
      assert.deepStrictEqual(requests, [],
        'switching tabs only shows and hides panes, but it made a request to a device');
    });

    await check('moving between tabs keeps a half-typed message and the transcript, because the composer sits outside every pane (#182)', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      const outside = await page.evaluate(() => ['dtInput', 'dtSend']
        .every((id) => !document.getElementById(id).closest('[role="tabpanel"]')));
      assert.ok(outside, 'the composer is inside a tab pane, so it would vanish with that tab');
      await page.evaluate(() => {
        const box = document.getElementById('dtInput');
        box.value = 'a half-typed follow-up';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('dtTranscript').dataset.kept182 = 'yes';
      });
      for (const tab of ['info', 'squad', 'chat']) {
        await page.click(`#dtTab-${tab}`);
        const composer = await page.evaluate(() => document.getElementById('dtInput').offsetParent !== null);
        assert.ok(composer, `the composer disappeared on the ${tab} tab`);
      }
      const kept = await page.evaluate(() => ({
        draft: document.getElementById('dtInput').value,
        transcript: document.getElementById('dtTranscript').dataset.kept182,
      }));
      assert.strictEqual(kept.draft, 'a half-typed follow-up', 'a tab switch cost someone their half-typed message');
      assert.strictEqual(kept.transcript, 'yes', 'a tab switch rebuilt the transcript');
    });

    await check('a pending request shows as an inline card on the Chat tab, and the pop-up and the bell still raise it (#182)', async () => {
      live182.allow = await gated182('allow', 'git status && npm test | tee 182-out.log', { repo: true });
      const g = live182.allow;
      await gotoSettled(page, origin);

      // The pop-up and the bell are unchanged by the card.
      await page.waitForSelector('#approvalScrim:not([hidden])', { timeout: 20000 });
      assert.match(await page.textContent('#apCommand'), /git status && npm test/, 'the pop-up did not show the command');
      const bell = await page.evaluate(() => ({
        hidden: document.getElementById('bellCount').hidden,
        count: Number(document.getElementById('bellCount').textContent),
      }));
      assert.ok(!bell.hidden && bell.count >= 1, 'the bell did not count the waiting request');
      await page.click('#apCancel');
      await page.click('#bellBtn');
      await page.waitForSelector('#inboxMenu:not([hidden])', { timeout: 5000 });
      assert.ok((await page.textContent('#inboxList')).includes('git status && npm test'),
        'the bell inbox did not list the waiting request');
      await page.click('#bellBtn');

      await page.click(`[data-session]:has-text("${g.prompt}")`);
      await page.waitForSelector('#dtApprovals .dt-appr', { timeout: 20000 });
      const card = await page.evaluate(() => {
        const c = document.querySelector('#dtApprovals .dt-appr');
        const texts = (sel) => [...c.querySelectorAll(sel)].map((e) => e.textContent.replace(/\s+/g, ' ').trim());
        const hint = c.querySelector('.hint-btn');
        return {
          visible: c.offsetParent !== null,
          inChat: !!c.closest('#dtPane-chat'),
          title: texts('.dt-appr-title')[0],
          command: c.querySelector('.dt-appr-cmd').textContent,
          tools: texts('.dt-appr-tools .dt-chip'),
          rows: [...c.querySelectorAll('.ap-row')].map((r) => ({
            label: r.querySelector('.ap-label').textContent,
            badge: r.querySelector('.ap-badge').textContent,
            writes: r.classList.contains('rw'),
          })),
          buttons: texts('.dt-appr-actions button'),
          rule: texts('.ap-rule')[0],
          hint: hint ? { label: hint.getAttribute('aria-label'), title: hint.title } : null,
          dot: !document.getElementById('dtTabChatDot').hidden,
          chatLabel: document.getElementById('dtTab-chat').getAttribute('aria-label'),
          text: c.textContent,
        };
      });
      assert.ok(card.visible && card.inChat, 'the card is not visible on the Chat tab');
      assert.strictEqual(card.title, 'Create marker file');
      assert.strictEqual(card.command, 'git status && npm test | tee 182-out.log', 'the card did not show what would run');
      assert.deepStrictEqual(card.tools, ['execute', 'git', 'npm', 'tee'], 'the tool chips are not the kind plus every program in the command');
      assert.strictEqual(card.rows[0].label, card.command, 'the first chip row is not the tool');
      assert.ok(card.rows.some((r) => r.label === '182-out.log'), 'the path the command names has no chip');
      assert.ok(card.rows.every((r) => r.badge === 'writes' && r.writes),
        'a command that pipes into tee must be badged as writing, never read-only');
      assert.deepStrictEqual(card.buttons, ['Allow once', 'Always allow', 'Deny'], 'the card does not offer exactly what the agent offered');
      assert.strictEqual(card.rule, 'Allow "git status && npm test | tee 182-out.log" without asking again in this session.',
        'Always allow does not say what it would make standing');
      assert.ok(card.hint && card.hint.label && card.hint.title, 'the card has no labelled explainer');
      assert.strictEqual(card.dot, true, 'the Chat tab does not signal that a request is waiting');
      assert.match(card.chatLabel, /permission request/, 'the Chat tab signal is color only');
      assert.ok(!/teams/i.test(card.text), 'the card carries a Teams control');
      await shoot182('detail-chat-approval');
    });

    await check('the card survives tab switches and live refreshes without being rebuilt, and the Chat dot stays (#182)', async () => {
      await page.evaluate(() => { document.querySelector('#dtApprovals .dt-appr').dataset.kept182 = 'yes'; });
      await page.click('#dtTab-info');
      const away = await page.evaluate(() => ({
        shown: document.querySelector('#dtApprovals .dt-appr').offsetParent !== null,
        dot: !document.getElementById('dtTabChatDot').hidden,
        empty: (document.querySelector('#dtInfoHistory .dt-empty') || {}).textContent || '',
      }));
      assert.strictEqual(away.shown, false, 'the card is showing on the Info tab');
      assert.strictEqual(away.dot, true, 'the Chat dot went away while the request is still waiting');
      assert.match(away.empty, /No permission request has been answered/, 'Info did not say nothing has been answered yet');

      // A manual refresh renders the whole page again from the hub.
      await page.click('#menuBtn');
      await page.click('[data-menu="refresh"]');
      await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
      await page.click('#dtTab-chat');
      const back = await page.evaluate(() => ({
        shown: document.querySelector('#dtApprovals .dt-appr').offsetParent !== null,
        kept: document.querySelector('#dtApprovals .dt-appr').dataset.kept182,
        cards: document.querySelectorAll('#dtApprovals .dt-appr').length,
      }));
      assert.deepStrictEqual(back, { shown: true, kept: 'yes', cards: 1 },
        'the card was rebuilt, duplicated or lost by a tab switch or a refresh');
    });

    await check('the tabs, the card and its buttons keep their sizes and stay inside the page at 1280, 900 and 390px (#182)', async () => {
      try {
        for (const width of [1280, 900, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
          const m = await page.evaluate(() => {
            const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, height: r.height }; };
            const card = document.querySelector('#dtApprovals .dt-appr');
            return {
              vw: document.documentElement.clientWidth,
              scroll: document.documentElement.scrollWidth,
              pill: box(document.getElementById('dtStatusPill')).height,
              bar: box(document.getElementById('dtTabs')),
              tabs: [...document.querySelectorAll('#dtTabs .dt-tab')].map((t) => box(t)),
              card: box(card),
              buttons: [...card.querySelectorAll('.dt-appr-actions button')].map((b) => box(b)),
              chips: [...card.querySelectorAll('.dt-chip, .ap-row')].map((c) => box(c)),
              toolChips: [...card.querySelectorAll('.dt-chip')].map((c) => box(c).height),
            };
          });
          assert.strictEqual(m.pill, 22, `at ${width}px the status pill is ${m.pill}px tall, not 22`);
          assert.strictEqual(m.bar.height, 40, `at ${width}px the tab bar is ${m.bar.height}px tall, not 40`);
          assert.ok(m.tabs.every((t) => t.height === 40 && Math.abs(t.top - m.tabs[0].top) <= 1),
            `at ${width}px the tabs are not one row of equal height`);
          assert.ok(m.tabs.every((t) => t.left >= 0 && t.right <= m.vw), `at ${width}px a tab is outside the viewport`);
          assert.ok(m.card.left >= 0 && m.card.right <= m.vw + 0.5, `at ${width}px the card is outside the viewport`);
          assert.ok(m.buttons.length === 3 && m.buttons.every((b) => b.height === 32),
            `at ${width}px the card buttons are not the product's 32px: ${m.buttons.map((b) => b.height)}`);
          assert.ok(m.buttons.every((b) => b.left >= 0 && b.right <= m.vw), `at ${width}px a card button is outside the viewport`);
          assert.ok(m.chips.every((c) => c.left >= -0.5 && c.right <= m.vw + 0.5), `at ${width}px a chip is outside the viewport`);
          assert.ok(m.toolChips.length >= 4 && m.toolChips.every((h) => h === 22),
            `at ${width}px the tool chips are not the product's 22px pill height: ${m.toolChips}`);
          assert.ok(m.scroll <= m.vw, `at ${width}px the page scrolls sideways (${m.scroll} > ${m.vw})`);
        }
      } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    });

    await check('the card waits for the hub: nothing goes while the answer is in flight, and a refused answer leaves the request answerable (#182)', async () => {
      const g = live182.allow;
      const posts = [];
      let release = null;
      const gate = new Promise((resolve) => { release = resolve; });
      const approveUrl = /\/api\/devices\/[^/]+\/approve$/;
      await page.route(approveUrl, async (route) => {
        posts.push(route.request().postDataJSON());
        await gate;
        await route.fulfill({
          status: 502, contentType: 'application/json',
          body: JSON.stringify({ error: 'the device did not accept the answer' }),
        });
      });
      try {
        await page.click('#dtApprovals [data-answer="allow_once"]');
        await until(() => posts.length === 1, 'the answer to leave the page');
        // In flight: the hub has not said yes, so nothing about the request may change.
        const inflight = await page.evaluate(() => {
          const card = document.querySelector('#dtApprovals .dt-appr');
          return {
            present: !!card,
            disabled: card ? [...card.querySelectorAll('.dt-appr-actions button')].map((b) => b.disabled) : [],
            note: card ? card.querySelector('.dt-appr-note').textContent : '',
          };
        });
        assert.strictEqual(inflight.present, true, 'the card went away before the hub accepted the answer');
        assert.deepStrictEqual(inflight.disabled, [true, true, true], 'the buttons were still live while the answer was in flight');
        assert.strictEqual(inflight.note, '', 'the card claimed an outcome before the hub gave one');
        await page.click('#dtApprovals [data-answer="allow_once"]', { force: true });
        await page.click('#dtApprovals [data-answer="allow_always"]', { force: true });
        await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
        assert.strictEqual(posts.length, 1, 'a second click while the answer was in flight sent a second answer');

        release();
        await until(async () => /Could not answer: the device did not accept the answer/.test(
          await page.textContent('#dtApprovals .dt-appr-note').catch(() => '')), 'the refusal to be reported on the card');
      } finally {
        release();
        await page.unroute(approveUrl);
      }
      const after = await page.evaluate(() => {
        const card = document.querySelector('#dtApprovals .dt-appr');
        return { cards: document.querySelectorAll('#dtApprovals .dt-appr').length, disabled: card ? [...card.querySelectorAll('.dt-appr-actions button')].map((b) => b.disabled) : [] };
      });
      assert.strictEqual(after.cards, 1, 'a refused answer removed the request, so it can no longer be answered');
      assert.deepStrictEqual(after.disabled, [false, false, false], 'a refused answer left the card unable to be answered again');
      assert.strictEqual(fs.existsSync(path.join(g.work, g.marker)), false, 'the tool ran although the hub refused the answer');
      assert.strictEqual(await historyRow182('allow_once'), null, 'the history recorded an answer the hub refused');
      assert.strictEqual(await page.isVisible('#approvalScrim'), false, 'the pop-up came back for a request that is still pending');
      assert.deepStrictEqual(posts, [{ sessionId: g.sessionId, approvalId: g.approvalId, optionId: 'allow_once' }],
        'the refused answer was not for this request with the option that was clicked');
    });

    await check('answering Allow once from the inline card ACTUALLY runs the tool, clears the card and lands in the Info history (#182)', async () => {
      const g = live182.allow;
      const posts = [];
      const onRequest = (r) => { if (r.method() === 'POST' && /\/approve$/.test(r.url())) posts.push(r.postDataJSON()); };
      page.on('request', onRequest);
      try {
        await page.click('#dtApprovals [data-answer="allow_once"]');
        // The side effect, not the reply: the agent writes this file only when it was really allowed.
        await until(() => fs.existsSync(path.join(g.work, g.marker)), 'the approved tool to actually run');
        await until(async () => (await page.$$('#dtApprovals .dt-appr')).length === 0, 'the answered card to go');
      } finally {
        page.off('request', onRequest);
      }
      assert.deepStrictEqual(posts, [{ sessionId: g.sessionId, approvalId: g.approvalId, optionId: 'allow_once' }],
        'the card must answer once, for this request, with the option that was clicked');
      assert.strictEqual(await page.isVisible('#approvalScrim'), false, 'the pop-up came back for a request that was answered');
      assert.strictEqual(await page.isHidden('#dtTabChatDot'), true, 'the Chat dot stayed after the request was answered');

      await page.click('#dtTab-info');
      await until(async () => !!(await historyRow182('allow_once')), 'the answer to appear in the Info history');
      const row = await historyRow182('allow_once');
      assert.strictEqual(row.approval, g.approvalId);
      assert.match(row.text, /Allowed/, 'the history does not say what the answer was');
      assert.match(row.text, /Create marker file/, 'the history does not say what the request was for');
      assert.match(row.text, /by test person/, 'the history does not say who answered');
      assert.match(row.text, /from the hub/, 'the history does not say where the answer came from');
      assert.ok(!/not answered/.test(row.text), 'an answered request is labelled as unanswered');

      // The rest of Info is what this device reported, or says it did not.
      const info = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#dtInfoRows tr')]
        .map((r) => [r.dataset.info, r.querySelector('td').textContent.replace(/\s+/g, ' ').trim()])));
      assert.match(info.device, /E2E Device/);
      assert.ok(info.cwd.includes(path.basename(g.work)), `the working directory is wrong: ${info.cwd}`);
      assert.match(info.repository, /octo\/widgets/);
      assert.match(info.repository, /github\.com/);
      assert.strictEqual(info.branch, 'feature/detail-tabs');
      assert.match(info.toolCalls, /^\d+$/, 'the tool count is not a number');
      assert.ok(info.started && !/not reported/.test(info.started), 'the start time is missing');
      assert.ok(info.squadHealth, 'the Squad health row is empty');
      assert.ok(!('links' in info), 'a device that is not on ACA showed an ACA row');
      assert.ok(!/lease/i.test(Object.values(info).join(' ')), 'Info invented a lease, which no device reports');
      await shoot182('detail-info');
    });

    await check('the Info tab, its history rows and the space above the composer stay aligned and inside the page at 1280, 900 and 390px (#182)', async () => {
      assert.deepStrictEqual((await tabState182()).selected, ['info'], 'the Info tab is not the one open');
      try {
        for (const width of [1280, 900, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
          const m = await page.evaluate(() => {
            const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
            const row = document.querySelector('#dtInfoHistory .dt-hist-row');
            const kids = [...row.children].map((c) => ({ cls: c.className, ...box(c) }));
            return {
              vw: document.documentElement.clientWidth,
              scroll: document.documentElement.scrollWidth,
              pane: box(document.getElementById('dtPane-info')),
              composer: box(document.querySelector('.composer')),
              row: box(row),
              kids,
              labels: [...document.querySelectorAll('#dtInfoRows th')].map((th) => box(th).left),
              pairs: [...document.querySelectorAll('#dtInfoRows tr')].map((tr) => [box(tr.querySelector('th')).top, box(tr.querySelector('td')).top]),
              cells: [...document.querySelectorAll('#dtInfoRows td, #dtInfoRows th')].map((c) => box(c)),
              pill: box(row.querySelector('.dt-pill')).height,
              chip: box(row.querySelector('.dt-chip')).height,
            };
          });
          assert.ok(m.scroll <= m.vw, `at ${width}px the Info tab scrolls the page sideways (${m.scroll} > ${m.vw})`);
          assert.ok(m.cells.every((c) => c.left >= -0.5 && c.right <= m.vw + 0.5), `at ${width}px a cell of the details table is outside the viewport`);
          assert.ok(m.kids.length === 4 && m.kids.every((k) => k.left >= -0.5 && k.right <= m.vw + 0.5),
            `at ${width}px a part of a history row is outside the viewport`);
          assert.strictEqual(m.pill, 22, `at ${width}px the history pill is ${m.pill}px tall, not 22`);
          assert.strictEqual(m.chip, 22, `at ${width}px the history chip is ${m.chip}px tall, not 22`);
          // Whatever shares a line shares a center, so a pill, a chip and the who/when text never sit at different heights.
          for (const a of m.kids) {
            for (const b of m.kids) {
              if (a === b || Math.abs(a.top - b.top) > 11) continue;
              assert.ok(Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) <= 1.5,
                `at ${width}px ${a.cls || 'the pill'} and ${b.cls || 'the pill'} share a line but not a center`);
            }
          }
          if (width >= 900) {
            assert.ok(m.row.height <= 40, `at ${width}px a history row wrapped (${m.row.height}px tall) though there is room for one line`);
            const when = m.kids.find((k) => k.cls === 'dt-hist-when');
            assert.ok(Math.abs(when.right - m.row.right) <= 1, `at ${width}px the time is not at the right edge of the row`);
          }
          assert.ok(new Set(m.labels.map((l) => Math.round(l))).size === 1, `at ${width}px the details table's labels do not line up`);
          assert.ok(m.pairs.every(([a, b]) => Math.abs(a - b) <= 1), `at ${width}px a label and its value do not start on the same line`);
          assert.ok(m.composer.top - m.pane.bottom >= 12,
            `at ${width}px the Info tab sits ${m.composer.top - m.pane.bottom}px above the composer, not at least 12`);
        }
      } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    });

    await check('the Squad tab shows the existing Squad panel, with its members and documents, above the composer (#182)', async () => {
      await page.click('#dtTab-squad');
      await page.waitForSelector('#dtSquad:not([hidden])', { timeout: 20000 });
      await page.waitForSelector('#dtSquadDocs .sq-doctab', { timeout: 20000 });
      const sq = await page.evaluate(() => ({
        inSquad: !!document.getElementById('dtSquad').closest('#dtPane-squad'),
        inChat: !!document.querySelector('#dtPane-chat #dtSquad, #dtPane-chat .sq-members'),
        none: document.getElementById('dtSquadNone').offsetParent !== null,
        members: [...document.querySelectorAll('#dtSquad .sq-member')].map((b) => b.dataset.squaddoc),
        docs: [...document.querySelectorAll('#dtSquadDocs .sq-doctab')].map((b) => b.textContent.trim()),
        decisions: /Recent decisions|No decisions recorded yet/.test(document.getElementById('dtSquad').textContent),
        gap: document.querySelector('.composer').getBoundingClientRect().top - document.getElementById('dtPane-squad').getBoundingClientRect().bottom,
        scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      assert.strictEqual(sq.inSquad && !sq.inChat, true, 'the Squad panel is not on the Squad tab alone');
      assert.strictEqual(sq.none, false, 'a session with a Squad workspace showed the "no Squad" note');
      assert.ok(sq.members.includes('charter:engineer'), `the Squad panel lost its roster: ${sq.members}`);
      assert.deepStrictEqual(sq.docs, ['Team', 'Decisions'], 'the document bar offers something other than what this workspace has');
      assert.ok(sq.decisions, 'the Squad panel lost its decisions section');
      assert.ok(sq.gap >= 12, `the Squad tab sits ${sq.gap}px above the composer, not at least 12`);
      assert.ok(sq.scroll <= 0, 'the Squad tab scrolls the page sideways');
      // Opening a document still works from the tab, and nothing leaks into the other tabs.
      await page.click('[data-squaddoc="decisions"]');
      await page.waitForSelector('.sq-doctext', { timeout: 20000 });
      assert.match(await page.textContent('.sq-doctext'), /Decisions/, 'the decisions document did not open from the Squad tab');
      await page.click('#dtTab-chat');
      assert.strictEqual(await page.isVisible('.sq-doctext'), false, 'the Squad document shows on the Chat tab');
      await page.click('#dtTab-squad');
      await shoot182('detail-squad');
      await page.click('#dtTab-info');
    });

    await check('a very long working directory wraps in the session header and in Info instead of pushing the page sideways at 1280, 900 and 390px (#182)', async () => {
      live182.wide = await gated182('wide', 'git status', { repo: true, longPath: true });
      await openGated182(live182.wide);
      try {
        for (const tab of ['chat', 'info']) {
          await page.click(`#dtTab-${tab}`);
          for (const width of [1280, 900, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
            const m = await page.evaluate(() => {
              const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; };
              const run = (el) => (el.textContent.match(/[^\\/\s]+/g) || []).reduce((n, s) => Math.max(n, s.length), 0);
              const meta = document.getElementById('dtMeta');
              const cwd = document.querySelector('#dtInfoRows [data-info="cwd"] code');
              return {
                vw: document.documentElement.clientWidth,
                scroll: document.documentElement.scrollWidth,
                meta: box(meta),
                metaRun: run(meta),
                cwd: cwd && cwd.offsetParent !== null ? box(cwd) : null,
                cells: [...document.querySelectorAll('#dtInfoRows td, #dtInfoRows th')]
                  .filter((c) => c.offsetParent !== null).map(box),
              };
            });
            // Without a long unbroken run in the fixture, nothing below proves anything.
            assert.ok(m.metaRun >= 100, `the working directory has no long unbroken run (${m.metaRun})`);
            assert.ok(m.scroll <= m.vw, `at ${width}px on ${tab} a long working directory scrolls the page sideways (${m.scroll} > ${m.vw})`);
            assert.ok(m.meta.right <= m.vw + 0.5, `at ${width}px on ${tab} the header summary runs off the page (${Math.round(m.meta.right)} > ${m.vw})`);
            if (tab === 'info') {
              assert.ok(m.cwd, 'the Info tab shows no working directory');
              assert.ok(m.cwd.right <= m.vw + 0.5, `at ${width}px a long working directory runs off the page in Info (${Math.round(m.cwd.right)} > ${m.vw})`);
              assert.ok(m.cells.every((c) => c.left >= -0.5 && c.right <= m.vw + 0.5), `at ${width}px a cell of the details table is outside the viewport`);
            }
          }
        }
        // Leave nothing pending, or the pop-up would cover the next check.
        await page.click('#dtTab-chat');
        await page.click('#dtApprovals [data-answer="reject_once"]');
        await until(async () => (await page.$$('#dtApprovals .dt-appr')).length === 0, 'the denied card to go');
      } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    });

    await check('the session header still fits, with the tabs, while a permission request waits, at 1280, 900 and 390px, light and dark (#182)', async () => {
      live182.header = await gated182('header', 'git status', { repo: true });
      await openGated182(live182.header);
      try {
        await page.waitForSelector('#dtApprovals .dt-appr', { timeout: 20000 });
        await headerFit182('a session waiting for permission', ['dtAca', 'dtStop', 'dtMoreBtn'], 'approval');
        await page.click('#dtApprovals [data-answer="reject_once"]');
        await until(async () => (await page.$$('#dtApprovals .dt-appr')).length === 0, 'the denied card to go');
      } finally {
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    });

    await check('denying from the inline card runs nothing, and the history records the denial (#182)', async () => {
      live182.deny = await gated182('deny', 'cat notes-182.md');
      const g = live182.deny;
      await openGated182(g);
      await page.waitForSelector('#dtApprovals .dt-appr', { timeout: 20000 });
      const badges = await page.evaluate(() => [...document.querySelectorAll('#dtApprovals .ap-badge')].map((b) => b.textContent));
      assert.ok(badges.length >= 2 && badges.every((b) => b === 'read-only'),
        `a plain cat of a file is not badged read-only: ${badges}`);

      await page.click('#dtApprovals [data-answer="reject_once"]');
      await until(async () => (await page.$$('#dtApprovals .dt-appr')).length === 0, 'the denied card to go');
      // The turn ends when the agent has been told no; only then is a missing file proof.
      await until(async () => {
        const st = await daemon.handle({ op: 'status' });
        const s = (st.sessions || []).find((x) => x.id === g.sessionId);
        return s && s.status !== 'waiting_approval' && s.status !== 'active';
      }, 'the denied turn to end');
      assert.strictEqual(fs.existsSync(path.join(g.work, g.marker)), false, 'a denied request ran the tool');

      await page.click('#dtTab-info');
      await until(async () => !!(await historyRow182('reject_once')), 'the denial to appear in the Info history');
      const row = await historyRow182('reject_once');
      assert.match(row.text, /Denied/);
      assert.match(row.text, /by test person/);
      assert.match(row.text, /from the hub/);
    });

    await check('a session opened from the sidebar starts on the Chat tab, not on the tab the previous session left open (#182)', async () => {
      await page.click('#dtTab-info');
      assert.deepStrictEqual((await tabState182()).selected, ['info']);
      await page.click('#detailSidebar [data-session]:has-text("squad doc view")');
      await until(async () => (await page.textContent('#dtTitle')).includes('squad doc view'), 'the other session to open');
      const next = await tabState182();
      assert.deepStrictEqual([next.selected, next.shown], [['chat'], ['chat']],
        'a session opened from the sidebar did not start on the Chat tab');
    });

    await check('a request answered at the terminal, and one that expired, show in the history with who, what and where (#182)', async () => {
      live182.terminal = await gated182('terminal', 'git status');
      let g = live182.terminal;
      await openGated182(g);
      await page.waitForSelector('#dtApprovals .dt-appr', { timeout: 20000 });
      // `squad-hub approve` on the device, which names no answerer.
      await daemon.handle({ op: 'approve', sessionId: g.sessionId, approvalId: g.approvalId, optionId: 'allow_once' });
      await until(async () => (await page.$$('#dtApprovals .dt-appr')).length === 0,
        'the card to go when the request was answered somewhere else');
      assert.ok(fs.existsSync(path.join(g.work, g.marker)), 'the terminal answer did not run the tool');
      await page.click('#dtTab-info');
      await until(async () => !!(await historyRow182('allow_once')), 'the terminal answer to appear in the history');
      let row = await historyRow182('allow_once');
      assert.match(row.text, /by someone/, 'the answerer is invented, or missing, when the terminal named no one');
      assert.match(row.text, /at the terminal on E2E Device/, 'the history does not say it was answered at the terminal');
      assert.ok(!/test person/.test(row.text), 'a terminal answer was attributed to the signed-in person');

      live182.expired = await gated182('expired', 'rm -rf build');
      g = live182.expired;
      await openGated182(g);
      await page.waitForSelector('#dtApprovals .dt-appr', { timeout: 20000 });
      // Watching Info when it lapses: the history has to update on its own.
      await page.click('#dtTab-info');
      assert.ok(daemon.sessions.get(g.sessionId).expire(g.approvalId), 'the request was not pending to expire');
      await until(async () => !!(await historyRow182('expired')), 'the expiry to appear in the history while Info is open');
      assert.strictEqual((await page.$$('#dtApprovals .dt-appr')).length, 0, 'the expired card is still there');
      row = await historyRow182('expired');
      assert.match(row.text, /Expired/);
      assert.match(row.text, /not answered/, 'an expired request is not labelled as unanswered');
      assert.ok(!/by /.test(row.text), 'an expired request was attributed to someone');
      assert.match(row.text, /on E2E Device/);

      for (const s of Object.values(live182)) {
        await daemon.handle({ op: 'stop-session', sessionId: s.sessionId }).catch(() => {});
      }
    });

    // Evidence capture for CI: a no-op unless SQUAD_HUB_SCREENSHOT_DIR is set.
    await check('the session detail page renders and is captured at desktop and phone widths, dark and light', async () => {
      const outDir = process.env.SQUAD_HUB_SCREENSHOT_DIR;
      if (!outDir) { assert.ok(true); return; }
      assert.ok(fs.statSync(outDir).isDirectory(), `SQUAD_HUB_SCREENSHOT_DIR is not a directory: ${outDir}`);
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      const shots = [
        { width: 1280, height: 900, scheme: 'dark', file: 'detail-desktop-dark.png' },
        { width: 1280, height: 900, scheme: 'light', file: 'detail-desktop-light.png' },
        { width: 390, height: 844, scheme: 'dark', file: 'detail-phone-390-dark.png' },
        { width: 390, height: 844, scheme: 'light', file: 'detail-phone-390-light.png' },
      ];
      try {
        for (const shot of shots) {
          await page.setViewportSize({ width: shot.width, height: shot.height });
          await page.emulateMedia({ colorScheme: shot.scheme });
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
          const state = await page.evaluate(() => {
            const shown = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
            return {
              signin: !!document.querySelector('.signin'),
              title: shown('dtTitle'),
              rename: shown('dtRename'),
              more: shown('dtMoreBtn'),
              back: shown('dtBackPhone'),
              titleText: (document.getElementById('dtTitle') || {}).textContent || '',
            };
          });
          assert.strictEqual(state.signin, false, `${shot.file}: the sign-in page is showing, not the session detail`);
          assert.ok(state.title && state.titleText.trim(), `${shot.file}: the detail title is not visible`);
          assert.ok(state.rename, `${shot.file}: the rename pencil is not visible`);
          assert.ok(state.more, `${shot.file}: the More actions button is not visible`);
          if (shot.width <= 900) assert.ok(state.back, `${shot.file}: the phone back arrow is not visible`);
          await page.screenshot({ path: path.join(outDir, shot.file) });
          assert.ok(fs.statSync(path.join(outDir, shot.file)).size > 0, `${shot.file} was written empty`);
        }
      } finally {
        await page.emulateMedia({ colorScheme: null });
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    });

    await check('under 900px, the sidebar is hidden and the phone back arrow takes its place', async () => {
      await gotoSettled(page, `${origin}/?session=${encodeURIComponent(firstSessionKey)}`);
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      const layout = await page.evaluate(() => ({
        sidebarVisible: document.getElementById('detailSidebar').offsetParent !== null,
        backPhoneVisible: document.getElementById('dtBackPhone').offsetParent !== null,
      }));
      assert.strictEqual(layout.sidebarVisible, false, 'the sidebar is still showing on a phone-width viewport');
      assert.strictEqual(layout.backPhoneVisible, true, 'the phone back arrow is not showing on a phone-width viewport');

      await page.click('#dtBackPhone');
      await page.waitForSelector('#detailScrim[hidden]', { state: 'attached', timeout: 10000 });
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await check('signing out returns to a usable sign-in page', async () => {      await gotoSettled(page, origin);
      await page.waitForSelector('#menuBtn', { timeout: 10000 });
      await page.click('#menuBtn');
      await page.click('[data-menu="signout"]');
      await page.waitForSelector('.signin', { timeout: 10000 });
      const stored = await page.evaluate(() => localStorage.getItem('squad-hub-token'));
      assert.strictEqual(stored, null, 'the credential survived signing out');
    });

    // -------------------------------------------------------------------
    // The OAuth sign-in completion and failure pages, driven for real.
    //
    // Flagged in the lead's review of this sprint (issue #84): every check
    // above signs in through `/?token=`, and never once loads
    // `/auth/github/callback` -- the route the inline-script hazard and the
    // inline-style hazard actually lived on. A browser suite that stayed
    // silent about both would be absence of coverage, not evidence the CSP
    // is safe to enforce. This drives that exact route, for both outcomes,
    // under the SAME enforced policy, and checks the property that matters:
    // the token actually lands in storage and the browser actually ends up
    // signed in -- not just that the response was 200.
    // -------------------------------------------------------------------
    let svcAuth = null;
    await check('the OAuth completion page stores the token and signs in, with the CSP enforced', async () => {
      const auth3 = new Authenticator({
        mode: MODES.GITHUB,
        allowedUsers: ['octocat'],
        githubFetch: async () => ({ login: 'octocat', id: 42 }),
      });
      const oauth3 = new GitHubOAuth({ clientId: 'cid', clientSecret: 'sec' });
      // Stand-ins for GitHub's own endpoints -- proven separately by
      // github-auth-unit.js and spike/github-auth-probe.js. What this test
      // owns is the PAGE this hub hands back, under a real browser.
      oauth3.exchange = async () => 'e2e-oauth-token-abc';
      // A real check, not a stub that always passes: the failure-page test
      // below reaches _signinError by sending a state this rejects, and a
      // fixed `true` would route it through the SUCCESS branch instead,
      // proving nothing about the failure page at all.
      oauth3.checkState = (state) => state === 's';
      svcAuth = new HubService({ auth: auth3, serveWeb: true, oauth: oauth3, persistDeviceTokens: false });
      const addrAuth = await svcAuth.listen(0, '127.0.0.1');
      const originAuth = `http://127.0.0.1:${addrAuth.port}`;
      const page3 = await browser.newPage();
      const violations3 = await watchCsp(page3);
      const errors3 = [];
      page3.on('console', (m) => { if (m.type() === 'error') errors3.push(m.text()); });
      page3.on('pageerror', (e) => errors3.push(`pageerror: ${e.message}`));
      try {
        await page3.goto(`${originAuth}/auth/github/callback?code=c&state=s`);
        // The completion page's own script stores the token then calls
        // location.replace('/'); this waits for THAT navigation to finish
        // and actually land signed in, not merely for the callback response.
        await page3.waitForSelector('#who', { timeout: 15000 });
        assert.strictEqual(await page3.textContent('#who'), 'octocat',
          'the completion page did not actually complete sign-in');
        const stored = await page3.evaluate(() => localStorage.getItem('squad-hub-token'));
        assert.strictEqual(stored, 'e2e-oauth-token-abc',
          'the token never reached localStorage -- an enforced script-src blocked the handoff');
        assert.deepStrictEqual(violations3, [],
          `CSP violations on the completion page: ${JSON.stringify(violations3)}`);
        const broken3 = errors3.filter((e) => !/favicon/i.test(e));
        assert.deepStrictEqual(broken3, [], `the completion page reported errors: ${broken3.join(' | ')}`);
      } finally {
        await page3.close();
      }
    });

    await check('the OAuth failure page renders its message and its styled logo, with the CSP enforced', async () => {
      // Re-uses svcAuth from the previous check; a bad state is this hub's
      // one deterministic way to reach _signinError without a real GitHub.
      const page4 = await browser.newPage();
      const violations4 = await watchCsp(page4);
      const errors4 = [];
      page4.on('console', (m) => { if (m.type() === 'error') errors4.push(m.text()); });
      page4.on('pageerror', (e) => errors4.push(`pageerror: ${e.message}`));
      try {
        await page4.goto(`http://127.0.0.1:${svcAuth.server.address().port}/auth/github/callback?code=c&state=bad`);
        await page4.waitForSelector('.signin-logo', { timeout: 10000 });
        const text = await page4.evaluate(() => document.body.innerText);
        assert.match(text, /sign-in failed/i, 'the failure page did not render its message');
        const decoded = await page4.evaluate(() => {
          const img = document.querySelector('.signin-logo');
          return img && { w: img.naturalWidth, radius: getComputedStyle(img).borderRadius };
        });
        assert.ok(decoded && decoded.w > 0, 'the logo on the failure page did not even load');
        assert.notStrictEqual(decoded.radius, '0px',
          'the logo lost its rounded corners -- the class-based style never applied');
        assert.deepStrictEqual(violations4, [],
          `CSP violations on the failure page: ${JSON.stringify(violations4)}`);
        // The failure page is deliberately served with a 403 status (this
        // route always has been -- see _signinError) so the browser logs
        // that as a console error for the top-level navigation itself; that
        // is the console reflecting an intentional response code, not a
        // broken page, so it is excluded the same way the favicon noise is.
        const broken4 = errors4.filter((e) => !/favicon/i.test(e) && !/403 \(Forbidden\)/.test(e));
        assert.deepStrictEqual(broken4, [], `the failure page reported errors: ${broken4.join(' | ')}`);
      } finally {
        await page4.close();
        await svcAuth.close();
      }
    });

    await check('a dispatched ACA job shows a Queued-on-ACA row, follows its run to a confirmed execution, and drops out when that execution\'s device attaches (#178)', async () => {
      // A hub with the GitHub App configured, on its own HubService/browser
      // so it cannot interfere with the no-App assertions the main `svc`
      // above makes. `fakeInlineGithubApp` stands in for `GitHubApp` itself
      // (already covered against the real GitHub API in
      // test/github-app-unit.js) -- this only needs to prove the BROWSER
      // reacts correctly to what `/api/aca/*` answers.
      const hub = await acaHub(browser, 'aca');
      const { page, app, calls } = hub;
      try {
        // Nothing is pending yet, and nobody has opened the dialog -- but
        // this is an ENABLED hub, so the "Squad on ACA" status card's own
        // mount-time `refreshAcaStatus()` (#233) has ALREADY made its one-time,
        // read-only discovery burst: GET /api/aca/status (always), then GET
        // /api/aca/repos and GET /api/aca/dispatches (since status answered
        // enabled: true). The invariant that matters is narrower than "zero
        // calls": no POST (no dispatch) and no route OTHER than those three
        // read-only endpoints may happen before the user's own deliberate
        // click opens the dialog. (The true "zero /api/aca/* calls at all"
        // invariant belongs to a DISABLED hub with no GitHub App -- see the
        // "Not connected" status-card check above.)
        const ALLOWED_PREOPEN_ACA_PATHS = ['/api/aca/status', '/api/aca/repos', '/api/aca/dispatches'];
        const illegalPreOpen = calls.filter((c) => (
          c.method !== 'GET' || !ALLOWED_PREOPEN_ACA_PATHS.some((p) => c.url.endsWith(p))
        ));
        assert.deepStrictEqual(illegalPreOpen, [],
          `only read-only status-card discovery GETs may happen before the dialog opens: ${JSON.stringify(illegalPreOpen)}`);

        await page.click('#newMoreBtn');
        await page.click('[data-new="aca"]');
        await page.waitForSelector('#acaScrim:not([hidden])', { timeout: 5000 });
        await page.waitForSelector('#acaForm:not([hidden])', { timeout: 10000 });

        // Opening the dialog must not itself retrigger the status card's
        // own discovery GET, and nothing may be POSTed before Start.
        const statusCallsAfterOpen = calls.filter((c) => c.method === 'GET' && c.url.endsWith('/api/aca/status'));
        assert.strictEqual(statusCallsAfterOpen.length, 1,
          `opening the dialog retriggered /api/aca/status: ${JSON.stringify(calls)}`);
        const dispatchPostsBeforeStart = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/aca/dispatch'));
        assert.deepStrictEqual(dispatchPostsBeforeStart, [],
          `/api/aca/dispatch was POSTed before #acaStart was ever clicked: ${JSON.stringify(dispatchPostsBeforeStart)}`);

        await page.fill('#acaRepo', 'acme/widgets');
        await page.fill('#acaPrompt', 'Update the docs and open a pull request');
        await page.click('#acaStart');
        await page.waitForSelector('#acaScrim[hidden]', { state: 'attached', timeout: 10000 });
        await page.waitForSelector('.row:has-text("Queued on ACA")', { timeout: 10000 });
        assert.strictEqual(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/aca/dispatch')).length, 1,
          'Start did not POST exactly one dispatch');
        // With no session yet the pending row IS the list: "No sessions yet" must not sit on top of it.
        assert.ok(await page.evaluate(() => document.getElementById('empty').hidden),
          'the empty state still says "No sessions yet" over a Queued on ACA row');

        // The run is picked up by the hub (in progress), but no execution is
        // confirmed yet: a running workflow proves a run, not a started job.
        app.setRun(1, { state: 'in_progress' });
        await refreshNow(page);
        const running = await until(async () => {
          const r = await pendingRows(page);
          return r.length === 1 && r[0].now.includes('Starting job') ? r : null;
        }, 'the in-progress run to be reflected on the row');
        assert.deepStrictEqual(running[0].done, ['Dispatched'],
          'a running workflow, with no confirmed execution, claimed more than the dispatch');
        assert.strictEqual(running[0].title, '#42 \u00b7 acme/widgets');

        // The workflow's receipt confirms the execution the lease claim and
        // ARM start produced: "Lease claimed" and "Starting job" are now proven.
        app.setRun(1, { executionName: ACA_EXEC });
        await refreshNow(page);
        const confirmed = await until(async () => {
          const r = await pendingRows(page);
          return r.length === 1 && r[0].now.includes('Attached') ? r : null;
        }, 'the confirmed execution to be reflected on the row');
        assert.deepStrictEqual(confirmed[0].done, ['Dispatched', 'Lease claimed', 'Starting job']);
        assert.strictEqual(confirmed[0].pill, 'Queued on ACA', 'attached was claimed before any device registered');

        // An OLDER aca- job on the same repository that reports the same issue
        // is not this dispatch: it gets its own session row, and the pending
        // row stays pending.
        attachAcaDevice(hub, 'aca-older-job-0001', 'sess-older', { repo: 'acme/widgets', issue: '42' }, Date.now() - 3600000);
        await refreshNow(page);
        await until(async () => (await realSessionRows(page)).length === 1, 'the older job to show as its own session');
        assert.strictEqual((await pendingRows(page)).length, 1,
          'an older same-repo/same-issue aca- device attached the new dispatch\'s pending row');

        // The job that THIS dispatch's execution became registers as
        // `aca-<executionName>`, with no repo/issue meta at all (a real job
        // sends none). That, and only that, attaches the row.
        attachAcaDevice(hub, `aca-${ACA_EXEC}`, 'sess-exec', {});
        await refreshNow(page);
        await until(async () => ((await pendingRows(page)).length === 0
          && (await realSessionRows(page)).length === 2), 'the dispatched job\'s own session to replace the pending row');
        assert.strictEqual(await page.$('.row:has-text("Queued on ACA")'), null, 'the Queued on ACA row survived the attach');

        // An attached job needs no more polling: nothing is pending, so a
        // further refresh must not call /api/aca/dispatches again.
        const dispatchGets = () => calls.filter((c) => c.method === 'GET' && c.url.endsWith('/api/aca/dispatches')).length;
        const before = dispatchGets();
        await refreshNow(page);
        await new Promise((r) => setTimeout(r, 500));
        assert.strictEqual(dispatchGets(), before, 'an attached job is still being polled');

        const broken = hub.errors.filter((e) => !/favicon/i.test(e));
        assert.deepStrictEqual(broken, [], `the dispatch flow logged console errors: ${broken.join(' | ')}`);
      } finally {
        await hub.close();
      }
    });

    await check('two dispatches on the SAME repository attach only to their own jobs, never to a lookalike or each other (#178)', async () => {
      // The defect matching by repository+issue+timing had: one real aca-
      // device clearing BOTH pending rows, or the wrong one. Each row now waits
      // for the device of ITS OWN confirmed execution.
      const hub = await acaHub(browser, 'two');
      const { page, app } = hub;
      try {
        // A pre-existing job on the same repository reporting dispatch 1's issue.
        attachAcaDevice(hub, 'aca-preexisting-0001', 'sess-old', { repo: 'acme/widgets', issue: '42' }, Date.now() - 3600000);

        await dispatchAcaJob(page, 'First job for this repository');
        await page.waitForSelector('.row:has-text("Queued on ACA")', { timeout: 10000 });
        await dispatchAcaJob(page, 'Second job for the same repository');
        await page.waitForFunction(() => document.querySelectorAll('.row.aca-pending').length === 2, null, { timeout: 10000 });

        app.setRun(1, { state: 'in_progress', executionName: ACA_EXEC });
        app.setRun(2, { state: 'in_progress', executionName: ACA_EXEC_2 });
        await refreshNow(page);
        await until(async () => {
          const r = await pendingRows(page);
          return r.length === 2 && r.every((x) => x.now.includes('Attached')) ? r : null;
        }, 'both rows to show their confirmed execution');
        assert.strictEqual((await pendingRows(page)).length, 2, 'the pre-existing device attached a pending row');

        // The SECOND dispatch's job registers: only the second row goes.
        attachAcaDevice(hub, `aca-${ACA_EXEC_2}`, 'sess-second', {});
        await refreshNow(page);
        const left = await until(async () => {
          const r = await pendingRows(page);
          return r.length === 1 ? r : null;
        }, 'exactly one pending row to remain');
        assert.strictEqual(left[0].title, '#42 \u00b7 acme/widgets', 'the wrong dispatch\'s row attached');

        // And then the first.
        attachAcaDevice(hub, `aca-${ACA_EXEC}`, 'sess-first', {});
        await refreshNow(page);
        await until(async () => ((await pendingRows(page)).length === 0
          && (await realSessionRows(page)).length === 3), 'both jobs to have their own session row and no pending rows');

        const broken = hub.errors.filter((e) => !/favicon/i.test(e));
        assert.deepStrictEqual(broken, [], `the dispatch flow logged console errors: ${broken.join(' | ')}`);
      } finally {
        await hub.close();
      }
    });

    await check('a dispatch that fails upstream shows the error and adds no pending row (#178)', async () => {
      const authFail = new Authenticator({ mode: MODES.DEV, devSecret: 'aca-fail', deviceSecret: 'aca-fail-dev' });
      const githubAppFail = fakeInlineGithubApp({ dispatchShouldFail: true });
      const svcFail = new HubService({ auth: authFail, serveWeb: true, githubApp: githubAppFail });
      const addrFail = await svcFail.listen(0, '127.0.0.1');
      const originFail = `http://127.0.0.1:${addrFail.port}`;
      const tokenFail = authFail.mintDevToken('t-fail', 'u-fail', 'fail tester');
      const pageFail = await browser.newPage();
      try {
        await gotoSettled(pageFail, `${originFail}/?token=${tokenFail}`);
        await pageFail.waitForSelector('#who', { timeout: 15000 });
        await pageFail.click('#newMoreBtn');
        await pageFail.click('[data-new="aca"]');
        await pageFail.waitForSelector('#acaForm:not([hidden])', { timeout: 10000 });
        await pageFail.fill('#acaRepo', 'acme/widgets');
        await pageFail.fill('#acaPrompt', 'Update the docs and open a pull request');
        await pageFail.click('#acaStart');
        await pageFail.waitForSelector('#acaErr:not([hidden])', { timeout: 10000 });
        const err = await pageFail.textContent('#acaErr');
        assert.match(err, /[Cc]ould not start the job/, `no explanation for the failed dispatch: ${err}`);
        assert.ok(!(await pageFail.evaluate(() => document.getElementById('acaScrim').hidden)),
          'the dialog closed as if the dispatch had succeeded');
        assert.doesNotMatch(await pageFail.evaluate(() => document.getElementById('groups').textContent),
          /Queued on ACA/, 'a pending row was added for a dispatch that never actually started');
      } finally {
        await pageFail.close();
        await svcFail.close();
      }
    });

    await check('two overlapping refreshes while the job attaches never duplicate or lose a row (#178)', async () => {
      // Two refresh-triggering actions fired back-to-back, the second started
      // before the first has settled, so two `syncAcaPending` passes genuinely
      // overlap. The attach must still happen exactly once: one real session
      // row, no leftover pending row, no console error.
      const hub = await acaHub(browser, 'overlap');
      const { page } = hub;
      try {
        await dispatchAcaJob(page, 'Overlapping-poll regression');
        await page.waitForSelector('.row:has-text("Queued on ACA")', { timeout: 10000 });
        hub.app.setRun(1, { state: 'in_progress', executionName: ACA_EXEC });
        attachAcaDevice(hub, `aca-${ACA_EXEC}`, 'sess-overlap-1', {});

        await Promise.all([
          page.selectOption('#statusFilter', 'action'),
          page.selectOption('#statusFilter', ''),
        ]);

        await until(async () => ((await realSessionRows(page)).length === 1
          && (await pendingRows(page)).length === 0), 'the attached session row to replace the pending row');
        assert.strictEqual((await realSessionRows(page)).length, 1,
          'the overlapping refreshes produced more than one row for one real session');
        assert.strictEqual((await pendingRows(page)).length, 0,
          'the overlapping refreshes left a pending row behind for a job that attached');
        const broken = hub.errors.filter((e) => !/favicon/i.test(e));
        assert.deepStrictEqual(broken, [], `overlapping refreshes logged console errors: ${broken.join(' | ')}`);
      } finally {
        await hub.close();
      }
    });

    await check('a slow, older /api/overview reply can never put an attached job back to Queued on ACA (#178)', async () => {
      // Out-of-order replies: refresh A's reply (taken BEFORE the job's device
      // registered) lands after refresh B's. Only the newest reply may update
      // the overview, or the just-attached session would vanish from the list.
      const hub = await acaHub(browser, 'stale');
      const { page } = hub;
      const hold = { armed: false, held: false, response: null, release: null };
      try {
        await page.route(`${hub.origin}/api/overview**`, async (route) => {
          if (!hold.armed) return route.continue();
          hold.armed = false;
          hold.response = await route.fetch();
          hold.held = true;
          await new Promise((resolve) => { hold.release = resolve; });
          return route.fulfill({ response: hold.response });
        });
        await dispatchAcaJob(page, 'Out-of-order overview replies');
        await page.waitForSelector('.row:has-text("Queued on ACA")', { timeout: 10000 });
        hub.app.setRun(1, { state: 'in_progress', executionName: ACA_EXEC });

        hold.armed = true;
        await page.selectOption('#statusFilter', 'action');
        await until(() => hold.held, 'refresh A to be taken and held');
        attachAcaDevice(hub, `aca-${ACA_EXEC}`, 'sess-stale-1', {});
        await page.selectOption('#statusFilter', '');
        await until(async () => ((await realSessionRows(page)).length === 1
          && (await pendingRows(page)).length === 0), 'refresh B to show the attached session');

        hold.release();
        await new Promise((r) => setTimeout(r, 800));
        assert.strictEqual((await realSessionRows(page)).length, 1,
          'the older overview reply removed the attached session from the list again');
        assert.strictEqual((await pendingRows(page)).length, 0, 'the attached job went back to a pending row');
      } finally {
        if (hold.release) hold.release();
        await hub.close();
      }
    });

    await check('a held overview GET cannot erase an ACA session attached through the live push (#178)', async () => {
      const hub = await acaHub(browser, 'push-stale-get');
      const { page } = hub;
      const hold = { armed: false, held: false, release: null };
      try {
        await dispatchAcaJob(page, 'Keep the pushed session when an older GET lands');
        hub.app.setRun(1, { state: 'in_progress', executionName: ACA_EXEC });
        await refreshNow(page);
        await until(async () => {
          const rows = await pendingRows(page);
          return rows.length === 1 && rows[0].now.includes('Attached');
        }, 'the pending row to know its execution');
        await page.waitForFunction(() => document.getElementById('conn').dataset.state === 'live', null, { timeout: 5000 });
        await page.route(`${hub.origin}/api/overview**`, async (route) => {
          if (!hold.armed) return route.continue();
          hold.armed = false;
          const response = await route.fetch();
          hold.held = true;
          await new Promise((resolve) => { hold.release = resolve; });
          return route.fulfill({ response });
        });
        hold.armed = true;
        await page.evaluate(async () => {
          const { refresh } = await import('/js/ws.js');
          window.__heldAcaRefresh = refresh();
        });
        await until(() => hold.held, 'the pre-attach GET to be held');
        attachAcaDevice(hub, `aca-${ACA_EXEC}`, 'sess-push-stale-get', {});
        hub.svc._broadcast(hub.subject, { type: 'overview', ...hub.svc.store.overview(hub.subject) });
        await until(async () => ((await realSessionRows(page)).length === 1
          && (await pendingRows(page)).length === 0), 'the live push to attach the session', 5000);
        hold.release();
        await page.evaluate(async () => {
          await window.__heldAcaRefresh;
          delete window.__heldAcaRefresh;
        });
        assert.strictEqual((await realSessionRows(page)).length, 1, 'the older GET erased the pushed session');
        assert.strictEqual((await pendingRows(page)).length, 0, 'the pushed attach reverted to pending');
      } finally {
        if (hold.release) hold.release();
        await hub.close();
      }
    });

    await check('the job\'s session replaces the pending row from the live push alone, with no refresh or poll (#178)', async () => {
      // Once the hub has confirmed the execution, the job's device registering
      // is pushed over the WebSocket: the row must swap right then, not on the
      // next 15 second poll or the next filter change.
      const hub = await acaHub(browser, 'push');
      const { page } = hub;
      try {
        await dispatchAcaJob(page, 'Swap on the live push');
        hub.app.setRun(1, { state: 'in_progress', executionName: ACA_EXEC });
        await refreshNow(page);
        await until(async () => {
          const r = await pendingRows(page);
          return r.length === 1 && r[0].now.includes('Attached') ? r : null;
        }, 'the confirmed execution to be reflected on the row');

        await page.waitForFunction(() => document.getElementById('conn').dataset.state === 'live', null, { timeout: 5000 });
        attachAcaDevice(hub, `aca-${ACA_EXEC}`, 'sess-push-1', {}); // the store write alone pushes nothing,
        // so send what a registering device's own message makes the hub send
        hub.svc._broadcast(hub.subject, { type: 'overview', ...hub.svc.store.overview(hub.subject) });
        await until(async () => ((await realSessionRows(page)).length === 1
          && (await pendingRows(page)).length === 0), 'the pushed device to replace the pending row', 5000);
      } finally {
        await hub.close();
      }
    });

    await check('a repository whose workflow cannot prove its run stays "Unknown outcome" and never guesses an aca- device (#178)', async () => {
      // `unsupported`: the workflow has no hub_correlation_id, so the hub cannot
      // say which run is this dispatch. A same-repository, same-issue aca- job
      // arriving meanwhile is exactly the lookalike the old matcher attached.
      const hub = await acaHub(browser, 'unsupported', { correlationSupported: false });
      const { page } = hub;
      try {
        await dispatchAcaJob(page, 'Workflow with no correlation input');
        attachAcaDevice(hub, 'aca-lookalike-0001', 'sess-lookalike', { repo: 'acme/widgets', issue: '42' });
        await refreshNow(page);
        const rows = await until(async () => {
          const r = await pendingRows(page);
          return r.length === 1 && r[0].pill === 'Unknown outcome' ? r : null;
        }, 'the unsupported dispatch to be reported as an unknown outcome');
        assert.match(rows[0].fail, /hub_correlation_id/, `the row did not say why: ${rows[0].fail}`);
        assert.deepStrictEqual(rows[0].done, ['Dispatched'], 'an unprovable dispatch claimed progress it cannot prove');
        assert.ok(rows[0].retry, 'an unknown outcome offers no way to check again');
        await until(async () => (await realSessionRows(page)).length === 1, 'the lookalike session to show on its own');
        assert.strictEqual((await pendingRows(page)).length, 1,
          'a same-repo/same-issue aca- device was guessed to be this dispatch');
        const broken = hub.errors.filter((e) => !/favicon/i.test(e));
        assert.deepStrictEqual(broken, [], `the unsupported flow logged console errors: ${broken.join(' | ')}`);
      } finally {
        await hub.close();
      }
    });

    await check('a run that finishes without the job attaching shows Dispatch failed with its reason, and Check again follows a rerun (#178)', async () => {
      const hub = await acaHub(browser, 'failed-run');
      const { page } = hub;
      try {
        await dispatchAcaJob(page, 'A run that ends badly');
        hub.app.setRun(1, { state: 'completed', conclusion: 'failure' });
        await refreshNow(page);
        const failed = await until(async () => {
          const r = await pendingRows(page);
          return r.length === 1 && r[0].pill === 'Dispatch failed' ? r : null;
        }, 'the failed run to be reported');
        assert.match(failed[0].fail, /finished \(failure\)/, `no reason shown: ${failed[0].fail}`);
        assert.ok(failed[0].retry, 'a failed dispatch offers no Check again');

        // A manual rerun is a new run attempt; the job it starts is a new
        // execution, so the row follows it rather than staying failed.
        hub.app.setRun(1, { runAttempt: 2, state: 'in_progress', conclusion: null, executionName: ACA_EXEC });
        await page.click('[data-aca-retry]');
        const rerun = await until(async () => {
          const r = await pendingRows(page);
          return r.length === 1 && r[0].now.includes('Attached') ? r : null;
        }, 'the rerun to be followed after Check again');
        assert.strictEqual(rerun[0].pill, 'Queued on ACA');
        attachAcaDevice(hub, `aca-${ACA_EXEC}`, 'sess-rerun-1', {});
        await refreshNow(page);
        await until(async () => ((await pendingRows(page)).length === 0
          && (await realSessionRows(page)).length === 1), 'the rerun job to attach');
        const broken = hub.errors.filter((e) => !/favicon/i.test(e));
        assert.deepStrictEqual(broken, [], `the failed-run flow logged console errors: ${broken.join(' | ')}`);
      } finally {
        await hub.close();
      }
    });

    await check('existing-issue mode survives the no-GitHub-App fallback, and opens that exact issue (#178)', async () => {
      // #178's release-gate review: the redesigned dialog moved the Issue
      // picker INSIDE #acaForm, so a hub with no GitHub App configured lost
      // the ability to pick "Existing issue" at all -- acaReviewLink always
      // built a brand-new-issue URL regardless of what was selected. This
      // proves both halves of the fix: the picker survives the disabled
      // state, and the fallback link actually branches on it.
      const authNoApp = new Authenticator({ mode: MODES.DEV, devSecret: 'aca-noapp', deviceSecret: 'aca-noapp-dev' });
      const svcNoApp = new HubService({ auth: authNoApp, serveWeb: true });
      const addrNoApp = await svcNoApp.listen(0, '127.0.0.1');
      const originNoApp = `http://127.0.0.1:${addrNoApp.port}`;
      const tokenNoApp = authNoApp.mintDevToken('t-noapp', 'u-noapp', 'noapp tester');
      const pageNoApp = await browser.newPage();
      try {
        await gotoSettled(pageNoApp, `${originNoApp}/?token=${tokenNoApp}`);
        await pageNoApp.waitForSelector('#who', { timeout: 15000 });
        await pageNoApp.click('#newMoreBtn');
        await pageNoApp.click('[data-new="aca"]');
        await pageNoApp.waitForSelector('#acaDisabledNote:not([hidden])', { timeout: 10000 });

        const issuePickerVisible = await pageNoApp.evaluate(() => (
          document.getElementById('acaIssueModeExisting').offsetParent !== null
        ));
        assert.ok(issuePickerVisible, 'the Issue mode picker hid along with the rest of the disabled form');

        await pageNoApp.fill('#acaRepo', 'acme/widgets');
        await pageNoApp.click('#acaIssueModeExisting');
        await pageNoApp.fill('#acaIssueNumber', '72');
        const [popup] = await Promise.all([
          pageNoApp.waitForEvent('popup'),
          pageNoApp.click('#acaReviewLink'),
        ]);
        const popupUrl = popup.url();
        await popup.close();
        assert.strictEqual(popupUrl, 'https://github.com/acme/widgets/issues/72',
          `existing-issue mode did not open that exact issue: ${popupUrl}`);
      } finally {
        await pageNoApp.close();
        await svcNoApp.close();
      }
    });

    await check('the /squad-aca command preview is visible and live, and survives a denied clipboard (#178)', async () => {
      // Restored by #178's release-gate review: the redesigned dialog copied
      // the command silently on click with nothing shown beforehand. A
      // denied/never-granted clipboard permission (every headless-Chromium
      // run, and plenty of real browser sessions -- see copyToClipboard's
      // own doc comment in util.js) must still leave something selectable.
      const authCmd = new Authenticator({ mode: MODES.DEV, devSecret: 'aca-cmd', deviceSecret: 'aca-cmd-dev' });
      const svcCmd = new HubService({ auth: authCmd, serveWeb: true });
      const addrCmd = await svcCmd.listen(0, '127.0.0.1');
      const originCmd = `http://127.0.0.1:${addrCmd.port}`;
      const tokenCmd = authCmd.mintDevToken('t-cmd', 'u-cmd', 'cmd tester');
      const pageCmd = await browser.newPage();
      // Force BOTH copy paths to fail: the Clipboard API (as a denied/never
      // -granted permission would) and the execCommand('copy') fallback
      // copyToClipboard itself falls back to -- so the only way the toast
      // can report success is if the real browser clipboard genuinely
      // worked, never a false positive from this test's own environment.
      await pageCmd.addInitScript(() => {
        if (navigator.clipboard) {
          navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
        }
        document.addEventListener('DOMContentLoaded', () => {
          const realExec = document.execCommand.bind(document);
          document.execCommand = (cmd, ...rest) => (cmd === 'copy' ? false : realExec(cmd, ...rest));
        });
      });
      try {
        await gotoSettled(pageCmd, `${originCmd}/?token=${tokenCmd}`);
        await pageCmd.waitForSelector('#who', { timeout: 15000 });
        await pageCmd.click('#newMoreBtn');
        await pageCmd.click('[data-new="aca"]');
        await pageCmd.waitForSelector('#acaScrim:not([hidden])', { timeout: 5000 });

        await pageCmd.fill('#acaPrompt', 'Investigate the flaky upload test');
        const preview = await pageCmd.textContent('#acaCmdPreview');
        assert.strictEqual(preview.trim(), '/squad-aca Investigate the flaky upload test',
          `the command preview did not update live from Instructions: ${preview}`);

        await pageCmd.click('#acaCopyLink');
        await pageCmd.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
        const toastText = await pageCmd.textContent('#toast');
        assert.match(toastText, /[Ss]elect and copy/, `a denied clipboard was not reported honestly: ${toastText}`);
      } finally {
        await pageCmd.close();
        await svcCmd.close();
      }
    });


    // ---- "Squad on ACA" status card: Checking and Connected (#180) --------
    // A second, independent hub -- its own HubService, its own browser page
    // -- with a real `GitHubApp` behind it, pointed at a local stand-in for
    // api.github.com (`acaFakeGitHubServer`, same technique as
    // test/github-app-unit.js's own `fakeGitHubApp`). The main `svc` above
    // never configures a GitHub App at all, so this is the only way to
    // reach the Connected phase from a real browser; the Checking phase is
    // reached by delaying `GET /api/aca/repos` on the FIRST load, the one
    // moment the real app actually shows it before a fetch resolves either
    // way.
    await check('the status card runs through Checking, then settles on Connected (#180)', async () => {
      const ghServer = acaFakeGitHubServer();
      const ghPort = await listen(ghServer);
      const githubApp = new GitHubApp({
        appId: '1', privateKey: ACA_FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${ghPort}`,
      });
      const authAca = new Authenticator({ mode: MODES.DEV, devSecret: 'e2e-aca', deviceSecret: 'e2e-aca-dev' });
      const svcAca = new HubService({ auth: authAca, serveWeb: true, githubApp });
      const addrAca = await svcAca.listen(0, '127.0.0.1');
      const originAca = `http://127.0.0.1:${addrAca.port}`;
      const tokenAca = authAca.mintDevToken('t-aca', 'u-aca', 'aca person');
      const pageAca = await browser.newPage();
      const errorsAca = [];
      pageAca.on('console', (m) => { if (m.type() === 'error') errorsAca.push(m.text()); });
      pageAca.on('pageerror', (e) => errorsAca.push(`pageerror: ${e.message}`));
      try {
        // Delay only the FIRST `GET /api/aca/repos` so the Checking phase
        // has a real window to be observed in, rather than racing a fetch
        // that answers before the next animation frame paints anything.
        let repoCalls = 0;
        await pageAca.route('**/api/aca/repos', async (route) => {
          repoCalls += 1;
          if (repoCalls === 1) await new Promise((r) => { setTimeout(r, 800); });
          route.continue();
        });

        await gotoSettled(pageAca, `${originAca}/?token=${tokenAca}`);
        await pageAca.waitForSelector('#acaStatusCard .acacard', { timeout: 10000 });

        const sawChecking = await until(async () => {
          const t = await pageAca.$eval('#acaStatusCard .status', (el) => el.textContent).catch(() => null);
          return t && /Checking/.test(t) ? true : null;
        }, 'the card to show Checking while the delayed fetch is still in flight', 5000);
        assert.ok(sawChecking, 'the card never showed Checking at all, even with the fetch delayed 800ms');

        // Scoped to the card's OWN status span (`.status.done`), not the
        // whole card's text -- the watcher/Ralph rows below legitimately say
        // "Not connected" too, for the device roster, which must not be
        // confused with the App-connection phase asserted here.
        await until(async () => {
          const t = await pageAca.$eval('#acaStatusCard .status', (el) => el.textContent).catch(() => null);
          return t && /^Connected$/.test(t.trim()) ? true : null;
        }, 'the card to settle on Connected once the delayed fetch resolves');
        const connectedTxt = await pageAca.textContent('#acaStatusCard');
        assert.match(connectedTxt, /Issue watcher/, 'no Issue watcher row once connected');
        assert.match(connectedTxt, /Ralph/, 'no Ralph row once connected');
        assert.match(connectedTxt, /Last dispatch/, 'no Last dispatch row once connected');
        // No squad-on-aca devices are attached to this hub, so the two
        // device-backed rows correctly say "Not connected" for THEM, which
        // is distinct from (and must not be confused with) the card's own
        // overall Connected phase asserted above.
        assert.match(connectedTxt, /No dispatches yet/, 'no dispatches were ever made against this fake, so the row should say so');

        const before = repoCalls;
        const urlBefore = pageAca.url();
        await pageAca.click('#acaStatusCard [data-action="aca-retry"]');
        await until(async () => (repoCalls > before ? true : null), 'Retry to issue a fresh GET /api/aca/repos');
        assert.strictEqual(pageAca.url(), urlBefore, 'Retry navigated the page instead of just re-fetching');
        await pageAca.waitForSelector('#acaStatusCard .acacard', { timeout: 10000 });

        const broken = errorsAca.filter((e) => !/favicon/i.test(e));
        assert.deepStrictEqual(broken, [], `the ACA-connected page reported errors: ${broken.join(' | ')}`);
      } finally {
        await pageAca.close();
        await svcAca.close();
        ghServer.close();
      }
    });

    // ---- "Squad on ACA" status card: real device shape, approval mode, and
    // sweep-vs-heartbeat wording (#180, #233) ---------------------------------
    // A Scout review on commit 69cd12d found the card lying in three ways: it
    // matched watcher/Ralph devices against `/watcher/i` and `/ralph/i`, which
    // the ACTUAL production device name --
    // `aca-ca-squad-aca-watch--0000016-f4848bdc9-c77w5` -- never matches (it
    // says "watch", not "watcher"), so the real card showed "Not connected"
    // against a device that genuinely was connected; it always labeled the
    // watcher "watch-only" regardless of the device's real approval mode; and
    // it displayed Ralph's bare heartbeat as "Last sweep", which proves only
    // that Ralph is alive, not that a sweep ran. This check registers devices
    // shaped exactly like real production records -- through the same
    // `store.registerDevice` a real device socket calls, never by poking the
    // DOM or faking a fetch response -- and drives a real browser against the
    // resulting `/api/overview` to prove the rendered card tells the truth.
    //
    // A follow-up Scout review on 87f7f98 found this check itself broken on
    // real CI (both node18 and node24): `svcAca2` was built with no
    // `GitHubApp` at all, so `GET /api/aca/status` correctly answered
    // `enabled: false` and the card never left the Not-connected phase --
    // the Connected-only watcher/Ralph rows this check waits for can never
    // appear on a hub that never reports itself connected. Fixed by reusing
    // the SAME configured-`GitHubApp`-plus-local-fake-server fixture as the
    // immediately preceding "Checking, then settles on Connected" check
    // (`acaFakeGitHubServer`), rather than inventing a second way to fake
    // discovery or skipping the assertion: the watcher/Ralph rows below are
    // still driven by real `store.registerDevice`/`heartbeat` calls and a
    // real rendered `#acaStatusCard`, only the App-connection half of the
    // phase is now real too.
    //
    // A THIRD Scout review on 35fdaaf found this check broken on real CI
    // AGAIN, in a different way: it called `svcAca2.store.heartbeat(...)`
    // directly to report the verified `approvalMode`/`lastSweepAt` facts.
    // `store.heartbeat` only ever updates the STORE -- it is `HubService`'s
    // own device-socket frame handler (`_fromDevice`'s `case 'heartbeat':`)
    // that broadcasts the refreshed `{ type: 'overview', ... }` payload to
    // every connected watcher (the browser page's own live socket) -- so a
    // store-only call left the already-rendered card waiting on its next
    // periodic poll to notice anything changed, and that poll is 15 seconds
    // out while the `until()` below gave up after 10. Fixed by attaching two
    // REAL, authenticated device sockets (`HubLink`, the same class the real
    // daemon/cloud-device uses to talk to a hub) for the watcher and Ralph
    // devices, and sending `register`/`heartbeat` FRAMES over them exactly as
    // a real device would -- which drives the genuine
    // `_attachDevice`/`_fromDevice`/`_broadcast` path and pushes the update
    // to the browser immediately, not on a timer.
    await check('the status card tells the truth about a real-shaped watcher and Ralph device (#180, #233)', async () => {
      const ghServer2 = acaFakeGitHubServer();
      const ghPort2 = await listen(ghServer2);
      const githubApp2 = new GitHubApp({
        appId: '1', privateKey: ACA_FAKE_PRIVATE_KEY_PEM, apiBase: `http://127.0.0.1:${ghPort2}`,
      });
      const authAca2 = new Authenticator({ mode: MODES.DEV, devSecret: 'e2e-aca-2', deviceSecret: 'e2e-aca-2-dev' });
      const svcAca2 = new HubService({ auth: authAca2, serveWeb: true, githubApp: githubApp2 });
      const addrAca2 = await svcAca2.listen(0, '127.0.0.1');
      const originAca2 = `http://127.0.0.1:${addrAca2.port}`;
      const tokenAca2 = authAca2.mintDevToken('t-aca2', 'u-aca2', 'aca person 2');
      const wsOriginAca2 = originAca2.replace('http', 'ws');

      const WATCH_DEVICE_ID = 'aca-ca-squad-aca-watch--0000016-f4848bdc9-c77w5';
      const RALPH_DEVICE_ID = 'aca-ca-squad-aca-ralph--0000031-9a8b7c6d-x1y2z';

      // Two real device sockets, attached and registered exactly as a real
      // squad-on-aca Container App Job would -- the literal name Scout's
      // review quoted from the real record, with no approval metadata
      // reported at register time -- the "unknown, never a false label" case.
      const watchLink = new HubLink({ url: `${wsOriginAca2}/ws`, token: tokenAca2, deviceId: WATCH_DEVICE_ID });
      const ralphLink = new HubLink({ url: `${wsOriginAca2}/ws`, token: tokenAca2, deviceId: RALPH_DEVICE_ID });
      await watchLink.connect();
      await ralphLink.connect();
      watchLink.send({ type: 'register', device: { name: WATCH_DEVICE_ID, platform: 'linux', meta: null } });
      // The established "squad-aca-ralph" job naming convention, heartbeating
      // (lastSeen set by the register frame itself) but never reporting a
      // confirmed `lastSweepAt` -- the heartbeat-is-not-a-sweep case.
      ralphLink.send({ type: 'register', device: { name: RALPH_DEVICE_ID, platform: 'linux', meta: null } });

      const pageAca2 = await browser.newPage();
      const errorsAca2 = [];
      pageAca2.on('console', (m) => { if (m.type() === 'error') errorsAca2.push(m.text()); });
      pageAca2.on('pageerror', (e) => errorsAca2.push(`pageerror: ${e.message}`));
      try {
        await gotoSettled(pageAca2, `${originAca2}/?token=${tokenAca2}`);
        await pageAca2.waitForSelector('#acaStatusCard .acacard', { timeout: 10000 });

        await until(async () => {
          const t = await pageAca2.$eval('#acaStatusCard .status', (el) => el.textContent).catch(() => null);
          return t && /^Connected$/.test(t.trim()) ? true : null;
        }, 'the card to report Connected once the configured GitHub App answers');

        await until(async () => {
          const t = await pageAca2.textContent('#acaStatusCard').catch(() => null);
          return t && /Issue watcher/.test(t) ? true : null;
        }, 'the watcher row to render at all');

        const textNoMeta = await pageAca2.textContent('#acaStatusCard');
        assert.doesNotMatch(textNoMeta, /Issue watcher[^\n]*Not connected/,
          'the real production device name (no "watcher" substring) was not matched -- the exact bug Scout flagged');
        assert.doesNotMatch(textNoMeta, /watch-only/,
          'watch-only was claimed with no approvalMode reported at all -- that is a guess, not a verified fact');
        assert.doesNotMatch(textNoMeta, /Ralph[^\n]*Last sweep/,
          'a bare heartbeat was reported as "Last sweep" -- heartbeat proves liveness, not that a sweep ran');
        assert.match(textNoMeta, /no sweep confirmed/,
          'Ralph heartbeating with no lastSweepAt must say so honestly, not imply a sweep happened');

        // Now report the device-side facts a real device would send on its
        // next heartbeat: a VERIFIED auto approval mode, and a VERIFIED sweep
        // timestamp -- sent as real `heartbeat` FRAMES over the same device
        // sockets, so the hub's own `_fromDevice` broadcasts the refreshed
        // overview to the page immediately, the same as a real daemon's
        // 15-second heartbeat would once it next fires.
        watchLink.send({ type: 'heartbeat', device: { meta: { approvalMode: 'auto' } } });
        ralphLink.send({ type: 'heartbeat', device: { meta: { lastSweepAt: new Date().toISOString() } } });

        await until(async () => {
          const t = await pageAca2.textContent('#acaStatusCard').catch(() => null);
          return t && /watch-only/.test(t) ? true : null;
        }, 'watch-only to appear once the device verifies approvalMode: auto', 10000);
        const textWithMeta = await pageAca2.textContent('#acaStatusCard');
        assert.match(textWithMeta, /Last sweep/,
          'a verified lastSweepAt must render as "Last sweep", not a bare heartbeat label');
        assert.doesNotMatch(textWithMeta, /no sweep confirmed/,
          'a verified lastSweepAt is still being reported as unconfirmed');

        const broken2 = errorsAca2.filter((e) => !/favicon/i.test(e));
        assert.deepStrictEqual(broken2, [], `the real-shaped-device page reported errors: ${broken2.join(' | ')}`);
      } finally {
        await pageAca2.close();
        watchLink.stop();
        ralphLink.stop();
        await svcAca2.close();
        ghServer2.close();
      }
    });

    // -----------------------------------------------------------------------
    // READY FOR REVIEW AND SQUAD HEALTH (#179), driven in a real browser.
    //
    // A hub of its own with one real device socket, so every session below is
    // published exactly as a device publishes it (`register`, then `session`
    // frames) and reaches the page through the hub's own routes and its live
    // socket. Nothing is injected into the DOM: the rows, the pill, the link,
    // the filter and the health badge are all what the app drew from that data.
    // -----------------------------------------------------------------------
    const RV_PR = {
      url: 'https://github.com/acme/widgets/pull/179', number: 179, title: 'Ready for review & health',
    };
    const RV_FAILING = {
      status: 'fail',
      checks: [
        { id: 'routing', status: 'fail' }, { id: 'state-backend', status: 'fail' },
        { id: 'docs', status: 'pass' }, { id: 'lint', status: 'skip' },
      ],
    };
    const RV_PASSING = { status: 'pass', checks: [{ id: 'routing', status: 'pass' }, { id: 'docs', status: 'pass' }] };
    const rvSquad = (health) => ({
      isSquad: true, project: 'widgets', memberCount: 6, activeMembers: 0, decisionCount: 4, health,
    });
    const rvSession = (id, over) => ({
      id, status: 'done', prompt: `rv ${id}`, cwd: '/work/widgets', agent: 'Copilot CLI',
      startedAt: Date.now() - 60000, toolCallCount: 3, pendingApprovals: [], pullRequest: null, ...over,
    });
    const rvKey = (id) => `rv-device:${id}`;
    const rv = {};

    await check('a Ready for review fixture starts: a hub, a device, and sessions in every state that matters', async () => {
      const authRv = new Authenticator({ mode: MODES.DEV, devSecret: 'e2e-rv', deviceSecret: 'e2e-rv-dev' });
      rv.svc = new HubService({ auth: authRv, serveWeb: true, persistStore: false, persistDeviceTokens: false });
      // Presence is read from the clock, so the last check below can make the
      // device unreachable in seconds rather than minutes. The device
      // heartbeats until then, as a real daemon does, so it stays online.
      rv.svc.store.staleAfterMs = 2000;
      rv.svc.store.offlineAfterMs = 4000;
      const addrRv = await rv.svc.listen(0, '127.0.0.1');
      rv.origin = `http://127.0.0.1:${addrRv.port}`;
      rv.token = authRv.mintDevToken('t-rv', 'u-rv', 'rv person');
      rv.link = new HubLink({
        url: `${rv.origin.replace('http', 'ws')}/ws`, token: rv.token, deviceId: 'rv-device',
      });
      await rv.link.connect();
      rv.link.send({ type: 'register', device: { name: 'RV Device', platform: 'linux', meta: null } });
      rv.send = (session) => rv.link.send({ type: 'session', session });
      rv.beat = setInterval(() => { try { rv.link.send({ type: 'heartbeat', device: {} }); } catch { /* socket closed */ } }, 300);
      rv.send(rvSession('ready', { prompt: 'Ship the ready for review pill', pullRequest: RV_PR, squad: rvSquad(RV_FAILING) }));
      rv.send(rvSession('failed-pr', { status: 'failed', prompt: 'A failed run that opened a PR', pullRequest: { ...RV_PR, number: 180, url: 'https://github.com/acme/widgets/pull/180' } }));
      rv.send(rvSession('working', { status: 'active', prompt: 'Still working on it', pullRequest: { ...RV_PR, number: 181, url: 'https://github.com/acme/widgets/pull/181' }, squad: rvSquad(RV_PASSING) }));
      rv.send(rvSession('idle', { status: 'idle', prompt: 'Waiting on your answer', pullRequest: { ...RV_PR, number: 182, url: 'https://github.com/acme/widgets/pull/182' } }));
      rv.send(rvSession('no-pr', { prompt: 'Done, but no pull request' }));
      rv.send(rvSession('bad-pr', { prompt: 'Done, with a pull request nobody should open', pullRequest: { url: 'javascript:alert(1)', number: 9, title: 'x' } }));
      rv.page = await browser.newPage();
      rv.errors = [];
      rv.page.on('console', (m) => { if (m.type() === 'error') rv.errors.push(m.text()); });
      rv.page.on('pageerror', (e) => rv.errors.push(`pageerror: ${e.message}`));
      // A 409 is the hub saying "that device is not connected", which the app
      // reports on screen. The browser still logs it as a resource error, so the
      // last check below accounts for each one rather than ignoring the kind.
      rv.conflicts = [];
      rv.page.on('response', (r) => { if (r.status() === 409) rv.conflicts.push({ url: r.url(), gone: !!rv.gone }); });
      rv.csp = await watchCsp(rv.page);
      // A pull request link opens github.com in a new tab; nothing here may
      // reach the real one.
      await rv.page.context().route('https://github.com/**', (route) => route.fulfill({
        status: 200, contentType: 'text/html', body: '<title>a pull request</title>',
      }));
      await gotoSettled(rv.page, `${rv.origin}/?token=${rv.token}`);
      await until(async () => (await rv.page.$$('#groups .row')).length >= 6 || null, 'all six sessions to render');
    });

    /** What one row says, read from the DOM the way a person reads it. */
    const rvRow = (id, pg) => (pg || rv.page).evaluate((key) => {
      const row = document.querySelector(`#groups .row[data-session="${key}"]`);
      if (!row) return null;
      const pill = row.querySelector(':scope > .status');
      const link = row.querySelector('a[data-pr-link]');
      const health = row.querySelector('.health');
      return {
        rowClass: row.className,
        rowEdge: getComputedStyle(row).boxShadow,
        pill: pill && pill.textContent.trim(),
        pillClass: pill && pill.className,
        pillHeight: pill && Math.round(pill.getBoundingClientRect().height),
        pillTag: pill && pill.tagName,
        pillColor: pill && getComputedStyle(pill).color,
        link: link && {
          href: link.getAttribute('href'), target: link.target, rel: link.rel, text: link.textContent.trim(),
          aria: link.getAttribute('aria-label'), title: link.title,
        },
        health: health && {
          text: health.textContent.trim(), title: health.title, tag: health.tagName, cls: health.className,
          role: health.getAttribute('role'), tabindex: health.getAttribute('tabindex'),
        },
      };
    }, rvKey(id));

    const rvViolet = () => rv.page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--violet)';
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });

    await check('an ended session with a pull request reads "Ready for review": a violet 22px pill, a violet row, an Open PR link (#179)', async () => {
      assert.ok(rv.page, 'the fixture did not start');
      const row = await rvRow('ready');
      assert.ok(row, 'the ready session has no row');
      assert.strictEqual(row.pill, 'Ready for review');
      assert.match(row.pillClass, /\bready\b/);
      assert.ok(/\bready\b/.test(row.rowClass), `the row is not marked ready: ${row.rowClass}`);
      assert.strictEqual(row.pillColor, await rvViolet(), 'the pill is not the violet of the design');
      assert.ok(row.rowEdge.includes(await rvViolet()) && /\b3px\b/.test(row.rowEdge), `the row has no violet edge: "${row.rowEdge}"`);
      assert.strictEqual(row.pillHeight, 22, `a pill is 22px tall, this one is ${row.pillHeight}px`);
      assert.notStrictEqual(row.pillTag, 'BUTTON', 'the pill is a button');
      assert.ok(row.link, 'the row has no Open PR link');
      assert.strictEqual(row.link.href, RV_PR.url);
      assert.strictEqual(row.link.text, 'Open PR ↗');
      assert.strictEqual(row.link.target, '_blank');
      assert.ok(/noopener/.test(row.link.rel) && /noreferrer/.test(row.link.rel), `rel is "${row.link.rel}"`);
      assert.match(row.link.title, /#179/);
      assert.match(row.link.aria, /Open PR #179/);
    });

    await check('"ended" includes a run that failed, so a failed run with a pull request is ready for review too (#179)', async () => {
      const row = await rvRow('failed-pr');
      assert.strictEqual(row.pill, 'Ready for review');
      assert.strictEqual(row.link && row.link.href, 'https://github.com/acme/widgets/pull/180');
    });

    await check('a session still going, one awaiting your reply, one with no pull request and one with an unusable one are NOT ready (#179)', async () => {
      for (const [id, want] of [['working', null], ['idle', /awaiting/i], ['no-pr', null], ['bad-pr', null]]) {
        const row = await rvRow(id);
        assert.ok(row, `${id} has no row`);
        assert.ok(!/ready for review/i.test(row.pill), `${id} reads "${row.pill}"`);
        assert.ok(!/\bready\b/.test(row.rowClass) && !/\bready\b/.test(row.pillClass), `${id} is styled as ready`);
        assert.ok(!row.rowEdge.includes(await rvViolet()), `${id} carries the violet edge of a ready row: "${row.rowEdge}"`);
        assert.strictEqual(row.link, null, `${id} offers an Open PR link`);
        if (want) assert.match(row.pill, want);
      }
      const wrong = await rv.page.evaluate(() => [...document.querySelectorAll('a[data-pr-link]')]
        .filter((a) => !/^https:\/\/github\.com\/acme\/widgets\/pull\/\d+$/.test(a.getAttribute('href'))).length);
      assert.strictEqual(wrong, 0, 'a link that is not a github.com pull request reached the page');
    });

    await check('following Open PR opens the pull request in a new tab and does NOT open the session (#179)', async () => {
      const [popup] = await Promise.all([
        rv.page.context().waitForEvent('page', { timeout: 10000 }),
        rv.page.click(`#groups .row[data-session="${rvKey('ready')}"] a[data-pr-link]`),
      ]);
      try {
        await popup.waitForLoadState('domcontentloaded');
        assert.strictEqual(popup.url(), RV_PR.url);
        assert.strictEqual(await popup.evaluate(() => window.opener), null, 'the new tab can reach back to the hub');
      } finally {
        await popup.close();
      }
      assert.strictEqual(await rv.page.$eval('#detailScrim', (el) => el.hidden), true,
        'following the link also opened the session');
      assert.ok(!/session=/.test(rv.page.url()), `the address changed to ${rv.page.url()}`);
    });

    await check('the Status filter offers "Ready for review" once a session is ready, and choosing it keeps exactly those sessions (#179)', async () => {
      const shown = await rv.page.evaluate(() => {
        const o = document.getElementById('statusFilter').querySelector('option[value="review"]');
        return o && { hidden: o.hidden, text: o.text };
      });
      assert.ok(shown && shown.hidden === false, 'the option is still hidden with two ready sessions on screen');
      assert.strictEqual(shown.text, 'Ready for review');

      const asked = rv.page.waitForRequest((r) => /\/api\/overview\?.*status=review/.test(r.url()), { timeout: 10000 });
      await rv.page.click('#statusFilter >> xpath=..');
      await rv.page.click('.sp-opt >> text=Ready for review');
      await asked;
      const keys = await until(async () => {
        const k = await rv.page.evaluate(() => [...document.querySelectorAll('#groups .row')].map((r) => r.dataset.session).sort());
        return k.length === 2 ? k : null;
      }, 'the list to narrow to the two ready sessions');
      assert.deepStrictEqual(keys, [rvKey('failed-pr'), rvKey('ready')].sort());
      assert.strictEqual(await rv.page.$eval('#statusFilter', (el) => el.value), 'review');
    });

    await check('the review filter also holds against a live push, which the hub sends unfiltered (#179)', async () => {
      rv.send(rvSession('late-no-pr', { prompt: 'Finished without a pull request' }));
      rv.send(rvSession('late-ready', { prompt: 'Finished with a pull request', pullRequest: { ...RV_PR, number: 183, url: 'https://github.com/acme/widgets/pull/183' } }));
      await until(async () => (await rv.page.$(`#groups .row[data-session="${rvKey('late-ready')}"]`)) || null,
        'the newly ready session to join the filtered list');
      // Counts, never the handle itself: a failing assert would otherwise try to print a Playwright object graph.
      assert.strictEqual((await rv.page.$$(`#groups .row[data-session="${rvKey('late-no-pr')}"]`)).length, 0,
        'a session that is not ready joined the review list');
      assert.strictEqual((await rv.page.$$(`#groups .row[data-session="${rvKey('working')}"]`)).length, 0,
        'a working session joined the review list');
    });

    await check('the ready-for-review filter is a deep link, and the raw Done filter still lists a ready session, in the rows on screen (#179)', async () => {
      await gotoSettled(rv.page, `${rv.origin}/?status=review`);
      await until(async () => (await rv.page.$$('#groups .row')).length === 3 || null, 'the deep link to land on the review list');
      assert.strictEqual(await rv.page.$eval('#statusFilter', (el) => el.value), 'review');

      await rv.page.evaluate(() => {
        const sel = document.getElementById('statusFilter');
        sel.value = 'done';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const rows = () => rv.page.evaluate(() => [...document.querySelectorAll('#groups .row')].map((r) => r.dataset.session).sort());
      const done = ['ready', 'no-pr', 'bad-pr', 'late-no-pr', 'late-ready'].map(rvKey).sort();
      await until(async () => JSON.stringify(await rows()) === JSON.stringify(done) || null, 'the list to narrow to the done sessions');
      assert.ok(!(await rows()).includes(rvKey('failed-pr')), 'the Done filter listed a failed session');

      // The hub pushes every session, filter or no filter. A session that is not done must not slip onto the list
      // because a push replaced the narrowed answer: the next frame is drawn from the push, not the filtered fetch.
      rv.send(rvSession('push-active', { status: 'active', prompt: 'Pushed while Done is chosen' }));
      rv.send(rvSession('push-done', { prompt: 'Pushed done session' }));
      await until(async () => (await rows()).includes(rvKey('push-done')) || null, 'the pushed done session to join the Done list');
      const after = await rows();
      assert.ok(!after.includes(rvKey('push-active')), 'a session that is not done joined the Done list on a live push');
      assert.deepStrictEqual(after, [...done, rvKey('push-done')].sort());

      await rv.page.evaluate(() => {
        const sel = document.getElementById('statusFilter');
        sel.value = '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await until(async () => (await rv.page.$$('#groups .row')).length >= 8 || null, 'the unfiltered list to come back');
    });

    await check('a Squad session row shows "● healthy" or "● health: N failing", with the failing check ids in its tooltip (#179)', async () => {
      const failing = await rvRow('ready');
      assert.ok(failing.health, 'the failing Squad row has no health badge');
      assert.strictEqual(failing.health.text, '● health: 2 failing');
      assert.strictEqual(failing.health.title, 'Squad health: failing checks — routing, state-backend');
      assert.ok(/\bfailing\b/.test(failing.health.cls));
      const healthy = await rvRow('working');
      assert.strictEqual(healthy.health.text, '● healthy');
      assert.strictEqual(healthy.health.title, 'Squad health: healthy — no failing checks');
      assert.ok(/\bhealthy\b/.test(healthy.health.cls));
      const none = await rvRow('no-pr');
      assert.strictEqual(none.health, null, 'a session with no Squad health drew a badge');
    });

    await check('the health badge is an indicator, not a pill or a button, and it reads red when failing and green when healthy (#179)', async () => {
      const seen = await rv.page.evaluate(() => ['ready', 'working'].map((id) => {
        const el = document.querySelector(`#groups .row[data-session="rv-device:${id}"] .health`);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { tag: el.tagName, role: el.getAttribute('role'), tab: el.getAttribute('tabindex'), cursor: cs.cursor, color: cs.color, inStatus: !!el.closest('.status') };
      }));
      assert.ok(seen.every(Boolean), 'nothing was left to check, so this proves nothing');
      for (const h of seen) {
        assert.ok(h.tag !== 'BUTTON' && h.tag !== 'A' && h.role !== 'button' && h.tab == null && h.cursor !== 'pointer' && !h.inStatus,
          `the health badge behaves like a control: ${JSON.stringify(h)}`);
      }
      assert.notStrictEqual(seen[0].color, seen[1].color, 'healthy and failing look the same');
      const hue = (scheme) => rv.page.emulateMedia({ colorScheme: scheme }).then(() => rv.page.evaluate(() => {
        const cx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
        const rgb = (id) => {
          cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000';
          cx.fillStyle = getComputedStyle(document.querySelector(`#groups .row[data-session="rv-device:${id}"] .health`)).color;
          cx.fillRect(0, 0, 1, 1);
          return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        return { failing: rgb('ready'), healthy: rgb('working') };
      }));
      try {
        for (const scheme of ['dark', 'light']) {
          const { failing: [fr, fg, fb], healthy: [hr, hg, hb] } = await hue(scheme);
          assert.ok(fr - fg >= 40 && fr - fb >= 40, `the failing badge is not red in the ${scheme} theme: rgb(${fr}, ${fg}, ${fb})`);
          assert.ok(hg - hr >= 30 && hg > hb, `the healthy badge is not green in the ${scheme} theme: rgb(${hr}, ${hg}, ${hb})`);
        }
      } finally {
        await rv.page.emulateMedia({ colorScheme: null });
      }
    });

    await check('the detail page shows the violet pill, the Open PR link and the per-check health list in the Squad panel (#179)', async () => {
      // The page is judged the moment it first appears: a live push repairs a
      // missing link a moment later, and waiting for it would hide the gap.
      await rv.page.evaluate(() => {
        const scrim = document.getElementById('detailScrim');
        window.__rvFirstPaint = null;
        new MutationObserver((_, obs) => {
          if (scrim.hidden) return;
          obs.disconnect();
          const links = document.getElementById('dtLinks');
          const health = document.getElementById('dtSquadHealth');
          window.__rvFirstPaint = {
            link: !!links.querySelector('a[data-pr-link]'), linksHidden: links.hidden,
            healthHidden: health.hidden, checks: health.querySelectorAll('.sq-checks li').length,
          };
        }).observe(scrim, { attributes: true, attributeFilter: ['hidden'] });
      });
      await rv.page.click(`#groups .row[data-session="${rvKey('ready')}"] .row-title`);
      await rv.page.waitForSelector('#detailScrim:not([hidden])', { timeout: 10000 });
      const first = await rv.page.evaluate(() => window.__rvFirstPaint);
      assert.deepStrictEqual(first, { link: true, linksHidden: false, healthHidden: false, checks: 4 },
        'the detail page opened without its Open PR link and health list');
      const d = await until(async () => {
        const r = await rv.page.evaluate(() => {
          const links = document.getElementById('dtLinks');
          const a = links && links.querySelector('a[data-pr-link]');
          const pill = document.getElementById('dtStatusPill');
          const health = document.getElementById('dtSquadHealth');
          return {
            pill: pill.textContent.trim(), pillClass: pill.className, pillHeight: Math.round(pill.getBoundingClientRect().height),
            pillColor: getComputedStyle(pill).color,
            linksHidden: links.hidden, href: a && a.getAttribute('href'), target: a && a.target, rel: a && a.rel,
            healthHidden: health && health.hidden,
            badge: health && health.querySelector('.health') && health.querySelector('.health').textContent.trim(),
            checks: health ? [...health.querySelectorAll('.sq-checks li')].map((li) => `${li.querySelector('b').textContent}=${li.className}`) : [],
            inSquadPanel: !!(health && health.closest('#dtSquad')),
          };
        });
        return r.healthHidden === false ? r : null;
      }, 'the Squad panel to show the health list');
      assert.strictEqual(d.pill, 'Ready for review');
      assert.match(d.pillClass, /\bready\b/);
      assert.strictEqual(d.pillColor, await rvViolet());
      assert.strictEqual(d.pillHeight, 22);
      assert.strictEqual(d.linksHidden, false);
      assert.strictEqual(d.href, RV_PR.url);
      assert.strictEqual(d.target, '_blank');
      assert.ok(/noopener/.test(d.rel) && /noreferrer/.test(d.rel));
      assert.strictEqual(d.badge, '● health: 2 failing');
      assert.deepStrictEqual(d.checks, ['routing=fail', 'state-backend=fail', 'docs=pass', 'lint=skip']);
      assert.ok(d.inSquadPanel, 'the per-check list is not in the existing Squad panel');
    });

    await check('the detail page follows the session live: health recovers, and a lost pull request takes the link away (#179)', async () => {
      rv.send(rvSession('ready', { prompt: 'Ship the ready for review pill', pullRequest: RV_PR, squad: rvSquad(RV_PASSING) }));
      await until(async () => (await rv.page.$eval('#dtSquadHealth .health', (el) => el.textContent.trim()).catch(() => null)) === '● healthy' || null,
        'the open detail page to show the recovered health');
      assert.deepStrictEqual(await rv.page.$$eval('#dtSquadHealth .sq-checks li', (li) => li.map((e) => e.className)), ['pass', 'pass']);

      rv.send(rvSession('ready', { prompt: 'Ship the ready for review pill', pullRequest: null, squad: rvSquad({ status: 'unknown' }) }));
      await until(async () => (await rv.page.$eval('#dtLinks', (el) => el.hidden)) || null, 'the Open PR link to leave the open detail page');
      assert.strictEqual(await rv.page.$eval('#dtSquadHealth', (el) => el.hidden), true, 'an unknown health still draws a block');
      assert.notStrictEqual(await rv.page.$eval('#dtStatusPill', (el) => el.textContent.trim()), 'Ready for review');

      rv.send(rvSession('ready', { prompt: 'Ship the ready for review pill', pullRequest: RV_PR, squad: rvSquad(RV_FAILING) }));
      await until(async () => (await rv.page.$eval('#dtLinks', (el) => !el.hidden)) || null, 'the Open PR link to come back');
    });

    await check('every sidebar row on the detail page carries the same pill as the list (#179)', async () => {
      const pills = await rv.page.evaluate(() => {
        const row = document.querySelector(`#detailSidebarList [data-session="rv-device:ready"]`);
        const pill = row && row.querySelector('.status');
        return pill && pill.textContent.trim();
      });
      assert.strictEqual(pills, 'Ready for review');
    });

    /**
     * Everything about the Ready for review row (or the detail page) that a
     * person would call "broken": the page wider than the screen, a piece of it
     * outside the row or the screen, a link or badge that wrapped, a pill that
     * is not 22px or does not sit on the title's line, a title squeezed to
     * nothing, or text under 4.5:1 against what it sits on. Returns a list of
     * plain strings, so a failure says what was wrong instead of printing a
     * browser object.
     */
    const rvFit = (view) => rv.page.evaluate((which) => {
      const problems = [];
      const vw = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth > vw) {
        problems.push(`the page is ${document.documentElement.scrollWidth}px wide in a ${vw}px viewport`);
      }
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const cx = canvas.getContext('2d', { willReadFrequently: true });
      const rgba = (css) => {
        cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = css; cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };
      const backdrop = (el) => {
        const layers = [];
        for (let n = el; n; n = n.parentElement) {
          const c = rgba(getComputedStyle(n).backgroundColor);
          if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
        }
        let out = [255, 255, 255];
        for (let i = layers.length - 1; i >= 0; i--) {
          const [r, g, b, a] = layers[i];
          out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
        }
        return out;
      };
      const luminance = ([r, g, b]) => {
        const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const legible = (name, el) => {
        const hi = luminance(rgba(getComputedStyle(el).color)) + 0.05;
        const lo = luminance(backdrop(el)) + 0.05;
        const ratio = Math.max(hi, lo) / Math.min(hi, lo);
        if (ratio < 4.5) problems.push(`${name} has ${ratio.toFixed(2)}:1 contrast, under 4.5:1`);
      };
      const inside = (name, el, box) => {
        if (!el) { problems.push(`${name} is missing`); return null; }
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) problems.push(`${name} has no size`);
        else if (r.left < box.left - 0.5 || r.right > box.right + 0.5) {
          problems.push(`${name} spans ${Math.round(r.left)}..${Math.round(r.right)}, outside ${Math.round(box.left)}..${Math.round(box.right)}`);
        }
        return r;
      };
      const centre = (r) => r.top + r.height / 2;
      const screen = { left: 0, right: vw };

      if (which === 'list') {
        const row = document.querySelector('#groups .row[data-session="rv-device:ready"]');
        if (!row) return ['the ready row is missing'];
        const rowBox = inside('the row', row, screen);
        const pill = row.querySelector(':scope > .status');
        const link = row.querySelector('a[data-pr-link]');
        const health = row.querySelector('.health');
        const title = row.querySelector('.row-title');
        const pillBox = inside('the pill', pill, rowBox);
        inside('the Open PR link', link, rowBox);
        inside('the health badge', health, rowBox);
        const titleBox = inside('the title', title, rowBox);
        if (link && link.getClientRects().length !== 1) problems.push('the Open PR link wrapped');
        if (health && health.getClientRects().length !== 1) problems.push('the health badge wrapped');
        if (pillBox && Math.round(pillBox.height) !== 22) problems.push(`the pill is ${Math.round(pillBox.height)}px tall`);
        if (pillBox && titleBox && Math.abs(centre(pillBox) - centre(titleBox)) > 1) problems.push('the pill is not on the title\'s line');
        for (const [name, el] of [['the pill', pill], ['the Open PR link', link], ['the health badge', health]]) if (el) legible(name, el);
        return problems;
      }

      const pill = document.getElementById('dtStatusPill');
      const title = document.getElementById('dtTitle');
      const pillBox = inside('the pill', pill, screen);
      const titleBox = inside('the title', title, screen);
      if (titleBox && titleBox.width < 40) problems.push(`the title is squeezed to ${Math.round(titleBox.width)}px`);
      if (pillBox && Math.round(pillBox.height) !== 22) problems.push(`the pill is ${Math.round(pillBox.height)}px tall`);
      const line = ['dtBackPhone', 'dtStar', 'dtTitle', 'dtStatusPill']
        .map((id) => document.getElementById(id)).filter((el) => el && el.offsetParent !== null)
        .map((el) => centre(el.getBoundingClientRect()));
      if (Math.max(...line) - Math.min(...line) > 1) problems.push(`the header items do not share a line: ${line.map(Math.round).join(', ')}`);
      const link = document.querySelector('#dtLinks a[data-pr-link]');
      inside('the Open PR link', link, screen);
      inside('the health block', document.getElementById('dtSquadHealth'), screen);
      inside('the check list', document.querySelector('#dtSquadHealth .sq-checks'), screen);
      for (const id of ['dtAca', 'dtStop', 'dtMoreBtn']) {
        const el = document.getElementById(id);
        if (el && el.offsetParent !== null) inside(`#${id}`, el, screen);
      }
      for (const [name, el] of [['the pill', pill], ['the Open PR link', link], ['the health badge', document.querySelector('#dtSquadHealth .health')],
        ['a failing check', document.querySelector('#dtSquadHealth li.fail span')], ['a passing check', document.querySelector('#dtSquadHealth li.pass span')],
        ['the health label', document.querySelector('#dtSquadHealth .sq-hlabel')]]) if (el) legible(name, el);
      return problems;
    }, view);

    await check('at 1280, 900 and 390px, dark and light, the Ready for review row and detail page fit: nothing overflows, wraps, misaligns or loses contrast (#179)', async () => {
      try {
        for (const view of ['list', 'detail']) {
          if (view === 'list') await gotoSettled(rv.page, `${rv.origin}/?token=${rv.token}`);
          else await gotoSettled(rv.page, `${rv.origin}/?session=${encodeURIComponent(rvKey('ready'))}`);
          await rv.page.waitForSelector(view === 'list' ? '#groups .row' : '#detailScrim:not([hidden])', { timeout: 20000 });
          await until(async () => (await rv.page.$$(view === 'list' ? '#groups .row a[data-pr-link]' : '#dtLinks a[data-pr-link]')).length || null,
            'the Open PR link to be drawn');
          await rv.page.waitForSelector(view === 'list' ? '#groups .row .health' : '#dtSquadHealth .health', { timeout: 10000 });
          for (const width of [1280, 900, 390]) {
            // The third pass is a person who chose Light on a dark system: the
            // explicit `data-theme` block of tokens.css, which the two system
            // passes never reach.
            for (const [scheme, os, chosen] of [['dark', 'dark', null], ['light', 'light', null], ['chosen light', 'dark', 'light']]) {
              await rv.page.setViewportSize({ width, height: 900 });
              await rv.page.emulateMedia({ colorScheme: os });
              await rv.page.evaluate((t) => {
                if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
                return new Promise((r) => requestAnimationFrame(r));
              }, chosen);
              const problems = await rvFit(view);
              assert.deepStrictEqual(problems, [], `${view} at ${width}px in the ${scheme} theme: ${problems.join('; ')}`);
            }
          }
        }
      } finally {
        await rv.page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
        await rv.page.emulateMedia({ colorScheme: null });
        await rv.page.setViewportSize({ width: 1280, height: 900 });
      }
    });

    await check('the Ready for review states are captured at 1280, 900 and 390px, dark and light, when a folder is given (#179)', async () => {
      const outDir = process.env.SQUAD_HUB_SCREENSHOT_DIR;
      if (!outDir) { assert.ok(true); return; }
      assert.ok(fs.statSync(outDir).isDirectory(), `SQUAD_HUB_SCREENSHOT_DIR is not a directory: ${outDir}`);
      const shots = [
        { width: 1280, height: 900, scheme: 'dark', suffix: 'desktop-dark' },
        { width: 1280, height: 900, scheme: 'light', suffix: 'desktop-light' },
        { width: 900, height: 800, scheme: 'dark', suffix: 'tablet-900-dark' },
        { width: 900, height: 800, scheme: 'light', suffix: 'tablet-900-light' },
        { width: 390, height: 844, scheme: 'dark', suffix: 'phone-390-dark' },
        { width: 390, height: 844, scheme: 'light', suffix: 'phone-390-light' },
      ];
      try {
        for (const view of ['list', 'detail']) {
          if (view === 'list') await gotoSettled(rv.page, `${rv.origin}/?token=${rv.token}`);
          else await gotoSettled(rv.page, `${rv.origin}/?session=${encodeURIComponent(rvKey('ready'))}`);
          await rv.page.waitForSelector(view === 'list' ? '#groups .row' : '#detailScrim:not([hidden])', { timeout: 20000 });
          await until(async () => (await rv.page.$$(view === 'list' ? '#groups .row a[data-pr-link]' : '#dtLinks a[data-pr-link]')).length || null,
            'the Open PR link to be drawn');
          await rv.page.waitForSelector(view === 'list' ? '#groups .row .health' : '#dtSquadHealth .health', { timeout: 10000 });
          for (const shot of shots) {
            await rv.page.setViewportSize({ width: shot.width, height: shot.height });
            await rv.page.emulateMedia({ colorScheme: shot.scheme });
            await rv.page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
            const file = path.join(outDir, `${view}-${shot.suffix}.png`);
            await rv.page.screenshot({ path: file });
            assert.ok(fs.statSync(file).size > 0, `${file} was written empty`);
          }
        }
      } finally {
        await rv.page.emulateMedia({ colorScheme: null });
        await rv.page.setViewportSize({ width: 1280, height: 900 });
      }
    });

    await check('a pending approval outranks Ready for review: the row stays amber, reads "Needs approval" and offers no link (#179)', async () => {
      await gotoSettled(rv.page, `${rv.origin}/?token=${rv.token}`);
      await rv.page.waitForSelector('#groups .row', { timeout: 10000 });
      rv.send(rvSession('pending', {
        status: 'waiting_approval', prompt: 'Waiting on an approval', pullRequest: { ...RV_PR, number: 190, url: 'https://github.com/acme/widgets/pull/190' },
        pendingApprovals: [{ approvalId: 'ap-rv', title: 'Run the tests', command: 'npm test', requestedAt: Date.now(), options: [{ id: 'allow_once', label: 'Allow once' }] }],
      }));
      const row = await until(async () => {
        const r = await rvRow('pending');
        return r && /approval/i.test(r.pill) ? r : null;
      }, 'the pending session to show its approval');
      assert.ok(/\battention\b/.test(row.rowClass) && !/\bready\b/.test(row.rowClass), `row class: ${row.rowClass}`);
      assert.strictEqual(row.link, null);
    });

    await check('an unreachable device outranks everything: its live session reads Unreachable, an ended one stays Ready for review (#179)', async () => {
      clearInterval(rv.beat);
      rv.link.stop();
      rv.gone = true;
      await new Promise((r) => setTimeout(r, rv.svc.store.offlineAfterMs + 700));
      await gotoSettled(rv.page, `${rv.origin}/?token=${rv.token}`);
      const idle = await until(async () => {
        const r = await rvRow('idle');
        return r && /unreachable/i.test(r.pill) ? r : null;
      }, 'the idle session to read Unreachable once its device went quiet');
      assert.ok(/\bstale\b/.test(idle.pillClass), `the pill class is "${idle.pillClass}"`);
      assert.strictEqual(idle.link, null);
      const ready = await rvRow('ready');
      assert.strictEqual(ready.pill, 'Ready for review', 'an ended session lost its pill when the device went away');
      assert.ok(ready.link, 'an ended session lost its link when the device went away');
    });

    await check('a stale session shows every header action at once and still fits a phone, because the actions take their own line (#179)', async () => {
      try {
        await rv.page.setViewportSize({ width: 390, height: 900 });
        await gotoSettled(rv.page, `${rv.origin}/?session=${encodeURIComponent(rvKey('idle'))}`);
        await rv.page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
        const seen = await until(async () => {
          const r = await rv.page.evaluate(() => {
            const vw = document.documentElement.clientWidth;
            const shown = ['dtAca', 'dtForget', 'dtStop', 'dtMoreBtn'].map((id) => {
              const el = document.getElementById(id);
              if (!el || el.offsetParent === null) return { id, shown: false };
              const r = el.getBoundingClientRect();
              return { id, shown: true, left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) };
            });
            const title = document.getElementById('dtTitle').getBoundingClientRect();
            return { vw, sw: document.documentElement.scrollWidth, shown, titleWidth: Math.round(title.width) };
          });
          return r.shown.every((b) => b.shown) ? r : null;
        }, 'the stale session to show Run on ACA, Forget, Stop and the more button together');
        assert.ok(seen.sw <= seen.vw, `the page is ${seen.sw}px wide in a ${seen.vw}px viewport`);
        for (const b of seen.shown) {
          assert.ok(b.left >= 0 && b.right <= seen.vw, `#${b.id} spans ${b.left}..${b.right} in a ${seen.vw}px viewport`);
          assert.strictEqual(b.height, 32, `#${b.id} is ${b.height}px tall; its label wrapped`);
        }
        assert.ok(seen.titleWidth >= 40, `the title is squeezed to ${seen.titleWidth}px`);
      } finally {
        await rv.page.setViewportSize({ width: 1280, height: 900 });
      }
    });

    // -----------------------------------------------------------------------
    // The hub's keyword, status and device filters, held by the page itself.
    //
    // A filtered fetch is answered by the hub, but a live push carries every
    // session, so the page must narrow it again or the list falls back to
    // everything the moment anything changes. Two devices of their own (online,
    // heartbeating) so "device" is a real choice; every prompt carries a word
    // nothing else on the hub has, so what the filters leave is exactly known.
    // -----------------------------------------------------------------------
    const fl = {};
    const flKey = (device, id) => `${device}:${id}`;
    const flRows = () => rv.page.evaluate(() => [...document.querySelectorAll('#groups .row')].map((r) => r.dataset.session).sort());
    const flHeads = () => rv.page.evaluate(() => [...document.querySelectorAll('#groups .group')]
      .map((g) => g.querySelector('.group-head').textContent.replace(/\s+/g, ' ').trim()));
    /** Every list the page drew from now until `flFrames`, even one that was on screen for a single frame. */
    const flRecord = () => rv.page.evaluate(() => {
      window.__flFrames = [];
      window.__flObs = new MutationObserver(() => {
        window.__flFrames.push([...document.querySelectorAll('#groups .row')].map((r) => r.dataset.session).sort());
      });
      window.__flObs.observe(document.getElementById('groups'), { childList: true, subtree: true });
    });
    const flFrames = () => rv.page.evaluate(() => { window.__flObs.disconnect(); return window.__flFrames; });
    // No `?token=` here: the app claims a token by dropping the whole query string, view state included.
    // The token is already in this browser's storage, so the address carries only the view.
    const flOpen = (query) => gotoSettled(rv.page, `${rv.origin}/?${query}`);
    const flWait = async (keys, what) => {
      try {
        return await until(async () => {
          const now = await flRows();
          return JSON.stringify(now) === JSON.stringify([...keys].sort()) ? now : null;
        }, what);
      } catch (e) {
        throw new Error(`${e.message}; wanted ${JSON.stringify([...keys].sort())}, the page had ${JSON.stringify(await flRows())}`);
      }
    };
    const flOnly = (frames, allowed, what) => {
      const stray = frames.flat().filter((k) => !allowed.includes(k));
      assert.deepStrictEqual([...new Set(stray)], [], `${what}: a session outside the filter was on screen`);
    };

    await check('two more devices start, with sessions that say which filter each should survive (#179)', async () => {
      assert.ok(rv.page, 'the fixture did not start');
      for (const [id, name] of [['fl-a', 'FL A'], ['fl-b', 'FL B']]) {
        const link = new HubLink({ url: `${rv.origin.replace('http', 'ws')}/ws`, token: rv.token, deviceId: id });
        await link.connect();
        link.send({ type: 'register', device: { name, platform: 'linux', meta: null } });
        fl[id] = link;
      }
      fl.beat = setInterval(() => { for (const id of ['fl-a', 'fl-b']) { try { fl[id].send({ type: 'heartbeat', device: {} }); } catch { /* socket closed */ } } }, 300);
      const send = (device, id, over) => fl[device].send({ type: 'session', session: rvSession(id, over) });
      send('fl-a', 'idle-1', { status: 'idle', prompt: 'zqneedle alpha' });
      send('fl-a', 'act-1', { status: 'active', prompt: 'zqneedle bravo' });
      send('fl-a', 'done-1', { prompt: 'zqneedle charlie' });
      send('fl-a', 'other-1', { status: 'idle', prompt: 'zqplain delta' });
      send('fl-b', 'idle-1', { status: 'idle', prompt: 'zqneedle echo' });
      send('fl-b', 'done-1', { prompt: 'zqplain foxtrot' });
      send('fl-b', 'cwd-hit', { status: 'idle', prompt: 'zqplain golf', cwd: '/work/ZQNEEDLE-repo' });
      fl.send = send;
      await flOpen('q=zqneedle');
      await flWait([flKey('fl-a', 'idle-1'), flKey('fl-a', 'act-1'), flKey('fl-a', 'done-1'), flKey('fl-b', 'idle-1'), flKey('fl-b', 'cwd-hit')],
        'both devices to publish their sessions');
    });

    await check('a keyword filter keeps the list to the prompt, folder or id it matches, in any case, through a live push (#179)', async () => {
      const hits = [flKey('fl-a', 'idle-1'), flKey('fl-a', 'act-1'), flKey('fl-a', 'done-1'), flKey('fl-b', 'idle-1'), flKey('fl-b', 'cwd-hit')];
      await flOpen('q=ZQNeedle');
      await flWait(hits, 'a keyword in another case to find the prompts and the folder');
      await flRecord();
      fl.send('fl-a', 'late-miss', { prompt: 'zqplain pushed while a keyword is typed' });
      fl.send('fl-b', 'late-hit', { prompt: 'zqneedle pushed while a keyword is typed' });
      await flWait([...hits, flKey('fl-b', 'late-hit')], 'the matching push to join the list');
      flOnly(await flFrames(), [...hits, flKey('fl-b', 'late-hit')], 'the keyword');
      assert.strictEqual(await rv.page.$eval('#q', (el) => el.value), 'ZQNeedle');
    });

    await check('a keyword and a status together keep exactly the sessions with both, through a live push (#179)', async () => {
      const hits = [flKey('fl-a', 'idle-1'), flKey('fl-b', 'idle-1'), flKey('fl-b', 'cwd-hit')];
      await flOpen('q=zqneedle&status=idle');
      await flWait(hits, 'the keyword and the status to narrow the list');
      await flRecord();
      fl.send('fl-a', 'late-active', { status: 'active', prompt: 'zqneedle active, pushed' });
      fl.send('fl-a', 'late-other', { status: 'idle', prompt: 'zqplain idle, pushed' });
      fl.send('fl-a', 'late-idle', { status: 'idle', prompt: 'zqneedle idle, pushed' });
      await flWait([...hits, flKey('fl-a', 'late-idle')], 'the matching push to join the list');
      flOnly(await flFrames(), [...hits, flKey('fl-a', 'late-idle')], 'the keyword and status');
    });

    await check('a device filter keeps one device, and the other still reads as empty, through a live push (#179)', async () => {
      const hits = [flKey('fl-b', 'idle-1'), flKey('fl-b', 'cwd-hit')];
      await flOpen('q=zqneedle&status=idle&device=fl-b');
      await flWait(hits, 'the device to narrow the list');
      const heads = await flHeads();
      assert.ok(heads.some((h) => /^FL A\b.*\b0 sessions\b/.test(h)), `the other online device was not shown empty: ${JSON.stringify(heads)}`);
      await flRecord();
      fl.send('fl-a', 'late-a', { status: 'idle', prompt: 'zqneedle idle on the other device' });
      fl.send('fl-b', 'late-b', { status: 'idle', prompt: 'zqneedle idle on this device' });
      await flWait([...hits, flKey('fl-b', 'late-b')], 'the push for the chosen device to join the list');
      flOnly(await flFrames(), [...hits, flKey('fl-b', 'late-b')], 'the device');
      const after = await flHeads();
      assert.ok(after.some((h) => /^FL A\b.*\b0 sessions\b/.test(h)), `a push turned the empty device into a full one: ${JSON.stringify(after)}`);
      assert.ok(after.some((h) => /^FL B\b.*\b3 sessions\b/.test(h)), `the chosen device does not count its own sessions: ${JSON.stringify(after)}`);
    });

    await check('a filtered answer that lands after the live push cannot put the other sessions back (#179)', async () => {
      const hits = [flKey('fl-a', 'idle-1'), flKey('fl-b', 'idle-1'), flKey('fl-b', 'cwd-hit'), flKey('fl-a', 'late-idle'), flKey('fl-a', 'late-a'), flKey('fl-b', 'late-b')];
      await flOpen('q=zqneedle&status=idle');
      await flWait(hits, 'the filtered list to settle');

      // The hub answers the next filtered fetch right away, but the answer is
      // held back until a live push, which carries every session, has been drawn.
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let held = 0;
      let arrived;
      const inFlight = new Promise((resolve) => { arrived = resolve; });
      await rv.page.route(/\/api\/overview\?.*q=zqneedle/, async (route) => {
        if (held) { await route.continue(); return; }
        held += 1;
        const answer = await route.fetch();
        arrived();
        await gate;
        await route.fulfill({ response: answer });
      });
      try {
        await flRecord();
        await rv.page.fill('#q', 'zqneedle');
        await inFlight;
        fl.send('fl-b', 'held-active', { status: 'active', prompt: 'zqneedle active, pushed while a fetch is out' });
        fl.send('fl-b', 'held-other', { status: 'idle', prompt: 'zqplain idle, pushed while a fetch is out' });
        fl.send('fl-a', 'held-idle', { status: 'idle', prompt: 'zqneedle idle, pushed while a fetch is out' });
        await until(async () => (await flRows()).includes(flKey('fl-a', 'held-idle')) || null, 'the push to be drawn while the fetch is held');
        const during = await flRows();
        assert.ok(!during.includes(flKey('fl-b', 'held-active')) && !during.includes(flKey('fl-b', 'held-other')),
          `the push put sessions outside the filter on screen while the fetch was out: ${JSON.stringify(during)}`);
        release();
        await new Promise((resolve) => setTimeout(resolve, 600));
        const allowed = [...hits, flKey('fl-a', 'held-idle')];
        flOnly(await flFrames(), allowed, 'the push and the late fetch');
        const settled = await flRows();
        assert.ok(settled.every((k) => allowed.includes(k)), `the list ended on sessions outside the filter: ${JSON.stringify(settled)}`);
      } finally {
        release();
        await rv.page.unroute(/\/api\/overview\?.*q=zqneedle/);
      }
    });

    await check('a chosen Status stays on the control while no session qualifies for it, and leaves it once cleared (#179)', async () => {
      const hidden = (value) => rv.page.$eval(`#statusFilter option[value="${value}"]`, (o) => o.hidden);
      await flOpen('status=queued');
      // "Ready for review" is offered once a session is ready, so it is the sign that the control has been drawn.
      await until(async () => (await hidden('review')) === false || null, 'the Status control to be drawn from the sessions');
      assert.strictEqual(await rv.page.$eval('#statusFilter', (el) => el.value), 'queued');
      assert.strictEqual(await hidden('queued'), false, 'the Status that is chosen was hidden because no session is queued');
      assert.deepStrictEqual(await flRows(), [], 'a session was listed under Queued on ACA');
      await rv.page.evaluate(() => {
        const el = document.getElementById('statusFilter');
        el.value = '';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await until(async () => (await hidden('queued')) === true || null, 'the unused Status to be hidden again once it is not chosen');
    });

    await check('clearing the keyword, the status and the device brings every session back (#179)', async () => {
      // The saved view follows a person to the hub (/api/prefs), so it is cleared the way a person clears it.
      await rv.page.fill('#q', '');
      await rv.page.evaluate(() => {
        for (const id of ['statusFilter', 'deviceFilter']) {
          const el = document.getElementById(id);
          el.value = '';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      const all = await until(async () => {
        const rows = await flRows();
        return rows.includes(flKey('fl-b', 'done-1')) && rows.includes(flKey('fl-a', 'other-1')) && rows.includes(rvKey('ready')) ? rows : null;
      }, 'every session to be listed again');
      assert.ok(all.length >= 14, `only ${all.length} sessions came back`);
      assert.strictEqual(await rv.page.$eval('#q', (el) => el.value), '');
    });

    try { if (fl.beat) clearInterval(fl.beat); } catch { /* closing */ }
    for (const id of ['fl-a', 'fl-b']) { try { if (fl[id]) fl[id].stop(); } catch { /* closing */ } }

    await check('the Ready for review page ran without a console error or a CSP violation, the 409s all from the device it disconnected (#179)', async () => {
      // A 409 is the hub refusing to reach a device that is not connected -- what opening the
      // unreachable device's session does. It is allowed only from that device, after it went.
      const isConflict = (e) => /status of 409/.test(e);
      const strays = rv.conflicts.filter((c) => !c.gone || !/rv-device/.test(c.url));
      assert.deepStrictEqual(strays, [], `a request was refused before the device went away, or for another device: ${JSON.stringify(strays)}`);
      assert.ok(rv.errors.filter(isConflict).length <= rv.conflicts.length, 'a 409 was logged that the page was never sent');
      const broken = rv.errors.filter((e) => !/favicon/i.test(e) && !isConflict(e));
      assert.deepStrictEqual(broken, [], `the page reported errors: ${broken.join(' | ')}`);
      assert.deepStrictEqual(rv.csp, [], `the CSP was tripped: ${JSON.stringify(rv.csp)}`);
    });

    try { if (rv.beat) clearInterval(rv.beat); } catch { /* closing */ }
    try { if (rv.page) await rv.page.close(); } catch { /* closing */ }
    try { if (rv.link) rv.link.stop(); } catch { /* closing */ }
    try { if (rv.svc) await rv.svc.close(); } catch { /* closing */ }

    await check('the whole suite ran under the enforced CSP with zero securitypolicyviolation events', async () => {

      // The exit criterion from issue #84: a policy strict enough to matter
      // and loose enough that nothing it actually touched -- sessions,
      // approvals, reconnects, themes, the service worker, the manifest --
      // ever tripped it. Checked LAST, so it covers every check above.
      assert.deepStrictEqual(cspViolations, [],
        `the main suite tripped the CSP: ${JSON.stringify(cspViolations)}`);
    });
  } finally {
    try { await browser.close(); } catch { /* closing */ }
    try { if (daemon) await daemon.close?.(); } catch { /* closing */ }
    try { await svc.close(); } catch { /* closing */ }
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`ERROR: ${e.message}`); console.log(e.stack); process.exit(1); });
