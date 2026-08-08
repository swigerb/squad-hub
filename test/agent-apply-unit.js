'use strict';
/**
 * The agent and model a session actually gets.
 *
 * `copilot --acp` accepts `--agent` and `--model` and silently ignores both.
 * Not rejects: accepts, with no error and no stderr, and runs the default
 * agent anyway. In `-p` mode the same flags ARE validated and an unknown value
 * exits 1, which is what made the bug so easy to believe was working. Every
 * squad-hub session ran as plain Copilot while every surface reported the
 * agent it had asked for.
 *
 * Proven at the time by controlled comparison: `copilot --agent squad -p "hi"`
 * replies "Squad v0.9.4 - hi!...", the same prompt through squad-hub replied
 * "Hi! How can I help?", and the spawned command line really did carry
 * `--acp --agent squad`.
 *
 * The selection is now made over the protocol after `session/new`, against the
 * agents and models that reply advertises. These tests drive a scripted ACP
 * agent rather than the real Copilot: the point is the protocol conversation
 * and what is reported afterwards, and a real agent would make that a slow,
 * credit-spending, network-dependent assertion about a language model.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0; let fail = 0;
async function check(name, fn) {
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

const { AcpSession } = require('../src/acp-session');

/**
 * A session wired to a scripted protocol peer.
 *
 * Only `_request` is replaced, so everything under test -- the discovery, the
 * matching, the warnings, what lands in toJSON -- is the real code.
 */
function scripted({ agents = ['', 'Squad'], models = ['auto', 'gpt-5.6-sol'], fail: failOn = null } = {}) {
  const s = Object.create(AcpSession.prototype);
  s.calls = [];
  s.agentSelection = null;
  s.applied = null;
  s.emit = () => {};
  s._request = async (method, params) => {
    s.calls.push({ method, params });
    if (failOn === method) throw new Error('the agent refused');
    if (method === 'session/new') {
      return {
        sessionId: 'acp-1',
        models: { availableModels: models.map((m) => ({ modelId: m })), currentModelId: models[0] },
        configOptions: [
          { type: 'select', id: 'mode', name: 'Mode', currentValue: 'agent', options: [] },
          {
            type: 'select',
            id: 'agent',
            name: 'Agent',
            currentValue: '',
            options: agents.map((a) => ({ value: a, name: a || 'Copilot' })),
          },
        ],
      };
    }
    return {};
  };
  return s;
}
const sent = (s, method) => s.calls.filter((c) => c.method === method);

(async () => {
  await check('the agent is chosen over the protocol, not left to the ignored flag', async () => {
    const s = scripted();
    s.agentSelection = { agent: 'squad', source: 'auto' };
    await s._applySelection(await s._request('session/new', {}));
    const set = sent(s, 'session/set_config_option');
    assert.strictEqual(set.length, 1, 'the agent was never actually selected');
    assert.strictEqual(set[0].params.configId, 'agent');
    assert.strictEqual(set[0].params.value, 'Squad');
  });

  await check('the agent name is matched case-insensitively', async () => {
    // Copilot registers Squad's agent as "Squad"; every other surface in this
    // codebase spells it "squad". An exact match would silently never apply.
    const s = scripted({ agents: ['', 'Squad'] });
    s.agentSelection = { agent: 'squad', source: 'auto' };
    await s._applySelection(await s._request('session/new', {}));
    assert.strictEqual(s.applied.agent, 'Squad');
    assert.deepStrictEqual(s.applied.warnings, []);
  });

  await check('an agent that is not installed is REPORTED, not silently swapped', async () => {
    const s = scripted({ agents: ['', 'Squad'] });
    s.agentSelection = { agent: 'not-installed', source: 'explicit' };
    await s._applySelection(await s._request('session/new', {}));
    assert.strictEqual(s.applied.agent, null);
    assert.strictEqual(s.applied.warnings.length, 1);
    assert.match(s.applied.warnings[0], /not installed/);
    assert.match(s.applied.warnings[0], /default agent instead/,
      'the warning must say what it IS running, not only what it is not');
    assert.match(s.applied.warnings[0], /Squad/, 'it must name what was available');
    assert.strictEqual(sent(s, 'session/set_config_option').length, 0,
      'an agent that does not exist must not be sent to the peer');
  });

  await check('the default agent asks for nothing at all', async () => {
    const s = scripted();
    s.agentSelection = { agent: 'default', source: 'auto' };
    await s._applySelection(await s._request('session/new', {}));
    assert.strictEqual(sent(s, 'session/set_config_option').length, 0);
    assert.deepStrictEqual(s.applied.warnings, []);
  });

  await check('the model is chosen over the protocol too', async () => {
    const s = scripted({ models: ['auto', 'claude-opus-4.8'] });
    s.agentSelection = { agent: 'default', model: 'claude-opus-4.8', source: 'explicit' };
    await s._applySelection(await s._request('session/new', {}));
    const set = sent(s, 'session/set_model');
    assert.strictEqual(set.length, 1);
    assert.strictEqual(set[0].params.modelId, 'claude-opus-4.8');
    assert.strictEqual(s.applied.model, 'claude-opus-4.8');
  });

  await check('a model the account cannot use is reported, and names the ones it can', async () => {
    const s = scripted({ models: ['auto', 'gpt-5.6-sol'] });
    s.agentSelection = { agent: 'default', model: 'claude-sonnet-4.5', source: 'explicit' };
    await s._applySelection(await s._request('session/new', {}));
    assert.strictEqual(s.applied.model, null);
    assert.match(s.applied.warnings[0], /not available/);
    assert.match(s.applied.warnings[0], /gpt-5\.6-sol/, 'a refusal that lists no alternative is unactionable');
    assert.strictEqual(sent(s, 'session/set_model').length, 0);
  });

  await check('a peer that refuses the selection degrades, and never takes the session down', async () => {
    // A session that cannot have its agent set is still a working session. It
    // is just not the one that was asked for, and saying so is the whole job.
    const s = scripted({ fail: 'session/set_config_option' });
    s.agentSelection = { agent: 'squad', source: 'auto' };
    const newSession = await s._request('session/new', {});
    await assert.doesNotReject(() => s._applySelection(newSession));
    assert.strictEqual(s.applied.agent, null);
    assert.match(s.applied.warnings[0], /could not select the agent/);
  });

  await check('a peer that advertises no agents at all does not throw', async () => {
    const s = scripted({ agents: [] });
    s.agentSelection = { agent: 'squad', source: 'auto' };
    const newSession = await s._request('session/new', {});
    await assert.doesNotReject(() => s._applySelection(newSession));
    assert.match(s.applied.warnings[0], /not installed/);
  });

  await check('what was granted is published, so a surface can tell it from what was asked', async () => {
    const s = scripted();
    s.agentSelection = { agent: 'squad', source: 'auto' };
    await s._applySelection(await s._request('session/new', {}));
    // Fill in what toJSON needs from a session that never really ran.
    Object.assign(s, {
      id: 's1', pid: 1, status: 'active', activity: '', cwd: '/w', prompt: 'p',
      startedAt: 1, endedAt: null, error: null, agentInfo: null, toolCallCount: 0,
      pendingApprovals: new Map(), expiredApprovals: [], answeredApprovals: [],
      transcript: [], _stderr: '', squadContext: () => null, gitContext: () => null,
    });
    const json = s.toJSON();
    assert.ok(json.applied, 'the session never publishes what it actually got');
    assert.strictEqual(json.applied.agent, 'Squad');
    assert.strictEqual(json.agentSelection.agent, 'squad',
      'the request must survive alongside the result; they are different facts');
  });

  // -------------------------------------------------------------------------
  // Doctor: ask Copilot which agents exist, rather than guess at a path
  // -------------------------------------------------------------------------
  const { availableAgents } = require('../src/doctor');

  /**
   * Write a fake Copilot that prints `text` on stderr and exits 1.
   *
   * It has to be a REAL EXECUTABLE, not `"node" "script.js"` crammed into
   * SQUAD_HUB_AGENT. `availableAgents` passes `shell: true` only on Windows,
   * so a command string with arguments is parsed by cmd.exe there and taken
   * literally as a filename everywhere else -- this passed on Windows and
   * could never have passed on Linux. Every other suite in this repository
   * already keeps the two apart (SQUAD_HUB_AGENT is the program,
   * SQUAD_HUB_AGENT_ARGS are its arguments); this is the one that did not.
   *
   * A .cmd on Windows and a shebang script elsewhere is spawnable on both,
   * with or without a shell.
   */
  function fakeCopilot(text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqhub-agents-'));
    if (process.platform === 'win32') {
      const cmd = path.join(dir, 'fake-copilot.cmd');
      fs.writeFileSync(cmd, `@echo off\r\n>&2 echo ${text}\r\nexit /b 1\r\n`);
      return { dir, command: cmd };
    }
    const sh = path.join(dir, 'fake-copilot.sh');
    fs.writeFileSync(sh, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(text)} >&2\nexit 1\n`);
    fs.chmodSync(sh, 0o755);
    return { dir, command: sh };
  }

  await check('the agent probe reads the list out of Copilot\'s own refusal', async () => {
    const { dir, command } = fakeCopilot('No such agent: __squad_hub_probe__, available: Squad, Reviewer.');
    const prior = process.env.SQUAD_HUB_AGENT;
    process.env.SQUAD_HUB_AGENT = command;
    try {
      const r = availableAgents();
      assert.strictEqual(r.ok, true, `probe failed: ${r.reason}`);
      assert.deepStrictEqual(r.agents, ['Squad', 'Reviewer'],
        'the trailing full stop and the spacing both have to come off');
    } finally {
      if (prior === undefined) delete process.env.SQUAD_HUB_AGENT; else process.env.SQUAD_HUB_AGENT = prior;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('an unreadable reply says so, rather than claiming there are no agents', async () => {
    // Parsing an error message is brittle by nature. It has to fail soft: "I
    // could not tell" and "there are none" call for opposite reactions.
    const { dir, command } = fakeCopilot('something entirely different');
    const prior = process.env.SQUAD_HUB_AGENT;
    process.env.SQUAD_HUB_AGENT = command;
    try {
      const r = availableAgents();
      assert.strictEqual(r.ok, false);
      assert.ok(r.reason, 'a failure with no reason cannot be acted on');
      assert.deepStrictEqual(r.agents, []);
    } finally {
      if (prior === undefined) delete process.env.SQUAD_HUB_AGENT; else process.env.SQUAD_HUB_AGENT = prior;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('a Copilot that cannot be run at all is reported, not treated as empty', async () => {
    const prior = process.env.SQUAD_HUB_AGENT;
    process.env.SQUAD_HUB_AGENT = path.join(os.tmpdir(), 'no-such-copilot-xyz');
    try {
      const r = availableAgents(4000);
      assert.strictEqual(r.ok, false);
      assert.deepStrictEqual(r.agents, []);
    } finally {
      if (prior === undefined) delete process.env.SQUAD_HUB_AGENT; else process.env.SQUAD_HUB_AGENT = prior;
    }
  });

  await check('run() applies the selection BETWEEN session/new and the prompt', async () => {
    /**
     * The seam, not the mechanism. Every other test here calls
     * `_applySelection` directly, so deleting the one line in `run()` that
     * invokes it would leave them all green and put the original bug straight
     * back. This drives the real `run()` and asserts on the order of the
     * protocol conversation.
     *
     * Order matters as much as presence: an agent chosen after the prompt has
     * been sent is an agent chosen too late to answer it.
     */
    const s = scripted();
    s.agentSelection = { agent: 'squad', model: 'gpt-5.6-sol', source: 'auto' };
    s._setStatus = () => {};
    s.shutdown = () => {};
    await s.run();

    const order = s.calls.map((c) => c.method);
    assert.ok(order.includes('session/set_config_option'),
      'run() never selected the agent; the ignored command-line flag is all that is left');
    assert.ok(order.indexOf('session/new') < order.indexOf('session/set_config_option'),
      'the agent was selected before there was a session to select it on');
    assert.ok(order.indexOf('session/set_config_option') < order.indexOf('session/prompt'),
      'the agent was selected after the prompt had already been sent');
    assert.ok(order.indexOf('session/set_model') < order.indexOf('session/prompt'),
      'the model was selected after the prompt had already been sent');
  });

  await check('run() still starts the session when the agent cannot be selected', async () => {
    const s = scripted({ agents: [] });
    s.agentSelection = { agent: 'nowhere-to-be-found', source: 'explicit' };
    s._setStatus = () => {};
    s.shutdown = () => {};
    await assert.doesNotReject(() => s.run(), 'a missing agent stopped the session running at all');
    assert.ok(s.calls.some((c) => c.method === 'session/prompt'), 'the prompt was never sent');
    assert.strictEqual(s.applied.warnings.length, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`ERROR: ${e.message}`); console.log(e.stack); process.exit(1); });
