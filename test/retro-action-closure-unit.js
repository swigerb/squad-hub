#!/usr/bin/env node
'use strict';
/**
 * `scripts/retro-action-closure.js` -- the decision, isolated from `gh`.
 *
 * Issue #100's Definition of done requires closure to be a real, observable
 * step once the retrospective is logged, not a sentence of prose. The DECISION
 * of which issues qualify is pure (no network, no `gh` binary), so these tests
 * exercise it directly with plain fixtures -- the workflow and the CLI wrapper
 * both delegate to this same function, so proving it here proves both.
 */

const assert = require('assert');
const path = require('path');

const MOD = path.join(__dirname, '..', 'scripts', 'retro-action-closure.js');
const {
  markerFor, hasTestsFailureMarker, issuesToClose,
} = require(MOD);

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

function issueOpenedForRun(runId, overrides = {}) {
  return {
    number: 1,
    state: 'open',
    labels: ['retro-action'],
    body: [`some report body`, '', `Record: ${markerFor(runId)}`].join('\n'),
    ...overrides,
  };
}

console.log('retro-action-closure: which issues a logged retrospective closes');
console.log('='.repeat(60));

check('nothing closes while a retrospective is still overdue', () => {
  const issues = [issueOpenedForRun(123)];
  assert.deepStrictEqual(issuesToClose(issues, { retroOverdue: true }), []);
});

check('a retro-action issue carrying the test-failure marker closes once the retro is logged', () => {
  const issue = issueOpenedForRun(123);
  const closed = issuesToClose([issue], { retroOverdue: false });
  assert.deepStrictEqual(closed, [issue]);
});

check('an already-closed issue is left alone', () => {
  const issue = issueOpenedForRun(123, { state: 'closed' });
  assert.deepStrictEqual(issuesToClose([issue], { retroOverdue: false }), []);
});

check('a retro-action issue WITHOUT the marker (filed by hand) is left alone', () => {
  const issue = { number: 2, state: 'open', labels: ['retro-action'], body: 'filed manually, no marker here' };
  assert.deepStrictEqual(issuesToClose([issue], { retroOverdue: false }), []);
});

check('an issue with the marker but missing the retro-action label is left alone', () => {
  const issue = issueOpenedForRun(123, { labels: ['type:chore'] });
  assert.deepStrictEqual(issuesToClose([issue], { retroOverdue: false }), []);
});

check('object-shaped labels ({name}) are read the same as plain strings', () => {
  const issue = issueOpenedForRun(123, { labels: [{ name: 'retro-action' }] });
  assert.deepStrictEqual(issuesToClose([issue], { retroOverdue: false }), [issue]);
});

check('only the matching run qualifies -- other open retro-action issues are untouched', () => {
  const mine = issueOpenedForRun(123);
  const someoneElses = issueOpenedForRun(456, { number: 2 });
  const closed = issuesToClose([mine, someoneElses], { retroOverdue: false });
  assert.deepStrictEqual(closed.map((i) => i.number).sort(), [1, 2],
    'both carry a valid test-failure marker for THEIR OWN run, so both should close');
});

check('hasTestsFailureMarker is false for a body with no marker at all', () => {
  assert.strictEqual(hasTestsFailureMarker('nothing to see here'), false);
  assert.strictEqual(hasTestsFailureMarker(undefined), false);
  assert.strictEqual(hasTestsFailureMarker(null), false);
});

check('markerFor is stable per run id, so the same run never gets two markers', () => {
  assert.strictEqual(markerFor(999), markerFor(999));
  assert.notStrictEqual(markerFor(999), markerFor(1000));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
