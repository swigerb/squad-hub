#!/usr/bin/env node
'use strict';
/**
 * `retro-action` is now a label two mechanisms depend on: the retrospective
 * ceremony's action items, and the durable record
 * `.github/workflows/retro-action-on-red-tests.yml` opens for a red `Tests`
 * run. Before this, the label existed on GitHub only because someone once
 * created it by hand -- nothing in the repository would recreate it if it
 * were ever deleted, renamed, or recoloured, and `sync-squad-labels.yml` is
 * the one place in this repository that DOES recreate labels on demand.
 *
 * This reads the workflow as text, the same technique docs-unit.js and
 * deploy-guard-unit.js already use for source that cannot run inside this
 * suite.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'sync-squad-labels.yml'), 'utf8');

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

console.log('sync-squad-labels.yml: retro-action is a label the repo can recreate');
console.log('='.repeat(60));

check('retro-action is defined among the labels this workflow syncs', () => {
  assert.match(src, /name:\s*'retro-action'/, 'retro-action is not defined in sync-squad-labels.yml');
});

check('the retro-action definition is actually pushed into the synced set', () => {
  assert.match(src, /CEREMONY_LABELS/, 'no CEREMONY_LABELS group was added');
  assert.match(src, /labels\.push\(\.\.\.CEREMONY_LABELS\)/,
    'CEREMONY_LABELS is defined but never merged into the labels that get synced');
});

check('retro-action keeps the colour and description already live on GitHub', () => {
  // Pinned to the actual values so a future edit here has to be deliberate --
  // GitHub already has this exact label; a definition that silently disagrees
  // would recolour or redescribe it on the next sync.
  assert.match(src, /name:\s*'retro-action',\s*color:\s*'5319E7'/);
  assert.match(src, /Action item from a retrospective ceremony/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
