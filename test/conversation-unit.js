'use strict';
/**
 * A session you can reply to.
 *
 * ACP is a conversational protocol: `session/prompt` returning means THIS TURN
 * ended, not that the conversation is over. The hub used to mark the session
 * `done` and kill the agent the moment the first turn returned -- so an agent
 * that ended its turn by asking a question ("4. Is that correct?") left a
 * session displaying "Ready for review", offering a composer, and refusing
 * every message typed into it with "this session is not accepting input".
 *
 * Measured against the real CLI before this was written: `copilot --acp` stays
 * alive after a turn and answers a second prompt. The protocol was doing its
 * job; the hub was hanging up.
 *
 * The assertions here are about the lifecycle, driven through a stand-in agent
 * so they are fast and deterministic. The end-to-end proof against real Copilot
 * lives in run-tests.js.
 */

const assert = require('assert');
const { EventEmitter } = require('events');

const { AcpSession, STATUS } = require('../src/acp-session');

let pass = 0; let fail = 0;
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }

const wait = (fn, ms = 3000) => new Promise((res, rej) => {
  const t = Date.now();
  const i = setInterval(() => {
    if (fn()) { clearInterval(i); res(true); } else if (Date.now() - t > ms) { clearInterval(i); rej(new Error('timeout')); }
  }, 5);
});

/**
 * A session with no child process, whose protocol calls resolve when told to.
 *
 * `isAgentDead` is overridden rather than faked with a real process: what these
 * assertions are about is what the SESSION does when a turn ends, and spawning
 * a process would test the operating system instead.
 */
function fakeSession({ agentAlive = true } = {}) {
  const s = Object.create(AcpSession.prototype);
  EventEmitter.call(s);
  Object.assign(s, EventEmitter.prototype);
  s._events = {};
  s._eventsCount = 0;
  s.id = 's1';
  s.status = STATUS.STARTING;
  s.activity = null;
  s.transcript = [];
  s.acpSessionId = 'acp-1';
  s.pendingApprovals = new Map();
  s._pending = new Map();
  s.sent = [];
  s.killed = false;
  s.isAgentDead = () => !agentAlive;
  s.shutdown = function shutdown() { this._clearIdleTimer(); this.killed = true; };
  s._pushTranscript = function push(e) { this.transcript.push(e); };
  s._resolvers = [];
  s._request = (method, params) => {
    s.sent.push({ method, params });
    return new Promise((resolve) => { s._resolvers.push(resolve); });
  };
  return s;
}

// --- a finished turn leaves a session you can talk to ------------------------

check('a finished turn goes IDLE, and does NOT kill the agent', async () => {
  const s = fakeSession();
  s._goIdle();
  assert.strictEqual(s.status, STATUS.IDLE);
  assert.strictEqual(s.killed, false, 'the agent was killed when its turn ended');
  s.stop();
});

check('an idle session accepts a reply', async () => {
  const s = fakeSession();
  s._goIdle();
  assert.strictEqual(s.steer('carry on'), true, 'a reply was refused by a session that is waiting for one');
  assert.strictEqual(s.status, STATUS.ACTIVE);
  const sent = s.sent.find((c) => c.method === 'session/prompt');
  assert.ok(sent, 'the reply never reached the agent');
  assert.strictEqual(sent.params.prompt[0].text, 'carry on');
  s.stop();
});

check('the reply appears in the transcript, so the conversation reads back', async () => {
  const s = fakeSession();
  s._goIdle();
  s.steer('carry on');
  const mine = s.transcript.filter((e) => e.sessionUpdate === 'user_message');
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].content.text, 'carry on');
  s.stop();
});

check('a SECOND turn also ends idle, so a conversation is not a single exchange', async () => {
  // The bug this catches: making only the first turn resumable, so a reply
  // works once and the session dies on the answer to it.
  const s = fakeSession();
  s._goIdle();
  s.steer('one');
  assert.strictEqual(s.status, STATUS.ACTIVE);
  s._resolvers.pop()({ stopReason: 'end_turn' });
  await wait(() => s.status === STATUS.IDLE);
  assert.strictEqual(s.killed, false);
  assert.strictEqual(s.steer('two'), true, 'the session took one reply and then stopped listening');
  s.stop();
});

check('a turn that ends in an error still leaves a session you can reply to', async () => {
  const s = fakeSession();
  s._goIdle();
  s.steer('one');
  s._resolvers.pop()(Promise.reject(new Error('boom')));
  // The rejection path pushes an error and returns to idle rather than
  // stranding the session in ACTIVE forever.
  await wait(() => s.status === STATUS.IDLE);
  assert.strictEqual(s.steer('two'), true);
  s.stop();
});

// --- what must still be refused ---------------------------------------------

check('a stopped session refuses a reply', async () => {
  const s = fakeSession();
  s._goIdle();
  s.stop();
  assert.strictEqual(s.status, STATUS.STOPPED);
  assert.strictEqual(s.steer('hello'), false, 'a stopped session accepted input');
});

check('a session whose agent has died refuses a reply rather than lying', async () => {
  // The original defect in miniature: saying "sent" when there is nothing on
  // the other end. The UI then shows the message as delivered.
  const s = fakeSession({ agentAlive: false });
  s.status = STATUS.IDLE;
  assert.strictEqual(s.steer('hello'), false);
});

check('a turn that ends after the agent has gone reports DONE, not IDLE', async () => {
  const s = fakeSession({ agentAlive: false });
  s._goIdle();
  assert.strictEqual(s.status, STATUS.DONE, 'a dead agent was reported as waiting for a reply');
  assert.ok(s.endedAt > 0, 'a finished session has no end time');
});

check('an empty reply is refused', async () => {
  const s = fakeSession();
  s._goIdle();
  assert.strictEqual(s.steer(''), false);
  assert.strictEqual(s.steer(null), false);
  s.stop();
});

// --- the session does not live forever --------------------------------------

check('an idle session is reaped, and its agent stopped, once nobody comes back', async () => {
  // A conversation you can return to is the point; a process that lives
  // forever because someone closed a tab is a leak.
  const prior = process.env.SQUAD_HUB_IDLE_MS;
  process.env.SQUAD_HUB_IDLE_MS = '40';
  delete require.cache[require.resolve('../src/acp-session')];
  // eslint-disable-next-line global-require
  const fresh = require('../src/acp-session');
  const s = Object.create(fresh.AcpSession.prototype);
  EventEmitter.call(s);
  Object.assign(s, EventEmitter.prototype);
  s._events = {}; s._eventsCount = 0;
  s.id = 's1'; s.status = fresh.STATUS.STARTING; s.transcript = []; s.pendingApprovals = new Map();
  s.isAgentDead = () => false;
  s.killed = false;
  s.shutdown = function shutdown() { this._clearIdleTimer(); this.killed = true; };
  s._goIdle();
  assert.strictEqual(s.status, fresh.STATUS.IDLE);
  await wait(() => s.status === fresh.STATUS.DONE, 2000);
  assert.strictEqual(s.killed, true, 'the idle session was closed but its agent left running');

  if (prior === undefined) delete process.env.SQUAD_HUB_IDLE_MS;
  else process.env.SQUAD_HUB_IDLE_MS = prior;
  delete require.cache[require.resolve('../src/acp-session')];
});

check('a reply resets the idle clock, so a live conversation is never reaped', async () => {
  const s = fakeSession();
  s._goIdle();
  const first = s._idleTimer;
  assert.ok(first, 'no idle timer was armed');
  s.steer('still here');
  assert.strictEqual(s._idleTimer, null, 'the idle timer survived a reply and would close a live session');
  s.stop();
});

check('stopping a session clears its idle timer', async () => {
  const s = fakeSession();
  s._goIdle();
  s.stop();
  assert.strictEqual(s._idleTimer, null, 'a stopped session left a timer holding a reference');
});

check('an idle session is never described as running something', async () => {
  // Observed live on two sessions: status `idle`, activity "Running <tool>".
  // A trailing update arrives just after the turn ends and relabels a session
  // that is in fact waiting for the person reading it.
  const s = fakeSession();
  s._goIdle();
  const was = s.activity;
  s._update({ update: { sessionUpdate: 'tool_call', title: 'Run full test suite' } });
  s._update({ update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x' } } });
  assert.strictEqual(s.activity, was, `an idle session reads as: ${s.activity}`);
  assert.doesNotMatch(s.activity, /Running|Processing/);
  s.stop();
});

check('a session blocked on an approval is never described as running something', async () => {
  const s = fakeSession();
  s.status = STATUS.WAITING_APPROVAL;
  s.activity = 'Waiting for approval';
  s._update({ update: { sessionUpdate: 'tool_call', title: 'rm -rf /' } });
  assert.strictEqual(s.activity, 'Waiting for approval');
});

check('a session that IS running still shows what it is running', async () => {
  // The accepting direction. Without it, an activity line that never updated
  // would satisfy both assertions above.
  const s = fakeSession();
  s.status = STATUS.ACTIVE;
  s._update({ update: { sessionUpdate: 'tool_call', title: 'Run full test suite' } });
  assert.strictEqual(s.activity, 'Running Run full test suite');
});

check('a stopped session is not relabelled by a late update', async () => {
  const s = fakeSession();
  s._goIdle();
  s.stop();
  s._update({ update: { sessionUpdate: 'tool_call', title: 'something' } });
  assert.doesNotMatch(s.activity, /Running/);
});

(async () => {
  for (const { name, fn } of queue) {
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
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
