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
 */

const fs = require('fs');
const path = require('path');

const MODE = process.env.FAKE_AGENT_MODE || 'approve-gate';
const MARKER = process.env.FAKE_AGENT_MARKER || 'fake-agent-marker.txt';
const COMMAND = process.env.FAKE_AGENT_COMMAND || `echo ran > ${MARKER}`;

let buf = '';
const sessions = new Map();

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
    sessions.set(sessionId, { cwd: msg.params && msg.params.cwd });
    return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId;
    const s = sessions.get(sessionId) || { cwd: process.cwd() };
    notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking' } });

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

