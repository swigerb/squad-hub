'use strict';
/**
 * What ACTUALLY happens to a pending approval when the hub service restarts?
 *
 * The App Service plan claims a restart "loses the pending approval, and the
 * agent then waits on a request nobody can see". That was reasoned from the
 * store being in memory -- it was never observed, and reasoning is not
 * evidence. If it is wrong, sprint S4 is unnecessary work.
 *
 * There is a good argument it may be wrong. The agent process on the device
 * survives the hub restarting; the daemon still holds the approval in memory
 * and re-sends its session list on reconnect. So the approval might simply
 * come back.
 *
 * The question that decides S4 is not whether it reappears in the list. It is
 * whether ANSWERING it still runs the tool -- which is asserted here with a
 * marker file, because a list entry that cannot be acted on is worse than an
 * absent one.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');
const FAKE = path.join(ROOT, 'test', 'fake-agent.js');

const { HubService } = require(path.join(ROOT, 'src', 'service', 'hub-service'));
const { Authenticator, MODES } = require(path.join(ROOT, 'src', 'service', 'auth'));

const log = (...a) => console.log('[restart]', ...a);

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const findings = {};

function api(port, p, token, opts = {}) {
  return new Promise((resolve) => {
    const body = opts.body ? JSON.stringify(opts.body) : null;
    const req = http.request({
      // The hub listens on 127.0.0.1. Omitting `host` defaults to `localhost`,
      // which can resolve to ::1; Node 20+ papers over that with Happy
      // Eyeballs, Node 18 fails with ECONNREFUSED.
      host: '127.0.0.1',
      port, path: p, method: opts.method || 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function cli(env, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, cwd: ROOT, windowsHide: true });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

async function waitFor(fn, ms = 30000, step = 500) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}

(async () => {
  const secret = crypto.randomBytes(16).toString('hex');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'restartw-'));
  const marker = path.join(work, 'fake-agent-marker.txt');
  // The HUB's own durable state, deliberately separate from `home` (the
  // DEVICE's SQUAD_HUB_HOME, below) -- in a real deployment these are two
  // different machines, and conflating them here would let a bug that
  // confuses "the device's own record" with "the hub's persisted copy" go
  // unnoticed. Explicit rather than left to default to whatever real
  // directory `paths.home()` would otherwise resolve to on the machine
  // running this suite.
  const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'restarthub-'));

  // The port must be STABLE across the restart -- that is what a real service
  // restart looks like to a device, which reconnects to the address it was
  // given. It does NOT have to be a well-known number, and hardcoding one
  // meant two test runs on the same machine collided on EADDRINUSE: a
  // concurrent mutation sweep could not run alongside an ordinary suite.
  //
  // Let the OS choose, then hold that choice for the rest of the run.
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret });
  let svc = new HubService({ auth, serveWeb: false, storeDir: hubHome });
  const PORT = (await svc.listen(0, '127.0.0.1')).port;
  const token = auth.mintDevToken('local', 'restart', 'Restart');
  log(`service up on ${PORT}`);

  const env = {
    ...process.env,
    SQUAD_HUB_HOME: home,
    SQUAD_HUB_AGENT: process.execPath,
    SQUAD_HUB_AGENT_ARGS: FAKE,
    FAKE_AGENT_MODE: 'approve-gate',
  };

  await cli(env, ['start', '--hub', `http://127.0.0.1:${PORT}`, '--token', token, '--allow-files-all']);
  const registered = await waitFor(async () => {
    const r = await api(PORT, '/api/overview', token);
    return r.body && r.body.devices.length ? r.body.devices[0] : null;
  });
  assert.ok(registered, 'the device never registered');
  log(`device attached: ${registered.name}`);

  await cli(env, ['run', 'do the thing', '--cwd', work]);
  const before = await waitFor(async () => {
    const r = await api(PORT, '/api/sessions', token);
    return (r.body && r.body.sessions.find((s) => (s.pendingApprovals || []).length)) || null;
  });
  assert.ok(before, 'no approval appeared');
  log(`approval pending: ${before.pendingApprovals[0].command}`);
  assert.ok(!fs.existsSync(marker), 'the tool ran before anyone approved');

  // ---- the restart ------------------------------------------------------
  log('');
  log('RESTARTING the hub service (in-memory state is discarded)...');
  await svc.close();
  await sleep(1500);

  const empty = new HubService({
    auth: new Authenticator({ mode: MODES.DEV, devSecret: secret }),
    serveWeb: false,
    storeDir: hubHome,
  });
  svc = empty;
  await svc.listen(PORT, '127.0.0.1');
  log('service back up, store rehydrated from disk');

  const immediately = await api(PORT, '/api/sessions', token);
  findings.sessionsImmediatelyAfterRestart = immediately.body ? immediately.body.sessions.length : 'error';
  log(`sessions immediately after restart: ${findings.sessionsImmediatelyAfterRestart}`);
  // Issue #91's whole point is that this row SURVIVES -- it must be here
  // already, straight off disk, before the device has said a word. What must
  // NOT be here is a pending approval nobody can answer (see
  // store-backing.js `sanitiseSessionForDisk`): a durable copy of the
  // session is honest; a durable copy of a live process's outstanding
  // request is not.
  findings.approvalPersistedToDisk = !!(immediately.body
    && immediately.body.sessions.some((s) => (s.pendingApprovals || []).length));
  log(`a pending approval was sitting on disk immediately after restart: ${findings.approvalPersistedToDisk}`);

  // ---- does the daemon put it back? -------------------------------------
  log('waiting to see whether the daemon re-reports it...');
  const t0 = Date.now();
  const recovered = await waitFor(async () => {
    const r = await api(PORT, '/api/sessions', token);
    return (r.body && r.body.sessions.find((s) => (s.pendingApprovals || []).length)) || null;
  }, 60000);

  findings.approvalReappeared = !!recovered;
  findings.recoverySeconds = recovered ? Math.round((Date.now() - t0) / 1000) : null;
  log(recovered
    ? `the approval REAPPEARED after ${findings.recoverySeconds}s`
    : 'the approval did NOT come back within 60s');

  // ---- and the question that actually decides S4 -------------------------
  if (recovered) {
    const dev = (await api(PORT, '/api/overview', token)).body.devices[0];
    const a = recovered.pendingApprovals[0];
    findings.approvalIdStable = a.approvalId === before.pendingApprovals[0].approvalId;
    log(`approval id unchanged: ${findings.approvalIdStable}`);

    const answered = await api(PORT, `/api/devices/${dev.deviceId}/approve`, token, {
      method: 'POST',
      body: { sessionId: recovered.id, approvalId: a.approvalId, optionId: 'allow_once' },
    });
    findings.answerStatus = answered.status;

    const ran = await waitFor(() => fs.existsSync(marker), 20000);
    findings.toolRanAfterRestart = !!ran;
    log(`answering it AFTER the restart ran the tool: ${!!ran}`);
  }

  // ---- the device deletes the session; does a SECOND restart bring it back? -
  //
  // This is the regression issue #91 names explicitly: a durable copy that
  // resurrects a row the device dropped on purpose is worse than losing it.
  // Proven end-to-end, not just against `Store` directly (see
  // test/session-persistence-unit.js), because a hub that gets `Store` right
  // in isolation could still wire it up wrong at the HTTP/WebSocket layer --
  // e.g. syncing a stale in-memory list instead of what the device just sent.
  if (recovered) {
    log('');
    log('the session finishes, and the DEVICE forgets it (not the hub)...');
    await cli(env, ['kill', recovered.id]);
    const finished = await waitFor(async () => {
      const r = await api(PORT, '/api/sessions', token);
      const s = r.body && r.body.sessions.find((x) => x.id === recovered.id);
      return s && ['done', 'failed', 'stopped'].includes(s.status);
    }, 20000);
    assert.ok(finished, 'the session never reached a terminal status after being killed');

    await cli(env, ['forget', '--all']);
    const forgotten = await waitFor(async () => {
      const r = await api(PORT, '/api/sessions', token);
      return r.body && !r.body.sessions.some((x) => x.id === recovered.id);
    }, 20000);
    findings.deviceForgetPropagated = !!forgotten;
    log(`the device's own deletion reached the hub: ${findings.deviceForgetPropagated}`);

    log('RESTARTING the hub AGAIN, with the deletion already on disk...');
    await svc.close();
    await sleep(1500);
    const twice = new HubService({
      auth: new Authenticator({ mode: MODES.DEV, devSecret: secret }),
      serveWeb: false,
      storeDir: hubHome,
    });
    svc = twice;
    await svc.listen(PORT, '127.0.0.1');

    const rightAfter = await api(PORT, '/api/sessions', token);
    findings.deletedRowBackOnDiskImmediately = !!(rightAfter.body
      && rightAfter.body.sessions.some((x) => x.id === recovered.id));
    log(`the dropped session was back on disk immediately after the second restart: ${findings.deletedRowBackOnDiskImmediately}`);

    // Give the device a moment to reconnect and republish its (now shorter)
    // list -- the wholesale replace that is supposed to keep the hub honest.
    await waitFor(async () => {
      const r = await api(PORT, '/api/overview', token);
      return r.body && r.body.devices.length > 0;
    }, 30000);
    await sleep(2000);

    const final = await api(PORT, '/api/sessions', token);
    const finalIds = (final.body ? final.body.sessions : []).map((s) => s.id);
    findings.deletedRowBackAfterReconnect = finalIds.includes(recovered.id);
    findings.duplicateIdsAfterReconnect = new Set(finalIds).size !== finalIds.length;
    log(`the dropped session was back after the device reconnected: ${findings.deletedRowBackAfterReconnect}`);
    log(`duplicate session rows after reconnect: ${findings.duplicateIdsAfterReconnect}`);
  }

  await cli(env, ['stop']);
  await svc.close();
  for (const d of [home, work, hubHome]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }

  check('a pending approval reappears after a hub restart', () => {
    assert.ok(findings.approvalReappeared, 'the approval was lost');
    assert.ok(findings.recoverySeconds <= 30, `took ${findings.recoverySeconds}s to come back`);
  });
  check('it comes back with the SAME approval id', () => {
    // A new id would mean the UI could not correlate it, and any card already
    // shown elsewhere would answer something that no longer exists.
    assert.strictEqual(findings.approvalIdStable, true);
  });
  check('ANSWERING it after the restart still runs the tool', () => {
    assert.strictEqual(findings.toolRanAfterRestart, true,
      'the approval reappeared but answering it did nothing - worse than losing it');
  });
  check('a pending approval is never the durable copy -- it always comes from the live device', () => {
    // The honest alternative to "reappears but cannot be answered": it is
    // simply not written down in the first place. What DOES survive on disk
    // (asserted above, `sessionsImmediatelyAfterRestart`) is the session
    // record; what does NOT is a handle to a process that might already be
    // dead.
    assert.strictEqual(findings.approvalPersistedToDisk, false,
      'a pending approval was sitting on disk immediately after restart, before any live device had said a word');
  });
  check('the device is authoritative: a session it deleted does not come back after a restart, and nothing is duplicated', () => {
    // Rewritten from a test that asserted the OPPOSITE of what issue #91 asks
    // for -- "the hub holds no session state of its own". That assumption is
    // now deliberately reversed: session records DO survive a restart. What
    // must still hold, and is asserted here directly, is that the DEVICE
    // remains authoritative: its own reconnect replaces the hub's copy of its
    // sessions wholesale, a session it has already deleted does not reappear
    // -- neither straight off disk nor after the device reconnects -- and no
    // row is duplicated by the merge of a persisted copy with a live one.
    assert.strictEqual(findings.deviceForgetPropagated, true,
      "the device's own deletion never reached the hub in the first place");
    assert.strictEqual(findings.deletedRowBackOnDiskImmediately, false,
      'a session the device had already deleted was sitting on disk again immediately after a restart');
    assert.strictEqual(findings.deletedRowBackAfterReconnect, false,
      'a session the device deleted came back once the device reconnected -- the durable copy resurrected it');
    assert.strictEqual(findings.duplicateIdsAfterReconnect, false,
      "the device's reconnect did not replace the hub's copy wholesale -- a session id appeared more than once");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('[restart] ERROR: ' + e.message);
  console.log(e.stack);
  process.exit(77);
});
