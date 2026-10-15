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

/**
 * Why a run has no exit status to read, or null when it finished.
 *
 * An error, a signal or a timeout disqualifies the run even when a status
 * integer is present: a runner that killed a process tree can see the OS report
 * an ordinary exit code for it, and that code says nothing about the suite.
 */
function unfinished(run) {
  if (run && run.error) return `the process did not finish: ${run.error.code || run.error.message}`;
  if (run && run.signal) return `the process was killed by ${run.signal}`;
  if (run && run.timedOut) return 'the process did not finish: it timed out and was stopped';
  if (run && run.cancelled) return 'the process did not finish: the run was cancelled';
  if (Number.isInteger(run && run.code)) return null;
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

// ---------------------------------------------------------------------------
// Output-level judgement for the acceptance runner (test/acceptance.js)
//
// The functions above take what a caller already parsed. These read the raw
// output of a child suite or of run-tests.js, so the runner and the quick probe
// reach the same verdicts from the same text instead of each keeping its own
// idea of "green".
// ---------------------------------------------------------------------------

// "5 passed, 0 failed", with an optional ", N skipped" and an optional "(12s)".
// Some suites prefix their own name ("required model: 5 passed, 0 failed").
const ANY_SUMMARY = /^(?:[^\n]*?: )?(\d+) passed, (\d+) failed(?:, (\d+) skipped)?(?:[ \t]+\(\d+s\))?[ \t]*\r?$/gim;

/** `[{ verdict, name, why }]` for every `RESULT\t<verdict>\t<name>[\t<why>]` line. */
function parseResults(out) {
  const results = [];
  for (const line of String(out || '').split('\n')) {
    if (!line.startsWith('RESULT\t')) continue;
    const parts = line.replace(/\r$/, '').split('\t');
    results.push({ verdict: parts[1], name: parts[2] || '', why: parts[3] || '' });
  }
  return results;
}

/** `{ passed, failed, skipped }` from the LAST summary line, or null when there is none. */
function parseSummary(out) {
  const all = [...String(out || '').matchAll(ANY_SUMMARY)];
  if (!all.length) return null;
  const [, passed, failed, skipped] = all[all.length - 1];
  return { passed: Number(passed), failed: Number(failed), skipped: Number(skipped || 0) };
}

/**
 * The names of the tests that failed, in the order they printed.
 *
 * A child suite reports through RESULT lines; run-tests.js prints `FAIL <name>`.
 * For a child suite the RESULT lines are the whole answer, because it also
 * prints a human `FAIL` line beside each one and counting both would double it.
 * A full regression's own `FAIL` lines are the answer there (see outputFormat).
 */
function failedNames(out) {
  if (outputFormat(out) === 'results') return parseResults(out).filter((r) => r.verdict === 'fail').map((r) => r.name);
  return printedLines(out, 'FAIL').map((l) => l.slice(5).trim());
}

/**
 * Which accounting an output follows. A full regression (run-tests.js) brackets
 * its child suites with `[child-suite]` markers and reports every test as an
 * `ok` / `FAIL` / `SKIP` line; its failure excerpts can quote a child's raw
 * RESULT lines, which are then not its own records. A child suite reports
 * through RESULT lines. `lines` is the full-regression style without markers.
 */
function outputFormat(out) {
  if (/^[ \t]*\[child-suite\] (?:start|end) /m.test(String(out || ''))) return 'full';
  return parseResults(out).length ? 'results' : 'lines';
}

/** Trimmed lines that start with `<word> ` (the human `ok` / `FAIL` / `SKIP` lines). */
function printedLines(out, word) {
  return String(out || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${word} `));
}

/**
 * The reason a summary cannot be true of the output it ends, or '' when the two
 * agree. A child suite's summary must equal its RESULT lines exactly, in all
 * three counts, and an unrecognised verdict is never a result. A full
 * regression's human lines are checked in the directions they can be trusted:
 * it prints one `FAIL` and one `SKIP` line for every failure and skip it
 * counts, and one `ok` line for every pass, though an excerpt of a child's
 * output can add lines, so it may not claim MORE passes than were printed.
 */
function summaryConflict(out, summary) {
  const format = outputFormat(out);
  if (format === 'results') {
    const results = parseResults(out);
    const unknown = results.find((r) => !['ok', 'fail', 'skip'].includes(r.verdict));
    if (unknown) return `unrecognised RESULT verdict "${unknown.verdict}"`;
    const count = (kind) => results.filter((r) => r.verdict === kind).length;
    const shown = { passed: count('ok'), failed: count('fail'), skipped: count('skip') };
    if (summary.failed !== shown.failed) {
      return summary.failed < shown.failed
        ? `the summary says ${summary.failed} failed but ${shown.failed} failures were printed: ${failedNames(out).join(' | ')}`
        : `the summary says ${summary.failed} failed but only ${shown.failed} failures were printed`;
    }
    if (summary.passed !== shown.passed || summary.skipped !== shown.skipped) {
      return `the summary (${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped) contradicts the ${results.length} results printed (${shown.passed} ok, ${shown.failed} fail, ${shown.skipped} skip)`;
    }
    return '';
  }
  const fails = printedLines(out, 'FAIL').length;
  const skips = printedLines(out, 'SKIP').length;
  const oks = printedLines(out, 'ok').length;
  if (summary.failed < fails) return `the summary says ${summary.failed} failed but ${fails} failures were printed: ${failedNames(out).join(' | ')}`;
  if (summary.failed > fails) return `the summary says ${summary.failed} failed but only ${fails} failures were printed`;
  if (summary.skipped !== skips) return `the summary says ${summary.skipped} skipped but ${skips} SKIP lines were printed`;
  if (summary.passed > oks) return `the summary says ${summary.passed} passed but only ${oks} ok lines were printed`;
  return '';
}

/**
 * `{ ok, reason, passed, failed, skipped }` for a clean run of ONE child suite
 * (or one browser scenario): the control that goes before and after a group of
 * mutants. Held to the baseline's standard, on the suite's own RESULT lines:
 * it finished with status 0, ran at least one test, failed and skipped none,
 * and its final summary does not contradict the results it printed.
 */
function judgeControl(run) {
  const stop = unfinished(run);
  if (stop) return { ok: false, reason: stop };
  if (run.code !== 0) {
    return { ok: false, reason: `the suite exited ${run.code}` };
  }
  const results = parseResults(run.out);
  const count = (kind) => results.filter((r) => r.verdict === kind).length;
  const counts = { passed: count('ok'), failed: count('fail'), skipped: count('skip') };
  const unknown = results.filter((r) => !['ok', 'fail', 'skip'].includes(r.verdict));
  if (unknown.length) return { ok: false, reason: `unrecognised RESULT verdict "${unknown[0].verdict}"`, ...counts };
  if (!results.length) return { ok: false, reason: 'the suite printed no RESULT lines, so nothing says it ran', ...counts };
  if (counts.failed) return { ok: false, reason: `${counts.failed} test${counts.failed === 1 ? '' : 's'} failed: ${failedNames(run.out).join(' | ')}`, ...counts };
  if (counts.skipped) return { ok: false, reason: `${counts.skipped} SKIPPED: a skipped test checked nothing`, ...counts };
  if (!counts.passed) return { ok: false, reason: 'the suite ran no tests', ...counts };
  const summary = parseSummary(run.out);
  if (!summary) return { ok: false, reason: 'the suite printed no "N passed, M failed" summary, so it may not have reached its end', ...counts };
  // The summary is the suite's own tally of its RESULT lines, so it must equal
  // them exactly: neither more nor fewer passes, and no failure or skip it hides.
  if (summary.passed !== counts.passed || summary.failed !== 0 || summary.skipped !== 0) {
    return {
      ok: false,
      reason: `the summary (${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped) contradicts the ${counts.passed} results printed`,
      ...counts,
    };
  }
  return { ok: true, reason: '', ...counts };
}

/**
 * `{ verdict, reason }` for one mutant, from the RAW run (`{ code, signal,
 * error, timedOut, out }`), under the strictest reading: a nonzero exit that
 * completed, the named test among the failures, and a final summary that does
 * not contradict them. Without `requireSummary: false` a run with no summary
 * has no verdict, because a process cut short after printing the named failure
 * may not have been judged on everything else.
 */
function classifyRun(run, mustFail, { requireSummary = true } = {}) {
  const failed = failedNames(run && run.out);
  const base = classify({ ...run, failed }, mustFail);
  if (unfinished(run)) return base;
  if (outputFormat(run.out) === 'results') {
    const skipRows = parseResults(run.out).filter((r) => r.verdict === 'skip').length;
    if (skipRows) return { verdict: 'error', reason: `${skipRows} test(s) SKIPPED in the mutant run: a skipped test cannot catch anything` };
    const unknown = parseResults(run.out).find((r) => !['ok', 'fail', 'skip'].includes(r.verdict));
    if (unknown) return { verdict: 'error', reason: `unrecognised RESULT verdict "${unknown.verdict}"` };
  }
  const summary = parseSummary(run.out);
  if (requireSummary && !summary) {
    return { verdict: 'error', reason: 'the suite printed no "N passed, M failed" summary, so it may not have run to its end' };
  }
  if (summary) {
    if (summary.skipped > 0) return { verdict: 'error', reason: `${summary.skipped} test(s) SKIPPED in the mutant run: a skipped test cannot catch anything` };
    if (summary.passed + summary.failed + summary.skipped === 0) return { verdict: 'error', reason: 'the mutant run executed no tests' };
    if (run.code === 0 && summary.failed > 0) {
      return { verdict: 'error', reason: `the suite exited 0 while its summary reports ${summary.failed} failed` };
    }
    const conflict = summaryConflict(run.out, summary);
    if (conflict) return { verdict: 'error', reason: conflict };
  }
  return base;
}

module.exports = {
  judgeBaseline, classify, summarise, parseResults, parseSummary, failedNames, outputFormat, judgeControl, classifyRun,
};
