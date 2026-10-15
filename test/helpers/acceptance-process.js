'use strict';
/**
 * Child processes for the acceptance runner (test/acceptance.js).
 *
 * Three things matter here, and none of them is what `spawnSync` gave the old
 * harness for free:
 *
 *   1. The output is the EVIDENCE. The child writes straight into a log file
 *      that lives outside the source tree, so the log grows while the step runs
 *      (a person can read it, and a heartbeat can say what is active), and the
 *      bytes a verdict was read from are exactly the bytes the digest covers.
 *   2. A process this module killed has no verdict. On Windows `taskkill`
 *      leaves an ordinary exit code behind; reporting it would turn a timeout
 *      into "the suite exited 1". `code` is therefore null whenever the run
 *      timed out, was cancelled, was signalled or failed to start, and the
 *      verdict functions refuse such a run.
 *   3. Only OWNED pids are ever signalled. Every process started here is
 *      registered, and cancellation walks that registry; nothing is found by
 *      name, so an unrelated `node` on the machine is never touched.
 */

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// pid -> { cancelled }. Entries live only while the process is running.
const OWNED = new Map();

/** Kill the tree rooted at an OWNED pid. False for any pid this module did not start. */
function killTree(pid) {
  if (!Number.isInteger(pid) || !OWNED.has(pid)) return false;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
      const t = setTimeout(() => {
        if (!OWNED.has(pid)) return;
        try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }, 3000);
      t.unref();
    }
  } catch { /* the process was already gone */ }
  return true;
}

/** Stop every process this module still owns; the number it signalled. */
function killOwned() {
  let n = 0;
  for (const [pid, state] of [...OWNED]) {
    state.cancelled = true;
    if (killTree(pid)) n += 1;
  }
  return n;
}

/** How many processes are running that this module started. */
function ownedCount() { return OWNED.size; }

/**
 * Run one command to completion and never reject.
 *
 * `spec`: `{ command, args, cwd, env, timeoutMs, logPath, onStart }`.
 * Resolves `{ pid, code, rawCode, signal, error, timedOut, cancelled, out,
 * log: { path, bytes, sha256 }, startedAt, finishedAt, durationMs }`.
 */
function runProcess(spec) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let fd = null;
    let child = null;
    let timer = null;
    let settled = false;
    let timedOut = false;
    let spawnError = null;

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const state = child && OWNED.get(child.pid);
      if (child) OWNED.delete(child.pid);
      let buf = Buffer.alloc(0);
      try { buf = fs.readFileSync(spec.logPath); } catch (e) { spawnError = spawnError || e; }
      const cancelled = !!(state && state.cancelled);
      const interrupted = timedOut || cancelled || !!signal || !!spawnError;
      const finishedAt = Date.now();
      resolve({
        pid: child ? child.pid : null,
        code: interrupted || !Number.isInteger(exitCode) ? null : exitCode,
        rawCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal || null,
        error: spawnError,
        timedOut,
        cancelled,
        out: buf.toString('utf8'),
        log: { path: spec.logPath, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') },
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
    };

    try {
      fs.mkdirSync(path.dirname(spec.logPath), { recursive: true });
      // One descriptor for both streams (a fresh file): the child writes the log as it
      // goes, in the order it wrote, with no buffering in this process.
      fd = fs.openSync(spec.logPath, 'w');
      child = spawn(spec.command || process.execPath, spec.args || [], {
        cwd: spec.cwd,
        env: spec.env || process.env,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      spawnError = e;
      finish(null, null);
      return;
    }
    try { fs.closeSync(fd); } catch { /* the child holds its own copy */ }

    if (Number.isInteger(child.pid)) OWNED.set(child.pid, { cancelled: false });
    child.on('error', (e) => { spawnError = e; finish(null, null); });
    child.on('close', (code, signal) => finish(code, signal));
    if (typeof spec.onStart === 'function') { try { spec.onStart(child.pid); } catch { /* progress only */ } }
    if (spec.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, spec.timeoutMs);
    }
  });
}

module.exports = { runProcess, killTree, killOwned, ownedCount };
