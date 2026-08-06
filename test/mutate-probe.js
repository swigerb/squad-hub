#!/usr/bin/env node
'use strict';
/**
 * A fast pre-flight for newly added mutations.
 *
 * The real harness (test/mutate.js) runs the ENTIRE suite once per mutation,
 * which is right for a sweep and far too slow to iterate on. This applies the
 * same mutations and runs only the one child suite that claims to catch them,
 * so a new mutation can be proven in seconds rather than an hour.
 *
 * It proves the same thing the harness does -- a NAMED test fails -- against a
 * narrower blast radius. The full harness stays the source of truth.
 *
 * Usage: node test/mutate-probe.js <child-suite.js> <name substring>...
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const [suiteArg, ...filters] = process.argv.slice(2);
if (!suiteArg) {
  console.error('usage: node test/mutate-probe.js <child-suite.js> [name substring]...');
  process.exit(2);
}
const SUITE = path.join(__dirname, suiteArg);

const { MUTATIONS } = require('./mutate');
const nl = (s) => s.replace(/\r\n/g, '\n');

const selected = MUTATIONS.filter((m) => !m.skip
  && (!filters.length || filters.some((f) => m.name.includes(f))));

if (!selected.length) {
  console.error(`no mutation matched: ${filters.join(', ')}`);
  process.exit(2);
}

function runSuite(env) {
  const r = spawnSync(process.execPath, [SUITE], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, ...env },
  });
  return (r.stdout || '') + (r.stderr || '');
}

function failedNames(out) {
  return out.split('\n')
    .filter((l) => l.startsWith('RESULT\tfail\t'))
    .map((l) => l.split('\t')[2]);
}

const baseline = failedNames(runSuite({}));
if (baseline.length) {
  console.log('BASELINE IS RED:');
  for (const n of baseline) console.log(`  - ${n}`);
  process.exit(1);
}
console.log('baseline green\n');

let caught = 0;
const escaped = [];
const restore = [];
process.on('exit', () => { for (const [f, t] of restore) fs.writeFileSync(f, t); });

for (const m of selected) {
  const file = path.join(ROOT, m.file);
  const original = fs.readFileSync(file, 'utf8');
  const mutated = nl(original).replace(nl(m.find), nl(m.replace));
  if (mutated === nl(original)) {
    console.log(`ANCHOR MISS  ${m.name}`);
    escaped.push(`${m.name} (anchor did not match)`);
    continue;
  }

  restore.push([file, original]);
  fs.writeFileSync(file, mutated);
  let failures;
  try { failures = failedNames(runSuite({ MUTANT: '1' })); }
  finally { fs.writeFileSync(file, original); restore.pop(); }

  if (failures.includes(m.mustFail)) {
    caught += 1;
    console.log(`caught       ${m.name}`);
  } else {
    escaped.push(m.name);
    console.log(`ESCAPED      ${m.name}`);
    console.log(`             expected to fail: ${m.mustFail}`);
    console.log(`             actually failed:  ${failures.length ? failures.join(' | ') : '(nothing)'}`);
  }
}

console.log(`\n${caught}/${selected.length} caught`);
process.exit(escaped.length ? 1 : 0);
