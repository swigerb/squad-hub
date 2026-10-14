'use strict';

/**
 * The plumbing that puts the acceptance runner in front of an ordinary pull
 * request: the npm scripts, the candidate-scope workflow, the registration of
 * the acceptance and browser-scenario suites in run-tests.js, and the docs that
 * tell people which command to use when. Read from SOURCE, so it holds when
 * this file runs alone.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const candidate = read('.github', 'workflows', 'candidate-acceptance.yml');
const exhaustive = read('.github', 'workflows', 'mutation-acceptance.yml');
const runner = read('test', 'run-tests.js');
const pkg = JSON.parse(read('package.json'));
let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`RESULT\tok\t${name}`); }
  catch (e) { fail += 1; console.log(`RESULT\tfail\t${name}\t${e.message}`); }
}

/** The text of one step of the candidate workflow, from its `- name:` line to the next step. */
function step(title) {
  const start = candidate.indexOf(`      - name: ${title}\n`);
  assert.ok(start !== -1, `no step named "${title}"`);
  const next = candidate.indexOf('\n      - ', start + 1);
  return candidate.slice(start, next === -1 ? candidate.length : next);
}
const GATE = 'Run the candidate acceptance gate';
const VERIFY = 'Verify the report is for this scope and source';
const CLEAN = 'Require a clean source tree';
const UPLOAD = 'Preserve the complete acceptance artifacts';
const at = (title) => candidate.indexOf(`- name: ${title}`);

check('the acceptance npm scripts name the scopes and leave npm test the complete regression', () => {
  assert.strictEqual(pkg.scripts['test:candidate'], 'node test/acceptance.js --scope candidate');
  assert.strictEqual(pkg.scripts['test:exhaustive'], 'node test/acceptance.js --scope exhaustive');
  assert.strictEqual(pkg.scripts.test, 'node test/run-tests.js');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'the manifest version is not a plain semver');
  assert.ok(read('CHANGELOG.md').includes(`## [${pkg.version}]`), `CHANGELOG.md has no section for the manifest version ${pkg.version}`);
});
check('the acceptance and browser-scenario suites are each registered once and invoked once in run-tests.js', () => {
  const suites = ['acceptance-evidence', 'acceptance-schedule', 'acceptance-runner',
    'browser-scenarios', 'acceptance-workflow'];
  for (const name of suites) {
    const file = `'${name}-unit.js'`;
    assert.strictEqual(runner.split(file).length - 1, 1, `${name}-unit.js is not registered exactly once`);
    assert.ok(runner.includes(`runChildSuite(path.join(__dirname, ${file}), '${name}');`), `${name} has an unexpected registration`);
    assert.ok(fs.existsSync(path.join(__dirname, `${name}-unit.js`)), `${name}-unit.js does not exist`);
  }
  for (const fn of ['suiteAcceptance', 'suiteBrowserScenarios', 'suiteAcceptanceWorkflow']) {
    assert.strictEqual(runner.split(`  await ${fn}();\n`).length - 1, 1, `${fn}() is not invoked exactly once`);
    assert.strictEqual(runner.split(`async function ${fn}()`).length - 1, 1, `${fn}() is not defined exactly once`);
  }
});
check('the new suites run after the existing ones and the runner does not give them a longer timeout', () => {
  assert.ok(runner.indexOf('await suiteFallbackOwners();') < runner.indexOf('await suiteAcceptance();'));
  assert.ok(runner.indexOf('await suiteAcceptance();') < runner.indexOf('await suiteBrowserScenarios();'));
  assert.ok(runner.indexOf('await suiteBrowserScenarios();') < runner.indexOf('await suiteAcceptanceWorkflow();'));
  for (const name of ['acceptance-evidence', 'acceptance-schedule', 'acceptance-runner',
    'browser-scenarios', 'acceptance-workflow']) {
    const line = runner.split('\n').find((l) => l.includes(`'${name}-unit.js'`));
    assert.ok(!/timeout/.test(line), `${name} overrides the runner timeout`);
  }
});
check('the mutation CI description in run-tests.js describes the coordinated exhaustive gate', () => {
  assert.ok(runner.includes('[MUTATE CI] the exhaustive gate is one coordinated run at the immutable head'));
  assert.doesNotMatch(runner, /isolated immutable-head partitions/);
});
check('candidate CI gates ordinary pull requests, and leaves release pull requests to the exhaustive gate', () => {
  assert.match(candidate, /on:\n  pull_request:\n    branches: \[main, dev\]\n\npermissions:/);
  assert.doesNotMatch(candidate, /workflow_dispatch|push:/);
  assert.ok(candidate.includes("if: ${{ !startsWith(github.head_ref, 'release/') }}"));
  assert.ok(exhaustive.includes("startsWith(github.head_ref, 'release/')"));
  assert.doesNotMatch(candidate, /--scope exhaustive|^\s+matrix:|^\s+strategy:/m);
});
check('candidate CI is measured against the immutable base and head SHAs with full history', () => {
  assert.match(candidate, /SOURCE_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(candidate, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(candidate, /ref: \$\{\{ env\.SOURCE_SHA \}\}\n          fetch-depth: 0/);
  assert.match(candidate, /runs-on: windows-latest/);
  assert.match(candidate, /node-version: '24'/);
  const s = step('Check the checkout is the exact head and the base is present');
  assert.ok(s.includes('$head -ne $env:SOURCE_SHA'));
  assert.ok(s.includes('git cat-file -e'));
  assert.ok(s.includes('if ($LASTEXITCODE -ne 0)'));
  assert.ok(at('Check the checkout is the exact head') < at(GATE));
  assert.doesNotMatch(candidate, /github\.base_ref|origin\/main|--base (main|dev)/);
});
check('candidate CI installs prerequisites outside the checkout, with the default registry, and stops if that fails', () => {
  const s = step('Install real browser coverage outside the checkout');
  assert.ok(s.includes('npm install --prefix $tools --no-save --package-lock=false'));
  assert.ok(s.includes("playwright.cmd') install --with-deps chromium"));
  assert.ok(s.includes('NODE_PATH='));
  assert.strictEqual((s.match(/if \(\$LASTEXITCODE -ne 0\)/g) || []).length, 2);
  assert.doesNotMatch(candidate, /--registry|npm config set|NPM_CONFIG_REGISTRY/);
  assert.ok(at('Install real browser coverage') < at(GATE));
});
check('candidate CI really executes one coordinated candidate run with external artifacts, never a plan', () => {
  const s = step(GATE);
  assert.ok(s.includes("$artifacts = Join-Path $env:RUNNER_TEMP 'acceptance-candidate'"));
  assert.ok(s.includes('node test\\acceptance.js --scope candidate --base $env:BASE_SHA --artifacts $artifacts'));
  assert.ok(s.includes('if ($LASTEXITCODE -ne 0)'));
  assert.match(s, /TEMP: \$\{\{ runner\.temp \}\}\n          TMP: \$\{\{ runner\.temp \}\}/);
  assert.strictEqual((candidate.match(/test\\acceptance\.js --scope candidate/g) || []).length, 1, 'candidate is run more than once');
  assert.doesNotMatch(candidate, /--plan|--only|--skip-baseline|--skip-restore|--reuse-baseline|--history|--shard/);
  assert.ok(!candidate.includes('test/mutate.js') && !candidate.includes('test\\mutate.js'), 'no full sweep belongs on an ordinary pull request');
  assert.doesNotMatch(candidate, /continue-on-error|\|\| true|-ErrorAction SilentlyContinue/);
});
check('candidate CI verifies the report for the candidate scope, then requires a clean source tree', () => {
  assert.ok(step(VERIFY).includes("node test\\acceptance.js --verify (Join-Path $artifacts 'report.json') --scope candidate"));
  assert.ok(step(VERIFY).includes('if ($LASTEXITCODE -ne 0)'));
  const c = step(CLEAN);
  assert.ok(c.includes('git status --porcelain') && c.includes('if ($dirty)') && c.includes('if ($LASTEXITCODE -ne 0)'));
  assert.ok(at(GATE) < at(VERIFY) && at(VERIFY) < at(CLEAN) && at(CLEAN) < at(UPLOAD));
});
check('candidate CI keeps the complete artifacts directory even on failure, and fails if it is missing', () => {
  const s = step(UPLOAD);
  assert.ok(s.includes('if: always()'));
  assert.ok(s.includes('name: acceptance-candidate-${{ env.SOURCE_SHA }}'));
  assert.ok(s.includes('path: ${{ runner.temp }}/acceptance-candidate\n'), 'the upload is not the whole artifacts directory');
  assert.ok(s.includes('if-no-files-found: error'));
  assert.strictEqual((candidate.match(/if: always\(\)/g) || []).length, 1, 'only the upload may run after a failure');
});
check('candidate CI is read-only, cancellable and time-bounded, with no publishing or secrets', () => {
  assert.match(candidate, /permissions:\n  contents: read/);
  assert.match(candidate, /concurrency:\n  group: candidate-acceptance-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true/);
  assert.ok(Number(candidate.match(/timeout-minutes: (\d+)/)[1]) <= 360);
  assert.doesNotMatch(candidate, /npm publish|npm run release|id-token: write|secrets\.|contents: write|git push|git tag/);
});
check('the existing Linux Tests matrix is untouched by the acceptance workflows', () => {
  const tests = read('.github', 'workflows', 'tests.yml');
  assert.ok(tests.includes("node: ['18', '24']"));
  assert.ok(tests.includes('runs-on: ubuntu-latest'));
  assert.doesNotMatch(tests, /acceptance\.js|candidate-acceptance|mutation-acceptance/);
});
check('the docs make the candidate command the everyday workflow and the exhaustive sweep deliberate', () => {
  const docs = read('docs', 'README.md');
  assert.match(docs, /node test[\\/]acceptance\.js --scope candidate --base \S+ --artifacts \S+/);
  assert.ok(docs.includes('--scope exhaustive'));
  assert.ok(docs.includes('--verify'));
  assert.ok(docs.includes('--plan'));
  assert.ok(docs.includes('--scenario'));
  assert.match(docs, /legacy/i);
  const readme = read('README.md');
  assert.ok(readme.includes('npm run test:candidate') || readme.includes('--scope candidate'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
