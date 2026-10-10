#!/usr/bin/env node
'use strict';
/**
 * `.github/workflows/tests.yml` -- the screenshot artifact upload, checked as
 * TEXT. The workflow cannot run inside this suite, so this follows the same
 * technique as `test/retro-action-workflow-unit.js`: read the file and assert
 * the guards that matter are present, in the right order.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'tests.yml'), 'utf8');
const e2eSrc = fs.readFileSync(path.join(__dirname, 'browser-e2e-unit.js'), 'utf8');

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

// The text of the upload step: from its `uses:` line to the next step or EOF.
function uploadStep() {
  const i = src.indexOf('uses: actions/upload-artifact@v4');
  assert.ok(i !== -1, 'no actions/upload-artifact@v4 step exists');
  const rest = src.slice(i);
  const next = rest.search(/\n\s*-\s+(name|uses):/);
  return next === -1 ? rest : rest.slice(0, next);
}

console.log('tests.yml: captured screenshots are uploaded as an artifact');
console.log('='.repeat(60));

check('an actions/upload-artifact@v4 step exists', () => {
  assert.match(src, /uses:\s*actions\/upload-artifact@v4\b/);
});

check('the upload path is the runner.temp screenshots PNG glob', () => {
  assert.match(uploadStep(), /path:\s*\$\{\{\s*runner\.temp\s*\}\}\/screenshots\/\*\.png/);
});

check('the artifact name is unique per matrix leg and per commit', () => {
  const m = uploadStep().match(/^\s*name:\s*(.+)$/m);
  assert.ok(m, 'the upload step has no name');
  assert.match(m[1], /matrix\.node/, 'the artifact name must include matrix.node');
  assert.match(m[1], /github\.sha/, 'the artifact name must include github.sha');
});

check('a missing screenshot fails the job instead of passing quietly', () => {
  assert.match(uploadStep(), /if-no-files-found:\s*error\s*$/m);
});

check('the upload only runs after a passing suite (no if: always())', () => {
  assert.doesNotMatch(uploadStep(), /^\s*if:/m);
});

check('the upload step comes after the "Run the test suite" step', () => {
  const run = src.indexOf('- name: Run the test suite');
  const up = src.indexOf('uses: actions/upload-artifact@v4');
  assert.ok(run !== -1, 'the "Run the test suite" step is missing');
  assert.ok(up > run, 'the upload step must come after the test step');
});

check('the four screenshot filenames the upload covers still exist in the browser suite', () => {
  for (const f of ['detail-desktop-dark.png', 'detail-desktop-light.png',
    'detail-phone-390-dark.png', 'detail-phone-390-light.png']) {
    assert.ok(e2eSrc.includes(f), `test/browser-e2e-unit.js no longer mentions ${f}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
