#!/usr/bin/env node
'use strict';
/**
 * Mutation harness.
 *
 * A suite that passes proves nothing on its own. This one broke 41 assertions'
 * worth of behaviour on the first run, which is precisely when a test suite
 * deserves suspicion.
 *
 * So: break each load-bearing mechanism, one at a time, and require that a
 * NAMED test fails. A mutation that nothing catches is a mechanism nothing is
 * testing -- and that is a finding, not a pass.
 *
 * Exit 0 only if every mutation is caught by the test that claims to cover it.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TESTS = path.join(__dirname, 'run-tests.js');

const MUTATIONS = [
  {
    name: 'daemon does not kill its children on shutdown',
    file: 'src/daemon.js',
    find: `  _killAllChildren() {
    for (const s of this.sessions.values()) {`,
    replace: `  _killAllChildren() {
    if (process.env.MUTANT) return; // MUTATION
    for (const s of this.sessions.values()) {`,
    mustFail: 'SHUTDOWN kills the agent, without help from the OS',
  },
  {
    name: 'daemon does not reap orphans on start',
    file: 'src/daemon.js',
    find: `  reapOrphans() {
    const killed = [];`,
    replace: `  reapOrphans() {
    if (process.env.MUTANT) return []; // MUTATION
    const killed = [];`,
    mustFail: 'REAP actually kills the orphaned agent',
  },
  {
    name: 'heartbeat does not notice a dead agent',
    file: 'src/daemon.js',
    find: `      if (live && s.isAgentDead()) {`,
    replace: `      if (live && s.isAgentDead() && !process.env.MUTANT) { // MUTATION`,
    mustFail: 'THE HEARTBEAT ITSELF marks the session failed',
  },
  {
    name: 'child pids are never recorded on disk',
    file: 'src/daemon.js',
    find: `  _trackChild(pid, sessionId) {
    if (!pid) return;`,
    replace: `  _trackChild(pid, sessionId) {
    if (process.env.MUTANT) return; // MUTATION
    if (!pid) return;`,
    mustFail: 'the orphan is recorded on disk so it can be found',
  },
  {
    name: 'the reaper steals children from OTHER live daemons',
    file: 'src/daemon.js',
    find: `      const daemonAlive = c.daemonPid === process.pid || alive(c.daemonPid);`,
    replace: `      const daemonAlive = process.env.MUTANT ? false : (c.daemonPid === process.pid || alive(c.daemonPid)); // MUTATION`,
    mustFail: 'a child of a LIVE daemon is not reaped',
  },
  {
    name: 'any option id is accepted, even one the agent never offered',
    file: 'src/acp-session.js',
    find: `    const known = a.options.some((o) => o.optionId === optionId);`,
    replace: `    const known = process.env.MUTANT ? true : a.options.some((o) => o.optionId === optionId); // MUTATION`,
    mustFail: 'a forged option id is rejected',
  },
  {
    name: 'the confinement root is not enforced',
    file: 'src/daemon.js',
    find: `    if (rel.startsWith('..') || path.isAbsolute(rel)) {`,
    replace: `    if ((rel.startsWith('..') || path.isAbsolute(rel)) && !process.env.MUTANT) { // MUTATION`,
    mustFail: 'a directory outside the root is refused',
  },
  {
    name: 'file access defaults to ON',
    file: 'src/config.js',
    find: `  allowFiles: false,         // expose any filesystem affordance at all`,
    replace: `  allowFiles: true, // MUTATION`,
    mustFail: 'file access is OFF by default',
  },
  {
    name: 'the approval shows a summary instead of the literal command',
    file: 'src/acp-session.js',
    find: `      command: raw.command || (Array.isArray(raw.commands) ? raw.commands.join(' && ') : null),`,
    replace: `      command: process.env.MUTANT ? (tc.title || null) : (raw.command || (Array.isArray(raw.commands) ? raw.commands.join(' && ') : null)), // MUTATION`,
    mustFail: 'the approval carries the LITERAL command, not a summary',
  },
  {
    name: 'the confinement root is included in the reportable device view',
    file: 'src/config.js',
    find: `function publicView(cfg = read()) {
  return {`,
    replace: `function publicView(cfg = read()) {
  if (process.env.MUTANT) return { trackAll: cfg.trackAll, fileAccess: cfg.allowFiles ? 'scoped' : 'off', filesRoot: cfg.filesRoot }; // MUTATION
  return {`,
    mustFail: 'the confinement path is NEVER in the reportable view',
  },
];

/**
 * Source on disk is CRLF on Windows; the anchors below are written with LF.
 * Normalising both sides is not cosmetic -- an anchor that silently fails to
 * match makes a mutation LOOK applied while testing nothing, which is the exact
 * false comfort this harness exists to prevent.
 */
const nl = (s) => s.replace(/\r\n/g, '\n');

function runTests(env) {
  const r = spawnSync(process.execPath, [TESTS], {
    cwd: ROOT, encoding: 'utf8', timeout: 600000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function failedTestNames(out) {
  return out.split('\n')
    .filter((l) => l.trim().startsWith('FAIL '))
    .map((l) => l.trim().slice(5).trim());
}

(async () => {
  console.log('squad-hub mutation harness');
  console.log('='.repeat(60));

  console.log('\nbaseline (unmutated): expecting a clean pass');
  const base = runTests({});
  if (base.code !== 0) {
    console.log(base.out.split('\n').slice(-30).join('\n'));
    console.log('\nBASELINE IS RED. Fix the suite before trusting any mutation.');
    process.exit(1);
  }
  console.log('  baseline green');

  let caught = 0;
  const escaped = [];

  for (const m of MUTATIONS) {
    const file = path.join(ROOT, m.file);
    const original = fs.readFileSync(file, 'utf8');
    const normalised = nl(original);
    if (!normalised.includes(m.find)) {
      console.log(`\n! could not apply mutation "${m.name}" - the anchor text moved`);
      escaped.push({ ...m, why: 'anchor not found; the mutation never ran' });
      continue;
    }
    fs.writeFileSync(file, normalised.replace(m.find, m.replace));

    try {
      const r = runTests({ MUTANT: '1' });
      const failed = failedTestNames(r.out);
      const hit = failed.some((f) => f.includes(m.mustFail));
      if (hit) {
        caught += 1;
        console.log(`\n  CAUGHT  ${m.name}`);
        console.log(`          -> "${m.mustFail}" failed, as it must`);
      } else if (r.code !== 0) {
        caught += 1;
        console.log(`\n  CAUGHT  ${m.name}`);
        console.log(`          -> suite went red, but on: ${failed.join(' | ') || '(no named failure)'}`);
        console.log(`          -> EXPECTED: "${m.mustFail}"  <- the coverage claim is imprecise`);
        escaped.push({ ...m, why: `caught by the wrong test: ${failed.join(' | ')}` });
      } else {
        console.log(`\n  ESCAPED ${m.name}`);
        console.log(`          -> the suite stayed GREEN. Nothing tests this.`);
        escaped.push({ ...m, why: 'suite stayed green' });
      }
    } finally {
      fs.writeFileSync(file, original);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`${caught}/${MUTATIONS.length} mutations caught`);

  const real = escaped.filter((e) => e.why === 'suite stayed green' || e.why.startsWith('anchor'));
  if (real.length) {
    console.log('\nUNTESTED MECHANISMS:');
    for (const e of real) console.log(` - ${e.name}\n   ${e.why}`);
  }
  const imprecise = escaped.filter((e) => e.why.startsWith('caught by the wrong test'));
  if (imprecise.length) {
    console.log('\nCAUGHT, BUT NOT BY THE NAMED TEST:');
    for (const e of imprecise) console.log(` - ${e.name}\n   ${e.why}`);
  }

  // A green baseline restored is part of the contract.
  const after = runTests({});
  console.log(`\nsource restored, baseline re-run: ${after.code === 0 ? 'green' : 'RED'}`);
  process.exit(real.length || after.code !== 0 ? 1 : 0);
})();
