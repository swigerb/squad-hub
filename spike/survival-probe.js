'use strict';
/**
 * What survives what?
 *
 * The hub-restart case is proven (test/restart-unit.js). Documenting it alone
 * would be half a story, because the neighbouring failures behave differently
 * and a reader will assume they behave the same.
 *
 * So: measure the rest before writing them down.
 *
 *   A. The DAEMON restarts. Its agents are reaped by design -- does the hub
 *      then show ghost sessions that no longer exist anywhere?
 *   B. The device goes away without saying goodbye (network loss, laptop lid).
 *      What does the hub show, and for how long?
 *   C. The browser closes. Anything lost?
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

const log = (...a) => console.log('[survive]', ...a);
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
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function waitFor(fn, ms = 30000, step = 400) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

(async () => {
  const PORT = 7997;
  const secret = crypto.randomBytes(16).toString('hex');
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret });
  const svc = new HubService({ auth, serveWeb: false });
  await svc.listen(PORT, '127.0.0.1');
  const token = auth.mintDevToken('local', 'sv', 'Survive');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'survive-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'survivew-'));
  const env = {
    ...process.env,
    SQUAD_HUB_HOME: home,
    SQUAD_HUB_AGENT: process.execPath,
    SQUAD_HUB_AGENT_ARGS: FAKE,
    FAKE_AGENT_MODE: 'approve-gate',
  };

  await cli(env, ['start', '--hub', `http://127.0.0.1:${PORT}`, '--token', token, '--allow-files-all']);
  await waitFor(async () => {
    const r = await api(PORT, '/api/overview', token);
    return r.body && r.body.devices.length ? true : null;
  });
  await cli(env, ['run', 'do the thing', '--cwd', work]);
  const s = await waitFor(async () => {
    const r = await api(PORT, '/api/sessions', token);
    return (r.body && r.body.sessions.find((x) => (x.pendingApprovals || []).length)) || null;
  });
  assert.ok(s, 'no approval appeared');
  const agentPid = s.pid;
  log(`session ${s.id} pending, agent pid ${agentPid}`);

  // ---- A. the DAEMON restarts --------------------------------------------
  log('');
  log('RESTARTING the daemon (its agents are reaped by design)...');
  await cli(env, ['stop']);
  await sleep(1500);
  findings.agentKilledByDaemonStop = !alive(agentPid);
  log(`the agent process is gone: ${findings.agentKilledByDaemonStop}`);

  await cli(env, ['start', '--hub', `http://127.0.0.1:${PORT}`, '--token', token, '--allow-files-all']);
  await sleep(3000);

  const after = await api(PORT, '/api/sessions', token);
  findings.sessionsAfterDaemonRestart = after.body ? after.body.sessions.length : 'error';
  findings.ghostSessions = after.body
    ? after.body.sessions.filter((x) => (x.pendingApprovals || []).length).length
    : 'error';
  log(`sessions in the hub after the daemon restarted: ${findings.sessionsAfterDaemonRestart}`);
  log(`of those, still showing a pending approval: ${findings.ghostSessions}`);

  const dev = (await api(PORT, '/api/overview', token)).body.devices[0];
  findings.deviceStillOnline = dev && dev.presence === 'online';
  log(`the device is back online: ${findings.deviceStillOnline}`);

  // ---- B. the device vanishes without saying goodbye ---------------------
  log('');
  log('KILLING the daemon outright (no clean shutdown, as a network loss looks)...');
  const st = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'));
  try { process.kill(st.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(2000);

  const d0 = (await api(PORT, '/api/overview', token)).body.devices[0];
  findings.presenceImmediatelyAfterKill = d0 ? d0.presence : 'absent';
  log(`presence immediately: ${findings.presenceImmediatelyAfterKill}`);

  // Presence decays on a timer, so a device that vanishes is reported stale
  // before it is reported offline. Worth knowing the shape rather than the
  // exact seconds, which are configurable.
  const wentStale = await waitFor(async () => {
    const r = await api(PORT, '/api/overview', token);
    const d = r.body && r.body.devices[0];
    return d && d.presence !== 'online' ? d.presence : null;
  }, 90000, 2000);
  findings.presenceAfterDecay = wentStale || 'still online after 90s';
  log(`presence after decay: ${findings.presenceAfterDecay}`);

  await svc.close();
  for (const d of [home, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }

  console.log('\n[survive] ===== FINDINGS =====');
  console.log(JSON.stringify(findings, null, 2));
  process.exit(0);
})().catch((e) => {
  console.log('[survive] ERROR: ' + e.message);
  console.log(e.stack);
  process.exit(77);
});
