'use strict';
/**
 * The orphan mechanisms, tested directly.
 *
 * WHY THIS EXISTS. The end-to-end orphan tests passed on Windows whether or not
 * the daemon killed anything, because libuv puts children in a job object that
 * the OS tears down with the parent (proven: test/platform-orphan-probe.js).
 * Mutation testing caught it: disabling _killAllChildren and reapOrphans left
 * the suite green.
 *
 * On Linux and macOS there is no such job object. Orphans are re-parented to
 * init and survive indefinitely -- and Linux is what ACA and AKS run. So the
 * mechanism is load-bearing precisely where the end-to-end test could not see
 * it.
 *
 * The fix is to stop relying on the OS to demonstrate our own behaviour. Each
 * test below spawns a DETACHED child, which escapes the job object even on
 * Windows, and then asserts that OUR code kills it.
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqorph-'));
process.env.SQUAD_HUB_HOME = home;

const { Daemon } = require('../src/daemon');
const { STATUS } = require('../src/acp-session');
const paths = require('../src/paths');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

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

/**
 * A process that the OS will NOT clean up for us: detached, so it leaves the
 * parent's job object on Windows and its own session on POSIX. If this dies,
 * something in our code killed it.
 */
function spawnUnreapable() {
  const p = spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000)'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  p.unref();
  return p.pid;
}

function fakeSession(id, pid) {
  return {
    id, pid,
    status: STATUS.ACTIVE,
    activity: 'Processing...',
    error: null,
    endedAt: null,
    isAgentDead() { return !alive(this.pid); },
    _setStatus(s, a) { this.status = s; this.activity = a; },
    toJSON() { return { id: this.id, pid: this.pid, status: this.status }; },
  };
}

(async () => {
  console.log(`platform: ${process.platform}`);

  // -- 1. shutdown kills children ------------------------------------------
  {
    const d = new Daemon();
    const pid = spawnUnreapable();
    await sleep(400);
    d.sessions.set('s1', fakeSession('s1', pid));

    check('the unreapable child is running', () => assert.ok(alive(pid), `pid ${pid} not alive`));

    d.shutdown(null); // null -> do not process.exit, so the test can continue
    await sleep(1200);

    check('SHUTDOWN kills the agent, without help from the OS', () => {
      assert.ok(!alive(pid), `ORPHAN: pid ${pid} survived daemon shutdown`);
    });
    if (alive(pid)) { try { process.kill(pid); } catch { /* gone */ } }
  }

  // -- 2. the next daemon reaps what a dead daemon abandoned ----------------
  {
    const pid = spawnUnreapable();
    await sleep(400);

    // A children.json written by a daemon that is now gone. PID 999999 is
    // chosen because nothing is running there; the record must look abandoned.
    const deadDaemonPid = 999999;
    check('the simulated dead daemon really is not running', () => {
      assert.ok(!alive(deadDaemonPid), 'pid 999999 unexpectedly exists; pick another');
    });

    fs.writeFileSync(paths.children(), JSON.stringify([
      { pid, sessionId: 'abandoned', daemonPid: deadDaemonPid, at: Date.now() },
    ], null, 2));

    const d2 = new Daemon();
    const killed = d2.reapOrphans();
    await sleep(1000);

    check('REAP reports the orphan it killed', () => {
      assert.deepStrictEqual(killed, [pid], `reaped ${JSON.stringify(killed)}, expected [${pid}]`);
    });
    check('REAP actually kills the orphaned agent', () => {
      assert.ok(!alive(pid), `ORPHAN SURVIVED: pid ${pid} still running after reapOrphans()`);
    });
    check('the reaped child is removed from the registry', () => {
      const kids = JSON.parse(fs.readFileSync(paths.children(), 'utf8'));
      assert.ok(!kids.some((k) => k.pid === pid), `still recorded: ${JSON.stringify(kids)}`);
    });
    if (alive(pid)) { try { process.kill(pid); } catch { /* gone */ } }
  }

  // -- 3. a LIVE daemon's children are not stolen --------------------------
  {
    const pid = spawnUnreapable();

    // The "other daemon" must be a genuinely DIFFERENT live process. An earlier
    // version of this test used process.pid, which took the "this is my own
    // child" branch instead -- so it passed while testing the wrong thing, and
    // a mutation that stole other daemons' children escaped it.
    const otherDaemonPid = spawnUnreapable();
    await sleep(500);

    check('the other daemon is a different, live process', () => {
      assert.notStrictEqual(otherDaemonPid, process.pid);
      assert.ok(alive(otherDaemonPid), 'the stand-in daemon is not running');
    });

    fs.writeFileSync(paths.children(), JSON.stringify([
      { pid, sessionId: 'someone-elses', daemonPid: otherDaemonPid, at: Date.now() },
    ], null, 2));

    const d3 = new Daemon();
    const killed = d3.reapOrphans();
    await sleep(800);

    check('a child of a LIVE daemon is not reaped', () => {
      assert.deepStrictEqual(killed, [], `wrongly reaped ${JSON.stringify(killed)}`);
      assert.ok(alive(pid), 'killed another live daemon\'s child');
    });
    check('that child is still registered afterwards', () => {
      const kids = JSON.parse(fs.readFileSync(paths.children(), 'utf8'));
      assert.ok(kids.some((k) => k.pid === pid), 'another live daemon\'s child was dropped from the registry');
    });

    for (const p of [pid, otherDaemonPid]) { try { process.kill(p); } catch { /* gone */ } }
  }

  // -- 4. our own in-flight children are left alone ------------------------
  {
    const pid = spawnUnreapable();
    await sleep(400);
    const d4 = new Daemon();
    fs.writeFileSync(paths.children(), JSON.stringify([
      { pid, sessionId: 'mine', daemonPid: process.pid, at: Date.now() },
    ], null, 2));

    const killed = d4.reapOrphans();
    await sleep(600);
    check('the reaper does not kill its own running session', () => {
      assert.deepStrictEqual(killed, [], `reaped its own child: ${JSON.stringify(killed)}`);
      assert.ok(alive(pid), 'the daemon reaped a session it owns');
    });
    try { process.kill(pid); } catch { /* gone */ }
  }

  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* locked */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
