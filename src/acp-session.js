'use strict';
/**
 * A Squad session backed by one `copilot --acp` child process.
 *
 * WHY ONE PROCESS PER SESSION, when spike/acp-capability-probe.js proved a
 * single ACP process can drive two concurrent sessions:
 *
 *   Because "can" is not "should". Multiplexing means one crash takes every
 *   session on the device with it, and it makes "stop this session" a protocol
 *   problem instead of a kill(). The probe's real value is that it removes
 *   multiplexing from the risk list -- we can adopt it later as an
 *   optimisation, having already proven the agent supports it.
 *
 * Everything this class exposes about a permission request comes from the wire,
 * not from a summary. spike/q1-permission-payload.json shows toolCall.rawInput
 * carries the literal command; we forward it untouched so the approval surface
 * can show what will actually run.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const STATUS = Object.freeze({
  STARTING: 'starting',
  ACTIVE: 'active',
  WAITING_APPROVAL: 'waiting_approval',
  DONE: 'done',
  FAILED: 'failed',
  STOPPED: 'stopped',
});

class AcpSession extends EventEmitter {
  constructor({ id, cwd, prompt, agentCommand = 'copilot', agentArgs = ['--acp'], env }) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.prompt = prompt;
    this.status = STATUS.STARTING;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.error = null;
    this.acpSessionId = null;
    this.agentInfo = null;
    this.agentSelection = null;
    this.toolCallCount = 0;
    this.transcript = [];
    // Every transcript entry gets a monotonic sequence number that survives
    // the 500-entry cap below. A client tracking "how many entries have I
    // seen" by ARRAY INDEX goes silent forever once the window first slides
    // (index 500 never arrives a second time); a client tracking the highest
    // `seq` it has seen keeps working across any number of slides. The cap
    // is overridable so a test can drive a slide in a handful of updates
    // instead of five hundred.
    this._nextSeq = 1;
    this._transcriptCap = Number(process.env.SQUAD_HUB_TRANSCRIPT_CAP) || 500;
    this.pendingApprovals = new Map();
    this.activity = 'Starting...';

    this._nextId = 1;
    this._pending = new Map();
    this._buffer = '';
    this._stderr = '';

    this.proc = spawn(agentCommand, agentArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    this.pid = this.proc.pid;

    this.proc.stderr.on('data', (d) => { this._stderr = (this._stderr + d.toString()).slice(-8000); });
    this.proc.stdout.on('data', (c) => this._read(c));
    this.proc.on('exit', (code, signal) => this._onExit(code, signal));
    this.proc.on('error', (e) => this._fail(`agent process could not start: ${e.message}`));
  }

  // -- wire -----------------------------------------------------------------

  _read(chunk) {
    this._buffer += chunk.toString();
    let nl;
    while ((nl = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, nl).trim();
      this._buffer = this._buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) return this._agentRequest(msg);
    if (msg.method === 'session/update') return this._update(msg.params);
  }

  _send(o) {
    if (!this.proc || this.proc.killed) return;
    try { this.proc.stdin.write(JSON.stringify(o) + '\n'); } catch { /* closing */ }
  }

  _request(method, params) {
    const id = this._nextId++;
    this._send({ jsonrpc: '2.0', id, method, params });
    return new Promise((res, rej) => this._pending.set(id, { resolve: res, reject: rej }));
  }

  _respond(id, result) { this._send({ jsonrpc: '2.0', id, result }); }

  _agentRequest(msg) {
    if (msg.method !== 'session/request_permission') {
      this._respond(msg.id, {});
      return;
    }
    const p = msg.params || {};
    const tc = p.toolCall || {};
    const raw = tc.rawInput || {};
    const approval = {
      approvalId: tc.toolCallId || `req-${msg.id}`,
      rpcId: msg.id,
      sessionId: this.id,
      title: tc.title || null,
      kind: tc.kind || null,
      // The literal thing that will run. Proven present in spike/q1.
      command: raw.command || (Array.isArray(raw.commands) ? raw.commands.join(' && ') : null),
      commands: Array.isArray(raw.commands) ? raw.commands : (raw.command ? [raw.command] : []),
      paths: extractPaths(raw),
      readOnly: tc.kind === 'read' || tc.kind === 'search',
      options: (p.options || []).map((o) => ({ optionId: o.optionId, kind: o.kind, name: o.name })),
      requestedAt: Date.now(),
      rawInput: raw,
    };
    this.pendingApprovals.set(approval.approvalId, approval);
    this._setStatus(STATUS.WAITING_APPROVAL, 'Waiting for approval');
    this.emit('approval', approval);
  }

  _pushTranscript(u) {
    this.transcript.push({ seq: this._nextSeq++, at: Date.now(), update: u });
    if (this.transcript.length > this._transcriptCap) {
      this.transcript.splice(0, this.transcript.length - this._transcriptCap);
    }
  }

  _update(params) {
    const u = (params && params.update) || {};
    this._pushTranscript(u);
    if (u.sessionUpdate === 'tool_call') {
      this.toolCallCount += 1;
      this.activity = u.title ? `Running ${u.title}` : 'Running a tool...';
    } else if (u.sessionUpdate === 'agent_message_chunk') {
      this.activity = 'Processing...';
    }
    this.emit('update', u);
  }

  // -- lifecycle ------------------------------------------------------------

  async run() {
    const init = await this._request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    this.agentInfo = init.agentInfo || null;

    const s = await this._request('session/new', { cwd: this.cwd, mcpServers: [] });
    this.acpSessionId = s.sessionId;
    this._setStatus(STATUS.ACTIVE, 'Processing...');

    const stop = await this._request('session/prompt', {
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text: this.prompt }],
    });
    this.stopReason = stop && stop.stopReason;
    this._setStatus(STATUS.DONE, 'Finished');
    this.endedAt = Date.now();
    this.shutdown();
    return stop;
  }

  /** Answer a pending approval. Returns false if the id is unknown. */
  answer(approvalId, optionId) {
    const a = this.pendingApprovals.get(approvalId);
    if (!a) return false;
    this.pendingApprovals.delete(approvalId);
    const known = a.options.some((o) => o.optionId === optionId);
    if (!known) return false;
    this._respond(a.rpcId, { outcome: { outcome: 'selected', optionId } });
    this._setStatus(STATUS.ACTIVE, 'Processing...');
    this.emit('approval-resolved', { approvalId, optionId });
    return true;
  }

  /** Let a pending approval lapse without running the tool. */
  expire(approvalId) {
    const a = this.pendingApprovals.get(approvalId);
    if (!a) return false;
    this.pendingApprovals.delete(approvalId);
    this._respond(a.rpcId, { outcome: { outcome: 'cancelled' } });
    this.emit('approval-expired', { approvalId });
    return true;
  }

  /**
   * Send follow-up input to a running agent.
   *
   * ACP has no "inject into the current turn" message, so this queues a fresh
   * prompt on the same session. The distinction is visible to the user: input
   * lands after the current turn ends, not in the middle of it. Pretending
   * otherwise would be worse than saying so.
   */
  steer(text) {
    if (!text || this.status === STATUS.DONE || this.status === STATUS.STOPPED || this.status === STATUS.FAILED) {
      return false;
    }
    if (!this.acpSessionId) return false;
    this._pushTranscript({ sessionUpdate: 'user_message', content: { text } });
    this._request('session/prompt', {
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text }],
    }).catch((e) => {
      this._pushTranscript({ sessionUpdate: 'error', content: { text: e.message } });
    });
    this._setStatus(STATUS.ACTIVE, 'Processing...');
    return true;
  }

  stop() {
    this._setStatus(STATUS.STOPPED, 'Stopped');
    this.endedAt = Date.now();
    this.shutdown();
  }

  shutdown() {
    if (!this.proc || this.proc.killed) return;
    try { this.proc.kill(); } catch { /* gone */ }
  }

  /** True when the child process is gone. */
  isAgentDead() {
    if (!this.pid) return true;
    try { process.kill(this.pid, 0); return false; } catch { return true; }
  }

  _onExit(code, signal) {
    const terminal = [STATUS.DONE, STATUS.STOPPED, STATUS.FAILED];
    if (terminal.includes(this.status)) return;
    this._fail(`agent exited unexpectedly (code=${code} signal=${signal})`);
  }

  _fail(message) {
    this.error = message;
    this.endedAt = Date.now();
    this._setStatus(STATUS.FAILED, 'Failed');
    for (const [, p] of this._pending) p.reject(new Error(message));
    this._pending.clear();
  }

  _setStatus(next, activity) {
    if (this.status === next && this.activity === activity) return;
    const prev = this.status;
    this.status = next;
    if (activity) this.activity = activity;
    this.emit('status', { from: prev, to: next, activity: this.activity });
  }

  toJSON() {
    return {
      id: this.id,
      pid: this.pid,
      status: this.status,
      activity: this.activity,
      cwd: this.cwd,
      prompt: this.prompt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      error: this.error,
      agent: this.agentInfo ? `${this.agentInfo.name} ${this.agentInfo.version}` : 'Copilot CLI',
      agentSelection: this.agentSelection || null,
      toolCallCount: this.toolCallCount,
      pendingApprovals: [...this.pendingApprovals.values()],
      squad: this.squadContext(),
      stderrTail: this.status === STATUS.FAILED ? this._stderr.slice(-1000) : undefined,
    };
  }

  /**
   * Squad context for this session's working directory.
   *
   * Cached, and refreshed on a timer rather than on every read. `toJSON` is
   * called on every heartbeat and every status poll; re-reading and re-parsing
   * `.squad/` each time would put a filesystem walk on the hot path for data
   * that changes a few times an hour.
   */
  squadContext() {
    const now = Date.now();
    if (this._squad !== undefined && now - this._squadAt < 30000) return this._squad;
    const { readSquad } = require('./squad-context');
    this._squad = readSquad(this.cwd, { transcript: this.transcript.slice(-40) });
    this._squadAt = now;
    return this._squad;
  }
}

/** Best-effort path extraction from a tool's raw input. */
function extractPaths(raw) {
  const out = new Set();
  for (const k of ['path', 'file', 'filePath', 'filename']) {
    if (typeof raw[k] === 'string') out.add(raw[k]);
  }
  for (const k of ['paths', 'files', 'filePaths']) {
    if (Array.isArray(raw[k])) raw[k].filter((x) => typeof x === 'string').forEach((x) => out.add(x));
  }
  const cmds = Array.isArray(raw.commands) ? raw.commands : (raw.command ? [raw.command] : []);
  for (const c of cmds) {
    const m = String(c).match(/[\w./\\-]+\.[A-Za-z0-9]{1,6}\b/g);
    if (m) m.forEach((x) => out.add(x));
  }
  return [...out];
}

module.exports = { AcpSession, STATUS, extractPaths };
