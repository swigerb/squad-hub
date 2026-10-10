#!/usr/bin/env node
'use strict';
/**
 * A fake ACP agent, for tests.
 *
 * It speaks the same wire protocol as `copilot --acp` -- newline-delimited
 * JSON-RPC over stdio -- and its permission request has the same shape as the
 * one captured in spike/q1-permission-payload.json, including
 * toolCall.rawInput.command. It is a stand-in for the real agent, not an
 * invention: the shape came off the wire.
 *
 * Behaviour is driven by FAKE_AGENT_MODE:
 *   approve-gate  (default) ask permission, then honour the answer by creating
 *                 (or not creating) a marker file -- so a test can assert the
 *                 SIDE EFFECT rather than the reply.
 *   no-permission run straight through without asking.
 *   hang          ask permission and then never finish, for timeout tests.
 *   steer-race    hold the FIRST session/prompt open, unanswered. A SECOND
 *                 session/prompt on the same session (a steer) interrupts it:
 *                 the first is answered immediately (as `copilot --acp`
 *                 does, per #164), and only after FAKE_AGENT_STEER_DELAY_MS
 *                 does the second get answered, writing the marker with the
 *                 steered text. Reproduces the race `_goIdle()`/`steer()` in
 *                 `src/acp-session.js` have to survive: a one-shot device
 *                 polling for "idle" between those two answers must not see
 *                 it and tear the session down before the steer actually ran.
 *
 * FAKE_AGENT_NEXT_TURN is separate from the mode above: it decides what the
 * agent advertises and accepts for a MODE or MODEL CHANGE between turns (#183),
 * shaped like the `session/new` and `session/set_config_option` traffic
 * captured from `copilot --acp` 1.0.93 / 1.0.95 (spike/next-turn-findings.json).
 * Unset, the agent advertises nothing and behaves exactly as it always did.
 *   copilot       advertises modes and models, applies a change, and ANSWERS
 *                 with the options as they now stand. An unadvertised value is
 *                 refused with -32602, as the real agent does.
 *   unsupported   advertises them, but answers set_config_option "method not found".
 *   models-only   lists models with no configOptions entry (nothing confirmable).
 *   ignores       accepts a change and answers with the OLD current value.
 *   no-readback   applies a change but answers `{}` and announces nothing.
 *   announce-only applies a change and ANNOUNCES it (config_option_update), but its
 *                 reply to the request is `{}`: the change happened, and the
 *                 request's own answer says nothing about it.
 *   stuck         never answers set_config_option.
 *   slow          as `copilot`, but each change is applied and answered only
 *                 after FAKE_AGENT_SLOW_MS (1500), so a person can do something
 *                 else while it is being confirmed.
 *   refuse-model  as `copilot`, but a model change is refused (-32602).
 *   refuse-mode   as `copilot`, but a mode change is refused (-32602).
 *   aliased       as `copilot`, but each model's display name is a bare alias that
 *                 is also a valid model name (fake-deep is called `deep`), so a
 *                 lookup by NAME finds a model a lookup by id does not.
 *   renamed       as `copilot`, but the modes carry display names that are not
 *                 the end of their ids (Ask first, Think first, Hands off).
 * FAKE_AGENT_WITH_AGENT=1 also advertises an `agent` config option (one custom
 * agent, `squad`), changed the same way as mode and model -- and as slowly under
 * `slow` -- so a test can stand in the wait that comes BEFORE the model change.
 * FAKE_AGENT_RPC_LOG names a file (resolved against the session's cwd) that
 * gets one JSON line per mode/model RPC and per prompt, in arrival order, with
 * the mode and model the prompt would RUN in -- the side effect a test asserts.
 * A prompt containing EXIT-PLAN makes the agent leave plan mode on its own,
 * announcing ONLY current_mode_update, as the protocol defines it.
 */

const fs = require('fs');
const path = require('path');

const MODE = process.env.FAKE_AGENT_MODE || 'approve-gate';
const MARKER = process.env.FAKE_AGENT_MARKER || 'fake-agent-marker.txt';
const COMMAND = process.env.FAKE_AGENT_COMMAND || `echo ran > ${MARKER}`;
const STEER_DELAY_MS = Number(process.env.FAKE_AGENT_STEER_DELAY_MS || 300);

// When set, record the REAL argv this process was launched with -- so a test
// can assert what the daemon actually put on the command line (e.g. `--agent
// squad --model x`) as a genuine side effect, not just what daemon.js's status
// output claims it did. Resolved against THIS process's own cwd (the
// session's real working directory, since the daemon spawns each agent with
// `cwd: dir`) rather than a fixed path -- a value baked into the DAEMON's own
// env at startup still lands in each session's own directory correctly, even
// when one daemon runs several sessions in different projects.
if (process.env.FAKE_AGENT_ARGV_FILE) {
  try { fs.writeFileSync(path.resolve(process.cwd(), process.env.FAKE_AGENT_ARGV_FILE), JSON.stringify(process.argv.slice(2))); } catch { /* best effort */ }
}

const NEXT = process.env.FAKE_AGENT_NEXT_TURN || '';
const RPC_LOG = process.env.FAKE_AGENT_RPC_LOG || '';
const modeUri = (n) => `https://agentclientprotocol.com/protocol/session-modes#${n}`;
const MODE_CHOICES = [
  { value: modeUri('agent'), name: 'Agent', description: 'Default agent mode for conversational interactions' },
  { value: modeUri('plan'), name: 'Plan', description: 'Plan mode for creating and executing multi-step plans' },
  { value: modeUri('autopilot'), name: 'Autopilot', description: 'Autonomous mode that runs until task completion' },
];
if (NEXT === 'renamed') MODE_CHOICES.forEach((m, i) => { m.name = ['Ask first', 'Think first', 'Hands off'][i]; });
// Like the real list, it repeats "auto".
const MODEL_CHOICES = [
  { value: 'auto', name: 'Auto', description: 'Let the agent pick the best model' },
  { value: 'fake-fast', name: 'Fake Fast', description: 'A fast model' },
  { value: 'fake-deep', name: 'Fake Deep', description: 'A deliberate model' },
  { value: 'auto', name: 'Auto', description: 'Let the agent pick the best model' },
];
const AGENT_CHOICES = [{ value: 'squad', name: 'Squad', description: 'A custom agent' }];
const WITH_AGENT = process.env.FAKE_AGENT_WITH_AGENT === '1';
if (NEXT === 'aliased') MODEL_CHOICES.forEach((m) => { if (m.value !== 'auto') m.name = m.value.replace(/^fake-/, ''); });

let buf = '';
const sessions = new Map();

function logRpc(entry) {
  if (!RPC_LOG) return;
  try { fs.appendFileSync(path.resolve(process.cwd(), RPC_LOG), `${JSON.stringify(entry)}\n`); } catch { /* best effort */ }
}

const modeName = (s) => String(s.mode).split('#').pop();

function configOptions(s) {
  return [
    {
      type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: s.mode, options: MODE_CHOICES,
    },
    {
      type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: s.model, options: MODEL_CHOICES,
    },
    {
      type: 'select', id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', currentValue: 'medium',
      options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }],
    },
    ...(WITH_AGENT ? [{
      type: 'select', id: 'agent', name: 'Agent', category: 'agent', currentValue: s.agent || 'default', options: AGENT_CHOICES,
    }] : []),
  ];
}

/** `session/new`'s result, as much of it as this variant advertises. */
function newSessionResult(sessionId, s) {
  if (!NEXT) return { sessionId };
  const models = {
    currentModelId: s.model,
    availableModels: MODEL_CHOICES.map((m) => ({ modelId: m.value, name: m.name })),
  };
  if (NEXT === 'models-only') return { sessionId, models };
  return {
    sessionId,
    modes: { currentModeId: s.mode, availableModes: MODE_CHOICES.map((m) => ({ id: m.value, name: m.name })) },
    models,
    configOptions: configOptions(s),
  };
}

function announceChange(sessionId, s, field) {
  if (field === 'mode') notify(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: s.mode });
  notify(sessionId, { sessionUpdate: 'config_option_update', configOptions: configOptions(s) });
}

/** `session/set_config_option`, `session/set_mode`, `session/set_model`. */
function handleChange(msg) {
  const p = msg.params || {};
  const s = sessions.get(p.sessionId);
  const field = msg.method === 'session/set_mode' ? 'mode'
    : msg.method === 'session/set_model' ? 'model' : p.configId;
  const value = msg.method === 'session/set_mode' ? p.modeId
    : msg.method === 'session/set_model' ? p.modelId : p.value;
  logRpc({ method: msg.method, field, value });
  const fail = (code, message) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

  if (!s || !NEXT || NEXT === 'unsupported' || NEXT === 'models-only') {
    return fail(-32601, `"Method not found": ${msg.method}`);
  }
  if (NEXT === 'stuck') return undefined;
  const choices = field === 'mode' ? MODE_CHOICES : field === 'model' ? MODEL_CHOICES
    : field === 'agent' && WITH_AGENT ? AGENT_CHOICES : null;
  if (!choices) return fail(-32602, `Unknown config option '${field}'`);
  if (NEXT === `refuse-${field}`) return fail(-32602, `Cannot change the ${field} right now.`);
  if (!choices.some((c) => c.value === value)) {
    return fail(-32602, `Invalid ${field} '${value}'. Supported values: ${choices.map((c) => c.value).join(', ')}.`);
  }
  if (NEXT === 'ignores') return send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: configOptions(s) } });
  const apply = () => {
    s[field] = value;
    if (NEXT !== 'no-readback') announceChange(p.sessionId, s, field);
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: msg.method === 'session/set_config_option' && NEXT !== 'no-readback' && NEXT !== 'announce-only'
        ? { configOptions: configOptions(s) } : {},
    });
  };
  if (NEXT === 'slow') {
    setTimeout(apply, Number(process.env.FAKE_AGENT_SLOW_MS || 1500));
    return undefined;
  }
  return apply();
}

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

function notify(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

process.stdin.on('data', (c) => {
  buf += c.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

let permRpcId = 1000;
const waiting = new Map();

function handle(msg) {
  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'FakeCopilot', version: '0.0.0-test' },
        agentCapabilities: { loadSession: true },
      },
    });
  }

  if (msg.method === 'session/new') {
    const sessionId = `fake-${Math.random().toString(36).slice(2, 10)}`;
    const created = { cwd: msg.params && msg.params.cwd, mode: modeUri('agent'), model: 'fake-fast' };
    sessions.set(sessionId, created);
    return send({ jsonrpc: '2.0', id: msg.id, result: newSessionResult(sessionId, created) });
  }

  if (msg.method === 'session/set_config_option' || msg.method === 'session/set_mode' || msg.method === 'session/set_model') {
    return handleChange(msg);
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId;
    const s = sessions.get(sessionId) || { cwd: process.cwd() };
    const promptText = (msg.params.prompt && msg.params.prompt[0] && msg.params.prompt[0].text) || '';
    if (NEXT) logRpc({ method: 'session/prompt', text: promptText, mode: modeName(s), model: s.model });
    notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking' } });

    if (NEXT && promptText.includes('EXIT-PLAN') && s.mode === modeUri('plan')) {
      s.mode = modeUri('agent');
      notify(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: s.mode });
    }
    // Plan mode only thinks, and autopilot does not ask: the same difference
    // the real agent showed in the spike. Both end their turn at once.
    if (NEXT && modeName(s) === 'plan') {
      notify(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'think it through', priority: 'high', status: 'pending' }] });
      return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }
    if (NEXT && modeName(s) === 'autopilot') {
      try { fs.writeFileSync(path.join(s.cwd, MARKER), 'ran\n'); } catch { /* cwd gone */ }
      return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }

    if (MODE === 'steer-race') {
      const text = (msg.params.prompt && msg.params.prompt[0] && msg.params.prompt[0].text) || '';
      if (!s.firstPromptId) {
        // The first turn: hold it open. Nothing answers this until a second
        // prompt (the steer) arrives on the same session.
        s.firstPromptId = msg.id;
        sessions.set(sessionId, s);
        return;
      }
      // The second prompt interrupts the first -- exactly what #164 measured
      // against the real agent: the original turn ends the moment the new
      // one is sent, well before the new one has done anything.
      send({ jsonrpc: '2.0', id: s.firstPromptId, result: { stopReason: 'end_turn' } });
      setTimeout(() => {
        try { fs.writeFileSync(path.join(s.cwd, MARKER), `${text}\n`); } catch { /* cwd gone */ }
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }, STEER_DELAY_MS);
      return;
    }

    if (MODE === 'no-permission') {
      notify(sessionId, { sessionUpdate: 'tool_call', title: 'A tool that needed no permission', kind: 'read' });
      return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }

    const rpcId = permRpcId++;
    waiting.set(rpcId, { promptId: msg.id, sessionId, cwd: s.cwd });
    notify(sessionId, { sessionUpdate: 'tool_call', title: 'Create marker file', kind: 'execute' });
    return send({
      jsonrpc: '2.0', id: rpcId, method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: {
          toolCallId: `call_fake_${rpcId}`,
          title: 'Create marker file',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: COMMAND, commands: [COMMAND] },
        },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
        ],
      },
    });
  }

  // A response to our permission request.
  if (msg.id !== undefined && msg.result !== undefined && waiting.has(msg.id)) {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (MODE === 'hang') return; // never answer the prompt

    const outcome = msg.result.outcome || {};
    const allowed = outcome.outcome === 'selected' && String(outcome.optionId).startsWith('allow');
    if (allowed) {
      // The side effect. Only happens on a genuine allow.
      try { fs.writeFileSync(path.join(w.cwd, MARKER), 'ran\n'); } catch { /* cwd gone */ }
    }
    return send({ jsonrpc: '2.0', id: w.promptId, result: { stopReason: allowed ? 'end_turn' : 'refusal' } });
  }
}

process.stdin.resume();

/**
 * STAY ALIVE when stdin closes.
 *
 * This is not incidental — it is what makes the orphan tests real. A child
 * whose parent dies gets EOF on stdin and, by default, exits once its event
 * loop drains. That meant the orphan tests passed whether or not the daemon
 * killed anything: the agent was dying of pipe closure, and the kill path was
 * never exercised.
 *
 * A supervisor must not depend on its children being polite. An agent mid-tool
 * with a subprocess of its own will not exit on EOF, and that is precisely the
 * one that becomes an orphan holding a repo checkout. So this fake refuses to
 * die quietly, and the daemon has to actually kill it.
 */
const keepalive = setInterval(() => {}, 1000);
process.stdin.on('end', () => { /* deliberately not exiting */ });
process.stdin.on('close', () => { /* deliberately not exiting */ });
process.on('SIGTERM', () => { clearInterval(keepalive); process.exit(0); });

