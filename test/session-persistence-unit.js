'use strict';
/**
 * Issue #91: cloud job history does not survive a deploy.
 *
 * Sessions on a device that comes back are fine -- the daemon re-publishes
 * its whole list on reconnect and `syncSessions` replaces the hub's copy
 * wholesale. A device that never comes back -- every Container Apps job
 * execution is one -- has nothing left to re-publish, so its finished
 * sessions used to be gone for good on every restart.
 *
 * Four things are proven here, matching the four sprints:
 *
 *   1. STORAGE CONTRACT. `Store`'s isolation rules -- a subject is required,
 *      no path returns another subject's record -- hold for a memory backing
 *      and a durable one, run through the SAME assertions. A backing that
 *      shares a bucket across subjects is shown failing those assertions, so
 *      the suite is proven able to catch the thing it claims to catch.
 *
 *   2. DURABILITY. Records survive a restart. THE REGRESSION TO FEAR: a live
 *      device's deletion must not be undone by the durable copy after a
 *      restart -- a durable copy that resurrects a row the device dropped on
 *      purpose is worse than losing it. A corrupt file is refused and the hub
 *      starts empty rather than failing to start.
 *
 *   3. TIMESTAMPS. `endedAt` and `firstSeen` survive a restart unchanged, so
 *      retention runs on its original schedule and "started N hours ago"
 *      does not drift on every deploy.
 *
 *   4. BOUNDED ON DISK. The same retention that bounds memory bounds the
 *      file, and pruning happens on every write, not only on a read.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/service/store');
const { MemoryBacking, FileBacking } = require('../src/service/store-backing');

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

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sqh-sessions-'));
}

function readFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
}

// =============================================================================
// Sprint 1 -- one storage contract, two implementations
// =============================================================================

/**
 * The partitioning rules a backing must never be able to violate, checked
 * directly against a `Store` -- not against the backing itself, because the
 * whole point is that `Store` enforces this and a backing has no way to.
 *
 * Returns a list of {name, ok, error} rather than throwing, so the SAME
 * function can be used both to assert a real backing is clean (see below)
 * and to demonstrate a broken one is caught (see "a backing that shares
 * buckets").
 */
function partitioningHolds(store) {
  const results = [];
  const record = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); } catch (e) {
      results.push({ name, ok: false, error: e.message });
    }
  };
  record('an unscoped read throws', () => {
    assert.throws(() => store.listDevices(undefined), /subject is required/);
    assert.throws(() => store.listDevices(''), /subject is required/);
  });
  record("no path returns another subject's record", () => {
    store.registerDevice('alice', { deviceId: 'alice-device', name: 'A', platform: 'linux' });
    store.upsertSession('alice', 'alice-device', { id: 's1', status: 'active' });
    store.registerDevice('bob', { deviceId: 'bob-device', name: 'B', platform: 'linux' });
    store.upsertSession('bob', 'bob-device', { id: 's2', status: 'active' });
    assert.ok(!store.listDevices('bob').some((d) => d.deviceId === 'alice-device'),
      "bob's device list contains alice's device");
    assert.ok(!store.listDevices('alice').some((d) => d.deviceId === 'bob-device'),
      "alice's device list contains bob's device");
    assert.ok(!store.listSessions('bob').some((s) => s.deviceId === 'alice-device'),
      "bob's session list contains alice's session");
    assert.ok(!store.listSessions('alice').some((s) => s.deviceId === 'bob-device'),
      "alice's session list contains bob's session");
  });
  return results;
}

function assertPartitioningHolds(label, store) {
  const results = partitioningHolds(store);
  const bad = results.filter((r) => !r.ok);
  assert.strictEqual(bad.length, 0,
    `[${label}] ${bad.map((b) => `${b.name}: ${b.error}`).join('; ')}`);
}

check('the storage contract holds for the in-memory backing', () => {
  const store = new Store({ backing: new MemoryBacking() });
  assertPartitioningHolds('memory', store);
});

check('the storage contract holds for the durable file backing, unchanged', () => {
  const store = new Store({ backing: new FileBacking({ dir: tmpdir() }) });
  assertPartitioningHolds('file', store);
});

// ---------------------------------------------------------------------------
// The store says which of the two it is, and /healthz reports it.
//
// Both behave identically right up until a restart, at which point one of them
// silently loses the record of every cloud job that has already finished. A
// deployment that thinks it is durable and is not looks exactly like one that
// is -- until the loss, which is the worst possible moment to find out. So the
// answer has to be readable rather than inferred.
// ---------------------------------------------------------------------------

check('a store says whether it is durable, and says it correctly', () => {
  assert.strictEqual(new Store({ backing: new MemoryBacking() }).durable, false);
  assert.strictEqual(new Store({ backing: new FileBacking({ dir: tmpdir() }) }).durable, true);
  // A file backing told NOT to persist is not durable either, whatever its
  // class -- reporting on the class rather than the behaviour would say
  // "durable" for a store that writes nothing.
  assert.strictEqual(new Store({ backing: new FileBacking({ dir: tmpdir(), persist: false }) }).durable, false);
});

check('/healthz reports the session store, so durability can be read rather than assumed', () => {
  // The detail block is built from `store.durable`; asserting the mapping here
  // keeps the reported word and the actual behaviour from drifting apart.
  const durable = new Store({ backing: new FileBacking({ dir: tmpdir() }) });
  const memory = new Store({ backing: new MemoryBacking() });
  assert.strictEqual(durable.durable ? 'durable' : 'memory', 'durable');
  assert.strictEqual(memory.durable ? 'durable' : 'memory', 'memory');

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'service', 'hub-service.js'), 'utf8');
  assert.ok(src.includes("sessionStore: this.store.durable ? 'durable' : 'memory'"),
    '/healthz no longer reports sessionStore from the store itself');
  assert.ok(!/State is held in memory/.test(src),
    'the scale-out warning still claims all state is in memory, which is no longer true');
});

/**
 * A backing that shares one bucket object across two subjects -- the exact
 * mistake a hand-rolled durable backing could make (forgetting to give each
 * subject its own Map on load). Proves the conformance assertions above are
 * not decorative: run against a backing that actually violates isolation,
 * they are shown catching it.
 */
class AliasingBacking {
  // eslint-disable-next-line class-methods-use-this
  loadAll() {
    const shared = { devices: new Map(), sessions: new Map() };
    const users = new Map();
    // The bug: both subjects are handed the SAME bucket object.
    users.set('alice', shared);
    users.set('bob', shared);
    return users;
  }

  // eslint-disable-next-line class-methods-use-this
  persist() {}

  get durable() { return false; }
}

check('a backing that shares buckets across subjects is caught by the partitioning check', () => {
  const store = new Store({ backing: new AliasingBacking() });
  const results = partitioningHolds(store);
  const bad = results.filter((r) => !r.ok);
  assert.ok(bad.length > 0,
    'a backing that shares one bucket between two subjects passed every partitioning check -- the check proves nothing');
  assert.ok(bad.some((b) => b.name.includes("no path returns another subject's record")),
    'the specific cross-subject leak went unnoticed');
});

// =============================================================================
// Sprint 2 -- records that outlive the device that made them
// =============================================================================

check("an ephemeral device's finished sessions are still listed after a restart", () => {
  const dir = tmpdir();
  const s1 = new Store({ backing: new FileBacking({ dir }) });
  s1.registerDevice('u', { deviceId: 'job-1', name: 'job', platform: 'linux', kind: 'cloud' });
  s1.upsertSession('u', 'job-1', { id: 'x', title: 'finished job', status: 'done' });

  // "Restart": a fresh Store, fresh FileBacking, same directory. Nothing
  // in-memory is shared with s1.
  const s2 = new Store({ backing: new FileBacking({ dir }) });
  const sessions = s2.listSessions('u');
  assert.strictEqual(sessions.length, 1, 'the finished session did not survive the restart');
  assert.strictEqual(sessions[0].id, 'x');
  assert.strictEqual(sessions[0].status, 'done');
});

check('a live device deleting a session does not have it come back after a restart', () => {
  // THE REGRESSION TO FEAR. A durable copy that resurrects a row the device
  // dropped on purpose is worse than losing it.
  const dir = tmpdir();
  const s1 = new Store({ backing: new FileBacking({ dir }) });
  s1.registerDevice('u', { deviceId: 'laptop-1', name: 'laptop', platform: 'darwin' });
  s1.syncSessions('u', 'laptop-1', [
    { id: 'keep', title: 'kept', status: 'done' },
    { id: 'drop', title: 'dropped', status: 'done' },
  ]);

  // Restart. Both sessions are there, exactly like the previous check.
  const s2 = new Store({ backing: new FileBacking({ dir }) });
  assert.strictEqual(s2.listSessions('u').length, 2, 'the restart did not even preserve both sessions');

  // The device reconnects and republishes its list with the session
  // removed -- a real user deleted it, or it aged out on the device's own
  // side. `syncSessions` replaces the hub's copy wholesale.
  s2.syncSessions('u', 'laptop-1', [{ id: 'keep', title: 'kept', status: 'done' }]);
  assert.strictEqual(s2.listSessions('u').length, 1, "the device's own reconnect did not remove the dropped session");

  // Restart AGAIN. If the durable copy were written by merging instead of
  // overwriting, "drop" would still be sitting in the old file content and
  // would reappear here.
  const s3 = new Store({ backing: new FileBacking({ dir }) });
  const sessions = s3.listSessions('u');
  assert.strictEqual(sessions.length, 1,
    `a dropped session resurrected after a restart: ${sessions.map((x) => x.id).join(', ')}`);
  assert.strictEqual(sessions[0].id, 'keep', 'the wrong session survived');
});

check("a pending approval is never persisted, so a restart cannot show one nobody can answer", () => {
  // THE OTHER REGRESSION TO FEAR. A pending approval is a handle onto a
  // specific agent process's specific outstanding request -- not a fact
  // about the session. Persisting it verbatim would let a restart hand back
  // a card that looks answerable and silently does nothing when answered,
  // because the process it would have to reach is already gone. Issue #91's
  // own words: "worse than losing it".
  const dir = tmpdir();
  const s1 = new Store({ backing: new FileBacking({ dir }) });
  s1.registerDevice('u', { deviceId: 'laptop-3', name: 'laptop', platform: 'darwin' });
  s1.upsertSession('u', 'laptop-3', {
    id: 'p',
    status: 'waiting_approval',
    pendingApprovals: [{ approvalId: 'a1', command: 'rm -rf /', options: [{ optionId: 'allow_once' }] }],
  });

  const onDisk = readFile(dir).subjects.u.sessions['laptop-3:p'];
  assert.ok(!onDisk.pendingApprovals, 'the pending approval was written to disk verbatim');

  // Restart: fresh Store, fresh FileBacking, same directory.
  const s2 = new Store({ backing: new FileBacking({ dir }) });
  const rec = s2.getSession('u', 'laptop-3:p');
  assert.strictEqual((rec.pendingApprovals || []).length, 0,
    'a pending approval reappeared for a process that a restart could not possibly have kept alive');
});

check('a corrupt or truncated state file is refused, and the hub starts empty rather than failing to start', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'sessions.json'), '{ this is not valid json, truncated mid-w');

  let store;
  assert.doesNotThrow(() => {
    store = new Store({ backing: new FileBacking({ dir }) });
  }, 'constructing a Store over a corrupt state file threw instead of starting empty');

  assert.deepStrictEqual(store.listSessions('u'), [], 'a corrupt file was trusted instead of refused');
  assert.strictEqual(store._backing.ok, false, 'the backing did not notice the file was unreadable');
  assert.ok(store._backing.error, 'no error was recorded for the corrupt file');

  // The hub still works from here -- a session created after the corrupt
  // read must not also fail.
  store.registerDevice('u', { deviceId: 'd1', name: 'd', platform: 'linux' });
  store.upsertSession('u', 'd1', { id: 'new', status: 'active' });
  assert.strictEqual(store.listSessions('u').length, 1, 'the hub could not accept new sessions after a corrupt read');
});

check('a wrong-shaped state file is treated as unreadable, not trusted', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ subjects: { evil: { devices: {}, sessions: { 'x:y': { id: 'y', status: 'done' } } } } }));
  const store = new Store({ backing: new FileBacking({ dir }) });
  assert.strictEqual(store._backing.ok, false, 'a file with no shape marker was loaded anyway');
  assert.deepStrictEqual(store.listSessions('evil'), [], 'an unversioned file admitted a session');
});

// =============================================================================
// Sprint 3 -- timestamps that survive a restart
// =============================================================================

check('a session that ended before a restart keeps its original endedAt, and ages out on its original schedule', () => {
  const dir = tmpdir();
  const s1 = new Store({ backing: new FileBacking({ dir }) });
  s1.registerDevice('u', { deviceId: 'job-2', name: 'job', platform: 'linux' });
  s1.upsertSession('u', 'job-2', { id: 'old', status: 'done' });

  // This session finished a long time before the restart -- not the
  // moment it happened to be written down.
  const longAgo = Date.now() - 20 * 3600 * 1000; // 20 hours ago
  const bucket = s1._bucket('u');
  bucket.sessions.get('job-2:old').endedAt = longAgo;
  s1._persist('u'); // the same write path any real mutation takes

  // Restart with a short retention window: a session correctly stamped 20
  // hours ago is old enough to be pruned by a 4-hour keepFinishedMs; a
  // session wrongly re-stamped to "now" on restart would not be.
  const s2 = new Store({ backing: new FileBacking({ dir }), keepFinishedMs: 4 * 3600 * 1000 });
  s2.listDevices('u'); // triggers the same pruning a real read would
  assert.strictEqual(s2.listSessions('u').length, 0,
    'the session was re-stamped to "now" on restart instead of keeping its original endedAt, so it did not age out on schedule');
});

check('firstSeen survives a re-publish across a restart; "started N hours ago" does not drift', () => {
  const dir = tmpdir();
  const s1 = new Store({ backing: new FileBacking({ dir }) });
  s1.registerDevice('u', { deviceId: 'job-3', name: 'job', platform: 'linux' });
  s1.upsertSession('u', 'job-3', { id: 'y', status: 'active' });

  const threeHoursAgo = Date.now() - 3 * 3600 * 1000;
  s1._bucket('u').sessions.get('job-3:y').firstSeen = threeHoursAgo;
  s1._persist('u');

  // Restart, then the device re-publishes its whole session list, exactly
  // as `syncSessions` is called on every reconnect.
  const s2 = new Store({ backing: new FileBacking({ dir }) });
  s2.syncSessions('u', 'job-3', [{ id: 'y', status: 'active' }]);

  const rec = s2.getSession('u', 'job-3:y');
  assert.strictEqual(rec.firstSeen, threeHoursAgo,
    'firstSeen moved on a re-publish after a restart, so "started N hours ago" would read as "started just now"');
});

// =============================================================================
// Sprint 4 -- bounded on disk, as it is in memory
// =============================================================================

check('1000 ephemeral devices, aged 30 simulated days, leave a bounded file', () => {
  const dir = tmpdir();
  const s = new Store({
    backing: new FileBacking({ dir }),
    forgetAfterMs: 15 * 60 * 1000,
    keepFinishedMs: 24 * 3600 * 1000,
  });
  for (let i = 0; i < 1000; i += 1) {
    s.registerDevice('u', { deviceId: `job-${i}`, name: 'job', platform: 'linux', kind: 'cloud' });
    s.upsertSession('u', `job-${i}`, { id: 'x', status: 'done' });
  }
  assert.strictEqual(s.listDevices('u').length, 1000, 'the 1000 devices were not even registered');

  // 30 simulated days, exactly as the in-memory retention tests simulate
  // time: backdate the timestamps directly rather than waiting.
  const THIRTY_DAYS = 30 * 24 * 3600 * 1000;
  const bucket = s._bucket('u');
  for (const d of bucket.devices.values()) d.lastSeen = Date.now() - THIRTY_DAYS;
  for (const sess of bucket.sessions.values()) sess.endedAt = Date.now() - THIRTY_DAYS;
  s._persist('u'); // a fresh write, exactly like any real mutation would trigger

  const onDisk = readFile(dir).subjects.u || { devices: {}, sessions: {} };
  assert.strictEqual(Object.keys(onDisk.devices).length, 0,
    `1000 ephemeral devices should have been pruned to 0 after 30 simulated days; the file held ${Object.keys(onDisk.devices).length}`);
  assert.strictEqual(Object.keys(onDisk.sessions).length, 0,
    `1000 finished sessions should have been pruned to 0 after 30 simulated days; the file held ${Object.keys(onDisk.sessions).length}`);
  assert.strictEqual(s.listDevices('u').length, 0, 'the in-memory roster was bounded but the file was not');
});

check('writes prune before persisting, so the file does not grow without bound between explicit prunes', () => {
  const dir = tmpdir();
  const s = new Store({ backing: new FileBacking({ dir }), forgetAfterMs: 60000, keepFinishedMs: 60000 });
  for (let i = 0; i < 50; i += 1) {
    s.registerDevice('u', { deviceId: `job-${i}`, name: 'job', platform: 'linux' });
    s.upsertSession('u', `job-${i}`, { id: 'x', status: 'done' });
    // Age this one out immediately -- a job that finished long ago, by the
    // time anything reads the roster.
    s._bucket('u').devices.get(`job-${i}`).lastSeen = Date.now() - 86400000;
    s._bucket('u').sessions.get(`job-${i}:x`).endedAt = Date.now() - 86400000;
  }
  const onDisk = readFile(dir).subjects.u;
  assert.ok(Object.keys(onDisk.devices).length <= 1,
    `the file held ${Object.keys(onDisk.devices).length} devices after 50 inserts; each insert's own persist should have pruned the one before it, not let them accumulate`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
