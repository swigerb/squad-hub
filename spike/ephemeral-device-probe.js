#!/usr/bin/env node
'use strict';
/**
 * A0 premise 6: does a flood of one-shot ACA devices break the device roster?
 *
 * Every ACA job execution would register its own device, run one session, and
 * end. Over a week that is hundreds of devices. Two questions have to be
 * answered BEFORE anything creates that flood, because afterwards is too late:
 *
 *   1. Do finished job devices ever leave? (_pruneStale keeps any device that
 *      has sessions -- deliberately, so history survives. So the answer may be
 *      "never", which would be unbounded growth.)
 *   2. Does a real laptop still survive pruning once the roster is full of them?
 *      A retention rule that reaps the machine you actually use is worse than
 *      no retention rule.
 *
 * This is a SPIKE against the real Store, not a mock.
 */

const assert = require('assert');
const path = require('path');

const { Store } = require(path.join(__dirname, '..', 'src', 'service', 'store'));

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n         ${e.message}`); }
}

const SUB = 'user-1';
const N = 200;

function freshStore() {
  return new Store({ staleAfterMs: 45000, offlineAfterMs: 120000, forgetAfterMs: 3600000 });
}

/** One ACA job: registers, runs a session, finishes, never heard from again. */
function addFinishedJobDevice(store, i, ageMs) {
  const id = `aca-exec-${i}`;
  store.registerDevice(SUB, { deviceId: id, name: `ACA job ${i}`, platform: 'linux' });
  store.upsertSession(SUB, id, { id: `s-${i}`, title: `job ${i}`, status: 'done' });
  // Age both the device and the session's recorded finish time. endedAt is
  // stamped by the store, so it has to be moved here rather than passed in --
  // which is the point: a device cannot age its own sessions out.
  const rec = store._bucket(SUB).devices.get(id);
  rec.lastSeen = Date.now() - ageMs;
  const s = store._bucket(SUB).sessions.get(`${id}:s-${i}`);
  s.endedAt = Date.now() - ageMs;
  return id;
}

console.log('ephemeral device flood probe');
console.log('='.repeat(60));
console.log(`simulating ${N} finished ACA job devices\n`);

check('a flood of long-finished job devices IS reaped', () => {
  // This measured the opposite before retention existed: 200 devices still
  // listed after thirty simulated days, and 1000 jobs holding 1000 devices and
  // 1000 sessions in memory.
  const store = freshStore();
  for (let i = 0; i < N; i += 1) addFinishedJobDevice(store, i, 30 * 86400000);
  const listed = store.listDevices(SUB);
  console.log(`       ${listed.length} of ${N} still listed after 30 simulated days`);
  assert.strictEqual(listed.length, 0, `${listed.length} job devices survived`);
});

check('a job that finished RECENTLY is still there to read', () => {
  // Retention must not erase this morning's run before anyone looks at it.
  const store = freshStore();
  addFinishedJobDevice(store, 1, 60000);
  assert.strictEqual(store.listDevices(SUB).length, 1, 'a run from a minute ago was already gone');
});

check('the laptop is not buried by them', () => {
  const store = freshStore();
  store.registerDevice(SUB, { deviceId: 'laptop', name: 'BS-LAPTOP', platform: 'win32' });
  for (let i = 0; i < N; i += 1) addFinishedJobDevice(store, i, 30 * 86400000);
  const listed = store.listDevices(SUB);
  console.log(`       roster is now ${listed.length} device(s)`);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].deviceId, 'laptop');
});

check('a RUNNING session is never aged out', () => {
  // The regression this risks: reaping live work because its device looks old.
  const store = freshStore();
  store.registerDevice(SUB, { deviceId: 'slow-job', name: 'long job', platform: 'linux' });
  store.upsertSession(SUB, 'slow-job', { id: 'live', title: 'still going', status: 'active' });
  store._bucket(SUB).devices.get('slow-job').lastSeen = Date.now() - 30 * 86400000;
  const listed = store.listDevices(SUB);
  assert.strictEqual(listed.length, 1, 'a device with a running session was reaped');
});

check('presence is still computed correctly at scale', () => {
  const store = freshStore();
  store.registerDevice(SUB, { deviceId: 'laptop', name: 'BS-LAPTOP', platform: 'win32' });
  // Five minutes: past the 2-minute offline threshold, well inside the
  // 15-minute forget window, so these are kept AND reported offline.
  for (let i = 0; i < N; i += 1) addFinishedJobDevice(store, i, 5 * 60000);
  const listed = store.listDevices(SUB);
  const laptop = listed.find((d) => d.deviceId === 'laptop');
  assert.strictEqual(laptop.presence, 'online', 'a live laptop was misreported');
  const offline = listed.filter((d) => d.presence === 'offline').length;
  assert.strictEqual(offline, N, `expected ${N} offline job devices, saw ${offline}`);
});

check('a job device with NO session is reaped normally', () => {
  const store = freshStore();
  store.registerDevice(SUB, { deviceId: 'aca-nosession', name: 'ACA job x', platform: 'linux' });
  store._bucket(SUB).devices.get('aca-nosession').lastSeen = Date.now() - 30 * 86400000;
  assert.strictEqual(store.listDevices(SUB).length, 0);
});

check('a laptop that is merely OFFLINE for a while is still kept', () => {
  // A real machine switched off over a long weekend must not vanish.
  const store = freshStore();
  store.registerDevice(SUB, { deviceId: 'laptop', name: 'BS-LAPTOP', platform: 'win32' });
  store.upsertSession(SUB, 'laptop', { id: 'work-1', title: 'real work', status: 'done' });
  store._bucket(SUB).devices.get('laptop').lastSeen = Date.now() - 3 * 86400000;
  assert.ok(store.listDevices(SUB).find((d) => d.deviceId === 'laptop'),
    'the laptop was reaped after a long weekend');
});

check('memory does not grow without bound', () => {
  const store = freshStore();
  for (let i = 0; i < 1000; i += 1) addFinishedJobDevice(store, i, 30 * 86400000);
  store.listDevices(SUB);   // triggers the prune
  const b = store._bucket(SUB);
  console.log(`       after 1000 finished jobs: ${b.devices.size} devices, ${b.sessions.size} sessions held`);
  assert.strictEqual(b.devices.size, 0);
  assert.strictEqual(b.sessions.size, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
