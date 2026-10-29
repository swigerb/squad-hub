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

/** The text of one step, from its `- name:` line to the next step. */
function step(title) {
  const start = source.indexOf(`      - name: ${title}\n`);
  assert.ok(start !== -1, `no step named "${title}"`);
  const next = source.indexOf('\n      - ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}
const GATE = 'Run the exhaustive acceptance gate';
const VERIFY = 'Verify the report is for this scope and source';
const CLEAN = 'Require a clean source tree';
const UPLOAD = 'Preserve the complete acceptance artifacts';

check('exhaustive CI is one coordinated Windows job, not four separately baselined shards', () => {
  assert.match(source, /runs-on: windows-latest/);
  assert.match(source, /defaults:\n      run:\n        shell: pwsh/);
  assert.strictEqual((source.match(/^ {2}[a-z][a-z-]*:\n {4}(?:if|name):/gm) || []).length, 1, 'more than one job');
  assert.doesNotMatch(source, /^\s+matrix:|^\s+strategy:|--shard|max-parallel|shard:/m);
});
check('exhaustive CI keeps its trigger: manual dispatch and release pull requests only', () => {
  assert.match(source, /on:\n  pull_request:\n    branches: \[main, dev\]\n  workflow_dispatch:/);
  assert.ok(source.includes("if: github.event_name == 'workflow_dispatch' || startsWith(github.head_ref, 'release/')"));
});
check('exhaustive CI tests the immutable head with full history and proves the checkout is that commit', () => {
  assert.match(source, /SOURCE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(source, /ref: \$\{\{ env\.SOURCE_SHA \}\}\n          fetch-depth: 0/);
  assert.match(source, /node-version: '24'/);
  const check_ = step('Check the checkout is the exact source under test');
  assert.ok(check_.includes('git rev-parse HEAD'));
  assert.ok(check_.includes('$head -ne $env:SOURCE_SHA'));
  assert.ok(source.indexOf('Check the checkout is the exact') < source.indexOf(`- name: ${GATE}`));
});
check('exhaustive CI installs Chromium prerequisites outside the checkout and fails if that fails', () => {
  const s = step('Install real browser coverage outside the checkout');
  assert.ok(s.includes("$tools = Join-Path $env:RUNNER_TEMP 'browser-tools'"));
  assert.ok(s.includes('npm install --prefix $tools --no-save --package-lock=false'));
  assert.ok(s.includes("playwright.cmd') install --with-deps chromium"));
  assert.ok(s.includes('NODE_PATH='));
  assert.ok(s.includes('$env:GITHUB_ENV'));
  assert.strictEqual((s.match(/if \(\$LASTEXITCODE -ne 0\)/g) || []).length, 2, 'each native install needs its own exit check');
  assert.doesNotMatch(source, /--registry|npm config set|NPM_CONFIG_REGISTRY/);
  assert.ok(source.indexOf('Install real browser coverage') < source.indexOf(`- name: ${GATE}`));
});
check('exhaustive CI runs the whole catalogue once, through the coordinator, with artifacts outside the source', () => {
  const s = step(GATE);
  assert.ok(s.includes("$artifacts = Join-Path $env:RUNNER_TEMP 'acceptance-exhaustive'"));
  assert.ok(s.includes('node test\\acceptance.js --scope exhaustive --jobs 4 --artifacts $artifacts'));
  assert.match(s, /TEMP: \$\{\{ runner\.temp \}\}\n          TMP: \$\{\{ runner\.temp \}\}/);
  assert.strictEqual((source.match(/test\\acceptance\.js --scope exhaustive/g) || []).length, 1, 'exhaustive is run more than once');
  assert.ok(!source.includes('test/mutate.js') && !source.includes('test\\mutate.js'), 'the legacy sweep is still run');
});
check('exhaustive CI never plans only, narrows the catalogue, or bypasses a baseline', () => {
  assert.doesNotMatch(source, /--plan|--only|--skip-baseline|--skip-restore|--reuse-baseline|--history|--shard|--base/);
  assert.doesNotMatch(source, /continue-on-error|\|\| true|-ErrorAction SilentlyContinue/);
});
check('exhaustive CI stops on the gate exit, then verifies the report and requires a clean source', () => {
  assert.ok(step(GATE).includes('if ($LASTEXITCODE -ne 0)'));
  const v = step(VERIFY);
  assert.ok(v.includes("node test\\acceptance.js --verify (Join-Path $artifacts 'report.json') --scope exhaustive"));
  assert.ok(v.includes('if ($LASTEXITCODE -ne 0)'));
  const c = step(CLEAN);
  assert.ok(c.includes('git status --porcelain'));
  assert.ok(c.includes('if ($LASTEXITCODE -ne 0)') && c.includes('if ($dirty)'));
  assert.doesNotMatch(source.slice(source.indexOf(`- name: ${GATE}`), source.indexOf(`- name: ${UPLOAD}`)), /if: always\(\)/);
  assert.ok(source.indexOf(`- name: ${GATE}`) < source.indexOf(`- name: ${VERIFY}`));
  assert.ok(source.indexOf(`- name: ${VERIFY}`) < source.indexOf(`- name: ${CLEAN}`));
});
check('exhaustive CI keeps the whole artifacts directory, on failure too, and fails if it is missing', () => {
  const s = step(UPLOAD);
  assert.ok(s.includes('if: always()'));
  assert.ok(s.includes('uses: actions/upload-artifact@v4'));
  assert.ok(s.includes('name: acceptance-exhaustive-${{ env.SOURCE_SHA }}'));
  assert.ok(s.includes('path: ${{ runner.temp }}/acceptance-exhaustive\n'), 'the upload is not the whole artifacts directory');
  assert.ok(s.includes('if-no-files-found: error'));
  assert.ok(source.indexOf(`- name: ${CLEAN}`) < source.indexOf(`- name: ${UPLOAD}`));
});
check('exhaustive CI is a read-only, cancellable, time-bounded gate, not a publisher or production dispatcher', () => {
  assert.match(source, /permissions:\n  contents: read/);
  assert.match(source, /concurrency:\n  group: mutation-acceptance-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true/);
  assert.match(source, /timeout-minutes: \d+/);
  assert.ok(Number(source.match(/timeout-minutes: (\d+)/)[1]) <= 360);
  assert.doesNotMatch(source, /npm publish|npm run release|npm run publish|id-token: write|secrets\.|contents: write|git push|git tag/);
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
