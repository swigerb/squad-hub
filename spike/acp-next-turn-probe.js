#!/usr/bin/env node
/**
 * Can a running Copilot ACP session change its mode and model for the NEXT
 * turn? (#183, "spike first".)
 *
 * Squad Hub's composer will offer a Mode and a Model selector only if the
 * agent genuinely honors a change between turns. A selector that sends a
 * request the agent ignores is the lie this project keeps finding: it reports
 * "mode -> plan" and the next prompt runs, and edits files, in agent mode. So
 * this asks the real agent, records what it ANSWERED, and puts nothing in the
 * UI that the answers do not support.
 *
 * What it measures, in order:
 *   1. What the agent advertises at `session/new` (modes, models, config).
 *   2. Which RPCs change a mode, and how each one REFUSES a value it does not
 *      know -- a refusal that comes back as success would defeat every
 *      validation downstream.
 *   3. Which RPCs change a model, the same way.
 *   4. (`--prompts`) The behavior, not the reply: the same file-creation
 *      request sent in agent mode and then in plan mode. Plan mode must not
 *      ask to run anything; agent mode must. Permission requests are CANCELLED,
 *      so nothing is ever written.
 *
 * Safe to run: it works in an empty directory it creates (or `--cwd`), never
 * answers a permission request with anything but "cancelled", never selects
 * Autopilot for a prompt, and prints no credentials. `--prompts` spends a few
 * turns of a zero-cost model.
 *
 * Usage:  node spike/acp-next-turn-probe.js [--prompts] [--cwd <empty dir>] [--out <file>]
 *         SQUAD_HUB_ACP_COMMAND overrides the executable (default: copilot).
 * Exit:   0 answered, 1 the probe itself failed.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

const RUN_PROMPTS = flag('--prompts');
const OUT = option('--out');
const EXECUTABLE = process.env.SQUAD_HUB_ACP_COMMAND || 'copilot';
const RPC_TIMEOUT_MS = 90000;
const CHEAP_MODEL = 'gpt-5-mini';

const findings = {};
const cwdGiven = option('--cwd');
const cwd = cwdGiven || fs.mkdtempSync(path.join(os.tmpdir(), 'acp-next-turn-'));
fs.mkdirSync(cwd, { recursive: true });

const child = spawn(EXECUTABLE, ['--acp'], {
  cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
const pending = new Map();
let nextId = 0;
let buffer = '';
let updates = [];
let permissionRequests = [];
child.stderr.on('data', () => {});
child.on('error', (e) => { console.error(`could not start ${EXECUTABLE}: ${e.message}`); process.exit(1); });
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf('\n');
    if (nl < 0) break;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'error'), { rpc: msg.error }));
      else p.resolve(msg.result);
    } else if (msg.method === 'session/update') {
      updates.push(msg.params && msg.params.update);
    } else if (msg.method && msg.id !== undefined) {
      if (msg.method === 'session/request_permission') {
        const call = (msg.params && msg.params.toolCall) || {};
        permissionRequests.push({ kind: call.kind || null, title: call.title || null });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } })}\n`);
      } else {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`);
      }
    }
  }
});

function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`${method} timed out`), { timedOut: true }));
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What one RPC did: the verdict plus the notifications it provoked. */
async function attempt(method, params) {
  updates = [];
  let outcome;
  try {
    const result = await request(method, params);
    outcome = { method, accepted: true, result: summarize(result) };
  } catch (e) {
    outcome = {
      method, accepted: false, code: e.rpc ? e.rpc.code : null, message: String(e.message).slice(0, 300),
    };
  }
  await sleep(400);
  outcome.notifications = updates.map((u) => u && u.sessionUpdate).filter(Boolean);
  // What the notifications SAY, not just that they fired: they are the agent
  // announcing its own state, so they confirm a change answered with a bare {}.
  const said = {};
  for (const u of updates) {
    if (!u) continue;
    if (u.sessionUpdate === 'current_mode_update' && u.currentModeId) said.mode = u.currentModeId;
    if (u.sessionUpdate === 'config_option_update' && Array.isArray(u.configOptions)) {
      for (const o of u.configOptions) {
        if (o && (o.id === 'mode' || o.id === 'model')) said[o.id] = o.currentValue;
      }
    }
  }
  if (Object.keys(said).length) outcome.notificationsSaid = said;
  return outcome;
}

/** `set_config_option` answers with the options as they now stand; keep only what matters. */
function summarize(result) {
  if (!result || typeof result !== 'object') return result === undefined ? null : result;
  const out = {};
  if (Array.isArray(result.configOptions)) {
    out.current = {};
    for (const o of result.configOptions) {
      if (o && (o.id === 'mode' || o.id === 'model')) out.current[o.id] = o.currentValue;
    }
  }
  return Object.keys(out).length ? out : result;
}

const modeId = (name, advertised) => (advertised.find((m) => m.id.endsWith(`#${name}`)) || {}).id || null;

async function behaviorTurn(sessionId, label, text) {
  updates = [];
  permissionRequests = [];
  const started = Date.now();
  let stopReason = null;
  let error = null;
  try {
    const r = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    stopReason = r && r.stopReason;
  } catch (e) { error = String(e.message).slice(0, 200); }
  const kinds = new Set(updates.map((u) => u && u.sessionUpdate).filter(Boolean));
  return {
    turn: label,
    stopReason,
    error,
    ms: Date.now() - started,
    askedPermission: permissionRequests.length > 0,
    permissionRequests: permissionRequests.slice(0, 5),
    updateKinds: [...kinds].sort(),
  };
}

(async () => {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  findings.agent = init.agentInfo || null;
  findings.protocolVersion = init.protocolVersion;
  findings.agentCapabilities = init.agentCapabilities || null;

  const session = await request('session/new', { cwd, mcpServers: [] });
  const sessionId = session.sessionId;
  const options = Array.isArray(session.configOptions) ? session.configOptions : [];
  const modeOption = options.find((o) => o.id === 'mode') || null;
  const modelOption = options.find((o) => o.id === 'model') || null;
  const advertisedModes = ((modeOption && modeOption.options) || []).map((o) => ({ id: o.value, name: o.name }));
  const advertisedModels = ((session.models && session.models.availableModels) || []).map((m) => m.modelId);
  findings.advertised = {
    configOptionIds: options.map((o) => o.id),
    modes: advertisedModes,
    currentMode: modeOption && modeOption.currentValue,
    sessionModesField: Boolean(session.modes),
    modelCount: advertisedModels.length,
    currentModel: (session.models && session.models.currentModelId) || (modelOption && modelOption.currentValue) || null,
    modelsFromConfigOption: Boolean(modelOption),
    modelsFromModelsField: advertisedModels.length > 0,
  };

  const agentMode = modeId('agent', advertisedModes);
  const planMode = modeId('plan', advertisedModes);
  const autopilotMode = modeId('autopilot', advertisedModes);
  const current = findings.advertised.currentModel;
  const other = advertisedModels.find((m) => m !== current && m !== 'auto') || null;

  const rpc = {};
  rpc.unknownMethod = await attempt('session/set_not_a_method', { sessionId });

  // MODE, by `session/set_config_option` (the advertised config option).
  rpc.modeConfigPlan = await attempt('session/set_config_option', { sessionId, configId: 'mode', value: planMode });
  rpc.modeConfigBareName = await attempt('session/set_config_option', { sessionId, configId: 'mode', value: 'plan' });
  rpc.modeConfigUnknown = await attempt('session/set_config_option', { sessionId, configId: 'mode', value: 'not-a-mode' });
  rpc.modeConfigAutopilotThenBack = await attempt('session/set_config_option', { sessionId, configId: 'mode', value: autopilotMode });
  rpc.modeConfigBackToAgent = await attempt('session/set_config_option', { sessionId, configId: 'mode', value: agentMode });

  // MODE, by `session/set_mode` (the ACP session-modes method).
  rpc.setModeUri = await attempt('session/set_mode', { sessionId, modeId: planMode });
  rpc.setModeBareName = await attempt('session/set_mode', { sessionId, modeId: 'plan' });
  rpc.setModeUnknown = await attempt('session/set_mode', { sessionId, modeId: 'not-a-mode' });
  rpc.setModeBackToAgent = await attempt('session/set_mode', { sessionId, modeId: agentMode });

  // MODEL.
  rpc.setModelValid = other ? await attempt('session/set_model', { sessionId, modelId: other }) : { skipped: 'no second model offered' };
  rpc.setModelUnknown = await attempt('session/set_model', { sessionId, modelId: 'not-a-model-id' });
  rpc.modelConfigOther = other ? await attempt('session/set_config_option', { sessionId, configId: 'model', value: other }) : { skipped: 'no second model offered' };
  rpc.modelConfigValid = current ? await attempt('session/set_config_option', { sessionId, configId: 'model', value: current }) : { skipped: 'no current model' };
  rpc.modelConfigUnknown = await attempt('session/set_config_option', { sessionId, configId: 'model', value: 'not-a-model-id' });
  // A read-back that changes nothing: what the agent says is current, after all of the above.
  rpc.readBack = await attempt('session/set_config_option', { sessionId, configId: 'mode', value: agentMode });
  findings.rpc = rpc;

  if (RUN_PROMPTS) {
    const cheap = advertisedModels.includes(CHEAP_MODEL) ? CHEAP_MODEL : null;
    findings.behavior = { model: cheap, note: 'permission requests are cancelled; nothing is written' };
    if (cheap) await attempt('session/set_model', { sessionId, modelId: cheap });
    const ask = 'Create a file named probe-output.txt in the current directory containing the single word hi. '
      + 'Use your file tools; do not just describe it.';
    await attempt('session/set_config_option', { sessionId, configId: 'mode', value: agentMode });
    findings.behavior.agentModeTurn = await behaviorTurn(sessionId, 'agent', ask);
    await attempt('session/set_config_option', { sessionId, configId: 'mode', value: planMode });
    findings.behavior.planModeTurn = await behaviorTurn(sessionId, 'plan', ask);
    findings.behavior.fileWritten = fs.existsSync(path.join(cwd, 'probe-output.txt'));
  }

  console.log(JSON.stringify(findings, null, 2));
  if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(findings, null, 2)}\n`);
})().catch((e) => {
  console.error(`probe failed: ${e.message}`);
  process.exitCode = 1;
}).finally(() => {
  child.kill();
  if (!cwdGiven) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } }
});
