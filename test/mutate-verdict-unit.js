'use strict';
/**
 * How the mutation harness judges a run (test/helpers/verdict.js, and the main
 * loop in test/mutate.js that calls it).
 *
 * The first half tests the decisions directly. The second half runs the REAL
 * main of test/mutate.js, unmodified apart from its catalogue, against a
 * throwaway tree: a one-file subject, a child suite that exercises it, and a
 * stub standing in for the full-suite baseline. That is the only way to see
 * what a person or a CI job actually sees -- the text printed and the exit
 * status -- and it is what proves a mutant stopped by the wrong test, a crash
 * or a skipped baseline fails the run rather than counting towards it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  judgeBaseline, classify, summarise, parseResults, parseSummary, failedNames, outputFormat, judgeControl, classifyRun,
} = require('./helpers/verdict');

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

const NAMED = 'the test the mutation names';
const timedOut = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });

check('a run that fails but not on the named test is imprecise, never caught', () => {
  const v = classify({ code: 1, signal: null, failed: ['some other test', 'and another'] }, NAMED);
  assert.strictEqual(v.verdict, 'imprecise');
  assert.match(v.reason, /some other test \| and another/);
  assert.notStrictEqual(classify({ code: 2, failed: ['unrelated'] }, NAMED).verdict, 'caught');
});

check('a nonzero exit with no failing test is a crash, never caught', () => {
  for (const failed of [[], undefined, null]) {
    const v = classify({ code: 1, failed }, NAMED);
    assert.strictEqual(v.verdict, 'error', `failed=${JSON.stringify(failed)}`);
    assert.match(v.reason, /exited 1 without failing any test/);
  }
  assert.strictEqual(classify({ code: 70, failed: [] }, NAMED).verdict, 'error');
});

check('a timeout, a kill or a missing status is an error even when the named failure was printed', () => {
  const printed = [NAMED];
  const runs = [
    { code: null, signal: 'SIGTERM', error: timedOut, failed: printed },
    { code: null, signal: 'SIGKILL', failed: printed },
    { code: null, failed: [] },
    { failed: printed },
    { code: undefined, failed: printed },
    { code: '1', failed: printed },
    { code: 1.5, failed: printed },
    { code: Number.NaN, failed: printed },
  ];
  for (const run of runs) {
    const v = classify(run, NAMED);
    assert.strictEqual(v.verdict, 'error', JSON.stringify(run));
    assert.match(v.reason, /did not finish|killed/);
  }
  assert.match(classify(runs[0], NAMED).reason, /ETIMEDOUT/);
  assert.match(classify(runs[1], NAMED).reason, /SIGKILL/);
  assert.strictEqual(classify(null, NAMED).verdict, 'error');
});

check('a named failure with a nonzero exit is caught, including inside a longer failing name', () => {
  assert.strictEqual(classify({ code: 1, failed: [NAMED] }, NAMED).verdict, 'caught');
  assert.strictEqual(classify({ code: 1, failed: ['first', NAMED, 'last'] }, NAMED).verdict, 'caught');
  assert.strictEqual(classify({ code: 3, failed: [`suite: ${NAMED} (retried)`] }, NAMED).verdict, 'caught');
  assert.strictEqual(classify({ code: 1, failed: [NAMED.toUpperCase()] }, NAMED).verdict, 'imprecise');
});

check('a green run is escaped, and one that reports failures while exiting 0 is an error', () => {
  const green = classify({ code: 0, failed: [] }, NAMED);
  assert.strictEqual(green.verdict, 'escaped');
  assert.strictEqual(classify({ code: 0 }, NAMED).verdict, 'escaped');
  const lying = classify({ code: 0, failed: [NAMED] }, NAMED);
  assert.strictEqual(lying.verdict, 'error', 'a named failure under exit 0 must not count: the suite did not report red');
  assert.match(lying.reason, /exited 0 while reporting failures/);
});

check('a mutation that names no test cannot be caught by anything', () => {
  for (const mustFail of ['', undefined, null, 7, {}]) {
    const v = classify({ code: 1, failed: ['any failing test at all'] }, mustFail);
    assert.strictEqual(v.verdict, 'error', `mustFail=${JSON.stringify(mustFail)}`);
    assert.match(v.reason, /names no test/);
  }
});

const SUMMARY_OK = '\n====\n2909 passed, 0 failed  (494s)\n';

check('the baseline must finish, exit 0, print a summary, run tests, fail none and skip none', () => {
  const good = judgeBaseline({ code: 0, out: SUMMARY_OK });
  assert.deepStrictEqual(good, { ok: true, reason: '', passed: 2909, failed: 0, skipped: 0 });

  const bad = (run, reason) => {
    const j = judgeBaseline(run);
    assert.strictEqual(j.ok, false, JSON.stringify(run));
    assert.match(j.reason, reason, JSON.stringify(run));
  };
  bad({ code: null, signal: 'SIGTERM', error: timedOut, out: SUMMARY_OK }, /ETIMEDOUT/);
  bad({ code: null, signal: 'SIGKILL', out: SUMMARY_OK }, /SIGKILL/);
  bad({ code: null, out: SUMMARY_OK }, /did not finish/);
  bad({ code: 1, out: '2908 passed, 1 failed  (494s)\n' }, /exited 1/);
  bad({ code: 0, out: 'everything is fine\n' }, /no "N passed, M failed" summary/);
  bad({ code: 0, out: '' }, /no "N passed, M failed" summary/);
  bad({ code: 0, out: undefined }, /no "N passed, M failed" summary/);
  bad({ code: 0, out: '2908 passed, 1 failed  (494s)\n' }, /1 test failed/);
  bad({ code: 0, out: '2908 passed, 2 failed  (494s)\n' }, /2 tests failed/);
  bad({ code: 0, out: '2908 passed, 0 failed, 1 SKIPPED  (494s)\n' }, /1 SKIPPED/);
  bad({ code: 0, out: '2900 passed, 0 failed, 9 SKIPPED  (494s)\n' }, /9 SKIPPED/);
  bad({ code: 0, out: '0 passed, 0 failed  (0s)\n' }, /ran no tests/);
});

check('the baseline reads the last summary line and tolerates CRLF', () => {
  const crlf = judgeBaseline({ code: 0, out: 'a\r\n12 passed, 0 failed  (3s)\r\n' });
  assert.strictEqual(crlf.ok, true);
  assert.strictEqual(crlf.passed, 12);
  const decoy = judgeBaseline({ code: 0, out: '0 passed, 5 failed  (1s)\nlater\n40 passed, 0 failed  (2s)\n' });
  assert.strictEqual(decoy.ok, true, 'an earlier line must not outvote the final summary');
  assert.strictEqual(decoy.passed, 40);
  const trailing = judgeBaseline({ code: 0, out: '40 passed, 0 failed  (2s)\n0 passed, 7 failed  (1s)\n' });
  assert.strictEqual(trailing.ok, false, 'the final summary is the one that counts');
});

check('the exit status is 0 only when every selected mutation was caught and the restore is clean', () => {
  const caught = (n) => Array.from({ length: n }, () => ({ verdict: 'caught' }));
  const clean = { ok: true };

  const all = summarise(caught(4), clean, 4);
  assert.deepStrictEqual([all.caught, all.applied, all.accepted, all.exitCode], [4, 4, true, 0]);

  const withWrongTest = summarise([...caught(3), { verdict: 'imprecise' }], clean, 4);
  assert.deepStrictEqual([withWrongTest.caught, withWrongTest.exitCode], [3, 1], 'a wrong-test hit must not be counted or accepted');
  for (const verdict of ['escaped', 'imprecise', 'error', 'anchor', 'something unknown']) {
    const s = summarise([...caught(2), { verdict }], clean, 3);
    assert.strictEqual(s.exitCode, 1, verdict);
    assert.strictEqual(s.caught, 2, verdict);
  }

  const noneCaught = summarise([{ verdict: 'imprecise' }, { verdict: 'error' }], clean, 2);
  assert.deepStrictEqual([noneCaught.caught, noneCaught.exitCode], [0, 1]);
  assert.strictEqual(summarise([], clean, 0).exitCode, 1, 'a run of nothing is not a pass');

  assert.strictEqual(summarise(caught(2), { ok: false, reason: 'RED' }, 2).exitCode, 1, 'a red restore must fail a fully caught run');
  assert.strictEqual(summarise(caught(2), undefined, 2).exitCode, 1);
  assert.strictEqual(summarise(caught(2), clean, 3).exitCode, 1, 'a selected mutation with no outcome must fail the run');
  assert.strictEqual(summarise(caught(2), clean).exitCode, 1, 'an unknown selection size must not read as complete');
  assert.deepStrictEqual(summarise([{ verdict: 'caught' }, { verdict: 'escaped' }, { verdict: 'escaped' }], clean, 3).tally, { caught: 1, escaped: 2 });
});

// ---------------------------------------------------------------------------
// The real main, on a throwaway tree.
// ---------------------------------------------------------------------------

const T_ADD = 'add sums two numbers';
const T_LABEL = 'label names the number';
const T_TWIN = 'twin title shared by two suites';

const SUBJECT = [
  "'use strict';",
  'function add(a, b) { return a + b; }',
  "function label(n) { return 'n=' + n; }",
  'function spare() { return 0; } // spare',
  'module.exports = { add, label, spare };',
  '',
].join('\n');

const SUBJECT_UNIT = [
  "'use strict';",
  "const assert = require('assert');",
  "const { add, label } = require('../src/subject');",
  'let fail = 0;',
  'function check(name, fn) {',
  "  try { fn(); console.log('RESULT\\tok\\t' + name); }",
  "  catch (e) { fail += 1; console.log('RESULT\\tfail\\t' + name + '\\t' + String(e.message).split('\\n')[0]); }",
  '}',
  `check(${JSON.stringify(T_ADD)}, () => assert.strictEqual(add(2, 3), 5));`,
  `check(${JSON.stringify(T_LABEL)}, () => assert.strictEqual(label(7), 'n=7'));`,
  `check(${JSON.stringify(T_TWIN)}, () => assert.strictEqual(add(1, 1), 2));`,
  'process.exit(fail ? 1 : 0);',
  '',
].join('\n');

// A second suite that declares the same title, so no suite can be said to own
// it. It is only ever READ, to build the index; the stub never runs it.
const TWIN_UNIT = [
  "'use strict';",
  `check(${JSON.stringify(T_TWIN)}, () => {});`,
  '',
].join('\n');

// Stands in for test/run-tests.js. It runs the one child suite and reports it
// as run-tests.js does -- FAIL lines, a summary, an exit status -- and lets a
// test bend the summary of an otherwise clean run through STUB_BASELINE.
const STUB_RUN_TESTS = [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  "const { spawnSync } = require('child_process');",
  "const r = spawnSync(process.execPath, [path.join(__dirname, 'subject-unit.js')], { encoding: 'utf8' });",
  "const out = (r.stdout || '') + (r.stderr || '');",
  "const results = out.split('\\n').filter((l) => l.startsWith('RESULT\\t')).map((l) => l.split('\\t'));",
  "const fails = results.filter((x) => x[1] === 'fail');",
  "for (const f of fails) console.log('  FAIL ' + f[2]);",
  "const runs = path.join(__dirname, 'runs.txt');",
  "const n = (fs.existsSync(runs) ? Number(fs.readFileSync(runs, 'utf8')) : 0) + 1;",
  'fs.writeFileSync(runs, String(n));',
  "const mode = process.env.STUB_BASELINE || 'green';",
  'const pristine = r.status === 0 && !fails.length;',
  'const ok = results.length - fails.length;',
  "let line = ok + ' passed, ' + fails.length + ' failed  (1s)';",
  'let code = r.status === 0 ? 0 : 1;',
  "if (pristine && mode === 'skips') line = ok + ' passed, 0 failed, 1 SKIPPED  (1s)';",
  "if (pristine && mode === 'zero') line = '0 passed, 0 failed  (0s)';",
  "if (pristine && (mode === 'red' || (mode === 'second-run-red' && n > 1))) {",
  "  line = ok + ' passed, 1 failed  (1s)';",
  "  console.log('  FAIL stub: the baseline is red');",
  '  code = 1;',
  '}',
  "if (!(pristine && mode === 'nosummary')) console.log(line);",
  'process.exit(code);',
  '',
].join('\n');

const HARNESS_START = '\nconst MUTATIONS = [\n';
const HARNESS_END = '\n/**\n * Source on disk is CRLF on Windows';
const realHarness = fs.readFileSync(path.join(__dirname, 'mutate.js'), 'utf8').replace(/\r\n/g, '\n');

/** The real harness text with only its catalogue swapped for `catalogue`. */
function harnessWith(catalogue) {
  const start = realHarness.indexOf(HARNESS_START);
  const end = realHarness.indexOf(HARNESS_END);
  assert.ok(start !== -1 && end > start, 'the catalogue boundaries in test/mutate.js moved, so the scratch harness cannot be built');
  assert.strictEqual(realHarness.split(HARNESS_START).length, 2, 'more than one catalogue start in test/mutate.js');
  assert.strictEqual(realHarness.split(HARNESS_END).length, 2, 'more than one catalogue end in test/mutate.js');
  return `${realHarness.slice(0, start)}\nconst MUTATIONS = ${JSON.stringify(catalogue)};\n${realHarness.slice(end)}`;
}

function buildScratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-'));
  const test = path.join(root, 'test');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(test, 'helpers'), { recursive: true });
  for (const f of fs.readdirSync(path.join(__dirname, 'helpers')).filter((x) => x.endsWith('.js'))) {
    fs.copyFileSync(path.join(__dirname, 'helpers', f), path.join(test, 'helpers', f));
  }
  fs.writeFileSync(path.join(test, 'subject-unit.js'), SUBJECT_UNIT);
  fs.writeFileSync(path.join(test, 'twin-unit.js'), TWIN_UNIT);
  fs.writeFileSync(path.join(test, 'run-tests.js'), STUB_RUN_TESTS);
  return root;
}

function withScratch(fn) {
  const root = buildScratch();
  try { return fn(root); } finally {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
  }
}

const mutation = (name, find, replace, mustFail) => ({ name, file: 'src/subject.js', find, replace, mustFail });
const M = {
  caught: mutation('add stops adding', 'return a + b;', 'return a - b;', T_ADD),
  imprecise: mutation('label breaks but add is named', "return 'n=' + n;", "return 'm=' + n;", T_ADD),
  escaped: mutation('spare changes and nothing notices', 'function spare() { return 0; }', 'function spare() { return 1; }', T_ADD),
  anchor: mutation('anchor text that is not there', 'this text is not in the subject', 'x', T_ADD),
  crash: mutation('subject stops being javascript', 'module.exports = { add, label, spare };', 'module.exports = { add, label, spare }; this is not javascript;', T_ADD),
  viaFullSuite: mutation('add stops adding, named by a shared title', 'return a + b;', 'return a - b;', T_TWIN),
  viaFullSuiteWrong: mutation('label breaks, shared title is named', "return 'n=' + n;", "return 'm=' + n;", T_TWIN),
};

/** Run the real main over `catalogue`, and prove it left the subject exactly as it found it. */
function runMain(root, catalogue, { baseline = 'green', subject = SUBJECT } = {}) {
  const subjectPath = path.join(root, 'src', 'subject.js');
  fs.writeFileSync(subjectPath, subject);
  fs.rmSync(path.join(root, 'test', 'runs.txt'), { force: true });
  fs.writeFileSync(path.join(root, 'test', 'mutate.js'), harnessWith(catalogue));
  const r = spawnSync(process.execPath, [path.join(root, 'test', 'mutate.js')], {
    cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, STUB_BASELINE: baseline },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.strictEqual(r.status === null, false, `the scratch harness did not finish: ${r.error || r.signal}\n${out.slice(-600)}`);
  assert.strictEqual(fs.readFileSync(subjectPath, 'utf8'), subject, 'the harness left the mutated subject behind');
  const runsFile = path.join(root, 'test', 'runs.txt');
  return { code: r.status, out, stubRuns: fs.existsSync(runsFile) ? Number(fs.readFileSync(runsFile, 'utf8')) : 0 };
}

check('main exits 1 and names the wrong test when the suite fails on one that is not the named test', () => withScratch((root) => {
  const r = runMain(root, [M.imprecise]);
  assert.strictEqual(r.code, 1, `a mutant stopped by the wrong test exited ${r.code}\n${r.out}`);
  assert.match(r.out, /IMPRECISE {2}label breaks but add is named {2}\(not counted as caught\)/);
  assert.match(r.out, new RegExp(`the suite failed on: ${T_LABEL}`));
  assert.match(r.out, new RegExp(`EXPECTED: "${T_ADD}"`));
  assert.match(r.out, /^0\/1 mutations caught/m);
  assert.match(r.out, /FAILED ON A TEST OTHER THAN THE NAMED ONE \(not counted as caught\)/);
  assert.match(r.out, /NOT ACCEPTED: 1 of 1 selected mutations were not caught/);
  assert.doesNotMatch(r.out, /^\s*CAUGHT/m);
}));

check('main exits 0 only for a catalogue whose every mutation fails its named test', () => withScratch((root) => {
  const one = runMain(root, [M.caught]);
  assert.strictEqual(one.code, 0, one.out);
  assert.match(one.out, /^\s*CAUGHT {2}add stops adding/m);
  assert.match(one.out, /^1\/1 mutations caught/m);
  assert.match(one.out, /source restored, baseline re-run: green/);
  assert.match(one.out, /ACCEPTED: every selected mutation was caught/);
  assert.strictEqual(one.stubRuns, 2, 'one baseline before and one after the single mutation');

  const two = runMain(root, [M.caught, mutation('add stops adding, differently', 'return a + b;', 'return a * b;', T_ADD)]);
  assert.strictEqual(two.code, 0, two.out);
  assert.match(two.out, /^2\/2 mutations caught/m);
}));

check('main exits 1 for a green mutant, a moved anchor and a crashed suite, each labelled distinctly', () => withScratch((root) => {
  const escaped = runMain(root, [M.escaped]);
  assert.strictEqual(escaped.code, 1, escaped.out);
  assert.match(escaped.out, /^\s*ESCAPED {1}spare changes and nothing notices/m);
  assert.match(escaped.out, /stayed GREEN\. Nothing tests this/);
  assert.match(escaped.out, /UNTESTED MECHANISMS/);
  assert.match(escaped.out, /^0\/1 mutations caught/m);

  const moved = runMain(root, [M.anchor]);
  assert.strictEqual(moved.code, 1, moved.out);
  assert.match(moved.out, /^\s*ANCHOR {2}anchor text that is not there/m);
  assert.match(moved.out, /the mutation never ran/);
  assert.match(moved.out, /^0\/1 mutations caught/m);

  const crashed = runMain(root, [M.crash]);
  assert.strictEqual(crashed.code, 1, `a suite that crashed on the mutant exited ${crashed.code}\n${crashed.out}`);
  assert.match(crashed.out, /^\s*ERROR {3}subject stops being javascript {2}\(not counted as caught\)/m);
  assert.match(crashed.out, /exited 1 without failing any test/);
  assert.match(crashed.out, /NO VERDICT: THE SUITE DID NOT FINISH CLEANLY/);
  assert.match(crashed.out, /^0\/1 mutations caught/m);
  assert.doesNotMatch(crashed.out, /^\s*CAUGHT/m);
}));

check('main counts only the caught mutations in a mixed catalogue and exits 1', () => withScratch((root) => {
  const r = runMain(root, [M.caught, M.imprecise, M.escaped, M.anchor, M.crash, M.viaFullSuite]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /^2\/6 mutations caught/m);
  assert.match(r.out, /^\s*CAUGHT {2}add stops adding$/m);
  assert.match(r.out, /^\s*CAUGHT {2}add stops adding, named by a shared title/m);
  for (const label of [/IMPRECISE {2}label breaks/, /ESCAPED {1}spare changes/, /ANCHOR {2}anchor text/, /ERROR {3}subject stops/]) assert.match(r.out, label);
  assert.match(r.out, /NOT ACCEPTED: 4 of 6 selected mutations were not caught/);
  assert.strictEqual(r.stubRuns, 3, 'the baseline, the one mutant routed to the full suite, and the restore');
}));

check('main places an ambiguous title on the full suite and still judges it by name', () => withScratch((root) => {
  const right = runMain(root, [M.viaFullSuite]);
  assert.strictEqual(right.code, 0, right.out);
  assert.match(right.out, /1 cannot be placed statically and use the full suite/);
  assert.match(right.out, /-> "twin title shared by two suites" failed, as it must {2}\[the full suite\]/);

  const wrong = runMain(root, [M.viaFullSuiteWrong]);
  assert.strictEqual(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /IMPRECISE {2}label breaks, shared title is named/);
  assert.match(wrong.out, /\[the full suite\]/);
}));

check('main refuses a baseline that skipped, ran nothing, failed or printed no summary, before any mutation', () => withScratch((root) => {
  const cases = [
    ['skips', /BASELINE IS RED: 1 SKIPPED/],
    ['zero', /BASELINE IS RED: the suite ran no tests/],
    ['red', /BASELINE IS RED: the suite exited 1/],
    ['nosummary', /BASELINE IS RED: the suite printed no "N passed, M failed" summary/],
  ];
  for (const [baseline, message] of cases) {
    const r = runMain(root, [M.caught], { baseline });
    assert.strictEqual(r.code, 1, `${baseline}: exited ${r.code}\n${r.out}`);
    assert.match(r.out, message, baseline);
    assert.strictEqual(r.stubRuns, 1, `${baseline}: a mutation ran against a baseline that proved nothing`);
    assert.doesNotMatch(r.out, /^\s*(CAUGHT|ESCAPED|IMPRECISE|ERROR)/m, baseline);
    assert.doesNotMatch(r.out, /mutations caught/, baseline);
  }
  const green = runMain(root, [M.caught]);
  assert.strictEqual(green.code, 0, 'the same catalogue passes against a clean baseline');
  assert.match(green.out, /baseline green: 3 passed, 0 failed, 0 skipped/);
}));

check('main fails a clean sweep whose restored source does not re-run clean', () => withScratch((root) => {
  const r = runMain(root, [M.caught], { baseline: 'second-run-red' });
  assert.strictEqual(r.code, 1, `a red restore exited ${r.code}\n${r.out}`);
  assert.match(r.out, /^1\/1 mutations caught/m);
  assert.match(r.out, /source restored, baseline re-run: RED \(the suite exited 1\)/);
  assert.match(r.out, /NOT ACCEPTED: the restored source does not re-run as a clean baseline/);
  for (const baseline of ['skips', 'zero', 'nosummary']) {
    assert.strictEqual(runMain(root, [M.caught], { baseline }).code, 1, baseline);
  }
}));

check('main refuses to start when a previous run left a live mutation in the tree', () => withScratch((root) => {
  const live = SUBJECT.replace('return a + b;', 'return a - b; // MUTATION');
  const r = runMain(root, [M.caught], { subject: live });
  assert.strictEqual(r.code, 3, r.out);
  assert.match(r.out, /A previous run left live mutations in the working tree/);
  assert.match(r.out, /git checkout -- src\/subject\.js/);
  assert.strictEqual(r.stubRuns, 0, 'a baseline ran on top of a live mutation');
}));

// --- Output-level judgement shared by the acceptance runner and the probe ------

const RES = (verdict, name, why) => `RESULT\t${verdict}\t${name}${why ? `\t${why}` : ''}`;
const suiteOut = (...lines) => `${lines.join('\n')}\n`;
const GREEN_OUT = suiteOut(RES('ok', 'one'), '  ok   one', RES('ok', 'two'), '  ok   two', '2 passed, 0 failed');
const RED_OUT = suiteOut(RES('ok', 'one'), RES('fail', NAMED, 'boom'), `  FAIL ${NAMED}`, '1 passed, 1 failed');

check('a status integer is never enough: an error, a signal, a timeout or a cancel disqualifies a run that also reports a code', () => {
  for (const over of [{ signal: 'SIGKILL' }, { timedOut: true }, { cancelled: true }, { error: timedOut }]) {
    const run = { code: 0, out: '5 passed, 0 failed  (1s)\n', ...over };
    assert.strictEqual(judgeBaseline(run).ok, false, JSON.stringify(Object.keys(over)));
    assert.strictEqual(judgeControl({ ...run, out: GREEN_OUT }).ok, false);
    assert.strictEqual(classify({ code: 1, failed: [NAMED], ...over }, NAMED).verdict, 'error');
    assert.strictEqual(classifyRun({ code: 1, out: RED_OUT, ...over }, NAMED).verdict, 'error');
  }
  assert.match(judgeBaseline({ code: 0, timedOut: true, out: '5 passed, 0 failed  (1s)' }).reason, /timed out and was stopped/);
  assert.match(classify({ code: 1, signal: 'SIGTERM', failed: [NAMED] }, NAMED).reason, /killed by SIGTERM/);
});

check('RESULT lines and summaries are read the way the suites print them', () => {
  assert.deepStrictEqual(parseResults(suiteOut(RES('ok', 'a'), 'noise', RES('fail', 'b', 'why'), RES('skip', 'c', 'no browser'))), [
    { verdict: 'ok', name: 'a', why: '' }, { verdict: 'fail', name: 'b', why: 'why' }, { verdict: 'skip', name: 'c', why: 'no browser' },
  ]);
  assert.deepStrictEqual(parseSummary('x\n3 passed, 1 failed\n'), { passed: 3, failed: 1, skipped: 0 });
  assert.deepStrictEqual(parseSummary('3 passed, 0 failed, 2 skipped\r\n'), { passed: 3, failed: 0, skipped: 2 });
  assert.deepStrictEqual(parseSummary('2909 passed, 0 failed  (494s)\n'), { passed: 2909, failed: 0, skipped: 0 });
  assert.deepStrictEqual(parseSummary('required model: 4 passed, 0 failed\n'), { passed: 4, failed: 0, skipped: 0 });
  assert.deepStrictEqual(parseSummary('1 passed, 0 failed\nnoise\n9 passed, 2 failed\n'), { passed: 9, failed: 2, skipped: 0 }, 'the last summary wins');
  assert.strictEqual(parseSummary('no numbers here'), null);
  assert.strictEqual(parseSummary('about 3 passed, 0 failed things'), null, 'prose is not a summary');
});

check('failed names come from RESULT lines when there are any, else from run-tests FAIL lines, and never twice', () => {
  assert.deepStrictEqual(failedNames(RED_OUT), [NAMED], 'the human FAIL line beside a RESULT line is not a second failure');
  assert.deepStrictEqual(failedNames('  ok   a\n  FAIL b\n  FAIL c\n1 passed, 2 failed  (1s)\n'), ['b', 'c']);
  assert.deepStrictEqual(failedNames(GREEN_OUT), []);
  assert.deepStrictEqual(failedNames(''), []);
  assert.deepStrictEqual(failedNames(undefined), []);
});

check('a control is clean only when it finished 0, ran something, failed and skipped nothing, and its summary agrees with its results', () => {
  assert.deepStrictEqual(judgeControl({ code: 0, out: GREEN_OUT }), { ok: true, reason: '', passed: 2, failed: 0, skipped: 0 });
  const bad = (run, re, label) => {
    const v = judgeControl(run);
    assert.strictEqual(v.ok, false, label);
    assert.match(v.reason, re, label);
  };
  bad({ code: 1, out: GREEN_OUT }, /exited 1/, 'nonzero');
  bad({ code: 0, out: RED_OUT }, new RegExp(`1 test failed: ${NAMED}`), 'a failure under status 0');
  bad({ code: 0, out: suiteOut(RES('ok', 'a'), RES('skip', 'b', 'no browser'), '1 passed, 0 failed, 1 skipped') }, /1 SKIPPED/, 'a skip');
  bad({ code: 0, out: '0 passed, 0 failed\n' }, /no RESULT lines/, 'zero tests');
  bad({ code: 0, out: suiteOut(RES('ok', 'a')) }, /no "N passed, M failed" summary/, 'a log cut off before the summary');
  bad({ code: 0, out: suiteOut(RES('ok', 'a'), RES('ok', 'b'), '3 passed, 0 failed') }, /summary \(3 passed, 0 failed, 0 skipped\) contradicts the 2 results/, 'a summary that claims more than was shown');
  bad({ code: 0, out: suiteOut(RES('ok', 'a'), '0 passed, 0 failed') }, /contradicts the 1 results/, 'a summary of nothing');
  bad({ code: 0, out: suiteOut(RES('ok', 'a'), RES('ok', 'aggregate row'), '1 passed, 0 failed') }, /summary \(1 passed, 0 failed, 0 skipped\) contradicts the 2 results/, 'a tally that leaves out a RESULT row is a contradiction too, not an allowance');
  bad({ code: 0, out: suiteOut(RES('ok', 'a'), RES('ok', 'b'), '2 passed, 1 failed') }, /contradicts/, 'a failure the results never showed');
  bad({ code: 0, out: suiteOut(RES('ok', 'a'), '1 passed, 0 failed, 3 skipped') }, /contradicts/, 'skips the results never showed');
  bad({ code: 0, out: suiteOut(RES('ok', 'a'), RES('maybe', 'b'), '1 passed, 0 failed') }, /unrecognised RESULT verdict "maybe"/, 'a verdict nobody defined');
  bad({ code: null, out: GREEN_OUT }, /did not finish/, 'no status');
  bad(undefined, /did not finish/, 'no run at all');
});

check('a mutant run is caught only on a complete, summarised, nonzero run that fails the named test', () => {
  assert.deepStrictEqual(classifyRun({ code: 1, out: RED_OUT }, NAMED), { verdict: 'caught', reason: '' });
  assert.strictEqual(classifyRun({ code: 1, out: RED_OUT }, 'some other test').verdict, 'imprecise');
  assert.strictEqual(classifyRun({ code: 0, out: GREEN_OUT }, NAMED).verdict, 'escaped');
  assert.strictEqual(classifyRun({ code: 1, out: GREEN_OUT }, NAMED).verdict, 'error', 'a crash that failed no test');
  assert.strictEqual(classifyRun({ code: 1, out: RED_OUT }, '').verdict, 'error', 'a mutation that names nothing');
  const cases = [
    ['no summary at all', { code: 1, out: suiteOut(RES('fail', NAMED, 'boom')) }, /no "N passed, M failed" summary/],
    ['skipped tests in the mutant run', { code: 1, out: suiteOut(RES('fail', NAMED), '0 passed, 1 failed, 2 skipped') }, /2 test\(s\) SKIPPED/],
    ['a summary of nothing', { code: 1, out: suiteOut(RES('fail', NAMED), '0 passed, 0 failed') }, /executed no tests/],
    ['fewer failures counted than printed', { code: 1, out: suiteOut(RES('fail', NAMED), RES('fail', 'other'), '3 passed, 1 failed') }, /summary says 1 failed but 2 failures were printed/],
    ['status 0 with a failing summary', { code: 0, out: suiteOut(RES('ok', 'a'), '1 passed, 1 failed') }, /exited 0 while its summary reports 1 failed/],
  ];
  for (const [label, run, re] of cases) {
    const v = classifyRun(run, NAMED);
    assert.strictEqual(v.verdict, 'error', label);
    assert.match(v.reason, re, label);
  }
  assert.strictEqual(classifyRun({ code: 1, out: suiteOut(RES('fail', NAMED, 'boom')) }, NAMED, { requireSummary: false }).verdict, 'caught', 'the summary requirement is explicit and opt-out');
});

check('a mutant run whose summary disagrees with its RESULT rows is an error in every direction, never a catch', () => {
  const reason = (out, code = 1) => classifyRun({ code, out }, NAMED);
  const cases = [
    ['an invented extra failure', suiteOut(RES('ok', 'a'), RES('fail', NAMED), '1 passed, 2 failed'), /summary says 2 failed but only 1 failures were printed/],
    ['a hidden failure', suiteOut(RES('fail', NAMED), RES('fail', 'other'), '0 passed, 1 failed'), /summary says 1 failed but 2 failures were printed/],
    ['an invented extra pass', suiteOut(RES('ok', 'a'), RES('fail', NAMED), '5 passed, 1 failed'), /contradicts the 2 results/],
    ['a pass left out of the tally', suiteOut(RES('ok', 'a'), RES('ok', 'b'), RES('fail', NAMED), '1 passed, 1 failed'), /contradicts the 3 results/],
    ['a skip row omitted from the summary', suiteOut(RES('ok', 'a'), RES('skip', 'b', 'no browser'), RES('fail', NAMED), '1 passed, 1 failed'), /SKIPPED in the mutant run/],
    ['skips the rows never showed', suiteOut(RES('ok', 'a'), RES('fail', NAMED), '1 passed, 1 failed, 1 skipped'), /SKIPPED in the mutant run/],
    ['an unknown verdict', suiteOut(RES('ok', 'a'), RES('maybe', 'b'), RES('fail', NAMED), '1 passed, 1 failed'), /unrecognised RESULT verdict "maybe"/],
  ];
  for (const [label, out, re] of cases) {
    const v = reason(out);
    assert.strictEqual(v.verdict, 'error', label);
    assert.match(v.reason, re, label);
  }
  assert.strictEqual(reason(suiteOut(RES('maybe', 'x'), RES('fail', NAMED))).verdict, 'error', 'an unknown verdict is an error even with no summary to compare');
  assert.strictEqual(classifyRun({ code: 1, out: suiteOut(RES('maybe', 'x'), RES('fail', NAMED)) }, NAMED, { requireSummary: false }).verdict, 'error');
  assert.strictEqual(reason(suiteOut(RES('ok', 'a'), RES('fail', NAMED), '1 passed, 1 failed')).verdict, 'caught', 'a consistent summary still catches');
  for (const over of [{ timedOut: true }, { cancelled: true }, { signal: 'SIGTERM' }, { error: timedOut }]) {
    assert.strictEqual(classifyRun({ code: 1, out: suiteOut(RES('ok', 'a'), RES('fail', NAMED), '1 passed, 1 failed'), ...over }, NAMED).verdict, 'error', 'an interrupted run stays an error with an integer status');
  }
});

check('a full regression (no RESULT rows) is accounted by its own ok / FAIL / SKIP lines, and a quoted child RESULT row is not its record', () => {
  const full = (...lines) => suiteOut('  [child-suite] start thing', '  [child-suite] end thing (0.1s)', ...lines);
  assert.strictEqual(outputFormat(full('  ok   a')), 'full');
  assert.strictEqual(outputFormat(suiteOut(RES('ok', 'a'))), 'results');
  assert.strictEqual(outputFormat(suiteOut('  ok   a', '1 passed, 0 failed')), 'lines');
  for (const pre of [full, suiteOut]) {
    assert.deepStrictEqual(classifyRun({ code: 1, out: pre('  ok   a', `  FAIL ${NAMED}`, '         why', '1 passed, 1 failed  (3s)') }, NAMED), { verdict: 'caught', reason: '' });
    assert.deepStrictEqual(classifyRun({ code: 1, out: pre('  ok   a', '  ok   b', `  FAIL ${NAMED}`, '2 passed, 1 failed  (3s)') }, NAMED), { verdict: 'caught', reason: '' });
    const bad = (out, re, label) => {
      const v = classifyRun({ code: 1, out }, NAMED);
      assert.strictEqual(v.verdict, 'error', label);
      assert.match(v.reason, re, label);
    };
    bad(pre('  ok   a', `  FAIL ${NAMED}`, '1 passed, 3 failed'), /summary says 3 failed but only 1 failures were printed/, 'an invented failure');
    bad(pre('  ok   a', `  FAIL ${NAMED}`, '  FAIL other', '1 passed, 1 failed'), /summary says 1 failed but 2 failures were printed/, 'a hidden failure');
    bad(pre('  ok   a', `  FAIL ${NAMED}`, '9 passed, 1 failed'), /summary says 9 passed but only 1 ok lines were printed/, 'invented passes');
    bad(pre('  ok   a', '  SKIP b', `  FAIL ${NAMED}`, '1 passed, 1 failed'), /SKIP lines were printed/, 'a skip row omitted from the summary');
  }
  const quoted = full('  ok   a', `  FAIL ${NAMED}  (exit=1)`, `         RESULT\tfail\tsome child test\tboom`, 'RESULT\tfail\tanother child test', '1 passed, 1 failed  (3s)');
  assert.deepStrictEqual(failedNames(quoted), [`${NAMED}  (exit=1)`], 'a full regression names its own FAIL lines, not a quoted child result');
  assert.strictEqual(classifyRun({ code: 1, out: quoted }, NAMED).verdict, 'caught');
});

// --- The quick probe shares the strict verdict rules ---------------------------

const { probe, runChild } = require('./mutate-probe');

function probeScratch(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-unit-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const SUBJECT_SRC = 'module.exports = () => 41 + 1;\r\n';
const CHILD_SRC = [
  "const f = require('./subject');",
  "const ok = f() === 42; const name = 'answer is 42';",
  "console.log(`RESULT\\t${ok ? 'ok' : 'fail'}\\t${name}`);",
  "console.log(`${ok ? 1 : 0} passed, ${ok ? 0 : 1} failed`);",
  'process.exit(ok ? 0 : 1);',
].join('\n');
const PROBE_MUT = { file: 'subject.js', name: 'answer m', find: '41 + 1', replace: '40 + 1', mustFail: 'answer is 42' };

check('the probe proves a real mutant through a real child, restores the file byte-for-byte and takes both controls', () => probeScratch((dir) => {
  fs.writeFileSync(path.join(dir, 'subject.js'), SUBJECT_SRC);
  fs.writeFileSync(path.join(dir, 'child.js'), CHILD_SRC);
  const lines = [];
  const res = probe({
    root: dir, mutations: [PROBE_MUT], log: (l) => lines.push(l),
    run: (env) => runChild(path.join(dir, 'child.js'), dir, env),
  });
  assert.strictEqual(res.ok, true, lines.join('\n'));
  assert.strictEqual(res.controls.pre.ok && res.controls.post.ok, true);
  assert.deepStrictEqual(res.results.map((r) => r.verdict), ['caught']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'subject.js'), 'utf8'), SUBJECT_SRC, 'CRLF bytes survive');
}));

check('the probe fails on a red pre-control, a wrong-name catch, a crash, a miss, a flaky post-control and never calls them catches', () => probeScratch((dir) => {
  fs.writeFileSync(path.join(dir, 'subject.js'), SUBJECT_SRC);
  const green = { code: 0, out: GREEN_OUT };
  const caughtOut = { code: 1, out: suiteOut(RES('fail', NAMED, 'x'), '0 passed, 1 failed') };
  const quiet = () => {};
  const mut = { ...PROBE_MUT, mustFail: NAMED };

  const red = probe({ root: dir, mutations: [mut], log: quiet, run: () => ({ code: 1, out: RED_OUT }) });
  assert.strictEqual(red.ok, false);
  assert.strictEqual(red.results.length, 0, 'no mutant runs against a red baseline');

  const answers = (seq) => { let i = 0; return () => seq[Math.min(i++, seq.length - 1)]; };
  const cases = [
    ['wrong name', [green, { code: 1, out: suiteOut(RES('fail', 'another'), '0 passed, 1 failed') }, green], 'imprecise'],
    ['crash with no failing test', [green, { code: 1, out: GREEN_OUT }, green], 'error'],
    ['timeout despite a status', [green, { code: 1, timedOut: true, out: caughtOut.out }, green], 'error'],
    ['killed by a signal', [green, { code: 1, signal: 'SIGKILL', out: caughtOut.out }, green], 'error'],
    ['miss', [green, green, green], 'escaped'],
    ['no summary', [green, { code: 1, out: suiteOut(RES('fail', NAMED)) }, green], 'error'],
  ];
  for (const [label, seq, verdict] of cases) {
    const res = probe({ root: dir, mutations: [mut], log: quiet, run: answers(seq) });
    assert.strictEqual(res.ok, false, label);
    assert.strictEqual(res.results[0].verdict, verdict, label);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'subject.js'), 'utf8'), SUBJECT_SRC, `${label}: restored`);
  }

  const flaky = probe({ root: dir, mutations: [mut], log: quiet, run: answers([green, caughtOut, { code: 1, out: RED_OUT }]) });
  assert.strictEqual(flaky.results[0].verdict, 'caught');
  assert.strictEqual(flaky.ok, false, 'a catch does not pass when the post-run control is red');

  const miss = probe({ root: dir, mutations: [{ ...mut, find: 'not in the file' }], log: quiet, run: () => green });
  assert.strictEqual(miss.ok, false);
  assert.match(miss.results[0].reason, /anchor did not match/);
}));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
