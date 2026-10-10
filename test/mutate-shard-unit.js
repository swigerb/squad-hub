'use strict';
/**
 * `--shard N/K` for the mutation harness (test/helpers/shard.js).
 *
 * The flag exists so one sweep can run as K shards in K isolated checkouts and
 * still cover the whole catalogue. That only holds if the shards are an exact
 * partition: no mutation in two shards, none in no shard, none that is skipped.
 * These tests check the selection itself, on a fixture catalogue and on the
 * real one, and that a request which selects nothing is refused before the
 * harness spends minutes on a baseline.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseShard, shardFromArgv, selectMutations, planRun } = require('./helpers/shard');
const { MUTATIONS } = require('./mutate');

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

/** A catalogue with some skipped entries and two kinds of name. */
const fixture = Array.from({ length: 31 }, (_, i) => ({
  name: `fixture ${i % 3 === 0 ? 'alpha' : 'beta'} mutation ${i}`,
  ...(i % 7 === 6 ? { skip: 'not runnable here' } : {}),
}));
const runnable = fixture.filter((m) => !m.skip);

const shards = (catalogue, count, only = null) => Array.from({ length: count }, (_, n) => (
  selectMutations(catalogue, { only, shard: parseShard(`${n + 1}/${count}`) })));

/** Assert `parts` partition `whole` exactly, each part in catalogue order. */
function assertPartition(parts, whole) {
  const flat = parts.flat();
  assert.strictEqual(new Set(flat).size, flat.length, 'a mutation is in more than one shard');
  assert.strictEqual(flat.length, whole.length, 'a runnable mutation is in no shard');
  const inWhole = new Set(whole);
  for (const m of flat) assert.ok(inWhole.has(m), `a shard holds a mutation that is not runnable: ${m.name}`);
  for (const part of parts) {
    const at = part.map((m) => whole.indexOf(m));
    assert.deepStrictEqual(at, [...at].sort((a, b) => a - b), 'a shard is out of catalogue order');
  }
}

check('every shard count splits the runnable fixture catalogue into disjoint shards that cover it exactly', () => {
  assert.ok(runnable.length > 20 && runnable.length < fixture.length, 'the fixture should hold skipped entries');
  for (let k = 1; k <= runnable.length + 3; k += 1) assertPartition(shards(fixture, k), runnable);
});

check('shard sizes never differ by more than one', () => {
  for (let k = 1; k <= runnable.length + 3; k += 1) {
    const sizes = shards(fixture, k).map((s) => s.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `K=${k} gave sizes ${sizes.join(',')}`);
  }
});

check('shard N of K takes the runnable ordinals N-1, N-1+K, N-1+2K and so on', () => {
  const ordinals = (n, k) => selectMutations(fixture, { shard: parseShard(`${n}/${k}`) }).map((m) => runnable.indexOf(m));
  assert.deepStrictEqual(ordinals(1, 4), [0, 4, 8, 12, 16, 20, 24]);
  assert.deepStrictEqual(ordinals(2, 4), [1, 5, 9, 13, 17, 21, 25]);
  assert.deepStrictEqual(ordinals(4, 4), [3, 7, 11, 15, 19, 23]);
  assert.deepStrictEqual(ordinals(1, 1), runnable.map((_, i) => i));
  assert.deepStrictEqual(ordinals(5, 5), [4, 9, 14, 19, 24]);
});

check('a skipped mutation is in no shard', () => {
  const skipped = fixture.filter((m) => m.skip);
  assert.ok(skipped.length > 0);
  for (const part of shards(fixture, 4)) for (const m of skipped) assert.ok(!part.includes(m), `${m.name} was selected`);
  assert.deepStrictEqual(selectMutations(fixture), runnable);
});

check('only narrows first, so the ordinal is taken over the filtered list and the shards stay even', () => {
  // The matching entries sit at ordinals 0, 4, 8 and 12 of the whole list, so an
  // ordinal taken before the filter would put every one of them in shard 1 of 4.
  const spread = Array.from({ length: 16 }, (_, i) => ({ name: `fixture ${i % 4 === 0 ? 'pick' : 'other'} ${i}` }));
  const picked = spread.filter((m) => m.name.includes('pick'));
  assert.strictEqual(picked.length, 4);
  const parts = shards(spread, 4, 'pick');
  assertPartition(parts, picked);
  assert.deepStrictEqual(parts.map((p) => p.length), [1, 1, 1, 1]);
  assert.deepStrictEqual(selectMutations(fixture, { only: 'alpha' }), runnable.filter((m) => m.name.includes('alpha')));
});

check('no shard flag selects every runnable mutation in catalogue order, as before', () => {
  assert.deepStrictEqual(selectMutations(fixture), runnable);
  assert.deepStrictEqual(selectMutations(fixture, { shard: null }), runnable);
  const plain = planRun([], fixture, null);
  assert.strictEqual(plain.shard, null);
  assert.deepStrictEqual(plain.selected, runnable);
  assert.strictEqual(plain.total, runnable.length);
  assert.deepStrictEqual(planRun(['--full'], fixture, 'beta').selected, runnable.filter((m) => m.name.includes('beta')));
});

check('planRun reports the shard, what it selected and the runnable total it was cut from', () => {
  const half = planRun(['--shard', '2/4'], fixture, null);
  assert.strictEqual(half.shard.label, '2/4');
  assert.strictEqual(half.total, runnable.length);
  assert.deepStrictEqual(half.selected, selectMutations(fixture, { shard: parseShard('2/4') }));
  const alphas = runnable.filter((m) => m.name.includes('alpha'));
  const narrowed = planRun(['--shard', '1/2'], fixture, 'alpha');
  assert.strictEqual(narrowed.total, alphas.length);
  assert.deepStrictEqual(narrowed.selected, alphas.filter((_, i) => i % 2 === 0));
  assert.ok(narrowed.selected.every((m) => m.name.includes('alpha')));
});

check('the real catalogue splits into four shards whose union is exactly its runnable mutations', () => {
  const real = MUTATIONS.filter((m) => !m.skip);
  assert.ok(real.length > 1000, 'the catalogue should hold its mutations');
  for (const k of [2, 3, 4, 7]) {
    const parts = shards(MUTATIONS, k);
    assertPartition(parts, real);
    const sizes = parts.map((p) => p.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `K=${k} gave sizes ${sizes.join(',')}`);
  }
  const filtered = real.filter((m) => m.name.includes('[suite index]'));
  assert.ok(filtered.length >= 4);
  assertPartition(shards(MUTATIONS, 4, '[suite index]'), filtered);
});

check('a missing, malformed or out-of-range shard is rejected', () => {
  const bad = [undefined, null, 4, '', 'x', '4', '/4', '1/', '0/4', '1/0', '0/0', '5/4', '-1/4', '1/-4', '1.5/4', '1/4.0',
    '1/4/2', ' 1/4', '1/4 ', '01/4', '1/04', '1:4', '1-4', 'a/b', '9007199254740993/9007199254740993'];
  for (const text of bad) assert.throws(() => parseShard(text), /--shard/, `accepted ${JSON.stringify(text)}`);
});

check('a valid shard is read as its zero-based index and its count', () => {
  assert.deepStrictEqual(parseShard('1/1'), { index: 0, count: 1, label: '1/1' });
  assert.deepStrictEqual(parseShard('2/4'), { index: 1, count: 4, label: '2/4' });
  assert.deepStrictEqual(parseShard('4/4'), { index: 3, count: 4, label: '4/4' });
  assert.deepStrictEqual(parseShard('10/12'), { index: 9, count: 12, label: '10/12' });
});

check('the flag is read from the command line: absent means none, its value must follow it, a repeat is refused', () => {
  assert.strictEqual(shardFromArgv([]), null);
  assert.strictEqual(shardFromArgv(['--only', 'x', '--full']), null);
  assert.deepStrictEqual(shardFromArgv(['--only', 'x', '--shard', '2/4', '--full']), { index: 1, count: 4, label: '2/4' });
  assert.throws(() => shardFromArgv(['--shard']), /--shard/);
  assert.throws(() => shardFromArgv(['--shard', '--full']), /--shard/);
  assert.throws(() => shardFromArgv(['--shard', '1/4', '--shard', '2/4']), /more than once/);
  assert.throws(() => shardFromArgv(['--shard', '5/4']), /N <= K/);
});

check('a shard with nothing to run is an error, not a clean sweep', () => {
  const three = fixture.slice(0, 3);
  assert.deepStrictEqual(planRun(['--shard', '3/4'], three, null).selected, [three[2]]);
  assert.throws(() => planRun(['--shard', '4/4'], three, null), /nothing to run/);
  assert.throws(() => planRun(['--shard', '2/2'], three, 'no such name'), /nothing to run/);
  assert.throws(() => planRun(['--shard', '2/2'], [{ name: 'fixture only one' }], null), /nothing to run/);
  assert.throws(() => planRun(['--shard', '1/2'], [{ name: 'fixture skipped', skip: 'x' }], null), /nothing to run/);
});

check('the CLI refuses a bad shard, an empty shard or a filter that matches nothing before any baseline runs', () => {
  const cases = [
    [['--shard', '0/4'], /--shard needs N\/K/],
    [['--shard', '5/4'], /N <= K/],
    [['--shard'], /--shard needs N\/K/],
    [['--shard', '1/4', '--shard', '2/4'], /more than once/],
    [['--shard', `${MUTATIONS.length + 1}/${MUTATIONS.length + 1}`], /nothing to run/],
    [['--only', 'no mutation has this name anywhere'], /nothing ran/],
    [['--only', 'no mutation has this name anywhere', '--shard', '1/4'], /nothing ran/],
  ];
  for (const [args, message] of cases) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'mutate.js'), ...args], { encoding: 'utf8', timeout: 30000 });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.strictEqual(r.status, 2, `${args.join(' ')} exited ${r.status}: ${out.slice(0, 300)}`);
    assert.match(out, message, args.join(' '));
    assert.ok(!/baseline/i.test(out), `${args.join(' ')} started a baseline`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
