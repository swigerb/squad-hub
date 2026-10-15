'use strict';
/**
 * Grouping, scheduling and progress for the acceptance runner
 * (test/helpers/acceptance-schedule.js): where a mutation runs, how the work is
 * cut into jobs and ordered, and what the progress line may honestly claim.
 *
 * Everything here is pure or driven by an injected clock, so nothing runs a
 * suite.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('./helpers/acceptance-schedule');

let pass = 0; let fail = 0;
function check(name, fn) {
  const done = (e) => {
    if (!e) { pass += 1; console.log(`  ok   ${name}`); console.log(`RESULT\tok\t${name}`); return; }
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => done(), done);
  } catch (e) { done(e); return undefined; }
  done();
  return undefined;
}

const entry = (index, suite, mustFail = `test ${index}`) => ({
  id: `id${String(index).padStart(4, '0')}`, index, suite, reasons: [], mutation: { name: `m${index}`, file: 'src/x.js', mustFail },
});
const range = (from, n, suite) => Array.from({ length: n }, (_, i) => entry(from + i, suite));
const ids = (jobs) => jobs.flatMap((j) => j.entries.map((e) => e.id)).sort();

(async () => {
  await check('placement: a suite stays a suite; no suite, or run-tests.js, is the visible full-regression fallback', () => {
    assert.deepStrictEqual(
      (({ key, kind, args }) => ({ key, kind, args }))(S.placeEntry(entry(1, 'a-unit.js'))),
      { key: 'a-unit.js', kind: 'suite', args: ['test/a-unit.js'] },
    );
    for (const suite of [null, undefined, 'run-tests.js']) {
      const p = S.placeEntry(entry(1, suite));
      assert.strictEqual(p.kind, 'full');
      assert.strictEqual(p.key, 'run-tests.js');
    }
  });

  await check('placement: a browser title with a scenario runs only that scenario; one without runs the whole browser suite', () => {
    const b = entry(1, S.BROWSER_SUITE, 'drag works');
    const p = S.placeEntry(b, (title) => (title === 'drag works' ? { id: 'drag' } : null));
    assert.strictEqual(p.kind, 'scenario');
    assert.strictEqual(p.key, `${S.BROWSER_SUITE}#drag`);
    assert.deepStrictEqual(p.args, [`test/${S.BROWSER_SUITE}`, '--scenario', 'drag']);
    assert.strictEqual(S.placeEntry(entry(2, S.BROWSER_SUITE, 'unknown'), () => null).kind, 'suite', 'unknown is the whole suite');
    assert.strictEqual(S.placeEntry(b, () => { throw new Error('ambiguous'); }).kind, 'suite', 'a throwing resolver is not a scenario');
    assert.strictEqual(S.placeEntry(b, undefined).kind, 'suite');
    assert.strictEqual(S.placeEntry(entry(3, 'a-unit.js'), () => ({ id: 'x' })).kind, 'suite', 'only the browser suite has scenarios');
  });

  await check('groups come out in key order with entries in catalogue order, whatever the input order', () => {
    const sel = [entry(5, 'b-unit.js'), entry(2, 'a-unit.js'), entry(9, 'b-unit.js'), entry(1, null), entry(7, 'a-unit.js')];
    const g = S.buildGroups(sel, null);
    assert.deepStrictEqual(g.map((x) => x.key), ['a-unit.js', 'b-unit.js', 'run-tests.js']);
    assert.deepStrictEqual(g[0].entries.map((e) => e.index), [2, 7]);
    assert.deepStrictEqual(S.buildGroups([...sel].reverse(), null).map((x) => [x.key, x.entries.map((e) => e.index)]), g.map((x) => [x.key, x.entries.map((e) => e.index)]));
  });

  await check('chunking never loses or duplicates a mutation, and never cuts the full-suite group or a single-worker run', () => {
    const sel = [...range(0, 130, 'big-unit.js'), ...range(130, 5, 'small-unit.js'), ...range(135, 3, null)];
    const groups = S.buildGroups(sel, null);
    for (const workers of [1, 2, 4, 8]) {
      const jobs = S.buildJobs(groups, { jobs: workers, maxChunk: 40 });
      assert.deepStrictEqual(ids(jobs), sel.map((e) => e.id).sort(), `lossless at ${workers} workers`);
      assert.strictEqual(new Set(jobs.map((j) => j.id)).size, jobs.length, 'job ids are unique');
      const full = jobs.filter((j) => j.kind === 'full');
      assert.strictEqual(full.length, 1, 'the full group is one job');
      assert.strictEqual(full[0].controlsFromBaseline, true);
      if (workers === 1) assert.strictEqual(jobs.filter((j) => j.key === 'big-unit.js').length, 1);
      else assert.ok(jobs.filter((j) => j.key === 'big-unit.js').every((j) => j.entries.length <= 40));
    }
    assert.ok(S.buildJobs(groups, { jobs: 4 }).filter((j) => j.key === 'big-unit.js').length >= 4, '130 mutations over 4 workers are cut');
  });

  await check('jobs are ordered longest measured first, ties by id, independent of input order', () => {
    const history = { 'a-unit.js': { controlMs: 1000, mutationMs: 100 }, 'b-unit.js': { controlMs: 1000, mutationMs: 5000 }, 'c-unit.js': { controlMs: 1000, mutationMs: 100 } };
    const sel = [entry(1, 'a-unit.js'), entry(2, 'b-unit.js'), entry(3, 'c-unit.js')];
    const a = S.buildJobs(S.buildGroups(sel, null), { jobs: 1, history });
    const b = S.buildJobs(S.buildGroups([...sel].reverse(), null), { jobs: 1, history });
    assert.deepStrictEqual(a.map((j) => j.id), ['b-unit.js', 'a-unit.js', 'c-unit.js']);
    assert.deepStrictEqual(a.map((j) => j.id), b.map((j) => j.id));
    assert.deepStrictEqual(S.orderJobs([{ id: 'z', estimateMs: 5 }, { id: 'a', estimateMs: 5 }, { id: 'm', estimateMs: 9 }]).map((j) => j.id), ['m', 'a', 'z']);
  });

  await check('missing history changes order and estimates only: the same mutations are selected either way, and unknown cost is never shown as a number', () => {
    const sel = [...range(0, 70, 'a-unit.js'), ...range(70, 3, 'b-unit.js'), ...range(73, 2, S.BROWSER_SUITE)];
    const groups = S.buildGroups(sel, () => ({ id: 'scn' }));
    const cold = S.buildJobs(groups, { jobs: 3 });
    const warm = S.buildJobs(groups, { jobs: 3, history: { 'a-unit.js': { controlMs: 10, mutationMs: 10 } } });
    assert.deepStrictEqual(ids(cold), ids(warm));
    assert.deepStrictEqual(ids(cold), sel.map((e) => e.id).sort());
    assert.ok(cold.every((j) => j.estimateKnown === false), 'no history means no known estimate');
    assert.ok(warm.some((j) => j.estimateKnown) && warm.some((j) => !j.estimateKnown));
    assert.ok(cold.find((j) => j.kind === 'scenario'), 'a scenario job exists');
  });

  await check('the pool runs every job once, never exceeds its width, takes jobs in order, and records a crash without losing the rest', async () => {
    const jobs = Array.from({ length: 9 }, (_, i) => ({ id: `j${i}` }));
    let inFlight = 0; let peak = 0; const started = [];
    const results = await S.runPool(jobs, 3, async (job) => {
      started.push(job.id); inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      if (job.id === 'j4') throw new Error('boom');
      return job.id;
    });
    assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
    assert.deepStrictEqual([...started].sort(), jobs.map((j) => j.id));
    assert.deepStrictEqual(started.slice(0, 3), ['j0', 'j1', 'j2']);
    assert.strictEqual(results.length, 9);
    assert.deepStrictEqual(results.filter((r) => r.error).map((r) => [r.job.id, r.error.message]), [['j4', 'boom']]);
    let stop = false; const ran = [];
    await S.runPool(jobs, 1, async (job) => { ran.push(job.id); if (job.id === 'j1') stop = true; }, () => stop);
    assert.deepStrictEqual(ran, ['j0', 'j1'], 'a stop request prevents new jobs');
    assert.deepStrictEqual(await S.runPool([], 4, async () => 1), []);
  });

  await check('progress is warming-up before enough steps are measured, and says what is missing rather than inventing a rate', () => {
    let t = 0;
    const jobs = [{ id: 'a', key: 'a', entries: new Array(10).fill(0), controlsFromBaseline: false }];
    const p = S.createProgress({ jobs, totalMutations: 10, now: () => t, workers: 1 });
    assert.strictEqual(p.eta().state, 'warming-up');
    assert.strictEqual(p.eta().etaMs, null);
    p.startJob('a'); p.controlDone('a', 'a', 1000); p.mutationDone('a', 'a', 500);
    const e = p.eta();
    assert.strictEqual(e.state, 'warming-up');
    assert.strictEqual(e.etaMs, null);
    assert.match(e.basis, /1\/3 measured/);
    assert.strictEqual(p.completed(), 1);
    assert.match(S.heartbeatLine({ completed: 1, total: 10, active: [{ worker: 1, label: 'a: x', elapsedMs: 4000 }], eta: e }), /1\/10 mutations done; active: w1 a: x 4s; ETA warming-up/);
  });

  await check('progress is unknown when mutants are measured but a remaining step has no measurement or history', () => {
    const jobs = [{ id: 'a', key: 'a', entries: new Array(6).fill(0), controlsFromBaseline: false }];
    const p = S.createProgress({ jobs, totalMutations: 6, now: () => 0, workers: 1 });
    p.startJob('a');
    for (let i = 0; i < 3; i += 1) p.mutationDone('a', 'a', 100);
    const e = p.eta();
    assert.strictEqual(e.state, 'unknown', JSON.stringify(e));
    assert.strictEqual(e.etaMs, null);
  });

  await check('progress estimates only from measurements or history, uses live measurements over history, and ends at zero', () => {
    const history = { k: { controlMs: 100, mutationMs: 10 } };
    const jobs = [{ id: 'k', key: 'k', entries: new Array(5).fill(0), controlsFromBaseline: false }];
    const p = S.createProgress({ jobs, totalMutations: 5, history, now: () => 0, workers: 1 });
    assert.deepStrictEqual((({ state, etaMs }) => ({ state, etaMs }))(p.eta()), { state: 'estimate', etaMs: 5 * 10 + 2 * 100 });
    p.startJob('k'); p.controlDone('k', 'k', 300);
    for (let i = 0; i < 3; i += 1) p.mutationDone('k', 'k', 40);
    assert.strictEqual(p.eta().etaMs, 2 * 40 + 1 * 300, 'measured costs replace history');
    p.mutationAbandoned('k', 2); p.controlDone('k', 'k', 300); p.jobDone('k');
    assert.deepStrictEqual((({ state, etaMs }) => ({ state, etaMs }))(p.eta()), { state: 'estimate', etaMs: 0 });
    const w = S.createProgress({ jobs: [jobs[0], { id: 'k2', key: 'k', entries: new Array(5).fill(0), controlsFromBaseline: false }], totalMutations: 10, history, now: () => 0, workers: 2 });
    assert.strictEqual(w.eta().etaMs, Math.round(2 * (5 * 10 + 2 * 100) / 2), 'work is shared across workers');
  });

  await check('progress snapshots list what is running and for how long', () => {
    let t = 1000;
    const p = S.createProgress({ jobs: [], totalMutations: 0, now: () => t, workers: 2 });
    const a = p.begin(1, 'suite one'); p.begin(2, 'suite two');
    t = 6000; p.end(a);
    const s = p.snapshot();
    assert.deepStrictEqual(s.active, [{ worker: 2, label: 'suite two', detail: '', elapsedMs: 5000 }]);
  });

  await check('timings for the next run keep only groups that were measured for both controls and mutants', () => {
    const measured = new Map([
      ['a', { mutationMs: [100, 300], controlMs: [50, 150] }],
      ['b', { mutationMs: [10], controlMs: [] }],
      ['c', { mutationMs: [], controlMs: [10] }],
    ]);
    assert.deepStrictEqual(S.timingsFromRun(measured), { a: { controlMs: 100, mutationMs: 200, samples: 2 } });
    assert.strictEqual(S.fmtMs(null), 'n/a');
    assert.strictEqual(S.fmtMs(3723000), '1h02m');
    assert.strictEqual(S.fmtMs(65000), '1m05s');
  });

  check('child-suite markers from run-tests.js give active suite and measured seconds, and never a verdict', () => {
    const log = [
      'noise', '  [child-suite] start alpha-unit.js', '  [child-suite] end alpha-unit.js (12.3s)\r',
      '  [child-suite] start beta-unit.js', '  [child-suite] start gamma-unit.js', '  [child-suite] end gamma-unit.js (0.4s)',
    ].join('\n');
    const m = S.parseChildMarkers(log);
    assert.deepStrictEqual(m.finished, [{ label: 'alpha-unit.js', seconds: 12.3 }, { label: 'gamma-unit.js', seconds: 0.4 }]);
    assert.deepStrictEqual(m.running, ['beta-unit.js']);
    assert.deepStrictEqual(m.problems, []);
    const odd = S.parseChildMarkers('[child-suite] end ghost (1.0s)\n[child-suite] start a\n[child-suite] start a\n[child-suite] end a (2s)\n[child-suite] end a (2s)\n[child-suite] begin nothing\n');
    assert.strictEqual(odd.problems.length, 3, odd.problems.join(' | '));
    assert.deepStrictEqual(S.parseChildMarkers(undefined), { finished: [], running: [], problems: [] });
  });

  check('the markers run-tests.js really prints (indented) are the ones the parser reads', () => {
    const src = fs.readFileSync(path.join(__dirname, 'run-tests.js'), 'utf8');
    const start = /console\.log\(`(\s*\[child-suite\] start \$\{label\})`\)/.exec(src);
    const end = /console\.log\(`(\s*\[child-suite\] end \$\{label\} \()\$\{[^`]*?\}s\)`\)/.exec(src);
    assert.ok(start && end, 'run-tests.js no longer prints [child-suite] start/end lines');
    const label = 'sample-unit.js';
    const log = [start[1].replace('${label}', label), `${end[1].replace('${label}', label)}4.5s)`].join('\n');
    assert.match(log, /^ +\[child-suite\] start sample-unit\.js\n +\[child-suite\] end sample-unit\.js \(4\.5s\)$/, 'the real markers are indented; this guards the indentation the parser must accept');
    const m = S.parseChildMarkers(log);
    assert.deepStrictEqual(m.finished, [{ label, seconds: 4.5 }]);
    assert.deepStrictEqual(m.running, []);
  });

  check('a step annotation shows up in the heartbeat beside the measured elapsed time', () => {
    let t = 0;
    const progress = S.createProgress({ jobs: [], totalMutations: 0, now: () => t, workers: 1 });
    const token = progress.begin(0, 'initial baseline (full regression)');
    t = 5000;
    assert.ok(!/\[/.test(S.heartbeatLine(progress.snapshot())), 'no annotation until there is something to say');
    progress.annotate(token, 'child suite: alpha-unit.js');
    assert.match(S.heartbeatLine(progress.snapshot()), /w0 initial baseline \(full regression\) 5s \[child suite: alpha-unit\.js\]/);
    progress.annotate(9999, 'ignored');
    progress.end(token);
    assert.match(S.heartbeatLine(progress.snapshot()), /active: idle/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
