'use strict';
/**
 * S5: control verification.
 *
 * The composer used to be live from the moment the panel opened, which is a
 * promise the UI cannot keep: the hub knowing about a session proves only that
 * a heartbeat once mentioned it. Whether the agent is alive and still taking
 * input is a fact only the DEVICE holds -- the same shape as the HTTP-101
 * handshake race HubLink already had to be fixed for, where an upgraded socket
 * was mistaken for a registered device.
 *
 * Two halves:
 *
 *   the protocol   a real Daemon answering `control-check` about real
 *                  sessions, so "the device says no" is proven end to end
 *                  rather than assumed.
 *
 *   the client     the pure state machine that decides whether controls are
 *                  enabled, what the person is told, and -- the part worth
 *                  guarding hardest -- that the draft survives a failure.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// ---------------------------------------------------------------------------
// The client-side state machine
// ---------------------------------------------------------------------------
const APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');
const MARKER = '(async function main()';
const idx = src.indexOf(MARKER);
if (idx < 0) {
  console.log(`  FAIL could not find the "${MARKER}" extraction anchor in web/app.js -- it moved`);
  console.log('RESULT\tfail\tweb/app.js extraction anchor is present\tanchor not found');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}
const mod = { exports: {} };
new Function('module', 'exports', `${src.slice(0, idx)}
module.exports = { CONTROL, controlsEnabled, canSync, controlStateFrom, controlBanner, composerReduce };`)(mod, mod.exports);
const { CONTROL, controlsEnabled, canSync, controlStateFrom, controlBanner, composerReduce } = mod.exports;

check('controls are DISABLED before anything has been asked', () => {
  assert.strictEqual(controlsEnabled(CONTROL.UNKNOWN), false,
    'a composer live before the far end was verified is a promise the UI cannot keep');
});

check('controls are disabled WHILE the check is in flight', () => {
  assert.strictEqual(controlsEnabled(CONTROL.VERIFYING), false);
});

check('controls are enabled only once the device says yes', () => {
  assert.strictEqual(controlsEnabled(CONTROL.SYNCED), true);
  assert.strictEqual(controlsEnabled(CONTROL.NOT_SYNCED), false);
  assert.strictEqual(controlsEnabled(CONTROL.UNVERIFIED), false);
});

check('a state nobody anticipated defaults to DISABLED', () => {
  // An allow-list, not a deny-list: a state added later must fail closed.
  assert.strictEqual(controlsEnabled('something-new'), false);
  assert.strictEqual(controlsEnabled(undefined), false);
  assert.strictEqual(controlsEnabled(null), false);
});

check('a definite "no" is told apart from a request that never arrived', () => {
  assert.strictEqual(controlStateFrom({ controllable: false, reason: 'the session is done' }), CONTROL.NOT_SYNCED);
  assert.strictEqual(controlStateFrom({ error: 'network down' }), CONTROL.UNVERIFIED,
    'telling someone "not synced" when the request never arrived sends them looking in the wrong place');
});

check('a timeout is Control could not be verified, not Not synced', () => {
  assert.strictEqual(controlStateFrom({ timedOut: true }), CONTROL.UNVERIFIED);
  assert.match(controlBanner(CONTROL.UNVERIFIED, '').label, /Control couldn't be verified/);
});

check('a positive answer is the ONLY thing that produces Synced', () => {
  assert.strictEqual(controlStateFrom({ controllable: true }), CONTROL.SYNCED);
  // Anything falsy, missing, or oddly shaped must not.
  for (const outcome of [{}, { controllable: 0 }, { controllable: '' }, { controllable: null }]) {
    assert.strictEqual(controlStateFrom(outcome), CONTROL.NOT_SYNCED, `${JSON.stringify(outcome)} produced Synced`);
  }
});

check('Sync session is offered only when there is something to fix', () => {
  assert.strictEqual(canSync(CONTROL.NOT_SYNCED), true);
  assert.strictEqual(canSync(CONTROL.UNVERIFIED), true);
  assert.strictEqual(canSync(CONTROL.SYNCED), false, 'a working session needs no Sync button');
  assert.strictEqual(canSync(CONTROL.VERIFYING), false, 'a check already in flight must not invite a second');
});

check('the banner passes the device\'s reason through', () => {
  const b = controlBanner(CONTROL.NOT_SYNCED, 'the agent process is gone');
  assert.strictEqual(b.reason, 'the agent process is gone',
    '"Not synced" alone does not say whether to restart it or give up on it');
  assert.strictEqual(b.enabled, false);
  assert.strictEqual(b.canSync, true);
});

check('a working session is not given a reason it does not need', () => {
  assert.strictEqual(controlBanner(CONTROL.SYNCED, 'stale reason from before').reason, '');
});

// --- the draft ------------------------------------------------------------

check('the draft survives a verification that timed out', () => {
  let s = composerReduce(undefined, { type: 'type', text: 'half a thought' });
  s = composerReduce(s, { type: 'verify-start' });
  s = composerReduce(s, { type: 'verify-result', outcome: { timedOut: true } });
  assert.strictEqual(s.draft, 'half a thought',
    'clearing it throws away work in order to report a transport problem');
  assert.strictEqual(s.control, CONTROL.UNVERIFIED);
});

check('the draft survives a device that says no', () => {
  let s = composerReduce(undefined, { type: 'type', text: 'keep me' });
  s = composerReduce(s, { type: 'verify-result', outcome: { controllable: false, reason: 'the session is done' } });
  assert.strictEqual(s.draft, 'keep me');
});

check('the draft survives a failed send', () => {
  let s = composerReduce(undefined, { type: 'type', text: 'important' });
  s = composerReduce(s, { type: 'send-failed', error: 'HTTP 502' });
  assert.strictEqual(s.draft, 'important',
    'the old code cleared the input BEFORE the request, so a failure lost it');
  assert.match(s.reason, /502/);
});

check('a successful send is the only thing that clears the draft', () => {
  let s = composerReduce(undefined, { type: 'type', text: 'sent text' });
  s = composerReduce(s, { type: 'sent' });
  assert.strictEqual(s.draft, '');
});

// ---------------------------------------------------------------------------
// QUEUED IS NOT SENT
//
// Measured end to end against production, with a real `squad-hub squad --tui`
// session running the Squad agent: steering an IDLE watched session answers
// `{"queued":true,"position":1}` and the message then sat in the queue
// untouched for 45+ seconds. It was delivered only when a human typed at that
// keyboard and ended a turn.
//
// The composer used to discard that response and dispatch a bare `sent`,
// clearing the draft and telling the person their message had landed. That is
// the #129 failure again -- a control that reports success and does nothing --
// and it is worse here, because the message may never arrive at all.
// ---------------------------------------------------------------------------

check('A QUEUED STEER IS NOT REPORTED AS SENT', () => {
  let s = composerReduce(undefined, { type: 'type', text: 'do the thing' });
  s = composerReduce(s, { type: 'sent', queued: true });
  assert.strictEqual(s.draft, '', 'the message was accepted, so the draft is spent');
  assert.strictEqual(s.outcome, 'queued',
    'a queued steer was recorded as sent, which promises a delivery that has not happened');
  assert.match(s.outcomeNote, /queued/i);
  assert.match(s.outcomeNote, /turn ends|idle|types/i,
    'the note does not say what the message is waiting for, so "queued" reads as a synonym for sent');
});

check('an owned session still reports a plain send', () => {
  // An ACP session is written to directly, so `sent` there is the truth and
  // must not be softened into a maybe.
  const s = composerReduce({ draft: 'x', control: CONTROL.SYNCED, reason: '' }, { type: 'sent' });
  assert.strictEqual(s.outcome, 'sent');
  assert.strictEqual(s.outcomeNote, '');
});

check('typing again clears the outcome of the last message', () => {
  let s = composerReduce(undefined, { type: 'sent', queued: true });
  assert.ok(s.outcomeNote, 'nothing to clear, so this proves nothing');
  s = composerReduce(s, { type: 'type', text: 'a new message' });
  assert.strictEqual(s.outcomeNote, '',
    'a stale "queued" note hung over an unrelated draft');
});

check('the reducer never mutates the state it was handed', () => {
  const before = { draft: 'original', control: CONTROL.SYNCED, reason: '' };
  composerReduce(before, { type: 'type', text: 'changed' });
  assert.strictEqual(before.draft, 'original');
});

check('an unknown event changes nothing', () => {
  const before = { draft: 'd', control: CONTROL.SYNCED, reason: 'r' };
  assert.deepStrictEqual(composerReduce(before, { type: 'nonsense' }), before);
  assert.deepStrictEqual(composerReduce(before, null), before);
});

check('a timeout says the device did not answer, rather than nothing at all', () => {
  const s = composerReduce(undefined, { type: 'verify-result', outcome: { timedOut: true } });
  assert.ok(s.reason, 'an empty reason under "could not be verified" tells a person nothing');
});

// ---------------------------------------------------------------------------
// The protocol: a real daemon answering control-check
// ---------------------------------------------------------------------------
const { Daemon } = require('../src/daemon');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhub-s5-'));
process.env.SQUAD_HUB_HOME = home;

(async () => {
  const d = new Daemon({ approvalTtlMs: 50 });

  await checkAsync('an unknown session is refused, with a reason, not an exception', async () => {
    const r = await d.handle({ op: 'control-check', sessionId: 'no-such-session' });
    assert.strictEqual(r.controllable, false);
    assert.ok(r.reason, 'a refusal with no reason is indistinguishable from a transport failure');
    // The point: it RESOLVED. An exception here could not be told apart from
    // the request never arriving, which is a different state entirely.
  });

  await checkAsync('a live session is controllable', async () => {
    const s = {
      id: 'live', status: 'active', pid: process.pid,
      isAgentDead: () => false, pendingApprovals: new Map(),
    };
    d.sessions.set('live', s);
    const r = await d.handle({ op: 'control-check', sessionId: 'live' });
    assert.strictEqual(r.controllable, true);
    assert.strictEqual(r.status, 'active');
  });

  await checkAsync('a session whose agent has died is NOT controllable', async () => {
    d.sessions.set('dead', {
      id: 'dead', status: 'active', pid: 999999,
      isAgentDead: () => true, pendingApprovals: new Map(),
    });
    const r = await d.handle({ op: 'control-check', sessionId: 'dead' });
    assert.strictEqual(r.controllable, false,
      'the status still says active; only the device can tell you the process is gone');
    assert.match(r.reason, /agent process is gone/);
  });

  for (const status of ['done', 'failed', 'stopped']) {
    await checkAsync(`a ${status} session is not controllable`, async () => {
      d.sessions.set(status, {
        id: status, status, pid: process.pid,
        isAgentDead: () => false, pendingApprovals: new Map(),
      });
      const r = await d.handle({ op: 'control-check', sessionId: status });
      assert.strictEqual(r.controllable, false);
      assert.match(r.reason, new RegExp(status));
    });
  }

  // --- approval expiry ----------------------------------------------------

  // The control-check fixtures above include a session whose agent is dead on
  // purpose; a heartbeat would try to fail it and is not what these test.
  d.sessions.clear();

  await checkAsync('an approval nobody answered expires, and the session resumes', async () => {
    /**
     * An approval gate with no approver is a hang: the agent is blocked on a
     * question, the person it was asked of has gone home, and the session
     * holds a process and a slot in everyone's list indefinitely.
     */
    const responded = [];
    const expired = [];
    const session = {
      id: 'gated',
      status: 'waiting_approval',
      pid: process.pid,
      isAgentDead: () => false,
      pendingApprovals: new Map([['a1', { approvalId: 'a1', rpcId: 7, requestedAt: Date.now() - 10000 }]]),
      expire(id) {
        const a = this.pendingApprovals.get(id);
        if (!a) return false;
        this.pendingApprovals.delete(id);
        responded.push({ id, outcome: 'cancelled' });
        this.status = 'active';
        expired.push(id);
        return true;
      },
    };
    d.sessions.set('gated', session);

    d.beat();

    assert.deepStrictEqual(expired, ['a1'], 'the stale approval was never expired');
    assert.strictEqual(session.pendingApprovals.size, 0);
    assert.strictEqual(session.status, 'active',
      'the session must resume; a cancelled tool is something an agent handles, waiting forever is not');
    assert.deepStrictEqual(responded[0].outcome, 'cancelled');
  });

  await checkAsync('a RECENT approval is left alone', async () => {
    const session = {
      id: 'fresh', status: 'waiting_approval', pid: process.pid,
      isAgentDead: () => false,
      pendingApprovals: new Map([['a2', { approvalId: 'a2', rpcId: 8, requestedAt: Date.now() }]]),
      expire() { throw new Error('a fresh approval must never be expired'); },
    };
    d.sessions.set('fresh', session);
    d.beat();
    assert.strictEqual(session.pendingApprovals.size, 1,
      'this is a backstop against a question nobody will answer, not a deadline for a person');
  });

  await checkAsync('the default approval lifetime is about half an hour', async () => {
    const plain = new Daemon();
    assert.strictEqual(plain.approvalTtlMs, 30 * 60 * 1000);
  });

  await checkAsync('a re-adopted session cannot bring the heartbeat down', async () => {
    /**
     * A session recovered from disk after a restart is a record, not a live
     * agent connection -- it has no pendingApprovals map at all. The expiry
     * sweep runs inside beat(), and an exception there does not fail one
     * session: it stops the loop that watches every session on the device.
     * This threw on the first run and took the whole heartbeat suite with it.
     */
    d.sessions.clear();
    d.sessions.set('adopted', { id: 'adopted', status: 'active', pid: process.pid, isAgentDead: () => false });
    assert.doesNotThrow(() => d.beat(), 'the heartbeat died on a session shape it did not expect');
  });

  // --- Sync session: restart the engine, keep the identity -----------------

  await checkAsync('Sync restarts the engine UNDER THE SAME session id', async () => {
    /**
     * The id is what the row, the Teams card and anyone's terminal history all
     * refer to. A "sync" that produced a new session would orphan every one of
     * those references while looking like it worked.
     */
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhub-s5b-'));
    const d2 = new Daemon({
      agentCommand: process.execPath,
      agentArgs: [path.join(__dirname, 'fake-agent.js')],
    });
    d2.sessions.clear();

    const first = d2.startSession({ prompt: 'do the thing', localCwd: home2 });
    const originalId = first.id;
    const originalPid = first.pid;

    const second = d2.resyncSession(originalId);

    assert.strictEqual(second.id, originalId, 'the session id changed; every reference to it is now dead');
    assert.notStrictEqual(second.pid, originalPid, 'no new engine was started');
    assert.strictEqual(d2.sessions.get(originalId), second, 'the daemon still points at the old engine');
    assert.strictEqual(second.resyncCount, 1, 'the resync was not recorded');

    for (const s of d2.sessions.values()) { try { s.stop(); } catch { /* closing */ } }
    // Windows holds the directory while the child processes wind down, and a
    // failed rmSync would fail the test on housekeeping rather than behaviour.
    try { fs.rmSync(home2, { recursive: true, force: true }); } catch { /* the OS still has it */ }
  });

  await checkAsync('Sync keeps the transcript, which did not stop being true', async () => {
    const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhub-s5c-'));
    const d3 = new Daemon({
      agentCommand: process.execPath,
      agentArgs: [path.join(__dirname, 'fake-agent.js')],
    });
    const s = d3.startSession({ prompt: 'p', localCwd: home3 });
    s.transcript = [{ seq: 1, at: Date.now(), update: { sessionUpdate: 'tool_call', title: 'a thing that happened' } }];

    const again = d3.resyncSession(s.id);
    assert.strictEqual(again.transcript.length, 1,
      'the record of what happened was thrown away with the process that produced it');

    for (const x of d3.sessions.values()) { try { x.stop(); } catch { /* closing */ } }
    try { fs.rmSync(home3, { recursive: true, force: true }); } catch { /* the OS still has it */ }
  });

  await checkAsync('Sync on an unknown session is refused, not silently ignored', async () => {
    assert.throws(() => d.resyncSession('no-such-thing'), /no such session/);
  });

  // --- Expired approvals are reported, not vanished ------------------------

  await checkAsync('an expired approval is recorded so the UI can say what happened', async () => {
    /**
     * Somebody saw a card asking permission. When it lapses they are owed an
     * answer to "what happened to that?" -- otherwise the request vanishes and
     * the only trace is a session carrying on without doing the thing.
     */
    const { AcpSession } = require('../src/acp-session');
    const s = Object.create(AcpSession.prototype);
    s.pendingApprovals = new Map([['a1', {
      approvalId: 'a1', rpcId: 3, title: 'Delete the build directory', requestedAt: Date.now() - 60000,
    }]]);
    s.expiredApprovals = [];
    s.status = 'waiting_approval';
    s._respond = () => {};
    s._setStatus = (next, activity) => { s.status = next; s.activity = activity; };
    s.emit = () => {};

    assert.strictEqual(s.expire('a1'), true);
    assert.strictEqual(s.expiredApprovals.length, 1, 'the expiry left no trace at all');
    assert.strictEqual(s.expiredApprovals[0].approvalId, 'a1');
    assert.match(s.expiredApprovals[0].title, /Delete the build directory/,
      'the record must say WHAT expired, or it explains nothing');
    assert.ok(s.expiredApprovals[0].expiredAt, 'no time was recorded');
    assert.strictEqual(s.status, 'active', 'the session must resume, not sit in waiting_approval');
  });

  // --- Answering: the right request, by a named person ---------------------

  function gated(opts = {}) {
    const { AcpSession } = require('../src/acp-session');
    const s = Object.create(AcpSession.prototype);
    s.pendingApprovals = new Map(Object.entries(opts.pending || {
      a1: {
        approvalId: 'a1', rpcId: 3, title: 'Run the tests', requestedAt: Date.now(),
        options: [{ optionId: 'allow_once' }, { optionId: 'reject_once' }],
      },
    }));
    s.expiredApprovals = [];
    s.answeredApprovals = [];
    s.status = 'waiting_approval';
    s.responded = [];
    s._respond = (rpcId, payload) => s.responded.push({ rpcId, payload });
    s._setStatus = (next, activity) => { s.status = next; s.activity = activity; };
    s.emit = () => {};
    return s;
  }

  await checkAsync('an answer for the WRONG request id is rejected', async () => {
    const s = gated();
    assert.strictEqual(s.answer('not-the-one', 'allow_once'), false);
    assert.strictEqual(s.responded.length, 0, 'the agent was answered for a request it did not ask');
    assert.strictEqual(s.pendingApprovals.size, 1, 'the real request was disturbed');
  });

  await checkAsync('a forged option id leaves the real request still answerable', async () => {
    /**
     * This deleted the approval BEFORE checking the option, then returned
     * false. The caller saw a refusal, the agent stayed blocked, and nothing
     * was pending any more -- so no surface could offer the question again and
     * the session hung until the expiry backstop. The existing forged-option
     * test only asserted a nonzero exit and that the tool had not run, so it
     * passed throughout.
     */
    const s = gated();
    assert.strictEqual(s.answer('a1', 'allow_everything_forever'), false);
    assert.strictEqual(s.pendingApprovals.size, 1,
      'a refused answer destroyed the request it refused');
    assert.strictEqual(s.answer('a1', 'allow_once'), true,
      'the request could no longer be answered properly');
  });

  await checkAsync('answering one of TWO simultaneous prompts resolves the right one', async () => {
    const s = gated({
      pending: {
        a1: { approvalId: 'a1', rpcId: 11, title: 'first', requestedAt: 1, options: [{ optionId: 'allow_once' }] },
        a2: { approvalId: 'a2', rpcId: 22, title: 'second', requestedAt: 2, options: [{ optionId: 'allow_once' }] },
      },
    });
    assert.strictEqual(s.answer('a2', 'allow_once'), true);
    assert.deepStrictEqual(s.responded.map((r) => r.rpcId), [22],
      'the wrong agent request was answered -- resolution is by index, not by id');
    assert.ok(s.pendingApprovals.has('a1'), 'the other request was resolved too');
  });

  await checkAsync('a resolved approval records WHO answered it', async () => {
    const s = gated();
    s.answer('a1', 'allow_once', 'Brian');
    assert.strictEqual(s.answeredApprovals.length, 1);
    assert.strictEqual(s.answeredApprovals[0].answeredBy, 'Brian',
      'on a hub two people can watch, "resolved" without "by whom" answers a different question');
    assert.strictEqual(s.answeredApprovals[0].optionId, 'allow_once');
    assert.match(s.answeredApprovals[0].title, /Run the tests/);
  });

  await checkAsync('an unattributed answer still says something, rather than nothing', async () => {
    const s = gated();
    s.answer('a1', 'allow_once');
    assert.ok(s.answeredApprovals[0].answeredBy, 'a blank name renders as a rendering bug');
  });

  await checkAsync('the answered list does not grow without bound', async () => {
    const s = gated();
    for (let i = 0; i < 40; i += 1) {
      s.pendingApprovals.set(`x${i}`, { approvalId: `x${i}`, rpcId: i, title: `t${i}`, requestedAt: 1, options: [{ optionId: 'allow_once' }] });
      s.answer(`x${i}`, 'allow_once', 'someone');
    }
    assert.ok(s.answeredApprovals.length <= 20, `unbounded: ${s.answeredApprovals.length}`);
  });

  await checkAsync('the hub attaches the caller identity to an approve, from the validated token', async () => {
    // Never from the request body -- otherwise anyone could claim to be anyone.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'service', 'hub-service.js'), 'utf8');
    assert.match(src, /answeredBy: me\.name \|\| me\.key/,
      'the identity must come from the validated caller, not from what was posted');
  });

  // --- Outbound only -------------------------------------------------------

  await checkAsync('the daemon listens on no TCP port at all', async () => {
    /**
     * The architectural promise the whole design rests on: a device dials OUT,
     * so nothing has to be opened on a laptop or reachable inside an ACA job.
     * Asserted against the running process rather than against a comment,
     * because a comment cannot notice someone adding a listener.
     */
    const home4 = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhub-out-'));
    const prior = process.env.SQUAD_HUB_HOME;
    process.env.SQUAD_HUB_HOME = home4;
    const d4 = new Daemon();
    try {
      await d4.listen();
      const handles = (process._getActiveHandles ? process._getActiveHandles() : [])
        .filter((h) => h && h.constructor && h.constructor.name === 'Server')
        .map((h) => { try { return h.address(); } catch { return null; } })
        .filter(Boolean);
      const tcp = handles.filter((a) => typeof a === 'object' && a.port);
      assert.deepStrictEqual(tcp, [],
        `the daemon opened a TCP port: ${JSON.stringify(tcp)} -- devices must dial out only`);
    } finally {
      try { await d4.close(); } catch { /* closing */ }
      if (prior === undefined) delete process.env.SQUAD_HUB_HOME;
      else process.env.SQUAD_HUB_HOME = prior;
      try { fs.rmSync(home4, { recursive: true, force: true }); } catch { /* held */ }
    }
  });

  await checkAsync('the expired list does not grow without bound', async () => {    const { AcpSession } = require('../src/acp-session');
    const s = Object.create(AcpSession.prototype);
    s.expiredApprovals = [];
    s.status = 'active';
    s._respond = () => {};
    s._setStatus = () => {};
    s.emit = () => {};
    for (let i = 0; i < 40; i += 1) {
      s.pendingApprovals = new Map([[`a${i}`, { approvalId: `a${i}`, rpcId: i, title: `t${i}`, requestedAt: 1 }]]);
      s.expire(`a${i}`);
    }
    assert.ok(s.expiredApprovals.length <= 20,
      `an unbounded list on a long-running session: ${s.expiredApprovals.length}`);
    assert.strictEqual(s.expiredApprovals[s.expiredApprovals.length - 1].approvalId, 'a39',
      'the most recent expiry was dropped, which is the one worth keeping');
  });

  // --- the route ----------------------------------------------------------

  await checkAsync('the hub routes control-check to the device', async () => {
    const svcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'service', 'hub-service.js'), 'utf8');
    assert.match(svcSrc, /control-check/,
      'the client asks for it; without a route it 404s and every session reads as unverified');
  });

  await checkAsync('the daemon accepts control-check from the hub, not only over IPC', async () => {
    const daemonSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.js'), 'utf8');
    assert.match(daemonSrc, /case 'control-check':\s*\n\s*result = await this\.handle/,
      'a command the hub cannot forward can only ever be answered locally');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(`ERROR: ${e.message}`);
  console.log(e.stack);
  process.exit(1);
});
