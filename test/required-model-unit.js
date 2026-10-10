#!/usr/bin/env node
'use strict';
/**
 * A model a supervisor REQUIRES: the session runs on exactly that model, as the
 * agent itself confirmed it, or no prompt is ever sent and the caller is told
 * why. Everything from the capability probe to the one-shot exit code, with a
 * real `fake-agent.js` child wherever a process is involved.
 *
 * The failure this exists to prevent: Hub warned and carried on with the
 * default model when a requested one was unavailable, so a worker that had
 * PINNED a model got a different one answering and had no way to tell. The
 * optional path keeps that behavior on purpose (a person at a terminal wants
 * the session to run); only a request that says it is required refuses.
 *
 * Assertions are about SIDE EFFECTS, not replies: the fake agent logs every
 * mode and model RPC and, for each prompt, the model that prompt would RUN on
 * (FAKE_AGENT_RPC_LOG). "No prompt was sent" and "the prompt ran on the
 * confirmed model" are read off that log, not off what Hub says about itself.
 * Every load-bearing check here is paired with a `test/mutate.js` mutation
 * that removes the control it asserts.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

process.env.SQUAD_HUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqreq-'));
// A change the agent never answers is reported after this long. Read at call
// time by AcpSession, and inherited by the one-shot children below.
process.env.SQUAD_HUB_SELECTION_TIMEOUT_MS = '1500';

const { Daemon } = require('../src/daemon');
const { AcpSession, STATUS } = require('../src/acp-session');
const {
  selectAgent, parseRequireModel, RequiredModelError,
} = require('../src/agent-select');
const { Authenticator, MODES } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');

const BIN = path.join(__dirname, '..', 'bin', 'squad-hub.js');
const FAKE_AGENT = path.join(__dirname, 'fake-agent.js');

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
const work = (tag = 'w') => fs.mkdtempSync(path.join(os.tmpdir(), `sqreq-${tag}-`));

const readLog = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, 'rpc.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const calls = (log) => log.map((e) => (e.field ? `${e.method}:${e.field}` : e.method));
const prompts = (log) => log.filter((e) => e.method === 'session/prompt');

// ---------------------------------------------------------------------------
// In-process: a real AcpSession and a real fake-agent child
// ---------------------------------------------------------------------------

const live = [];
const killAll = () => { for (const s of live) { try { s.proc.kill(); } catch { /* gone */ } } };

/**
 * One session on a real agent child that advertises what `variant` says it
 * does. The selection is the product of the real `selectAgent`, handed over
 * after `new` and before `run()` exactly as the daemon does.
 */
function start(variant, { model, mode, strict = true, agentArgs, env = {} } = {}) {
  const dir = work();
  const s = new AcpSession({
    id: `rm-${live.length}`,
    cwd: dir,
    prompt: 'first turn',
    agentCommand: process.execPath,
    agentArgs: agentArgs || [FAKE_AGENT],
    env: {
      FAKE_AGENT_MODE: 'no-permission',
      FAKE_AGENT_NEXT_TURN: variant,
      FAKE_AGENT_RPC_LOG: 'rpc.jsonl',
      ...env,
    },
  });
  s.dir = dir;
  s.agentSelection = selectAgent({
    cwd: dir, explicitModel: model, explicitMode: mode, requireModel: strict,
  });
  live.push(s);
  s.outcome = s.run().then(() => null, (e) => e);
  return s;
}

/** The turn finished and the session is waiting for a person: it ran. */
async function ran(s) {
  const err = await s.outcome;
  assert.strictEqual(err, null, `the session failed: ${err && err.message}`);
  await until(() => s.status === STATUS.IDLE, 'the first turn to end');
  return s;
}

/**
 * Everything a refusal must be, asserted once so no case can forget a part:
 * `run()` threw the named code, the session says failed and why, nothing was
 * confirmed or applied, no prompt reached the agent, and the agent is dead.
 */
async function refused(s, code) {
  const err = await s.outcome;
  assert.ok(err, 'run() did not throw: the session carried on');
  assert.ok(err instanceof RequiredModelError, `not a RequiredModelError: ${err && err.stack}`);
  assert.strictEqual(err.code, code, err.message);
  assert.strictEqual(s.status, STATUS.FAILED, `status ${s.status}`);
  const rm = s.toJSON().requiredModel;
  assert.strictEqual(rm.confirmed, false, JSON.stringify(rm));
  assert.strictEqual(rm.chosen, null, JSON.stringify(rm));
  assert.strictEqual(rm.failure.code, code, JSON.stringify(rm));
  assert.ok(rm.failure.reason, 'a refusal with no reason');
  assert.ok(!s.applied || s.applied.model === null, 'a model was reported applied that the agent never confirmed');
  assert.deepStrictEqual(prompts(readLog(s.dir)), [], 'a prompt reached the agent');
  assert.strictEqual(
    s.transcript.some((e) => e.update && e.update.sessionUpdate === 'agent_message_chunk'),
    false,
    'the agent answered a prompt',
  );
  await until(() => s.isAgentDead(), 'the refused session\'s agent to be killed', 5000);
  return err;
}

(async () => {
  console.log('required model');
  console.log('='.repeat(60));

  // -------------------------------------------------------------------------
  // A. The capability probe
  // -------------------------------------------------------------------------

  const scrubbed = () => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith('SQUAD_HUB_') || k.startsWith('FAKE_AGENT_')) delete env[k];
    }
    return env;
  };
  const probe = (args, env, cwd) => spawnSync(process.execPath, [BIN, ...args], {
    env, cwd, encoding: 'utf8', timeout: 20000, windowsHide: true,
  });

  await check('required model: the capability probe prints exactly the contract JSON and exits 0', () => {
    const cwd = work('probe');
    const r = probe(['oneshot', '--capabilities'], scrubbed(), cwd);
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.deepStrictEqual(JSON.parse(r.stdout), { protocolVersion: 1, requiredModel: true });
    assert.strictEqual(r.stdout.trim().split('\n').length, 1, `more than the one JSON line: ${r.stdout}`);
    assert.strictEqual(r.stderr, '', 'the probe wrote to stderr');
  });

  await check('required model: the probe answers with no configuration, and with every configuration hostile, and touches nothing', () => {
    const cwd = work('probe-cwd');
    const home = path.join(os.tmpdir(), `sqreq-never-created-${process.pid}-${Date.now()}`);
    const env = {
      ...scrubbed(),
      // Everything the real run reads, set to something that would stop it.
      SQUAD_HUB_HOME: home,
      SQUAD_HUB_REQUIRE_MODEL: 'garbage',
      SQUAD_HUB_MODEL: '--x',
      SQUAD_HUB_URL: 'http://127.0.0.1:1',
      SQUAD_HUB_TOKEN: 'not-a-token',
      SQUAD_HUB_ONESHOT: '1',
      SQUAD_HUB_PROMPT: 'this must never run',
      SQUAD_HUB_AGENT: process.execPath,
      SQUAD_HUB_AGENT_ARGS: FAKE_AGENT,
      FAKE_AGENT_ARGV_FILE: 'agent-argv.json',
      FAKE_AGENT_MODE: 'no-permission',
    };
    const r = probe(['oneshot', '--capabilities'], env, cwd);
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
    assert.deepStrictEqual(JSON.parse(r.stdout), { protocolVersion: 1, requiredModel: true });
    assert.strictEqual(r.stderr, '', `the probe wrote to stderr: ${r.stderr}`);
    assert.strictEqual(fs.existsSync(home), false, 'the probe created the Hub home (config, daemon, device state)');
    assert.deepStrictEqual(fs.readdirSync(cwd), [], 'the probe left a file behind: an agent ran or a log was written');
  });

  await check('required model: a global --env naming an environment that is not configured does not stop the probe', () => {
    const home = path.join(os.tmpdir(), `sqreq-never-created-env-${process.pid}-${Date.now()}`);
    for (const args of [['--env', 'ppe', 'oneshot', '--capabilities'], ['oneshot', '--capabilities', '--env=ppe'], ['--no-config-cache', 'oneshot', '--capabilities']]) {
      const r = probe(args, { ...scrubbed(), SQUAD_HUB_HOME: home }, work('probe-env'));
      assert.strictEqual(r.status, 0, `${args.join(' ')}: exit ${r.status}: ${r.stdout}${r.stderr}`);
      assert.deepStrictEqual(JSON.parse(r.stdout), { protocolVersion: 1, requiredModel: true }, args.join(' '));
    }
    assert.strictEqual(fs.existsSync(home), false, 'the probe created the Hub home');
  });

  await check('required model: a probe with any other argument is refused with no answer, not read as capable', () => {
    for (const args of [
      ['oneshot', '--capabilities', '--bogus'],
      ['oneshot', '--capabilities', 'extra'],
      ['oneshot', '--bogus', '--capabilities'],
    ]) {
      const r = probe(args, scrubbed(), work('probe-args'));
      assert.notStrictEqual(r.status, 0, `${args.join(' ')} exited 0`);
      assert.strictEqual(r.stdout, '', `${args.join(' ')} answered: ${r.stdout}`);
    }
  });

  await check('required model: a oneshot without the probe flag is unchanged and answers no capability', () => {
    const r = probe(['oneshot'], scrubbed(), work('probe-plain'));
    assert.strictEqual(r.status, 64, `exit ${r.status}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /protocolVersion|requiredModel/);
  });

  // -------------------------------------------------------------------------
  // B. SQUAD_HUB_REQUIRE_MODEL and the selection
  // -------------------------------------------------------------------------

  await check('required model: SQUAD_HUB_REQUIRE_MODEL is strict: 1 is on, 0 and unset are off, anything else is refused', () => {
    for (const off of [undefined, null, '', '0']) assert.strictEqual(parseRequireModel(off), false, String(off));
    assert.strictEqual(parseRequireModel('1'), true);
    for (const bad of ['true', 'TRUE', 'yes', 'on', ' 1', '1 ', '01', '2', '-1', 'false', 'secret-value-123']) {
      let thrown = null;
      try { parseRequireModel(bad); } catch (e) { thrown = e; }
      assert.ok(thrown, `"${bad}" was accepted`);
      assert.ok(thrown instanceof RequiredModelError, `"${bad}": ${thrown.stack}`);
      assert.strictEqual(thrown.code, 'REQUIRED_MODEL_FLAG_INVALID', `"${bad}"`);
      if (bad.length > 4) assert.ok(!thrown.message.includes(bad), `the value "${bad}" was echoed back: ${thrown.message}`);
    }
  });

  await check('required model: a required selection has no fallback: a missing or invalid model refuses, and the project model is never used', () => {
    const dir = work('select');
    fs.writeFileSync(path.join(dir, '.squad-hub.json'), JSON.stringify({ model: 'project-model' }));
    const code = (over) => {
      try { selectAgent({ cwd: dir, requireModel: true, ...over }); } catch (e) { return e.code; }
      return 'no error';
    };
    assert.strictEqual(code({}), 'REQUIRED_MODEL_MISSING');
    assert.strictEqual(code({ explicitModel: '' }), 'REQUIRED_MODEL_MISSING');
    assert.strictEqual(code({ explicitModel: '--allow-all-tools' }), 'REQUIRED_MODEL_INVALID');
    assert.strictEqual(code({ explicitModel: 'two words' }), 'REQUIRED_MODEL_INVALID');
    assert.strictEqual(code({ explicitModel: 'm'.repeat(65) }), 'REQUIRED_MODEL_INVALID');
    assert.strictEqual(code({ explicitModel: 42 }), 'REQUIRED_MODEL_INVALID');
    const ok = selectAgent({ cwd: dir, explicitModel: 'fake-deep', requireModel: true });
    assert.strictEqual(ok.model, 'fake-deep', 'the project model replaced the required one');
    assert.strictEqual(ok.requiredModel, true);
  });

  await check('required model: an optional selection still falls back to the project model and carries no required flag', () => {
    const dir = work('select-optional');
    fs.writeFileSync(path.join(dir, '.squad-hub.json'), JSON.stringify({ model: 'project-model' }));
    const bad = selectAgent({ cwd: dir, explicitModel: '--x' });
    assert.strictEqual(bad.model, 'project-model');
    assert.ok(bad.warnings.some((w) => /not a valid name/.test(w)), JSON.stringify(bad.warnings));
    assert.strictEqual('requiredModel' in bad, false, 'an optional selection claimed to be required');
    const off = selectAgent({ cwd: dir, explicitModel: 'fake-deep', requireModel: false });
    assert.strictEqual('requiredModel' in off, false);
  });

  // -------------------------------------------------------------------------
  // C. The daemon: the intent has to survive the trip into the session
  // -------------------------------------------------------------------------

  const argvFile = 'agent-argv.json';
  const daemon = () => {
    const d = new Daemon({ hubUrl: null });
    d.agentCommand = process.execPath;
    d.agentArgs = [FAKE_AGENT];
    return d;
  };
  const askDaemon = (d, req) => Promise.resolve()
    .then(() => d.handle({ op: 'start-session', prompt: 'first turn', ...req }))
    .then(() => null, (e) => e);
  const scoped = async (env, fn) => {
    const before = {};
    for (const k of Object.keys(env)) { before[k] = process.env[k]; process.env[k] = env[k]; }
    try { return await fn(); } finally {
      for (const k of Object.keys(env)) {
        if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
      }
    }
  };

  await check('required model: the daemon refuses a bad required request before any agent starts or session exists', async () => {
    const dir = work('daemon-bad');
    fs.writeFileSync(path.join(dir, '.squad-hub.json'), JSON.stringify({ model: 'project-model' }));
    await scoped({ FAKE_AGENT_NEXT_TURN: 'copilot', FAKE_AGENT_ARGV_FILE: argvFile }, async () => {
      const d = daemon();
      const cases = [
        [{ requiredModel: true }, 'REQUIRED_MODEL_MISSING'],
        [{ requiredModel: true, model: '--allow-all-tools' }, 'REQUIRED_MODEL_INVALID'],
        [{ requiredModel: 'true', model: 'fake-deep' }, 'REQUIRED_MODEL_FLAG_INVALID'],
        [{ requiredModel: 1, model: 'fake-deep' }, 'REQUIRED_MODEL_FLAG_INVALID'],
        [{ requiredModel: null, model: 'fake-deep' }, 'REQUIRED_MODEL_FLAG_INVALID'],
      ];
      for (const [req, code] of cases) {
        const e = await askDaemon(d, { localCwd: dir, ...req });
        assert.ok(e, `${JSON.stringify(req)} was accepted`);
        assert.strictEqual(e.code, code, `${JSON.stringify(req)}: ${e.message}`);
      }
      assert.strictEqual(d.sessions.size, 0, 'a refused request left a session behind');
      assert.strictEqual(fs.existsSync(path.join(dir, argvFile)), false, 'a refused request spawned the agent');
    });
  });

  await check('required model: the daemon carries the required intent into the session, which confirms the requested model before its first prompt', async () => {
    const dir = work('daemon-ok');
    fs.writeFileSync(path.join(dir, '.squad-hub.json'), JSON.stringify({ model: 'fake-fast' }));
    await scoped({
      FAKE_AGENT_MODE: 'no-permission', FAKE_AGENT_NEXT_TURN: 'copilot', FAKE_AGENT_RPC_LOG: 'rpc.jsonl',
    }, async () => {
      const d = daemon();
      const started = await d.handle({
        op: 'start-session', prompt: 'first turn', localCwd: dir, model: 'fake-deep', requiredModel: true,
      });
      const s = d.sessions.get(started.id);
      s.dir = dir;
      live.push(s);
      assert.strictEqual(started.agentSelection.requiredModel, true, 'the intent was dropped on the way in');
      assert.strictEqual(started.agentSelection.model, 'fake-deep', 'the project model replaced the required one');
      await until(() => s.status === STATUS.IDLE, 'the first turn to end');
      assert.deepStrictEqual(calls(readLog(dir)), ['session/set_config_option:model', 'session/prompt']);
      assert.strictEqual(prompts(readLog(dir))[0].model, 'fake-deep');
      const json = s.toJSON();
      assert.deepStrictEqual(json.requiredModel, {
        requested: 'fake-deep', chosen: 'fake-deep', confirmed: true, failure: null,
      });
      assert.strictEqual(json.applied.model, 'fake-deep');
      assert.strictEqual(json.agentSelection.requiredModel, true);
    });
  });

  await check('required model: a session the daemon resyncs is still required, and confirms its model again before the replayed prompt', async () => {
    const dir = work('daemon-resync');
    await scoped({
      FAKE_AGENT_MODE: 'no-permission', FAKE_AGENT_NEXT_TURN: 'copilot', FAKE_AGENT_RPC_LOG: 'rpc.jsonl',
    }, async () => {
      const d = daemon();
      const started = await d.handle({
        op: 'start-session', prompt: 'first turn', localCwd: dir, model: 'fake-deep', requiredModel: true,
      });
      const first = d.sessions.get(started.id);
      live.push(first);
      await until(() => first.status === STATUS.IDLE, 'the first turn to end');
      const again = d.resyncSession(started.id);
      live.push(again);
      await until(() => again.status === STATUS.IDLE, 'the replayed turn to end');
      assert.strictEqual(again.agentSelection.requiredModel, true, 'the requirement did not survive the resync');
      assert.deepStrictEqual(calls(readLog(dir)), [
        'session/set_config_option:model', 'session/prompt', 'session/set_config_option:model', 'session/prompt',
      ], 'the replayed prompt went out without its model being confirmed again');
      assert.strictEqual(prompts(readLog(dir))[1].model, 'fake-deep');
      assert.strictEqual(again.toJSON().requiredModel.confirmed, true);
    });
  });
  await check('required model: a session the daemon starts without the flag is optional and carries no required record', async () => {
    const dir = work('daemon-optional');
    await scoped({
      FAKE_AGENT_MODE: 'no-permission', FAKE_AGENT_NEXT_TURN: 'copilot', FAKE_AGENT_RPC_LOG: 'rpc.jsonl',
    }, async () => {
      const d = daemon();
      const started = await d.handle({
        op: 'start-session', prompt: 'first turn', localCwd: dir, model: 'fake-deep',
      });
      const s = d.sessions.get(started.id);
      s.dir = dir;
      live.push(s);
      await until(() => s.status === STATUS.IDLE, 'the first turn to end');
      assert.strictEqual('requiredModel' in started.agentSelection, false);
      assert.strictEqual(s.toJSON().requiredModel, undefined, 'an optional session grew a required-model record');
    });
  });

  // -------------------------------------------------------------------------
  // D. AcpSession over the real protocol
  // -------------------------------------------------------------------------

  await check('required model: an advertised model is confirmed over the protocol, then exactly one prompt runs on it', async () => {
    const s = start('copilot', { model: 'fake-deep' });
    await ran(s);
    const log = readLog(s.dir);
    assert.deepStrictEqual(calls(log), ['session/set_config_option:model', 'session/prompt'],
      'the model must be confirmed first and then exactly one prompt sent');
    assert.strictEqual(log[0].value, 'fake-deep');
    assert.strictEqual(prompts(log).length, 1);
    assert.strictEqual(prompts(log)[0].model, 'fake-deep', 'the prompt did not run on the required model');
    assert.deepStrictEqual(s.toJSON().requiredModel, {
      requested: 'fake-deep', chosen: 'fake-deep', confirmed: true, failure: null,
    });
    assert.strictEqual(s.applied.model, 'fake-deep');
    assert.strictEqual(s.nextTurnState().model.current, 'fake-deep');
  });

  await check('required model: a model that is already the current one is still confirmed by the agent, not assumed', async () => {
    const s = start('copilot', { model: 'fake-fast' });
    await ran(s);
    assert.deepStrictEqual(calls(readLog(s.dir)), ['session/set_config_option:model', 'session/prompt']);
    assert.strictEqual(s.toJSON().requiredModel.confirmed, true);
  });

  await check('required model: a different spelling of an advertised id runs on the agent\'s own id', async () => {
    const s = start('copilot', { model: 'FAKE-DEEP' });
    await ran(s);
    const log = readLog(s.dir);
    assert.strictEqual(log[0].value, 'fake-deep', 'the agent was sent the spelling it never advertised');
    assert.strictEqual(prompts(log)[0].model, 'fake-deep');
    assert.strictEqual(s.toJSON().requiredModel.chosen, 'fake-deep');
  });

  await check('required model: with the model confirmed the mode follows it, and both come before the prompt', async () => {
    const s = start('copilot', { model: 'fake-deep', mode: 'plan' });
    await ran(s);
    const log = readLog(s.dir);
    assert.deepStrictEqual(calls(log), ['session/set_config_option:model', 'session/set_config_option:mode', 'session/prompt']);
    assert.strictEqual(prompts(log)[0].model, 'fake-deep');
    assert.strictEqual(prompts(log)[0].mode, 'plan');
  });

  await check('required model: a model the agent does not offer is refused before any request or prompt', async () => {
    const s = start('copilot', { model: 'no-such-model' });
    const err = await refused(s, 'REQUIRED_MODEL_UNAVAILABLE');
    assert.deepStrictEqual(calls(readLog(s.dir)), [], 'something was sent to an agent that does not offer the model');
    assert.match(err.message, /fake-fast/, 'the refusal does not say what is available');
    assert.notStrictEqual(s.nextTurnState().model.current, 'no-such-model');
  });

  await check('required model: an agent that advertises nothing cannot confirm a model, so the session is refused', async () => {
    const s = start('', { model: 'fake-deep' });
    await refused(s, 'REQUIRED_MODEL_NOT_ADVERTISED');
    assert.deepStrictEqual(calls(readLog(s.dir)), [], 'a model change was attempted on an agent that advertised none');
  });

  await check('required model: an agent that lists models but cannot switch them is refused', async () => {
    const s = start('models-only', { model: 'fake-deep' });
    await refused(s, 'REQUIRED_MODEL_NOT_ADVERTISED');
    assert.deepStrictEqual(calls(readLog(s.dir)), [], 'session/set_model was tried as a way round the missing confirmation');
  });

  await check('required model: a method not found answer is a refusal, not a model that is in effect', async () => {
    const s = start('unsupported', { model: 'fake-deep' });
    await refused(s, 'REQUIRED_MODEL_NOT_ADVERTISED');
    assert.deepStrictEqual(calls(readLog(s.dir)), ['session/set_config_option:model']);
    assert.notStrictEqual(s.nextTurnState().model.current, 'fake-deep');
  });

  await check('required model: an agent that answers with the OLD current model has not confirmed the new one', async () => {
    const s = start('ignores', { model: 'fake-deep' });
    await refused(s, 'REQUIRED_MODEL_UNCONFIRMED');
    assert.deepStrictEqual(calls(readLog(s.dir)), ['session/set_config_option:model']);
    assert.strictEqual(s.nextTurnState().model.current, 'fake-fast', 'an unconfirmed request became the current model');
  });

  await check('required model: an agent that answers an empty result has not confirmed anything', async () => {
    const s = start('no-readback', { model: 'fake-deep' });
    await refused(s, 'REQUIRED_MODEL_UNCONFIRMED');
    assert.deepStrictEqual(calls(readLog(s.dir)), ['session/set_config_option:model']);
    assert.strictEqual(s.nextTurnState().model.current, 'fake-fast', 'an empty answer became the current model');
  });

  await check('required model: a model the agent only ANNOUNCED, while its reply to the request says nothing, is not confirmed', async () => {
    const s = start('announce-only', { model: 'fake-deep' });
    await refused(s, 'REQUIRED_MODEL_UNCONFIRMED');
    assert.deepStrictEqual(calls(readLog(s.dir)), ['session/set_config_option:model']);
  });

  await check('required model: a model is found by its id only: a display name that is itself a valid model name is a different thing', async () => {
    const byName = start('aliased', { model: 'deep' });
    await refused(byName, 'REQUIRED_MODEL_UNAVAILABLE');
    assert.deepStrictEqual(calls(readLog(byName.dir)), [], 'a request was sent for a model that was only matched by its display name');
    const byId = start('aliased', { model: 'fake-deep' });
    await ran(byId);
    assert.strictEqual(prompts(readLog(byId.dir))[0].model, 'fake-deep');
    assert.strictEqual(byId.toJSON().requiredModel.chosen, 'fake-deep');
  });

  await check('required model: an agent that refuses the change is a refusal that carries its reason', async () => {
    const s = start('refuse-model', { model: 'fake-deep' });
    const err = await refused(s, 'REQUIRED_MODEL_UNCONFIRMED');
    assert.match(err.message, /Cannot change the model/, 'the agent\'s own reason was lost');
  });

  await check('required model: a model refusal means the mode is never sent either', async () => {
    const s = start('refuse-model', { model: 'fake-deep', mode: 'plan' });
    await refused(s, 'REQUIRED_MODEL_UNCONFIRMED');
    assert.deepStrictEqual(calls(readLog(s.dir)), ['session/set_config_option:model'], 'the mode was applied after a failed model');
  });

  await check('required model: an agent that never answers times out as a refusal and its process is killed', async () => {
    const started = Date.now();
    const s = start('stuck', { model: 'fake-deep' });
    const err = await refused(s, 'REQUIRED_MODEL_TIMEOUT');
    assert.ok(Date.now() - started < 9000, 'the refusal waited past the selection timeout');
    assert.match(err.message, /REQUIRED_MODEL_TIMEOUT/);
  });

  await check('required model: an agent that dies while the model is being confirmed is a refusal with its own code', async () => {
    const s = start('stuck', { model: 'fake-deep' });
    await until(() => calls(readLog(s.dir)).includes('session/set_config_option:model'), 'the change to reach the agent');
    s.proc.kill();
    await refused(s, 'REQUIRED_MODEL_AGENT_EXITED');
  });

  await check('required model: an agent that exits before it answers the handshake is a refusal', async () => {
    const s = start('copilot', { model: 'fake-deep', agentArgs: ['-e', 'process.exit(3)'] });
    await refused(s, 'REQUIRED_MODEL_AGENT_EXITED');
  });

  await check('required model: a failure AFTER the model was confirmed is an ordinary failure, not a refusal', async () => {
    // The default fake mode asks for a permission and waits: the model is
    // already confirmed when the agent is killed.
    const s = start('copilot', { model: 'fake-deep', env: { FAKE_AGENT_MODE: 'approve-gate' } });
    await until(() => s.status === STATUS.WAITING_APPROVAL || s.pendingApprovals.size > 0, 'the first turn to ask');
    s.proc.kill();
    const err = await s.outcome;
    if (err) assert.ok(!(err instanceof RequiredModelError), `a later failure was reported as a model refusal: ${err.message}`);
    const rm = s.toJSON().requiredModel;
    assert.strictEqual(rm.confirmed, true);
    assert.strictEqual(rm.failure, null, 'a confirmed model was reported as refused');
  });

  // -------------------------------------------------------------------------
  // E. The optional path: still warns and defaults, still runs
  // -------------------------------------------------------------------------

  await check('required model: an optional model the agent does not offer still warns, defaults, and runs the prompt', async () => {
    const s = start('copilot', { model: 'no-such-model', strict: false });
    await ran(s);
    const log = readLog(s.dir);
    assert.deepStrictEqual(calls(log), ['session/prompt'], 'the optional path sent a model change for a model nobody offered');
    assert.strictEqual(prompts(log)[0].model, 'fake-fast', 'the default model did not run');
    assert.ok(s.applied.warnings.some((w) => /no-such-model/.test(w)), JSON.stringify(s.applied.warnings));
    assert.strictEqual(s.applied.model, null);
    assert.strictEqual(s.toJSON().requiredModel, undefined);
  });

  await check('required model: an optional model on an agent that advertises nothing still runs on its default', async () => {
    const s = start('', { model: 'fake-deep', strict: false });
    await ran(s);
    assert.strictEqual(s.status, STATUS.IDLE);
    assert.ok(s.transcript.some((e) => e.update && e.update.sessionUpdate === 'agent_message_chunk'), 'the prompt never ran');
  });

  await check('required model: an optional model the agent offers is still applied the way it always was', async () => {
    const s = start('copilot', { model: 'fake-deep', strict: false });
    await ran(s);
    const log = readLog(s.dir);
    assert.deepStrictEqual(calls(log), ['session/set_model:model', 'session/prompt'], 'the optional path changed how it asks');
    assert.strictEqual(prompts(log)[0].model, 'fake-deep');
    assert.strictEqual(s.applied.model, 'fake-deep');
  });

  killAll();

  // -------------------------------------------------------------------------
  // F. The whole cloud one-shot, through the shipped verb, against a fake hub
  // -------------------------------------------------------------------------

  const auth = new Authenticator({ mode: MODES.DEV, devSecret: 'required-model', deviceSecret: 'required-model-dev' });
  const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'sqreq-store-'));
  const svc = new HubService({ auth, deviceTokenDir: tmpStore });
  const addr = await svc.listen(0, '127.0.0.1');
  const hubUrl = `http://127.0.0.1:${addr.port}`;
  const userTok = auth.mintDevToken('t1', 'u1', 'operator');
  const get = (urlPath, token) => new Promise((resolve, reject) => {
    const r = http.get({
      host: '127.0.0.1', port: addr.port, path: urlPath, headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
  });
  const me = await get('/api/me', userTok);
  const devTok = auth.mintDeviceToken({ key: me.subject, label: 'jobs', didPrefix: 'job-' });

  let seq = 0;
  /** `squad-hub oneshot`, as a job platform runs it, against the fake hub and agent. */
  function oneshot(env, budgetMs = 45000) {
    return new Promise((resolve) => {
      seq += 1;
      const dir = work('job');
      const deviceId = `job-rm-${seq}`;
      const home = work('job-home');
      const child = spawn(process.execPath, [BIN, 'oneshot'], {
        env: {
          ...scrubbed(),
          SQUAD_HUB_HOME: home,
          SQUAD_HUB_AGENT: process.execPath,
          SQUAD_HUB_AGENT_ARGS: FAKE_AGENT,
          SQUAD_HUB_URL: hubUrl,
          SQUAD_HUB_TOKEN: devTok,
          SQUAD_HUB_DEVICE_ID: deviceId,
          SQUAD_HUB_DEVICE_NAME: `job ${seq}`,
          SQUAD_HUB_PROMPT: 'do the thing',
          SQUAD_HUB_CWD: dir,
          SQUAD_HUB_SELECTION_TIMEOUT_MS: '1500',
          FAKE_AGENT_MODE: 'no-permission',
          FAKE_AGENT_RPC_LOG: 'rpc.jsonl',
          FAKE_AGENT_ARGV_FILE: argvFile,
          ...env,
        },
        windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const started = Date.now();
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
        resolve({
          exited: false, code: null, ms: Date.now() - started, out, dir, deviceId,
        });
      }, budgetMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({
          exited: true, code, ms: Date.now() - started, out, dir, deviceId,
        });
      });
    });
  }
  const hubSession = async (deviceId) => {
    const r = await get('/api/sessions', userTok);
    return (r.sessions || []).find((s) => s.deviceId === deviceId) || null;
  };
  const refusal = (r) => (r.out.match(/required-model-refused code=(\S+) reason=(.*)/) || []);

  await check('required model: a one-shot with a confirmed required model runs the prompt on it and exits 0', async () => {
    const r = await oneshot({ SQUAD_HUB_REQUIRE_MODEL: '1', SQUAD_HUB_MODEL: 'fake-deep', FAKE_AGENT_NEXT_TURN: 'copilot' });
    assert.strictEqual(r.exited, true, `the process never exited. ${r.out.slice(-400)}`);
    assert.strictEqual(r.code, 0, `exit ${r.code}. ${r.out.slice(-600)}`);
    assert.match(r.out, /model required: fake-deep/);
    assert.match(r.out, /model confirmed: requested=fake-deep chosen=fake-deep/);
    assert.doesNotMatch(r.out, /required-model-refused/);
    const log = readLog(r.dir);
    assert.deepStrictEqual(calls(log), ['session/set_config_option:model', 'session/prompt']);
    assert.strictEqual(prompts(log)[0].model, 'fake-deep', 'the job did not run on the required model');
    const seen = await hubSession(r.deviceId);
    assert.ok(seen, 'the hub never heard about the session');
    assert.strictEqual(seen.agentSelection.requiredModel, true, JSON.stringify(seen.agentSelection));
    assert.strictEqual(seen.requiredModel.confirmed, true, JSON.stringify(seen.requiredModel));
    assert.strictEqual(seen.applied.model, 'fake-deep', 'the hub was told a model that was not the confirmed one');
  });

  await check('required model: a one-shot whose required model is unavailable exits 78 with the code, runs no prompt, and leaves nothing hanging', async () => {
    const r = await oneshot({ SQUAD_HUB_REQUIRE_MODEL: '1', SQUAD_HUB_MODEL: 'no-such-model', FAKE_AGENT_NEXT_TURN: 'copilot' });
    assert.strictEqual(r.exited, true, `the process hung on a refused session (${r.ms} ms). ${r.out.slice(-400)}`);
    assert.strictEqual(r.code, 78, `exit ${r.code}. ${r.out.slice(-600)}`);
    assert.strictEqual(refusal(r)[1], 'REQUIRED_MODEL_UNAVAILABLE', r.out.slice(-600));
    assert.doesNotMatch(r.out, /model confirmed/);
    assert.strictEqual(prompts(readLog(r.dir)).length, 0, 'a prompt ran on the wrong model');
    assert.deepStrictEqual(calls(readLog(r.dir)), []);
    const seen = await hubSession(r.deviceId);
    assert.ok(seen, 'the hub never heard about the session');
    assert.strictEqual(seen.status, 'failed', `the hub shows ${seen.status} for a refused job`);
    assert.strictEqual(seen.requiredModel.failure.code, 'REQUIRED_MODEL_UNAVAILABLE', JSON.stringify(seen.requiredModel));
    assert.strictEqual(seen.applied.model, null);
  });

  await check('required model: a one-shot refuses with 78 when the agent ignores the change, cannot read it back, never answers, or advertises nothing', async () => {
    const cases = [
      ['ignores', 'REQUIRED_MODEL_UNCONFIRMED'],
      ['no-readback', 'REQUIRED_MODEL_UNCONFIRMED'],
      ['stuck', 'REQUIRED_MODEL_TIMEOUT'],
      ['unsupported', 'REQUIRED_MODEL_NOT_ADVERTISED'],
      ['', 'REQUIRED_MODEL_NOT_ADVERTISED'],
    ];
    for (const [variant, code] of cases) {
      const r = await oneshot({ SQUAD_HUB_REQUIRE_MODEL: '1', SQUAD_HUB_MODEL: 'fake-deep', FAKE_AGENT_NEXT_TURN: variant });
      const what = `agent "${variant || 'advertises nothing'}": exit ${r.code}. ${r.out.slice(-500)}`;
      assert.strictEqual(r.exited, true, `hung. ${what}`);
      assert.strictEqual(r.code, 78, what);
      assert.strictEqual(refusal(r)[1], code, what);
      assert.strictEqual(prompts(readLog(r.dir)).length, 0, `a prompt ran. ${what}`);
      assert.doesNotMatch(r.out, /model confirmed/, what);
    }
  });

  await check('required model: a one-shot whose agent never confirms stops at the session ceiling with 78, and the hub is told it was stopped', async () => {
    const r = await oneshot({
      SQUAD_HUB_REQUIRE_MODEL: '1',
      SQUAD_HUB_MODEL: 'fake-deep',
      FAKE_AGENT_NEXT_TURN: 'stuck',
      SQUAD_HUB_SELECTION_TIMEOUT_MS: '60000',
      SQUAD_HUB_MAX_SESSION_MS: '3000',
    });
    const what = `exit ${r.code}. ${r.out.slice(-500)}`;
    assert.strictEqual(r.exited, true, `hung. ${what}`);
    assert.strictEqual(r.code, 78, what);
    assert.strictEqual(refusal(r)[1], 'REQUIRED_MODEL_TIMEOUT', what);
    assert.match(refusal(r)[2], /ceiling/, what);
    assert.strictEqual(prompts(readLog(r.dir)).length, 0, `a prompt ran. ${what}`);
    const seen = await hubSession(r.deviceId);
    assert.ok(seen, 'the hub never heard about the session');
    assert.strictEqual(seen.status, 'stopped', `the hub shows ${seen.status} for a job that was cut off waiting for its model`);
  });

  await check('required model: a one-shot with a missing, invalid or unparseable requirement refuses before any agent or hub work', async () => {
    const cases = [
      [{ SQUAD_HUB_REQUIRE_MODEL: '1' }, 'REQUIRED_MODEL_MISSING'],
      [{ SQUAD_HUB_REQUIRE_MODEL: '1', SQUAD_HUB_MODEL: '--allow-all-tools' }, 'REQUIRED_MODEL_INVALID'],
      [{ SQUAD_HUB_REQUIRE_MODEL: 'true', SQUAD_HUB_MODEL: 'fake-deep' }, 'REQUIRED_MODEL_FLAG_INVALID'],
      [{ SQUAD_HUB_REQUIRE_MODEL: '1', SQUAD_HUB_MODEL: 'fake-deep', SQUAD_HUB_ONESHOT: '0' }, 'REQUIRED_MODEL_ONESHOT_ONLY'],
    ];
    for (const [env, code] of cases) {
      const r = await oneshot({ FAKE_AGENT_NEXT_TURN: 'copilot', ...env });
      const what = `${JSON.stringify(env)}: exit ${r.code}. ${r.out.slice(-400)}`;
      assert.strictEqual(r.exited, true, `hung. ${what}`);
      assert.strictEqual(r.code, 78, what);
      assert.strictEqual(refusal(r)[1], code, what);
      assert.strictEqual(fs.existsSync(path.join(r.dir, argvFile)), false, `the agent was started. ${what}`);
      assert.doesNotMatch(r.out, /attaching to|connected|session \S+ (started|idle|done|failed)/, `the device started work. ${what}`);
      assert.strictEqual(await hubSession(r.deviceId), null, `the hub heard about a refused job. ${what}`);
      if (env.SQUAD_HUB_MODEL && /^-/.test(env.SQUAD_HUB_MODEL)) {
        assert.ok(!r.out.includes(env.SQUAD_HUB_MODEL), 'the rejected model value was echoed');
      }
    }
  });

  await check('required model: with the flag off or 0 an unavailable model still warns, defaults and runs, as before', async () => {
    for (const flag of [undefined, '0', '']) {
      const env = { SQUAD_HUB_MODEL: 'no-such-model', FAKE_AGENT_NEXT_TURN: 'copilot' };
      if (flag !== undefined) env.SQUAD_HUB_REQUIRE_MODEL = flag;
      const r = await oneshot(env);
      const what = `flag ${JSON.stringify(flag)}: exit ${r.code}. ${r.out.slice(-500)}`;
      assert.strictEqual(r.code, 0, what);
      assert.match(r.out, /model requested: no-such-model/, what);
      assert.doesNotMatch(r.out, /required-model-refused|model required/, what);
      const log = readLog(r.dir);
      assert.strictEqual(prompts(log).length, 1, `the optional job did not run. ${what}`);
      assert.strictEqual(prompts(log)[0].model, 'fake-fast', `the default model did not run. ${what}`);
      assert.deepStrictEqual(calls(log), ['session/prompt'], what);
    }
  });

  await svc.close();
  killAll();

  console.log('='.repeat(60));
  console.log(`required model: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  killAll();
  console.error(e);
  process.exit(1);
});
