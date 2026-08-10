'use strict';
/**
 * The intended FRESH workflow, end to end (E1 through E4 in one pass).
 *
 * A brand-new machine, nothing configured:
 *
 *   squad-hub connect --hub ... --token ...        (once)
 *   cd my-project                                   (a real Squad project)
 *   squad-hub squad "..."                           (every day)
 *
 * and the whole thing has to be true at once: the daemon actually attaches to
 * a REAL hub, the project is auto-detected as Squad and the fake agent is
 * genuinely launched with `--agent squad`, the session is visible and
 * answerable from the HUB side (simulating the browser), and answering an
 * approval from there produces a REAL file on disk -- not just a reply.
 *
 * Isolated SQUAD_HUB_HOME/work dirs throughout; nothing here touches the
 * developer's real ~/.squad-hub, and no login-startup task is registered.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const { HubService } = require('../src/service/hub-service');
const { Authenticator, MODES, subjectKey } = require('../src/service/auth');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, step = 150) {
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
      // The hub listens on 127.0.0.1. Omitting `host` defaults to `localhost`,
      // which can resolve to ::1; Node 20+ papers over that with Happy
      // Eyeballs, Node 18 fails with ECONNREFUSED.
      host: '127.0.0.1',
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
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    probe.on('error', reject);
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqfresh-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqfresh-work-'));
  fs.mkdirSync(path.join(work, '.squad')); // a real Squad project, auto-detected
  const marker = path.join(work, 'fresh-marker.txt');

  const secret = crypto.randomBytes(16).toString('hex');
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret, deviceSecret: crypto.randomBytes(16).toString('hex') });
  const svc = new HubService({ auth, serveWeb: false });
  const port = await freePort();
  await svc.listen(port, '127.0.0.1');

  const userToken = auth.mintDevToken('local', 'fresh-workflow-user', 'Fresh Workflow');
  // A device token is minted for the SAME partition its owner's user token
  // lands in, exactly as the "Connect a device" flow in the browser would do
  // by minting it while that user is signed in -- otherwise the device would
  // register into a partition nobody can ever see from the API.
  const deviceToken = auth.mintDeviceToken({
    key: subjectKey('local', 'fresh-workflow-user'),
    name: 'fresh-workflow-laptop',
    label: 'fresh workflow test',
  });
  const hubUrl = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    SQUAD_HUB_HOME: home,
    SQUAD_HUB_AGENT: process.execPath,
    SQUAD_HUB_AGENT_ARGS: FAKE,
    FAKE_AGENT_MODE: 'approve-gate',
    FAKE_AGENT_MARKER: 'fresh-marker.txt',
  };
  // Async spawn throughout: the hub service runs in THIS process, and
  // spawnSync would block the event loop the hub needs to answer on.
  const cli = (args, opts = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, cwd: opts.cwd || work, windowsHide: true });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  try {
    // -- step 0: a genuinely fresh machine -----------------------------------
    check('a fresh SQUAD_HUB_HOME has no daemon and no saved config yet', () => {
      assert.ok(!fs.existsSync(path.join(home, 'daemon.json')));
      assert.ok(!fs.existsSync(path.join(home, 'config.json')));
    });

    // -- step 1: connect, once -------------------------------------------------
    const connected = await cli(['connect', '--hub', hubUrl, '--token', deviceToken, '--allow-files-all']);
    check('squad-hub connect succeeds against the real hub, and says so', () => {
      assert.strictEqual(connected.code, 0, connected.stdout + connected.stderr);
      assert.match(connected.stdout, /connected to /);
    });
    check('connect never printed the raw device token', () => {
      assert.ok(!connected.stdout.includes(deviceToken) && !connected.stderr.includes(deviceToken));
    });

    // -- step 2: the daemon is genuinely attached to the hub -------------------
    const appeared = await waitFor(async () => {
      const r = await api(port, '/api/overview', userToken);
      return r.body && r.body.devices && r.body.devices.length ? r.body : null;
    });
    check('the device is visible in the hub after connect (not just locally)', () => {
      assert.ok(appeared, 'the device never registered with the hub');
      assert.strictEqual(appeared.devices.length, 1);
      assert.strictEqual(appeared.devices[0].presence, 'online');
    });

    // -- step 3: cd into a Squad project, run WITHOUT any --agent flag --------
    const ran = await cli(['squad', 'please create the marker'], { cwd: work });
    check('`squad-hub squad "<prompt>"` starts and returns, from inside a Squad project', () => {
      assert.strictEqual(ran.code, 0, ran.stdout + ran.stderr);
      assert.match(ran.stdout, /session .* started/);
    });

    // -- step 4: Squad was auto-detected, and the session is visible in hub ---
    const waiting = await waitFor(async () => {
      const r = await api(port, '/api/sessions', userToken);
      const s = r.body && r.body.sessions && r.body.sessions.find((x) => (x.pendingApprovals || []).length);
      return s || null;
    });
    check('the session is visible in the Hub, with a pending approval', () => {
      assert.ok(waiting, 'no session with a pending approval ever appeared in the hub');
      assert.strictEqual(waiting.status, 'waiting_approval');
    });
    check('the Hub session view shows the auto-detected squad agent, and WHY', () => {
      assert.ok(waiting.agentSelection, 'no agentSelection surfaced to the hub at all');
      assert.strictEqual(waiting.agentSelection.agent, 'squad');
      assert.strictEqual(waiting.agentSelection.source, 'auto');
      assert.strictEqual(waiting.agentSelection.isSquad, true);
    });

    check('nothing has run yet -- the marker does not exist before approval', () => {
      assert.ok(!fs.existsSync(marker));
    });

    // -- step 5: answer the approval from the HUB side (the "remote surface") -
    const approval = waiting.pendingApprovals[0];
    const deviceId = appeared.devices[0].deviceId;
    const answered = await api(port, `/api/devices/${deviceId}/approve`, userToken, {
      method: 'POST',
      body: { sessionId: waiting.id, approvalId: approval.approvalId, optionId: 'allow_once' },
    });
    check('the hub accepts the remote approval', () => {
      assert.strictEqual(answered.status, 200, JSON.stringify(answered));
    });

    // -- step 6: the genuine tool side effect ----------------------------------
    const effectHappened = await waitFor(() => fs.existsSync(marker), 20000);
    check('a REMOTE approval answered through the hub produced a REAL file on disk', () => {
      assert.ok(effectHappened, `the marker never appeared; dir contents: ${fs.readdirSync(work).join(', ')}`);
      assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), 'ran');
    });

    const finished = await waitFor(async () => {
      const r = await api(port, '/api/sessions', userToken);
      const s = r.body.sessions.find((x) => x.id === waiting.id);
      return s && ['idle', 'done'].includes(s.status) ? s : null;
    }, 20000);
    check('the session completes and the hub reflects it', () => {
      assert.ok(finished, 'the session never finished its turn in the hub view');
    });

    // -- step 7: still controllable locally, same session model ---------------
    const status = await cli(['status', '--json']);
    check('the local `squad-hub status` shows the very same session, still', () => {
      const parsed = JSON.parse(status.stdout);
      const s = (parsed.sessions || []).find((x) => x.id === waiting.id);
      assert.ok(s, 'the local daemon lost track of the session the hub answered');
    });
  } finally {
    // -- cleanup: never leave a daemon, a hub, or temp dirs behind -------------
    await cli(['stop']).catch(() => {});
    await svc.close();
    for (const d of [home, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('[fresh-workflow] ERROR: ' + e.message);
  console.log(e.stack);
  process.exit(77);
});
