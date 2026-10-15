'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const runner = fs.readFileSync(path.join(__dirname, 'run-tests.js'), 'utf8').replace(/\r\n/g, '\n');
const start = runner.indexOf('function runChildSuite(');
const end = runner.indexOf('\n// ---------------------------------------------------------------------------\n// CRITERION 2', start);
assert.ok(start >= 0 && end > start, 'child-runner function could not be extracted');
const body = runner.slice(start, end);
let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`RESULT\tok\t${name}`); }
  catch (e) { fail += 1; console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`); }
}
function run(result, options = { timeout: 300000, requireCompletion: true }) {
  let used;
  const logs = [];
  const context = {
    pass: 0, fail: 0, failures: [], skipped: [], process,
    console: { log(line) { logs.push(String(line)); } },
    spawnSync(exe, args, opts) { used = opts; return { stdout: '', stderr: '', signal: null, ...result }; },
  };
  vm.createContext(context);
  vm.runInContext(`${body}\nrunChildSuite('fixture.js', 'browser', ${JSON.stringify(options)});`, context);
  return { ...context, used, logs };
}
const complete = { status: 0, stdout: 'RESULT\tok\tfixture check\n\n1 passed, 0 failed\n' };

check('child runner rejects a timeout even when the child handles TERM and exits zero', () => {
  const result = run({ ...complete, error: { code: 'ETIMEDOUT', message: 'child timed out' } });
  assert.ok(result.fail > 0);
  assert.ok(result.failures.some(f => f.error.includes('ETIMEDOUT')));
});
check('child runner rejects a signal even when the child reports a matching final summary', () => {
  const result = run({ ...complete, signal: 'SIGTERM' });
  assert.ok(result.fail > 0);
});
check('child runner rejects partial passing results without a final completion summary', () => {
  const result = run({ status: 0, stdout: 'RESULT\tok\tfixture check\n' });
  assert.ok(result.fail > 0);
  assert.ok(result.failures.some(f => f.name.includes('final summary')));
});
check('child runner rejects a final summary whose counts omit or invent results', () => {
  for (const summary of ['2 passed, 0 failed', '1 passed, 1 failed', '1 passed, 0 failed, 1 skipped']) {
    assert.ok(run({ status: 0, stdout: `RESULT\tok\tfixture check\n${summary}\n` }).fail > 0);
  }
});
check('child runner accepts a completed positive suite with matching results and summary', () => {
  const result = run(complete);
  assert.strictEqual(result.fail, 0);
  assert.strictEqual(result.pass, 1);
});
check('child runner keeps a completed named assertion failure as a failure', () => {
  const result = run({ status: 1, stdout: 'RESULT\tfail\tfixture check\tactual assertion\n0 passed, 1 failed\n' });
  assert.strictEqual(result.fail, 1);
  assert.strictEqual(result.failures[0].name, 'fixture check');
});
check('child runner reports an optional missing browser as skipped rather than passed', () => {
  const result = run({ status: 0, stdout: 'RESULT\tskip\tbrowser unavailable\n0 passed, 0 failed, 1 skipped\n' });
  assert.strictEqual(result.fail, 0);
  assert.strictEqual(result.pass, 0);
  assert.strictEqual(result.skipped.length, 1);
});
check('child runner names the suite it starts and ends, with its elapsed time, without touching results', () => {
  const result = run(complete);
  const start = result.logs.indexOf('  [child-suite] start browser');
  const end = result.logs.findIndex((l) => /^  \[child-suite\] end browser \(\d+\.\d\s*s\)$/.test(l));
  assert.ok(start >= 0, 'no start marker naming the suite');
  assert.ok(end > start, 'no end marker with a duration after the start marker');
  assert.strictEqual(result.pass, 1);
});
check('child runner uses the explicit browser budget without relaxing other child suites', () => {
  assert.strictEqual(run(complete).used.timeout, 300000);
  assert.strictEqual(run(complete, {}).used.timeout, 120000);
  assert.ok(runner.includes("'browser', { timeout: 300000, requireCompletion: true }"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
