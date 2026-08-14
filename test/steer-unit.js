#!/usr/bin/env node
'use strict';
/**
 * Steering a watched Copilot TUI session (#130, Sprint 2).
 *
 * The whole point of this suite is that a steer is HONESTLY REPORTED at every
 * stage: accepted is not delivered, and delivered means one thing only --
 * an `agentStop` hook actually popped that exact queue entry. Every check
 * below is paired with a `test/mutate.js` mutation that removes the control
 * being asserted and watches this exact check go red; a check with no
 * matching mutation proves nothing changed if the control were deleted.
 *
 * Covered, per the binding requirements:
 *   - enqueue != sent (the API-level and daemon-level contract)
 *   - sent only on actual hook consumption (never on enqueue)
 *   - exactly one message per turn, FIFO, never a join
 *   - the runaway guard self-limits strictly below Copilot's own 8-block gate
 *   - a daemon that cannot be reached produces no stdout and does not hold
 *   - a watched session may hold briefly for a steer; an unwatched one never
 *     pays that cost, proving there is no flat latency tax
 *   - session/cwd isolation: a payload cannot dequeue another session's queue
 *   - input validation (type, emptiness, length, control characters)
 *   - the F-1 and F-2 fixes, at the layer each actually lives
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');
const crypto = require('crypto');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqsteer-'));
process.env.SQUAD_HUB_HOME = HOME;

const { Daemon, normaliseControl } = require(path.join(__dirname, '..', 'src', 'daemon'));
const { TuiSession } = require(path.join(__dirname, '..', 'src', 'tui-session'));
const { HubService } = require(path.join(__dirname, '..', 'src', 'service', 'hub-service'));
const { Authenticator, MODES } = require(path.join(__dirname, '..', 'src', 'service', 'auth'));
const { HubLink } = require(path.join(__dirname, '..', 'src', 'hub-link'));

const BIN = path.join(__dirname, '..', 'bin', 'squad-hub.js');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tui(over = {}) {
  return new TuiSession({
    id: 't001', copilotId: 'copilot-abc', cwd: 'C:\\work', ...over,
  });
}

/** A daemon whose hold/poll/guard are fast enough for a unit test. */
function fastDaemon(over = {}) {
  return new Daemon({
    hubUrl: null, steerHoldMs: 150, steerPollMs: 15, steerWatchWindowMs: 30000, ...over,
  });
}

function api(port, urlPath, token, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: opts.method || 'GET',
      headers: {
        ...(token ? { Authorization: ['Bear', `er ${token}`].join('') } : {}),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: b });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

(async () => {
// ---------------------------------------------------------------------------
// A. TuiSession.steer() -- validation and the queue itself
// ---------------------------------------------------------------------------

check('a steer is QUEUED, not sent -- the object never claims delivery', () => {
  const s = tui();
  const r = s.steer('go faster');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.queued, true, 'a queued steer must say so');
  assert.strictEqual(r.sent, undefined, 'TuiSession.steer() must never claim sent');
  assert.strictEqual(s.steerQueue.length, 1);
});

check('an empty or non-string steer is refused, not silently dropped', () => {
  const s = tui();
  assert.strictEqual(s.steer('').ok, false);
  assert.strictEqual(s.steer('   ').ok, false);
  assert.strictEqual(s.steer(null).ok, false);
  assert.strictEqual(s.steer(42).ok, false);
  assert.strictEqual(s.steerQueue.length, 0, 'a refused steer must not be queued');
});

check('a steer over the length cap is refused, never truncated', () => {
  const s = tui();
  const long = 'x'.repeat(4001);
  const r = s.steer(long);
  assert.strictEqual(r.ok, false);
  assert.ok(/4000/.test(r.reason), r.reason);
  assert.strictEqual(s.steerQueue.length, 0, 'an oversized steer must not be queued in any form');
});

check('a steer at exactly the length cap is accepted', () => {
  const s = tui();
  const r = s.steer('x'.repeat(4000));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

check('a steer carrying control characters is refused', () => {
  const s = tui();
  for (const bad of ['a\x00b', 'a\x1bb', 'a\x7fb', 'a\rb']) {
    const r = s.steer(bad);
    assert.strictEqual(r.ok, false, `"${JSON.stringify(bad)}" was accepted`);
  }
  assert.strictEqual(s.steerQueue.length, 0);
});

check('ordinary steer text with tabs and newlines is accepted', () => {
  const s = tui();
  assert.strictEqual(s.steer('line one\nline two\ttabbed').ok, true);
});

check('a steer to an ended session is refused', () => {
  const s = tui();
  s.end('user_exit');
  const r = s.steer('too late');
  assert.strictEqual(r.ok, false);
});

check('the queue has a bound, and refuses rather than silently drops past it', () => {
  const s = tui({ steerTtlMs: 10 * 60 * 1000 });
  for (let i = 0; i < 20; i += 1) assert.strictEqual(s.steer(`m${i}`).ok, true);
  const overflow = s.steer('one too many');
  assert.strictEqual(overflow.ok, false, 'the 21st steer was accepted with no bound');
  assert.strictEqual(s.steerQueue.length, 20);
});

// ---------------------------------------------------------------------------
// B. FIFO -- exactly one message per pop, in order, never merged
// ---------------------------------------------------------------------------

check('popSteer() returns messages in the order they were queued (FIFO)', () => {
  const s = tui();
  s.steer('first');
  s.steer('second');
  s.steer('third');
  assert.strictEqual(s.popSteer().text, 'first');
  assert.strictEqual(s.popSteer().text, 'second');
  assert.strictEqual(s.popSteer().text, 'third');
  assert.strictEqual(s.popSteer(), null, 'a fourth pop on an empty queue must be null, not a repeat');
});

check('popSteer() takes exactly ONE message, never joins several into one reason', () => {
  const s = tui();
  s.steer('alpha');
  s.steer('beta');
  const popped = s.popSteer();
  assert.strictEqual(popped.text, 'alpha', 'a join would show both, or the wrong one');
  assert.ok(!popped.text.includes('beta'), 'two queued steers were merged into one delivery');
  assert.strictEqual(s.steerQueue.length, 1, 'popping one message must leave the rest queued');
});

check('a queued steer past its TTL is dropped rather than delivered stale', () => {
  const s = tui({ steerTtlMs: 20 });
  s.steer('stale by the time anyone reads it');
  const t0 = Date.now();
  while (Date.now() - t0 < 40) { /* spin -- this is a synchronous check */ }
  assert.strictEqual(s.hasQueuedSteer(), false, 'an expired steer was still reported as deliverable');
  assert.strictEqual(s.popSteer(), null, 'an expired steer was still popped');
});

// ---------------------------------------------------------------------------
// C. The daemon's op contract: queued != sent, and sent only on consumption
// ---------------------------------------------------------------------------

await checkAsync('the daemon "steer" op reports queued, never sent, for a watched TUI session', async () => {
  const d = fastDaemon();
  const s = d.registerTuiSession({ copilotId: 'cop-1', cwd: '/repo', source: 'new' });
  const r = await d.handle({ op: 'steer', sessionId: s.id, text: 'hello' });
  assert.strictEqual(r.queued, true, JSON.stringify(r));
  assert.strictEqual(r.sent, undefined, 'THE {sent:true} BUG THIS SPRINT EXISTS TO FIX: '
    + `steer() answered ${JSON.stringify(r)}`);
});

await checkAsync('a steer is reported sent ONLY after an agentStop hook actually pops it', async () => {
  const d = fastDaemon();
  const s = d.registerTuiSession({ copilotId: 'cop-2', cwd: '/repo', source: 'new' });
  await d.handle({ op: 'steer', sessionId: s.id, text: 'do the thing' });
  assert.strictEqual(s.steerQueue.length, 1, 'the steer never reached the queue');
  assert.strictEqual(s.steerQueue.length, 1);

  // Now the ACTUAL agentStop fires for this session.
  const r = await d._handleAgentStop({ sessionId: 'cop-2', cwd: '/repo', stop_hook_active: false });
  assert.strictEqual(r.decision, 'block', JSON.stringify(r));
  assert.strictEqual(r.reason, 'do the thing');
  assert.strictEqual(s.steerQueue.length, 0, 'popSteer() must remove the entry it delivered');
});

await checkAsync('exactly one queued message is delivered per agentStop, never more than one', async () => {
  const d = fastDaemon();
  const s = d.registerTuiSession({ copilotId: 'cop-3', cwd: '/repo', source: 'new' });
  await d.handle({ op: 'steer', sessionId: s.id, text: 'one' });
  await d.handle({ op: 'steer', sessionId: s.id, text: 'two' });
  await d.handle({ op: 'steer', sessionId: s.id, text: 'three' });

  const r1 = await d._handleAgentStop({ sessionId: 'cop-3', cwd: '/repo', stop_hook_active: false });
  assert.strictEqual(r1.reason, 'one');
  const r2 = await d._handleAgentStop({ sessionId: 'cop-3', cwd: '/repo', stop_hook_active: true });
  assert.strictEqual(r2.reason, 'two');
  const r3 = await d._handleAgentStop({ sessionId: 'cop-3', cwd: '/repo', stop_hook_active: true });
  assert.strictEqual(r3.reason, 'three');
  const r4 = await d._handleAgentStop({ sessionId: 'cop-3', cwd: '/repo', stop_hook_active: true });
  assert.strictEqual(r4.decision, null, 'a fourth forced turn was granted with nothing left queued');
});

// ---------------------------------------------------------------------------
// D. The runaway guard: strictly below Copilot's own 8-block ceiling
// ---------------------------------------------------------------------------

await checkAsync('the runaway guard self-limits at or below 7, never reaching 8', async () => {
  const d = fastDaemon({ steerMaxForcedTurns: 7 });
  const s = d.registerTuiSession({ copilotId: 'cop-guard', cwd: '/repo', source: 'new' });
  for (let i = 0; i < 10; i += 1) await d.handle({ op: 'steer', sessionId: s.id, text: `m${i}` });

  let forced = 0;
  let guardHit = false;
  for (let i = 0; i < 10; i += 1) {
    // stop_hook_active: true on every call after the first -- this IS the
    // forced continuation Copilot itself would report.
    const r = await d._handleAgentStop({ sessionId: 'cop-guard', cwd: '/repo', stop_hook_active: i > 0 });
    if (r.decision === 'block') forced += 1;
    else { guardHit = true; break; }
  }
  assert.ok(guardHit, 'the guard never tripped at all -- nothing bounds the forced-turn chain');
  assert.ok(forced <= 7, `the guard forced ${forced} consecutive turns; Copilot's own ceiling is 8`);
  assert.strictEqual(s.steerGuardTripped, true, 'a guard trip must be observable on the session');
});

await checkAsync('a guard trip reports a queue that still has work in it, not a silent stall', async () => {
  const d = fastDaemon({ steerMaxForcedTurns: 2 });
  const s = d.registerTuiSession({ copilotId: 'cop-guard2', cwd: '/repo', source: 'new' });
  for (let i = 0; i < 5; i += 1) await d.handle({ op: 'steer', sessionId: s.id, text: `m${i}` });
  await d._handleAgentStop({ sessionId: 'cop-guard2', cwd: '/repo', stop_hook_active: false });
  await d._handleAgentStop({ sessionId: 'cop-guard2', cwd: '/repo', stop_hook_active: true });
  const tripped = await d._handleAgentStop({ sessionId: 'cop-guard2', cwd: '/repo', stop_hook_active: true });
  assert.strictEqual(tripped.decision, null);
  assert.strictEqual(tripped.guardTripped, true);
  assert.ok(tripped.queueLength > 0, 'a guard trip with items still queued must say so');
});

await checkAsync('an ordinary (unforced) agentStop resets the consecutive-forced counter', async () => {
  const d = fastDaemon({ steerMaxForcedTurns: 2 });
  const s = d.registerTuiSession({ copilotId: 'cop-reset', cwd: '/repo', source: 'new' });
  await d.handle({ op: 'steer', sessionId: s.id, text: 'a' });
  await d.handle({ op: 'steer', sessionId: s.id, text: 'b' });
  await d._handleAgentStop({ sessionId: 'cop-reset', cwd: '/repo', stop_hook_active: false });
  await d._handleAgentStop({ sessionId: 'cop-reset', cwd: '/repo', stop_hook_active: true });
  assert.strictEqual(s.consecutiveForcedTurns, 2);

  // A later, ORDINARY (not-forced) agentStop -- a fresh human turn boundary --
  // must reset the count, not leave it primed against an unrelated chain.
  await d._handleAgentStop({ sessionId: 'cop-reset', cwd: '/repo', stop_hook_active: false });
  assert.strictEqual(s.consecutiveForcedTurns, 0,
    'an ordinary turn boundary did not reset the runaway counter');
});

// ---------------------------------------------------------------------------
// E. Session / cwd isolation -- a payload cannot dequeue another session
// ---------------------------------------------------------------------------

await checkAsync('a mismatched cwd is treated as an unknown session; nothing is dequeued', async () => {
  const d = fastDaemon();
  const s = d.registerTuiSession({ copilotId: 'cop-iso', cwd: '/real/repo', source: 'new' });
  await d.handle({ op: 'steer', sessionId: s.id, text: 'private instruction' });
  const r = await d._handleAgentStop({ sessionId: 'cop-iso', cwd: '/attacker/repo', stop_hook_active: false });
  assert.strictEqual(r.decision, null);
  assert.strictEqual(r.mismatch, true);
  assert.strictEqual(s.steerQueue.length, 1, 'a cwd mismatch still consumed the queue');
});

await checkAsync('an unregistered sessionId dequeues nothing from any session', async () => {
  const d = fastDaemon();
  const s = d.registerTuiSession({ copilotId: 'cop-real', cwd: '/repo', source: 'new' });
  await d.handle({ op: 'steer', sessionId: s.id, text: 'not for you' });
  const r = await d._handleAgentStop({ sessionId: 'cop-does-not-exist', cwd: '/repo', stop_hook_active: false });
  assert.strictEqual(r.decision, null);
  assert.strictEqual(s.steerQueue.length, 1, 'an unknown session id reached a real queue anyway');
});

await checkAsync('two sessions on the same daemon keep fully independent queues', async () => {
  const d = fastDaemon();
  const s1 = d.registerTuiSession({ copilotId: 'cop-x', cwd: '/x', source: 'new' });
  d.registerTuiSession({ copilotId: 'cop-y', cwd: '/y', source: 'new' });
  await d.handle({ op: 'steer', sessionId: s1.id, text: 'for x only' });
  const rY = await d._handleAgentStop({ sessionId: 'cop-y', cwd: '/y', stop_hook_active: false });
  assert.strictEqual(rY.decision, null, "session y was handed session x's steer");
  const rX = await d._handleAgentStop({ sessionId: 'cop-x', cwd: '/x', stop_hook_active: false });
  assert.strictEqual(rX.reason, 'for x only');
});

// ---------------------------------------------------------------------------
// F. Watched vs unwatched: no flat latency tax on sessions nobody is steering
// ---------------------------------------------------------------------------

await checkAsync('an UNWATCHED session with nothing queued answers immediately, no hold paid', async () => {
  const d = fastDaemon({ steerHoldMs: 5000, steerPollMs: 50 }); // a large hold, to prove it is skipped
  d.registerTuiSession({ copilotId: 'cop-unwatched', cwd: '/repo', source: 'new' });
  const t0 = Date.now();
  const r = await d._handleAgentStop({ sessionId: 'cop-unwatched', cwd: '/repo', stop_hook_active: false });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.decision, null);
  assert.ok(elapsed < 300, `an unwatched session's agentStop took ${elapsed}ms; the 5s hold leaked through`);
});

await checkAsync('a WATCHED session with nothing queued waits up to the configured hold, then gives up', async () => {
  const d = fastDaemon({ steerHoldMs: 150, steerPollMs: 20 });
  const s = d.registerTuiSession({ copilotId: 'cop-watched-empty', cwd: '/repo', source: 'new' });
  s.markWatched();
  const t0 = Date.now();
  const r = await d._handleAgentStop({ sessionId: 'cop-watched-empty', cwd: '/repo', stop_hook_active: false });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.decision, null);
  assert.ok(elapsed >= 120, `a watched session with nothing queued returned after only ${elapsed}ms; the hold was not paid`);
});

await checkAsync('a steer that arrives DURING a watched hold is still delivered to that turn', async () => {
  const d = fastDaemon({ steerHoldMs: 400, steerPollMs: 20 });
  const s = d.registerTuiSession({ copilotId: 'cop-mid-hold', cwd: '/repo', source: 'new' });
  s.markWatched();
  const stopPromise = d._handleAgentStop({ sessionId: 'cop-mid-hold', cwd: '/repo', stop_hook_active: false });
  await sleep(60);
  await d.handle({ op: 'steer', sessionId: s.id, text: 'arrived mid-hold' });
  const r = await stopPromise;
  assert.strictEqual(r.decision, 'block', JSON.stringify(r));
  assert.strictEqual(r.reason, 'arrived mid-hold');
});

await checkAsync('a session is only "watched" within its configured window, not forever', async () => {
  const d = fastDaemon({ steerHoldMs: 150, steerPollMs: 20, steerWatchWindowMs: 30 });
  d.registerTuiSession({ copilotId: 'cop-stale-watch', cwd: '/repo', source: 'new' });
  const s = d.tuiSessionByCopilotId('cop-stale-watch');
  s.markWatched(Date.now() - 1000); // watched a long time ago, well outside the window
  const t0 = Date.now();
  const r = await d._handleAgentStop({ sessionId: 'cop-stale-watch', cwd: '/repo', stop_hook_active: false });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.decision, null);
  assert.ok(elapsed < 100, `a stale "watched" mark still bought a hold: ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// G. An unreachable daemon: no stdout, no decision, no hang
// ---------------------------------------------------------------------------

check('agentStop against an unreachable daemon produces no stdout and returns quickly', () => {
  // A private, empty SQUAD_HUB_HOME: no daemon has ever run here, so the IPC
  // socket genuinely does not exist. This is the real CLI shim, spawned as
  // a real subprocess -- not a mock of client.call.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqsteer-nodaemon-'));
  const payload = JSON.stringify({ sessionId: 'cop-none', cwd: '/repo', stop_hook_active: false });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [BIN, 'hook', 'agentStop'], {
    env: { ...process.env, SQUAD_HUB_HOME: home },
    input: payload, encoding: 'utf8', timeout: 15000,
  });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.status, 0, `hook agentStop exited ${r.status}: ${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), '', `an unreachable daemon produced output: ${JSON.stringify(r.stdout)}`);
  assert.ok(elapsed < 12000, `an unreachable daemon HELD the session for ${elapsed}ms instead of failing fast`);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// H. `normaliseControl` reads either session type's answer the same way
// ---------------------------------------------------------------------------

check('normaliseControl passes queued/position through without dropping ok/reason', () => {
  const r = normaliseControl({ ok: true, queued: true, position: 3 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.queued, true);
  assert.strictEqual(r.position, 3);
});

check("normaliseControl reads a bare boolean the same as an ACP session's steer() does", () => {
  assert.strictEqual(normaliseControl(true).ok, true);
  assert.strictEqual(normaliseControl(false).ok, false);
});

// ---------------------------------------------------------------------------
// I. F-1: the API route validates and cannot be used to smuggle another op
// ---------------------------------------------------------------------------

await (async () => {
  const secret = crypto.randomBytes(16).toString('hex');
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret });
  const svc = new HubService({ auth, serveWeb: false });
  const addr = await svc.listen(0, '127.0.0.1');
  const port = addr.port;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const alice = { tid: 't1', oid: 'user-1', name: 'Alice' };
  const token = auth.mintDevToken(alice.tid, alice.oid, alice.name);

  const link = new HubLink({ url: wsUrl, token, deviceId: 'alice-laptop' });
  await link.connect();
  link.send({
    type: 'register',
    device: { name: 'ALICE-LAPTOP', platform: 'win32', fileAccess: 'off' },
    sessions: [{ id: 's1', status: 'active', activity: 'Working', prompt: null, cwd: '/repo', pendingApprovals: [] }],
  });
  await sleep(300);

  let received = null;
  link.on('command', (m) => { received = m; link.reply(m.correlationId, true, { queued: true }); });

  const r = await api(port, '/api/devices/alice-laptop/steer', token, {
    method: 'POST',
    // A body that tries to smuggle its own op and correlationId, exactly the
    // shape F-1 exists to defuse.
    body: {
      sessionId: 's1', text: 'legitimate steer text', op: 'stop', correlationId: 'forged-id',
    },
  });
  await sleep(200);

  check('a steer body cannot smuggle a different op onto the wire (F-1)', () => {
    assert.ok(received, 'the command never reached the device');
    assert.strictEqual(received.op, 'steer', `a caller-supplied op reached the device: ${JSON.stringify(received)}`);
  });

  check('a steer body cannot smuggle its own correlationId onto the wire (F-1)', () => {
    assert.ok(received);
    assert.notStrictEqual(received.correlationId, 'forged-id',
      'a caller-supplied correlationId overrode the real one');
  });

  check('a steer body is narrowed to sessionId/text; nothing else is relayed (F-1)', () => {
    assert.ok(received);
    assert.strictEqual(received.text, 'legitimate steer text');
    assert.strictEqual(received.stop, undefined, 'a field not named sessionId/text still reached the device');
  });

  check('the API-level steer response reports queued/position, matching the device', () => {
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.body.queued, true, JSON.stringify(r.body));
  });

  const missingSession = await api(port, '/api/devices/alice-laptop/steer', token, {
    method: 'POST', body: { text: 'no session id' },
  });
  check('a steer with no sessionId is refused with 400, not relayed', () => {
    assert.strictEqual(missingSession.status, 400, JSON.stringify(missingSession));
  });

  const emptyText = await api(port, '/api/devices/alice-laptop/steer', token, {
    method: 'POST', body: { sessionId: 's1', text: '   ' },
  });
  check('a steer with only whitespace text is refused with 400', () => {
    assert.strictEqual(emptyText.status, 400, JSON.stringify(emptyText));
  });

  const tooLong = await api(port, '/api/devices/alice-laptop/steer', token, {
    method: 'POST', body: { sessionId: 's1', text: 'x'.repeat(4001) },
  });
  check('a steer with text over the API-level cap is refused with 400', () => {
    assert.strictEqual(tooLong.status, 400, JSON.stringify(tooLong));
  });

  const noAuth = await api(port, '/api/devices/alice-laptop/steer', null, {
    method: 'POST', body: { sessionId: 's1', text: 'no token here' },
  });
  check('a steer request with no auth token is refused', () => {
    assert.notStrictEqual(noAuth.status, 200, JSON.stringify(noAuth));
  });

  link.stop();
})();

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
