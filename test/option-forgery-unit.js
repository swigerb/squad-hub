'use strict';
/**
 * An approval option the agent never offered is refused, and refusing it does
 * not run the tool. Through the real CLI, daemon and fake agent. Extracted from
 * test/run-tests.js so it runs, and is mutation-tested, on its own.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  makeEnv, cli, statusJson, daemonPid, alive, waitFor, startDaemon, stopDaemon, cleanup, resultReporter,
} = require('./helpers/device-harness');

const { check, finish } = resultReporter();

async function suiteRejectsUnknownOption() {
  console.log('\n[session] an option the agent never offered is refused');
  const { home, env } = makeEnv();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqwork-'));
  try {
    await startDaemon(env);
    cli(env, ['reset', '--allow-files-all']);
    await waitFor(() => alive(daemonPid(home)));
    cli(env, ['run', 'do the thing', '--cwd', work]);
    await waitFor(() => statusJson(env).sessions.some((x) => x.pendingApprovals.length > 0), 20000);
    const sess = statusJson(env).sessions.find((s) => s.pendingApprovals.length > 0);
    const appr = sess.pendingApprovals[0];

    const r = cli(env, ['approve', sess.id, appr.approvalId, 'allow_forever_muahaha']);
    check('a forged option id is rejected', () => assert.notStrictEqual(r.status, 0, 'a made-up option was accepted'));

    const marker = path.join(work, 'fake-agent-marker.txt');
    check('the forged option did not run the tool', () => assert.ok(!fs.existsSync(marker)));

    await stopDaemon(env);
  } finally {
    // The agent is blocked on the approval; stop the daemon so it cannot outlive a throw.
    try { await stopDaemon(env); } catch { /* already stopped */ }
    cleanup(home); cleanup(work);
  }
}

suiteRejectsUnknownOption()
  .catch((e) => check('the unknown-option suite ran to completion', () => { throw e; }))
  .then(finish);
