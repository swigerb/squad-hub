#!/usr/bin/env node
/**
 * Sprint 1 design input — two questions Sprint 0 left open, both load-bearing.
 *
 * Q1. Does session/request_permission carry the LITERAL command and the paths
 *     touched, or only a human-readable title?
 *
 *     Sprint 0 observed kind=execute and title="Create marker file...". If that
 *     is all there is, the PRD's sprint-3 acceptance criterion ("the card shows
 *     the command and the paths touched") cannot be met and must be rewritten.
 *     So: dump the ENTIRE params object, unabridged, and let the bytes decide.
 *
 * Q2. Can ONE ACP client process drive TWO concurrent sessions?
 *
 *     If yes, the daemon is one process with a session map. If no, it is a
 *     process supervisor. That is a different program, and it is cheaper to
 *     learn now than in sprint 4.
 *
 * Usage:  node acp-capability-probe.js [--q1] [--q2]
 * Exit:   0 both answered, 77 inconclusive.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUN_Q1 = process.argv.includes('--q1') || !process.argv.includes('--q2');
const RUN_Q2 = process.argv.includes('--q2') || !process.argv.includes('--q1');

const log = (...a) => console.log('[cap]', ...a);
const findings = [];

class AcpClient {
  constructor(cwd, tag) {
    this.tag = tag;
    this.cwd = cwd;
    this.proc = spawn('copilot', ['--acp'], { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.onPermission = null;
    this.updates = [];
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString(); });
    this.proc.stdout.on('data', (c) => this._read(c));
  }

  _read(chunk) {
    this.buffer += chunk.toString();
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        if (msg.method === 'session/request_permission' && this.onPermission) {
          this.onPermission(msg);
        } else {
          this.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        }
        continue;
      }
      if (msg.method === 'session/update') this.updates.push(msg.params);
    }
  }

  send(o) { this.proc.stdin.write(JSON.stringify(o) + '\n'); }

  request(method, params) {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }

  respond(id, result) { this.send({ jsonrpc: '2.0', id, result }); }

  async init() {
    const r = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    return r;
  }

  kill() { try { this.proc.kill(); } catch { /* gone */ } }
}

function pick(opts, deny) {
  const want = deny ? ['reject_once', 'reject'] : ['allow_once', 'allow'];
  return opts.find((o) => want.includes(o.kind)) || opts.find((o) => want.includes(o.optionId)) || opts[0];
}

// ---------------------------------------------------------------------------
// Q1 — the full payload.
// ---------------------------------------------------------------------------
async function q1() {
  log('=== Q1: what does a permission request actually contain? ===');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-q1-'));
  // Two files and a recognisable literal, so we can search the payload for
  // BOTH the command text and the paths.
  fs.writeFileSync(path.join(dir, 'alpha.txt'), 'alpha\n');
  const c = new AcpClient(dir, 'q1');
  let captured = null;

  c.onPermission = (msg) => {
    if (!captured) captured = msg.params;
    const opts = (msg.params && msg.params.options) || [];
    c.respond(msg.id, { outcome: { outcome: 'selected', optionId: pick(opts, true).optionId } });
  };

  const info = await c.init();
  log(`agent: ${info.agentInfo && info.agentInfo.name} ${info.agentInfo && info.agentInfo.version}`);
  const s = await c.request('session/new', { cwd: dir, mcpServers: [] });

  const NEEDLE = 'SQUADHUBNEEDLE42';
  await c.request('session/prompt', {
    sessionId: s.sessionId,
    prompt: [{
      type: 'text',
      text: `Run this exact shell command and nothing else: echo ${NEEDLE} >> alpha.txt`,
    }],
  });

  c.kill();

  if (!captured) {
    log('no permission request captured');
    findings.push({ q: 'Q1', answer: 'INCONCLUSIVE - no permission request arrived' });
    return;
  }

  const json = JSON.stringify(captured, null, 2);
  const outFile = path.join(__dirname, 'q1-permission-payload.json');
  fs.writeFileSync(outFile, json);
  log(`FULL PAYLOAD written to ${outFile} (${json.length} bytes)`);
  console.log(json.length > 6000 ? json.slice(0, 6000) + '\n...[truncated]' : json);

  // The assertions that matter: is the literal command in there, and the path?
  const hasCommand = json.includes(NEEDLE);
  const hasPath = /alpha\.txt/.test(json);
  const keys = Object.keys(captured.toolCall || {});
  log(`toolCall keys: ${JSON.stringify(keys)}`);
  log(`literal command text present (searched for ${NEEDLE}): ${hasCommand}`);
  log(`touched path present (alpha.txt): ${hasPath}`);

  findings.push({
    q: 'Q1',
    answer: hasCommand
      ? 'the literal command IS in the payload - sprint 3 criterion is achievable as written'
      : 'the literal command is NOT in the payload - sprint 3 criterion must be rewritten',
    hasCommand, hasPath, toolCallKeys: keys,
  });
}

// ---------------------------------------------------------------------------
// Q2 — concurrency on one client.
// ---------------------------------------------------------------------------
async function q2() {
  log('');
  log('=== Q2: can ONE acp process drive TWO concurrent sessions? ===');
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-q2a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-q2b-'));
  const c = new AcpClient(dirA, 'q2');

  const seen = { A: false, B: false };
  const bySession = new Map();

  c.onPermission = (msg) => {
    const sid = msg.params && msg.params.sessionId;
    bySession.set(sid, (bySession.get(sid) || 0) + 1);
    const opts = (msg.params && msg.params.options) || [];
    c.respond(msg.id, { outcome: { outcome: 'selected', optionId: pick(opts, false).optionId } });
  };

  await c.init();
  const a = await c.request('session/new', { cwd: dirA, mcpServers: [] });
  let b;
  try {
    b = await c.request('session/new', { cwd: dirB, mcpServers: [] });
  } catch (e) {
    log('second session/new REJECTED: ' + e.message);
    findings.push({ q: 'Q2', answer: 'one process CANNOT hold two sessions - daemon must be a process supervisor' });
    c.kill();
    return;
  }

  log(`session A = ${a.sessionId}`);
  log(`session B = ${b.sessionId}`);
  if (a.sessionId === b.sessionId) {
    findings.push({ q: 'Q2', answer: 'FAIL - the agent returned the same session id twice' });
    c.kill();
    return;
  }

  // Fire both prompts WITHOUT awaiting the first. If the agent serialises, the
  // second will simply finish later; if it rejects or interleaves incorrectly we
  // will see it.
  const pa = c.request('session/prompt', {
    sessionId: a.sessionId,
    prompt: [{ type: 'text', text: 'Run this exact shell command and nothing else: echo A > a.txt' }],
  });
  const pb = c.request('session/prompt', {
    sessionId: b.sessionId,
    prompt: [{ type: 'text', text: 'Run this exact shell command and nothing else: echo B > b.txt' }],
  });

  const settled = await Promise.allSettled([pa, pb]);
  settled.forEach((r, i) => log(`prompt ${'AB'[i]}: ${r.status}${r.status === 'rejected' ? ' ' + r.reason.message : ''}`));

  seen.A = fs.existsSync(path.join(dirA, 'a.txt'));
  seen.B = fs.existsSync(path.join(dirB, 'b.txt'));
  log(`side effect in A's cwd: ${seen.A}   (${fs.readdirSync(dirA).join(', ') || 'empty'})`);
  log(`side effect in B's cwd: ${seen.B}   (${fs.readdirSync(dirB).join(', ') || 'empty'})`);
  log(`permission requests per session: ${JSON.stringify([...bySession])}`);

  c.kill();

  const both = seen.A && seen.B;
  findings.push({
    q: 'Q2',
    answer: both
      ? 'ONE process drove TWO sessions to completion in SEPARATE working directories - daemon can be a single process with a session map'
      : 'one process did NOT complete both sessions - daemon should supervise one process per session',
    sideEffectA: seen.A, sideEffectB: seen.B,
    distinctSessionIds: a.sessionId !== b.sessionId,
  });
}

(async () => {
  const t = setTimeout(() => { log('OVERALL TIMEOUT'); process.exit(77); }, 420000);
  try {
    if (RUN_Q1) await q1();
    if (RUN_Q2) await q2();
  } catch (e) {
    log('ERROR: ' + e.message);
  }
  clearTimeout(t);
  console.log('\n[cap] ===== FINDINGS =====');
  console.log(JSON.stringify(findings, null, 2));
  fs.writeFileSync(path.join(__dirname, 'capability-findings.json'), JSON.stringify(findings, null, 2));
  process.exit(findings.length ? 0 : 77);
})();
