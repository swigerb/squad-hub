'use strict';
/**
 * What the mutation harness (test/mutate.js) makes of a run.
 *
 * The harness exists to say "this mechanism is tested", so every way a run can
 * go wrong must read as NOT tested rather than as a pass:
 *
 *   caught     the suite finished with a nonzero exit status and the test the
 *              catalogue NAMES is one of the tests that failed. Only this counts.
 *   escaped    the suite finished green. Nothing tests the mechanism.
 *   imprecise  the suite finished red but not on the named test. The mutant was
 *              stopped by something else, so the coverage claim is wrong.
 *   error      there is no verdict to read: the suite timed out, was killed,
 *              crashed before reporting a failing test, or contradicted itself.
 *   anchor     the text to mutate was not found, so the mutation never ran.
 *
 * Nothing but `caught` is accepted. The baseline is held to the same standard:
 * a run that executed nothing, or skipped a suite, proves nothing about the
 * mutants measured against it.
 *
 * These are pure functions over what the harness collected, so they can be
 * tested directly and mutated like any other module. They live here, and not in
 * test/mutate.js, because a mutation anchored in the harness would also match
 * its own catalogue entry.
 */

// The last line test/run-tests.js prints, e.g. "2909 passed, 0 failed  (494s)".
const SUMMARY = /^(\d+) passed, (\d+) failed(?:, (\d+) SKIPPED)?[ \t]+\(\d+s\)[ \t]*\r?$/gm;

/** Why a run has no exit status to read, or null when it finished. */
function unfinished(run) {
  if (Number.isInteger(run && run.code)) return null;
  if (run && run.error) return `the process did not finish: ${run.error.code || run.error.message}`;
  if (run && run.signal) return `the process was killed by ${run.signal}`;
  return 'the process did not finish (timed out, or never reported a status)';
}

/**
 * `{ ok, reason, passed, failed, skipped }` for a run of the UNMUTATED suite.
 *
 * ok only when it finished with status 0 and printed a summary that says tests
 * ran, none failed and none were skipped. A suite that skips (the browser
 * tests without Playwright, say) did not check what a mutant might break.
 */
function judgeBaseline(run) {
  const stop = unfinished(run);
  if (stop) return { ok: false, reason: stop };
  if (run.code !== 0) return { ok: false, reason: `the suite exited ${run.code}` };
  const all = [...String(run.out || '').matchAll(SUMMARY)];
  if (!all.length) return { ok: false, reason: 'the suite printed no "N passed, M failed" summary, so nothing says it ran' };
  const last = all[all.length - 1];
  const passed = Number(last[1]);
  const failed = Number(last[2]);
  const skipped = Number(last[3] || 0);
  const counts = { passed, failed, skipped };
  if (failed > 0) return { ok: false, reason: `${failed} test${failed === 1 ? '' : 's'} failed`, ...counts };
  if (skipped > 0) return { ok: false, reason: `${skipped} SKIPPED: a skipped test checked nothing, so the baseline proves nothing about it`, ...counts };
  if (passed === 0) return { ok: false, reason: 'the suite ran no tests', ...counts };
  return { ok: true, reason: '', ...counts };
}

/**
 * `{ verdict, reason }` for one mutant's run, given the test name it must fail.
 *
 * `run` is `{ code, signal, error, failed }`: the exit status (null unless the
 * process finished), and the names of the tests that printed a failure.
 */
function classify(run, mustFail) {
  if (typeof mustFail !== 'string' || !mustFail) {
    return { verdict: 'error', reason: 'the mutation names no test, so nothing could have caught it' };
  }
  const stop = unfinished(run);
  if (stop) return { verdict: 'error', reason: stop };
  const failed = Array.isArray(run.failed) ? run.failed : [];
  if (run.code === 0) {
    return failed.length
      ? { verdict: 'error', reason: `the suite exited 0 while reporting failures: ${failed.join(' | ')}` }
      : { verdict: 'escaped', reason: 'the suite stayed green' };
  }
  if (!failed.length) {
    return { verdict: 'error', reason: `the suite exited ${run.code} without failing any test: it crashed rather than caught the mutant` };
  }
  if (failed.some((f) => f.includes(mustFail))) return { verdict: 'caught', reason: '' };
  return { verdict: 'imprecise', reason: `the suite failed on: ${failed.join(' | ')}` };
}

/**
 * The run's totals and its exit status, from one `{ verdict }` per mutation.
 *
 * `expected` is how many mutations were selected, so a mutation that never
 * produced an outcome cannot be missed. `restore` is judgeBaseline's answer for
 * the suite re-run after the last mutation. Exit 0 only when every selected
 * mutation was caught and the source was restored to a clean baseline.
 */
function summarise(outcomes, restore, expected) {
  const tally = {};
  for (const o of outcomes) tally[o.verdict] = (tally[o.verdict] || 0) + 1;
  const caught = tally.caught || 0;
  const restoredOk = !!(restore && restore.ok);
  const complete = outcomes.length > 0 && outcomes.length === expected;
  const accepted = complete && caught === outcomes.length && restoredOk;
  return { applied: outcomes.length, caught, tally, complete, restoredOk, accepted, exitCode: accepted ? 0 : 1 };
}

module.exports = { judgeBaseline, classify, summarise };
