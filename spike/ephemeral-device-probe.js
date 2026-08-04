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
  store.upsertSession(SUB, id, {
    sessionId: `s-${i}`, title: `job ${i}`, status: 'completed', updatedAt: Date.now() - ageMs,
  });
  const rec = store._bucket(SUB).devices.get(id);
  rec.lastSeen = Date.now() - ageMs;      // long gone
  return id;
}

console.log('ephemeral device flood probe');
console.log('='.repeat(60));
console.log(`simulating ${N} finished ACA job devices\n`);

check('a flood of finished job devices is NOT reaped today', () => {
  // Establishes the current behaviour. If this ever starts failing, retention
  // changed and this probe should be revisited rather than deleted.
  const store = freshStore();
  for (let i = 0; i < N; i += 1) addFinishedJobDevice(store, i, 30 * 86400000); // 30 days old
  const listed = store.listDevices(SUB);   // triggers _pruneStale
  assert.strictEqual(listed.length, N,
    `expected all ${N} to survive (sessions pin them), saw ${listed.length}`);
  console.log(`       ${listed.length} devices still listed after 30 simulated days`);
});

check('the laptop is buried by them', () => {
  const store = freshStore();
  store.registerDevice(SUB, { deviceId: 'laptop', name: 'BS-LAPTOP', platform: 'win32' });
  for (let i = 0; i < N; i += 1) addFinishedJobDevice(store, i, 30 * 86400000);
  const listed = store.listDevices(SUB);
  const idx = listed.findIndex((d) => d.deviceId === 'laptop');
  console.log(`       the laptop is item ${idx + 1} of ${listed.length}`);
  assert.ok(listed.length > 50, 'not enough devices to demonstrate the problem');
});

check('presence is still computed correctly at scale', () => {
  // The flood must not make ONLINE devices look wrong -- that would be a
  // correctness bug on top of a usability one.
  const store = freshStore();
  store.registerDevice(SUB, { deviceId: 'laptop', name: 'BS-LAPTOP', platform: 'win32' });
  for (let i = 0; i < N; i += 1) addFinishedJobDevice(store, i, 30 * 86400000);
  const listed = store.listDevices(SUB);
  const laptop = listed.find((d) => d.deviceId === 'laptop');
  assert.strictEqual(laptop.presence, 'online', 'a live laptop was misreported');
  const offline = listed.filter((d) => d.presence === 'offline').length;
  assert.strictEqual(offline, N, `expected ${N} offline job devices, saw ${offline}`);
});

check('a job device with NO session is reaped normally', () => {
  // Confirms the existing rule is exactly "sessions pin a device", so any fix
  // has to address session retention, not device retention.
  const store = freshStore();
  store.registerDevice(SUB, { deviceId: 'aca-nosession', name: 'ACA job x', platform: 'linux' });
  store._bucket(SUB).devices.get('aca-nosession').lastSeen = Date.now() - 30 * 86400000;
  const listed = store.listDevices(SUB);
  assert.strictEqual(listed.find((d) => d.deviceId === 'aca-nosession'), undefined,
    'a device with no sessions was kept, so the cause is not sessions');
});

check('a laptop that is merely OFFLINE for a while is still kept', () => {
  // The regression any retention change risks: reaping a real machine that was
  // switched off over a weekend.
  const store = freshStore();
  store.registerDevice(SUB, { deviceId: 'laptop', name: 'BS-LAPTOP', platform: 'win32' });
  store.upsertSession(SUB, 'laptop', {
    sessionId: 'work-1', title: 'real work', status: 'completed', updatedAt: Date.now(),
  });
  store._bucket(SUB).devices.get('laptop').lastSeen = Date.now() - 3 * 86400000; // 3 days
  const listed = store.listDevices(SUB);
  assert.ok(listed.find((d) => d.deviceId === 'laptop'), 'the laptop was reaped after a long weekend');
});

check('memory grows linearly and is not trivially bounded', () => {
  const store = freshStore();
  for (let i = 0; i < 1000; i += 1) addFinishedJobDevice(store, i, 30 * 86400000);
  const b = store._bucket(SUB);
  console.log(`       1000 jobs -> ${b.devices.size} devices, ${b.sessions.size} sessions in memory`);
  assert.strictEqual(b.devices.size, 1000);
  assert.strictEqual(b.sessions.size, 1000);
});

console.log(`\n${pass} passed, ${fail} failed`);
console.log('\nNote: these assertions describe TODAY. They are a measurement, not a target.');
process.exit(fail ? 1 : 0);
