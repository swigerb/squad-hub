#!/usr/bin/env node
'use strict';
/**
 * The next turn's mode and model (#183): everything from the agent's RPC to the
 * hub's route, with a real `fake-agent.js` child where a process is involved.
 *
 * The browser side lives in `next-turn-browser-unit.js`; this suite is the part
 * that has to be right BEFORE any page exists -- a change and the prompt it is
 * for are one operation, a value the agent never advertised never reaches it,
 * and nothing is ever reported as applied that the agent did not confirm.
 *
 * Assertions are about SIDE EFFECTS, not replies: the fake agent logs every mode
 * and model RPC and, for each prompt, the mode and model that prompt would RUN
 * in (FAKE_AGENT_RPC_LOG). "Applied before the prompt" is read off that log.
 * Every check here is paired with a `test/mutate.js` mutation that removes the
 * control it asserts.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.SQUAD_HUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqnext-'));

const { Daemon } = require(path.join(__dirname, '..', 'src', 'daemon'));
const { TuiSession } = require(path.join(__dirname, '..', 'src', 'tui-session'));
const { AcpSession, STATUS } = require(path.join(__dirname, '..', 'src', 'acp-session'));
const { HubService } = require(path.join(__dirname, '..', 'src', 'service', 'hub-service'));
const { Authenticator, MODES } = require(path.join(__dirname, '..', 'src', 'service', 'auth'));
const { HubLink } = require(path.join(__dirname, '..', 'src', 'hub-link'));

const FAKE_AGENT = path.join(__dirname, 'fake-agent.js');
const modeUri = (n) => `https://agentclientprotocol.com/protocol/session-modes#${n}`;

let pass = 0; let fail = 0;
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
async function until(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const live = [];
function work() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sqnext-w-'));
}

/** One real fake-agent child, advertising what `variant` says it does. */
function acp(variant, env = {}) {
  const dir = work();
  const s = new AcpSession({
    id: `nt-${live.length}`,
    cwd: dir,
    prompt: 'first turn',
    agentCommand: process.execPath,
    agentArgs: [FAKE_AGENT],
    env: {
      FAKE_AGENT_MODE: 'no-permission',
      FAKE_AGENT_NEXT_TURN: variant,
      FAKE_AGENT_RPC_LOG: 'rpc.jsonl',
      FAKE_AGENT_MARKER: 'marker.txt',
      ...env,
    },
  });
  s.dir = dir;
  live.push(s);
  s.run().catch(() => { /* a failed session shows in its status */ });
  return s;
}
async function session(variant, env) {
  const s = acp(variant, env);
  await until(() => s.status === STATUS.IDLE && s.acpSessionId, 'the first turn to end');
  return s;
}
const killAll = () => { for (const s of live) { try { s.proc.kill(); } catch { /* gone */ } } };

const readLog = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, 'rpc.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
/** Everything the agent logged after the session's own first prompt. */
const afterFirst = (s) => {
  const log = readLog(s.dir);
  return log.slice(log.findIndex((e) => e.method === 'session/prompt') + 1);
};
const calls = (log) => log.map((e) => (e.field ? `${e.method}:${e.field}` : e.method));
const updates = (s) => s.transcript.map((e) => e.update);
const idle = (s) => until(() => s.status === STATUS.IDLE && s._pendingSteers === 0, 'the turn to end');

(async () => {
// ---------------------------------------------------------------------------
// A. AcpSession against an agent that advertises what Copilot 1.0.9x does
// ---------------------------------------------------------------------------

await checkAsync('next turn: the selectors offer exactly what the agent advertised, labeled Agent, Plan and Autopilot', async () => {
  const s = await session('copilot');
  const nt = s.nextTurnState();
  assert.strictEqual(nt.supported, true, JSON.stringify(nt));
  assert.deepStrictEqual(nt.mode.choices.map((c) => c.name), ['Agent', 'Plan', 'Autopilot']);
  assert.deepStrictEqual(nt.mode.choices.map((c) => c.id), [modeUri('agent'), modeUri('plan'), modeUri('autopilot')]);
  assert.strictEqual(nt.mode.current, modeUri('agent'));
  // The agent lists "auto" twice; a person should not see it twice.
  assert.deepStrictEqual(nt.model.choices.map((c) => c.id), ['auto', 'fake-fast', 'fake-deep']);
  assert.strictEqual(nt.model.current, 'fake-fast');
  assert.strictEqual(nt.mode.reason, null);
});

await checkAsync('next turn: a mode and model are applied BEFORE the prompt, which then runs in them', async () => {
  const s = await session('copilot');
  const r = await s.steerWithSelection('plan this with the deep model', { mode: 'plan', model: 'fake-deep' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.sent, true);
  await idle(s);
  const log = afterFirst(s);
  assert.deepStrictEqual(calls(log), [
    'session/set_config_option:model', 'session/set_config_option:mode', 'session/prompt',
  ], 'the changes must land before the prompt, model first and mode last');
  const prompt = log[2];
  assert.strictEqual(prompt.mode, 'plan', 'the prompt ran in the wrong mode');
  assert.strictEqual(prompt.model, 'fake-deep', 'the prompt ran on the wrong model');
  assert.strictEqual(prompt.text, 'plan this with the deep model');
  assert.deepStrictEqual(r.changes.map((c) => `${c.field}:${c.to}`), ['model:fake-deep', `mode:${modeUri('plan')}`]);
});

await checkAsync('next turn: the change goes over session/set_config_option with the advertised id, never session/set_mode or set_model', async () => {
  const s = await session('copilot');
  await s.steerWithSelection('hello', { mode: 'plan', model: 'fake-deep' });
  await idle(s);
  const log = afterFirst(s);
  const methods = new Set(log.map((e) => e.method));
  assert.deepStrictEqual([...methods].sort(), ['session/prompt', 'session/set_config_option']);
  const mode = log.find((e) => e.field === 'mode');
  assert.strictEqual(mode.value, modeUri('plan'), `the wire value was ${mode.value}, not the advertised id`);
});

await checkAsync('next turn: a mode named by label, case or fragment is sent as the id the agent advertised', async () => {
  const s = await session('copilot');
  await s.steerWithSelection('one', { mode: 'Autopilot' });
  await idle(s);
  await s.steerWithSelection('two', { mode: 'AGENT' });
  await idle(s);
  await s.steerWithSelection('three', { model: 'FAKE DEEP' });
  await idle(s);
  const sets = afterFirst(s).filter((e) => e.field === 'mode').map((e) => e.value);
  assert.deepStrictEqual(sets, [modeUri('autopilot'), modeUri('agent')]);
  const models = afterFirst(s).filter((e) => e.field === 'model').map((e) => e.value);
  assert.deepStrictEqual(models, ['fake-deep'], 'a model asked for by its display name was not found');

  // An agent whose display names are not the end of its ids: the label and the
  // # fragment are two different ways to find the same choice.
  const r = await session('renamed');
  await r.steerWithSelection('four', { mode: 'PLAN' });
  await idle(r);
  await r.steerWithSelection('five', { mode: 'hands OFF' });
  await idle(r);
  assert.deepStrictEqual(afterFirst(r).filter((e) => e.field === 'mode').map((e) => e.value),
    [modeUri('plan'), modeUri('autopilot')], 'a mode was not found by the end of its id, or by its display name');
});

await checkAsync('next turn: each applied change lands in the transcript, before the message that needed it', async () => {
  const s = await session('copilot');
  await s.steerWithSelection('go on', { mode: 'plan', model: 'fake-deep' });
  await idle(s);
  const u = updates(s);
  const changes = u.filter((x) => x.sessionUpdate === 'selection_change');
  assert.deepStrictEqual(changes.map((c) => c.content.text), ['model → fake-deep', 'mode → plan']);
  assert.strictEqual(changes[1].from, 'Agent');
  assert.strictEqual(changes[1].to, 'Plan');
  const lastChange = u.map((x) => x.sessionUpdate).lastIndexOf('selection_change');
  const message = u.findIndex((x) => x.sessionUpdate === 'user_message' && x.content.text === 'go on');
  assert.ok(message > lastChange && lastChange >= 0, 'the message must follow the changes it was sent with');
});

await checkAsync('next turn: an unknown mode is refused, and nothing is sent, changed or announced', async () => {
  const s = await session('copilot');
  const r = await s.steerWithSelection('hello', { mode: 'turbo' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.code, 'selection-not-offered');
  assert.match(r.reason, /Agent, Plan, Autopilot/, 'the refusal should say what IS on offer');
  assert.deepStrictEqual(afterFirst(s), [], 'a refused change still reached the agent');
  assert.strictEqual(s.status, STATUS.IDLE);
  assert.strictEqual(s.nextTurnState().mode.current, modeUri('agent'));
  assert.ok(!updates(s).some((x) => x.sessionUpdate === 'selection_change'), 'a change was announced that never happened');
});

await checkAsync('next turn: an unknown model is refused, and nothing is sent or changed', async () => {
  const s = await session('copilot');
  const r = await s.steerWithSelection('hello', { model: 'gpt-imaginary' });
  assert.strictEqual(r.code, 'selection-not-offered', JSON.stringify(r));
  assert.deepStrictEqual(afterFirst(s), []);
  assert.strictEqual(s.nextTurnState().model.current, 'fake-fast');
});

await checkAsync('next turn: every value is validated BEFORE any change is made, so a good mode is not applied beside a bad model', async () => {
  const s = await session('copilot');
  const r = await s.steerWithSelection('hello', { mode: 'autopilot', model: 'gpt-imaginary' });
  assert.strictEqual(r.code, 'selection-not-offered', JSON.stringify(r));
  assert.deepStrictEqual(afterFirst(s), [], 'the valid half of a refused request was still applied');
  assert.strictEqual(s.nextTurnState().mode.current, modeUri('agent'));
  // And the other way round: the model is the step that is applied first.
  const other = await s.steerWithSelection('hello', { model: 'fake-deep', mode: 'turbo' });
  assert.strictEqual(other.code, 'selection-not-offered', JSON.stringify(other));
  assert.deepStrictEqual(afterFirst(s), [], 'a valid model was applied beside a bad mode');
  assert.strictEqual(s.nextTurnState().model.current, 'fake-fast');
});

await checkAsync('next turn: asking for the mode the session already has makes no change and no round trip', async () => {
  const s = await session('copilot');
  const r = await s.steerWithSelection('same mode', { mode: 'agent', model: 'fake-fast' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.changes, []);
  await idle(s);
  assert.deepStrictEqual(calls(afterFirst(s)), ['session/prompt']);
});

await checkAsync('next turn: a steer with no mode or model changes nothing', async () => {
  const s = await session('copilot');
  const r = await s.steerWithSelection('just a reply', {});
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  await idle(s);
  assert.deepStrictEqual(calls(afterFirst(s)), ['session/prompt']);
});

await checkAsync('next turn: an agent that refuses the change gets no prompt, and the session does not claim it applied', async () => {
  const s = await session('refuse-mode');
  const r = await s.steerWithSelection('plan it', { mode: 'plan' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'selection-failed', JSON.stringify(r));
  assert.match(r.reason, /Your message was not sent/);
  assert.deepStrictEqual(calls(afterFirst(s)), ['session/set_config_option:mode'], 'a prompt followed a refused change');
  assert.strictEqual(s.nextTurnState().mode.current, modeUri('agent'), 'the session claims a mode the agent refused');
  const u = updates(s);
  assert.ok(u.some((x) => x.sessionUpdate === 'error' && /could not change the mode/.test(x.content.text)));
  assert.ok(!u.some((x) => x.sessionUpdate === 'selection_change'));
  assert.strictEqual(s.status, STATUS.IDLE, 'the session should still be ready for a reply');
});

await checkAsync('next turn: a refused second change leaves the first confirmed one reported, and the message unsent', async () => {
  const s = await session('refuse-mode');
  const r = await s.steerWithSelection('both', { model: 'fake-deep', mode: 'plan' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.changes.map((c) => c.field), ['model'], 'the confirmed model change must be reported');
  assert.match(r.reason, /model change already confirmed stays in effect/);
  assert.strictEqual(s.nextTurnState().model.current, 'fake-deep');
  assert.ok(!afterFirst(s).some((e) => e.method === 'session/prompt'));
});

await checkAsync('next turn: an agent that accepts a change but reports the OLD value is not believed', async () => {
  const s = await session('ignores');
  const r = await s.steerWithSelection('plan it', { mode: 'plan' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'selection-failed', JSON.stringify(r));
  assert.match(r.reason, /still Agent/);
  assert.strictEqual(s.nextTurnState().mode.current, modeUri('agent'));
  assert.ok(!afterFirst(s).some((e) => e.method === 'session/prompt'), 'the prompt ran in a mode nobody confirmed');
  assert.ok(!updates(s).some((x) => x.sessionUpdate === 'selection_change'));
});

await checkAsync('next turn: an agent that accepts a change and says nothing about it is not believed either', async () => {
  const s = await session('no-readback');
  const r = await s.steerWithSelection('plan it', { mode: 'plan' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'selection-failed', JSON.stringify(r));
  assert.match(r.reason, /did not say what the mode is now/);
  assert.strictEqual(s.nextTurnState().mode.current, modeUri('agent'), 'an unconfirmed change was recorded as applied');
  assert.ok(!afterFirst(s).some((e) => e.method === 'session/prompt'));
});

await checkAsync('next turn: "method not found" disables the selector with a reason, and is remembered', async () => {
  const s = await session('unsupported');
  const first = await s.steerWithSelection('plan it', { mode: 'plan' });
  assert.strictEqual(first.code, 'next-turn-unsupported', JSON.stringify(first));
  const nt = s.nextTurnState();
  assert.strictEqual(nt.mode.supported, false);
  assert.match(nt.mode.reason, /does not support changing the mode/);
  assert.deepStrictEqual(nt.mode.choices, [], 'a disabled selector must offer nothing');
  const again = await s.steerWithSelection('plan it again', { mode: 'plan' });
  assert.strictEqual(again.code, 'next-turn-unsupported');
  assert.strictEqual(afterFirst(s).length, 1, 'the same refused change was tried a second time');
});

await checkAsync('next turn: a model list with nothing confirmable is shown disabled, and a change is refused', async () => {
  const s = await session('models-only');
  const nt = s.nextTurnState();
  assert.strictEqual(nt.supported, false);
  assert.strictEqual(nt.model.supported, false);
  assert.match(nt.model.reason, /no way to confirm a change/);
  assert.match(nt.mode.reason, /did not offer a choice of mode/);
  assert.strictEqual(nt.model.current, 'fake-fast', 'what is current is still worth showing');
  const r = await s.steerWithSelection('hello', { model: 'fake-deep' });
  assert.strictEqual(r.code, 'next-turn-unsupported', JSON.stringify(r));
  assert.deepStrictEqual(afterFirst(s), [], 'an unconfirmable change was sent anyway');
});

await checkAsync('next turn: an agent that advertises nothing is disabled with a plain reason, and an ordinary reply still works', async () => {
  const s = await session('');
  const nt = s.nextTurnState();
  assert.strictEqual(nt.supported, false);
  assert.match(nt.reason, /did not offer a choice of mode/);
  const refused = await s.steerWithSelection('hello', { mode: 'plan' });
  assert.strictEqual(refused.code, 'next-turn-unsupported', JSON.stringify(refused));
  const plain = await s.steerWithSelection('an ordinary reply', {});
  assert.strictEqual(plain.ok, true, JSON.stringify(plain));
});

await checkAsync('next turn: a change the agent never answers is reported as unconfirmed, sends nothing, and frees the session', async () => {
  const s = await session('stuck');
  process.env.SQUAD_HUB_SELECTION_TIMEOUT_MS = '250';
  let r;
  try { r = await s.steerWithSelection('plan it', { mode: 'plan' }); } finally { delete process.env.SQUAD_HUB_SELECTION_TIMEOUT_MS; }
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'selection-failed', JSON.stringify(r));
  assert.match(r.reason, /may or may not have applied/);
  assert.ok(!afterFirst(s).some((e) => e.method === 'session/prompt'));
  assert.strictEqual(s._nextTurn().busy, false, 'the session is stuck "busy" for ever');
  assert.strictEqual(s.status, STATUS.IDLE);
  assert.strictEqual(s.steer('a plain reply'), true, 'a plain reply should still work afterward');
});

await checkAsync('next turn: a second change while one is being applied is refused as busy, and only one prompt is sent', async () => {
  const s = await session('copilot');
  const first = s.steerWithSelection('one', { mode: 'plan' });
  const second = await s.steerWithSelection('two', { mode: 'autopilot' });
  const plain = s.steer('three');
  assert.strictEqual(second.code, 'selection-busy', JSON.stringify(second));
  assert.strictEqual(plain.ok, false, 'a plain reply slipped in between the change and its prompt');
  assert.strictEqual((await first).ok, true);
  await idle(s);
  const prompts = afterFirst(s).filter((e) => e.method === 'session/prompt');
  assert.deepStrictEqual(prompts.map((p) => `${p.text}:${p.mode}`), ['one:plan']);
});

await checkAsync('next turn: a change asked for mid-turn is refused as in progress and touches nothing', async () => {
  const s = acp('copilot', { FAKE_AGENT_MODE: 'approve-gate' });
  await until(() => s.pendingApprovals.size, 'the first turn to ask for approval');
  assert.notStrictEqual(s.status, STATUS.IDLE);
  const r = await s.steerWithSelection('hello', { mode: 'plan' });
  assert.strictEqual(r.code, 'turn-in-progress', JSON.stringify(r));
  assert.deepStrictEqual(calls(afterFirst(s)), [], 'a change reached the agent while a turn was running');
});

await checkAsync('next turn: the mode shown follows the agent when it leaves plan mode on its own', async () => {
  const s = await session('copilot');
  await s.steerWithSelection('EXIT-PLAN when done', { mode: 'plan' });
  await idle(s);
  const prompt = afterFirst(s).find((e) => e.method === 'session/prompt');
  assert.strictEqual(prompt.mode, 'plan');
  assert.strictEqual(s.nextTurnState().mode.current, modeUri('agent'),
    'the composer would keep saying plan after the agent left it');
});

await checkAsync('next turn: an ended session offers nothing and refuses a change', async () => {
  const s = await session('copilot');
  s.stop();
  const nt = s.nextTurnState();
  assert.strictEqual(nt.supported, false);
  assert.strictEqual(nt.mode.reason, 'this session has ended');
  const r = await s.steerWithSelection('hello', { mode: 'plan' });
  assert.strictEqual(r.code, 'not-steerable', JSON.stringify(r));
});

await checkAsync('next turn: a session that ends while its change is being applied sends nothing and says the session changed', async () => {
  const s = await session('slow', { FAKE_AGENT_SLOW_MS: '1500' });
  const pending = s.steerWithSelection('plan it', { mode: 'plan' });
  assert.strictEqual(s._nextTurn().busy, true, 'the change was not in flight');
  s.stop();
  const r = await pending;
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.strictEqual(r.code, 'session-changed', JSON.stringify(r));
  assert.strictEqual(updates(s).filter((x) => x.sessionUpdate === 'user_message').length, 0,
    'a message was written to a session that had ended');
  assert.strictEqual(s._nextTurn().busy, false);
});

// ---------------------------------------------------------------------------
// B. The daemon: the command, the capability, and the sessions it cannot change
// ---------------------------------------------------------------------------

function daemon(over = {}) {
  const d = new Daemon({ hubUrl: null, ...over });
  d.agentCommand = process.execPath;
  d.agentArgs = [FAKE_AGENT];
  return d;
}
async function daemonSession(d, variant) {
  const dir = work();
  Object.assign(process.env, {
    FAKE_AGENT_MODE: 'no-permission', FAKE_AGENT_NEXT_TURN: variant, FAKE_AGENT_RPC_LOG: 'rpc.jsonl',
  });
  const started = await d.handle({ op: 'start-session', prompt: 'first turn', localCwd: dir });
  const s = d.sessions.get(started.id);
  s.dir = dir;
  live.push(s);
  await until(() => s.status === STATUS.IDLE && s.acpSessionId, 'the first turn to end');
  return s;
}

await checkAsync('daemon: a steer with a mode runs the prompt in that mode and reports the confirmed change', async () => {
  const d = daemon();
  const s = await daemonSession(d, 'copilot');
  const r = await d.handle({ op: 'steer', sessionId: s.id, text: 'plan it', mode: 'plan' });
  assert.strictEqual(r.sent, true);
  assert.deepStrictEqual(r.changes.map((c) => c.field), ['mode']);
  await idle(s);
  const prompt = afterFirst(s).find((e) => e.method === 'session/prompt');
  assert.strictEqual(prompt.mode, 'plan');
});

await checkAsync('daemon: a refused selection throws the named code the hub maps, and a malformed one is a bad request', async () => {
  const d = daemon();
  const s = await daemonSession(d, 'copilot');
  const ask = (extra) => d.handle({ op: 'steer', sessionId: s.id, text: 'hi', ...extra }).then(() => null, (e) => e);
  assert.strictEqual((await ask({ mode: 'turbo' })).code, 'selection-not-offered');
  assert.strictEqual((await ask({ model: 'gpt-imaginary' })).code, 'selection-not-offered');
  assert.strictEqual((await ask({ mode: 42 })).code, 'BAD_SELECTION');
  assert.strictEqual((await ask({ mode: '   ' })).code, 'BAD_SELECTION');
  assert.strictEqual((await ask({ model: 'm'.repeat(201) })).code, 'BAD_SELECTION');
  assert.deepStrictEqual(afterFirst(s), [], 'a refused steer reached the agent');
  s.stop();
  assert.strictEqual((await ask({ mode: 'plan' })).code, 'NOT_STEERABLE', 'a session that ended lost the code the hub maps');
});

await checkAsync('daemon: the capability is claimed at registration and withdrawn for a one-shot job', async () => {
  assert.strictEqual(new Daemon({ hubUrl: null }).snapshot().device.capabilities.nextTurnSelection, true);
  assert.strictEqual(new Daemon({ hubUrl: null, nextTurnSelection: false }).snapshot().device.capabilities.nextTurnSelection, false);
});

await checkAsync('daemon: a one-shot device refuses a change and does not deliver the text', async () => {
  const d = daemon({ nextTurnSelection: false });
  const s = await daemonSession(d, 'copilot');
  const e = await d.handle({ op: 'steer', sessionId: s.id, text: 'hi', mode: 'plan' }).then(() => null, (x) => x);
  assert.strictEqual(e && e.code, 'next-turn-unsupported');
  assert.match(e.message, /one-shot/);
  assert.deepStrictEqual(afterFirst(s), [], 'the text was delivered without the change it was sent with');
  const published = d.snapshot().sessions.find((x) => x.id === s.id);
  assert.strictEqual(published.nextTurn.supported, false);
  assert.match(published.nextTurn.mode.reason, /one-shot/);
});

await checkAsync('daemon: a watched terminal session refuses a change and queues nothing', async () => {
  const d = daemon();
  const tui = new TuiSession({ id: 't001', copilotId: 'copilot-abc', cwd: 'C:\\work' });
  d.sessions.set(tui.id, tui);
  const e = await d.handle({ op: 'steer', sessionId: 't001', text: 'hi', mode: 'plan' }).then(() => null, (x) => x);
  assert.strictEqual(e && e.code, 'next-turn-unsupported');
  assert.strictEqual(tui.steerQueue.length, 0, 'the text was queued without its change');
  const nt = tui.toJSON().nextTurn;
  assert.strictEqual(nt.supported, false);
  assert.match(nt.mode.reason, /terminal/);
});

await checkAsync('hub link: a refusal carries its code on the reply, and a success never does', async () => {
  const link = new HubLink({ url: 'ws://127.0.0.1:1/ws', token: 't', deviceId: 'd' });
  const sent = [];
  link.send = (m) => { sent.push(m); return true; };
  link.reply('c1', false, 'nope', 'selection-failed');
  link.reply('c2', true, { ok: 1 }, 'selection-failed');
  link.reply('c3', false, 'plain');
  link.reply('c4', false, 'odd', { not: 'a string' });
  assert.strictEqual(sent[0].code, 'selection-failed');
  assert.strictEqual('code' in sent[1], false, 'a success carried a refusal code');
  assert.strictEqual('code' in sent[2], false);
  assert.strictEqual('code' in sent[3], false, 'a non-string code was passed on');
});

// ---------------------------------------------------------------------------
// C. The hub: the route, the capability gate, and what a browser may read back
// ---------------------------------------------------------------------------

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
      res.on('data', (x) => { b += x; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

await (async () => {
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex') });
  const svc = new HubService({ auth, serveWeb: false });
  const { port } = await svc.listen(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const token = auth.mintDevToken('t1', 'user-1', 'Alice');

  const received = {};
  let script = { ok: true, result: { sent: true, changes: [] } };
  const links = [];
  async function device(id, capabilities, sessions) {
    const link = new HubLink({ url: wsUrl, token, deviceId: id });
    await link.connect();
    link.on('command', (m) => {
      received[id] = m;
      link.reply(m.correlationId, script.ok, script.ok ? script.result : script.error, script.code);
    });
    link.send({
      type: 'register',
      device: { name: id.toUpperCase(), platform: 'win32', fileAccess: 'off', ...(capabilities ? { capabilities } : {}) },
      sessions: sessions || [{ id: 's1', status: 'idle', activity: 'Ready', prompt: null, cwd: '/repo', pendingApprovals: [] }],
    });
    links.push(link);
    return link;
  }

  const hostile = {
    supported: true,
    reason: 'x'.repeat(5000),
    mode: {
      supported: true,
      current: '<script>',
      reason: '<i onmouseover=x>nope</i>',
      choices: [
        { id: modeUri('plan'), name: 'Plan' }, { id: '<img src=x>', name: 'Evil' }, { id: 7, name: 'Number' },
        { id: modeUri('autopilot'), name: '<b onmouseover=x>Auto</b>' },
      ],
    },
    model: {
      supported: true,
      choices: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}` })),
    },
  };
  await device('capable', { nextTurnSelection: true }, [
    {
      id: 's1', status: 'idle', activity: 'Ready', prompt: null, cwd: '/repo', pendingApprovals: [],
      nextTurn: {
        supported: true,
        reason: null,
        mode: { supported: true, reason: null, current: modeUri('agent'), choices: [{ id: modeUri('agent'), name: 'Agent' }, { id: modeUri('plan'), name: 'Plan' }] },
        model: { supported: false, reason: 'no models offered', current: null, choices: [] },
      },
    },
    { id: 's2', status: 'idle', activity: 'Ready', prompt: null, cwd: '/repo', pendingApprovals: [], nextTurn: hostile },
    { id: 's3', status: 'idle', activity: 'Ready', prompt: null, cwd: '/repo', pendingApprovals: [], nextTurn: 'yes please' },
    {
      id: 's4', status: 'idle', activity: 'Ready', prompt: null, cwd: '/repo', pendingApprovals: [],
      nextTurn: { supported: true, mode: { supported: true, choices: 'all of them' }, model: null },
    },
    { id: 's5', status: 'idle', activity: 'Ready', prompt: null, cwd: '/repo', pendingApprovals: [] },
  ]);
  await device('old', null);
  await device('stringy', { nextTurnSelection: 'true' });
  await sleep(400);

  const steer = (id, body) => api(port, `/api/devices/${id}/steer`, token, { method: 'POST', body });

  await checkAsync('hub: a mode and model reach a capable device as strings, and nothing else rides along', async () => {
    delete received.capable;
    const r = await steer('capable', {
      sessionId: 's1', text: 'plan it', mode: ' plan ', model: 'fake-deep', op: 'stop', correlationId: 'forged', extra: 1,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const m = received.capable;
    assert.ok(m, 'nothing reached the device');
    assert.strictEqual(m.op, 'steer');
    assert.notStrictEqual(m.correlationId, 'forged');
    assert.strictEqual(m.mode, 'plan');
    assert.strictEqual(m.model, 'fake-deep');
    assert.strictEqual(m.extra, undefined, 'a field the route does not know was relayed');
  });

  await checkAsync('hub: a steer with no mode or model is relayed exactly as before, even to a device that predates this', async () => {
    for (const id of ['capable', 'old']) {
      delete received[id];
      const r = await steer(id, { sessionId: 's1', text: 'just a reply' });
      assert.strictEqual(r.status, 200, `${id}: ${JSON.stringify(r)}`);
      assert.strictEqual('mode' in received[id], false, `${id}: a mode appeared out of nowhere`);
      assert.strictEqual('model' in received[id], false);
    }
  });

  await checkAsync('hub: a mode or model that is not a short string is refused before it reaches any device', async () => {
    const bad = [
      { mode: 42 }, { mode: '' }, { mode: '   ' }, { model: {} }, { model: ['a'] }, { mode: 'x'.repeat(201) },
      { model: 'a\u0000b' }, { mode: 'plan\nautopilot' },
    ];
    for (const extra of bad) {
      delete received.capable;
      const r = await steer('capable', { sessionId: 's1', text: 'hi', ...extra });
      assert.strictEqual(r.status, 400, `${JSON.stringify(extra)} -> ${JSON.stringify(r)}`);
      assert.strictEqual(received.capable, undefined, `${JSON.stringify(extra)} reached the device`);
    }
  });

  await checkAsync('hub: a device that does not claim next-turn support is refused up front, and sent nothing', async () => {
    for (const id of ['old', 'stringy']) {
      delete received[id];
      const r = await steer(id, { sessionId: 's1', text: 'plan it', mode: 'plan' });
      assert.strictEqual(r.status, 409, `${id}: ${JSON.stringify(r)}`);
      assert.strictEqual(r.body.code, 'next-turn-unsupported');
      assert.match(r.body.error, /cannot change the mode or model/);
      assert.strictEqual(received[id], undefined, `${id}: the steer reached a device that would have ignored the mode`);
    }
  });

  await checkAsync('hub: a device refusal keeps its code and maps to its own status, and an unknown code stays a plain error', async () => {
    const expected = {
      'next-turn-unsupported': 409,
      'turn-in-progress': 409,
      'selection-busy': 409,
      'session-changed': 409,
      'selection-not-offered': 422,
      'selection-failed': 502,
    };
    for (const [code, status] of Object.entries(expected)) {
      script = { ok: false, error: `refused: ${code}`, code };
      const r = await steer('capable', { sessionId: 's1', text: 'hi', mode: 'plan' });
      assert.strictEqual(r.status, status, `${code} -> ${JSON.stringify(r)}`);
      assert.strictEqual(r.body.code, code);
    }
    script = { ok: false, error: 'something else', code: 'made-up-code' };
    const odd = await steer('capable', { sessionId: 's1', text: 'hi', mode: 'plan' });
    assert.strictEqual(odd.status, 400, JSON.stringify(odd));
    assert.strictEqual('code' in odd.body, false, 'a code the hub never listed reached the browser');
    script = { ok: true, result: { sent: true, changes: [] } };
  });

  await checkAsync('hub: a steer with a mode from nobody, or from someone who does not own the device, reaches nothing', async () => {
    const asked = { sessionId: 's1', text: 'plan it', mode: 'plan' };
    delete received.capable;
    const anon = await api(port, '/api/devices/capable/steer', null, { method: 'POST', body: asked });
    assert.strictEqual(anon.status, 401, JSON.stringify(anon));
    const stranger = await api(port, '/api/devices/capable/steer', auth.mintDevToken('t2', 'user-2', 'Mallory'), { method: 'POST', body: asked });
    assert.strictEqual(stranger.status, 404, `someone else's device answered ${JSON.stringify(stranger)}`);
    assert.strictEqual(received.capable, undefined, 'a steer from someone who may not send one reached the device');
    const missing = await steer('nobody-here', asked);
    assert.strictEqual(missing.status, 404, JSON.stringify(missing));
  });

  const sessionsOf = async () => {
    const r = await api(port, '/api/sessions', token);
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    return Object.fromEntries(r.body.sessions.filter((s) => s.deviceId === 'capable').map((s) => [s.id, s]));
  };

  await checkAsync('hub: the nextTurn on a session reaches the browser, and a disabled field keeps its reason', async () => {
    const s = (await sessionsOf()).s1;
    assert.ok(s && s.nextTurn, JSON.stringify(s));
    assert.strictEqual(s.nextTurn.supported, true);
    assert.deepStrictEqual(s.nextTurn.mode.choices.map((c) => c.name), ['Agent', 'Plan']);
    assert.strictEqual(s.nextTurn.mode.current, modeUri('agent'));
    assert.strictEqual(s.nextTurn.model.supported, false);
    assert.strictEqual(s.nextTurn.model.reason, 'no models offered');
  });

  await checkAsync('hub: a hostile nextTurn is bounded and stripped of anything markup-shaped', async () => {
    const s = (await sessionsOf()).s2;
    assert.ok(s && s.nextTurn, JSON.stringify(s));
    assert.strictEqual(s.nextTurn.reason, null, 'an over-long reason was kept');
    assert.strictEqual(s.nextTurn.mode.current, null, 'a markup-shaped value was kept');
    assert.deepStrictEqual(s.nextTurn.mode.choices.map((c) => c.id), [modeUri('plan'), modeUri('autopilot')],
      'a markup-shaped or non-string choice id survived');
    assert.strictEqual(s.nextTurn.mode.choices[1].name, modeUri('autopilot'), 'a markup-shaped choice name survived');
    assert.strictEqual(s.nextTurn.mode.reason, null, 'a markup-shaped reason survived');
    assert.strictEqual(s.nextTurn.model.choices.length, 64, 'the choice list was not bounded');
  });

  await checkAsync('hub: a malformed nextTurn becomes a disabled one, never an enabled one', async () => {
    const all = await sessionsOf();
    assert.strictEqual(all.s3.nextTurn, null, 'a string was kept as a nextTurn');
    assert.strictEqual(all.s4.nextTurn.supported, false, 'a nextTurn with no usable choices claimed support');
    assert.strictEqual(all.s4.nextTurn.mode.supported, false);
    assert.deepStrictEqual(all.s4.nextTurn.mode.choices, []);
  });

  await checkAsync('hub: a session from an older device carries no nextTurn at all', async () => {
    const s = (await sessionsOf()).s5;
    assert.ok(s, 'the session was not stored');
    assert.strictEqual('nextTurn' in s, false, 'a nextTurn appeared that no device sent');
  });

  for (const l of links) l.stop();
  await svc.close();
})();

// ---------------------------------------------------------------------------
// C2. The cloud device, as an ACA job actually runs it
// ---------------------------------------------------------------------------
await (async () => {
  const { spawn } = require('child_process');
  const CLOUD = path.join(__dirname, '..', 'src', 'cloud-device.js');
  const auth = new Authenticator({
    mode: MODES.DEV,
    devSecret: crypto.randomBytes(16).toString('hex'),
    deviceSecret: crypto.randomBytes(16).toString('hex'),
  });
  const svc = new HubService({ auth, serveWeb: false, deviceTokenDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sqnext-tok-')) });
  const { port } = await svc.listen(0, '127.0.0.1');
  const userToken = auth.mintDevToken('t1', 'user-1', 'Alice');
  const me = await api(port, '/api/me', userToken);
  const deviceToken = auth.mintDeviceToken({ key: me.body.subject, label: 'jobs', didPrefix: 'job-' });
  const kids = [];

  function cloud(id, env) {
    const child = spawn(process.execPath, [CLOUD], {
      env: {
        ...process.env,
        SQUAD_HUB_HOME: work(),
        SQUAD_HUB_AGENT: process.execPath,
        SQUAD_HUB_AGENT_ARGS: FAKE_AGENT,
        FAKE_AGENT_MODE: 'approve-gate',
        FAKE_AGENT_NEXT_TURN: 'copilot',
        SQUAD_HUB_URL: `http://127.0.0.1:${port}`,
        SQUAD_HUB_TOKEN: deviceToken,
        SQUAD_HUB_DEVICE_ID: id,
        SQUAD_HUB_DEVICE_NAME: id,
        SQUAD_HUB_CWD: work(),
        ...env,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    kids.push(child);
    return child;
  }
  const registered = (id) => until(() => svc.store.getDevice(me.body.subject, id), `${id} to register`, 20000);

  await checkAsync('cloud device: a one-shot job claims no next-turn support and a change for it is refused before it reaches the job', async () => {
    cloud('job-nt-1', { SQUAD_HUB_ONESHOT: '1', SQUAD_HUB_PROMPT: 'first turn' });
    const device = await registered('job-nt-1');
    assert.strictEqual(device.capabilities.nextTurnSelection, false, JSON.stringify(device.capabilities));
    const r = await api(port, '/api/devices/job-nt-1/steer', userToken, {
      method: 'POST', body: { sessionId: 'anything', text: 'plan it', mode: 'plan' },
    });
    assert.strictEqual(r.status, 409, JSON.stringify(r));
    assert.strictEqual(r.body.code, 'next-turn-unsupported');
  });

  await checkAsync('cloud device: a long-lived worker claims next-turn support', async () => {
    cloud('job-nt-2', {});
    const device = await registered('job-nt-2');
    assert.strictEqual(device.capabilities.nextTurnSelection, true, JSON.stringify(device.capabilities));
  });

  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  await svc.close();
})();

// ---------------------------------------------------------------------------
// D. The page's own decisions, on the real module source
// ---------------------------------------------------------------------------
{
  const { readWebSource } = require('./helpers/web-source');
  const mod = { exports: {} };
  new Function('module', 'exports', `${readWebSource()}
module.exports = { state, CONTROL, ntFieldView, ntSelectionBody, ntNote, ntSteer, ntViewActive, captureSelection, invalidateSelection };`)(mod, mod.exports);
  const {
    state, CONTROL, ntFieldView, ntSelectionBody, ntNote, ntSteer, ntViewActive, captureSelection, invalidateSelection,
  } = mod.exports;
  const nt = (over = {}) => ({
    id: 's1',
    key: 'dev:s1',
    status: 'idle',
    nextTurn: {
      supported: true,
      mode: { supported: true, current: modeUri('agent'), choices: [{ id: modeUri('agent'), name: 'Agent' }, { id: modeUri('plan'), name: 'Plan' }] },
      model: { supported: false, reason: 'no models offered', current: null, choices: [] },
    },
    ...over,
  });

  await checkAsync('page: a selector is enabled only when synced, idle, not mid-send and offered; each other state says why', async () => {
    assert.strictEqual(ntFieldView('mode', nt(), CONTROL.SYNCED, undefined, false).enabled, true);
    for (const control of [CONTROL.UNKNOWN, CONTROL.VERIFYING, CONTROL.NOT_SYNCED, CONTROL.UNVERIFIED, 'something-new', undefined]) {
      const v = ntFieldView('mode', nt(), control, undefined, false);
      assert.strictEqual(v.enabled, false, `enabled while the control state was ${control}`);
      assert.match(v.reason, /synced/);
    }
    for (const status of ['active', 'starting', 'waiting_approval', 'ended', undefined]) {
      const v = ntFieldView('mode', nt({ status }), CONTROL.SYNCED, undefined, false);
      assert.strictEqual(v.enabled, false, `enabled while the session was ${status}`);
      assert.match(v.reason, /waiting for your next message/);
    }
    const sending = ntFieldView('mode', nt(), CONTROL.SYNCED, undefined, true);
    assert.strictEqual(sending.enabled, false, 'enabled while a change was being confirmed');
    assert.match(sending.reason, /Sending your message/);
  });

  await checkAsync('page: a field the device did not offer stays disabled with the reason the device gave, and never enabled by a guess', async () => {
    const model = ntFieldView('model', nt(), CONTROL.SYNCED, undefined, false);
    assert.strictEqual(model.enabled, false);
    assert.strictEqual(model.reason, 'no models offered');
    assert.match(ntFieldView('mode', nt({ nextTurn: undefined }), CONTROL.SYNCED).reason, /older than this feature/);
    assert.match(ntFieldView('mode', nt({ nextTurn: 'yes please' }), CONTROL.SYNCED).reason, /older than this feature/);
    const empty = nt();
    empty.nextTurn.mode.choices = [];
    assert.strictEqual(ntFieldView('mode', empty, CONTROL.SYNCED).enabled, false, 'a selector with nothing to choose from was enabled');
    const weird = nt();
    weird.nextTurn.mode.choices = [{ id: 7, name: 'Seven' }, null, { name: 'no id' }];
    assert.strictEqual(ntFieldView('mode', weird, CONTROL.SYNCED).enabled, false, 'a choice with no usable id was offered');
  });

  await checkAsync('page: only a pick that is offered, differs from the session and sits in an enabled selector is sent', async () => {
    const plan = modeUri('plan');
    assert.deepStrictEqual(ntSelectionBody(nt(), CONTROL.SYNCED, { mode: plan }), { mode: plan });
    assert.deepStrictEqual(ntSelectionBody(nt(), CONTROL.SYNCED, { mode: modeUri('agent') }), {}, 'a pick equal to the current value was sent');
    assert.deepStrictEqual(ntSelectionBody(nt(), CONTROL.SYNCED, { mode: 'turbo' }), {}, 'a value nobody offered was sent');
    assert.deepStrictEqual(ntSelectionBody(nt(), CONTROL.SYNCED, { model: 'fake-deep' }), {}, 'a pick in a disabled selector was sent');
    assert.deepStrictEqual(ntSelectionBody(nt(), CONTROL.NOT_SYNCED, { mode: plan }), {}, 'a pick was sent for a session nobody verified');
    assert.deepStrictEqual(ntSelectionBody(nt({ status: 'active' }), CONTROL.SYNCED, { mode: plan }), {}, 'a pick was sent while a turn was running');
  });

  await checkAsync('page: the note names what is unavailable, and leaves the sync banner to speak while the session is not synced', async () => {
    const views = (control) => ({
      mode: ntFieldView('mode', nt(), control), model: ntFieldView('model', nt(), control),
    });
    assert.strictEqual(ntNote(views(CONTROL.SYNCED), CONTROL.SYNCED), 'Model is unavailable. No models offered.');
    assert.strictEqual(ntNote(views(CONTROL.NOT_SYNCED), CONTROL.NOT_SYNCED), '', 'the note spoke over the sync banner');
    const both = { mode: ntFieldView('mode', nt({ nextTurn: undefined }), CONTROL.SYNCED), model: ntFieldView('model', nt({ nextTurn: undefined }), CONTROL.SYNCED) };
    assert.match(ntNote(both, CONTROL.SYNCED), /^Mode and Model are unavailable\./);
  });

  await checkAsync('page: the page a send began on stays the one on screen across live rebuilds, and stops being it once left, reopened or closed', async () => {
    const device = { deviceId: 'dev' };
    const open = () => { state.currentSession = { device, session: { id: 's1', key: 'dev:s1' } }; };
    state.currentSession = null;
    assert.strictEqual(captureSelection(), null, 'a page was captured with nothing open');
    assert.strictEqual(ntViewActive(null), false, 'no page counted as the page a send began on');
    invalidateSelection(); open();
    const view = captureSelection();
    assert.strictEqual(ntViewActive(view), true, 'the page a send began on was not recognized');
    open();
    assert.strictEqual(ntViewActive(view), true, 'a rebuilt record of the same session was not recognized');
    state.currentSession = { device, session: { id: 's2', key: 'dev:s2' } };
    assert.strictEqual(ntViewActive(view), false, 'another session counted as the page a send began on');
    invalidateSelection(); open();
    assert.strictEqual(ntViewActive(view), false, 'the same session reopened counted as the page a send began on');
    state.currentSession = null;
    assert.strictEqual(ntViewActive(view), false, 'a closed page counted as the page a send began on');
  });

  await checkAsync('page: two devices that share a session id are two sessions for the one message guard', async () => {
    const realFetch = global.fetch;
    const realDocument = global.document;
    global.document = { getElementById: () => null };
    const gate = [];
    let hits = 0;
    global.fetch = () => { hits += 1; return new Promise((resolve) => gate.push(resolve)); };
    const here = { deviceId: 'dev-a' };
    const there = { deviceId: 'dev-b' };
    try {
      state.currentSession = { device: here, session: { id: 's1', status: 'idle' } };
      state.composer = { control: CONTROL.SYNCED };
      const first = ntSteer(here, { id: 's1', status: 'idle' }, 'one', null);
      const other = ntSteer(there, { id: 's1', status: 'idle' }, 'two', null).then(() => null, (e) => e);
      assert.strictEqual(hits, 2, 'the same session id on another device was held by the first device message');
      for (const resolve of gate.splice(0)) resolve({ ok: true, json: async () => ({ sent: true, changes: [] }) });
      await first;
      assert.strictEqual(await other, null, 'the other device message was refused');
    } finally {
      global.fetch = realFetch;
      global.document = realDocument;
      state.currentSession = null;
    }
  });

  await checkAsync('page: a second send for a session still being confirmed is refused outright, and a finished or failed one frees it again', async () => {
    const realFetch = global.fetch;
    const realDocument = global.document;
    global.document = { getElementById: () => null };
    const gate = [];
    let hits = 0;
    global.fetch = () => { hits += 1; return new Promise((resolve) => gate.push(resolve)); };
    const device = { deviceId: 'dev' };
    const session = nt();
    try {
      state.currentSession = { device, session };
      state.composer = { control: CONTROL.SYNCED };
      const first = ntSteer(device, session, 'one', null);
      const second = await Promise.race([
        ntSteer(device, session, 'two', null).then(() => null, (e) => e),
        sleep(100).then(() => ({ message: 'it went out and is waiting on the agent' })),
      ]);
      assert.ok(second && second.ntHandled === true && /still being sent/.test(second.message), `the second send was ${second && second.message}`);
      assert.strictEqual(hits, 1, 'a second message was sent while the first was in flight');
      gate.shift()({ ok: true, json: async () => ({ sent: true, changes: [] }) });
      await first;

      const third = ntSteer(device, session, 'three', null);
      assert.strictEqual(hits, 2, 'a finished send left the session held');
      gate.shift()({ ok: false, status: 502, json: async () => ({ error: 'the agent said no' }) });
      const refused = await third.then(() => null, (e) => e);
      assert.ok(refused && refused.message === 'the agent said no', 'a refusal was reported as a success');

      const fourth = ntSteer(device, session, 'four', null);
      assert.strictEqual(hits, 3, 'a failed send left the session held for ever');
      gate.shift()({ ok: true, json: async () => ({ sent: true, changes: [] }) });
      await fourth;
    } finally {
      global.fetch = realFetch;
      global.document = realDocument;
      state.currentSession = null;
    }
  });
}

killAll();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
