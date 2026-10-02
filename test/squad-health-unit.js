#!/usr/bin/env node
'use strict';
/**
 * Squad v0.13 health integration.
 *
 * Every subprocess here is the fake `squad` CLI in this repository. The test
 * never depends on a real Squad install and never touches user state.
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fake-squad.js');
const SCRATCH_PREFIX = '_tmp_squad_health_';
const PID_FILE = path.join(os.tmpdir(), `${SCRATCH_PREFIX}${process.pid}_fake_pids_${Date.now()}.log`);
const scratchArtifacts = new Set([PID_FILE]);

const {
  runSquadHealth,
  getCachedSquadHealth,
  clearSquadHealthCache,
  killAllSquadHealthProbes,
  findOnPath,
  squadHealthCacheSize,
} = require('../src/squad-health');

let pass = 0; let fail = 0;
function check(name, fn) {
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}
async function checkAsync(name, fn) {
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

function scratch(name) {
  const safeName = String(name).replace(/[^A-Za-z0-9_.-]+/g, '-');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${SCRATCH_PREFIX}${process.pid}_${safeName}_`));
  scratchArtifacts.add(dir);
  return dir;
}
function hostileScratch(name) {
  const dir = path.join(os.tmpdir(), `${SCRATCH_PREFIX}${name}`);
  fs.mkdirSync(dir, { recursive: true });
  scratchArtifacts.add(dir);
  return dir;
}
function rmArtifact(target) {
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      scratchArtifacts.delete(target);
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
    }
  }
}
function cleanup(...dirs) {
  for (const d of dirs) rmArtifact(d);
}
function listScratchArtifacts() {
  try {
    return fs.readdirSync(os.tmpdir())
      .filter((name) => name.startsWith(SCRATCH_PREFIX))
      .map((name) => path.join(os.tmpdir(), name));
  } catch {
    return [];
  }
}
function sweepScratchArtifacts() {
  for (const target of [...new Set([...scratchArtifacts, ...listScratchArtifacts()])]) rmArtifact(target);
}
function livePidsFromFile() {
  let lines = [];
  try { lines = fs.readFileSync(PID_FILE, 'utf8').split(/\r?\n/); } catch { return []; }
  const pids = [...new Set(lines.map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0))];
  return pids.filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
}
function squadProject(name) {
  const dir = scratch(name);
  fs.mkdirSync(path.join(dir, '.squad'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.squad', 'team.md'), [
    '| Name | Role | Status |',
    '| --- | --- | --- |',
    '| Squad | coordinator | Active |',
    '',
  ].join('\n'));
  return dir;
}
function fakeOpts(mode, extra = {}) {
  return {
    squadCommand: process.execPath,
    squadArgsPrefix: [FAKE],
    timeoutMs: extra.timeoutMs || 700,
    maxOutputBytes: extra.maxOutputBytes || 32 * 1024,
    ttlMs: extra.ttlMs,
    maxCacheEntries: extra.maxCacheEntries,
    env: {
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || '',
      WINDIR: process.env.WINDIR || '',
      FAKE_SQUAD_MODE: mode,
      FAKE_SQUAD_VERSION: extra.version || '0.13.1',
      FAKE_SQUAD_PID_FILE: PID_FILE,
      ...(extra.env || {}),
    },
  };
}
function writeCmdShim(dir) {
  fs.writeFileSync(path.join(dir, 'squad.cmd'), [
    '@echo off',
    `"${process.execPath}" "${FAKE}" %*`,
    '',
  ].join('\r\n'));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = fn();
    if (last) return last;
    await sleep(25);
  }
  return last;
}

sweepScratchArtifacts();

(async () => {
  {
    const project = squadProject('pass');
    try {
      const r = await runSquadHealth(project, fakeOpts('pass'));
      check('squad health valid pass JSON is parsed', () => {
        assert.strictEqual(r.available, true, r.reason);
        assert.strictEqual(r.report.schema, 'squad-health/v1');
        assert.strictEqual(r.report.status, 'pass');
      });
    } finally { cleanup(project); }
  }

  {
    const project = squadProject('fail');
    try {
      const r = await runSquadHealth(project, fakeOpts('fail'));
      check('squad health exit code 1 with valid JSON is still parsed as a result', () => {
        assert.strictEqual(r.available, true, r.reason);
        assert.strictEqual(r.exitCode, 1);
        assert.strictEqual(r.report.status, 'fail');
        assert.strictEqual(r.report.checks.find((c) => c.id === 'env-vars').status, 'fail');
      });
    } finally { cleanup(project); }
  }

  {
    const project = squadProject('old');
    try {
      const r = await runSquadHealth(project, fakeOpts('pass', { version: '0.12.9' }));
      check('squad versions older than 0.13 are rejected', () => {
        assert.strictEqual(r.available, false);
        assert.match(r.reason, /0\.12\.9.*need >= 0\.13/);
      });
    } finally { cleanup(project); }
  }

  {
    const project = squadProject('missing');
    const empty = scratch('empty-path');
    const savedPath = process.env.PATH;
    process.env.PATH = empty;
    try {
      const r = await runSquadHealth(project, { timeoutMs: 300, env: { PATH: empty } });
      check('missing squad binary is reported as unavailable', () => {
        assert.strictEqual(r.available, false);
        assert.match(r.reason, /not found on PATH/);
      });
    } finally {
      process.env.PATH = savedPath;
      cleanup(project, empty);
    }
  }

  {
    const project = squadProject('hang');
    try {
      const started = Date.now();
      const r = await runSquadHealth(project, fakeOpts('hang', { timeoutMs: 250 }));
      check('squad health timeout is enforced and reported', () => {
        assert.strictEqual(r.available, false);
        assert.match(r.reason, /timed out/);
        assert.ok(Date.now() - started < 2000, 'the hung child was not killed promptly');
      });
    } finally { cleanup(project); }
  }

  {
    const project = squadProject('garbage');
    try {
      const r = await runSquadHealth(project, fakeOpts('garbage'));
      check('garbage squad health stdout is unavailable, not parsed', () => {
        assert.strictEqual(r.available, false);
        assert.match(r.reason, /unparsable/);
      });
    } finally { cleanup(project); }
  }

  {
    const project = squadProject('oversized');
    try {
      const r = await runSquadHealth(project, fakeOpts('oversized', { maxOutputBytes: 1024 }));
      check('oversized squad health stdout is capped and rejected', () => {
        assert.strictEqual(r.available, false);
        assert.match(r.reason, /too much output/);
      });
    } finally { cleanup(project); }
  }

  if (process.platform === 'win32') {
    const project = squadProject('taskkill');
    const original = childProcess.spawnSync;
    const calls = [];
    childProcess.spawnSync = (command, args, opts) => {
      calls.push({ command, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await runSquadHealth(project, fakeOpts('oversized', { maxOutputBytes: 1024 }));
      check('squad health kills Windows children with trusted System32 taskkill', () => {
        assert.ok(calls.length, 'taskkill was not invoked');
        const expected = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        assert.strictEqual(calls[0].command, expected);
        assert.strictEqual(calls[0].opts.cwd, path.dirname(expected));
        assert.deepStrictEqual(calls[0].args.slice(2), ['/T', '/F']);
      });
    } finally {
      childProcess.spawnSync = original;
      cleanup(project);
    }
  }

  if (process.platform === 'win32') {
    const project = squadProject('cmd-shim-pass');
    const shimDir = scratch('cmd-shim-pass-path');
    const argvFile = path.join(project, 'argv.txt');
    const savedPath = process.env.PATH;
    const savedPathext = process.env.PATHEXT;
    const dangerous = 'literal space & | ^ " quoted';
    writeCmdShim(shimDir);
    process.env.PATH = shimDir;
    process.env.PATHEXT = '.CMD';
    try {
      const r = await runSquadHealth(project, {
        squadArgsPrefix: [dangerous],
        timeoutMs: 1000,
        maxOutputBytes: 32 * 1024,
        env: fakeOpts('pass', {
          env: {
            PATH: shimDir,
            PATHEXT: '.CMD',
            FAKE_SQUAD_ARGV_FILE: argvFile,
            FAKE_SQUAD_EXPECT_PREFIX: dangerous,
          },
        }).env,
      });
      check('Windows squad.cmd shim on PATH runs with literal metacharacter args', () => {
        assert.strictEqual(r.available, true, r.reason);
        const seen = fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.deepStrictEqual(seen, [
          [dangerous, '--version'],
          [dangerous, 'health', '--json'],
        ]);
      });
    } finally {
      process.env.PATH = savedPath;
      if (savedPathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathext;
      cleanup(project, shimDir);
    }
  }

  if (process.platform === 'win32') {
    const project = squadProject('cmd-shim-path-injection');
    const injectedName = `injected_${process.pid}.txt`;
    const shimDir = hostileScratch(`review_x & ^ copy NUL ${injectedName} & rem_${process.pid}_${Date.now()}_tail`);
    const sideEffects = [path.join(project, injectedName), path.join(ROOT, injectedName), path.join(os.tmpdir(), injectedName)];
    const savedPath = process.env.PATH;
    const savedPathext = process.env.PATHEXT;
    fs.mkdirSync(shimDir, { recursive: true });
    writeCmdShim(shimDir);
    process.env.PATH = shimDir;
    process.env.PATHEXT = '.CMD';
    try {
      for (const f of sideEffects) { try { fs.unlinkSync(f); } catch { /* absent */ } }
      const r = await runSquadHealth(project, {
        timeoutMs: 1000,
        maxOutputBytes: 32 * 1024,
        env: fakeOpts('pass', { env: { PATH: shimDir, PATHEXT: '.CMD' } }).env,
      });
      check('Windows squad.cmd shim path attack metacharacters do not execute injected commands', () => {
        assert.strictEqual(r.available, true, r.reason);
        assert.ok(sideEffects.every((f) => !fs.existsSync(f)), 'cmd metacharacter side effect was created');
      });
    } finally {
      process.env.PATH = savedPath;
      if (savedPathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathext;
      for (const f of sideEffects) { try { fs.unlinkSync(f); } catch { /* absent */ } }
      cleanup(project, shimDir);
    }
  }

  if (process.platform === 'win32') {
    const project = squadProject('cmd-shim-hostile-args');
    const shimDir = scratch('cmd-shim-hostile-args-path');
    const argvFile = path.join(project, 'argv.txt');
    const savedPath = process.env.PATH;
    const savedPathext = process.env.PATHEXT;
    const prefix = ['plain&|^', 'bang!FAKE_SQUAD_DELAYED!literal', 'literal space & | ^ " quoted'];
    writeCmdShim(shimDir);
    process.env.PATH = shimDir;
    process.env.PATHEXT = '.CMD';
    try {
      const r = await runSquadHealth(project, {
        squadArgsPrefix: prefix,
        timeoutMs: 1000,
        maxOutputBytes: 32 * 1024,
        env: fakeOpts('pass', {
          env: {
            PATH: shimDir,
            PATHEXT: '.CMD',
            FAKE_SQUAD_DELAYED: 'EXPANDED',
            FAKE_SQUAD_ARGV_FILE: argvFile,
            FAKE_SQUAD_EXPECT_PREFIX_JSON: JSON.stringify(prefix),
          },
        }).env,
      });
      check('Windows squad.cmd shim keeps no-space metacharacter and delayed-expansion args literal', () => {
        assert.strictEqual(r.available, true, r.reason);
        const seen = fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.deepStrictEqual(seen, [
          [...prefix, '--version'],
          [...prefix, 'health', '--json'],
        ]);
      });
    } finally {
      process.env.PATH = savedPath;
      if (savedPathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathext;
      cleanup(project, shimDir);
    }
  }

  if (process.platform === 'win32') {
    const project = squadProject('cmd-shim-unsafe-prefix');
    const shimDir = scratch('cmd-shim-unsafe-prefix-path');
    const argvFile = path.join(project, 'argv.txt');
    const savedPath = process.env.PATH;
    const savedPathext = process.env.PATHEXT;
    writeCmdShim(shimDir);
    process.env.PATH = shimDir;
    process.env.PATHEXT = '.CMD';
    try {
      const cases = [
        { name: 'percent expansion', prefix: ['%FAKE_SQUAD_SHOULD_NOT_EXPAND%'], match: /percent expansion syntax/ },
        { name: 'CR/LF', prefix: ['line\r\nbreak'], match: /control character/ },
        { name: 'backslash before quote', prefix: ['tail\\"quoted'], match: /backslash before a quote/ },
      ];
      const results = [];
      for (const c of cases) {
        try { fs.unlinkSync(argvFile); } catch { /* absent */ }
        const r = await runSquadHealth(project, {
          squadArgsPrefix: c.prefix,
          timeoutMs: 1000,
          maxOutputBytes: 32 * 1024,
          env: fakeOpts('pass', {
            env: {
              PATH: shimDir,
              PATHEXT: '.CMD',
              FAKE_SQUAD_SHOULD_NOT_EXPAND: 'EXPANDED',
              FAKE_SQUAD_ARGV_FILE: argvFile,
            },
          }).env,
        });
        results.push({ ...c, result: r, invoked: fs.existsSync(argvFile) });
      }
      check('Windows squad.cmd shim fails closed for unrepresentable prefix arguments', () => {
        for (const r of results) {
          assert.strictEqual(r.result.available, false, r.name);
          assert.match(r.result.reason, r.match, r.name);
          assert.strictEqual(r.invoked, false, `${r.name} invoked fake squad`);
        }
      });
    } finally {
      process.env.PATH = savedPath;
      if (savedPathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathext;
      cleanup(project, shimDir);
    }
  }

  if (process.platform === 'win32') {
    const project = squadProject('cmd-shim-unsafe-path');
    try {
      const cases = [
        { name: 'quote', command: path.join(project, 'bad"shim.cmd'), match: /cmd syntax/ },
        { name: 'pipe', command: `C:\\bad|path\\squad.cmd`, match: /cmd syntax/ },
        { name: 'percent expansion', command: path.join(project, 'bad%FAKE_SQUAD_SHOULD_NOT_EXPAND%.cmd'), match: /cmd syntax/ },
        { name: 'CR/LF', command: `${path.join(project, 'line')}\r\nbreak.cmd`, match: /control character/ },
      ];
      const results = [];
      for (const c of cases) {
        const r = await runSquadHealth(project, {
          squadCommand: c.command,
          timeoutMs: 1000,
          maxOutputBytes: 32 * 1024,
          env: fakeOpts('pass', { env: { FAKE_SQUAD_SHOULD_NOT_EXPAND: 'EXPANDED' } }).env,
        });
        results.push({ ...c, result: r });
      }
      check('Windows squad.cmd shim fails closed for unrepresentable script paths', () => {
        for (const r of results) {
          assert.strictEqual(r.result.available, false, r.name);
          assert.match(r.result.reason, r.match, r.name);
        }
      });
    } finally { cleanup(project); }
  }

  if (process.platform === 'win32') {
    const project = squadProject('cmd-shim-fail');
    const shimDir = scratch('cmd-shim-fail-path');
    const savedPath = process.env.PATH;
    const savedPathext = process.env.PATHEXT;
    writeCmdShim(shimDir);
    process.env.PATH = shimDir;
    process.env.PATHEXT = '.CMD';
    try {
      const r = await runSquadHealth(project, {
        timeoutMs: 1000,
        maxOutputBytes: 32 * 1024,
        env: fakeOpts('fail', { env: { PATH: shimDir, PATHEXT: '.CMD' } }).env,
      });
      check('Windows squad.cmd shim preserves exit-code-1 health JSON', () => {
        assert.strictEqual(r.available, true, r.reason);
        assert.strictEqual(r.exitCode, 1);
        assert.strictEqual(r.report.status, 'fail');
      });
    } finally {
      process.env.PATH = savedPath;
      if (savedPathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathext;
      cleanup(project, shimDir);
    }
  }

  if (process.platform === 'win32') {
    const savedPath = process.env.PATH;
    const savedPathext = process.env.PATHEXT;
    const exeDir = scratch('exe-path');
    const extlessDir = scratch('extless-path');
    fs.writeFileSync(path.join(exeDir, 'squad.EXE'), '');
    fs.writeFileSync(path.join(extlessDir, 'squad'), '');
    try {
      process.env.PATH = exeDir;
      process.env.PATHEXT = '.EXE';
      const exeFound = findOnPath('squad');
      process.env.PATH = extlessDir;
      process.env.PATHEXT = '.EXE';
      const extlessFound = findOnPath('squad');
      check('Windows PATH lookup still resolves .exe and extensionless squad files', () => {
        assert.strictEqual(exeFound, path.join(exeDir, 'squad.EXE'));
        assert.strictEqual(extlessFound, path.join(extlessDir, 'squad'));
      });
    } finally {
      process.env.PATH = savedPath;
      if (savedPathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathext;
      cleanup(exeDir, extlessDir);
    }
  }

  if (process.platform === 'win32') {
    const project = squadProject('direct-extless-spawn');
    const extlessDir = scratch('direct-extless-path');
    const extlessSquad = path.join(extlessDir, 'squad');
    const savedPath = process.env.PATH;
    const savedPathext = process.env.PATHEXT;
    const originalSpawn = childProcess.spawn;
    const calls = [];
    fs.writeFileSync(extlessSquad, '');
    process.env.PATH = extlessDir;
    process.env.PATHEXT = '.EXE';
    childProcess.spawn = (command, args, opts) => {
      calls.push({ command, args, opts });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 12345 + calls.length;
      process.nextTick(() => {
        if (args.includes('--version')) child.stdout.end('0.13.1\n');
        else child.stdout.end(JSON.stringify({
          schema: 'squad-health/v1',
          status: 'pass',
          checks: [
            { id: 'team', status: 'pass', message: 'ok' },
            { id: 'registry-charters', status: 'pass', message: 'ok' },
            { id: 'routing', status: 'pass', message: 'ok' },
            { id: 'state-backend', status: 'pass', message: 'ok' },
            { id: 'env-vars', status: 'pass', message: 'ok' },
          ],
        }));
        child.emit('close', 0, null);
      });
      return child;
    };
    try {
      const r = await runSquadHealth(project, {
        timeoutMs: 1000,
        maxOutputBytes: 32 * 1024,
        env: fakeOpts('pass', { env: { PATH: extlessDir, PATHEXT: '.EXE' } }).env,
      });
      check('Windows extensionless squad files spawn directly instead of through cmd.exe', () => {
        assert.strictEqual(r.available, true, r.reason);
        assert.ok(calls.length >= 2, 'spawn was not called');
        assert.ok(calls.every((c) => c.command === extlessSquad), JSON.stringify(calls.map((c) => c.command)));
        assert.ok(calls.every((c) => c.opts.windowsVerbatimArguments === false));
      });
    } finally {
      childProcess.spawn = originalSpawn;
      process.env.PATH = savedPath;
      if (savedPathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathext;
      cleanup(project, extlessDir);
    }
  }

  {
    const project = squadProject('schema');
    try {
      const r = await runSquadHealth(project, fakeOpts('wrong-schema'));
      check('wrong squad health schema is rejected', () => {
        assert.strictEqual(r.available, false);
        assert.match(r.reason, /squad-health\/v1 schema/);
      });
    } finally { cleanup(project); }
  }

  {
    const project = squadProject('skip');
    try {
      const r = await runSquadHealth(project, fakeOpts('skip'));
      check('squad health skip checks are parsed without making the report fail', () => {
        assert.strictEqual(r.available, true, r.reason);
        assert.strictEqual(r.report.status, 'pass');
        assert.strictEqual(r.report.checks.find((c) => c.id === 'routing').status, 'skip');
      });
    } finally { cleanup(project); }
  }

  {
    const project = squadProject('cache');
    const countFile = path.join(project, 'count.txt');
    clearSquadHealthCache();
    try {
      const first = getCachedSquadHealth(project, fakeOpts('pass', {
        env: { FAKE_SQUAD_COUNT_FILE: countFile },
      }));
      check('lazy squad health returns unknown immediately instead of blocking session start', () => {
        assert.deepStrictEqual(first, { status: 'unknown' });
      });
      await waitFor(() => getCachedSquadHealth(project, fakeOpts('pass', {
        env: { FAKE_SQUAD_COUNT_FILE: countFile },
      })).status === 'pass');
      const before = Number(fs.readFileSync(countFile, 'utf8'));
      const cached = getCachedSquadHealth(project, fakeOpts('fail', {
        ttlMs: 60 * 1000,
        env: { FAKE_SQUAD_COUNT_FILE: countFile },
      }));
      await sleep(400);
      const after = Number(fs.readFileSync(countFile, 'utf8'));
      check('squad health cache TTL is honored instead of respawning every read', () => {
        assert.strictEqual(cached.status, 'pass');
        assert.strictEqual(after, before);
      });
    } finally {
      clearSquadHealthCache();
      cleanup(project);
    }

    {
      const projects = Array.from({ length: 5 }, (_, i) => squadProject(`cache-prune-${i}`));
      clearSquadHealthCache();
      try {
        for (const project of projects) {
          getCachedSquadHealth(project, fakeOpts('pass', { maxCacheEntries: 3 }));
        }
        await sleep(1200);
        const cappedSize = squadHealthCacheSize();
        const stale = projects[projects.length - 1];
        await waitFor(() => getCachedSquadHealth(stale, fakeOpts('pass', { maxCacheEntries: 3 })).status === 'pass');
        const expired = getCachedSquadHealth(stale, fakeOpts('fail', {
          ttlMs: 1,
          maxCacheEntries: 3,
          now: Date.now() + 5000,
        }));
        const refreshed = await waitFor(() => getCachedSquadHealth(stale, fakeOpts('fail', {
          ttlMs: 60 * 1000,
          maxCacheEntries: 3,
        })).status === 'fail');
        check('squad health cache prunes expired entries and enforces max size', () => {
          assert.ok(cappedSize <= 3, `cache grew to ${cappedSize}`);
          assert.deepStrictEqual(expired, { status: 'unknown' });
          assert.strictEqual(refreshed, true);
          assert.ok(squadHealthCacheSize() <= 3, `cache grew to ${squadHealthCacheSize()}`);
        });
      } finally {
        clearSquadHealthCache();
        cleanup(...projects);
      }
    }
  }

  {
    const project = squadProject('public');
    clearSquadHealthCache();
    try {
      await waitFor(() => getCachedSquadHealth(project, fakeOpts('pass')).status === 'pass');
      const summary = getCachedSquadHealth(project, fakeOpts('pass'));
      check('squad health diagnostics are excluded from the hub summary', () => {
        assert.strictEqual(summary.status, 'pass');
        assert.ok(summary.checks.every((c) => c.id && c.status && !('diagnostics' in c)));
        assert.ok(!JSON.stringify(summary).includes('C:\\secret'), 'a local diagnostic path leaked');
      });
    } finally {
      clearSquadHealthCache();
      cleanup(project);
    }
  }

  {
    const project = squadProject('doctor');
    const savedAgent = process.env.SQUAD_HUB_AGENT;
    process.env.SQUAD_HUB_AGENT = process.execPath;
    try {
      const { runDoctor } = require('../src/doctor');
      const r = await runDoctor({
        cwd: project,
        squadCommand: process.execPath,
        squadArgsPrefix: [FAKE],
        squadHealthEnv: fakeOpts('skip').env,
      });
      check('doctor renders squad health skip as a warning, not a failure', () => {
        const skip = r.checks.find((c) => c.id === 'squad-health:routing');
        assert.strictEqual(skip.level, 'warn');
        assert.strictEqual(skip.squadHealthStatus, 'skip');
        assert.ok(!r.checks.some((c) => c.id === 'squad-health:routing' && c.level === 'fail'));
      });
      const failReport = await runDoctor({
        cwd: project,
        squadCommand: process.execPath,
        squadArgsPrefix: [FAKE],
        squadHealthEnv: fakeOpts('fail').env,
      });
      check('doctor renders failing squad health checks as required failures', () => {
        const envVars = failReport.checks.find((c) => c.id === 'squad-health:env-vars');
        assert.strictEqual(envVars.level, 'fail');
        assert.strictEqual(envVars.squadHealthStatus, 'fail');
        assert.strictEqual(failReport.healthy, false);
      });
    } finally {
      if (savedAgent === undefined) delete process.env.SQUAD_HUB_AGENT; else process.env.SQUAD_HUB_AGENT = savedAgent;
      cleanup(project);
    }
  }

  clearSquadHealthCache();
  await waitFor(() => livePidsFromFile().length === 0, 3000);
  const liveFakePids = livePidsFromFile();
  for (const pid of liveFakePids) { try { process.kill(pid); } catch { /* already gone */ } }
  sweepScratchArtifacts();
  check('fake squad children exit and scratch artifacts are removed', () => {
    assert.deepStrictEqual(liveFakePids, []);
    assert.deepStrictEqual(listScratchArtifacts(), []);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  clearSquadHealthCache();
  killAllSquadHealthProbes();
  sweepScratchArtifacts();
  console.log('[squad-health] ERROR: ' + e.message);
  process.exit(1);
});
