'use strict';
/**
 * ORPHAN GATE, hard kill: SIGKILLing the daemon gives it no chance to clean up,
 * so the agent it spawned must have been recorded on disk, and the next daemon
 * must reap it. Through the real CLI, daemon and fake agent. Extracted from
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

async function suiteOrphanOnHardKill() {
  console.log('\n[ORPHAN GATE] SIGKILLing the daemon must not leave an agent running forever');
  const { home, env } = makeEnv();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqwork-'));
  let agentPid = null;
  try {
    const dpid = await startDaemon(env);
    cli(env, ['reset', '--allow-files-all']);
    await waitFor(() => alive(daemonPid(home)));
    const dpid2 = daemonPid(home);
    cli(env, ['run', 'do the thing', '--cwd', work]);
    await waitFor(() => statusJson(env).sessions.length > 0, 20000);
    agentPid = statusJson(env).sessions[0].pid;

    // The brutal case: no chance to clean up.
    try { process.kill(dpid2, 'SIGKILL'); } catch { /* already gone */ }
    try { if (dpid !== dpid2) process.kill(dpid, 'SIGKILL'); } catch { /* gone */ }
    await waitFor(() => !alive(dpid2), 6000);

    check('the daemon is dead', () => assert.ok(!alive(dpid2), 'daemon survived SIGKILL'));
    const survived = alive(agentPid);
    check('the orphan is recorded on disk so it can be found', () => {
      const kids = JSON.parse(fs.readFileSync(path.join(home, 'children.json'), 'utf8'));
      assert.ok(kids.some((k) => k.pid === agentPid), `child ${agentPid} was not recorded: ${JSON.stringify(kids)}`);
    });

    // The recovery guarantee: the next daemon reaps what the last one abandoned.
    await startDaemon(env);
    const reaped = await waitFor(() => !alive(agentPid), 12000);
    check('HARD KILL: the next daemon start reaps the orphan', () => {
      assert.ok(reaped, `ORPHAN SURVIVED: agent pid ${agentPid} still running after a fresh daemon start (was alive after kill: ${survived})`);
    });

    await stopDaemon(env);
  } finally {
    try { await stopDaemon(env); } catch { /* already stopped */ }
    // If the mutant (or a bug) left the agent behind, it is this suite's own
    // verified child pid: end it rather than leave it running.
    if (agentPid && alive(agentPid)) { try { process.kill(agentPid, 'SIGKILL'); } catch { /* gone */ } }
    cleanup(home); cleanup(work);
  }
}

suiteOrphanOnHardKill()
  .catch((e) => check('the hard-kill orphan suite ran to completion', () => { throw e; }))
  .then(finish);
