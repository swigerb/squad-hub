'use strict';
/**
 * A device's lifecycle, through the real CLI and daemon: start, status and stop,
 * and what the reportable device view does and does not say. Extracted from
 * test/run-tests.js so it runs, and is mutation-tested, on its own.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  makeEnv, cli, statusJson, alive, startDaemon, stopDaemon, cleanup, resultReporter,
} = require('./helpers/device-harness');

const { check, finish } = resultReporter();

async function suiteLifecycle() {
  console.log('\n[lifecycle] daemon start / status / stop');
  const { home, env } = makeEnv();
  try {
    const before = cli(env, ['status', '--json']);
    check('status exits 3 when no daemon is running', () => {
      assert.strictEqual(before.status, 3, `expected exit 3, got ${before.status}`);
      assert.strictEqual(JSON.parse(before.stdout).running, false);
    });

    const pid = await startDaemon(env);
    check('start produces a live daemon process', () => assert.ok(alive(pid), `pid ${pid} is not alive`));

    const snap = statusJson(env);
    check('status reports running with a device identity', () => {
      assert.strictEqual(snap.running, true);
      assert.ok(snap.device.name, 'no device name');
      assert.strictEqual(snap.device.platform, process.platform);
    });

    check('file access is OFF by default', () => assert.strictEqual(snap.device.fileAccess, 'off'));

    check('the confinement path is NEVER in the reportable view', () => {
      assert.ok(!('filesRoot' in snap.device), 'filesRoot leaked into the device view');
      assert.ok(!JSON.stringify(snap.device).includes(home), 'the home path leaked into the device view');
    });

    await stopDaemon(env);
    check('stop leaves no daemon process', () => assert.ok(!alive(pid), `pid ${pid} survived stop`));
    check('stop removes the state file', () => assert.ok(!fs.existsSync(path.join(home, 'daemon.json'))));
  } finally {
    // A daemon the suite started must not outlive a suite that threw midway.
    try { await stopDaemon(env); } catch { /* already stopped */ }
    cleanup(home);
  }
}

suiteLifecycle()
  .catch((e) => check('the lifecycle suite ran to completion', () => { throw e; }))
  .then(finish);
