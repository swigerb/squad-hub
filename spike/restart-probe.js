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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const findings = {};

function api(port, p, token, opts = {}) {
  return new Promise((resolve) => {
    const body = opts.body ? JSON.stringify(opts.body) : null;
    const req = http.request({
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

  // A FIXED port, so the daemon reconnects to the same address after the
  // "restart" -- which is what a real service restart looks like to a device.
  const PORT = 7999;
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret });
  let svc = new HubService({ auth, serveWeb: false });
  await svc.listen(PORT, '127.0.0.1');
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

  const empty = new HubService({ auth: new Authenticator({ mode: MODES.DEV, devSecret: secret }), serveWeb: false });
  svc = empty;
  await svc.listen(PORT, '127.0.0.1');
  log('service back up, store EMPTY');

  const immediately = await api(PORT, '/api/sessions', token);
  findings.sessionsImmediatelyAfterRestart = immediately.body ? immediately.body.sessions.length : 'error';
  log(`sessions immediately after restart: ${findings.sessionsImmediatelyAfterRestart}`);

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

  await cli(env, ['stop']);
  await svc.close();
  for (const d of [home, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }

  console.log('\n[restart] ===== FINDINGS =====');
  console.log(JSON.stringify(findings, null, 2));
  console.log('');
  if (findings.toolRanAfterRestart) {
    console.log('[restart] VERDICT: a pending approval SURVIVES a hub restart. The daemon still');
    console.log('[restart] holds it, re-reports it on reconnect, and answering it still runs the');
    console.log('[restart] tool. S4 (persistence) is NOT needed for this case.');
  } else if (findings.approvalReappeared) {
    console.log('[restart] VERDICT: the approval reappears but answering it does NOT run the tool.');
    console.log('[restart] That is worse than losing it -- the UI offers an action that silently');
    console.log('[restart] fails. S4 is needed.');
  } else {
    console.log('[restart] VERDICT: the approval is LOST. The agent waits on a request nobody can');
    console.log('[restart] see. S4 is needed.');
  }
  process.exit(0);
})().catch((e) => {
  console.log('[restart] ERROR: ' + e.message);
  console.log(e.stack);
  process.exit(77);
});
