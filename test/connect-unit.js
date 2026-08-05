'use strict';
/**
 * `squad-hub connect` (E1): the one-time per-machine setup that replaces the
 * old two-step "start, then hope the token was right".
 *
 * The property that matters is not "connect prints something reassuring" --
 * it is that connect NEVER reports success before the daemon has genuinely
 * finished attaching to the hub, and never silently accepts a token the hub
 * would refuse. Both are asserted against a REAL HubService on a real
 * loopback port, not a mock -- a refusal has to come from the actual
 * connect-and-be-told-no path, the same one a production hub uses.
 *
 * The CLI child is always spawned ASYNC (never spawnSync): the hub service
 * runs in this same process, and spawnSync would block this process's event
 * loop, starving the very server the daemon is trying to reach. See
 * test/e2e-unit.js for the same lesson learned the hard way.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');
const FAKE = path.join(__dirname, 'fake-agent.js');

const { HubService } = require('../src/service/hub-service');
const { Authenticator, MODES } = require('../src/service/auth');

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

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqconnect-'));
  return {
    home,
    env: {
      ...process.env,
      SQUAD_HUB_HOME: home,
      SQUAD_HUB_AGENT: process.execPath,
      SQUAD_HUB_AGENT_ARGS: FAKE,
      FAKE_AGENT_MODE: 'no-permission',
    },
  };
}
/** A device whose session never reaches a terminal status on its own -- so a
 * `run` against it is a stand-in for a "live session" a connect must protect. */
function makeEnvGated() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqconnect-'));
  return {
    home,
    env: {
      ...process.env,
      SQUAD_HUB_HOME: home,
      SQUAD_HUB_AGENT: process.execPath,
      SQUAD_HUB_AGENT_ARGS: FAKE,
      FAKE_AGENT_MODE: 'approve-gate',
    },
  };
}
function cliSync(env, args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env, encoding: 'utf8', cwd: opts.cwd || ROOT, timeout: opts.timeout || 20000,
  });
}
function cli(env, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, cwd: opts.cwd || ROOT, windowsHide: true });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function daemonPid(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8')).pid; } catch { return null; }
}
async function statusJson(env) {
  const r = await cli(env, ['status', '--json']);
  try { return JSON.parse(r.stdout); } catch { return null; }
}
async function waitFor(fn, ms = 15000, step = 100) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) return false;
    await sleep(step);
  }
}
function cleanup(...dirs) {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
async function stopViaCli(env) {
  await cli(env, ['stop']);
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    probe.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Argument validation -- entirely offline, no hub needed, spawnSync is fine.
// ---------------------------------------------------------------------------

{
  const { home, env } = makeEnv();
  try {
    check('missing --hub and --token is refused with a usage message', () => {
      const r = cliSync(env, ['connect']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /usage: squad-hub connect/);
    });
    check('a non-http(s) --hub is refused', () => {
      const r = cliSync(env, ['connect', '--hub', 'ftp://example.com', '--token', 'sqhd1.x.y']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /http:\/\/ or https:\/\//);
    });
    check('a token with the wrong prefix is refused offline, with no daemon started', () => {
      const r = cliSync(env, ['connect', '--hub', 'http://127.0.0.1:1', '--token', 'not-a-device-token']);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /does not look like a device token/);
      assert.strictEqual(daemonPid(home), null, 'a daemon should never have been started for a malformed token');
    });
  } finally { cleanup(home); }
}

// ---------------------------------------------------------------------------
// A REAL hub: successful attach, refusal, idempotency, and no logged token.
// ---------------------------------------------------------------------------

(async () => {
  const secret = crypto.randomBytes(16).toString('hex');
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret, deviceSecret: crypto.randomBytes(16).toString('hex') });
  const svc = new HubService({ auth, serveWeb: false });
  const PORT = await freePort();
  await svc.listen(PORT, '127.0.0.1');
  const hubUrl = `http://127.0.0.1:${PORT}`;
  const goodToken = auth.mintDeviceToken({ key: 'connect-test', name: 'connect-device', label: 'connect test' });

  try {
    {
      const { home, env } = makeEnv();
      try {
        const r = await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all']);
        await checkAsync('a valid device token connects successfully and says so', async () => {
          assert.strictEqual(r.status, 0, r.stdout + r.stderr);
          assert.match(r.stdout, /connected to /);
        });
        check('connect only reports success once the daemon is ALIVE', () => {
          const pid = daemonPid(home);
          assert.ok(pid && alive(pid), 'connect reported success but no live daemon exists');
        });
        check('connect never prints the token, on success', () => {
          assert.ok(!r.stdout.includes(goodToken), 'the raw token leaked into stdout');
          assert.ok(!r.stderr.includes(goodToken), 'the raw token leaked into stderr');
        });
        check('the daemon log never contains the raw token either', () => {
          const logPath = path.join(home, 'daemon.log');
          let logText = '';
          try { logText = fs.readFileSync(logPath, 'utf8'); } catch { /* no log yet is fine */ }
          assert.ok(!logText.includes(goodToken), 'the raw token leaked into the daemon log');
        });
        await checkAsync('running connect again with the SAME good token is idempotent', async () => {
          const r2 = await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all']);
          assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
          assert.match(r2.stdout, /connected to /);
        });
      } finally { await stopViaCli(env); cleanup(home); }
    }

    {
      // A token minted for a DIFFERENT device secret -- signature mismatch,
      // the same shape a stale/expired/copy-pasted-wrong token takes.
      const otherAuth = new Authenticator({ mode: MODES.DEV, devSecret: secret, deviceSecret: crypto.randomBytes(16).toString('hex') });
      const badToken = otherAuth.mintDeviceToken({ key: 'connect-test', name: 'wrong-secret' });

      const { home, env } = makeEnv();
      try {
        const r = await cli(env, ['connect', '--hub', hubUrl, '--token', badToken, '--allow-files-all']);
        check('a token the hub refuses fails clearly and NEVER reports success', () => {
          assert.notStrictEqual(r.status, 0, 'a refused token exited 0');
          assert.doesNotMatch(r.stdout, /connected to /, 'a refused token printed a success line');
          assert.match(r.stderr + r.stdout, /connect FAILED|refused/i);
        });
      } finally { await stopViaCli(env); cleanup(home); }
    }

    {
      // A hub that accepts the TCP connection but NEVER completes (or
      // refuses) the WebSocket upgrade -- proves connect actually WAITS for
      // genuine attachment rather than declaring victory the moment the
      // daemon process exists.
      const stall = net.createServer((sock) => { sock.on('error', () => {}); /* hold the socket open; never answer */ });
      await new Promise((resolve) => stall.listen(0, '127.0.0.1', resolve));
      const stallPort = stall.address().port;
      const { home, env } = makeEnv();
      try {
        const t0 = Date.now();
        const r = await cli(env, ['connect', '--hub', `http://127.0.0.1:${stallPort}`, '--token', goodToken, '--allow-files-all'], { timeout: 20000 });
        const elapsed = Date.now() - t0;
        check('a hub that never completes the handshake is NOT reported as connected', () => {
          assert.notStrictEqual(r.status, 0, 'connect reported success against a hub that never attached');
          assert.doesNotMatch(r.stdout, /connected to /, 'connect printed success before real attachment');
          assert.ok(elapsed >= 3000, `connect gave up suspiciously fast (${elapsed}ms) -- it may not have waited at all`);
        });
      } finally { await stopViaCli(env); cleanup(home); stall.close(); }
    }

    {
      // A token restricted to a device id that this machine's REAL, stable
      // device id can never satisfy. The candidate probe (see
      // candidateDeviceId) deliberately crafts its OWN one-off id that always
      // matches the token's claim -- on purpose, so probing never risks
      // kicking a real connection already registered under this machine's
      // actual device id. That means the probe alone cannot catch this: it
      // passes. Only the REAL reconnect attempt, using the daemon's genuine
      // device id, gets refused. Connect must not have declared victory
      // (or left the new, now-useless config/daemon in place) the moment the
      // probe succeeded -- the refusal has to surface, and the prior state
      // has to come back exactly as it was.
      //
      // A hex sha1-derived device id can never start with a non-hex letter
      // run like this, so the mismatch is guaranteed regardless of the host
      // running the suite.
      const restrictedToken = auth.mintDeviceToken({ key: 'connect-test', name: 'device-bound', didPrefix: 'not-a-hex-device-' });
      const { home, env } = makeEnv();
      try {
        const r = await cli(env, ['connect', '--hub', hubUrl, '--token', restrictedToken, '--allow-files-all'], { timeout: 20000 });
        check('a token whose device binding this machine cannot satisfy is refused, not accepted', () => {
          assert.notStrictEqual(r.status, 0, 'connect reported success for a device-id-mismatched token');
          assert.doesNotMatch(r.stdout, /connected to /, 'connect printed success before the real device id was checked');
          assert.match(r.stderr + r.stdout, /connect FAILED|refused/i);
        });
        check('the config left behind after a device-bound refusal is NOT the rejected candidate', () => {
          let cfg = null;
          try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { /* fine: never written at all */ }
          if (cfg) assert.notStrictEqual(cfg.token, restrictedToken, 'the rejected candidate token was left in config.json');
        });
        check('no daemon is left running against a hub that refused this device', () => {
          const pid = daemonPid(home);
          assert.ok(!pid || !alive(pid), 'a daemon survived a device-id-bound refusal');
        });
      } finally { await stopViaCli(env); cleanup(home); }
    }

    {
      // Reconnecting with different flags (a device name) must actually take
      // effect -- proving connect restarts rather than leaving stale settings.
      const { home, env } = makeEnv();
      try {
        await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all', '--name', 'first-name']);
        const r2 = await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all', '--name', 'second-name']);
        check('re-running connect with a new --name takes effect (idempotent, not stale)', () => {
          assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
          const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
          assert.strictEqual(cfg.deviceName, 'second-name');
        });
      } finally { await stopViaCli(env); cleanup(home); }
    }

    // -------------------------------------------------------------------
    // N5: validate-before-you-touch-anything, and a live-session force gate.
    // -------------------------------------------------------------------

    {
      // A running (never-terminal) session, then a reconnect that CHANGES the
      // config -- must be refused, naming the session, and leave everything
      // running exactly as it was.
      const { home, env } = makeEnvGated();
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqconnectw-'));
      try {
        await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all']);
        await cli(env, ['run', 'do a gated thing', '--cwd', work]);
        const live = await waitFor(async () => {
          const s = await statusJson(env);
          return !!(s && s.sessions && s.sessions.some((x) => x.status === 'waiting_approval'));
        });
        assert.ok(live, 'no live/waiting_approval session appeared to test the force gate against');

        const beforePid = daemonPid(home);
        const beforeCfg = fs.readFileSync(path.join(home, 'config.json'), 'utf8');

        const r = await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all', '--name', 'renamed-while-live']);
        check('connect refuses to restart the daemon while a session is running, without --force', () => {
          assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
          assert.match(r.stderr, /running session/i);
          assert.match(r.stderr, /--force/);
        });
        check('a blocked connect leaves the daemon (same pid) running, untouched', () => {
          assert.strictEqual(daemonPid(home), beforePid, 'the daemon was restarted despite being blocked');
        });
        check('a blocked connect leaves config.json exactly as it was', () => {
          assert.strictEqual(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), beforeCfg, 'config.json changed despite being blocked');
        });
        await checkAsync('the live session survives the blocked connect attempt', async () => {
          const s = await statusJson(env);
          assert.ok(s && s.sessions && s.sessions.some((x) => x.status === 'waiting_approval'), 'the live session did not survive the blocked connect attempt');
        });
      } finally { await stopViaCli(env); cleanup(home, work); }
    }

    {
      // The same setup, but WITH --force -- this is the one case a restart
      // (and the session going away with it) is expected and correct.
      const { home, env } = makeEnvGated();
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqconnectw-'));
      try {
        await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all']);
        await cli(env, ['run', 'do another gated thing', '--cwd', work]);
        const live = await waitFor(async () => {
          const s = await statusJson(env);
          return !!(s && s.sessions && s.sessions.some((x) => x.status === 'waiting_approval'));
        });
        assert.ok(live, 'no live session to force past');
        const beforePid = daemonPid(home);

        const r = await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all', '--name', 'renamed-with-force', '--force']);
        await checkAsync('connect --force restarts the daemon despite a running session, and reports success', async () => {
          assert.strictEqual(r.status, 0, r.stdout + r.stderr);
          assert.match(r.stdout, /connected to /);
        });
        check('--force produces a genuinely NEW daemon process (a different pid)', () => {
          const afterPid = daemonPid(home);
          assert.ok(afterPid && afterPid !== beforePid, `pid did not change (${beforePid} -> ${afterPid})`);
        });
        await checkAsync('the forced restart does not resurrect the old session', async () => {
          const s = await statusJson(env);
          assert.ok(!s || !s.sessions || !s.sessions.some((x) => x.status === 'waiting_approval'), 'the old session survived a forced restart, contradicting --force');
        });
      } finally { await stopViaCli(env); cleanup(home, work); }
    }

    {
      // A refused CANDIDATE must never touch a daemon/session that was
      // already fine -- validated before anything is written, per N5.
      const otherAuth = new Authenticator({ mode: MODES.DEV, devSecret: secret, deviceSecret: crypto.randomBytes(16).toString('hex') });
      const badToken = otherAuth.mintDeviceToken({ key: 'connect-test', name: 'wrong-secret-live' });
      const { home, env } = makeEnvGated();
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqconnectw-'));
      try {
        await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all']);
        await cli(env, ['run', 'do a third gated thing', '--cwd', work]);
        const live = await waitFor(async () => {
          const s = await statusJson(env);
          return !!(s && s.sessions && s.sessions.some((x) => x.status === 'waiting_approval'));
        });
        assert.ok(live, 'no live session to protect against a refused candidate');
        const beforePid = daemonPid(home);
        const beforeCfg = fs.readFileSync(path.join(home, 'config.json'), 'utf8');

        const r = await cli(env, ['connect', '--hub', hubUrl, '--token', badToken, '--allow-files-all']);
        check('a refused candidate during connect fails and never restarts the daemon', () => {
          assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
          assert.match(r.stderr + r.stdout, /connect FAILED|refused/i);
        });
        check('a refused candidate leaves the same daemon pid running', () => {
          assert.strictEqual(daemonPid(home), beforePid, 'the daemon was restarted despite the candidate being refused');
        });
        check('a refused candidate leaves config.json unwritten', () => {
          assert.strictEqual(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), beforeCfg, 'config.json was overwritten despite the candidate being refused');
        });
        await checkAsync('the live session is still there after the refused candidate attempt', async () => {
          const s = await statusJson(env);
          assert.ok(s && s.sessions && s.sessions.some((x) => x.status === 'waiting_approval'), 'the live session was lost even though the candidate was refused');
        });
      } finally { await stopViaCli(env); cleanup(home, work); }
    }

    {
      // A truly identical reconnect must be a pure no-op, live session or not
      // -- this is stronger than the earlier idempotent test because a
      // session is actually running while it happens.
      const { home, env } = makeEnvGated();
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqconnectw-'));
      try {
        await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all']);
        await cli(env, ['run', 'do a fourth gated thing', '--cwd', work]);
        const live = await waitFor(async () => {
          const s = await statusJson(env);
          return !!(s && s.sessions && s.sessions.some((x) => x.status === 'waiting_approval'));
        });
        assert.ok(live, 'no live session for the idempotent-with-live-session check');
        const beforePid = daemonPid(home);

        const r = await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all']);
        check('an identical reconnect succeeds without --force, even with a live session', () => {
          assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        });
        check('an identical reconnect does not restart the daemon (same pid)', () => {
          assert.strictEqual(daemonPid(home), beforePid, 'the daemon restarted for a no-op reconnect');
          // Proves the truly-idempotent FAST PATH fired -- not merely that a
          // restart happened not to occur further down. Without it, an
          // already-connected reconnect would re-probe the hub over the
          // network (and print "checking ...") on every single invocation,
          // work a genuine no-op has no business doing.
          assert.match(r.stdout, /already connected to /, 'the fast idempotent no-op path did not run');
          assert.doesNotMatch(r.stdout, /checking .*\.\.\./, 'connect re-probed the hub instead of taking the no-op fast path');
        });
        await checkAsync('the running session survives an identical reconnect', async () => {
          const s = await statusJson(env);
          assert.ok(s && s.sessions && s.sessions.some((x) => x.status === 'waiting_approval'), 'the live session did not survive an identical reconnect');
        });
      } finally { await stopViaCli(env); cleanup(home, work); }
    }
    {
      // The actual bug: identical config, but the daemon's OWN hub link is
      // currently down (not the config) -- must still gate a restart on
      // --force when a session is live, exactly like a config CHANGE would.
      // Severing the connection SERVER-side (rather than closing the whole
      // service) reproduces a real "still up, but this one link dropped"
      // blip: the hub stays reachable, so a plain reconnect would succeed --
      // which is exactly why gating only on `wouldChange` is not enough.
      const { home, env } = makeEnvGated();
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqconnectw-'));
      try {
        await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all']);
        await cli(env, ['run', 'do a fifth gated thing', '--cwd', work]);
        const live = await waitFor(async () => {
          const s = await statusJson(env);
          return !!(s && s.sessions && s.sessions.some((x) => x.status === 'waiting_approval'));
        });
        assert.ok(live, 'no live session to test the disconnected-daemon gate against');

        const cfgBefore = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
        const deviceMap = svc._devices.get('connect-test');
        const conn = deviceMap && deviceMap.get(cfgBefore.deviceId);
        assert.ok(conn, 'could not find the live device connection on the hub to sever');
        conn.close(1000, 'test: simulating a dropped hub link');

        const down = await waitFor(async () => {
          try {
            const st = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'));
            return !!(st.hub && st.hub.connected === false);
          } catch { return false; }
        }, 5000, 50);
        assert.ok(down, 'the daemon never reported hub.connected:false after its link was severed');

        const beforePid = daemonPid(home);
        const beforeCfg = fs.readFileSync(path.join(home, 'config.json'), 'utf8');

        // Same hub/token/flags as already configured: an IDENTICAL reconnect,
        // but the daemon is not currently attached.
        const r = await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all']);
        check('an identical reconnect against a disconnected daemon still refuses to restart over a live session, without --force', () => {
          assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
          assert.match(r.stderr, /running session/i);
          assert.match(r.stderr, /--force/);
        });
        check('the disconnected daemon (same pid) is left running, not restarted', () => {
          assert.strictEqual(daemonPid(home), beforePid, 'the daemon was restarted despite being blocked');
        });
        check('config.json is untouched by the blocked identical-but-disconnected reconnect', () => {
          assert.strictEqual(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), beforeCfg);
        });
        await checkAsync('the live session survives the blocked disconnected-daemon reconnect attempt', async () => {
          const s = await statusJson(env);
          assert.ok(s && s.sessions && s.sessions.some((x) => x.status === 'waiting_approval'));
        });

        // With --force, the same identical-but-disconnected scenario must
        // actually restart and reattach.
        const r2 = await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all', '--force']);
        await checkAsync('--force restarts a disconnected daemon over a live session with an otherwise-identical config, and reconnects', async () => {
          assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
          assert.match(r2.stdout, /connected to /);
        });
        check('--force against a disconnected-but-identical reconnect produces a genuinely NEW daemon process', () => {
          const afterPid = daemonPid(home);
          assert.ok(afterPid && afterPid !== beforePid, `pid did not change (${beforePid} -> ${afterPid})`);
        });
      } finally { await stopViaCli(env); cleanup(home, work); }
    }
  } finally {
    await svc.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('[connect] ERROR: ' + e.message);
  console.log(e.stack);
  process.exit(77);
});
