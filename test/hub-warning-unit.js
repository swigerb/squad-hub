'use strict';
/**
 * N6: a noninteractive `run`/`squad "<prompt>"` must never be silent about a
 * hub that is configured but not actually attached. The interactive terminal
 * says so in its banner every time (untouched here); a script or CI job
 * calling `run` has no equivalent moment and would otherwise only find out by
 * separately running `squad-hub status` -- or never, if nobody thinks to.
 *
 * Three states matter, and they read differently to a human:
 *  - refused:     the hub said no. Permanent until the token/config changes.
 *  - connecting:  not refused, just not there yet (or unreachable). Might
 *                 still attach in the background.
 *  - connected / not configured at all: nothing to warn about.
 *
 * All three are driven against a REAL daemon and (where relevant) a REAL
 * HubService on a loopback port -- config.json is written directly to reach
 * the refused/stalled states, since `connect` itself now (correctly, see
 * connect-unit.js) refuses to leave a rejected candidate connected at all.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhubwarn-'));
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
function writeConfig(home, cfg) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
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
async function stopViaCli(env) { await cli(env, ['stop']); }
function cleanup(...dirs) {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    probe.on('error', reject);
  });
}

(async () => {
  try {
    // ---------------------------------------------------------------------
    // Not configured at all: no warning. A local-only machine is normal, not
    // degraded, and must not be nagged about it on every single run.
    // ---------------------------------------------------------------------
    {
      const { home, env } = makeEnv();
      try {
        const r = await cli(env, ['run', 'say hi'], { cwd: home });
        check('no hub configured at all -> `run` never mentions the hub', () => {
          assert.strictEqual(r.status, 0, r.stdout + r.stderr);
          assert.doesNotMatch(r.stderr, /hub/i, 'an unconfigured hub still produced hub chatter on stderr');
        });
      } finally { await stopViaCli(env); cleanup(home); }
    }

    // ---------------------------------------------------------------------
    // Connected: no warning either. The common, healthy case must stay
    // quiet -- otherwise the warning trains people to ignore it.
    // ---------------------------------------------------------------------
    {
      const secret = crypto.randomBytes(16).toString('hex');
      const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret, deviceSecret: crypto.randomBytes(16).toString('hex') });
      const svc = new HubService({ auth, serveWeb: false });
      const PORT = await freePort();
      await svc.listen(PORT, '127.0.0.1');
      const hubUrl = `http://127.0.0.1:${PORT}`;
      const goodToken = auth.mintDeviceToken({ key: 'hub-warn-test', name: 'connected-device' });

      const { home, env } = makeEnv();
      try {
        const connectResult = await cli(env, ['connect', '--hub', hubUrl, '--token', goodToken, '--allow-files-all']);
        assert.strictEqual(connectResult.status, 0, connectResult.stdout + connectResult.stderr);

        const r = await cli(env, ['run', 'say hi'], { cwd: home });
        check('genuinely connected to the hub -> `run` says nothing about it', () => {
          assert.strictEqual(r.status, 0, r.stdout + r.stderr);
          assert.doesNotMatch(r.stderr, /LOCAL-ONLY|not yet connected|hub refused/i);
        });
      } finally { await stopViaCli(env); cleanup(home); await svc.close(); }
    }

    // ---------------------------------------------------------------------
    // Refused: `run` must call this out by name, on stderr, distinctly from
    // the "still connecting" case -- a refusal will not fix itself by
    // waiting, so it should read differently to whoever is watching a log.
    // ---------------------------------------------------------------------
    {
      const secret = crypto.randomBytes(16).toString('hex');
      const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret, deviceSecret: crypto.randomBytes(16).toString('hex') });
      const svc = new HubService({ auth, serveWeb: false });
      const PORT = await freePort();
      await svc.listen(PORT, '127.0.0.1');
      const hubUrl = `http://127.0.0.1:${PORT}`;
      // A hex sha1-derived stable device id can never start with a run of
      // non-hex letters, so this is refused on THIS or any machine.
      const restrictedToken = auth.mintDeviceToken({ key: 'hub-warn-test', name: 'refused-device', didPrefix: 'not-a-hex-device-' });

      const { home, env } = makeEnv();
      try {
        writeConfig(home, { server: hubUrl, token: restrictedToken, allowFiles: true, allowFilesAll: true });
        // First call brings the daemon up and starts (and loses) the attach
        // race in the background; the CLI itself does not wait for it here,
        // only `connect` does. Give the refusal time to settle...
        await cli(env, ['run', 'warm up'], { cwd: home });
        await sleep(1000);
        // ...then ask again against the SAME already-refused daemon, so the
        // assertion is not a coin flip on attach timing.
        const r = await cli(env, ['run', 'say hi'], { cwd: home });
        check('a hub that refused this device -> `run` warns by name, not silently', () => {
          assert.strictEqual(r.status, 0, r.stdout + r.stderr);
          assert.match(r.stderr, /hub refused this device/i);
          assert.match(r.stderr, /LOCAL-ONLY/);
        });
      } finally { await stopViaCli(env); cleanup(home); await svc.close(); }
    }

    // ---------------------------------------------------------------------
    // Still connecting (or just unreachable): a warning, but NOT the refused
    // wording -- this is not necessarily permanent.
    // ---------------------------------------------------------------------
    {
      const stall = net.createServer((sock) => { sock.on('error', () => {}); /* never answer */ });
      await new Promise((resolve) => stall.listen(0, '127.0.0.1', resolve));
      const stallPort = stall.address().port;
      const { home, env } = makeEnv();
      try {
        writeConfig(home, { server: `http://127.0.0.1:${stallPort}`, token: 'sqhd1.not-a-real-token.sig', allowFiles: true, allowFilesAll: true });
        const r = await cli(env, ['run', 'say hi'], { cwd: home });
        check('a hub that has not attached yet -> `run` warns without claiming a refusal', () => {
          assert.strictEqual(r.status, 0, r.stdout + r.stderr);
          assert.match(r.stderr, /not yet connected/i);
          assert.doesNotMatch(r.stderr, /hub refused this device/i);
          assert.match(r.stderr, /LOCAL-ONLY/);
        });
      } finally { await stopViaCli(env); cleanup(home); stall.close(); }
    }
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => {
  console.log('[hub-warning] ERROR: ' + e.message);
  console.log(e.stack);
  process.exit(77);
});
