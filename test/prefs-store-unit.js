'use strict';
/**
 * Per-user preferences: the store, directly.
 *
 * prefs-api-unit.js proves the ROUTE applies these rules to a real HTTP
 * request from a real principal. This proves the rules themselves: caps are
 * enforced, wrong shapes are refused rather than coerced, one subject's
 * record never leaks into another's, and a PUT replaces the whole record
 * rather than merging into it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PrefsStore, MAX_PINS, MAX_NAMES, MAX_NAME_LEN,
} = require('../src/service/prefs-store');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sqh-prefs-'));
}

// --- defaults and basic round trip ------------------------------------------

check('a subject with no saved preferences gets empty defaults', () => {
  const s = new PrefsStore({ dir: null });
  assert.deepStrictEqual(s.get('nobody'), { pins: [], names: {}, view: null });
});

check('a valid PUT is readable back by GET, for the subject that saved it', () => {
  const s = new PrefsStore({ dir: null });
  const body = {
    pins: ['dev:1', 'dev:2'],
    names: { 'dev:1': 'release branch' },
    view: {
      scope: 'mine', groupBy: 'device', sortBy: 'recent', filters: { status: 'active' },
    },
  };
  const r = s.set('alice', body);
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual(s.get('alice'), body);
});

// --- partitioning ------------------------------------------------------------

check('one subject writing preferences does not affect another subject', () => {
  const s = new PrefsStore({ dir: null });
  s.set('alice', { pins: ['a:1'] });
  s.set('bob', { pins: ['b:1'] });
  assert.deepStrictEqual(s.get('alice').pins, ['a:1']);
  assert.deepStrictEqual(s.get('bob').pins, ['b:1']);
});

// --- PUT replaces the whole record -------------------------------------------

check('a PUT that omits a field reverts that field to its default, rather than leaving it as it was', () => {
  const s = new PrefsStore({ dir: null });
  s.set('alice', { pins: ['a:1'], names: { 'a:1': 'first' }, view: { scope: 'mine' } });
  const r = s.set('alice', { pins: ['a:2'] });
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual(s.get('alice'), { pins: ['a:2'], names: {}, view: null });
});

check('duplicate pins in one PUT are de-duplicated rather than rejected', () => {
  const s = new PrefsStore({ dir: null });
  const r = s.set('alice', { pins: ['a:1', 'a:1', 'a:2'] });
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual(r.prefs.pins, ['a:1', 'a:2']);
});

// --- caps --------------------------------------------------------------------

check(`pins may not exceed ${MAX_PINS}`, () => {
  const s = new PrefsStore({ dir: null });
  const pins = Array.from({ length: MAX_PINS + 1 }, (_, i) => `dev:${i}`);
  const r = s.set('alice', { pins });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, new RegExp(String(MAX_PINS)));
  // The refusal must not have left a partial write behind.
  assert.deepStrictEqual(s.get('alice').pins, []);
});

check(`exactly ${MAX_PINS} pins is accepted`, () => {
  const s = new PrefsStore({ dir: null });
  const pins = Array.from({ length: MAX_PINS }, (_, i) => `dev:${i}`);
  const r = s.set('alice', { pins });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.prefs.pins.length, MAX_PINS);
});

check(`names may not exceed ${MAX_NAMES} entries`, () => {
  const s = new PrefsStore({ dir: null });
  const names = {};
  for (let i = 0; i < MAX_NAMES + 1; i += 1) names[`dev:${i}`] = 'x';
  const r = s.set('alice', { names });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, new RegExp(String(MAX_NAMES)));
});

check(`a name longer than ${MAX_NAME_LEN} characters is refused`, () => {
  const s = new PrefsStore({ dir: null });
  const r = s.set('alice', { names: { 'dev:1': 'x'.repeat(MAX_NAME_LEN + 1) } });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, new RegExp(String(MAX_NAME_LEN)));
});

check(`a name of exactly ${MAX_NAME_LEN} characters is accepted`, () => {
  const s = new PrefsStore({ dir: null });
  const name = 'x'.repeat(MAX_NAME_LEN);
  const r = s.set('alice', { names: { 'dev:1': name } });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.prefs.names['dev:1'], name);
});

// --- wrong shapes and types are refused, never coerced -----------------------

check('pins must be an array, not a string', () => {
  const s = new PrefsStore({ dir: null });
  const r = s.set('alice', { pins: 'dev:1' });
  assert.strictEqual(r.ok, false);
});

check('each pin must be a string, not a number', () => {
  const s = new PrefsStore({ dir: null });
  const r = s.set('alice', { pins: [42] });
  assert.strictEqual(r.ok, false);
});

check('an empty-string pin is refused', () => {
  const s = new PrefsStore({ dir: null });
  const r = s.set('alice', { pins: [''] });
  assert.strictEqual(r.ok, false);
});

check('names must be an object, not an array', () => {
  const s = new PrefsStore({ dir: null });
  const r = s.set('alice', { names: ['not', 'an', 'object'] });
  assert.strictEqual(r.ok, false);
});

check('a name value must be a string, not a number', () => {
  const s = new PrefsStore({ dir: null });
  const r = s.set('alice', { names: { 'dev:1': 42 } });
  assert.strictEqual(r.ok, false);
});

check('view must be an object or null, not a string', () => {
  const s = new PrefsStore({ dir: null });
  const r = s.set('alice', { view: 'mine' });
  assert.strictEqual(r.ok, false);
});

check('view.filters must be an object, not a string', () => {
  const s = new PrefsStore({ dir: null });
  const r = s.set('alice', { view: { filters: 'status=active' } });
  assert.strictEqual(r.ok, false);
});

check('an unknown top-level field is refused outright', () => {
  const s = new PrefsStore({ dir: null });
  const r = s.set('alice', { pins: [], evil: true });
  assert.strictEqual(r.ok, false);
});

check('an unknown view field is refused outright', () => {
  const s = new PrefsStore({ dir: null });
  const r = s.set('alice', { view: { scope: 'mine', notAField: 1 } });
  assert.strictEqual(r.ok, false);
});

check('the body itself must be an object, not an array or a scalar', () => {
  const s = new PrefsStore({ dir: null });
  assert.strictEqual(s.set('alice', []).ok, false);
  assert.strictEqual(s.set('alice', 'nope').ok, false);
  assert.strictEqual(s.set('alice', null).ok, false);
});

// --- persistence --------------------------------------------------------------

check('preferences survive a restart when a directory is configured', () => {
  const dir = tmpdir();
  const s1 = new PrefsStore({ dir, persist: true });
  const r = s1.set('alice', { pins: ['a:1'], names: { 'a:1': 'first' } });
  assert.strictEqual(r.ok, true, r.reason);

  const s2 = new PrefsStore({ dir, persist: true });
  assert.deepStrictEqual(s2.get('alice'), { pins: ['a:1'], names: { 'a:1': 'first' }, view: null });
});

check('a memory-only store (no directory) works and is not durable', () => {
  const s = new PrefsStore({ dir: null });
  assert.strictEqual(s.persist, false);
  const r = s.set('alice', { pins: ['a:1'] });
  assert.strictEqual(r.ok, true, r.reason);
});

check('a preferences file with no shape marker is refused rather than trusted', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ not: 'the right shape' }));
  const s = new PrefsStore({ dir, persist: true });
  assert.strictEqual(s.ok, false, 'a file with no shape marker was loaded anyway');
  assert.strictEqual(s.set('alice', { pins: ['a:1'] }).ok, false, 'a store that failed to load still accepted a write');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
