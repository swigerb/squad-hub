'use strict';
/**
 * Every mutation the harness used to run against the WHOLE suite now has an
 * owner: a standalone -unit.js file that declares the test it names, so the
 * harness runs that file alone.
 *
 * test/mutate.js falls back to the full run-tests.js when suiteFor() cannot
 * place a mustFail name -- minutes of work for one mutant, and a catch that
 * cannot be attributed. These names fell back because their tests were inline in
 * run-tests.js, or were titled from a runtime template. This pins where each one
 * lives now, that exactly one suite declares it, and that run-tests.js still runs
 * each owner exactly once (so moving a test out did not drop or duplicate it).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { suiteFor, MUTATIONS } = require('./mutate');
const { declaredTitles, readSuiteSources, buildSuiteIndex } = require('./helpers/suite-index');
const { check, finish } = require('./helpers/device-harness').resultReporter();

const OWNERS = [
  ['the orphan is recorded on disk so it can be found', 'orphan-hard-kill-unit.js'],
  ['a GitHub token is redacted before it can reach a channel', 'teams-unit.js'],
  ['a forged option id is rejected', 'option-forgery-unit.js'],
  ['a directory outside the root is refused', 'file-access-unit.js'],
  ['file access is OFF by default', 'device-lifecycle-unit.js'],
  ['the confinement path is NEVER in the reportable view', 'device-lifecycle-unit.js'],
  ['a done session is not controllable', 'control-verification-unit.js'],
  ['pins may not exceed 500', 'prefs-store-unit.js'],
  ['names may not exceed 500 entries', 'prefs-store-unit.js'],
  ['a name longer than 120 characters is refused', 'prefs-store-unit.js'],
  ['more than 25 subscriptions for one subject is refused', 'push-store-unit.js'],
  ['run-tests.js still wires in the escape-focus child suite and invocation', 'run-tests-wiring-unit.js'],
];

const nl = (s) => s.replace(/\r\n/g, '\n');
const runner = nl(fs.readFileSync(path.join(__dirname, 'run-tests.js'), 'utf8'));
const index = buildSuiteIndex(readSuiteSources(__dirname));

check('each formerly full-suite mustFail name resolves to its own standalone suite', () => {
  for (const [name, owner] of OWNERS) {
    assert.strictEqual(suiteFor(name), owner, `"${name}" must be placed in ${owner}`);
  }
});

check('each of those names is declared by exactly one suite file, as a literal check title', () => {
  for (const [name, owner] of OWNERS) {
    assert.deepStrictEqual([...(index.get(name) || [])], [owner], `"${name}" must be declared only by ${owner}`);
    assert.ok(declaredTitles(fs.readFileSync(path.join(__dirname, owner), 'utf8')).includes(name));
  }
});

check('no owner is run-tests.js, and every owner is an executable -unit.js file', () => {
  for (const [, owner] of OWNERS) {
    assert.ok(owner.endsWith('-unit.js') && owner !== 'run-tests.js', owner);
    assert.ok(fs.statSync(path.join(__dirname, owner)).isFile(), `${owner} is missing`);
  }
});

check('the inline run-tests.js copies are gone, so a test cannot run twice under npm test', () => {
  const inline = new Set(declaredTitles(runner));
  for (const [name] of OWNERS) assert.ok(!inline.has(name), `"${name}" is still declared inline in run-tests.js`);
});

check('run-tests.js runs each owner suite exactly once', () => {
  for (const owner of new Set(OWNERS.map(([, o]) => o))) {
    const calls = runner.split(`runChildSuite(path.join(__dirname, '${owner}')`).length - 1;
    // teams-unit.js and the other pre-existing owners were already registered; the new ones must be too.
    assert.strictEqual(calls, 1, `${owner} is registered ${calls} times in run-tests.js`);
  }
  assert.strictEqual(runner.split("runChildSuite(path.join(__dirname, 'fallback-owners-unit.js')").length - 1, 1);
});

check('every one of these names is still a named mutation in the catalogue', () => {
  const named = new Set(MUTATIONS.map((m) => m.mustFail));
  for (const [name] of OWNERS) assert.ok(named.has(name), `no mutation names "${name}" any more`);
});

check('both escape-focus runner mutations still find their anchor exactly once in run-tests.js', () => {
  const wiring = MUTATIONS.filter((m) => m.file === 'test/run-tests.js'
    && m.mustFail === 'run-tests.js still wires in the escape-focus child suite and invocation');
  assert.strictEqual(wiring.length, 2, 'the registration and the invocation mutations');
  for (const m of wiring) {
    const find = nl(m.find);
    const first = runner.indexOf(find);
    assert.ok(first >= 0, `anchor not found: ${find}`);
    assert.strictEqual(runner.indexOf(find, first + 1), -1, `anchor is not unique: ${find}`);
  }
});

finish();
