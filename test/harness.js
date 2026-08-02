'use strict';
/** A very small test harness. No dependencies, deliberately. */

const assert = require('assert');

const suites = [];
let only = null;

function suite(name, fn) { suites.push({ name, fn }); }
function onlySuite(name, fn) { only = { name, fn }; suites.push(only); }

async function run() {
  const list = only ? [only] : suites;
  let pass = 0; let fail = 0;
  const failures = [];

  for (const s of list) {
    const t = makeT(s.name);
    try {
      await s.fn(t);
      for (const r of t._results) {
        if (r.ok) { pass += 1; } else { fail += 1; failures.push(r); }
        console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : '\n       ' + r.error}`);
      }
    } catch (e) {
      fail += 1;
      failures.push({ name: `${s.name} (threw)`, error: e.stack || e.message });
      console.log(`  FAIL ${s.name} threw\n       ${e.stack || e.message}`);
    }
  }

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(` - ${f.name}: ${f.error}`);
  }
  return fail === 0;
}

function makeT(suiteName) {
  const results = [];
  const t = {
    _results: results,
    check(name, fn) {
      try { fn(); results.push({ ok: true, name: `${suiteName}: ${name}` }); }
      catch (e) { results.push({ ok: false, name: `${suiteName}: ${name}`, error: e.message }); }
    },
    async checkAsync(name, fn) {
      try { await fn(); results.push({ ok: true, name: `${suiteName}: ${name}` }); }
      catch (e) { results.push({ ok: false, name: `${suiteName}: ${name}`, error: e.message }); }
    },
    assert,
  };
  return t;
}

module.exports = { suite, onlySuite, run };
