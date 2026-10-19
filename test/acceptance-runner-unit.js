'use strict';
/**
 * The acceptance runner end to end (test/helpers/acceptance-runner.js and the
 * CLI in test/acceptance.js), against a throwaway git repository whose
 * regression is a handful of tiny child suites. Processes are REAL (clones,
 * copies, children, logs, kills); only the mutation catalogue and the policy are
 * stand-ins, because the real catalogue costs hours. A wrapper around the real
 * process runner lets a case corrupt exactly one step -- a status that lies, a
 * source edit during the baseline, a hang -- and see what the run does with it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runAcceptance, normaliseOptions, UsageError } = require('./helpers/acceptance-runner');
const { runProcess, ownedCount } = require('./helpers/acceptance-process');
const ev = require('./helpers/acceptance-evidence');
const cli = require('./acceptance');

let pass = 0; let fail = 0;
async function check(name, fn) {
  try {
    await fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-run-'));
let serial = 0;
const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// --- The subject: a repository with real git, real suites, real run-tests -----

const CALC = 'module.exports = { add: (a, b) => a + b, mul: (a, b) => a * b };\n';
const GREET = "module.exports = { hi: () => 'hi' };\n";

const unit = (requirePath, checks, extra = '') => `'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const m = require('${requirePath}');
fs.writeFileSync(path.join(os.tmpdir(), 'seen.json'), JSON.stringify({ tmp: os.tmpdir(), home: process.env.SQUAD_HUB_HOME || null, mutant: process.env.MUTANT || null }));
if (process.env.MUTANT && process.env.ACC_SLOW) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
${extra}
const checks = ${checks};
let p = 0; let f = 0;
for (const [name, test] of checks) {
  let ok = false; try { ok = test(); } catch (e) { ok = false; }
  if (ok) { p += 1; console.log('RESULT\\tok\\t' + name); } else { f += 1; console.log('RESULT\\tfail\\t' + name + '\\twrong'); }
}
console.log(p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
`;

const runTests = (summary) => `'use strict';
const { spawnSync } = require('child_process'); const fs = require('fs'); const path = require('path');
let p = 0; let f = 0;
for (const file of fs.readdirSync(__dirname).filter((n) => n.endsWith('-unit.js')).sort()) {
  console.log('[child-suite] start ' + file);
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', env: process.env });
  console.log('[child-suite] end ' + file + ' (1.5s)');
  for (const line of r.stdout.split('\\n')) {
    if (line.startsWith('RESULT\\tok\\t')) { p += 1; console.log('  ok   ' + line.split('\\t')[2]); }
    else if (line.startsWith('RESULT\\tfail\\t')) { f += 1; console.log('  FAIL ' + line.split('\\t')[2]); }
  }
}
${summary}
process.exit(f ? 1 : 0);
`;

const SUMMARIES = {
  ok: "console.log(p + ' passed, ' + f + ' failed  (0s)');",
  none: '',
  zero: "console.log('0 passed, 0 failed  (0s)');",
  skipped: "console.log(p + ' passed, ' + f + ' failed, 1 SKIPPED  (0s)');",
};

function makeRepo({ calcBroken = false, summary = 'ok' } = {}) {
  const root = path.join(TMP, `repo-${(serial += 1)}`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'calc.js'), CALC);
  fs.writeFileSync(path.join(root, 'src', 'greet.js'), GREET);
  fs.writeFileSync(path.join(root, 'test', 'calc-unit.js'), unit('../src/calc', `[['add adds', () => ${calcBroken ? 'false' : 'm.add(2, 3) === 5'}], ['mul multiplies', () => m.mul(2, 3) === 6]]`));
  fs.writeFileSync(path.join(root, 'test', 'other-unit.js'), unit('../src/greet', "[['greeting is hi', () => m.hi() === 'hi']]"));
  fs.writeFileSync(path.join(root, 'test', 'run-tests.js'), runTests(SUMMARIES[summary]));
  sh('git', ['init', '-q'], root);
  sh('git', ['add', '-A'], root);
  sh('git', ['-c', 'user.name=Test Author', '-c', 'user.email=author@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'subject'], root);
  return root;
}

const MUTS = [
  { file: 'src/calc.js', name: 'add mutant', find: 'a + b', replace: 'a - b', mustFail: 'add adds' },
  { file: 'src/calc.js', name: 'mul mutant', find: 'a * b', replace: 'a + b', mustFail: 'mul multiplies' },
  { file: 'src/greet.js', name: 'greet mutant', find: "'hi'", replace: "'yo'", mustFail: 'greeting is hi' },
  { file: 'src/calc.js', name: 'mul full-suite mutant', find: 'a * b', replace: 'a / b', mustFail: 'mul multiplies' },
];
const suiteFor = (m) => (m.name === 'mul full-suite mutant' ? null : m.file === 'src/greet.js' ? 'other-unit.js' : 'calc-unit.js');

const policy = {
  mutationId: (m) => ev.sha256(ev.canonicalJson([m.file, m.name, m.find, m.replace, m.mustFail])),
  planAcceptance({ mutations, scope, baseRef, select, requiredSuites }) {
    const chosen = [];
    const deferred = [];
    const excluded = [];
    mutations.forEach((mutation, index) => {
      const entry = { id: policy.mutationId(mutation), index, mutation, suite: suiteFor(mutation), reasons: ['stand-in policy'] };
      if (mutation.skip) excluded.push(entry);
      else if (!select || select.includes(index)) chosen.push(entry);
      else deferred.push({ id: entry.id, index, reason: 'not selected' });
    });
    return { schemaVersion: 1, scope, baseRef: baseRef || null, changedFiles: [], selected: chosen, deferred, excluded, requiredSuites: requiredSuites || [], warnings: [], blockedReasons: [] };
  },
};
const withPlan = (tweak, extra = {}) => ({
  mutationId: policy.mutationId,
  planAcceptance: (a) => { const p = policy.planAcceptance({ ...a, ...extra }); return tweak(p) || p; },
});

// --- A process runner that can lie about, or interfere with, one step ----------

function spyExec(hook = {}) {
  const calls = [];
  const exec = async (spec) => {
    const m = /^\d+-(.+)\.log$/.exec(path.basename(spec.logPath));
    const call = { kind: m ? m[1] : '?', logPath: spec.logPath, cwd: spec.cwd, mutant: spec.env.MUTANT || null, suite: path.basename(spec.args[0] || ''), env: spec.env };
    calls.push(call);
    if (hook.before) await hook.before(call, spec);
    let r = await runProcess(spec);
    if (hook.after) r = (await hook.after(call, r, spec)) || r;
    return r;
  };
  exec.calls = calls;
  exec.count = (kind) => calls.filter((c) => c.kind === kind).length;
  return exec;
}

async function run(root, o = {}) {
  const artifacts = o.artifacts || path.join(TMP, `art-${(serial += 1)}`);
  const logs = [];
  const exec = o.exec || spyExec();
  const result = await runAcceptance({
    root, scope: 'exhaustive', artifacts, jobs: 1, mutations: MUTS, suiteFor, policy, scenarioFor: null,
    exec, heartbeatMs: 0, log: (...a) => logs.push(a.join(' ')),
    timeouts: { baselineMs: 120000, suiteMs: 60000, fullMs: 120000 },
    ...o, ...(o.exec ? {} : { exec }),
  });
  return { result, artifacts, logs, exec, text: logs.join('\n'), report: JSON.parse(fs.readFileSync(result.reportFile, 'utf8')) };
}

const verdicts = (r) => Object.fromEntries(r.report.outcomes.map((x) => [x.name, x.verdict]));
const readEvents = (artifacts) => fs.readFileSync(path.join(artifacts, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const read = (p) => fs.readFileSync(p, 'utf8');

(async () => {
  let happy; let happyRoot;

  await check('a clean exhaustive run is accepted, labelled exhaustive, and every mutation is caught by its own suite', async () => {
    happyRoot = makeRepo();
    const before = ev.sourceManifest(happyRoot);
    happy = await run(happyRoot, { jobs: 2 });
    assert.strictEqual(happy.result.status, 'accepted', happy.text);
    assert.strictEqual(happy.result.exitCode, 0);
    assert.strictEqual(happy.report.scope, 'exhaustive');
    assert.strictEqual(happy.report.scopeLabel, 'exhaustive');
    assert.deepStrictEqual(verdicts(happy), { 'add mutant': 'caught', 'mul mutant': 'caught', 'greet mutant': 'caught', 'mul full-suite mutant': 'caught' });
    assert.strictEqual(happy.report.outcomes.length, 4);
    assert.ok(happy.report.outcomes.every((x) => x.exit.code === 1 && x.failed.length >= 1), 'each caught mutant is a completed nonzero run that named a failure');
    assert.match(happy.text, /ACCEPTED \(exhaustive\)/);
    assert.deepStrictEqual(ev.sourceManifest(happyRoot), before, 'the caller tree is byte-for-byte what it was');
    assert.strictEqual(sh('git', ['status', '--porcelain'], happyRoot).trim(), '', 'and git sees no change');
    assert.strictEqual(ev.verifyReport(happy.result.reportFile, { expectedScope: 'exhaustive', manifestDigest: before.digest }).ok, true);
  });

  await check('there is one full baseline at the start and one at the end of the whole run, not one per worker or shard', async () => {
    for (const calls of [happy.exec]) {
      assert.strictEqual(calls.count('baseline'), 2, 'initial and final only');
      assert.strictEqual(calls.count('control-pre'), 2);
      assert.strictEqual(calls.count('control-post'), 2);
      assert.strictEqual(calls.count('mutation'), 4);
    }
    const wide = await run(makeRepo(), { jobs: 4 });
    assert.strictEqual(wide.result.status, 'accepted', wide.text);
    assert.strictEqual(wide.exec.count('baseline'), 2, 'four workers still share one baseline');
    assert.deepStrictEqual(read(happy.result.reportFile).match(/"label": "(initial|final)"/g).sort(), ['"label": "final"', '"label": "initial"']);
  });

  await check('workers run in private copies with a private TEMP, TMP and SQUAD_HUB_HOME, and never in the caller tree', async () => {
    const work = path.join(happy.artifacts, 'work');
    for (const c of happy.exec.calls) {
      assert.ok(ev.isInside(work, c.cwd), `${c.kind} ran in ${c.cwd}`);
      assert.notStrictEqual(path.resolve(c.cwd), path.resolve(happyRoot));
      assert.ok(ev.isInside(work, c.env.TEMP) && ev.isInside(work, c.env.SQUAD_HUB_HOME), 'private TEMP and home');
      assert.strictEqual(c.env.TEMP, c.env.TMP);
      assert.strictEqual(c.mutant, c.kind === 'mutation' ? '1' : null, `MUTANT is set on mutant runs only (${c.kind})`);
    }
    const homes = new Set(happy.exec.calls.map((c) => c.env.SQUAD_HUB_HOME));
    assert.ok(homes.size >= 3, 'the baseline copy and each worker have different homes');
    const seen = JSON.parse(read(path.join(work, 'w1-env', 'tmp', 'seen.json')));
    assert.strictEqual(seen.tmp, path.join(work, 'w1-env', 'tmp'));
    assert.strictEqual(seen.home, path.join(work, 'w1-env', 'home'));
    assert.ok(!fs.existsSync(path.join(happyRoot, 'seen.json')));
    const copy = ev.sourceManifest(path.join(work, 'w1'));
    assert.strictEqual(copy.digest, ev.sourceManifest(happyRoot).digest, 'a worker copy is restored byte for byte');
  });

  await check('every step has a streamed log, a JSONL start and finish with a duration, and the run emits a timing history', async () => {
    const events = readEvents(happy.artifacts);
    assert.strictEqual(events[0].event, 'run-start');
    const starts = events.filter((e) => e.event === 'step-start');
    const finishes = events.filter((e) => e.event === 'step-finish' && Number.isInteger(e.step));
    assert.strictEqual(starts.length, 10, 'two baselines, four controls, four mutants');
    assert.deepStrictEqual(starts.map((e) => e.step).sort((a, b) => a - b), finishes.map((e) => e.step).sort((a, b) => a - b));
    for (const f of finishes) {
      assert.ok(f.durationMs >= 0 && f.exit && 'code' in f.exit, JSON.stringify(f));
      assert.ok(fs.existsSync(path.join(happy.artifacts, f.log)), f.log);
    }
    assert.ok(events.every((e, i) => e.seq === i + 1 && typeof e.ts === 'string'));
    const t = JSON.parse(read(path.join(happy.artifacts, 'timings.json')));
    assert.ok(t.groups['calc-unit.js'].mutationMs >= 0 && t.groups['calc-unit.js'].controlMs >= 0);
    assert.ok(!('run-tests.js' in t.groups), 'a group with no measured control gets no history entry');
    assert.deepStrictEqual(t.baselineChildSuiteSeconds, { 'calc-unit.js': 1.5, 'other-unit.js': 1.5 }, 'the initial baseline log yields per-child-suite timings');
    const base = finishes.filter((e) => e.childSuites);
    assert.ok(base.length >= 2 && base.every((e) => e.childSuites.finished === 2 && !e.childSuites.unfinished.length && !e.childSuites.problems.length), 'full regressions report their child suites');
    assert.ok(finishes.filter((e) => !e.childSuites).length >= 4, 'single-suite steps carry no child-suite summary');
  });

  await check('a candidate run is labelled candidate-selected, lists what it deferred, and cannot satisfy an exhaustive gate', async () => {
    const r = await run(makeRepo(), { scope: 'candidate', baseRef: 'HEAD', policy: withPlan(() => null, { select: [0] }) });
    assert.strictEqual(r.result.status, 'accepted', r.text);
    assert.strictEqual(r.report.scope, 'candidate');
    assert.strictEqual(r.report.scopeLabel, 'candidate-selected');
    assert.strictEqual(r.report.baseRef, 'HEAD');
    assert.strictEqual(r.report.selectedCount, 1);
    assert.strictEqual(r.report.deferredCount, 3);
    assert.match(r.text, /CANDIDATE-SELECTED against HEAD/);
    assert.match(r.text, /deferred 3 \(NOT proven by this run\)/);
    assert.match(r.text, /ACCEPTED \(candidate-selected: the selected mutations only\)/);
    assert.strictEqual(r.exec.count('mutation'), 1);
    assert.strictEqual(r.exec.count('control-pre'), 1);
    const need = (scope) => ev.verifyReport(r.result.reportFile, { expectedScope: scope });
    assert.strictEqual(need('candidate').ok, true);
    assert.match(need('exhaustive').reason, /candidate-selected report, not a exhaustive one/);
    assert.match(need('nonsense').reason, /not one of candidate, exhaustive/);
    assert.match(need(undefined).reason, /not one of/);
  });

  await check('a plan selects, identifies and costs, then stops: no process, no worker copy, no source change, and it is not acceptance', async () => {
    const root = makeRepo();
    const before = ev.sourceManifest(root);
    const r = await run(root, { planOnly: true });
    assert.strictEqual(r.exec.calls.length, 0, 'nothing was run');
    assert.strictEqual(r.result.status, 'plan');
    assert.strictEqual(r.result.exitCode, 0);
    assert.ok(path.basename(r.result.reportFile) === 'plan.json');
    assert.ok(!fs.existsSync(path.join(r.artifacts, 'work')) && !fs.existsSync(path.join(r.artifacts, 'events.jsonl')) && !fs.existsSync(path.join(r.artifacts, 'report.json')));
    assert.deepStrictEqual(ev.sourceManifest(root), before);
    assert.strictEqual(r.report.plan.selectedCount, 4);
    assert.strictEqual(r.report.plan.estimatedMs, null, 'cold start: the cost is unknown, not guessed');
    assert.match(r.report.plan.estimateBasis, /unavailable: 3 of 3 job\(s\) have no history/);
    assert.match(r.text, /PLAN ONLY: nothing was run/);
    assert.ok(r.report.plan.jobs.some((j) => j.id === 'run-tests.js') && r.report.warnings.some((w) => /FULL regression/.test(w)));
    assert.strictEqual(ev.verifyReport(r.result.reportFile, { expectedScope: 'exhaustive' }).ok, false, 'a plan is never an accepted report');
    // A real run may reuse the directory that holds only the plan.
    const full = await run(root, { artifacts: r.artifacts });
    assert.strictEqual(full.result.status, 'accepted', full.text);
  });

  await check('with measured history the plan estimates, and a missing or corrupt history only warns and changes nothing selected', async () => {
    const root = makeRepo();
    const hist = path.join(TMP, `hist-${(serial += 1)}.json`);
    fs.writeFileSync(hist, JSON.stringify({ schemaVersion: 1, groups: {
      'calc-unit.js': { controlMs: 100, mutationMs: 10 }, 'other-unit.js': { controlMs: 100, mutationMs: 10 }, 'run-tests.js': { controlMs: 0, mutationMs: 1000 },
    } }));
    const warm = await run(root, { planOnly: true, historyFile: hist });
    assert.strictEqual(warm.report.plan.estimatedMs, (200 + 20) + (200 + 10) + 1000);
    assert.strictEqual(warm.report.plan.estimateBasis, 'measured history');
    assert.deepStrictEqual(warm.report.plan.jobs.map((j) => j.id), ['run-tests.js', 'calc-unit.js', 'other-unit.js'], 'longest measured first');
    fs.writeFileSync(hist, '{ not json');
    const corrupt = await run(root, { planOnly: true, historyFile: hist });
    assert.strictEqual(corrupt.result.status, 'plan');
    assert.ok(corrupt.report.warnings.some((w) => /unreadable/.test(w)));
    const missing = await run(root, { planOnly: true, historyFile: path.join(TMP, 'nope.json') });
    assert.ok(missing.report.warnings.some((w) => /no timing history/.test(w)));
    assert.strictEqual(missing.report.plan.selectedCount, 4);
  });

  await check('an incomplete, inconsistent or empty selection is blocked before anything runs, never run as a smaller success', async () => {
    const cases = {
      'drops a mutation without accounting for it': [(p) => { p.selected.pop(); }, /accounts for 3 of 4 catalogue mutations/],
      'selects none and requires no suite': [(p) => { p.deferred = p.selected.map((s) => ({ id: s.id, index: s.index })); p.selected = []; }, /selects no mutations and requires no suite/],
      'defers under an exhaustive scope': [(p) => { const s = p.selected.pop(); p.deferred.push({ id: s.id, index: s.index }); }, /may not defer mutations, but 1 were/],
      'carries a stale id': [(p) => { p.selected[0].id = 'f'.repeat(64); }, /carries a stale id/],
      'selects a mutation twice': [(p) => { p.selected[1] = p.selected[0]; }, /selected twice/],
      'reports a blocked reason': [(p) => { p.blockedReasons.push('base ref unknown'); }, /policy blocked the plan: base ref unknown/],
      'has the wrong schema': [(p) => { p.schemaVersion = 2; }, /no schema 1 plan/],
      'answers for another scope': [(p) => { p.scope = 'candidate'; }, /planned scope "candidate", not the requested exhaustive/],
      'is missing a list': [(p) => { delete p.deferred; }, /plan\.deferred is not a list/],
    };
    for (const [label, [tweak, expected]] of Object.entries(cases)) {
      const r = await run(makeRepo(), { policy: withPlan((p) => { tweak(p); return p; }) });
      assert.strictEqual(r.exec.calls.length, 0, `${label}: nothing may run`);
      assert.strictEqual(r.result.status, 'blocked', label);
      assert.strictEqual(r.result.exitCode, 1, label);
      assert.ok(r.report.failures.some((f) => expected.test(f)), `${label}: ${r.report.failures.join(' | ')}`);
      assert.strictEqual(r.report.accepted, false);
    }
  });

  await check('an empty candidate selection that still requires a suite runs its control and is accepted only as controls; with no required suite it is blocked', async () => {
    const root = makeRepo();
    const r = await run(root, { scope: 'candidate', baseRef: 'HEAD', policy: withPlan(() => null, { select: [], requiredSuites: ['other-unit.js'] }) });
    assert.strictEqual(r.result.status, 'accepted', r.text);
    assert.strictEqual(r.report.controlsOnly, true);
    assert.strictEqual(r.exec.count('mutation'), 0);
    assert.strictEqual(r.exec.count('control-pre'), 1);
    assert.strictEqual(r.exec.count('baseline'), 2);
    assert.strictEqual(ev.verifyReport(r.result.reportFile, { expectedScope: 'candidate' }).ok, true);
    const none = await run(root, { scope: 'candidate', baseRef: 'HEAD', policy: withPlan(() => null, { select: [] }) });
    assert.strictEqual(none.result.status, 'blocked');
    assert.strictEqual(none.exec.calls.length, 0);
  });

  await check('bad options fail visibly: unknown scope, a candidate without a base, artifacts in or around the source, a reused directory, bad job counts', async () => {
    const root = makeRepo();
    const ok = { root, scope: 'exhaustive', artifacts: path.join(TMP, `art-${(serial += 1)}`), mutations: MUTS, suiteFor, policy };
    const bad = [
      [{ scope: 'everything' }, /--scope must be one of candidate, exhaustive/],
      [{ scope: undefined }, /--scope must be one of/],
      [{ scope: 'candidate' }, /needs --base <explicit Git ref>/],
      [{ scope: 'candidate', baseRef: '--all' }, /needs --base/],
      [{ artifacts: undefined }, /--artifacts .* is required/],
      [{ artifacts: path.join(root, 'out') }, /outside the source tree/],
      [{ artifacts: path.dirname(root) }, /outside the source tree/],
      [{ jobs: 0 }, /--jobs must be an integer from 1 to 64/],
      [{ jobs: 1.5 }, /--jobs must be an integer/],
      [{ jobs: 65 }, /--jobs must be an integer/],
    ];
    for (const [patch, re] of bad) {
      await assert.rejects(runAcceptance({ ...ok, ...patch, exec: spyExec(), heartbeatMs: 0, log() {} }), (e) => e instanceof UsageError && re.test(e.message), JSON.stringify(Object.keys(patch)));
    }
    assert.throws(() => normaliseOptions({ ...ok, artifacts: happy.artifacts }), (e) => e instanceof UsageError && /new or empty directory/.test(e.message), 'old logs and proofs cannot be mistaken for this run');
    assert.ok(!fs.existsSync(ok.artifacts), 'a refused run created nothing');
  });

  await check('a red baseline stops the run before any worker starts; zero tests, a skip, no summary, and a failing suite each read as red', async () => {
    const variants = { 'a failing suite': { calcBroken: true }, 'no summary': { summary: 'none' }, 'zero tests': { summary: 'zero' }, 'a skip': { summary: 'skipped' } };
    for (const [label, opts] of Object.entries(variants)) {
      const r = await run(makeRepo(opts));
      assert.strictEqual(r.result.status, 'rejected', label);
      assert.strictEqual(r.result.exitCode, 1);
      // Failing TESTS earn one more baseline run (a flake would go green); a
      // structural red (no summary, zero tests, a skip) is not retried.
      const expected = label === 'a failing suite' ? 2 : 1;
      assert.strictEqual(r.exec.calls.length, expected, `${label}: only the baseline ran (${expected}x)`);
      assert.ok(r.exec.calls.every((c) => c.kind === 'baseline'), `${label}: nothing but the baseline ran`);
      if (label === 'a failing suite') assert.ok(r.report.failures.some((f) => /failing: .*add adds/.test(f)), `${label}: the failure names the failing test: ${r.report.failures}`);
      assert.ok(!fs.existsSync(path.join(r.artifacts, 'work', 'w1')), 'no worker copy');
      assert.deepStrictEqual(r.report.outcomes, []);
      assert.ok(r.report.failures.some((f) => /the baseline is red/.test(f)), `${label}: ${r.report.failures}`);
      assert.strictEqual(r.report.accepted, false);
    }
  });

  await check('a mutant is accepted only when it completes nonzero on the NAMED test: escapes, wrong failures, missing anchors, timeouts and signals each have their own verdict', async () => {
    const calcName = (name, over) => ({ file: 'src/calc.js', name, find: 'a + b', replace: 'a - b', mustFail: 'add adds', ...over });
    const mutations = [
      calcName('wrong named test', { mustFail: 'mul multiplies' }),
      calcName('behaves the same', { replace: 'b + a' }),
      calcName('anchor is gone', { find: 'text that is not there' }),
      calcName('times out despite a status', { replace: 'a - b /*t1*/' }),
      calcName('killed despite a status', { replace: 'a - b /*s1*/' }),
      calcName('exits zero despite a failure', { replace: 'a - b /*z1*/' }),
      calcName('caught'),
    ];
    const exec = spyExec({
      after: (call, r) => {
        if (call.kind !== 'mutation') return null;
        const src = read(path.join(call.cwd, 'src', 'calc.js'));
        if (src.includes('/*t1*/')) return { ...r, timedOut: true };
        if (src.includes('/*s1*/')) return { ...r, signal: 'SIGTERM' };
        if (src.includes('/*z1*/')) return { ...r, code: 0 };
        return null;
      },
    });
    const root = makeRepo();
    const before = ev.sourceManifest(root);
    const r = await run(root, { mutations, exec, suiteFor: () => 'calc-unit.js', policy: { mutationId: policy.mutationId, planAcceptance: (a) => policy.planAcceptance({ ...a, mutations }) } });
    assert.strictEqual(r.result.status, 'rejected');
    assert.strictEqual(r.result.exitCode, 1);
    assert.deepStrictEqual(verdicts(r), {
      'wrong named test': 'imprecise', 'behaves the same': 'escaped', 'anchor is gone': 'anchor',
      'times out despite a status': 'error', 'killed despite a status': 'error', 'exits zero despite a failure': 'error', caught: 'caught',
    });
    const reason = (n) => r.report.outcomes.find((x) => x.name === n).reason;
    assert.match(reason('times out despite a status'), /timed out/);
    assert.match(reason('killed despite a status'), /killed by SIGTERM/);
    assert.match(reason('exits zero despite a failure'), /exited 0 while its summary reports 1 failed/);
    assert.deepStrictEqual(r.report.tally, { imprecise: 1, escaped: 1, anchor: 1, error: 3, caught: 1 }, 'errors are counted on their own, not folded into catches');
    assert.match(r.text, /NOT ACCEPTED: 6 of 7 selected mutations were not caught/);
    assert.strictEqual(ev.verifyReport(r.result.reportFile, { expectedScope: 'exhaustive' }).ok, false);
    assert.deepStrictEqual(ev.sourceManifest(root), before);
  });

  await check('a failed clean control invalidates the whole group: no verdict from before a red control, none kept after one', async () => {
    const hook = (which) => spyExec({ after: (call, r) => (call.kind === which && call.suite === 'calc-unit.js' ? { ...r, code: 1 } : null) });
    const pre = await run(makeRepo(), { exec: hook('control-pre') });
    assert.strictEqual(pre.result.status, 'rejected');
    assert.strictEqual(verdicts(pre)['add mutant'], 'error');
    assert.match(pre.report.outcomes.find((x) => x.name === 'add mutant').reason, /clean control before this group is not green/);
    assert.strictEqual(pre.report.outcomes.filter((x) => x.notRun).length, 2, 'the group was not run at all');
    assert.strictEqual(verdicts(pre)['greet mutant'], 'caught', 'an unrelated group keeps its verdict');
    const post = await run(makeRepo(), { exec: hook('control-post') });
    assert.strictEqual(post.result.status, 'rejected');
    assert.deepStrictEqual([verdicts(post)['add mutant'], verdicts(post)['mul mutant']], ['error', 'error']);
    assert.strictEqual(post.report.outcomes.find((x) => x.name === 'add mutant').observed, 'caught', 'the discarded verdict is kept for diagnosis');
    assert.ok(post.report.controls.some((c) => !c.ok && c.phase === 'post'));
  });

  await check('a clean control whose tests fail once and pass on the retry keeps its group, and the report says it was flaky', async () => {
    const clean = await run(makeRepo());
    let reds = 0;
    const flaky = spyExec({ after: (call, r) => {
      if (call.kind !== 'control-pre' || call.suite !== 'calc-unit.js' || reds >= 1) return null;
      reds += 1;
      return { ...r, code: 1, out: `${r.out}RESULT\tfail\tadd adds\twrong\n` };
    } });
    const r = await run(makeRepo(), { exec: flaky });
    assert.strictEqual(reds, 1, 'the control was made red exactly once');
    assert.strictEqual(r.exec.calls.filter((c) => c.kind === 'control-pre' && c.suite === 'calc-unit.js').length, 2, 'the red control was run once more');
    assert.strictEqual(r.result.status, clean.result.status, 'one flaky control no longer costs the run');
    assert.deepStrictEqual(verdicts(r), verdicts(clean), 'the group keeps its verdicts');
    assert.ok(r.report.controls.every((c) => c.ok), 'only the green retry is recorded as the control');
    assert.ok(r.report.warnings.some((w) => /flaky control: .*calc-unit\.js pre was red .*add adds.* and green on retry/.test(w)), r.report.warnings.join('|'));
    assert.match(r.text, /CONTROL RED, RETRYING ONCE/);
  });

  await check('a clean control whose tests fail twice still invalidates its group', async () => {
    const red = spyExec({ after: (call, r) => (call.kind === 'control-pre' && call.suite === 'calc-unit.js' ? { ...r, code: 1, out: `${r.out}RESULT\tfail\tadd adds\twrong\n` } : null) });
    const r = await run(makeRepo(), { exec: red });
    assert.strictEqual(r.exec.calls.filter((c) => c.kind === 'control-pre' && c.suite === 'calc-unit.js').length, 2, 'retried once, not more');
    assert.strictEqual(r.result.status, 'rejected');
    assert.strictEqual(verdicts(r)['add mutant'], 'error');
    assert.ok(!r.report.warnings.some((w) => /flaky control/.test(w)), 'a control red twice is not reported as flaky');
  });

  await check('a baseline whose tests fail once and pass on the retry lets the run go on, and the report says it was flaky', async () => {
    const clean = await run(makeRepo());
    let reds = 0;
    const flaky = spyExec({ after: (call, r) => {
      if (call.kind !== 'baseline' || reds >= 1) return null;
      reds += 1;
      return { ...r, code: 1, out: r.out.replace(/  ok   add adds/, '  FAIL add adds').replace(/(\d+) passed, 0 failed/, (m, p) => `${Number(p) - 1} passed, 1 failed`) };
    } });
    const r = await run(makeRepo(), { exec: flaky });
    assert.strictEqual(reds, 1);
    assert.strictEqual(r.exec.count('baseline'), clean.exec.count('baseline') + 1, 'the initial baseline ran once more');
    assert.strictEqual(r.result.status, clean.result.status);
    assert.ok(r.report.warnings.some((w) => /flaky baseline: .*add adds.* green on retry/.test(w)), r.report.warnings.join('|'));
    assert.strictEqual(r.report.proofs.filter((p) => p.label === 'initial').length, 1, 'only the green baseline is kept as the proof');
  });

  await check('source drift is rejected wherever it happens: the caller during the baseline, the baseline copy, a worker, and live mutation text', async () => {
    const callerRoot = makeRepo();
    const callerEdit = await run(callerRoot, { exec: spyExec({ after: (call) => { if (call.kind === 'baseline') fs.appendFileSync(path.join(callerRoot, 'src', 'greet.js'), '// edited during the baseline\n'); } }) });
    assert.strictEqual(callerEdit.result.status, 'rejected');
    assert.ok(callerEdit.report.failures.some((f) => /the source tree changed during the run: changed: src\/greet\.js/.test(f)), callerEdit.report.failures.join('|'));
    assert.strictEqual(callerEdit.exec.count('mutation'), 0, 'no mutant ran on a baseline that was not of this source');

    const own = await run(makeRepo(), { exec: spyExec({ after: (call) => { if (call.kind === 'baseline') fs.writeFileSync(path.join(call.cwd, 'left-behind.txt'), 'x'); } }) });
    assert.strictEqual(own.result.status, 'rejected');
    assert.ok(own.report.failures.some((f) => /the baseline changed its own source copy: added: left-behind\.txt/.test(f)));

    const stray = await run(makeRepo(), { exec: spyExec({ before: (call) => { if (call.kind === 'mutation') fs.writeFileSync(path.join(call.cwd, 'stray.txt'), 'x'); } }) });
    assert.strictEqual(stray.result.status, 'rejected');
    assert.ok(stray.report.failures.some((f) => /worker 1 drifted after .*added: stray\.txt/.test(f)), stray.report.failures.join('|'));
    assert.ok(stray.report.outcomes.some((x) => /no longer matches the source/.test(x.reason)));
    assert.strictEqual(stray.report.outcomes.filter((x) => x.verdict === 'caught').length < 4, true, 'a drifted worker discards its verdicts');

    const liveRoot = makeRepo();
    fs.writeFileSync(path.join(liveRoot, 'src', 'greet.js'), "module.exports = { hi: () => 'yo' }; // MUTATION\n");
    const live = await run(liveRoot);
    assert.strictEqual(live.result.status, 'rejected');
    assert.ok(live.report.failures.some((f) => /live mutation text is present in the source tree: src\/greet\.js/.test(f)));
    assert.strictEqual(live.exec.calls.length, 0);
  });

  await check('uncommitted edits and untracked files are part of the identity: copies match the dirty tree, not just HEAD', async () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'src', 'extra.js'), 'module.exports = 1;\n');
    fs.appendFileSync(path.join(root, 'src', 'greet.js'), '// dirty edit\n');
    fs.rmSync(path.join(root, 'test', 'other-unit.js'));
    const manifest = ev.sourceManifest(root);
    assert.ok(manifest.files.some((f) => f.path === 'src/extra.js'));
    assert.ok(manifest.files.some((f) => f.path === 'test/other-unit.js' && f.sha256 === null), 'a deleted tracked file is a recorded deletion');
    const r = await run(root, { policy: withPlan(() => null, { select: [0, 1, 3] }), scope: 'candidate', baseRef: 'HEAD' });
    assert.strictEqual(r.result.status, 'accepted', r.text);
    assert.strictEqual(r.report.manifestDigest, manifest.digest);
    assert.strictEqual(ev.sourceManifest(path.join(r.artifacts, 'work', 'w1')).digest, manifest.digest);
    assert.ok(fs.existsSync(path.join(r.artifacts, 'work', 'w1', 'src', 'extra.js')));
    assert.ok(!fs.existsSync(path.join(r.artifacts, 'work', 'w1', 'test', 'other-unit.js')));
    assert.strictEqual(r.report.runtimeDigest.length, 64);
  });

  await check('cancellation kills only the runner\'s own processes, is reported incomplete, runs no final baseline, and is never accepted', async () => {
    const ac = new AbortController();
    const exec = spyExec({
      before: (call, spec) => {
        if (call.kind !== 'mutation') return;
        spec.env = { ...spec.env, ACC_SLOW: '1' };
        setTimeout(() => ac.abort(), 600);
      },
    });
    const started = Date.now();
    const r = await run(makeRepo(), { exec, signal: ac.signal });
    assert.ok(Date.now() - started < 25000, 'the hung mutant was killed, not waited for');
    assert.strictEqual(r.result.status, 'incomplete');
    assert.strictEqual(r.result.exitCode, 130);
    assert.strictEqual(r.report.accepted, false);
    assert.strictEqual(r.report.incomplete, true);
    assert.strictEqual(ownedCount(), 0, 'no process of ours is left');
    assert.strictEqual(r.exec.count('baseline'), 1, 'no final baseline after a cancel');
    assert.strictEqual(r.report.outcomes.length, 4, 'every selected mutation is accounted for');
    assert.ok(r.report.outcomes.every((x) => x.verdict === 'error'), JSON.stringify(verdicts(r)));
    assert.ok(r.report.outcomes.some((x) => /cancelled/.test(x.reason)));
    assert.match(r.text, /INCOMPLETE: cancelled; nothing is accepted/);
    assert.strictEqual(ev.verifyReport(r.result.reportFile, { expectedScope: 'exhaustive' }).ok, false);
    assert.ok(readEvents(r.artifacts).some((e) => e.event === 'cancel'));
  });

  await check('a run cancelled before it starts is incomplete without running a baseline', async () => {
    const ac = new AbortController(); ac.abort();
    const r = await run(makeRepo(), { signal: ac.signal, exec: spyExec() });
    assert.notStrictEqual(r.result.status, 'accepted');
    assert.strictEqual(r.report.accepted, false);
  });

  await check('a baseline is reused only after its source, runtime and log are checked again; stale, edited and corrupt proofs are refused', async () => {
    const proof = path.join(happy.artifacts, 'baseline', 'initial-proof.json');
    const reuse = await run(happyRoot, { reuseBaseline: { proof } });
    assert.strictEqual(reuse.result.status, 'accepted', reuse.text);
    assert.strictEqual(reuse.exec.count('baseline'), 1, 'only the final baseline ran');
    assert.match(reuse.text, /baseline: REUSED after re-validating/);
    assert.ok(reuse.report.controls.some((c) => c.reused));

    const refuse = async (mutate, re, label) => {
      const dir = path.join(TMP, `copy-${(serial += 1)}`);
      fs.cpSync(happy.artifacts, dir, { recursive: true });
      mutate(dir);
      const r = await run(happyRoot, { reuseBaseline: { proof: path.join(dir, 'baseline', 'initial-proof.json') } });
      assert.strictEqual(r.result.status, 'rejected', label);
      assert.ok(r.report.failures.some((f) => re.test(f)), `${label}: ${r.report.failures}`);
      assert.strictEqual(r.exec.calls.length, 0, `${label}: nothing ran on a proof that was not good`);
    };
    const proofLog = (dir) => path.join(dir, JSON.parse(read(path.join(dir, 'baseline', 'initial-proof.json'))).log.path);
    await refuse((d) => fs.appendFileSync(proofLog(d), '\n999 passed, 0 failed  (1s)\n'), /log no longer matches the recorded digest/, 'edited log');
    await refuse((d) => fs.writeFileSync(path.join(d, 'baseline', 'initial-proof.json'), '{ nope'), /unreadable or corrupt/, 'corrupt proof');
    await refuse((d) => { const f = path.join(d, 'baseline', 'initial-proof.json'); const p = JSON.parse(read(f)); p.verdict.passed = 99999; fs.writeFileSync(f, JSON.stringify(p)); }, /digest does not match its content/, 'edited proof');
    await refuse((d) => fs.rmSync(proofLog(d)), /its log is missing/, 'missing log');
    await refuse((d) => { const f = path.join(d, 'baseline', 'initial-proof.json'); const p = JSON.parse(read(f)); p.log.path = '../../outside.log'; fs.writeFileSync(f, JSON.stringify(p)); }, /digest does not match|leaves the artifact directory/, 'escaping log path');

    fs.appendFileSync(path.join(happyRoot, 'src', 'greet.js'), '// drift after the proof was made\n');
    const stale = await run(happyRoot, { reuseBaseline: { proof }, policy: withPlan(() => null) });
    assert.strictEqual(stale.result.status, 'rejected');
    assert.ok(stale.report.failures.some((f) => /different source: the tree drifted or the proof is stale/.test(f)));
    assert.strictEqual(stale.exec.calls.length, 0);
    fs.writeFileSync(path.join(happyRoot, 'src', 'greet.js'), GREET);
  });

  await check('heartbeats report completed/total, the active step and an honest ETA, and are recorded as events', async () => {
    const exec = spyExec({ before: async () => new Promise((r) => setTimeout(r, 150)) });
    const r = await run(makeRepo(), { exec, heartbeatMs: 120 });
    assert.strictEqual(r.result.status, 'accepted', r.text);
    const beats = r.logs.filter((l) => l.startsWith('heartbeat '));
    assert.ok(beats.length >= 2, `${beats.length} heartbeats`);
    assert.ok(beats.every((b) => /^heartbeat \d+\/4 mutations done; active: .+; ETA (warming-up|unknown|~)/.test(b)), beats.join('\n'));
    assert.ok(beats.some((b) => /ETA warming-up/.test(b)), 'the first beats have measured nothing and say so');
    assert.ok(readEvents(r.artifacts).filter((e) => e.event === 'heartbeat').length >= 2);
  });

  await check('the CLI parses strictly: unknown, repeated and valueless arguments and bad job counts fail instead of being guessed at', () => {
    const p = cli.parseArgs(['--scope', 'candidate', '--base', 'origin/main', '--artifacts', 'out', '--jobs', '3', '--plan']);
    assert.deepStrictEqual(p.options, { scope: 'candidate', base: 'origin/main', artifacts: 'out', jobs: 3, plan: true });
    assert.deepStrictEqual(cli.parseArgs(['-h']).options, { help: true });
    for (const [argv, re] of [
      [['--bogus'], /unknown argument "--bogus"/],
      [['--scope'], /--scope needs a value/],
      [['--scope', '--plan'], /--scope needs a value/],
      [['--scope', 'candidate', '--scope', 'exhaustive'], /more than once/],
      [['--plan', '--plan'], /more than once/],
      [['--jobs', 'four'], /--jobs must be a positive integer/],
      [['--jobs', '0'], /--jobs must be a positive integer/],
      [['positional'], /unknown argument/],
    ]) assert.match(cli.parseArgs(argv).error, re, argv.join(' '));
  });

  await check('the CLI exit codes: help 0, bad arguments 2, usage errors 2, a rejected run 1, an incomplete run 130, and no scope is ever guessed', async () => {
    const out = [];
    const log = (...a) => out.push(a.join(' '));
    assert.strictEqual(await cli.main(['--help'], { log }), 0);
    assert.match(out.join('\n'), /Usage:[\s\S]*--scope candidate --base <git ref> --artifacts <dir>/);
    assert.strictEqual(await cli.main(['--nope'], { log }), 2);
    assert.strictEqual(await cli.main([], { log }), 2, 'no scope');
    assert.match(out.join('\n'), /--scope must be one of candidate, exhaustive/);
    assert.strictEqual(await cli.main(['--scope', 'candidate', '--artifacts', path.join(TMP, 'cli-a')], { log }), 2, 'candidate without --base');
    const seen = [];
    for (const [code, expected] of [[0, 0], [1, 1], [130, 130]]) {
      const got = await cli.main(['--scope', 'candidate', '--base', 'main', '--artifacts', 'a', '--jobs', '2', '--plan', '--history', 'h.json'], {
        log, runAcceptance: async (o) => { seen.push(o); return { exitCode: code }; },
      });
      assert.strictEqual(got, expected);
    }
    assert.strictEqual(seen[0].scope, 'candidate');
    assert.strictEqual(seen[0].baseRef, 'main');
    assert.strictEqual(seen[0].jobs, 2);
    assert.strictEqual(seen[0].planOnly, true);
    assert.strictEqual(seen[0].historyFile, 'h.json');
    assert.ok(seen[0].signal && typeof seen[0].signal.aborted === 'boolean');
    assert.strictEqual(await cli.main(['--scope', 'exhaustive', '--artifacts', 'a'], { log, runAcceptance: async () => { throw new Error('the policy exploded'); } }), 1);
    assert.match(out.join('\n'), /REJECTED: the policy exploded/);
  });

  await check('the CLI verifies a finished report for the scope it is asked about and for THIS tree', async () => {
    const out = [];
    const log = (...a) => out.push(a.join(' '));
    const report = happy.result.reportFile;
    assert.strictEqual(await cli.main(['--verify', report, '--scope', 'exhaustive'], { log, root: happyRoot }), 0);
    assert.match(out.pop(), /VERIFIED: .* intact exhaustive acceptance report/);
    assert.strictEqual(await cli.main(['--verify', report, '--scope', 'candidate'], { log, root: happyRoot }), 1);
    assert.match(out.pop(), /exhaustive report, not a candidate-selected one/);
    assert.strictEqual(await cli.main(['--verify', report], { log, root: happyRoot }), 2, 'the scope must be named');
    fs.appendFileSync(path.join(happyRoot, 'src', 'calc.js'), '// a later edit\n');
    assert.strictEqual(await cli.main(['--verify', report, '--scope', 'exhaustive'], { log, root: happyRoot }), 1);
    assert.match(out.pop(), /made for different source/);
    fs.writeFileSync(path.join(happyRoot, 'src', 'calc.js'), CALC);
    const forged = path.join(TMP, 'forged.json');
    const doc = JSON.parse(read(report)); doc.outcomes[0].verdict = 'escaped';
    fs.writeFileSync(forged, JSON.stringify(doc));
    assert.strictEqual(await cli.main(['--verify', forged, '--scope', 'exhaustive'], { log, root: happyRoot }), 1);
    assert.match(out.pop(), /digest does not match its content/);
  });

  await check('node test/acceptance.js --help runs standalone, without the policy or browser helpers', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'acceptance.js'), '--help'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /--scope <candidate\|exhaustive>/);
    const bad = spawnSync(process.execPath, [path.join(__dirname, 'acceptance.js'), '--scope', 'candidate'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(bad.status, 2);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
