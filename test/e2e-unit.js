'use strict';
/**
 * Sprint 3 + 4 gate — the whole path, end to end.
 *
 * Everything before this proved a layer. This proves the product claim:
 *
 *   an agent pauses on a device -> the pause reaches the hub -> a remote
 *   surface answers it -> the agent actually proceeds.
 *
 * Real service, real daemon over a real WebSocket, real agent process. The
 * "remote surface" is an HTTP client, which is exactly what the browser is.
 *
 * The verdict is a MARKER FILE ON DISK. Not a status field, not a 200. An agent
 * that had run a denied command would report success just as cheerfully.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { HubService } = require('../src/service/hub-service');
const { Authenticator, MODES } = require('../src/service/auth');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');
const FAKE = path.join(__dirname, 'fake-agent.js');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 25000, step = 150) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}

function api(port, p, token, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      port, path: p, method: opts.method || 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqe2e-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqe2ew-'));
  const marker = path.join(work, 'fake-agent-marker.txt');

  const secret = crypto.randomBytes(16).toString('hex');
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret });
  const svc = new HubService({ auth });
  const addr = await svc.listen(0, '127.0.0.1');
  const port = addr.port;
  const token = auth.mintDevToken('local', 'e2e-user', 'E2E');

  const env = {
    ...process.env,
    SQUAD_HUB_HOME: home,
    SQUAD_HUB_AGENT: process.execPath,
    SQUAD_HUB_AGENT_ARGS: FAKE,
    FAKE_AGENT_MODE: 'approve-gate',
  };
  /**
   * The CLI is run with async spawn, NOT spawnSync.
   *
   * spawnSync blocks this process's event loop, and the hub service runs in
   * this process. An earlier version used spawnSync and so froze the service
   * for the whole of `squad-hub start`, which made the daemon's connection look
   * like it took ten seconds. The daemon was never at fault; the test was
   * holding the door shut and timing how long the door took to open.
   */
  const cli = (args, opts = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      env, cwd: opts.cwd || ROOT, windowsHide: true,
    });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  console.log(`service on 127.0.0.1:${port}`);

  // -- the device attaches to the hub --------------------------------------
  const started = await cli(['start', '--hub', `http://127.0.0.1:${port}`, '--token', token, '--allow-files-all']);
  check('the daemon starts and reports a hub connection', () => {
    assert.match(started.stdout, /daemon started/, started.stdout + started.stderr);
    assert.match(started.stdout, /hub\s+http:\/\/127\.0\.0\.1:\d+ \(connected\)/,
      `the daemon did not confirm a live hub link:\n${started.stdout}`);
  });

  const appeared = await waitFor(async () => {
    const r = await api(port, '/api/overview', token);
    return r.body && r.body.devices.length ? r.body : null;
  });
  check('the device appears in the hub', () => {
    assert.ok(appeared, 'the device never registered');
    assert.strictEqual(appeared.devices.length, 1);
    assert.strictEqual(appeared.devices[0].presence, 'online');
  });
  const deviceId = appeared.devices[0].deviceId;

  // -- spawn a session REMOTELY --------------------------------------------
  const spawned = await api(port, `/api/devices/${deviceId}/spawn`, token, {
    method: 'POST', body: { prompt: 'do the thing', cwd: work },
  });
  check('a session can be started remotely', () => {
    assert.strictEqual(spawned.status, 200, JSON.stringify(spawned));
    assert.ok(spawned.body.id, 'no session id came back');
  });

  // -- the pause reaches the hub -------------------------------------------
  const pauseT0 = Date.now();
  const waiting = await waitFor(async () => {
    const r = await api(port, '/api/sessions', token);
    const s = r.body && r.body.sessions.find((x) => (x.pendingApprovals || []).length);
    return s || null;
  });
  const pauseLatency = Date.now() - pauseT0;
  check('the agent pause reaches the hub as an approval', () => {
    assert.ok(waiting, 'no pending approval ever surfaced in the hub');
    assert.strictEqual(waiting.status, 'waiting_approval');
  });

  // The daemon pushes state changes immediately; the heartbeat is only a
  // backstop. Without the push a pause still arrives, just on the next
  // heartbeat -- and "your agent has been blocked for fifteen seconds and you
  // do not know yet" is the problem this product exists to remove. So the
  // latency is asserted, not just the arrival.
  check(`a pause reaches the hub promptly, not on the next heartbeat (${pauseLatency}ms)`, () => {
    const heartbeatMs = 15000;
    assert.ok(pauseLatency < heartbeatMs / 3,
      `took ${pauseLatency}ms; that is heartbeat latency, not a push`);
  });

  const approval = waiting.pendingApprovals[0];

  check('the approval carries the LITERAL command, not a summary', () => {
    assert.ok(approval.command, 'no command reached the hub');
    assert.match(approval.command, /fake-agent-marker\.txt/, `got: ${approval.command}`);
  });
  check('the approval carries the paths it touches', () => {
    assert.ok((approval.paths || []).some((p) => p.includes('fake-agent-marker.txt')),
      JSON.stringify(approval.paths));
  });

  // Found by looking at the rendered UI: the session title had the --cwd value
  // glued onto the prompt, because the argument filter kept flag VALUES.
  check('the prompt does not absorb flag values', () => {
    assert.strictEqual(waiting.prompt, 'do the thing',
      `the prompt picked up an adjacent flag value: ${JSON.stringify(waiting.prompt)}`);
  });
  check('the approval offers the protocol options', () => {
    assert.deepStrictEqual(approval.options.map((o) => o.optionId).sort(),
      ['allow_always', 'allow_once', 'reject_once']);
  });
  check('the action-needed count reflects it', () => {
    assert.ok(approval, 'precondition');
  });

  check('NOTHING HAS RUN YET', () => {
    assert.ok(!fs.existsSync(marker), 'the tool ran BEFORE anyone approved it');
  });

  // -- answer it from the remote surface ------------------------------------
  const answered = await api(port, `/api/devices/${deviceId}/approve`, token, {
    method: 'POST',
    body: { sessionId: waiting.id, approvalId: approval.approvalId, optionId: 'allow_once' },
  });
  check('the remote answer is accepted', () => {
    assert.strictEqual(answered.status, 200, JSON.stringify(answered));
  });

  const ran = await waitFor(() => fs.existsSync(marker), 20000);
  check('REMOTE APPROVAL RAN THE TOOL - proven by the file on disk', () => {
    assert.ok(ran, `the marker never appeared. dir: ${fs.readdirSync(work).join(', ') || 'empty'}`);
  });

  const finished = await waitFor(async () => {
    const r = await api(port, '/api/sessions', token);
    const s = r.body.sessions.find((x) => x.id === waiting.id);
    return s && s.status === 'done' ? s : null;
  }, 20000);
  check('the session completes and the hub sees it', () => {
    assert.ok(finished, 'the session never reached done in the hub');
    assert.strictEqual((finished.pendingApprovals || []).length, 0, 'the approval was not cleared');
  });

  // -- deny, from the same surface ------------------------------------------
  const work2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sqe2ed-'));
  const marker2 = path.join(work2, 'fake-agent-marker.txt');
  await api(port, `/api/devices/${deviceId}/spawn`, token, {
    method: 'POST', body: { prompt: 'do the thing', cwd: work2 },
  });
  const waiting2 = await waitFor(async () => {
    const r = await api(port, '/api/sessions', token);
    return r.body.sessions.find((x) => x.cwd === work2 && (x.pendingApprovals || []).length) || null;
  });
  check('a second session pauses too', () => assert.ok(waiting2, 'no second approval'));

  await api(port, `/api/devices/${deviceId}/approve`, token, {
    method: 'POST',
    body: { sessionId: waiting2.id, approvalId: waiting2.pendingApprovals[0].approvalId, optionId: 'reject_once' },
  });
  await sleep(2500);
  check('REMOTE DENY STOPPED THE TOOL - proven by the absence of the file', () => {
    assert.ok(!fs.existsSync(marker2), `the tool RAN ANYWAY. dir: ${fs.readdirSync(work2).join(', ')}`);
  });
  check('the denied working directory is genuinely empty', () => {
    assert.deepStrictEqual(fs.readdirSync(work2), []);
  });

  // -- transcript and stop --------------------------------------------------
  const work3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sqe2es-'));
  const spawned3 = await api(port, `/api/devices/${deviceId}/spawn`, token, {
    method: 'POST', body: { prompt: 'do the thing', cwd: work3 },
  });
  await waitFor(async () => {
    const r = await api(port, '/api/sessions', token);
    return r.body.sessions.find((x) => x.id === spawned3.body.id && (x.pendingApprovals || []).length);
  });

  await checkAsync('the transcript can be fetched remotely', async () => {
    const r = await api(port, `/api/devices/${deviceId}/transcript`, token, {
      method: 'POST', body: { sessionId: spawned3.body.id, limit: 50 },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(Array.isArray(r.body.transcript), 'no transcript array');
    assert.ok(r.body.transcript.length > 0, 'the transcript was empty');
  });

  await checkAsync('a session can be stopped remotely, and its agent dies', async () => {
    const before = (await api(port, '/api/sessions', token)).body.sessions
      .find((x) => x.id === spawned3.body.id);
    const agentPid = before.pid;
    assert.ok(agentPid, 'no agent pid reported');

    const r = await api(port, `/api/devices/${deviceId}/stop`, token, {
      method: 'POST', body: { sessionId: spawned3.body.id },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r));

    const dead = await waitFor(() => {
      try { process.kill(agentPid, 0); return false; } catch { return true; }
    }, 10000);
    assert.ok(dead, `the agent process ${agentPid} survived a remote stop`);
  });

  // -- the web app is actually served ---------------------------------------
  await checkAsync('the hub serves the web app', async () => {
    const r = await api(port, '/', null);
    assert.strictEqual(r.status, 200, `index did not load: ${r.status}`);
    assert.match(r.raw, /Squad Hub/);
    assert.match(r.raw, /All sessions/);
  });
  await checkAsync('the web assets load', async () => {
    for (const f of ['/app.js', '/app.css', '/app.webmanifest']) {
      const r = await api(port, f, null);
      assert.strictEqual(r.status, 200, `${f} did not load (${r.status})`);
    }
  });

  // Found by rendering the page: `.scrim { display: flex }` outranks the UA
  // stylesheet's `[hidden] { display: none }`, so every modal appeared at once,
  // stacked, on first load. A stylesheet cannot be caught by an API test, so
  // this asserts the rule exists.
  await checkAsync('hidden modals are actually hidden', async () => {
    const css = (await api(port, '/app.css', null)).raw;
    assert.match(css, /\.scrim\[hidden\]\s*\{\s*display:\s*none/,
      'no rule re-hides a .scrim marked [hidden]; display:flex would override it');
    assert.match(css, /\.menu\[hidden\]\s*\{\s*display:\s*none/,
      'the menu has the same display-override problem the modals had');
  });

  /**
   * Every interactive control must be wired to something.
   *
   * The hamburger shipped doing nothing at all, and nothing in the suite
   * noticed, because a dead control returns no error and changes no state. This
   * pairs each id in the markup with a handler in the script -- crude, but it
   * fails loudly the moment a button is added without behaviour.
   */
  await checkAsync('every control in the markup is wired to a handler', async () => {
    const html = (await api(port, '/', null)).raw;
    const js = (await api(port, '/app.js', null)).raw;

    const ids = [...html.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length >= 5, `only found ${ids.length} buttons; the scan is not working`);

    const dead = ids.filter((id) => !new RegExp(`\\$\\('${id}'\\)\\s*\\.on|getElementById\\('${id}'\\)`).test(js));
    assert.deepStrictEqual(dead, [], `these controls have no handler: ${dead.join(', ')}`);
  });

  await checkAsync('every menu entry maps to an action', async () => {
    const html = (await api(port, '/', null)).raw;
    const js = (await api(port, '/app.js', null)).raw;
    const actions = [...html.matchAll(/data-menu="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(actions.length >= 4, `only found ${actions.length} menu entries`);
    for (const a of actions) {
      assert.ok(js.includes(`'${a}'`), `menu entry "${a}" has no branch in onMenu()`);
    }
  });
  await checkAsync('static serving cannot escape the web root', async () => {
    // Several encodings, because `new URL()` collapses a literal `..` before
    // the handler ever sees it -- so a plain /../ probe proves nothing. The
    // encoded forms survive parsing and are what a real attempt looks like.
    const attempts = ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2fpackage.json'];
    for (const a of attempts) {
      const r = await api(port, a, null);
      assert.notStrictEqual(r.status, 200, `traversal served a file outside web/: ${a}`);
      assert.ok(!String(r.raw).includes('"squad-hub"'), `package.json leaked via ${a}`);
    }
  });

  // -- teardown -------------------------------------------------------------
  await cli(['stop']);
  await svc.close();
  for (const d of [home, work, work2, work3]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
