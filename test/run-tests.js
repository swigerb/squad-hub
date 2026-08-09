#!/usr/bin/env node
'use strict';
/**
 * The squad-hub test suite.
 *
 * The two criteria that decide this sprint are not "the daemon starts". They
 * are the two ways a supervisor betrays you:
 *
 *   1. Kill the daemon -> the agent must NOT survive as an orphan.
 *      An abandoned `copilot --acp` holding a repo checkout, invisible to every
 *      surface, is worse than no daemon at all.
 *
 *   2. Kill the agent -> the session must be marked failed within one heartbeat.
 *      A session list that shows "Active" for a process that died ten minutes
 *      ago is a lie, and it is the lie people act on.
 *
 * Both are asserted by OS-level process liveness -- `process.kill(pid, 0)` --
 * not by what the daemon reports about itself. A daemon that has lost track of
 * a child will happily report a tidy shutdown.
 *
 * Every test runs against a private SQUAD_HUB_HOME and a fake ACP agent, so the
 * suite never touches the developer's real daemon and never needs the network.
 */

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');
const FAKE = path.join(__dirname, 'fake-agent.js');

let pass = 0; let fail = 0;
const failures = [];
/** Suites that deliberately did not run. Reported, never counted as passing. */
const skipped = [];

function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; failures.push({ name, error: e.message }); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; failures.push({ name, error: e.message }); console.log(`  FAIL ${name}\n         ${e.message}`); }
}

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

// ===========================================================================

async function suiteLifecycle() {
  console.log('\n[lifecycle] daemon start / status / stop');
  const { home, env } = makeEnv();
  try {
    const before = cli(env, ['status', '--json']);
    check('status exits 3 when no daemon is running', () => {
      assert.strictEqual(before.status, 3, `expected exit 3, got ${before.status}`);
      assert.strictEqual(JSON.parse(before.stdout).running, false);
    });

    const pid = await startDaemon(env);
    check('start produces a live daemon process', () => assert.ok(alive(pid), `pid ${pid} is not alive`));

    const snap = statusJson(env);
    check('status reports running with a device identity', () => {
      assert.strictEqual(snap.running, true);
      assert.ok(snap.device.name, 'no device name');
      assert.strictEqual(snap.device.platform, process.platform);
    });

    check('file access is OFF by default', () => assert.strictEqual(snap.device.fileAccess, 'off'));

    check('the confinement path is NEVER in the reportable view', () => {
      assert.ok(!('filesRoot' in snap.device), 'filesRoot leaked into the device view');
      assert.ok(!JSON.stringify(snap.device).includes(home), 'the home path leaked into the device view');
    });

    await stopDaemon(env);
    check('stop leaves no daemon process', () => assert.ok(!alive(pid), `pid ${pid} survived stop`));
    check('stop removes the state file', () => assert.ok(!fs.existsSync(path.join(home, 'daemon.json'))));
  } finally { cleanup(home); }
}

async function suiteSessionRoundTrip() {
  console.log('\n[session] start a session, approve, observe the SIDE EFFECT');
  const { home, env } = makeEnv();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqwork-'));
  try {
    await startDaemon({ ...env });
    cli(env, ['config', 'show']);
    // Allow a working directory to be chosen at all.
    cli(env, ['reset', '--allow-files-all']);
    await waitFor(() => alive(daemonPid(home)));

    const started = cli(env, ['run', 'do the thing', '--cwd', work]);
    check('run reports a session id', () => assert.match(started.stdout, /session s\d+/, started.stdout + started.stderr));

    const gotApproval = await waitFor(() => {
      const s = statusJson(env);
      return s.sessions && s.sessions.some((x) => x.pendingApprovals.length > 0);
    }, 20000);
    check('the session pauses and surfaces a pending approval', () => assert.ok(gotApproval, 'no approval appeared'));

    const snap = statusJson(env);
    const sess = snap.sessions.find((s) => s.pendingApprovals.length > 0);
    const appr = sess && sess.pendingApprovals[0];

    check('status becomes waiting_approval', () => assert.strictEqual(sess.status, 'waiting_approval'));

    check('the approval carries the LITERAL command, not a summary', () => {
      assert.ok(appr.command, 'no command on the approval');
      assert.match(appr.command, /fake-agent-marker\.txt/, `command was: ${appr.command}`);
    });

    check('the approval carries the paths it touches', () => {
      assert.ok(appr.paths.length > 0, 'no paths extracted');
      assert.ok(appr.paths.some((p) => p.includes('fake-agent-marker.txt')), JSON.stringify(appr.paths));
    });

    check('the approval offers the three protocol options', () => {
      const ids = appr.options.map((o) => o.optionId).sort();
      assert.deepStrictEqual(ids, ['allow_always', 'allow_once', 'reject_once']);
    });

    const marker = path.join(work, 'fake-agent-marker.txt');
    check('nothing has run yet', () => assert.ok(!fs.existsSync(marker), 'the tool ran BEFORE it was approved'));

    const app = cli(env, ['approve', sess.id, appr.approvalId, 'allow_once']);
    check('approve is accepted', () => assert.strictEqual(app.status, 0, app.stdout + app.stderr));

    const ran = await waitFor(() => fs.existsSync(marker), 15000);
    check('APPROVE ran the tool - proven by the side effect on disk', () => assert.ok(ran, 'marker never appeared'));

    const done = await waitFor(() => {
      const s = statusJson(env);
      return s.sessions && s.sessions.some((x) => x.id === sess.id && x.status === 'done');
    }, 15000);
    check('the session reaches done', () => assert.ok(done, 'session never completed'));

    await stopDaemon(env);
  } finally { cleanup(home); cleanup(work); }
}

async function suiteDeny() {
  console.log('\n[session] deny stops the tool');
  const { home, env } = makeEnv();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqwork-'));
  try {
    await startDaemon(env);
    cli(env, ['reset', '--allow-files-all']);
    await waitFor(() => alive(daemonPid(home)));
    cli(env, ['run', 'do the thing', '--cwd', work]);

    await waitFor(() => statusJson(env).sessions.some((x) => x.pendingApprovals.length > 0), 20000);
    const sess = statusJson(env).sessions.find((s) => s.pendingApprovals.length > 0);
    const appr = sess.pendingApprovals[0];

    cli(env, ['approve', sess.id, appr.approvalId, 'reject_once']);
    await sleep(2500);

    const marker = path.join(work, 'fake-agent-marker.txt');
    check('DENY did not run the tool - proven by the absence of the side effect', () => {
      assert.ok(!fs.existsSync(marker), `the tool RAN ANYWAY. dir: ${fs.readdirSync(work).join(',')}`);
    });

    check('the working directory is genuinely empty', () => {
      assert.deepStrictEqual(fs.readdirSync(work), [], 'unexpected files appeared');
    });

    await stopDaemon(env);
  } finally { cleanup(home); cleanup(work); }
}

async function suiteRejectsUnknownOption() {
  console.log('\n[session] an option the agent never offered is refused');
  const { home, env } = makeEnv();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqwork-'));
  try {
    await startDaemon(env);
    cli(env, ['reset', '--allow-files-all']);
    await waitFor(() => alive(daemonPid(home)));
    cli(env, ['run', 'do the thing', '--cwd', work]);
    await waitFor(() => statusJson(env).sessions.some((x) => x.pendingApprovals.length > 0), 20000);
    const sess = statusJson(env).sessions.find((s) => s.pendingApprovals.length > 0);
    const appr = sess.pendingApprovals[0];

    const r = cli(env, ['approve', sess.id, appr.approvalId, 'allow_forever_muahaha']);
    check('a forged option id is rejected', () => assert.notStrictEqual(r.status, 0, 'a made-up option was accepted'));

    const marker = path.join(work, 'fake-agent-marker.txt');
    check('the forged option did not run the tool', () => assert.ok(!fs.existsSync(marker)));

    await stopDaemon(env);
  } finally { cleanup(home); cleanup(work); }
}

// ---------------------------------------------------------------------------
// CRITERION 1 -- the orphan gate.
// ---------------------------------------------------------------------------
async function suiteOrphanOnGracefulStop() {
  console.log('\n[ORPHAN GATE] stopping the daemon must not orphan the agent');
  const { home, env } = makeEnv();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqwork-'));
  try {
    await startDaemon(env);
    cli(env, ['reset', '--allow-files-all']);
    await waitFor(() => alive(daemonPid(home)));
    cli(env, ['run', 'do the thing', '--cwd', work]);

    await waitFor(() => statusJson(env).sessions.length > 0, 20000);
    const agentPid = statusJson(env).sessions[0].pid;
    check('the agent process is running', () => assert.ok(alive(agentPid), `agent pid ${agentPid} not alive`));

    await stopDaemon(env);
    const reaped = await waitFor(() => !alive(agentPid), 10000);
    check('GRACEFUL STOP: the agent process is gone', () => {
      assert.ok(reaped, `ORPHAN: agent pid ${agentPid} survived the daemon stopping`);
    });
  } finally { cleanup(home); cleanup(work); }
}

async function suiteOrphanOnHardKill() {
  console.log('\n[ORPHAN GATE] SIGKILLing the daemon must not leave an agent running forever');
  const { home, env } = makeEnv();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqwork-'));
  try {
    const dpid = await startDaemon(env);
    cli(env, ['reset', '--allow-files-all']);
    await waitFor(() => alive(daemonPid(home)));
    const dpid2 = daemonPid(home);
    cli(env, ['run', 'do the thing', '--cwd', work]);
    await waitFor(() => statusJson(env).sessions.length > 0, 20000);
    const agentPid = statusJson(env).sessions[0].pid;

    // The brutal case: no chance to clean up.
    try { process.kill(dpid2, 'SIGKILL'); } catch { /* already gone */ }
    try { if (dpid !== dpid2) process.kill(dpid, 'SIGKILL'); } catch { /* gone */ }
    await waitFor(() => !alive(dpid2), 6000);

    check('the daemon is dead', () => assert.ok(!alive(dpid2), 'daemon survived SIGKILL'));
    const survived = alive(agentPid);
    check('the orphan is recorded on disk so it can be found', () => {
      const kids = JSON.parse(fs.readFileSync(path.join(home, 'children.json'), 'utf8'));
      assert.ok(kids.some((k) => k.pid === agentPid), `child ${agentPid} was not recorded: ${JSON.stringify(kids)}`);
    });

    // The recovery guarantee: the next daemon reaps what the last one abandoned.
    await startDaemon(env);
    const reaped = await waitFor(() => !alive(agentPid), 12000);
    check('HARD KILL: the next daemon start reaps the orphan', () => {
      assert.ok(reaped, `ORPHAN SURVIVED: agent pid ${agentPid} still running after a fresh daemon start (was alive after kill: ${survived})`);
    });

    await stopDaemon(env);
  } finally { cleanup(home); cleanup(work); }
}

/**
 * The orphan mechanisms, tested directly rather than through the OS.
 *
 * The end-to-end tests above cannot fail on Windows: libuv puts children in a
 * job object that dies with the parent, so the agent is cleaned up whether or
 * not our code does anything (proven in test/platform-orphan-probe.js). On
 * Linux -- which is what ACA and AKS run -- there is no such safety net.
 *
 * This suite spawns DETACHED children that escape the job object, so a pass
 * means our code did the killing.
 */
async function suiteOrphanMechanisms() {
  console.log('\n[ORPHAN GATE] the mechanisms themselves, with no OS safety net');
  runChildSuite(path.join(__dirname, 'orphan-unit.js'), 'orphan');
}

/** Runs a child test file that reports through the RESULT contract. */
function runChildSuite(file, label) {
  const r = spawnSync(process.execPath, [file], {
    encoding: 'utf8', timeout: 120000, env: process.env, windowsHide: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const results = out.split('\n').filter((l) => l.startsWith('RESULT\t')).map((l) => l.split('\t'));

  if (!results.length) {
    fail += 1;
    const name = `${label}: the child suite produced parseable results`;
    failures.push({ name, error: `no RESULT lines; exit=${r.status}. ${out.slice(-300)}` });
    console.log(`  FAIL ${name}  (exit=${r.status})`);
    return;
  }
  for (const [, verdict, name, why] of results) {
    if (verdict === 'ok') { pass += 1; console.log(`  ok   ${name}`); }
    else if (verdict === 'skip') {
      // A suite may legitimately not run -- the browser tests need Playwright,
      // which is deliberately not a dependency. That must not fail the run, and
      // it must not silently look like a pass either: it is counted separately
      // and named again in the summary, because "270 passed" while a whole
      // suite quietly did nothing is the reporting failure worth avoiding.
      skipped.push(name);
      console.log(`  SKIP ${name}`);
    } else { fail += 1; failures.push({ name, error: why || 'failed' }); console.log(`  FAIL ${name}\n         ${why || ''}`); }
  }
  const anyFailed = results.some(([, v]) => v === 'fail');
  if (r.status !== 0 && !anyFailed) {
    fail += 1;
    const name = `${label}: the child suite exited cleanly`;
    // The child's own output goes in the message. Without it this branch said
    // only "exit=77 with no failing result", which names the symptom and
    // discards the one thing that explains it -- the child prints its error
    // before exiting, and that line was being thrown away. An intermittent
    // failure you cannot read is one you can only guess at.
    failures.push({ name, error: `exit=${r.status} with no failing result. Child output:\n${out.slice(-600)}` });
    console.log(`  FAIL ${name}  (exit=${r.status})\n         ${out.slice(-600)}`);
  }
}

// ---------------------------------------------------------------------------
// CRITERION 2 -- a dead agent must not read as Active.
//
// TWO independent mechanisms cover this, and they are NOT interchangeable:
//
//   a) the child's 'exit' event  -- only fires for a process the daemon parented
//   b) the heartbeat's liveness poll -- the only thing that covers a session the
//      daemon did not spawn (re-adoption, inheritance from a prior daemon)
//
// The end-to-end test below exercises (a). Mutation testing proved it does NOT
// exercise (b): disabling the heartbeat check left the suite green, because the
// exit event reached the session first. So (b) gets its own isolated test.
// ---------------------------------------------------------------------------
async function suiteDeadAgentDetected() {
  console.log('\n[HEARTBEAT GATE] killing the agent must mark the session failed');
  const { home, env } = makeEnv({ FAKE_AGENT_MODE: 'hang' });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sqwork-'));
  try {
    await startDaemon(env);
    cli(env, ['reset', '--allow-files-all']);
    await waitFor(() => alive(daemonPid(home)));
    cli(env, ['run', 'do the thing', '--cwd', work]);
    await waitFor(() => statusJson(env).sessions.length > 0, 20000);

    const before = statusJson(env).sessions[0];
    const agentPid = before.pid;
    check('the session is live before the kill', () => {
      assert.ok(['starting', 'active', 'waiting_approval'].includes(before.status), `status was ${before.status}`);
    });

    try { process.kill(agentPid, 'SIGKILL'); } catch { /* gone */ }
    await waitFor(() => !alive(agentPid), 6000);

    const flipped = await waitFor(() => {
      const s = statusJson(env).sessions.find((x) => x.id === before.id);
      return s && s.status === 'failed';
    }, 25000);

    check('a dead agent is reported as FAILED, not Active', () => {
      const s = statusJson(env).sessions.find((x) => x.id === before.id);
      assert.ok(flipped, `session still reads '${s && s.status}' after its agent was killed`);
    });

    check('the failure says why', () => {
      const s = statusJson(env).sessions.find((x) => x.id === before.id);
      assert.ok(s.error && s.error.length > 0, 'failed with no explanation');
    });

    await stopDaemon(env);
  } finally { cleanup(home); cleanup(work); }
}

/**
 * The heartbeat in isolation, for a session the daemon never spawned -- the
 * case the end-to-end test cannot reach, because there the 'exit' event always
 * wins the race.
 */
async function suiteHeartbeatIsolated() {
  console.log('\n[HEARTBEAT GATE] the heartbeat itself, with no exit event to help it');
  runChildSuite(path.join(__dirname, 'heartbeat-unit.js'), 'heartbeat');
}

// ---------------------------------------------------------------------------
// File access confinement.
// ---------------------------------------------------------------------------
async function suiteFileAccess() {
  console.log('\n[file access] off by default, and scoped means scoped');
  const { home, env } = makeEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqroot-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sqout-'));
  const inside = path.join(root, 'nested');
  fs.mkdirSync(inside);
  try {
    await startDaemon(env);
    const denied = cli(env, ['run', 'x', '--cwd', outside]);
    check('with file access OFF, a working directory is refused', () => {
      assert.notStrictEqual(denied.status, 0, 'a cwd was accepted while file access was off');
      assert.match(denied.stderr + denied.stdout, /file access is off/i);
    });
    await stopDaemon(env);

    // Scope to `root` by running reset from there.
    cli(env, ['reset', '--allow-files'], { cwd: root });
    await waitFor(() => alive(daemonPid(home)), 10000);

    const snap = statusJson(env);
    check('scoped access reports as scoped', () => assert.strictEqual(snap.device.fileAccess, 'scoped'));
    check('the confinement root still never appears in the device view', () => {
      assert.ok(!JSON.stringify(snap.device).includes(root), 'the root path leaked');
    });

    const ok = cli(env, ['run', 'x', '--cwd', inside]);
    check('a directory inside the root is allowed', () => assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr));

    const esc = cli(env, ['run', 'x', '--cwd', outside]);
    check('a directory outside the root is refused', () => {
      assert.notStrictEqual(esc.status, 0, 'escaped the confinement root');
      assert.match(esc.stderr + esc.stdout, /outside/i);
    });

    const traversal = cli(env, ['run', 'x', '--cwd', path.join(root, '..', path.basename(outside))]);
    check('.. traversal out of the root is refused', () => {
      assert.notStrictEqual(traversal.status, 0, 'traversal escaped the confinement root');
    });

    await stopDaemon(env);
  } finally { cleanup(home); cleanup(root); cleanup(outside); }
}

async function suiteConfig() {
  console.log('\n[config] reset returns to factory defaults');
  const { home, env } = makeEnv();
  try {
    await startDaemon(env);
    cli(env, ['track-all', 'on']);
    await waitFor(() => alive(daemonPid(home)), 10000);
    check('track-all on persists', () => {
      const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
      assert.strictEqual(c.trackAll, true);
    });

    cli(env, ['reset']);
    await waitFor(() => alive(daemonPid(home)), 10000);
    check('reset clears track-all', () => {
      const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
      assert.strictEqual(c.trackAll, false);
    });
    check('reset turns file access back OFF', () => {
      const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
      assert.strictEqual(c.allowFiles, false);
      assert.strictEqual(c.allowFilesAll, false);
    });
    await stopDaemon(env);
  } finally { cleanup(home); }
}

async function suiteIsolation() {
  console.log('\n[isolation] two homes are two devices');
  const a = makeEnv();
  const b = makeEnv();
  try {
    const pa = await startDaemon(a.env);
    const pb = await startDaemon(b.env);
    check('two daemons run concurrently without colliding', () => {
      assert.notStrictEqual(pa, pb);
      assert.ok(alive(pa) && alive(pb));
    });
    check('each reports only its own state', () => {
      assert.strictEqual(statusJson(a.env).device.pid, pa);
      assert.strictEqual(statusJson(b.env).device.pid, pb);
    });
    await stopDaemon(a.env);
    check('stopping one leaves the other running', () => assert.ok(!alive(pa) && alive(pb)));
    await stopDaemon(b.env);
  } finally { cleanup(a.home); cleanup(b.home); }
}

/**
 * Two real principals, two real daemons, one real
 * service. If this suite ever goes red, nothing internet-reachable ships.
 */
async function suiteUserIsolation() {
  console.log('\n[ISOLATION GATE] two identities must not see each other');
  runChildSuite(path.join(__dirname, 'isolation-unit.js'), 'isolation');
}

/**
 * Sprints 3 and 4: the product claim, end to end. An agent pauses on a device,
 * the pause reaches the hub, a remote surface answers it, and the agent
 * actually proceeds -- or actually does not.
 */
async function suiteEndToEnd() {
  console.log('\n[END TO END] hub -> daemon -> agent, and back');
  runChildSuite(path.join(__dirname, 'e2e-unit.js'), 'e2e');
}

/**
 * The hub is a cache, not the record.
 *
 * A pending approval survives a hub restart because the DEVICE holds it -- the
 * agent process never noticed the hub go away, and its RPC request stays open.
 * That is what lets the service be redeployed mid-working-day without
 * interrupting anything, and it is easy to break accidentally by moving
 * authority into the service.
 */
async function suiteRestartRecovery() {
  console.log('\n[RECOVERY] a pending approval survives a hub restart');
  runChildSuite(path.join(__dirname, 'restart-unit.js'), 'recovery');
}

/**
 * What makes this Squad Hub rather than a session dashboard.
 * Tested against a real .squad/ directory where one exists on the machine.
 */
async function suiteSquadContext() {
  console.log('\n[SQUAD AWARENESS] reading .squad/ team, decisions, and models');
  runChildSuite(path.join(__dirname, 'squad-context-unit.js'), 'squad');
}

/**
 * Teams notification. Delivery is tested against a real HTTP server
 * that captures the bytes, and redaction is asserted against real secret shapes.
 */
async function suiteTeams() {
  console.log('\n[TEAMS] approval cards, redaction, and delivery');
  runChildSuite(path.join(__dirname, 'teams-unit.js'), 'teams');
}

/**
 * GitHub as an identity provider. Exists because an Entra app registration
 * needs tenant-admin cooperation many people cannot get, and without an
 * alternative they are stuck on a shared secret.
 */
async function suiteGitHubAuth() {
  console.log('\n[GITHUB AUTH] a GitHub token as a sign-in');
  runChildSuite(path.join(__dirname, 'github-auth-unit.js'), 'github');
runChildSuite(path.join(__dirname, 'device-token-unit.js'), 'device-tokens');
runChildSuite(path.join(__dirname, 'oneshot-unit.js'), 'oneshot');
runChildSuite(path.join(__dirname, 'browser-e2e-unit.js'), 'browser');
}

/**
 * E2: automatic, per-session Squad custom-agent selection. Precedence
 * (explicit > project > auto > default), .squad-hub.json schema/validation,
 * array-safe argv building, and a real daemon proving selection happens per
 * session rather than once at daemon startup.
 */
async function suiteAgentSelect() {
  console.log('\n[AGENT SELECT] explicit > project > auto > default, per session');
  runChildSuite(path.join(__dirname, 'agent-select-unit.js'), 'agent-select');
}

/**
 * E1: the one-time `squad-hub connect`. Argument/URL validation, a real hub
 * accepting a valid device token, a real refusal, and -- the property that
 * matters most -- a hub that never completes the handshake must never be
 * reported as connected.
 */
async function suiteConnect() {
  console.log('\n[CONNECT] one-time setup: validate, attach, never lie about it');
  runChildSuite(path.join(__dirname, 'connect-unit.js'), 'connect');
}

/**
 * E4: the interactive local terminal. Scripted stdin against a real daemon
 * and a real fake agent, asserting a genuine tool side effect after an
 * approval -- and the two-stage Ctrl+C safety behaviour, which never kills a
 * running session out from under you.
 */
async function suiteInteractive() {
  console.log('\n[INTERACTIVE] a plain terminal over the same session the Hub sees');
  runChildSuite(path.join(__dirname, 'interactive-unit.js'), 'interactive');
}

/**
 * E5: optional login-startup service management. Every assertion here uses
 * --dry-run / {dryRun:true} -- this suite must never register a real login
 * task on the machine that runs it.
 */
async function suiteServiceInstall() {
  console.log('\n[SERVICE INSTALL] login-startup, dry-run only, never touches the machine');
  runChildSuite(path.join(__dirname, 'service-install-unit.js'), 'service-install');
}

/**
 * E6: `squad-hub doctor`. Deterministic PATH manipulation drives the
 * Copilot-CLI check; the property that matters is that a `fail` always
 * yields a nonzero exit code and a `warn` never does.
 */
async function suiteDoctor() {
  console.log('\n[DOCTOR] one command, every independent health check');
  runChildSuite(path.join(__dirname, 'doctor-unit.js'), 'doctor');
}

/**
 * The intended fresh workflow, end to end: an isolated SQUAD_HUB_HOME with
 * nothing configured yet, through connect, auto-detected Squad selection,
 * a session started and visible in the hub, an approval answered remotely,
 * and a genuine tool side effect -- the whole E1-E4 story in one pass.
 */
async function suiteFreshWorkflow() {
  console.log('\n[FRESH WORKFLOW] connect -> attach -> auto-detect -> run -> approve -> effect');
  runChildSuite(path.join(__dirname, 'fresh-workflow-unit.js'), 'fresh-workflow');
}

/**
 * B1's transcript cursor (proven directly against AcpSession/Daemon, not
 * through the interactive terminal), N4's stale-daemon-cwd fallback, and the
 * hub spawn/local start-session result-shape symmetry suggestion.
 */
async function suiteDaemonFixes() {
  console.log('\n[DAEMON FIXES] transcript cursor survives a cap slide; cwd fallback is never process.cwd()');
  runChildSuite(path.join(__dirname, 'daemon-fixes-unit.js'), 'daemon-fixes');
}

/**
 * N6: noninteractive `run`/`squad "<prompt>"` must never be silent about a
 * hub that is configured but not actually attached -- refused, connecting,
 * and connected/not-configured all read differently on stderr.
 */
async function suiteHubWarning() {
  console.log('\n[HUB WARNING] `run`/`squad` never silent about a configured-but-unattached hub');
  runChildSuite(path.join(__dirname, 'hub-warning-unit.js'), 'hub-warning');
  runChildSuite(path.join(__dirname, 'hub-link-unit.js'), 'hub-link');
}

/**
 * Documentation, checked against the code. Prose drifts silently; a renamed
 * command or an undocumented variable fails no build and wastes an afternoon.
 */
async function suiteDocs() {
  console.log('\n[DOCS] every promise kept, every variable documented');
  runChildSuite(path.join(__dirname, 'docs-unit.js'), 'docs');
}

/**
 * The shipped artefact, not the working tree. A green suite proves the code
 * works where the tests run; it says nothing about what a consumer installs.
 */
async function suitePackage() {
  console.log('\n[PACKAGE] what actually ships is what the server needs');
  runChildSuite(path.join(__dirname, 'package-unit.js'), 'package');
}

/**
 * The command surface itself: the verbs and global options a person types.
 * `autostart` had to arrive without breaking the three older spellings, and a
 * global option has to mean the same thing on either side of the subcommand.
 */
async function suiteCliParity() {
  console.log('\n[CLI PARITY] autostart, config edit/env, --env, --no-config-cache');
  runChildSuite(path.join(__dirname, 'cli-parity-unit.js'), 'cli-parity');
}

/**
 * Stored XSS (Opus review, HIGH): `.squad-hub.json` agent/model ->
 * `agentSelection` -> the hub -> `web/app.js`'s `sessionRow`. Proven directly
 * against the file's pure, DOM-free prefix -- no jsdom, per the zero-runtime-
 * dependency constraint -- a malicious agent/model/source must render as
 * inert escaped text, never live markup.
 */
async function suiteWebXss() {
  console.log('\n[WEB XSS] agentSelection fields render as text, never live markup');
  runChildSuite(path.join(__dirname, 'web-xss-unit.js'), 'web-xss');
}

/**
 * Session metadata: repository and branch read from the checkout, the live
 * activity line, the badge set, and the ordering that pulls a blocked session
 * to the top. Every new field reaching the DOM carries its own stored-XSS
 * case -- a branch name is attacker-influenceable, git permits any bytes.
 */
async function suiteSessionMetadata() {
  console.log('\n[SESSION METADATA] repository, branch, activity, badges, ordering');
  runChildSuite(path.join(__dirname, 'session-metadata-unit.js'), 'session-metadata');
}

/**
 * The list controls -- time window, grouping, sort, repository/organisation
 * scope and pinning. All pure functions, proven in Node without a browser,
 * because a rule that lives inside a DOM callback cannot be proven at all.
 */
async function suiteListControls() {
  console.log('\n[LIST CONTROLS] window, grouping, sort, scope, pinning');
  runChildSuite(path.join(__dirname, 'list-controls-unit.js'), 'list-controls');
}

/**
 * The device roster: ordering, presence wording, load meters, and the
 * telemetry that feeds them -- which is off by default, like every other thing
 * the daemon could report about the machine it runs on.
 */
async function suiteDeviceRoster() {
  console.log('\n[DEVICE ROSTER] cloud first, presence, meters, telemetry');
  runChildSuite(path.join(__dirname, 'device-roster-unit.js'), 'device-roster');
}

/**
 * Control verification. The composer stays disabled until the DEVICE confirms
 * it can take input -- the hub knowing about a session proves only that a
 * heartbeat once mentioned it. Same shape as the HTTP-101 handshake race.
 */
async function suiteControlVerification() {
  console.log('\n[CONTROL] disabled until the device itself says otherwise');
  runChildSuite(path.join(__dirname, 'control-verification-unit.js'), 'control');
}

/**
 * Approval depth and the composer's agent/model selection. Reading a file and
 * rewriting a directory are not the same decision, and a standing permission
 * that does not say what it makes standing is a blank cheque.
 */
async function suiteApprovalDepth() {
  console.log('\n[APPROVAL DEPTH] read-only badges, standing rules, agent/model');
  runChildSuite(path.join(__dirname, 'approval-depth-unit.js'), 'approval-depth');
}

/**
 * The channel a caller uses to impose a TOOL POLICY on the agent. Squad on ACA
 * resolves permissions in one reviewable place and passes them as argv, and
 * its deny patterns contain spaces -- so the channel has to preserve an
 * argument exactly, and must never drop the protocol flag or silently ignore
 * a policy it was handed.
 */
async function suiteAgentArgs() {
  console.log('\n[AGENT ARGS] a tool policy survives transport, or nothing starts');
  runChildSuite(path.join(__dirname, 'agent-args-unit.js'), 'agent-args');
}

/**
 * Removing the record of ended sessions. A tidy-up button that can reach live
 * work is a remote kill with a friendly label, so most of what is proven here
 * is what `forget` REFUSES -- above all, never deleting the record of a
 * session whose agent process is still alive.
 */
async function suiteForget() {
  console.log('\n[FORGET] ended sessions only, never a live one, never an orphan');
  runChildSuite(path.join(__dirname, 'forget-unit.js'), 'forget');
}

/**
 * The parity checklist, checked against the code. Catches a capability being
 * removed or renamed while its tests go with it -- the one way a green suite
 * can coexist with a lost feature.
 */
async function suiteParityAudit() {
  console.log('\n[PARITY] every item on the checklist is still built, and still tested');
  runChildSuite(path.join(__dirname, 'parity-audit-unit.js'), 'parity');
}

/**
 * The agent and model a session actually gets. `copilot --acp` accepts
 * `--agent` and `--model` and silently ignores both, so the selection has to
 * be made over the protocol -- and what was granted has to be reported, not
 * assumed from what was asked.
 */
async function suiteAgentApply() {
  console.log('\n[AGENT] the selection is applied over the protocol, and reported honestly');
  runChildSuite(path.join(__dirname, 'agent-apply-unit.js'), 'agent-apply');
}

// ===========================================================================

(async () => {
  console.log('squad-hub test suite');
  console.log('='.repeat(60));
  const t0 = Date.now();

  await suiteLifecycle();
  await suiteSessionRoundTrip();
  await suiteDeny();
  await suiteRejectsUnknownOption();
  await suiteOrphanOnGracefulStop();
  await suiteOrphanOnHardKill();
  await suiteOrphanMechanisms();
  await suiteDeadAgentDetected();
  await suiteHeartbeatIsolated();
  await suiteFileAccess();
  await suiteConfig();
  await suiteIsolation();
  await suiteUserIsolation();
  await suiteEndToEnd();
  await suiteRestartRecovery();
  await suiteSquadContext();
  await suiteTeams();
  await suiteGitHubAuth();
  await suiteAgentSelect();
  await suiteConnect();
  await suiteInteractive();
  await suiteServiceInstall();
  await suiteDoctor();
  await suiteFreshWorkflow();
  await suiteDaemonFixes();
  await suiteHubWarning();
  await suiteCliParity();
  await suiteDocs();
  await suitePackage();
  await suiteWebXss();
  await suiteSessionMetadata();
  await suiteListControls();
  await suiteDeviceRoster();
  await suiteControlVerification();
  await suiteApprovalDepth();
  await suiteForget();
  await suiteAgentArgs();
  await suiteParityAudit();
  await suiteAgentApply();

  console.log('');
  console.log('='.repeat(60));
  console.log(`${pass} passed, ${fail} failed${skipped.length ? `, ${skipped.length} SKIPPED` : ''}  (${Math.round((Date.now() - t0) / 1000)}s)`);
if (skipped.length) {
  // Named again, so a green run cannot be mistaken for a complete one.
  console.log('\nSKIPPED (not checked at all):');
  for (const s of skipped) console.log(` - ${s}`);
}
  if (fail) {
    console.log('\nFAILURES');
    for (const f of failures) console.log(` - ${f.name}\n   ${f.error}`);
  }
  process.exit(fail ? 1 : 0);
})();
