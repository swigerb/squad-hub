'use strict';
/**
 * An isolated device for the suites that drive the real CLI and daemon: a
 * private home, a private IPC endpoint and the fake ACP agent. Shared by
 * test/run-tests.js and by the standalone suites extracted from it, so a
 * suite run alone sets up exactly what it did inside the full run.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');
const FAKE = path.join(__dirname, '..', 'fake-agent.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function waitFor(fn, ms = 15000, step = 100) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) return false;
    await sleep(step);
  }
}

/** An isolated device: private home, private IPC endpoint, fake agent. */
function makeEnv(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhub-'));
  return {
    home,
    env: {
      ...process.env,
      SQUAD_HUB_HOME: home,
      SQUAD_HUB_AGENT: process.execPath,
      SQUAD_HUB_AGENT_ARGS: FAKE,
      FAKE_AGENT_MODE: 'approve-gate',
      ...extra,
    },
  };
}

function cli(env, args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env, encoding: 'utf8', cwd: opts.cwd || ROOT, timeout: opts.timeout || 30000,
  });
}

function statusJson(env) {
  const r = cli(env, ['status', '--json']);
  try { return JSON.parse(r.stdout); } catch { return { running: false, _raw: r.stdout, _err: r.stderr }; }
}

function daemonPid(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8')).pid; } catch { return null; }
}

async function startDaemon(env) {
  const r = cli(env, ['start']);
  const ok = await waitFor(() => !!daemonPid(env.SQUAD_HUB_HOME) && alive(daemonPid(env.SQUAD_HUB_HOME)));
  if (!ok) throw new Error(`daemon did not start: ${r.stdout} ${r.stderr}`);
  return daemonPid(env.SQUAD_HUB_HOME);
}

async function stopDaemon(env) {
  cli(env, ['stop']);
  await waitFor(() => !alive(daemonPid(env.SQUAD_HUB_HOME)), 8000);
}

/**
 * Windows holds a lock briefly after a process exits, so a single rmSync races
 * and leaves temp directories behind. Retry, then give up quietly -- a test
 * suite that fails on its own cleanup teaches you nothing.
 */
function cleanup(home) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(home, { recursive: true, force: true }); return; }
    catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},150)']); }
  }
}

/**
 * The RESULT contract run-tests.js reads from a child suite: `check` /
 * `checkAsync` print `RESULT\t<ok|fail>\t<name>[\t<why>]`, and `finish()` prints
 * the final "N passed, M failed" line and sets the exit status.
 */
function resultReporter() {
  let pass = 0; let fail = 0;
  const report = (name, e) => {
    if (!e) { pass += 1; console.log(`  ok   ${name}`); console.log(`RESULT\tok\t${name}`); return; }
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  };
  return {
    check(name, fn) { try { fn(); report(name); } catch (e) { report(name, e); } },
    async checkAsync(name, fn) { try { await fn(); report(name); } catch (e) { report(name, e); } },
    finish() {
      console.log(`\n${pass} passed, ${fail} failed`);
      process.exitCode = fail ? 1 : 0;
    },
    failures: () => fail,
  };
}

module.exports = {
  ROOT, BIN, FAKE, sleep, alive, waitFor, makeEnv, cli, statusJson, daemonPid, startDaemon, stopDaemon, cleanup,
  resultReporter,
};
