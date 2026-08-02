#!/usr/bin/env node
/**
 * Sprint 0 — the abandon gate for Squad Hub.
 *
 * QUESTION: can a programmatic client catch an agent's permission request and
 * answer it, so that the agent actually proceeds or actually stops?
 *
 * If it cannot, Squad Hub is a read-only viewer and the product needs
 * re-scoping. Everything downstream (daemon, service, PWA, Teams) is
 * conventional engineering; this one message is the product.
 *
 * WHAT THIS REFUSES TO DO
 *
 * It does not assert on the agent's reply text, and it does not assert that a
 * permission response was accepted. Both are things a broken implementation
 * says just as readily as a working one. It asserts the SIDE EFFECT: a file the
 * agent can only create by actually running the tool.
 *
 *   allow -> the marker file EXISTS
 *   deny  -> the marker file DOES NOT EXIST
 *
 * A test that checked "the agent said it was denied" would pass against an
 * agent that ran the command anyway.
 *
 * Usage:  node acp-permission-probe.js [--mode allow|deny|timeout]
 * Exit:   0 pass, 1 fail, 77 inconclusive (could not reach a permission request)
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODE = (() => {
  const i = process.argv.indexOf('--mode');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 'allow';
})();

const OVERALL_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 180000);
// Deliberately short so an unanswered request is observed as bounded rather
// than as "the probe gave up".
const NO_ANSWER_WINDOW_MS = Number(process.env.PROBE_NO_ANSWER_MS || 45000);

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-probe-'));
const markerName = 'squad-hub-probe-marker.txt';
const markerPath = path.join(workdir, markerName);

const log = (...a) => console.log('[probe]', ...a);

// ---------------------------------------------------------------------------
// Minimal ACP client over stdio (newline-delimited JSON-RPC).
// ---------------------------------------------------------------------------
const proc = spawn('copilot', ['--acp'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: workdir });

let nextId = 1;
const pending = new Map();
let buffer = '';
let stderr = '';

const observed = {
  permissionRequests: [],
  updates: 0,
  toolCalls: [],
  agentRequests: [],
};

function send(obj) {
  proc.stdin.write(JSON.stringify(obj) + '\n');
}

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

proc.stderr.on('data', (d) => { stderr += d.toString(); });

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;

    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    // A response to something we sent.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      continue;
    }

    // A request FROM the agent. This is the direction that matters.
    if (msg.method && msg.id !== undefined) {
      observed.agentRequests.push(msg.method);
      handleAgentRequest(msg);
      continue;
    }

    // A notification from the agent (transcript stream).
    if (msg.method === 'session/update') {
      observed.updates += 1;
      const u = msg.params && msg.params.update;
      if (u && u.sessionUpdate === 'tool_call') {
        observed.toolCalls.push(u.title || u.kind || 'tool');
      }
    }
  }
});

function handleAgentRequest(msg) {
  if (msg.method === 'session/request_permission') {
    observed.permissionRequests.push(msg.params);
    const opts = (msg.params && msg.params.options) || [];
    log(`PERMISSION REQUEST received. options=${JSON.stringify(opts.map((o) => o.optionId || o.kind))}`);
    const tc = msg.params && msg.params.toolCall;
    if (tc) log(`  toolCall: kind=${tc.kind} title=${JSON.stringify(tc.title)}`);

    if (MODE === 'timeout') {
      log('  mode=timeout -> deliberately NOT answering');
      return; // never respond
    }

    const want = MODE === 'deny'
      ? ['reject_once', 'reject', 'reject_always']
      : ['allow_once', 'allow', 'allow_always'];
    let chosen = opts.find((o) => want.includes(o.kind)) || opts.find((o) => want.includes(o.optionId));
    if (!chosen && opts.length) chosen = MODE === 'deny' ? opts[opts.length - 1] : opts[0];

    if (!chosen) {
      log('  no options offered; cancelling');
      respond(msg.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    log(`  answering: ${chosen.optionId} (${chosen.kind})`);
    respond(msg.id, { outcome: { outcome: 'selected', optionId: chosen.optionId } });
    return;
  }

  // Anything else the agent asks of us: answer minimally so it is not blocked
  // on an unrelated capability.
  respond(msg.id, {});
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
(async () => {
  const timer = setTimeout(() => {
    log('OVERALL TIMEOUT');
    finish(77, 'the probe timed out before a verdict');
  }, OVERALL_TIMEOUT_MS);

  try {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    log(`initialize ok: ${init.agentInfo && init.agentInfo.name} ${init.agentInfo && init.agentInfo.version}`);

    const session = await request('session/new', { cwd: workdir, mcpServers: [] });
    const sessionId = session.sessionId;
    log(`session/new ok: ${sessionId}`);

    const prompt =
      `Create a file named exactly ${markerName} in the current working directory, ` +
      `containing the word ran. Use a shell command to do it. ` +
      `Do not use a file-writing tool. Do nothing else.`;

    log(`prompting (mode=${MODE})...`);
    const promptPromise = request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });

    if (MODE === 'timeout') {
      await new Promise((r) => setTimeout(r, NO_ANSWER_WINDOW_MS));
      clearTimeout(timer);
      const sawRequest = observed.permissionRequests.length > 0;
      const markerExists = fs.existsSync(markerPath);
      log(`permission requests seen: ${observed.permissionRequests.length}`);
      log(`marker exists: ${markerExists}`);
      if (!sawRequest) return finish(77, 'no permission request arrived; cannot judge the timeout path');
      if (markerExists) return finish(1, 'an UNANSWERED permission request still ran the tool');
      return finish(0, 'an unanswered request did not run the tool, and the probe was not hung by it');
    }

    const stop = await promptPromise;
    clearTimeout(timer);
    log(`session/prompt returned: ${JSON.stringify(stop)}`);

    const sawRequest = observed.permissionRequests.length > 0;
    const markerExists = fs.existsSync(markerPath);
    log(`permission requests seen: ${observed.permissionRequests.length}`);
    log(`session/update notifications: ${observed.updates}`);
    log(`agent->client methods: ${JSON.stringify([...new Set(observed.agentRequests)])}`);
    log(`tool calls observed: ${JSON.stringify(observed.toolCalls.slice(0, 5))}`);
    log(`MARKER FILE EXISTS: ${markerExists}   (${markerPath})`);
    if (!markerExists) log(`workdir contains: ${JSON.stringify(fs.readdirSync(workdir))}`);

    if (!sawRequest) {
      return finish(77, 'no session/request_permission arrived - inconclusive, not a pass');
    }
    if (MODE === 'allow') {
      return markerExists
        ? finish(0, 'ALLOW ran the tool - proven by the side effect, not by the reply')
        : finish(1, 'ALLOW was answered but the tool did not run');
    }
    return markerExists
      ? finish(1, 'DENY was answered but the tool RAN ANYWAY')
      : finish(0, 'DENY stopped the tool - proven by the absence of the side effect');
  } catch (e) {
    clearTimeout(timer);
    log('ERROR: ' + e.message);
    if (stderr) log('stderr: ' + stderr.slice(0, 600));
    finish(77, 'the probe could not complete a run');
  }
})();

function finish(code, why) {
  const verdict = code === 0 ? 'PASS' : code === 1 ? 'FAIL' : 'INCONCLUSIVE';
  console.log(`\n[probe] ${verdict}: ${why}`);
  try { proc.kill(); } catch { /* already gone */ }
  process.exit(code);
}
