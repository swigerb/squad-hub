#!/usr/bin/env node
'use strict';
/**
 * Fake `squad` CLI for health tests.
 *
 * Invoked as `node test/fake-squad.js ...`, because production code must not
 * use `shell:true` and Windows cannot directly exec a `.cmd` shim without a
 * shell. This still exercises argv-array subprocess execution, timeout, and
 * bounded output without depending on a real Squad install.
 */

const fs = require('fs');

const mode = process.env.FAKE_SQUAD_MODE || 'pass';
const version = process.env.FAKE_SQUAD_VERSION || '0.13.1';

if (process.env.FAKE_SQUAD_PID_FILE) {
  try { fs.appendFileSync(process.env.FAKE_SQUAD_PID_FILE, `${process.pid}\n`); } catch { /* best effort */ }
}

if (process.env.FAKE_SQUAD_COUNT_FILE) {
  try {
    const n = Number(fs.readFileSync(process.env.FAKE_SQUAD_COUNT_FILE, 'utf8') || '0') || 0;
    fs.writeFileSync(process.env.FAKE_SQUAD_COUNT_FILE, String(n + 1));
  } catch {
    try { fs.writeFileSync(process.env.FAKE_SQUAD_COUNT_FILE, '1'); } catch { /* best effort */ }
  }
}

let args = process.argv.slice(2);
if (process.env.FAKE_SQUAD_ARGV_FILE) {
  try { fs.appendFileSync(process.env.FAKE_SQUAD_ARGV_FILE, `${JSON.stringify(args)}\n`); } catch { /* best effort */ }
}
if (process.env.FAKE_SQUAD_EXPECT_PREFIX) {
  if (args[0] !== process.env.FAKE_SQUAD_EXPECT_PREFIX) {
    process.stderr.write(`prefix mismatch: ${JSON.stringify(args[0])}\n`);
    process.exit(9);
  }
  args = args.slice(1);
}
if (process.env.FAKE_SQUAD_EXPECT_PREFIX_JSON) {
  let expected;
  try { expected = JSON.parse(process.env.FAKE_SQUAD_EXPECT_PREFIX_JSON); } catch {
    process.stderr.write('prefix json mismatch: unparsable expectation\n');
    process.exit(9);
  }
  if (!Array.isArray(expected) || JSON.stringify(args.slice(0, expected.length)) !== JSON.stringify(expected)) {
    process.stderr.write(`prefix json mismatch: ${JSON.stringify(args.slice(0, expected.length))}\n`);
    process.exit(9);
  }
  args = args.slice(expected.length);
}
if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') {
  if (mode === 'version-crash') process.exit(7);
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

if (args[0] === 'health' && args[1] === '--json') {
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'garbage') {
    process.stdout.write('not json\n');
    process.exit(0);
  }
  if (mode === 'oversized') {
    process.stdout.write('x'.repeat(128 * 1024));
    process.exit(0);
  }
  if (mode === 'wrong-schema') {
    process.stdout.write(JSON.stringify({ schema: 'other/v1', status: 'pass', checks: [] }, null, 2));
    process.exit(0);
  }

  const checks = [
    { id: 'team', status: 'pass', message: 'team exists', diagnostics: ['C:\\secret\\team.md'] },
    { id: 'registry-charters', status: 'pass', message: 'charters exist' },
    { id: 'routing', status: mode === 'skip' ? 'skip' : 'pass', message: mode === 'skip' ? 'not configured' : 'routing exists' },
    { id: 'state-backend', status: 'pass', message: 'local state backend' },
    { id: 'env-vars', status: mode === 'fail' ? 'fail' : 'pass', message: mode === 'fail' ? 'missing env var' : 'env ok' },
  ];
  const report = {
    schema: 'squad-health/v1',
    status: checks.some((c) => c.status === 'fail') ? 'fail' : 'pass',
    checks,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.status === 'fail' ? 1 : 0);
}

process.stderr.write(`unexpected args: ${args.join(' ')}\n`);
process.exit(2);
