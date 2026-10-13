'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'mutation-acceptance.yml'), 'utf8')
  .replace(/\r\n/g, '\n');
let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`RESULT\tok\t${name}`); }
  catch (e) { fail += 1; console.log(`RESULT\tfail\t${name}\t${e.message}`); }
}

check('mutation CI partitions the complete catalogue on four separate runners', () => {
  assert.match(source, /runs-on: windows-latest/);
  assert.match(source, /shell: bash/);
  assert.match(source, /- name: Run the complete partition and require named catches\n        env:\n          TEMP: \$\{\{ runner\.temp \}\}\n          TMP: \$\{\{ runner\.temp \}\}/);
  assert.match(source, /fail-fast: false/);
  assert.match(source, /max-parallel: 4/);
  assert.match(source, /shard: \[1, 2, 3, 4\]/);
});
check('mutation CI tests and records the immutable pull-request head', () => {
  assert.match(source, /SOURCE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(source, /ref: \$\{\{ env\.SOURCE_SHA \}\}/);
  assert.ok(source.includes('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"'));
  assert.ok(source.includes('sha: process.env.SOURCE_SHA'));
});
check('mutation CI installs real Chromium before running any partition', () => {
  assert.match(source, /node-version: '24'/);
  assert.ok(source.includes('npx playwright install --with-deps chromium'));
  assert.ok(source.indexOf('npx playwright install') < source.indexOf('node test/mutate.js'));
});
check('mutation CI never narrows the catalogue or bypasses a baseline', () => {
  assert.ok(source.includes('node test/mutate.js --shard "${{ matrix.shard }}/4"'));
  assert.doesNotMatch(source, /--only|--skip-baseline|--skip-restore/);
  assert.ok(source.includes("planRun(['--shard', process.env.SHARD], MUTATIONS, null)"));
});
check('mutation CI requires the harness exit, named acceptance and restored source', () => {
  assert.ok(source.includes('set -o pipefail'));
  assert.ok(source.includes("grep -Fx 'ACCEPTED: every selected mutation was caught by its named test.' mutation.log"));
  assert.ok(source.includes("grep -Fx 'source restored, baseline re-run: green' mutation.log"));
  assert.ok(source.includes('git diff --exit-code'));
});
check('mutation CI preserves actual selected names, exclusions and failed results', () => {
  assert.ok(source.includes('name: m.name, mustFail: m.mustFail'));
  assert.ok(source.includes('reason: m.skip'));
  assert.match(source, /if: always\(\)/);
  assert.match(source, /mutation-partition\.json\n\s+mutation\.log/);
  assert.match(source, /if-no-files-found: error/);
});
check('mutation CI is a read-only release gate, not a publisher or production dispatcher', () => {
  assert.match(source, /permissions:\n  contents: read/);
  assert.ok(source.includes("startsWith(github.head_ref, 'release/')"));
  assert.doesNotMatch(source, /npm publish|npm run release|id-token: write|secrets\./);
});
check('mutation CI can start on an unmutated checkout with no stranded-marker collision', () => {
  if (process.env.MUTANT) return; // Catalogue runs intentionally carry a marker.
  const { MUTATIONS } = require('./mutate');
  const root = path.join(__dirname, '..');
  const files = [...new Set(MUTATIONS.map(m => m.file))];
  const dirty = files.filter(file => fs.readFileSync(path.join(root, file), 'utf8').includes('MUTATION'));
  assert.deepStrictEqual(dirty, [], `clean source would trip the live-mutation guard: ${dirty.join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
