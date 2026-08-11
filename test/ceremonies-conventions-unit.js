#!/usr/bin/env node
'use strict';
/**
 * `.squad/ceremonies.md` -- the two conventions issues #97 and #98 asked for,
 * checked as TEXT (the same technique `docs-unit.js` and
 * `sync-squad-labels-unit.js` already use for prose/config that has no
 * runtime to execute).
 *
 * Both issues named a real corpus measurement as the deciding evidence, and
 * BOTH point the same direction: a script, a close-time gate, or a CI job
 * would fire on almost nothing --
 *   - #97: only 3 of the last 16 closed issues (19%) carried a `## Sprints`
 *     section, and of those only #84 was an ordinary issue (#1 and #11 are
 *     structural docs, not work items).
 *   - #98: only 2 of the last 16 closed issues (13%) carried a Definition of
 *     done at all (#84, #85).
 *
 * So neither gets automation. What each gets is a short, plain convention in
 * this file -- and this test is what makes "short and plain" different from
 * "unenforced": if either convention is deleted or watered down, this fails.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ceremonies = fs.readFileSync(path.join(ROOT, '.squad', 'ceremonies.md'), 'utf8');

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

console.log('ceremonies.md: the #97 and #98 conventions actually say what they must');
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// #97: sprint closing convention -- plain, no automation.
// ---------------------------------------------------------------------------

check('the sprint closing convention exists and names issue #97', () => {
  assert.match(ceremonies, /Sprint closing convention \(issue #97\)/);
});

check('the convention requires the CLOSING COMMENT to list each sprint ID against its merged PR number', () => {
  assert.match(ceremonies, /closing comment must[\s\S]{0,40}list each sprint ID against the PR number that merged it/);
});

check('the convention states its corpus evidence, so the choice is not silently reversible', () => {
  assert.match(ceremonies, /3 of the last 16 closed issues \(19%\)/);
  assert.match(ceremonies, /only #84 was an ordinary/);
});

check('no sprint parser, close-time gate, script, workflow or CI job is introduced for #97', () => {
  assert.match(ceremonies, /No automation, no script, no[\s\S]{0,10}workflow/);
  // The repository itself must not carry any such mechanism either.
  const scripts = fs.readdirSync(path.join(ROOT, 'scripts'));
  assert.ok(!scripts.some((f) => /sprint/i.test(f)), `a sprint script exists: ${scripts.join(', ')}`);
  const workflowDir = path.join(ROOT, '.github', 'workflows');
  const workflows = fs.existsSync(workflowDir) ? fs.readdirSync(workflowDir) : [];
  assert.ok(!workflows.some((f) => /sprint/i.test(f)), `a sprint workflow exists: ${workflows.join(', ')}`);
});

// ---------------------------------------------------------------------------
// #98: Definition-of-done template -- plain, no ceremony step, no automation.
// ---------------------------------------------------------------------------

check('the Definition-of-done template exists and names issue #98', () => {
  assert.match(ceremonies, /Definition-of-done template \(issue #98\)/);
});

check('the template requires each bullet to name a real file path, document section, or test name', () => {
  assert.match(ceremonies, /a real file path[\s\S]{0,80}a real[\s\S]{0,20}document section[\s\S]{0,80}or a real[\s\S]{0,40}test[\s\S]{0,10}name/);
});

check('the template states its corpus evidence, so the choice is not silently reversible', () => {
  assert.match(ceremonies, /Only 2 of the last 16 closed issues \(13%\)/);
});

check('no DoD-resolution ceremony step or automation is introduced for #98', () => {
  assert.match(ceremonies, /not a new ceremony step/);
  const scripts = fs.readdirSync(path.join(ROOT, 'scripts'));
  assert.ok(!scripts.some((f) => /dod|definition-of-done/i.test(f)), `a DoD script exists: ${scripts.join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
