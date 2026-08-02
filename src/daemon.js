'use strict';
/**
 * The per-device daemon.
 *
 * One daemon serves every session on the machine. It owns:
 *   - the session registry
 *   - a heartbeat that decides device presence AND notices dead agents
 *   - an orphan reaper, which is the load-bearing part
 *
 * ON ORPHANS. A daemon that is SIGKILLed gets no chance to clean up, so its
 * agent children survive with nothing supervising them. That is the failure the
 * sprint-1 gate exists to catch, and it is not hypothetical: a detached
 * `copilot --acp` holding a repo checkout, invisible to every surface, is worse
 * than no daemon at all.
 *
 * Two mechanisms, because one is not enough:
 *   1. Graceful  -- on stop/SIGTERM/exit, kill every child.
 *   2. Forensic  -- child PIDs are written to disk as they are created, so the
 *                   NEXT daemon start reaps whatever the last one abandoned.
 *
 * Mechanism 2 is what makes the guarantee survive kill -9, and it is why the
 * PID file is written before the child is useful rather than after.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const paths = require('./paths');
const config = require('./config');
const { AcpSession, STATUS } = require('./acp-session');

class Daemon extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cfg = config.read();
    this.sessions = new Map();
    this.startedAt = Date.now();
    this.deviceName = this.cfg.deviceName || os.hostname();
    this.agentCommand = opts.agentCommand || process.env.SQUAD_HUB_AGENT || 'copilot';
    this.agentArgs = opts.agentArgs || (process.env.SQUAD_HUB_AGENT_ARGS
      ? process.env.SQUAD_HUB_AGENT_ARGS.split(' ')
      : ['--acp']);
    this.heartbeatMs = (opts.heartbeatSeconds || this.cfg.heartbeatSeconds) * 1000;
    this.beats = 0;
    this.server = null;
    this._timer = null;
    this._seq = 0;
  }

  // -- children on disk -----------------------------------------------------

  _readChildren() {
    try { return JSON.parse(fs.readFileSync(paths.children(), 'utf8')); } catch { return []; }
  }

  _writeChildren(list) {
    paths.ensureHome();
    fs.writeFileSync(paths.children(), JSON.stringify(list, null, 2));
  }

  _trackChild(pid, sessionId) {
    if (!pid) return;
    const list = this._readChildren().filter((c) => c.pid !== pid);
    list.push({ pid, sessionId, daemonPid: process.pid, at: Date.now() });
    this._writeChildren(list);
  }

  _untrackChild(pid) {
    this._writeChildren(this._readChildren().filter((c) => c.pid !== pid));
  }

  /**
   * Kill any child recorded by a daemon that is no longer running.
   * Returns the PIDs actually killed -- the number the gate asserts on.
   */
  reapOrphans() {
    const killed = [];
    const survivors = [];
    for (const c of this._readChildren()) {
      const daemonAlive = c.daemonPid === process.pid || alive(c.daemonPid);
      if (daemonAlive && c.daemonPid !== process.pid) { survivors.push(c); continue; }
      if (c.daemonPid === process.pid) { survivors.push(c); continue; }
      if (alive(c.pid)) {
        try { process.kill(c.pid); killed.push(c.pid); } catch { /* raced */ }
      }
    }
    this._writeChildren(survivors);
    return killed;
  }

  // -- lifecycle ------------------------------------------------------------

  async listen() {
    paths.ensureHome();
    const reaped = this.reapOrphans();
    if (reaped.length) this.log(`reaped ${reaped.length} orphaned agent(s): ${reaped.join(', ')}`);

    const endpoint = paths.ipc();
    if (process.platform !== 'win32') { try { fs.unlinkSync(endpoint); } catch { /* none */ } }

    this.server = net.createServer((sock) => this._onConnection(sock));
    await new Promise((res, rej) => {
      this.server.once('error', rej);
      this.server.listen(endpoint, res);
    });

    this._endpoint = endpoint;
    this._writeState();

    this._timer = setInterval(() => this.beat(), this.heartbeatMs);
    if (this._timer.unref) this._timer.unref();

    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      try { process.on(sig, () => this.shutdown(0)); } catch { /* unsupported */ }
    }
    process.on('exit', () => this._killAllChildren());

    this.log(`daemon listening on ${endpoint} pid=${process.pid} device=${this.deviceName}`);
    return endpoint;
  }

  /**
   * Publish daemon state to disk.
   *
   * The CLI reads this file rather than polling over IPC. That is not a
   * micro-optimisation: polling `hub-status` every 100ms starved the daemon's
   * own outbound connection, turning a 114ms connect into 6 seconds -- so the
   * check reported "not connected" about a connection its own impatience had
   * delayed. An observer that changes what it observes is worse than no
   * observer.
   */
  _writeState() {
    try {
      fs.writeFileSync(paths.state(), JSON.stringify({
        pid: process.pid,
        ipc: this._endpoint,
        startedAt: this.startedAt,
        deviceName: this.deviceName,
        version: require('../package.json').version,
        hub: {
          configured: !!(this.link && this.link.url),
          connected: !!(this.link && this.link.connected),
          url: this.link ? this.link.url : null,
        },
      }, null, 2));
    } catch { /* best effort */ }
  }

  /**
   * One heartbeat tick. Two jobs, and the second is the one people forget:
   * presence is easy, noticing that an agent died under you is not.
   */
  beat() {
    this.beats += 1;
    const transitions = [];
    for (const s of this.sessions.values()) {
      const live = s.status === STATUS.ACTIVE || s.status === STATUS.WAITING_APPROVAL || s.status === STATUS.STARTING;
      if (live && s.isAgentDead()) {
        s.error = s.error || 'agent process disappeared';
        s.endedAt = Date.now();
        s._setStatus(STATUS.FAILED, 'Failed');
        this._untrackChild(s.pid);
        transitions.push(s.id);
        this.log(`heartbeat: session ${s.id} marked failed (agent pid ${s.pid} is gone)`);
      }
      if (!live) this._untrackChild(s.pid);
    }
    this.emit('heartbeat', { beats: this.beats, at: Date.now(), transitions });
    this._persistSessions();
    return transitions;
  }

  _persistSessions() {
    try {
      fs.writeFileSync(paths.sessions(), JSON.stringify(this.snapshot(), null, 2));
    } catch { /* best effort */ }
  }

  _killAllChildren() {
    for (const s of this.sessions.values()) {
      if (s.pid && alive(s.pid)) { try { process.kill(s.pid); } catch { /* gone */ } }
      this._untrackChild(s.pid);
    }
  }

  shutdown(code = 0) {
    if (this._timer) clearInterval(this._timer);
    this._killAllChildren();
    try { this.server && this.server.close(); } catch { /* closing */ }
    try { fs.unlinkSync(paths.state()); } catch { /* gone */ }
    this.log('daemon stopped');
    if (code !== null) process.exit(code);
  }

  log(line) {
    const msg = `${new Date().toISOString()} ${line}\n`;
    try { fs.appendFileSync(paths.log(), msg); } catch { /* best effort */ }
    if (process.env.SQUAD_HUB_DEBUG) process.stderr.write(msg);
  }

  // -- sessions -------------------------------------------------------------

  startSession({ prompt, cwd }) {
    const dir = this._resolveCwd(cwd);
    const id = `s${(++this._seq).toString().padStart(3, '0')}-${Date.now().toString(36)}`;
    const s = new AcpSession({
      id, cwd: dir, prompt,
      agentCommand: this.agentCommand,
      agentArgs: this.agentArgs,
    });
    this.sessions.set(id, s);
    this._trackChild(s.pid, id);

    s.on('status', (e) => { this.emit('session-status', { id, ...e }); this._persistSessions(); });
    s.on('approval', (a) => { this.emit('approval', a); this._persistSessions(); });

    s.run().catch((e) => {
      if (s.status !== STATUS.FAILED && s.status !== STATUS.STOPPED) s._fail(e.message);
    }).finally(() => { this._untrackChild(s.pid); this._persistSessions(); });

    return s;
  }

  /**
   * File access is off by default, and when it is scoped the daemon -- not the
   * service -- enforces the boundary. A caller may not escape the root by
   * asking nicely, or by asking with '..'.
   */
  _resolveCwd(requested) {
    const cfg = config.read();
    if (!requested) return cfg.filesRoot || process.cwd();
    if (!cfg.allowFiles) {
      const e = new Error('file access is off on this device; start the daemon with --allow-files to choose a working directory');
      e.code = 'FILE_ACCESS_OFF';
      throw e;
    }
    const abs = path.resolve(requested);
    if (cfg.allowFilesAll) return abs;
    const root = path.resolve(cfg.filesRoot || process.cwd());
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      const e = new Error(`working directory is outside this device's allowed root`);
      e.code = 'OUTSIDE_ROOT';
      throw e;
    }
    return abs;
  }

  snapshot() {
    const cfg = config.read();
    return {
      device: {
        name: this.deviceName,
        platform: process.platform,
        pid: process.pid,
        startedAt: this.startedAt,
        beats: this.beats,
        ...config.publicView(cfg),
      },
      sessions: [...this.sessions.values()].map((s) => s.toJSON()),
    };
  }

  /**
   * Attach this device to a hub service. Outbound only: the daemon dials out,
   * so nothing has to be opened on a laptop or dev box.
   */
  attachHub({ url, token, deviceId }) {
    const { HubLink } = require('./hub-link');
    this.link = new HubLink({ url, token, deviceId, heartbeatMs: this.heartbeatMs });

    this.link.on('connected', () => {
      this.log('connected to hub');
      this._writeState();
      const snap = this.snapshot();
      this.link.send({
        type: 'register',
        device: { ...snap.device, version: require('../package.json').version },
        sessions: snap.sessions,
      });
    });
    this.link.on('disconnected', () => { this.log('hub connection lost; retrying'); this._writeState(); });
    this.link.on('command', (m) => this._hubCommand(m));

    this.link.startHeartbeat(() => {
      const snap = this.snapshot();
      return { device: snap.device, sessions: snap.sessions };
    });

    // Push state changes immediately, rather than making a human wait for the
    // next heartbeat to learn an agent is blocked on them.
    const push = () => {
      if (!this.link || !this.link.connected) return;
      const snap = this.snapshot();
      this.link.send({ type: 'sessions', sessions: snap.sessions });
    };
    this.on('session-status', push);
    this.on('approval', push);

    return this.link.connect();
  }

  async _hubCommand(m) {
    try {
      let result;
      switch (m.op) {
        case 'spawn': {
          const s = this.startSession({ prompt: m.prompt, cwd: m.cwd });
          result = { id: s.id, pid: s.pid, cwd: s.cwd };
          break;
        }
        case 'approve':
          result = await this.handle({ op: 'approve', sessionId: m.sessionId, approvalId: m.approvalId, optionId: m.optionId });
          break;
        case 'stop':
          result = await this.handle({ op: 'stop-session', sessionId: m.sessionId });
          break;
        case 'transcript':
          result = await this.handle({ op: 'transcript', sessionId: m.sessionId, limit: m.limit });
          break;
        case 'steer':
          result = await this.handle({ op: 'steer', sessionId: m.sessionId, text: m.text });
          break;
        default:
          throw new Error(`unknown command: ${m.op}`);
      }
      this.link.reply(m.correlationId, true, result);
      const snap = this.snapshot();
      this.link.send({ type: 'sessions', sessions: snap.sessions });
    } catch (e) {
      this.link.reply(m.correlationId, false, e.message);
    }
  }

  // -- IPC ------------------------------------------------------------------

  _onConnection(sock) {
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        Promise.resolve(this.handle(req))
          .then((r) => sock.write(JSON.stringify({ id: req.id, ok: true, result: r }) + '\n'))
          .catch((e) => sock.write(JSON.stringify({ id: req.id, ok: false, error: e.message, code: e.code }) + '\n'));
      }
    });
    sock.on('error', () => { /* client vanished */ });
  }

  async handle(req) {
    switch (req.op) {
      case 'ping':
        return { pong: true, pid: process.pid, beats: this.beats };
      case 'hub-status':
        return {
          configured: !!(this.link && this.link.url),
          connected: !!(this.link && this.link.connected),
          url: this.link ? this.link.url : null,
        };
      case 'status':
        return this.snapshot();
      case 'beat':
        return { transitions: this.beat(), beats: this.beats };
      case 'start-session': {
        const s = this.startSession({ prompt: req.prompt, cwd: req.cwd });
        return { id: s.id, pid: s.pid, cwd: s.cwd };
      }
      case 'approve': {
        const s = this.sessions.get(req.sessionId);
        if (!s) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });
        const ok = s.answer(req.approvalId, req.optionId);
        if (!ok) throw Object.assign(new Error('no such pending approval, or unsupported option'), { code: 'NO_APPROVAL' });
        return { answered: true };
      }
      case 'stop-session': {
        const s = this.sessions.get(req.sessionId);
        if (!s) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });
        s.stop();
        this._untrackChild(s.pid);
        return { stopped: true };
      }
      case 'transcript': {
        const s = this.sessions.get(req.sessionId);
        if (!s) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });
        return { transcript: s.transcript.slice(-(req.limit || 100)) };
      }
      case 'steer': {
        const s = this.sessions.get(req.sessionId);
        if (!s) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });
        const ok = s.steer(req.text);
        if (!ok) throw Object.assign(new Error('this session is not accepting input'), { code: 'NOT_STEERABLE' });
        return { sent: true };
      }
      case 'shutdown':
        setTimeout(() => this.shutdown(0), 20);
        return { stopping: true };
      default:
        throw Object.assign(new Error(`unknown op: ${req.op}`), { code: 'UNKNOWN_OP' });
    }
  }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

module.exports = { Daemon, alive };
