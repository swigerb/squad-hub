'use strict';
/**
 * Does the HEARTBEAT itself detect a dead agent, or was the suite passing
 * because the child's 'exit' event got there first?
 *
 * This matters beyond tidiness. The exit event only fires for a process the
 * daemon is the parent of. Any path where that is not true -- re-adoption after
 * a restart, a session inherited from a previous daemon -- has only the
 * heartbeat to fall back on. If the heartbeat is untested, that path is
 * untested.
 *
 * So: build a session the daemon did NOT spawn, kill it, and call beat().
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhb-'));
process.env.SQUAD_HUB_HOME = home;

const { Daemon } = require('../src/daemon');
const { STATUS } = require('../src/acp-session');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

(async () => {
  const d = new Daemon();
  let pass = 0; let fail = 0;
  const check = (name, fn) => {
    try {
      fn(); pass += 1;
      console.log(`  ok   ${name}`);
      console.log(`RESULT\tok\t${name}`);
    } catch (e) {
      fail += 1;
      console.log(`  FAIL ${name}\n         ${e.message}`);
      console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
    }
  };

  // A process the daemon is NOT the parent of, so no 'exit' event reaches it.
  const stray = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true });
  stray.unref();
  stray.removeAllListeners('exit');
  await sleep(300);

  // A minimal session stand-in wired the way a re-adopted session would be:
  // a pid, a status, and no process handle at all.
  const events = [];
  const fake = {
    id: 'readopted-001',
    pid: stray.pid,
    status: STATUS.ACTIVE,
    activity: 'Processing...',
    error: null,
    endedAt: null,
    isAgentDead() { return !alive(this.pid); },
    _setStatus(next, activity) { this.status = next; this.activity = activity; events.push(next); },
    toJSON() { return { id: this.id, pid: this.pid, status: this.status }; },
  };
  d.sessions.set(fake.id, fake);

  check('the adopted session starts Active', () => assert.strictEqual(fake.status, STATUS.ACTIVE));

  const t1 = d.beat();
  check('a beat while the agent lives changes nothing', () => {
    assert.strictEqual(fake.status, STATUS.ACTIVE);
    assert.deepStrictEqual(t1, []);
  });

  process.kill(stray.pid);
  await sleep(500);
  check('the agent is dead', () => assert.ok(!alive(stray.pid)));

  check('status is STILL Active before the next beat (nothing else noticed)', () => {
    assert.strictEqual(fake.status, STATUS.ACTIVE,
      'something other than the heartbeat changed the status - this test is not isolating the heartbeat');
  });

  const t2 = d.beat();
  check('THE HEARTBEAT ITSELF marks the session failed', () => {
    assert.strictEqual(fake.status, STATUS.FAILED, `status was ${fake.status}`);
  });
  check('the beat reports the transition', () => assert.deepStrictEqual(t2, [fake.id]));
  check('the failure says why', () => assert.ok(fake.error && /disappear/i.test(fake.error), fake.error));

  d.shutdown(null);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* locked */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
