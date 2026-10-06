'use strict';
/**
 * `squad-hub sessions` and `squad-hub open` (#185, the last of the three CLI
 * parity gaps: `config edit` already restores its own file, `autostart`
 * already covers the service verbs).
 *
 * `sessions` is proven against a REAL `HubService` with a REAL fake device
 * attached over `HubLink` -- the same harness `mcp-unit.js` uses for
 * `list_sessions` -- because the thing worth proving is that the CLI reaches
 * the actual `/api/sessions` and `/api/devices` routes, filters what they
 * return, and refuses a device token exactly where `mcp`/`device-token`
 * already do, not that some formatting function agrees with itself.
 *
 * `open` needs no hub at all to prove its one real job: building the right
 * URL and printing it unconditionally, whether or not a browser could be
 * launched. `SQUAD_HUB_BROWSER` stands in for a real browser, the same way
 * `$EDITOR` stands in for a real editor in `cli-parity-unit.js`.
 *
 * The CLI is always spawned ASYNC (never spawnSync) in the `sessions` suite:
 * the hub service runs in this same process, and spawnSync would block the
 * very event loop the server needs to answer. See doctor-unit.js and
 * connect-unit.js for the same lesson.
 */

const assert = require('assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');

const { HubService } = require('../src/service/hub-service');
const { Authenticator, MODES } = require('../src/service/auth');
const { HubLink } = require('../src/hub-link');
const { DeviceTokens } = require('../src/service/device-token');

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

function cli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        SQUAD_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'sqhub-sessopen-')),
        VISUAL: '',
        EDITOR: '',
        SQUAD_HUB_BROWSER: '',
        SQUAD_HUB_URL: '',
        ...extraEnv,
      },
      windowsHide: true,
    });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

/**
 * A "browser" that is really a Node script, exactly as `fakeEditor` in
 * cli-parity-unit.js stands in for a real `$EDITOR`. It writes the argv it
 * was launched with to a file, so the test can assert WHAT would have been
 * opened without an actual window ever appearing.
 */
function fakeBrowser(dir, { exitCode = 0 } = {}) {
  const script = path.join(dir, 'fake-browser.js');
  const recordFile = path.join(dir, 'opened.txt');
  fs.writeFileSync(script, `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(recordFile)}, process.argv.slice(2).join('\\n'));
process.exit(${exitCode});
`);
  return { cmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, recordFile };
}

(async () => {
// ---------------------------------------------------------------------------
// `squad-hub sessions`: against a real hub, a real device, real sessions
// ---------------------------------------------------------------------------
await (async () => {
  const secret = crypto.randomBytes(16).toString('hex');
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret, deviceSecret: crypto.randomBytes(16).toString('hex') });
  const svc = new HubService({ auth, serveWeb: false });
  const addr = await svc.listen(0, '127.0.0.1');
  const hub = `http://127.0.0.1:${addr.port}`;
  const wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
  const token = auth.mintDevToken('t1', 'user-1', 'Alice');

  // A local laptop with two sessions, one idle and one waiting on a human.
  const laptop = new HubLink({ url: wsUrl, token, deviceId: 'alice-laptop' });
  await laptop.connect();
  laptop.send({
    type: 'register',
    device: { name: 'ALICE-LAPTOP', platform: 'linux', fileAccess: 'off' },
    sessions: [
      { id: 's1', status: 'active', activity: 'Working', prompt: 'fix the thing', cwd: '/repo', pendingApprovals: [] },
      { id: 's2', status: 'waiting_approval', activity: 'blocked', prompt: 'ship it', cwd: '/other', pendingApprovals: [{ id: 'a1', command: 'rm -rf /tmp/x' }] },
    ],
  });

  // A cloud (ACA) job with one finished session.
  const cloud = new HubLink({ url: wsUrl, token, deviceId: 'aca-job-42' });
  await cloud.connect();
  cloud.send({
    type: 'register',
    device: { name: 'aca-job-42', platform: 'linux', fileAccess: 'off', kind: 'cloud' },
    sessions: [
      { id: 's3', status: 'done', activity: 'Finished', prompt: 'nightly build', cwd: '/work', pendingApprovals: [] },
    ],
  });
  await sleep(300);

  await checkAsync('`sessions` lists every session, across every device, without a scope filter', async () => {
    const r = await cli(['sessions', '--hub', hub, '--token', token]);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /alice-laptop:s1/);
    assert.match(r.stdout, /alice-laptop:s2/);
    assert.match(r.stdout, /aca-job-42:s3/);
  });

  await checkAsync('`sessions --json` prints parseable session objects carrying their key', async () => {
    const r = await cli(['sessions', '--hub', hub, '--token', token, '--json']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const { sessions } = JSON.parse(r.stdout);
    const keys = sessions.map((s) => s.key).sort();
    assert.deepStrictEqual(keys, ['aca-job-42:s3', 'alice-laptop:s1', 'alice-laptop:s2']);
  });

  await checkAsync('`sessions --scope local` excludes the cloud device', async () => {
    const r = await cli(['sessions', '--hub', hub, '--token', token, '--scope', 'local', '--json']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const { sessions } = JSON.parse(r.stdout);
    assert.deepStrictEqual(sessions.map((s) => s.key).sort(), ['alice-laptop:s1', 'alice-laptop:s2']);
  });

  await checkAsync('`sessions --scope cloud` excludes the local device', async () => {
    const r = await cli(['sessions', '--hub', hub, '--token', token, '--scope', 'cloud', '--json']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const { sessions } = JSON.parse(r.stdout);
    assert.deepStrictEqual(sessions.map((s) => s.key).sort(), ['aca-job-42:s3']);
  });

  await checkAsync('`sessions --status` filters by session status', async () => {
    const r = await cli(['sessions', '--hub', hub, '--token', token, '--status', 'waiting_approval', '--json']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const { sessions } = JSON.parse(r.stdout);
    assert.deepStrictEqual(sessions.map((s) => s.key), ['alice-laptop:s2']);
  });

  await checkAsync('`sessions --scope` refuses anything but local or cloud', async () => {
    const r = await cli(['sessions', '--hub', hub, '--token', token, '--scope', 'nonsense']);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--scope must be "local" or "cloud"/);
  });

  await checkAsync('`sessions` refuses a device token, the same way `mcp` does', async () => {
    const deviceToken = new DeviceTokens({ secret: 'test-secret' }).mint({ key: 'whatever' });
    const r = await cli(['sessions', '--hub', hub, '--token', deviceToken]);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /device token/);
  });

  await checkAsync('`sessions` with no hub/token configured is a usage error, not a crash', async () => {
    const r = await cli(['sessions']);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /usage: squad-hub sessions/);
  });

  await checkAsync('`sessions` reports a clean, readable error when the hub refuses the token', async () => {
    const r = await cli(['sessions', '--hub', hub, '--token', 'not-a-real-token']);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /the hub refused/);
  });

  laptop.stop();
  cloud.stop();
  await new Promise((resolve) => svc.server.close(resolve));
})();

// ---------------------------------------------------------------------------
// `squad-hub open`
// ---------------------------------------------------------------------------
await (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhub-open-'));

  await checkAsync('`open` prints the hub root URL and launches the browser on it', async () => {
    const { cmd, recordFile } = fakeBrowser(dir);
    const r = await cli(['open', '--hub', 'http://hub.example:7420'], { SQUAD_HUB_BROWSER: cmd });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^http:\/\/hub\.example:7420\/$/m);
    assert.strictEqual(fs.readFileSync(recordFile, 'utf8'), 'http://hub.example:7420/');
  });

  await checkAsync('`open <session>` builds the same deep link the web app reads', async () => {
    const { cmd, recordFile } = fakeBrowser(dir);
    const r = await cli(['open', 'alice-laptop:s1', '--hub', 'http://hub.example:7420'], { SQUAD_HUB_BROWSER: cmd });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\?session=alice-laptop%3As1$/m);
    assert.strictEqual(fs.readFileSync(recordFile, 'utf8'), 'http://hub.example:7420/?session=alice-laptop%3As1');
  });

  await checkAsync('`open` strips a trailing slash from --hub before building the URL', async () => {
    const { cmd, recordFile } = fakeBrowser(dir);
    const r = await cli(['open', '--hub', 'http://hub.example:7420/'], { SQUAD_HUB_BROWSER: cmd });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^http:\/\/hub\.example:7420\/$/m);
    void recordFile;
  });

  await checkAsync('`open` never embeds a token in the URL', async () => {
    const { cmd } = fakeBrowser(dir);
    const r = await cli(['open', '--hub', 'http://hub.example:7420'], { SQUAD_HUB_BROWSER: cmd, SQUAD_HUB_USER_TOKEN: 'super-secret-token' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(!r.stdout.includes('super-secret-token'), 'a token leaked into the printed URL');
  });

  await checkAsync('`open` still prints the URL even when the browser cannot launch', async () => {
    const r = await cli(['open', '--hub', 'http://hub.example:7420'], { SQUAD_HUB_BROWSER: 'squad-hub-no-such-browser-xyz' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^http:\/\/hub\.example:7420\/$/m);
    assert.match(r.stderr, /could not open a browser automatically/);
  });

  await checkAsync('`open` reports a browser that exits nonzero, but still succeeds overall', async () => {
    const { cmd } = fakeBrowser(dir, { exitCode: 7 });
    const r = await cli(['open', '--hub', 'http://hub.example:7420'], { SQUAD_HUB_BROWSER: cmd });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /could not open a browser automatically/);
  });

  await checkAsync('`open` with no hub configured is a usage error', async () => {
    const r = await cli(['open'], { SQUAD_HUB_BROWSER: 'true' });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /no hub is configured/);
  });

  await checkAsync('`open` refuses a --hub that is not http(s)', async () => {
    const r = await cli(['open', '--hub', 'ftp://not-a-hub'], { SQUAD_HUB_BROWSER: 'true' });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /not an http:\/\/ or https:\/\/ URL/);
  });
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
})();
