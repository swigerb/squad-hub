#!/usr/bin/env node
'use strict';
/**
 * Removing the record of ended sessions.
 *
 * The thing being added is a tidy-up button, and a tidy-up button that can
 * reach live work is a remote kill with a friendly label. So the tests here
 * are mostly about what `forget` REFUSES to do.
 *
 * The sharpest hazard is not authentication -- the route inherits every guard
 * the other control ops already have -- it is ORPHANING. A session record is
 * the only handle the daemon has on its agent process: `_killAllChildren`
 * walks `this.sessions`, and so does shutdown. Delete a record whose process
 * is still breathing and that process becomes exactly the invisible orphan
 * this daemon's reaper, its children file, and a good part of this suite
 * exist to prevent. That is why "terminal" is not enough on its own and
 * liveness is checked too.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// An isolated device identity -- never the developer's real ~/.squad-hub.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqforget-'));
process.env.SQUAD_HUB_HOME = HOME;

const { Daemon } = require(path.join(ROOT, 'src', 'daemon'));
const { STATUS } = require(path.join(ROOT, 'src', 'acp-session'));

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

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** A session record shaped like the real thing, without a process behind it. */
function fakeSession(id, { status = STATUS.DONE, endedAt = Date.now() - DAY, pid = null } = {}) {
  return {
    id, status, endedAt, pid,
    toJSON() { return { id: this.id, status: this.status, endedAt: this.endedAt }; },
  };
}

function daemonWith(sessions) {
  const d = new Daemon();
  for (const s of sessions) d.sessions.set(s.id, s);
  // Never let a test write the real children file or talk to a hub.
  d._persistSessions = () => {};
  d._untrackChild = () => {};
  d.log = () => {};
  return d;
}

// ---------------------------------------------------------------------------
// What it removes
// ---------------------------------------------------------------------------

check('an ended session is removed', () => {
  const d = daemonWith([fakeSession('a')]);
  const r = d.forgetSessions({});
  assert.deepStrictEqual(r.forgotten, ['a']);
  assert.strictEqual(d.sessions.has('a'), false);
});

check('every terminal status is eligible, not just done', () => {
  const d = daemonWith([
    fakeSession('done', { status: STATUS.DONE }),
    fakeSession('failed', { status: STATUS.FAILED }),
    fakeSession('stopped', { status: STATUS.STOPPED }),
  ]);
  assert.strictEqual(d.forgetSessions({}).count, 3);
});

check('the count and the kept tally describe what actually happened', () => {
  const d = daemonWith([
    fakeSession('a'), fakeSession('b'),
    fakeSession('live', { status: STATUS.ACTIVE, endedAt: null }),
  ]);
  const r = d.forgetSessions({});
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.kept, 1);
});

check('forgetting twice is harmless', () => {
  const d = daemonWith([fakeSession('a')]);
  d.forgetSessions({});
  const again = d.forgetSessions({});
  assert.strictEqual(again.count, 0, 'a second click must not be an error');
});

check('a daemon with no sessions at all does not throw', () => {
  assert.strictEqual(daemonWith([]).forgetSessions({}).count, 0);
});

// ---------------------------------------------------------------------------
// What it refuses -- the part that matters
// ---------------------------------------------------------------------------

check('A RUNNING SESSION IS NEVER REMOVED', () => {
  // Given a stamped end time, so the ONLY thing standing between live work and
  // removal is the status check. Written this way deliberately: with
  // `endedAt: null` these rows are saved by a different guard, and the test
  // would keep passing after the status check was deleted.
  const stale = Date.now() - 30 * DAY;
  const d = daemonWith([
    fakeSession('active', { status: STATUS.ACTIVE, endedAt: stale }),
    fakeSession('starting', { status: STATUS.STARTING, endedAt: stale }),
    fakeSession('waiting', { status: STATUS.WAITING_APPROVAL, endedAt: stale }),
  ]);
  const r = d.forgetSessions({});
  assert.strictEqual(r.count, 0, 'a tidy-up that can reach live work is a remote kill with a friendly label');
  assert.strictEqual(d.sessions.size, 3);
});

check('a session waiting on a person is never removed, even asked to forget everything', () => {
  const d = daemonWith([fakeSession('w', { status: STATUS.WAITING_APPROVAL, endedAt: Date.now() - 30 * DAY })]);
  assert.strictEqual(d.forgetSessions({ olderThanMs: 0 }).count, 0,
    'the one row that cannot make progress on its own is the one nobody may tidy away');
});

check('A SESSION WHOSE AGENT IS STILL ALIVE IS NEVER REMOVED, whatever its status says', () => {
  // Terminal status, but the process is this very test runner: provably alive.
  const d = daemonWith([fakeSession('zombie', { status: STATUS.DONE, pid: process.pid })]);
  const r = d.forgetSessions({});
  assert.strictEqual(r.count, 0,
    'deleting the record would leave the process running with nothing supervising it -- an invisible orphan');
  assert.strictEqual(d.sessions.has('zombie'), true);
});

check('a terminal session with no end time yet is left for the next beat', () => {
  const d = daemonWith([fakeSession('half', { status: STATUS.DONE, endedAt: null })]);
  assert.strictEqual(d.forgetSessions({}).count, 0,
    'a terminal status with no endedAt has not finished being written down');
});

check('forget never kills anything', () => {
  const d = daemonWith([fakeSession('a')]);
  let killed = false;
  const realKill = process.kill;
  // Allow the liveness probe (signal 0) and fail on anything that would signal.
  process.kill = (pid, sig) => { if (sig !== 0) killed = true; return realKill.call(process, pid, 0); };
  try { d.forgetSessions({}); } finally { process.kill = realKill; }
  assert.strictEqual(killed, false, 'forget is record-keeping; the day it learns to end a session is the day it becomes stop');
});

// ---------------------------------------------------------------------------
// The age window
// ---------------------------------------------------------------------------

check('a window keeps what ended inside it', () => {
  const now = Date.now();
  const d = daemonWith([
    fakeSession('old', { endedAt: now - 10 * DAY }),
    fakeSession('recent', { endedAt: now - 1 * HOUR }),
  ]);
  const r = d.forgetSessions({ olderThanMs: 7 * DAY });
  assert.deepStrictEqual(r.forgotten, ['old']);
  assert.strictEqual(d.sessions.has('recent'), true);
});

check('no window means every ended session', () => {
  const d = daemonWith([fakeSession('a', { endedAt: Date.now() })]);
  assert.strictEqual(d.forgetSessions({}).count, 1);
});

check('a nonsense window is refused rather than treated as "everything"', () => {
  const d = daemonWith([fakeSession('a')]);
  assert.throws(() => d.forgetSessions({ olderThanMs: -1 }), /non-negative/);
  assert.throws(() => d.forgetSessions({ olderThanMs: 'soon' }), /non-negative/);
  assert.strictEqual(d.sessions.has('a'), true, 'a refused sweep must remove nothing at all');
});

// ---------------------------------------------------------------------------
// How it reaches the daemon
// ---------------------------------------------------------------------------

checkAsync('the local IPC op reaches it', async () => {
  const d = daemonWith([fakeSession('a')]);
  const r = await d.handle({ op: 'forget' });
  assert.strictEqual(r.count, 1);
});

checkAsync('who asked is recorded, and comes from the caller', async () => {
  const d = daemonWith([fakeSession('a')]);
  const lines = [];
  d.log = (l) => lines.push(l);
  await d.handle({ op: 'forget', forgottenBy: 'ada@example.com' });
  assert.ok(lines.some((l) => l.includes('ada@example.com')),
    'a destructive action with no record of who took it is the answer to a different question');
});

check('the hub-facing op list still refuses everything it always refused', () => {
  const svc = fs.readFileSync(path.join(ROOT, 'src', 'service', 'hub-service.js'), 'utf8');
  const m = svc.match(/\/\^\\\/api\\\/devices\\\/\(\[\^\/\]\+\)\\\/\(([^)]+)\)\$\//);
  assert.ok(m, 'the control-op allow-list moved; find it before trusting this test');
  const ops = m[1].split('|');
  assert.ok(ops.includes('forget'), 'forget must be named to be reachable');
  for (const forbidden of ['start-session', 'shutdown', 'beat', 'status']) {
    assert.ok(!ops.includes(forbidden),
      `${forbidden} must never be reachable from the hub; the only thing keeping it out is this list`);
  }
});

check('the daemon still refuses an op nobody named', async () => {
  const d = daemonWith([]);
  await assert.rejects(() => d.handle({ op: 'forget-everything-everywhere' }), /unknown op/);
});

// ---------------------------------------------------------------------------
// A device that is never coming back
// ---------------------------------------------------------------------------
//
// Removal is normally a command to the device, because the device owns its
// session list and republishes it wholesale on every heartbeat -- so anything
// deleted hub-side would simply reappear.
//
// That argument depends on the device coming back. An ephemeral one does not:
// a Container Apps job execution registers under an id unique to that run,
// finishes, and is gone. There is no daemon left to command, and nothing that
// will ever re-publish the row. Before this, its finished sessions could not
// be cleared at all -- the only control offered refused with "device is
// offline", and the list kept every cloud job until retention expired it.
const { Store } = require(path.join(ROOT, 'src', 'service', 'store'));

function storeWith(sessions) {
  const st = new Store();
  st.registerDevice('subj', { deviceId: 'aca-job-1', name: 'cloud' });
  for (const s of sessions) st.upsertSession('subj', 'aca-job-1', s);
  return st;
}

check('a finished session on an offline device can be removed by the hub', () => {
  const st = storeWith([{ id: 's1', status: 'done' }]);
  const r = st.forgetDeviceSessions('subj', 'aca-job-1');
  assert.strictEqual(r.removed, 1, 'the finished session was not removed');
  assert.strictEqual(st.listSessions('subj').length, 0);
});

check('a session still RUNNING on an offline device is kept, because offline can mean a blip', () => {
  // The hazard this guards: "offline" is not proof the work stopped. A network
  // partition over a live session looks identical from here, and removing that
  // row would hide running work rather than tidy up finished work. It comes
  // back on reconnect anyway.
  const st = storeWith([{ id: 's1', status: 'running' }, { id: 's2', status: 'done' }]);
  const r = st.forgetDeviceSessions('subj', 'aca-job-1');
  assert.strictEqual(r.removed, 1, 'it should have removed only the finished one');
  assert.strictEqual(r.kept, 1);
  const left = st.listSessions('subj');
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].status, 'running', 'the running session was removed');
});

check('an age window is honoured, so "older than a day" does not clear this morning', () => {
  const st = storeWith([{ id: 's1', status: 'done' }]);
  const r = st.forgetDeviceSessions('subj', 'aca-job-1', { olderThanMs: 24 * 3600 * 1000 });
  assert.strictEqual(r.removed, 0, 'a session that ended seconds ago was swept by a one-day window');
  assert.strictEqual(r.kept, 1);
});

check('another device\'s sessions are never touched', () => {
  const st = storeWith([{ id: 's1', status: 'done' }]);
  st.registerDevice('subj', { deviceId: 'laptop', name: 'laptop' });
  st.upsertSession('subj', 'laptop', { id: 's9', status: 'done' });
  st.forgetDeviceSessions('subj', 'aca-job-1');
  const left = st.listSessions('subj');
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].deviceId, 'laptop');
});

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 100);
