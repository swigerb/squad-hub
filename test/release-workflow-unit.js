#!/usr/bin/env node
'use strict';
/**
 * `.github/workflows/squad-release.yml` -- the gate in front of the tag and the
 * GitHub release.
 *
 * That workflow used to run `node --test test/*.test.cjs`. This repository has
 * no `*.test.cjs` file, so the step ran zero tests, exited 0, and the tag and
 * release were created behind a gate that could not fail. These checks make
 * sure the gate is the real suite and can no longer be a zero-test, skipped or
 * red run that still releases.
 *
 * The workflow cannot run inside this suite, so it is read as TEXT, the same
 * technique `test/tests-workflow-unit.js` uses. The one piece of logic worth
 * more than a text match -- the shell that decides pass or fail -- is taken
 * out of the workflow and EXECUTED with a stand-in for `npm`, so "a zero-test
 * run fails" is observed, not inferred from a regular expression. That needs a
 * POSIX bash (always present on the ubuntu runner, Git Bash on Windows); when
 * there is none those checks report SKIP rather than a pass.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const lf = (s) => s.replace(/\r\n/g, '\n');
const read = (...p) => lf(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

const raw = read('.github', 'workflows', 'squad-release.yml');
const testsYml = read('.github', 'workflows', 'tests.yml');
const pkg = JSON.parse(read('package.json'));

let pass = 0; let fail = 0; let skip = 0;
class Skip extends Error {}
function check(name, fn) {
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    if (e instanceof Skip) {
      skip += 1;
      console.log(`  SKIP ${name}`);
      console.log(`RESULT\tskip\t${name}`);
      return;
    }
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// Reading the workflow
// ---------------------------------------------------------------------------

const withoutComments = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** The `run: |` body of one step, dedented, with its comments kept. */
function runBlock(lines) {
  const i = lines.findIndex((l) => /^ {8}run:/.test(l));
  if (i === -1) return null;
  const inline = lines[i].match(/^ {8}run:[ \t]*(\S.*)$/);
  if (inline && !/^\|[-+]?$/.test(inline[1])) return inline[1];
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() === '') { body.push(''); continue; }
    if (!/^ {10}/.test(l)) break;
    body.push(l.slice(10));
  }
  return body.join('\n').replace(/\s+$/, '');
}

function parseSteps() {
  const lines = raw.split('\n');
  const at = lines.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  assert.ok(at !== -1, 'the release job has no steps: list');
  const blocks = [];
  for (const l of lines.slice(at + 1)) {
    if (/^ {6}- /.test(l)) blocks.push([l]);
    else if (blocks.length) blocks[blocks.length - 1].push(l);
  }
  return blocks.map((b, index) => {
    const text = withoutComments(b.join('\n'));
    const field = (key) => {
      const m = text.match(new RegExp(`^(?: {6}- | {8})${key}:[ \\t]*(.*)$`, 'm'));
      return m ? m[1].trim() : null;
    };
    return {
      index, text, name: field('name'), uses: (field('uses') || '').replace(/\s+#.*$/, '') || null, cond: field('if'), run: runBlock(b),
    };
  });
}

const steps = parseSteps();
const GATE = 'Run the test suite';
const NOT_TAGGED = "steps.check_tag.outputs.exists == 'false'";

function step(name) {
  const s = steps.find((x) => x.name === name);
  assert.ok(s, `no step named "${name}" (steps: ${steps.map((x) => x.name || x.uses).join(' | ')})`);
  return s;
}
const gateIndex = () => step(GATE).index;
/** Steps whose commands create a tag or a release, or push anything to the remote. */
const releasing = () => steps.filter((s) => /\bgit\s+tag\b|\bgit\s+push\b|\bgh\s+release\s+create\b/.test(s.text));

// ---------------------------------------------------------------------------
// Running a step's shell with a stand-in for npm
// ---------------------------------------------------------------------------

function findBash() {
  const works = (b) => {
    const r = spawnSync(b, ['-c', 'command -v tee grep >/dev/null && echo ok'], { encoding: 'utf8', timeout: 20000 });
    return r.status === 0 && /ok/.test(r.stdout || '');
  };
  if (process.platform !== 'win32') return works('bash') ? 'bash' : null;
  // System32\bash.exe is the WSL launcher: not what the runner uses, and it
  // may not be configured. Only Git for Windows' own bash is trusted here.
  const where = spawnSync('where', ['git'], { encoding: 'utf8' });
  for (const g of (where.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const root = path.resolve(path.dirname(g), '..');
    for (const rel of [['bin', 'bash.exe'], ['usr', 'bin', 'bash.exe']]) {
      const b = path.join(root, ...rel);
      if (fs.existsSync(b) && works(b)) return b;
    }
  }
  return null;
}
let bashPath;
function needBash() {
  if (bashPath === undefined) bashPath = findBash();
  if (!bashPath) throw new Skip('no POSIX bash');
  return bashPath;
}

/** A path as bash wants to read it: Git Bash takes `/c/dir/file`, not `C:\dir\file`. */
function bashPathOf(p) {
  if (process.platform !== 'win32') return p;
  return p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
}
const shQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * `npm test` puts every parent `node_modules/.bin` on PATH, and one of those
 * can hold a `node` launcher that points at a Node which is not there (this is
 * what a developer machine with a stray `~/node_modules` looks like). Bash picks
 * that file up before the real `node`, so a step that calls `node` fails with a
 * message that has nothing to do with the step. This builds the same trap in a
 * directory of its own; the launcher is the shape npm generates, plus a marker.
 */
function makeHostileNpmBin() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqrel-npmbin-'));
  const dir = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'node');
  fs.writeFileSync(f, [
    '#!/bin/sh',
    'echo "HOSTILE-NODE-SHIM-RAN" >&2',
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    'case `uname` in',
    '    *CYGWIN*|*MINGW*|*MSYS*) basedir=`cygpath -w "$basedir"`;;',
    'esac',
    'exec "$basedir/../node/bin/node"   "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(f, 0o755);
  return { dir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp dir, best effort */ } } };
}

/**
 * Runs one step's shell in a scratch directory. The stand-ins are first on PATH:
 * `npm` (when asked for) is a fake, and `node` is a wrapper that execs THIS
 * process's own Node by absolute path, so what a step runs is real Node and not
 * whatever `node` the surrounding PATH happens to resolve to. `inheritedBin` is
 * a directory put on the inherited PATH, after the stand-ins, the way npm does.
 */
function runShell(script, { files = {}, env = {}, fakeNpm = false, inheritedBin = null, realNode = true } = {}) {
  const bash = needBash();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqrel-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    if (fakeNpm) {
      // Prints what it is told to and exits with the code it is told to: the
      // only two things the gate can observe about the real `npm test`.
      const f = path.join(bin, 'npm');
      fs.writeFileSync(f, '#!/bin/sh\necho "FAKE-NPM-ARGS: $*"\nprintf \'%s\\n\' "$FAKE_NPM_OUT"\nexit "${FAKE_NPM_EXIT:-0}"\n');
      fs.chmodSync(f, 0o755);
    }
    if (realNode) {
      const f = path.join(bin, 'node');
      fs.writeFileSync(f, `#!/bin/sh\nexec ${shQuote(bashPathOf(process.execPath))} "$@"\n`);
      fs.chmodSync(f, 0o755);
    }
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    fs.writeFileSync(path.join(dir, 'step.sh'), `${script}\n`);
    // Windows may name the variable Path or PATH; keep exactly one of them.
    const childEnv = { ...process.env, ...env };
    const pathKeys = Object.keys(childEnv).filter((k) => k.toLowerCase() === 'path');
    const inherited = pathKeys.length ? childEnv[pathKeys[0]] : '';
    for (const k of pathKeys) delete childEnv[k];
    childEnv[pathKeys[0] || 'PATH'] = [bin, inheritedBin, inherited].filter(Boolean).join(path.delimiter);
    const r = spawnSync(bash, ['-e', 'step.sh'], { cwd: dir, encoding: 'utf8', timeout: 60000, env: childEnv });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
  }
}

/** The gate exactly as the workflow writes it, with `npm test` replaced by a canned answer. */
function gate(output, exitCode = 0) {
  return runShell(step(GATE).run, {
    fakeNpm: true,
    env: { FAKE_NPM_OUT: output, FAKE_NPM_EXIT: String(exitCode) },
  });
}
const GREEN = '1540 passed, 0 failed  (231s)';

console.log('squad-release.yml: the tag and release sit behind the real test suite');
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// The gate is the real suite, and it comes first
// ---------------------------------------------------------------------------

check('the gate runs npm test, never the zero-test node --test glob', () => {
  const code = withoutComments(raw);
  assert.doesNotMatch(code, /node\s+--test/, 'node --test is back in the workflow');
  assert.doesNotMatch(code, /\.test\.cjs/, 'the *.test.cjs glob is back in the workflow -- nothing here matches it');
  assert.match(step(GATE).run, /^\s*npm test 2>&1 \| tee test\.out \|\| rc=\$\?$/m,
    'the gate no longer runs `npm test`, with its output captured and its exit status kept');
});

check('npm test is the real runner: package.json test script is node test/run-tests.js, and it exists', () => {
  assert.strictEqual((pkg.scripts || {}).test, 'node test/run-tests.js');
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'run-tests.js')), 'test/run-tests.js is missing');
});

check('the runner runs this unit, so the release gate checks cannot be silently unplugged', () => {
  const runner = read('test', 'run-tests.js');
  assert.ok(runner.includes("runChildSuite(path.join(__dirname, 'release-workflow-unit.js'), 'release-workflow')"),
    'test/run-tests.js no longer registers release-workflow-unit.js');
  assert.match(runner, /^\s*await suiteReleaseWorkflow\(\);$/m, 'test/run-tests.js registers the suite but never runs it');
});

check('the gate reads the strings the runner really prints', () => {
  // A grep for a line the runner no longer prints would never match, and the
  // gate would then pass or fail for the wrong reason.
  const runner = read('test', 'run-tests.js');
  assert.ok(runner.includes('console.log(`${pass} passed, ${fail} failed'),
    'run-tests.js no longer prints "<n> passed, <n> failed" as its summary');
  assert.ok(runner.includes('SKIPPED (not checked at all)'), 'run-tests.js no longer names skipped suites');
  assert.ok(runner.includes('console.log(`  SKIP ${name}`)'), 'run-tests.js no longer prints a SKIP line per skipped test');
});

check('the Playwright install matches the Tests workflow, so the browser suites cannot skip', () => {
  const run = step('Install Playwright (so the browser suite cannot skip)').run;
  for (const cmd of [
    'npm install --no-save --no-audit --no-fund playwright',
    'npx playwright install --with-deps chromium',
  ]) {
    assert.ok(run.includes(cmd), `the release gate no longer runs: ${cmd}`);
    assert.ok(testsYml.includes(cmd), `tests.yml no longer runs "${cmd}"; the two gates have drifted`);
  }
});

check('Playwright is installed with --no-save, so no dependency manifest is written', () => {
  assert.match(step('Install Playwright (so the browser suite cannot skip)').run, /npm install --no-save\b/);
});

check('the order is: version check, tag check, install, gate, then tag, release, verify', () => {
  const names = [
    'Validate version consistency', 'Read version from package.json', 'Check if tag already exists',
    'Install Playwright (so the browser suite cannot skip)', GATE,
    'Create git tag', 'Create GitHub Release', 'Verify release',
  ];
  const at = names.map((n) => step(n).index);
  assert.deepStrictEqual(at, [...at].sort((a, b) => a - b), `out of order: ${names.map((n, i) => `${n}@${at[i]}`).join(', ')}`);
});

check('the tag and release steps come after the test gate, never before', () => {
  const early = releasing().filter((s) => s.index <= gateIndex());
  assert.deepStrictEqual(early.map((s) => s.name), [],
    'a step that tags, pushes or creates a release runs before (or as) the test gate');
  assert.ok(releasing().length >= 2, 'no tag/release step was found at all, so the ordering above proves nothing');
});

check('install, gate, tag, release and verify only run when the tag does not exist yet', () => {
  for (const n of ['Install Playwright (so the browser suite cannot skip)', GATE, 'Create git tag', 'Create GitHub Release', 'Verify release']) {
    assert.strictEqual(step(n).cond, NOT_TAGGED, `"${n}" must be conditional on ${NOT_TAGGED}`);
  }
});

check('no step is allowed to fail without stopping the release (no continue-on-error, no always())', () => {
  assert.doesNotMatch(withoutComments(raw), /continue-on-error/, 'a step can fail and the job carries on');
  for (const s of steps) {
    assert.doesNotMatch(s.cond || '', /\b(always|failure|cancelled|success)\s*\(/,
      `"${s.name || s.uses}" has a status-check function in its if:, so it can run after a failed gate`);
  }
});

// ---------------------------------------------------------------------------
// The workflow does what it did before, and nothing more
// ---------------------------------------------------------------------------

check('the workflow keeps its name and only triggers on a push to main', () => {
  assert.match(raw, /^name: Squad Release$/m);
  assert.match(raw, /^on:\n {2}push:\n {4}branches: \[main\]\n\npermissions:/m,
    'the triggers changed: this must release only from a push to main');
});

check('the workflow keeps its single contents: write permission', () => {
  assert.match(raw, /^permissions:\n {2}contents: write\n\njobs:/m,
    'permissions changed; the release needs contents: write to tag and release, and nothing else');
});

check('every action is pinned to a full commit SHA', () => {
  const uses = steps.filter((s) => s.uses);
  assert.ok(uses.length >= 2, 'expected at least checkout and setup-node');
  for (const s of uses) assert.match(s.uses, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${s.uses} is not pinned to a commit SHA`);
});

check('the workflow cannot publish to npm or deploy anything', () => {
  assert.doesNotMatch(withoutComments(raw),
    /\bnpm\s+(publish|run\s+release|run\s+publish|run\s+verify|login|adduser)\b|NODE_AUTH_TOKEN|NPM_TOKEN|registry-url|azure\/login|\bazd\b|\baz\s+(containerapp|webapp|login)\b|docker\s+(push|login)|workflow_dispatch/,
    'the workflow publishes or deploys; npm publication is `npm run release`, done by a person');
});

check('the release is refused when CHANGELOG.md has no section for the package version', () => {
  const s = step('Validate version consistency');
  assert.match(s.run, /grep -q "## \\\[\$VERSION\\\]" CHANGELOG\.md/);
  assert.match(s.run, /exit 1/);
  assert.strictEqual(s.cond, null, 'the version check must run on every push, not only when tagging');
});

check('CHANGELOG.md has a section for the version in package.json', () => {
  const log = read('CHANGELOG.md');
  assert.ok(log.includes(`## [${pkg.version}]`), `CHANGELOG.md has no "## [${pkg.version}]" heading, so the release workflow would refuse this commit`);
});

// ---------------------------------------------------------------------------
// The gate, executed
// ---------------------------------------------------------------------------

check('a green suite passes the gate, and the gate ran npm test', () => {
  const r = gate(GREEN, 0);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /FAKE-NPM-ARGS: test\b/, 'the gate did not run `npm test`');
  assert.doesNotMatch(r.out, /::error::/);
});

check('a run that executed zero tests fails the gate', () => {
  // The old step's whole defect: it ran nothing and exited 0.
  for (const out of ['0 passed, 0 failed  (0s)', '', '# tests 0\n# pass 0\n# fail 0']) {
    const r = gate(out, 0);
    assert.notStrictEqual(r.code, 0, `the gate passed a run with no tests. Output was ${JSON.stringify(out)}:\n${r.out}`);
    assert.match(r.out, /::error::/);
  }
});

check('a skipped suite fails the gate even when every test that did run passed', () => {
  const summary = '1500 passed, 0 failed, 1 SKIPPED  (200s)\n\nSKIPPED (not checked at all):\n - browser end-to-end (playwright not installed)';
  const r = gate(`  SKIP browser end-to-end (playwright not installed)\n${summary}`, 0);
  assert.notStrictEqual(r.code, 0, `a skipped browser suite released:\n${r.out}`);
  assert.match(r.out, /SKIPPED/);
  // The per-test SKIP line alone is enough, in case the summary format changes.
  const lineOnly = gate(`  SKIP browser end-to-end (playwright not installed)\n${GREEN}`, 0);
  assert.notStrictEqual(lineOnly.code, 0, `a SKIP line without the summary words released:\n${lineOnly.out}`);
});

check('a non-zero exit from npm test fails the gate and is propagated, whatever the output says', () => {
  const r = gate(GREEN, 3);
  assert.strictEqual(r.code, 3, `expected the suite's exit status (3) to be the step's, got ${r.code}:\n${r.out}`);
  assert.match(r.out, /::error::.*exit 3/);
});

check('a summary that reports failures fails the gate even if npm exits 0', () => {
  const r = gate('1498 passed, 2 failed  (200s)', 0);
  assert.notStrictEqual(r.code, 0, `a run with failures released:\n${r.out}`);
});

check('the gate refuses a suite whose summary it cannot read', () => {
  const r = gate('all good, trust me', 0);
  assert.notStrictEqual(r.code, 0, `an unreadable summary released:\n${r.out}`);
});

check('the changelog guard refuses a version CHANGELOG.md does not mention and accepts one it does', () => {
  const script = step('Validate version consistency').run;
  const files = (heading) => ({
    'package.json': JSON.stringify({ name: 'x', version: '9.9.9' }),
    'CHANGELOG.md': `# Changelog\n\n${heading}\n\nsomething\n`,
  });
  const ok = runShell(script, { files: files('## [9.9.9] — now') });
  assert.strictEqual(ok.code, 0, ok.out);
  const bad = runShell(script, { files: files('## [9.9.8] — before') });
  assert.notStrictEqual(bad.code, 0, `a version with no changelog section was accepted:\n${bad.out}`);
  assert.match(bad.out, /::error::/);
});

check('the shell steps run this process own Node even when npm puts a broken node launcher first on PATH', () => {
  const hostile = makeHostileNpmBin();
  try {
    // Control: with the isolation off the launcher does win, so this fixture
    // really reproduces the failure `npm test` produced and is not vacuous.
    const trap = runShell('node -p 1', { inheritedBin: hostile.dir, realNode: false });
    assert.notStrictEqual(trap.code, 0, `the broken launcher was never reached, so this fixture proves nothing:\n${trap.out}`);
    assert.match(trap.out, /HOSTILE-NODE-SHIM-RAN/);
    const r = runShell('node -p process.execPath', { inheritedBin: hostile.dir });
    assert.strictEqual(r.code, 0, `a step that calls node failed under an inherited node launcher:\n${r.out}`);
    assert.doesNotMatch(r.out, /HOSTILE-NODE-SHIM-RAN/, 'the inherited node launcher still wins over the fixture');
    const same = (a, b) => path.resolve(a.trim()).toLowerCase() === path.resolve(b).toLowerCase();
    assert.ok(same(r.out, process.execPath),
      `the step ran a different node than this process.\n  step: ${r.out.trim()}\n  here: ${process.execPath}`);
  } finally { hostile.cleanup(); }
});

check('the changelog guard reads the real version under a hostile inherited PATH: 9.9.9 passes, 9.9.8 and a stubbed version do not', () => {
  const script = step('Validate version consistency').run;
  const hostile = makeHostileNpmBin();
  try {
    const at = (version, heading) => runShell(script, {
      inheritedBin: hostile.dir,
      files: {
        'package.json': JSON.stringify({ name: 'x', version }),
        'CHANGELOG.md': `# Changelog\n\n${heading}\n\nsomething\n`,
      },
    });
    const ok = at('9.9.9', '## [9.9.9] — now');
    assert.strictEqual(ok.code, 0, ok.out);
    assert.match(ok.out, /Version 9\.9\.9 validated/);
    assert.doesNotMatch(ok.out, /HOSTILE-NODE-SHIM-RAN/);
    const bad = at('9.9.9', '## [9.9.8] — before');
    assert.notStrictEqual(bad.code, 0, `a version with no changelog section was accepted:\n${bad.out}`);
    assert.match(bad.out, /::error::Version 9\.9\.9 not found/, 'the guard did not read the version from package.json');
    // A node that returned one fixed version would get one of these two wrong.
    const other = at('9.9.7', '## [9.9.7] — also');
    assert.strictEqual(other.code, 0, other.out);
    assert.match(other.out, /Version 9\.9\.7 validated/);
  } finally { hostile.cleanup(); }
});

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
