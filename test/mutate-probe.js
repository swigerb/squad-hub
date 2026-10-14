#!/usr/bin/env node
'use strict';
/**
 * A fast pre-flight for newly added mutations.
 *
 * The real harness (test/mutate.js, or test/acceptance.js for a coordinated
 * run) runs the ENTIRE suite once per mutation, which is right for a sweep and
 * far too slow to iterate on. This applies the same mutations and runs only the
 * one child suite that claims to catch them, so a new mutation can be proven in
 * seconds rather than an hour.
 *
 * It uses the same verdict rules as the sweep (test/helpers/verdict.js): the
 * suite must pass cleanly BEFORE and AFTER the mutants -- finished with status
 * 0, no error/signal/timeout, a summary, no skips, no failures -- and every
 * mutant must finish nonzero with a complete summary and fail its NAMED test.
 * A crash, a timeout, a missing summary, a missing anchor or an unrestored file
 * is a failure, never a catch. It narrows the blast radius, not the standard;
 * the full harness stays the source of truth.
 *
 * Usage: node test/mutate-probe.js <child-suite.js> <name substring>...
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { judgeControl, classifyRun } = require('./helpers/verdict');

const nl = (s) => s.replace(/\r\n/g, '\n');
const CHILD_TIMEOUT_MS = 300000;

/** Run one child suite, keeping everything the verdict needs. */
function runChild(suite, root, env, timeout = CHILD_TIMEOUT_MS) {
  const r = spawnSync(process.execPath, [suite], {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return {
    code: typeof r.status === 'number' ? r.status : null,
    signal: r.signal || null,
    error: r.error || null,
    timedOut: !!(r.error && r.error.code === 'ETIMEDOUT'),
    out: (r.stdout || '') + (r.stderr || ''),
  };
}

/**
 * Prove `mutations` against one suite. `run(env)` is injectable so the logic is
 * testable without spawning. Returns { ok, results, controls, restored }.
 */
function probe({ root, mutations, run, log = () => {} }) {
  const results = [];
  const controls = {};
  const outcome = (extra) => ({ ok: false, results, controls, restored: true, ...extra });

  const pre = judgeControl(run({}));
  controls.pre = pre;
  if (!pre.ok) {
    log(`BASELINE IS NOT CLEAN: ${pre.reason}`);
    return outcome();
  }
  log(`baseline clean (${pre.passed} passed)\n`);

  const touched = new Map();
  let restored = true;
  const restoreAll = () => {
    for (const [file, bytes] of touched) {
      fs.writeFileSync(file, bytes);
      if (!fs.readFileSync(file).equals(bytes)) restored = false;
    }
  };
  const onExit = () => { try { restoreAll(); } catch { /* best effort on exit */ } };
  process.on('exit', onExit);
  try {
    for (const m of mutations) {
      const file = path.join(root, m.file);
      const bytes = fs.readFileSync(file);
      const original = bytes.toString('utf8');
      const mutated = nl(original).replace(nl(m.find), nl(m.replace));
      if (mutated === nl(original)) {
        results.push({ name: m.name, verdict: 'error', reason: 'anchor did not match' });
        log(`ANCHOR MISS  ${m.name}`);
        continue;
      }
      touched.set(file, bytes);
      let verdict;
      try {
        fs.writeFileSync(file, mutated);
        verdict = classifyRun(run({ MUTANT: '1' }), m.mustFail);
      } finally {
        fs.writeFileSync(file, bytes);
        if (!fs.readFileSync(file).equals(bytes)) restored = false;
      }
      results.push({ name: m.name, ...verdict });
      if (verdict.verdict === 'caught') log(`caught       ${m.name}`);
      else {
        log(`${verdict.verdict.toUpperCase().padEnd(12)} ${m.name}`);
        log(`             expected to fail: ${m.mustFail}`);
        log(`             ${verdict.reason}`);
      }
    }
  } finally {
    restoreAll();
    process.removeListener('exit', onExit);
  }

  const post = judgeControl(run({}));
  controls.post = post;
  if (!post.ok) log(`POST-RUN BASELINE IS NOT CLEAN: ${post.reason}`);
  if (!restored) log('A MUTATED FILE WAS NOT RESTORED BYTE-FOR-BYTE');

  const allCaught = results.length === mutations.length && results.every((r) => r.verdict === 'caught');
  return { ok: allCaught && pre.ok && post.ok && restored, results, controls, restored };
}

function main(argv) {
  const [suiteArg, ...filters] = argv;
  if (!suiteArg) {
    console.error('usage: node test/mutate-probe.js <child-suite.js> [name substring]...');
    return 2;
  }
  const root = path.join(__dirname, '..');
  const suite = path.join(__dirname, suiteArg);
  const { MUTATIONS } = require('./mutate');
  const selected = MUTATIONS.filter((m) => !m.skip
    && (!filters.length || filters.some((f) => m.name.includes(f))));
  if (!selected.length) {
    console.error(`no mutation matched: ${filters.join(', ')}`);
    return 2;
  }
  const res = probe({ root, mutations: selected, run: (env) => runChild(suite, root, env), log: (l) => console.log(l) });
  const caught = res.results.filter((r) => r.verdict === 'caught').length;
  console.log(`\n${caught}/${selected.length} caught`);
  if (!res.ok) console.log('PROBE FAILED: a control, restore or verdict was not clean');
  return res.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { probe, runChild, main };