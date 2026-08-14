#!/usr/bin/env node
'use strict';
/**
 * #114: supervising a real Copilot TUI session through hooks.
 *
 * The hub speaks ACP over the agent's stdio and the TUI wants that same stdio,
 * so one process cannot serve both. Hooks are a different channel: Copilot runs
 * a command of our choosing at points in a session's life, so a session can
 * register itself, report what it is doing, and ask permission — without giving
 * up its terminal.
 *
 * Three measurements against Copilot CLI 1.0.79 shaped all of this, and the
 * third is the reason the suite is built the way it is:
 *
 *   1. a preToolUse hook may block a long time (90s observed, timeoutSec 300)
 *   2. a hook that TIMES OUT falls through to the session's normal permission
 *      handling — which in a --allow-all-tools session means the tool RUNS
 *   3. an explicit "ask" overrides --allow-all-tools; the tool is refused
 *
 * (2) is the trap. A supervision feature whose failure mode is "approve
 * everything" is worse than no feature, so the load-bearing property here is
 * NO FAILURE PATH MAY RETURN 'allow' — not an unknown session, not an ended
 * one, not a timeout, not an unrecognised answer. Every one of those has a test
 * that fails if it ever resolves to permission.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhooks-'));
process.env.SQUAD_HUB_HOME = HOME;

const hooks = require(path.join(__dirname, '..', 'src', 'hooks'));
const { TuiSession } = require(path.join(__dirname, '..', 'src', 'tui-session'));
// The ONE status vocabulary. Imported from the same place the daemon and the
// hub read it, so this suite cannot quietly agree with a second one -- which is
// precisely how a watched session reached production rendering as a blank row.
const { STATUS } = require(path.join(__dirname, '..', 'src', 'acp-session'));

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
const asyncChecks = [];
function checkAsync(name, fn) { asyncChecks.push({ name, fn }); }

function fakeEnv() {
  return { COPILOT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'copilothome-')) };
}
function session(over = {}) {
  return new TuiSession({
    id: 't001', copilotId: 'copilot-abc', cwd: 'C:\\work', ...over,
  });
}

// ---------------------------------------------------------------------------
// A. The hook file
// ---------------------------------------------------------------------------

check('THE POWERSHELL FORM USES THE CALL OPERATOR, or the hook silently does nothing', () => {
  // Without `&`, PowerShell evaluates a quoted path as a STRING and returns it.
  // No error, no process: a hook that looks installed and never runs. This cost
  // a debugging pass, and it is invisible without this assertion.
  const cfg = hooks.buildHookConfig('"C:\\node.exe" "C:\\squad-hub.js"');
  for (const [event, entries] of Object.entries(cfg.hooks)) {
    assert.ok(entries[0].powershell.startsWith('& '), `${event} powershell is not invoked: ${entries[0].powershell}`);
  }
});

check('every event the code answers is actually asked for', () => {
  const cfg = hooks.buildHookConfig('cmd');
  assert.deepStrictEqual(Object.keys(cfg.hooks).sort(), [...hooks.EVENTS].sort());
});

check('APPROVALS GET A LONGER DEADLINE THAN COPILOT CAN OUTLAST', () => {
  // If Copilot gives up before the hook answers, the hook produces no output —
  // and no output falls through to the session's own handling, which under
  // --allow-all-tools runs the tool. preToolUse must therefore outlast the
  // daemon's own wait (120s default) by a clear margin.
  const cfg = hooks.buildHookConfig('cmd');
  const approval = cfg.hooks.preToolUse[0].timeoutSec;
  const notify = cfg.hooks.sessionStart[0].timeoutSec;
  assert.ok(approval >= 240, `preToolUse timeoutSec is only ${approval}s; the daemon waits 120s`);
  assert.ok(notify <= 10, `a fire-and-forget hook waits ${notify}s and blocks the session that long`);
});

check('install writes a file Copilot will actually read, and reports it', () => {
  const env = fakeEnv();
  const r = hooks.install({ env, command: 'cmd' });
  assert.ok(r.ok, r.reason);
  const parsed = JSON.parse(fs.readFileSync(hooks.hookPath(env), 'utf8'));
  assert.strictEqual(parsed.version, 1);
  assert.ok(parsed.hooks.sessionStart, 'no sessionStart in the installed file');
});

check('a file we did not write is NOT silently replaced', () => {
  const env = fakeEnv();
  fs.mkdirSync(hooks.hooksDir(env), { recursive: true });
  fs.writeFileSync(hooks.hookPath(env), 'not json at all', 'utf8');

  const r = hooks.install({ env, command: 'cmd' });
  assert.strictEqual(r.ok, false, 'someone else\'s file was overwritten');
  assert.strictEqual(fs.readFileSync(hooks.hookPath(env), 'utf8'), 'not json at all');
  assert.ok(/--force/.test(r.reason), r.reason);
});

check('A STALE FILE IS REPORTED AS STALE, not merely as installed', () => {
  // "Installed" and "installed and doing what this build expects" are different
  // facts. Only reporting the first hides an old file missing the events this
  // version relies on.
  const env = fakeEnv();
  fs.mkdirSync(hooks.hooksDir(env), { recursive: true });
  fs.writeFileSync(hooks.hookPath(env), JSON.stringify({ version: 1, hooks: { sessionStart: [] } }), 'utf8');

  const s = hooks.status(env);
  assert.strictEqual(s.installed, true);
  assert.strictEqual(s.current, false, 'a file missing most events reported itself as current');
  assert.ok(s.missing.includes('preToolUse'), JSON.stringify(s.missing));
});

check('removing something already absent is not an error', () => {
  const env = fakeEnv();
  const r = hooks.remove(env);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed, false);
});

check('install then remove leaves nothing behind', () => {
  const env = fakeEnv();
  hooks.install({ env, command: 'cmd' });
  assert.strictEqual(hooks.status(env).installed, true);
  hooks.remove(env);
  assert.strictEqual(hooks.status(env).installed, false);
});

// ---------------------------------------------------------------------------
// B. A session the hub watches but does not own
// ---------------------------------------------------------------------------

check('a watched session says so, rather than leaving it to be inferred', () => {
  const j = session().toJSON();
  assert.strictEqual(j.supervision, 'hooks');
  assert.strictEqual(j.pid, null, 'a pid promises something can be signalled');
});

check('STOP REFUSES WITH A REASON, instead of appearing to work', () => {
  // A button that lies is worse than an absent one.
  //
  // The reason must also say what to do INSTEAD. "Cannot stop" alone reads as
  // a fault; "close that terminal" reads as a boundary. Matched on the
  // redirection rather than the phrasing, so improving the wording does not
  // fail a correct file.
  //
  // `steer()` is deliberately NOT covered here any more -- Sprint 2 (#130)
  // built it. See steer-unit.js for what it does now: queue, never appear to
  // send.
  const s = session();
  const r = s.stop();
  assert.strictEqual(r.ok, false);
  assert.ok(/that terminal/.test(r.reason), r.reason);
});

check('the first prompt becomes the session name, and later ones do not replace it', () => {
  const s = session();
  s.notePrompt('fix the tests');
  s.notePrompt('now the docs');
  assert.strictEqual(s.prompt, 'fix the tests');
  assert.strictEqual(s.status, STATUS.ACTIVE);
});

check('tool use is counted and named', () => {
  const s = session();
  s.noteTool('powershell');
  s.noteTool('edit');
  assert.strictEqual(s.toolCallCount, 2);
  assert.ok(/edit/.test(s.activity), s.activity);
});

check('AN UNKNOWN END REASON IS A FAILURE, not a clean finish', () => {
  // A session that stopped for a reason nobody anticipated is exactly the one
  // worth looking at; calling it "Finished" would hide it.
  const s = session();
  s.end('something-nobody-planned-for');
  assert.strictEqual(s.status, STATUS.FAILED);
  assert.ok(s.error, 'no error recorded');
});

check('the ordinary endings are terminal, and are not failures', () => {
  // 'complete' is a clean finish; user_exit and abort are somebody closing the
  // terminal. All three must be terminal so `forget` can tidy them, and none
  // of them is an error worth showing.
  for (const reason of ['complete', 'user_exit', 'abort']) {
    const s = session();
    s.end(reason);
    assert.notStrictEqual(s.status, STATUS.FAILED, `${reason} was treated as a failure`);
    assert.strictEqual(s.ended, true, `${reason} did not leave the session ended`);
  }
});

// ---------------------------------------------------------------------------
// C. Approvals -- no failure path may return 'allow'
// ---------------------------------------------------------------------------

checkAsync('an approval answered in the hub allows the tool', async () => {
  const s = session();
  const p = s.requestApproval({ approvalId: 'a1', toolName: 'powershell', timeoutMs: 5000 });
  assert.strictEqual(s.status, STATUS.WAITING_APPROVAL);
  assert.ok(s.answer('a1', 'allow_once', 'brian'), 'the answer was not accepted');
  assert.strictEqual(await p, 'allow');
  assert.strictEqual(s.answeredApprovals.length, 1);
});

checkAsync('a refusal in the hub denies the tool', async () => {
  const s = session();
  const p = s.requestApproval({ approvalId: 'a1', toolName: 'powershell', timeoutMs: 5000 });
  s.answer('a1', 'reject_once');
  assert.strictEqual(await p, 'deny');
});

checkAsync('AN UNRECOGNISED ANSWER IS A DENY, never permission', async () => {
  const s = session();
  const p = s.requestApproval({ approvalId: 'a1', timeoutMs: 5000 });
  s.answer('a1', 'something_new_we_do_not_know');
  assert.strictEqual(await p, 'deny', 'an unknown option id became permission to run a tool');
});

checkAsync('NOBODY ANSWERING RESOLVES TO ask, NOT allow', async () => {
  // The measurement that made this matter: a hook producing no output falls
  // through, and under --allow-all-tools that runs the tool. Answering "ask"
  // puts the decision at the keyboard instead, and overrides allow-all.
  const s = session();
  const decision = await s.requestApproval({ approvalId: 'a1', timeoutMs: 60 });
  assert.strictEqual(decision, 'ask', 'an unanswered approval became permission');
  assert.strictEqual(s.expiredApprovals.length, 1);
});

checkAsync('A SESSION ENDING RELEASES ANYONE WAITING, with ask', async () => {
  // The terminal is closing. Leaving the hook parked until its own timeout
  // would stall the very session that is trying to exit.
  const s = session();
  const p = s.requestApproval({ approvalId: 'a1', timeoutMs: 60000 });
  s.end('user_exit');
  assert.strictEqual(await p, 'ask');
});

checkAsync('answering twice is refused the second time', async () => {
  const s = session();
  const p = s.requestApproval({ approvalId: 'a1', timeoutMs: 5000 });
  assert.strictEqual(s.answer('a1', 'allow_once'), true);
  await p;
  assert.strictEqual(s.answer('a1', 'allow_once'), false, 'a settled approval was answered again');
});

check('answering an approval that does not exist is refused', () => {
  assert.strictEqual(session().answer('nope', 'allow_once'), false);
});

checkAsync('AN UNREGISTERED SESSION NEVER REACHES THE DAEMON, so a wedged hub cannot tax it', async () => {
  /**
   * Hooks are USER-LEVEL. `agentStop` fires at the end of every turn of every
   * Copilot session on the machine, including sessions that have nothing to do
   * with the hub -- and an unregistered session can only ever be answered "let
   * the turn end". Making that answer cost a round trip is bad enough; making
   * it cost a TIMEOUT is a hub outage spreading to unrelated work.
   *
   * A wedged daemon is the case that matters, and it is not the same as a dead
   * one: a dead daemon refuses the connection and the shim gives up at once,
   * while a wedged one accepts and never answers. Measured with the check
   * removed: 8067ms per turn. With it: 50ms.
   */
  const net = require('net');
  const { spawn } = require('child_process');
  const paths = require(path.join(__dirname, '..', 'src', 'paths'));

  // Every accepted socket is kept so it can be destroyed at the end.
  // `server.close()` waits for open connections, and the whole point of this
  // server is that it never closes one -- so without this the suite hangs
  // here, silently, exactly in the case the mutation is meant to expose.
  const sockets = [];
  const server = net.createServer((s) => { sockets.push(s); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.ipc(), resolve);
  });

  try {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'bin', 'squad-hub.js'), 'hook', 'agentStop'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SQUAD_HUB_HOME: HOME } },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end(JSON.stringify({ sessionId: 'never-registered-with-this-daemon', cwd: HOME }));

    const code = await new Promise((r) => child.on('close', r));
    const elapsed = Date.now() - started;

    assert.strictEqual(code, 0, 'the hook shim failed rather than getting out of the way');
    assert.strictEqual(out.trim(), '',
      'an unregistered session was given a decision, which is not the hook\'s to make');
    assert.ok(elapsed < 4000,
      `an unrelated session waited ${elapsed}ms on a wedged daemon at the end of its turn`);
  } finally {
    for (const s of sockets) { try { s.destroy(); } catch { /* already gone */ } }
    await new Promise((r) => server.close(r));
  }
});

checkAsync('THE PAYLOAD NEVER CARRIES THE WAITING PROMISE', async () => {
  // pendingApprovals is handed to code that inspects the object directly, not
  // only to JSON.stringify.
  const s = session();
  const p = s.requestApproval({ approvalId: 'a1', toolName: 'powershell', timeoutMs: 5000 });
  const [card] = s.toJSON().pendingApprovals;
  assert.ok(card, 'the approval is not visible to the hub at all');
  assert.strictEqual(card._settle, undefined, 'the internal resolver leaked into the payload');
  assert.ok(card.options.some((o) => o.optionId === 'allow_once'), 'the hub is offered no way to allow');
  s.answer('a1', 'reject_once');
  await p;
});

// ---------------------------------------------------------------------------

(async () => {
  for (const c of asyncChecks) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ok   ${c.name}`);
      console.log(`RESULT\tok\t${c.name}`);
    } catch (e) {
      fail += 1;
      console.log(`  FAIL ${c.name}\n         ${e.message}`);
      console.log(`RESULT\tfail\t${c.name}\t${String(e.message).split('\n')[0]}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
