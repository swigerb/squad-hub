#!/usr/bin/env node
'use strict';
/**
 * `squad-hub report-pr` (#201): a device reports its session's pull request
 * after the session has already ended.
 *
 * The scenario this exists for: a Squad on ACA worker opens its pull request
 * only AFTER the agent -- and the `squad-hub oneshot` process with it -- has
 * already exited (swigerb/squad-on-aca#136). By then there is no daemon left
 * to tell, so this command reconnects to the hub AS THE SAME DEVICE, just
 * long enough to attach the URL, and leaves.
 *
 * Two layers of test:
 *   1. Pure functions in `src/report-pr.js` -- argument parsing/validation
 *      and reading the device's own local session record -- in-process,
 *      fast, no network.
 *   2. The shipped CLI verb against a REAL `HubService`, because the security
 *      property this issue cares about most (a device token cannot touch
 *      another device's session) is enforced by the hub's websocket upgrade,
 *      not by anything `report-pr` does -- so only an end-to-end run proves
 *      it holds for this new caller too.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { Authenticator, MODES } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');
const {
  parsePullRequestArgs, mostRecentLocalSessionId,
} = require('../src/report-pr');
const { cloudDeviceId } = require('../src/device-identity');
const paths = require('../src/paths');

const BIN = path.join(__dirname, '..', 'bin', 'squad-hub.js');

let pass = 0; let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

function run(args, env, budgetMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const started = Date.now();
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      resolve({ exited: false, code: null, ms: Date.now() - started, out });
    }, budgetMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exited: true, code, ms: Date.now() - started, out });
    });
  });
}

/**
 * Restore an environment variable to its prior value -- which may have been
 * "never set" (`undefined`). Assigning `undefined` to `process.env[key]`
 * does NOT unset it; Node coerces it to the literal string `"undefined"`,
 * which then satisfies `||` fallbacks truthily and quietly breaks every test
 * that runs afterwards in this same process. `delete` is required for that
 * case; a plain assignment is only safe when there was a real prior value.
 */
function restoreEnv(key, prev) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

/** One real hub, with a plain user credential to mint device tokens from. */
async function startHub() {
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: 'rp', deviceSecret: 'rp-dev' });
  const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-store-'));
  const svc = new HubService({ auth, deviceTokenDir: tmpStore });
  const addr = await svc.listen(0, '127.0.0.1');
  const hub = `http://127.0.0.1:${addr.port}`;
  const userTok = auth.mintDevToken('t1', 'u1', 'operator');
  const me = await new Promise((resolve, reject) => {
    const r = require('http').get({
      host: '127.0.0.1', port: addr.port, path: '/api/me', headers: { Authorization: `Bearer ${userTok}` },
    }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b)));
    });
    r.on('error', reject);
  });
  return { auth, svc, hub, subject: me.subject };
}

(async () => {
  console.log('squad-hub report-pr');
  console.log('='.repeat(60));

  // -------------------------------------------------------------------------
  // Pure functions: argument parsing and validation
  // -------------------------------------------------------------------------

  await check('a valid --url/--number/--title parses to a validated pull request', () => {
    const r = parsePullRequestArgs([
      '--url', 'https://github.com/swigerb/squad-hub/pull/201', '--number', '201', '--title', 'report-pr',
    ]);
    assert.deepStrictEqual(r.pullRequest, {
      url: 'https://github.com/swigerb/squad-hub/pull/201', number: 201, title: 'report-pr',
    });
  });

  await check('--title is optional', () => {
    const r = parsePullRequestArgs(['--url', 'https://github.com/swigerb/squad-hub/pull/201', '--number', '201']);
    assert.deepStrictEqual(r.pullRequest, {
      url: 'https://github.com/swigerb/squad-hub/pull/201', number: 201, title: null,
    });
  });

  await check('a missing --url is a usage error, not a validation error', () => {
    const r = parsePullRequestArgs(['--number', '201']);
    assert.ok(r.error, 'expected an error');
    assert.match(r.error, /usage: squad-hub report-pr/);
  });

  await check('a missing --number is a usage error', () => {
    const r = parsePullRequestArgs(['--url', 'https://github.com/swigerb/squad-hub/pull/201']);
    assert.ok(r.error);
    assert.match(r.error, /usage: squad-hub report-pr/);
  });

  await check('a non-GitHub-pull-request URL is rejected', () => {
    const r = parsePullRequestArgs(['--url', 'javascript:alert(1)', '--number', '1']);
    assert.ok(r.error && !r.pullRequest, 'an invalid URL must not parse');
    assert.match(r.error, /not a valid pull request/);
  });

  await check('a --number that does not match the URL is rejected', () => {
    const r = parsePullRequestArgs(['--url', 'https://github.com/o/r/pull/5', '--number', '6']);
    assert.ok(r.error && !r.pullRequest);
  });

  await check('a non-numeric --number is rejected', () => {
    const r = parsePullRequestArgs(['--url', 'https://github.com/o/r/pull/5', '--number', 'five']);
    assert.ok(r.error && !r.pullRequest);
  });

  await check('a hex, float or scientific-notation --number is rejected, not coerced', () => {
    // `Number()` would happily turn any of these into the integer 5 --
    // "0x5", "5.0" and "5e0" are not what a CLI's --number flag means by "a
    // number", only decimal digits are.
    for (const numberText of ['0x5', '5.0', '5e0', '+5', ' 5']) {
      const r = parsePullRequestArgs(['--url', `https://github.com/o/r/pull/${numberText}`, '--number', numberText]);
      assert.ok(r.error && !r.pullRequest, `--number ${JSON.stringify(numberText)} must be rejected`);
      assert.match(r.error, /decimal integer/);
    }
  });

  await check('an injection-shaped --title is rejected', () => {
    const r = parsePullRequestArgs([
      '--url', 'https://github.com/o/r/pull/5', '--number', '5', '--title', '<script>alert(1)</script>',
    ]);
    assert.ok(r.error && !r.pullRequest);
  });

  await check('a --title that looks like a dropped flag is rejected, not silently dropped', () => {
    const r = parsePullRequestArgs([
      '--url', 'https://github.com/o/r/pull/5', '--number', '5', '--title', '--session', 'sneaky',
    ]);
    assert.ok(r.error && !r.pullRequest, 'a --title value starting with -- must be rejected');
    assert.match(r.error, /--title/);
  });

  // -------------------------------------------------------------------------
  // Pure functions: the local "most recent session" default
  // -------------------------------------------------------------------------

  await check('no local sessions file means no default session', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-'));
    const prev = process.env.SQUAD_HUB_HOME;
    process.env.SQUAD_HUB_HOME = home;
    try {
      assert.strictEqual(mostRecentLocalSessionId(), null);
    } finally {
      restoreEnv('SQUAD_HUB_HOME', prev);
    }
  });

  await check('the most recently ENDED session wins over an earlier one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-'));
    const prev = process.env.SQUAD_HUB_HOME;
    process.env.SQUAD_HUB_HOME = home;
    try {
      fs.writeFileSync(paths.sessions(), JSON.stringify({
        sessions: [
          { id: 'old', status: 'done', startedAt: 1000, endedAt: 2000 },
          { id: 'new', status: 'done', startedAt: 3000, endedAt: 4000 },
        ],
      }));
      assert.strictEqual(mostRecentLocalSessionId(), 'new');
    } finally {
      restoreEnv('SQUAD_HUB_HOME', prev);
    }
  });

  await check('a session with no endedAt yet falls back to startedAt', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-'));
    const prev = process.env.SQUAD_HUB_HOME;
    process.env.SQUAD_HUB_HOME = home;
    try {
      fs.writeFileSync(paths.sessions(), JSON.stringify({
        sessions: [
          { id: 'finished', status: 'done', startedAt: 1000, endedAt: 2000 },
          { id: 'still-running', status: 'active', startedAt: 9000, endedAt: null },
        ],
      }));
      assert.strictEqual(mostRecentLocalSessionId(), 'still-running');
    } finally {
      restoreEnv('SQUAD_HUB_HOME', prev);
    }
  });

  await check('cloudDeviceId honors an explicit SQUAD_HUB_DEVICE_ID', () => {
    assert.strictEqual(
      cloudDeviceId({ SQUAD_HUB_DEVICE_ID: 'pinned-1', CONTAINER_APP_NAME: '', SQUAD_HUB_DEVICE_NAME: '' }),
      'pinned-1'
    );
  });

  await check('cloudDeviceId falls back to a hash of the app name, matching cloud-device.js', () => {
    const crypto = require('crypto');
    const expected = crypto.createHash('sha1').update('cloud|my-app').digest('hex').slice(0, 16);
    // Pass every field explicitly, as '' rather than omitting them, so this check is not at the
    // mercy of a SQUAD_HUB_DEVICE_ID left set in the ambient environment: a default parameter
    // only applies to a field that is `undefined`, so '' (falsy, but not undefined) pins each
    // field to "deliberately unset" the same way cloudDeviceId itself treats a falsy value.
    // Real callers always pass the full process.env, where this same explicitness is what
    // process.env itself already provides.
    assert.strictEqual(
      cloudDeviceId({ SQUAD_HUB_DEVICE_ID: '', CONTAINER_APP_NAME: 'my-app', SQUAD_HUB_DEVICE_NAME: '' }),
      expected
    );
  });

  // -------------------------------------------------------------------------
  // The shipped CLI verb, end to end against a real hub
  // -------------------------------------------------------------------------

  await check('--help lists report-pr, so a worker can feature-detect it', async () => {
    const r = await run([BIN, '--help'], process.env);
    assert.strictEqual(r.exited, true);
    assert.match(r.out, /report-pr/);
  });

  await check('with no hub configured, it is a no-op that exits 0', async () => {
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-')),
      SQUAD_HUB_URL: '',
      SQUAD_HUB_TOKEN: '',
    };
    const r = await run([BIN, 'report-pr', '--url', 'https://github.com/o/r/pull/5', '--number', '5'], env);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /nothing to report/);
  });

  await check('a missing device token is a clear, non-zero failure', async () => {
    const { hub } = await startHub();
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-'))     ,
      SQUAD_HUB_URL: hub,
      SQUAD_HUB_TOKEN: '',
    };
    const r = await run([BIN, 'report-pr', '--url', 'https://github.com/o/r/pull/5', '--number', '5'], env);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.out, /SQUAD_HUB_TOKEN/);
  });

  await check('connecting to a hub that never upgrades the socket times out, instead of hanging', async () => {
    // A hub that accepts the TCP connection but never answers the WebSocket
    // upgrade (a firewalled port that still completes the handshake, a hung
    // listener) must not hang this short-lived command forever -- a real
    // daemon would just keep retrying, but report-pr has a caller waiting on
    // it to exit.
    const net = require('net');
    const srv = net.createServer((socket) => { /* accept and go silent */ });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address();
    try {
      const env = {
        ...process.env,
        SQUAD_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-')),
        SQUAD_HUB_URL: `http://127.0.0.1:${port}`,
        SQUAD_HUB_TOKEN: 'does-not-matter',
        SQUAD_HUB_DEVICE_ID: 'timeout-1',
        SQUAD_HUB_REPORT_PR_CONNECT_TIMEOUT_MS: '200',
      };
      const r = await run([BIN, 'report-pr', '--url', 'https://github.com/o/r/pull/5',
        '--number', '5', '--session', 'sess-1'], env, 5000);
      assert.strictEqual(r.exited, true, 'the connect timeout must make the process exit, not hang');
      assert.notStrictEqual(r.code, 0);
      assert.match(r.out, /timed out connecting/);
    } finally {
      srv.close();
    }
  });

  await check('an invalid --url is rejected before anything is sent, with exit code 2', async () => {
    const { auth, hub, subject } = await startHub();
    const devTok = auth.mintDeviceToken({ key: subject, label: 'jobs', didPrefix: 'inv-' });
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-')),
      SQUAD_HUB_URL: hub,
      SQUAD_HUB_TOKEN: devTok,
      SQUAD_HUB_DEVICE_ID: 'inv-1',
    };
    const r = await run([BIN, 'report-pr', '--url', 'not a url', '--number', '5'], env);
    assert.strictEqual(r.code, 2, r.out);
    assert.doesNotMatch(r.out, new RegExp(devTok), 'the token must never be printed');
  });

  await check('an invalid --number (not matching the URL) is rejected with exit code 2', async () => {
    const { auth, hub, subject } = await startHub();
    const devTok = auth.mintDeviceToken({ key: subject, label: 'jobs', didPrefix: 'num-' });
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-')),
      SQUAD_HUB_URL: hub,
      SQUAD_HUB_TOKEN: devTok,
      SQUAD_HUB_DEVICE_ID: 'num-1',
    };
    const r = await run([BIN, 'report-pr', '--url', 'https://github.com/o/r/pull/5', '--number', '999'], env);
    assert.strictEqual(r.code, 2, r.out);
  });

  await check('a valid report lands on the named session, and nothing else about it changes', async () => {
    const { auth, svc, hub, subject } = await startHub();
    svc.store.upsertSession(subject, 'rep-1', { id: 'sess-1', status: 'idle', toolCallCount: 3 });
    const before = svc.store.listSessions(subject)[0];

    const devTok = auth.mintDeviceToken({ key: subject, label: 'jobs', didPrefix: 'rep-' });
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-')),
      SQUAD_HUB_URL: hub,
      SQUAD_HUB_TOKEN: devTok,
      SQUAD_HUB_DEVICE_ID: 'rep-1',
    };
    const r = await run([BIN, 'report-pr', '--url', 'https://github.com/swigerb/squad-hub/pull/201',
      '--number', '201', '--title', 'report-pr', '--session', 'sess-1'], env);
    assert.strictEqual(r.code, 0, r.out);
    assert.doesNotMatch(r.out, new RegExp(devTok), 'the token must never be printed');

    const after = svc.store.listSessions(subject)[0];
    assert.deepStrictEqual(after.pullRequest, {
      url: 'https://github.com/swigerb/squad-hub/pull/201', number: 201, title: 'report-pr',
    });
    assert.strictEqual(after.status, before.status, 'the status must not change');
    assert.strictEqual(after.toolCallCount, before.toolCallCount, 'unrelated fields must not change');
  });

  await check('a session message with no correlationId gets no reply, exactly as before report-pr existed', async () => {
    // The ack the hub now sends for `report-pr` is opt-in: a `session` message
    // with no `correlationId` -- what every heartbeat and status-change push
    // already sends -- must still get silence back, not a surprise `reply` on
    // a socket nothing is listening for one on.
    const { HubLink } = require('../src/hub-link');
    const { auth, svc, hub, subject } = await startHub();
    const devTok = auth.mintDeviceToken({ key: subject, label: 'jobs', didPrefix: 'rep-' });
    const wsUrl = hub.replace(/^http/, 'ws') + '/ws';
    const link = new HubLink({ url: wsUrl, token: devTok, deviceId: 'rep-1' });
    const seen = [];
    link.on('message', (m) => seen.push(m));
    await link.connect();
    try {
      link.send({ type: 'session', session: { id: 'sess-1', status: 'idle' } });
      // Give the hub a moment to (not) answer; there is nothing to await on a
      // message that must never arrive, so a short, generous wait stands in.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(!seen.some((m) => m.type === 'reply'), 'a session message with no correlationId must not get a reply');
    } finally {
      link.stop();
    }
  });

  await check('without --session, it defaults to this device\'s most recently ended local session', async () => {
    const { auth, svc, hub, subject } = await startHub();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-'));
    const prevHome = process.env.SQUAD_HUB_HOME;
    process.env.SQUAD_HUB_HOME = home;
    try {
      fs.writeFileSync(paths.sessions(), JSON.stringify({
        sessions: [
          { id: 'earlier', status: 'done', startedAt: 1000, endedAt: 2000 },
          { id: 'latest', status: 'done', startedAt: 3000, endedAt: 4000 },
        ],
      }));
    } finally {
      restoreEnv('SQUAD_HUB_HOME', prevHome);
    }
    svc.store.upsertSession(subject, 'def-1', { id: 'earlier', status: 'done' });
    svc.store.upsertSession(subject, 'def-1', { id: 'latest', status: 'done' });

    const devTok = auth.mintDeviceToken({ key: subject, label: 'jobs', didPrefix: 'def-' });
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: home,
      SQUAD_HUB_URL: hub,
      SQUAD_HUB_TOKEN: devTok,
      SQUAD_HUB_DEVICE_ID: 'def-1',
    };
    const r = await run([BIN, 'report-pr', '--url', 'https://github.com/swigerb/squad-hub/pull/201', '--number', '201'], env);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /latest/, 'it did not pick the most recently ended session');

    const sessions = svc.store.listSessions(subject);
    const latest = sessions.find((s) => s.id === 'latest');
    const earlier = sessions.find((s) => s.id === 'earlier');
    assert.ok(latest.pullRequest, 'the most recent session should carry the pull request');
    assert.strictEqual(earlier.pullRequest, null, 'the earlier session must be untouched');
  });

  await check('with no session at all to report against, it fails rather than guessing', async () => {
    const { auth, hub, subject } = await startHub();
    const devTok = auth.mintDeviceToken({ key: subject, label: 'jobs', didPrefix: 'none-' });
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-')),
      SQUAD_HUB_URL: hub,
      SQUAD_HUB_TOKEN: devTok,
      SQUAD_HUB_DEVICE_ID: 'none-1',
    };
    const r = await run([BIN, 'report-pr', '--url', 'https://github.com/swigerb/squad-hub/pull/201', '--number', '201'], env);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.out, /--session/);
  });

  await check('a report against a session the hub has never seen fails, rather than creating one', async () => {
    // The bug this guards against: `_upsertSessionRecord` starts from
    // `existing || {}`, so a report naming an unknown `{deviceId}:{id}` used
    // to create a status-less, never-ending ("ghost") record and ack success
    // anyway. Triggers include a mistyped `--session`, a device id that
    // drifted between the `oneshot` run and this report, or a hub restart on
    // a non-durable store in between.
    const { auth, svc, hub, subject } = await startHub();
    const devTok = auth.mintDeviceToken({ key: subject, label: 'jobs', didPrefix: 'ghost-' });
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-')),
      SQUAD_HUB_URL: hub,
      SQUAD_HUB_TOKEN: devTok,
      SQUAD_HUB_DEVICE_ID: 'ghost-1',
    };
    const r = await run([BIN, 'report-pr', '--url', 'https://github.com/swigerb/squad-hub/pull/201',
      '--number', '201', '--session', 'never-existed'], env);
    assert.notStrictEqual(r.code, 0, r.out);
    assert.match(r.out, /no existing session|could not report/i);

    const ghost = svc.store.listSessions(subject).find((s) => s.deviceId === 'ghost-1');
    assert.strictEqual(ghost, undefined,
      'reporting against an unknown session must not create one as a side effect');
  });

  await check('a token for device A cannot set pullRequest on device B\'s session', async () => {
    const { auth, svc, hub, subject } = await startHub();
    // Both devices happen to have run a session with the SAME id (plausible:
    // session ids are short and device-local) -- so BOTH have a genuine,
    // pre-existing record to report against. This isolates the session store's
    // device-id scoping from the ghost-prevention check above: if records were
    // ever keyed by session id alone, device A's report would land in (and
    // overwrite) device B's record instead of its own.
    svc.store.upsertSession(subject, 'device-b', { id: 'shared-id', status: 'done' });
    svc.store.upsertSession(subject, 'device-a', { id: 'shared-id', status: 'done' });

    const tokA = auth.mintDeviceToken({ key: subject, label: 'A', didPrefix: 'device-a' });
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-')),
      SQUAD_HUB_URL: hub,
      SQUAD_HUB_TOKEN: tokA,
      SQUAD_HUB_DEVICE_ID: 'device-a',
    };
    const r = await run([BIN, 'report-pr', '--url', 'https://github.com/swigerb/squad-hub/pull/201',
      '--number', '201', '--session', 'shared-id'], env);
    assert.strictEqual(r.code, 0, r.out);

    const bSession = svc.store.listSessions(subject).find((s) => s.deviceId === 'device-b');
    assert.ok(bSession, 'device B\'s own record must still exist, untouched');
    assert.strictEqual(bSession.pullRequest, null,
      'device A must not be able to set a pull request on device B\'s session');

    const aSession = svc.store.listSessions(subject).find((s) => s.deviceId === 'device-a');
    assert.ok(aSession, 'device A\'s own record must still exist');
    assert.strictEqual(aSession.pullRequest.number, 201,
      'device A\'s report must land on device A\'s own session');
  });

  await check('a token may not even attach as a device id outside its own prefix', async () => {
    const { auth, svc, hub, subject } = await startHub();
    svc.store.upsertSession(subject, 'device-b2', { id: 'shared-id-2', status: 'done' });

    const tokA = auth.mintDeviceToken({ key: subject, label: 'A', didPrefix: 'device-a2' });
    const env = {
      ...process.env,
      SQUAD_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'report-pr-home-')),
      SQUAD_HUB_URL: hub,
      SQUAD_HUB_TOKEN: tokA,
      // Impersonating device B's id outright -- disallowed by didPrefix.
      SQUAD_HUB_DEVICE_ID: 'device-b2',
    };
    const r = await run([BIN, 'report-pr', '--url', 'https://github.com/swigerb/squad-hub/pull/201',
      '--number', '201', '--session', 'shared-id-2'], env);
    assert.notStrictEqual(r.code, 0, 'a token outside its own device-id prefix must be refused');
    assert.match(r.out, /refused|could not attach/i);

    const bSession = svc.store.listSessions(subject).find((s) => s.deviceId === 'device-b2');
    assert.strictEqual(bSession.pullRequest, null);
  });

  console.log('');
  console.log('='.repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
