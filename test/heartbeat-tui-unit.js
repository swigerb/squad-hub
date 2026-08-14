#!/usr/bin/env node
'use strict';
/**
 * The outage a supervised TUI session caused on a real machine.
 *
 * Reported live: a session started with `squad-hub squad --tui`, the device
 * went offline seconds later, the session froze at "Working" forever, and every
 * tool call afterwards turned into a local approval prompt.
 *
 * Two distinct defects, and the second is the more dangerous of the pair.
 *
 * 1. THE HEARTBEAT KILLED THE DAEMON.
 *
 *    `beat()` calls `isAgentDead()` on every live session. `TuiSession` was
 *    added without it, so the first heartbeat after a terminal session
 *    registered threw inside a `setInterval` callback -- an uncaught exception,
 *    which took the whole daemon with it. The device went offline, and nothing
 *    in the symptom pointed anywhere near a heartbeat.
 *
 * 2. AN UNREACHABLE DAEMON PUT A PROMPT ON EVERY COPILOT SESSION.
 *
 *    The hook file is user-level: it runs for every Copilot session on the
 *    machine. With the daemon down, `preToolUse` answered "ask" for all of
 *    them -- supervising nothing while making every tool call in every project
 *    require a manual approval. That is more restrictive than not installing
 *    the hooks at all.
 *
 *    The rule is now: interpose only on sessions the hub is genuinely
 *    supervising. Where it is supervising, a failure still means "ask" and
 *    never "allow".
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqbeat-'));
process.env.SQUAD_HUB_HOME = HOME;

const { Daemon } = require(path.join(__dirname, '..', 'src', 'daemon'));
const { TuiSession } = require(path.join(__dirname, '..', 'src', 'tui-session'));
const { STATUS } = require(path.join(__dirname, '..', 'src', 'acp-session'));
const hooks = require(path.join(__dirname, '..', 'src', 'hooks'));

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

function tui(over = {}) {
  return new TuiSession({
    id: 't001', copilotId: 'copilot-abc', cwd: 'C:\\work', ...over,
  });
}

// ---------------------------------------------------------------------------
// 1. The heartbeat
// ---------------------------------------------------------------------------

check('A WATCHED SESSION ANSWERS EVERYTHING THE HEARTBEAT ASKS IT', () => {
  // The contract, asserted directly. Adding a session type without these is
  // what took the device down.
  const s = tui();
  for (const m of ['isAgentDead', '_setStatus', 'toJSON', 'answer']) {
    assert.strictEqual(typeof s[m], 'function', `TuiSession has no ${m}(), which beat() calls`);
  }
});

check('a watched session is never reported as having a dead agent', () => {
  // There is no process here. Guessing "dead" would mark a perfectly live
  // terminal session as Failed on its first heartbeat.
  const s = tui();
  assert.strictEqual(s.isAgentDead(), false);
});

check('THE HEARTBEAT SURVIVES A SESSION THAT THROWS', () => {
  // The deeper fault. One session must not be able to kill the daemon, and
  // with it every other session, the hub connection, and the device.
  const d = new Daemon({ hubUrl: null });
  const bad = tui({ id: 'bad' });
  bad.isAgentDead = () => { throw new Error('this session is broken'); };
  d.sessions.set('bad', bad);
  const good = tui({ id: 'good', copilotId: 'copilot-good' });
  d.sessions.set('good', good);

  assert.doesNotThrow(() => d.beat(), 'one broken session still takes the daemon down');
  assert.strictEqual(d.beats, 1, 'the heartbeat did not complete');
  assert.strictEqual(good.status, STATUS.ACTIVE, 'a healthy session was disturbed by a broken one');
});

check('a heartbeat over a registered TUI session does not throw', () => {
  // The exact sequence that happened: register through the daemon, then beat.
  const d = new Daemon({ hubUrl: null });
  d.registerTuiSession({ copilotId: 'copilot-xyz', cwd: 'C:\\work', source: 'new' });
  assert.doesNotThrow(() => d.beat(), 'the first heartbeat after registering a TUI session threw');
  assert.doesNotThrow(() => d.beat(), 'a later heartbeat threw');
});

check('the sweep still marks a REAL dead agent as failed', () => {
  // The guard must not have turned the heartbeat into a no-op.
  const d = new Daemon({ hubUrl: null });
  const s = tui({ id: 'acp-like' });
  s.isAgentDead = () => true;
  d.sessions.set('acp-like', s);
  d.beat();
  assert.strictEqual(s.status, STATUS.FAILED, 'a dead agent was not marked failed');
});

// ---------------------------------------------------------------------------
// 2. Only interpose where the hub is actually supervising
// ---------------------------------------------------------------------------

check('a session is recorded as supervised only when registration succeeded', () => {
  const id = 'sess-supervised';
  assert.strictEqual(hooks.isSupervised(id), false, 'a session is supervised before anything registered it');
  hooks.markSupervised(id);
  assert.strictEqual(hooks.isSupervised(id), true);
  hooks.clearSupervised(id);
  assert.strictEqual(hooks.isSupervised(id), false, 'the record outlived the session');
});

check('A SESSION ID THAT IS NOT PLAINLY SAFE NEVER REACHES A FILE PATH', () => {
  // The id arrives from outside this process and is used to build a path.
  for (const bad of ['../escape', 'a/b', 'a\\b', '', 'x'.repeat(200)]) {
    assert.strictEqual(hooks.markSupervised(bad), false, `"${bad}" was accepted as a session id`);
    assert.strictEqual(hooks.isSupervised(bad), false, `"${bad}" reported as supervised`);
  }
});

check('THE DAEMON SAYS WHEN IT IS NOT SUPERVISING, rather than just refusing', async () => {
  // "not watching this" and "denied" are different answers, and only one of
  // them should put a prompt in front of somebody.
  const d = new Daemon({ hubUrl: null });
  const r = await d.handle({ op: 'hook-approval', sessionId: 'never-registered', toolName: 'powershell' });
  assert.strictEqual(r.supervised, false, 'an unregistered session is reported as supervised');
});

check('an ENDED session is no longer supervised', async () => {
  const d = new Daemon({ hubUrl: null });
  const s = d.registerTuiSession({ copilotId: 'copilot-end', cwd: 'C:\\work' });
  s.end('user_exit');
  const r = await d.handle({ op: 'hook-approval', sessionId: 'copilot-end', toolName: 'powershell' });
  assert.strictEqual(r.supervised, false, 'a finished session still claims supervision');
});

check('a live registered session IS supervised', async () => {
  const d = new Daemon({ hubUrl: null, hookApprovalTimeoutMs: 40 });
  d.registerTuiSession({ copilotId: 'copilot-live', cwd: 'C:\\work' });
  const r = await d.handle({ op: 'hook-approval', sessionId: 'copilot-live', toolName: 'powershell' });
  assert.strictEqual(r.supervised, true, 'a live registered session is not reported as supervised');
  // Nobody answered, so it must still be "ask" -- never "allow".
  assert.strictEqual(r.decision, 'ask');
});

check('THE UNREACHABLE-HUB MESSAGE NAMES THE FIX, not just the problem', () => {
  // A wall of approval prompts with no explanation is how somebody learns to
  // approve without reading.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  const idx = src.indexOf('Squad Hub is not running on this device');
  assert.ok(idx > 0, 'the unreachable-daemon path does not say the daemon is not running');
  const block = src.slice(idx, idx + 400);
  assert.match(block, /squad-hub start/, 'no way to restore supervision is offered');
  assert.match(block, /hooks remove/, 'no way to stop the prompts is offered');
});

check('AN UNSUPERVISED SESSION IS LET THROUGH, not prompted on', () => {
  // The machine-wide failure: with the daemon down, every Copilot session on
  // the box would otherwise need a manual approval for every tool call.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  assert.match(src, /if \(!hooks\.isSupervised\(sessionId\)\) return 0;/,
    'an unreachable daemon still answers for sessions nobody was supervising');
  assert.match(src, /r\.supervised === false/,
    'the shim ignores the daemon saying it is not supervising a session');
});

check('a supervised session with no hub still never resolves to allow', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  const idx = src.indexOf('Squad Hub is not running on this device');
  const block = src.slice(Math.max(0, idx - 600), idx + 200);
  assert.ok(!/permissionDecision': *'allow'|permissionDecision: 'allow'/.test(block),
    'the unreachable path can answer allow');
});

// ---------------------------------------------------------------------------
// 3. A control that cannot work must SAY SO, not report success
// ---------------------------------------------------------------------------

const { normaliseControl } = require(path.join(__dirname, '..', 'src', 'daemon'));
const { Store } = require(path.join(__dirname, '..', 'src', 'service', 'store'));

check('A CONTROL RESULT IS READ THE SAME WHICHEVER SHAPE IT ARRIVES IN', () => {
  // AcpSession.steer() returns a boolean; AcpSession.stop() returns nothing;
  // TuiSession returns { ok: false, reason } so the UI can say WHY. An object
  // is truthy, so `if (!ok)` read that refusal as SUCCESS -- steering a watched
  // session answered { sent: true } and sent nothing.
  assert.strictEqual(normaliseControl(true).ok, true, 'a boolean success became a refusal');
  assert.strictEqual(normaliseControl(false).ok, false, 'a boolean refusal became a success');
  assert.strictEqual(normaliseControl(undefined).ok, true, 'a void method became a refusal');
  assert.strictEqual(normaliseControl({ ok: true }).ok, true);
  assert.strictEqual(normaliseControl({ ok: false, reason: 'no' }).ok, false,
    'AN OBJECT REFUSAL WAS READ AS SUCCESS -- every control on a watched session would lie');
  assert.strictEqual(normaliseControl({ ok: false, reason: 'no' }).reason, 'no',
    'the reason is dropped, so the UI can only say "failed"');
});

// ---------------------------------------------------------------------------
// 4. A session that outlived its daemon can be cleared
// ---------------------------------------------------------------------------

function storeWithStuckSession() {
  const s = new Store({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sqstore-')), persist: false });
  s.registerDevice('me', { id: 'dev1', name: 'Gaming PC' });
  s.syncSessions('me', 'dev1', [
    // The ghost: registered through hooks, then its daemon died. No sessionEnd
    // ever arrives, so it stays "active" forever.
    { id: 'ghost', status: 'active', supervision: 'hooks', cwd: 'C:\\work' },
    { id: 'done', status: 'done', endedAt: Date.now() - 60000 },
  ]);
  return s;
}

check('an ordinary forget still leaves a running session alone', () => {
  const s = storeWithStuckSession();
  const r = s.forgetDeviceSessions('me', 'dev1', {});
  assert.strictEqual(r.removed, 1, 'the finished session was not removed');
  assert.strictEqual(r.kept, 1, 'a running session was removed without being asked');
  assert.strictEqual(r.stuck, 1, 'the answer does not say a session was left behind');
});

check('A SESSION THAT OUTLIVED ITS DAEMON CAN BE CLEARED, when asked for', () => {
  // Before this there was no way at all: forget skipped every non-terminal
  // session, and a hooks session can only be ended by the daemon that
  // registered it -- which is the thing that died.
  const s = storeWithStuckSession();
  const r = s.forgetDeviceSessions('me', 'dev1', { force: true });
  assert.strictEqual(r.removed, 2, `a stuck session survived a forced forget: ${JSON.stringify(r)}`);
  assert.strictEqual(s.listSessions('me', { deviceId: 'dev1' }).length, 0);
});

check('the answer counts what was stuck, so a caller can tell why nothing happened', () => {
  const s = storeWithStuckSession();
  assert.strictEqual(s.forgetDeviceSessions('me', 'dev1', {}).stuck, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);