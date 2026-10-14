'use strict';
/**
 * File access confinement, through the real CLI and daemon: OFF by default, and
 * scoped means scoped. Extracted from test/run-tests.js so it runs, and is
 * mutation-tested, on its own.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  makeEnv, cli, statusJson, daemonPid, alive, waitFor, startDaemon, stopDaemon, cleanup, resultReporter,
} = require('./helpers/device-harness');

const { check, finish } = resultReporter();

async function suiteFileAccess() {
  console.log('\n[file access] off by default, and scoped means scoped');
  const { home, env } = makeEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqroot-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sqout-'));
  const inside = path.join(root, 'nested');
  fs.mkdirSync(inside);
  try {
    await startDaemon(env);
    const denied = cli(env, ['run', 'x', '--cwd', outside]);
    check('with file access OFF, a working directory is refused', () => {
      assert.notStrictEqual(denied.status, 0, 'a cwd was accepted while file access was off');
      assert.match(denied.stderr + denied.stdout, /file access is off/i);
    });
    await stopDaemon(env);

    // Scope to `root` by running reset from there.
    cli(env, ['reset', '--allow-files'], { cwd: root });
    await waitFor(() => alive(daemonPid(home)), 10000);

    const snap = statusJson(env);
    check('scoped access reports as scoped', () => assert.strictEqual(snap.device.fileAccess, 'scoped'));
    check('the confinement root still never appears in the device view', () => {
      assert.ok(!JSON.stringify(snap.device).includes(root), 'the root path leaked');
    });

    const ok = cli(env, ['run', 'x', '--cwd', inside]);
    check('a directory inside the root is allowed', () => assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr));

    const esc = cli(env, ['run', 'x', '--cwd', outside]);
    check('a directory outside the root is refused', () => {
      assert.notStrictEqual(esc.status, 0, 'escaped the confinement root');
      assert.match(esc.stderr + esc.stdout, /outside/i);
    });

    const traversal = cli(env, ['run', 'x', '--cwd', path.join(root, '..', path.basename(outside))]);
    check('.. traversal out of the root is refused', () => {
      assert.notStrictEqual(traversal.status, 0, 'traversal escaped the confinement root');
    });

    await stopDaemon(env);
  } finally {
    // The accepted `run` started an agent under this home; stopping the daemon reaps it.
    try { await stopDaemon(env); } catch { /* already stopped */ }
    cleanup(home); cleanup(root); cleanup(outside);
  }
}

suiteFileAccess()
  .catch((e) => check('the file-access suite ran to completion', () => { throw e; }))
  .then(finish);
