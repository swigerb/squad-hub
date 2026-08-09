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
 * orphan gate exists to catch, and it is not hypothetical: a detached
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
const { selectAgent, buildAgentArgs } = require('./agent-select');

/**
 * The statuses a session never comes back from.
 *
 * Named here as well as in the hub's store because the two make the same
 * judgement about the same word from opposite ends of the wire, and a session
 * the device thinks is finished while the hub thinks it is running is the kind
 * of disagreement that ends with someone tidying away live work.
 */
const TERMINAL_STATUS = new Set([STATUS.DONE, STATUS.FAILED, STATUS.STOPPED]);

/**
 * The arguments the agent process is launched with.
 *
 * TWO CHANNELS, because there are two genuinely different needs and conflating
 * them broke the test harness the first time this was written.
 *
 * BASE (`SQUAD_HUB_AGENT_ARGS`) replaces the whole argv. It defaults to
 * `--acp`, the protocol this daemon speaks, and it is replaced rather than
 * appended to because a caller may not be launching Copilot at all -- the test
 * suite points `SQUAD_HUB_AGENT` at node and uses this to name a fake agent
 * script. Prepending `--acp` to that would hand node a flag it does not have.
 *
 * EXTRA (`SQUAD_HUB_AGENT_EXTRA_ARGS_JSON`) is APPENDED, and is where a TOOL
 * POLICY travels. This exists for Squad on ACA, which resolves permissions in
 * one reviewable place and passes them as argv. Its deny patterns legitimately
 * contain spaces:
 *
 *     --deny-tool shell(git config)
 *
 * so the channel is a JSON array rather than a space-separated string. Splitting
 * that on spaces tears it into `shell(git` and `config)`; measured against
 * Copilot CLI 1.0.78 the CLI then refuses to start -- `Invalid rule format:
 * shell(git` -- so a mangled deny rule fails CLOSED rather than silently
 * becoming a weaker one. That is the right failure, and it is still a failure:
 * the session never runs.
 *
 * MALFORMED JSON THROWS. The tempting fallback -- ignore it and launch with the
 * defaults -- would start an agent with NO tool policy at all for a caller who
 * was trying to impose one, which is the most dangerous possible reading of a
 * typo. Refusing to start is the only safe answer.
 */
function resolveAgentArgs() {
  const spaced = process.env.SQUAD_HUB_AGENT_ARGS;
  const base = spaced && spaced.trim() ? spaced.trim().split(/\s+/) : ['--acp'];

  const json = process.env.SQUAD_HUB_AGENT_EXTRA_ARGS_JSON;
  if (!json || !json.trim()) return base;

  let extra;
  try { extra = JSON.parse(json); } catch (e) {
    throw new Error(`SQUAD_HUB_AGENT_EXTRA_ARGS_JSON is not valid JSON (${e.message}). `
      + 'Refusing to start: launching without the arguments you asked for could run an agent '
      + 'with no tool policy at all.');
  }
  if (!Array.isArray(extra) || extra.some((a) => typeof a !== 'string')) {
    throw new Error('SQUAD_HUB_AGENT_EXTRA_ARGS_JSON must be a JSON array of strings, '
      + 'so that a tool policy pattern containing a space survives intact.');
  }
  return [...base, ...extra];
}

class Daemon extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cfg = config.read();
    this.sessions = new Map();
    this.startedAt = Date.now();
    this.deviceName = this.cfg.deviceName || os.hostname();
    this.agentCommand = opts.agentCommand || process.env.SQUAD_HUB_AGENT || 'copilot';
    this.agentArgs = opts.agentArgs || resolveAgentArgs();
    this.heartbeatMs = (opts.heartbeatSeconds || this.cfg.heartbeatSeconds) * 1000;
    // How long an unanswered approval waits before it is cancelled. Long by
    // design: a backstop against a question nobody will ever answer, not a
    // deadline for someone who stepped away. Overridable so a test does not
    // have to wait half an hour to prove it.
    this.approvalTtlMs = Number(opts.approvalTtlMs || process.env.SQUAD_HUB_APPROVAL_TTL_MS || 30 * 60 * 1000);
    this.beats = 0;
    this.server = null;
    this._timer = null;
    this._seq = 0;
    // Set on a hub POLICY refusal (bad/expired/wrong-prefix token) and cleared
    // on a successful connect. `connected: false` alone cannot be told apart
    // from "still trying" -- `squad-hub connect` needs that distinction to
    // report a failure instead of hanging until its timeout says nothing.
    this._hubRefusedReason = null;
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
          refusedReason: this._hubRefusedReason || null,
        },
      }, null, 2));
    } catch { /* best effort */ }
  }

  /**
   * One heartbeat tick. Three jobs, and the second and third are the ones
   * people forget: presence is easy, noticing that an agent died under you is
   * not, and neither is noticing that nobody ever answered.
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
      if (this._expireStaleApprovals(s)) transitions.push(s.id);
    }
    this.emit('heartbeat', { beats: this.beats, at: Date.now(), transitions });
    this._persistSessions();
    return transitions;
  }

  /**
   * Let an approval nobody answered lapse.
   *
   * An approval gate with no approver is a hang: the agent is blocked on a
   * question, the person it was asked of has gone home, and the session sits
   * there consuming a process and a slot in everyone's list for as long as it
   * is left. Cancelling the request lets the agent decide what to do about a
   * refused tool, which is a normal thing for it to handle -- unlike waiting
   * forever, which is not.
   *
   * Deliberately long. This is a backstop against an unanswered question, not
   * a deadline for a person who stepped away from their desk.
   */
  _expireStaleApprovals(s) {
    // A re-adopted session (recovered from disk after a restart) is a record,
    // not a live agent connection: it has no pending approvals and no way to
    // answer one. Guarding rather than assuming matters more here than almost
    // anywhere else -- this runs inside the heartbeat, and an exception here
    // does not fail one session, it stops the loop that watches all of them.
    if (!s || !s.pendingApprovals || typeof s.expire !== 'function') return false;
    const cutoff = Date.now() - this.approvalTtlMs;
    let expired = false;
    for (const a of [...s.pendingApprovals.values()]) {
      if (a.requestedAt > cutoff) continue;
      s.expire(a.approvalId);
      expired = true;
      this.log(`heartbeat: approval ${a.approvalId} on session ${s.id} expired unanswered`);
    }
    return expired;
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

  /**
   * Which custom agent/model this session runs is decided HERE, per session,
   * from the cwd it is actually starting in -- not once at daemon startup.
   * `this.agentArgs` (default `['--acp']`) is the base every session shares;
   * `--agent`/`--model` are appended per selection, so one long-lived daemon
   * can run a Squad project and a plain repo side by side correctly.
   */
  startSession({ prompt, cwd, localCwd, agent, model }) {
    const dir = this._resolveCwd(cwd, localCwd);
    const id = `s${(++this._seq).toString().padStart(3, '0')}-${Date.now().toString(36)}`;
    const selection = selectAgent({ cwd: dir, explicitAgent: agent, explicitModel: model });
    const args = buildAgentArgs(this.agentArgs, selection);
    const s = new AcpSession({
      id, cwd: dir, prompt,
      agentCommand: this.agentCommand,
      agentArgs: args,
    });
    s.agentSelection = selection;
    this.sessions.set(id, s);
    this._trackChild(s.pid, id);

    s.on('status', (e) => { this.emit('session-status', { id, ...e }); this._persistSessions(); });
    s.on('approval', (a) => { this.emit('approval', a); this._persistSessions(); });
    s.on('capabilities', (c) => this._rememberCapabilities(c));

    s.run().catch((e) => {
      if (s.status !== STATUS.FAILED && s.status !== STATUS.STOPPED) s._fail(e.message);
    }).finally(() => { this._untrackChild(s.pid); this._persistSessions(); });

    return s;
  }

  /**
   * Restart a session's agent UNDER THE SAME SESSION ID.
   *
   * What `Sync session` is for. A session whose agent has died or wedged is
   * not recoverable by asking it nicely -- the process on the other end of the
   * pipe is gone. But throwing the session away and starting a new one loses
   * the id, and with it every reference to it: the row someone is watching,
   * the link in a Teams card, the id in somebody's terminal history.
   *
   * So the ENGINE is replaced and the identity is kept. The transcript is
   * carried across too, because it is the record of what happened and none of
   * it stopped being true when the process died.
   *
   * The original prompt is replayed, since an ACP session begins with one and
   * there is nothing else to resume from. That is a real limitation and is
   * stated rather than hidden: this restarts the work, it does not rewind the
   * agent to where it was.
   */
  resyncSession(sessionId) {
    const old = this.sessions.get(sessionId);
    if (!old) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });

    // Anything still pending is answered before the process goes, so the old
    // agent is never left blocked on a question nobody will now answer.
    for (const a of [...old.pendingApprovals.values()]) {
      try { old.expire(a.approvalId); } catch { /* the pipe may already be gone */ }
    }
    try { old.stop(); } catch { /* already gone */ }
    this._untrackChild(old.pid);

    const args = buildAgentArgs(this.agentArgs, old.agentSelection || {});
    const s = new AcpSession({
      id: sessionId,
      cwd: old.cwd,
      prompt: old.prompt,
      agentCommand: this.agentCommand,
      agentArgs: args,
    });
    s.agentSelection = old.agentSelection;
    // The record of what happened survives the process that produced it.
    s.transcript = old.transcript || [];
    s.resyncedAt = Date.now();
    s.resyncCount = (old.resyncCount || 0) + 1;

    this.sessions.set(sessionId, s);
    this._trackChild(s.pid, sessionId);
    s.on('status', (e) => { this.emit('session-status', { id: sessionId, ...e }); this._persistSessions(); });
    s.on('approval', (a) => { this.emit('approval', a); this._persistSessions(); });
    s.on('capabilities', (c) => this._rememberCapabilities(c));
    s.run().catch((e) => {
      if (s.status !== STATUS.FAILED && s.status !== STATUS.STOPPED) s._fail(e.message);
    }).finally(() => { this._untrackChild(s.pid); this._persistSessions(); });

    this._persistSessions();
    return s;
  }

  /**
   * File access is off by default, and when it is scoped the daemon -- not the
   * service -- enforces the boundary. A caller may not escape the root by
   * asking nicely, or by asking with '..'.
   *
   * `localCwd` is a SEPARATE, ungated channel: it is only ever the local CLI's
   * own `process.cwd()`, sent over the local IPC socket by the same account
   * that is typing the command. There is no folder picker and no directory
   * hop involved -- it is exactly "run where I already am", the same trust
   * boundary as running any other local command-line tool from that
   * directory. `requested` (an explicit `--cwd <dir>`, whether from the local
   * CLI or a hub-driven `spawn`) is a genuinely different directory being
   * asked for, and stays behind the `--allow-files` gate as before.
   *
   * NEITHER requested NOR localCwd is exactly the hub-driven `spawn` case
   * with no `cwd` in the request body (the web "+" button lets that field be
   * blank -- and stays blank by design for a `fileAccess: 'off'` device,
   * which never offers a folder picker at all). Falling back to
   * `process.cwd()` here used to mean the DAEMON's own working directory --
   * for the auto-started, detached daemon, whichever project happened to
   * auto-start it, however many days ago. That is never what anyone asked
   * for, and is the actual bug: NOT that a fallback exists, but that it was
   * an ACCIDENT of which directory the daemon happened to be launched from
   * rather than a deliberate, stable choice. The fix is the fallback itself
   * being deliberate: a configured `filesRoot` if there is one, otherwise
   * the user's real home directory -- always the same regardless of which
   * directory launched the daemon, and different in kind from "whatever
   * `process.cwd()` resolves to right now".
   */
  _resolveCwd(requested, localCwd) {
    const cfg = config.read();
    if (requested) {
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
    if (localCwd) return path.resolve(localCwd);
    if (cfg.filesRoot) return path.resolve(cfg.filesRoot);
    return os.homedir();
  }

  /**
   * Answer a `transcript` request either as a plain tail (`limit`, the
   * original behaviour -- used by the hub, which always wants "the last N")
   * or as a cursor read (`since`): every entry with a `seq` greater than the
   * one the caller has already seen.
   *
   * WHY a cursor at all: `AcpSession.transcript` is capped (see
   * `_transcriptCap` on AcpSession) and trimmed from the front as a session
   * runs long. A caller that remembered "I've seen the first 500 entries" by
   * ARRAY INDEX goes silent forever the moment the window first slides --
   * index 500 never exists again. A caller that remembers the highest `seq`
   * it has seen keeps working no matter how many times the window slides,
   * because `seq` is assigned once and never reused.
   *
   * `gap: true` tells an honest caller when its cursor is now behind the
   * oldest entry actually retained -- i.e. some transcript it has not seen
   * was evicted rather than delivered. Silently skipping that is worse than
   * saying so.
   */
  _transcriptSince(s, req) {
    if (!Number.isInteger(req.since)) {
      const list = s.transcript.slice(-(req.limit || 100));
      const nextSince = list.length ? list[list.length - 1].seq : 0;
      return { transcript: list, nextSince, gap: false };
    }
    const since = req.since;
    const list = s.transcript.filter((e) => e.seq > since);
    const oldestRetained = s.transcript.length ? s.transcript[0].seq : null;
    const gap = oldestRetained !== null && since < oldestRetained - 1;
    const nextSince = list.length
      ? list[list.length - 1].seq
      : (s.transcript.length ? s.transcript[s.transcript.length - 1].seq : since);
    return { transcript: list, nextSince, gap };
  }

  /**
   * Forget the RECORD of sessions that have already ended.
   *
   * This is record-keeping, not control. It removes rows from the session
   * list; it does not stop, kill, signal, or touch anything on disk beyond
   * rewriting the same sessions file the heartbeat already rewrites. It must
   * never grow into `stop`: the two live next to each other in the same
   * switch, and the day this one learns to end a session is the day a tidy-up
   * menu becomes a remote kill.
   *
   * WHY IT LIVES ON THE DEVICE. The hub replaces a device's session list
   * wholesale from what the device reports (Store.syncSessions), so a hub-side
   * deletion would come back on the very next heartbeat. Forgetting here means
   * the removal propagates through the mechanism that already exists, rather
   * than needing a second one that fights it.
   *
   * THE GUARD THAT MATTERS is the liveness check, not the status check. A
   * session record is the only handle anything has on its agent process:
   * `_killAllChildren` walks `this.sessions`, and so does the shutdown path.
   * Delete a record whose process is still breathing and that process becomes
   * an orphan holding a repo checkout, invisible to every surface -- which is
   * the precise failure this daemon's reaper, its children file and a good
   * part of its test suite exist to prevent. So a session is forgotten only if
   * it is terminal, HAS an end time, and its pid is provably gone.
   *
   * @param {object}  opts
   * @param {number}  [opts.olderThanMs]  only forget sessions that ended at
   *                                      least this long ago. Omitted means
   *                                      every ended session.
   * @param {string}  [opts.forgottenBy]  who asked, for the log.
   * @returns {{forgotten: string[], kept: number, count: number}}
   */
  forgetSessions({ olderThanMs, forgottenBy } = {}) {
    const now = Date.now();
    // A negative or non-finite window would silently become "everything".
    // Refusing is better than guessing at what someone meant.
    const window = olderThanMs == null ? null : Number(olderThanMs);
    if (window !== null && (!Number.isFinite(window) || window < 0)) {
      throw Object.assign(new Error('olderThanMs must be a non-negative number of milliseconds'), { code: 'BAD_WINDOW' });
    }
    const cutoff = window === null ? null : now - window;

    const forgotten = [];
    let kept = 0;
    for (const [id, s] of this.sessions) {
      if (!TERMINAL_STATUS.has(s.status)) { kept += 1; continue; }
      // A terminal status with no end time has not finished being written
      // down. Waiting one heartbeat costs nothing.
      if (!s.endedAt) { kept += 1; continue; }
      if (cutoff !== null && s.endedAt > cutoff) { kept += 1; continue; }
      // The orphan guard. Belt and braces: a terminal session should already
      // have been untracked, so this should never fire -- and the day it does
      // is exactly the day it earns its place.
      if (s.pid && alive(s.pid)) {
        this.log(`forget: refusing to forget session ${id}; its agent (pid ${s.pid}) is still alive`);
        kept += 1;
        continue;
      }
      this.sessions.delete(id);
      this._untrackChild(s.pid);
      forgotten.push(id);
    }

    if (forgotten.length) {
      this._persistSessions();
      // Republish immediately rather than waiting for the next beat, so the
      // hub's copy is corrected by the same wholesale sync it always uses.
      if (this.link && this.link.connected) {
        try { this.link.send({ type: 'sessions', sessions: this.snapshot().sessions }); }
        catch { /* the next heartbeat carries it */ }
      }
      const who = forgottenBy ? ` at the request of ${forgottenBy}` : '';
      this.log(`forget: removed ${forgotten.length} ended session(s)${who}`);
    }
    return { forgotten, kept, count: forgotten.length };
  }

  /**
   * Remember what an agent said it can do, from a session that really started.
   *
   * MODELS EXIST NOWHERE ELSE. Agents can be probed by running the CLI once,
   * but the model list is advertised only at `session/new` -- so until a
   * session has run, an honest device cannot offer one, and the New session
   * dialog can only ask someone to type a name blind.
   *
   * Kept in the config file rather than in memory, because a restart would
   * otherwise take the list away and put the free-text box back until the next
   * session happened to run. Cheap: two short arrays.
   *
   * The agent list from a live session is better evidence than the CLI probe
   * -- it is what THIS agent offered for THIS project -- so it wins where both
   * exist.
   */
  _rememberCapabilities(cap) {
    if (!cap) return;
    const models = Array.isArray(cap.models) ? cap.models : [];
    const agents = Array.isArray(cap.agents) ? cap.agents : [];
    if (!models.length && !agents.length) return;

    const cfg = config.read();
    const prior = cfg.knownCapabilities || {};
    const next = {
      agents: agents.length ? agents : (prior.agents || []),
      models: models.length ? models : (prior.models || []),
    };
    // Only write when something actually changed. This runs on every session
    // start, and rewriting an identical file each time would churn the config
    // and invalidate its cache for nothing.
    if (JSON.stringify(prior) === JSON.stringify(next)) return;
    try { config.update({ knownCapabilities: next }); } catch { /* a cache is not worth failing a session over */ }
  }

  /**
   * Which agents this device's CLI will accept, probed ONCE and remembered.
   *
   * The hub cannot know this: it holds no Copilot install and never runs one.
   * Without it the New session dialog can only offer a free-text box, so
   * someone starting work has to already know what to type -- and a typo is
   * only discovered when the session comes back reporting a different agent
   * than the one they asked for.
   *
   * Probed lazily and cached, because it costs a process spawn. A device that
   * cannot answer reports nothing at all rather than an empty list: "I could
   * not tell" and "there are none" call for opposite things in the UI, and
   * only one of them should hide the picker.
   */
  _knownAgents() {
    if (this._agentsProbed) return this._agentsCache;
    this._agentsProbed = true;
    try {
      const r = require('./doctor').availableAgents();
      this._agentsCache = r && r.ok && r.agents.length ? r.agents : null;
    } catch { this._agentsCache = null; }
    return this._agentsCache;
  }

  snapshot() {
    const cfg = config.read();
    // What a live session advertised beats what the CLI probe guessed: it is
    // what this agent offered for real work, not what a refusal message listed.
    const known = cfg.knownCapabilities || {};
    const agents = (known.agents && known.agents.length) ? known.agents : this._knownAgents();
    const models = (known.models && known.models.length) ? known.models : null;
    return {
      device: {
        name: this.deviceName,
        platform: process.platform,
        kind: cfg.deviceKind || 'local',
        pid: process.pid,
        startedAt: this.startedAt,
        beats: this.beats,
        agents,
        models,
        ...config.publicView(cfg),
        // Absent, not zeroed, when telemetry is off. A roster can then tell
        // "this device does not report load" from "this device is idle" --
        // which are very different things to show on a meter.
        telemetrySample: cfg.reportTelemetry ? this._telemetry().sample() : null,
      },
      sessions: [...this.sessions.values()].map((s) => s.toJSON()),
    };
  }

  /**
   * The CPU sampler, created on first use.
   *
   * It has to be long-lived: CPU usage is a delta between two readings, so a
   * fresh sampler on every snapshot would have no previous reading and could
   * never report anything.
   */
  _telemetry() {
    if (!this._telemetrySampler) {
      const { Telemetry } = require('./telemetry');
      this._telemetrySampler = new Telemetry();
    }
    return this._telemetrySampler;
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
      this._hubRefusedReason = null;
      this._writeState();
      const snap = this.snapshot();
      this.link.send({
        type: 'register',
        device: { ...snap.device, version: require('../package.json').version },
        sessions: snap.sessions,
      });
    });
    this.link.on('disconnected', () => { this.log('hub connection lost; retrying'); this._writeState(); });
    // A refusal is not a disconnection. Retrying would never succeed and would
    // bury the one line that says what to fix.
    this.link.on('refused', (why) => {
      this.log(`the hub refused this device: ${why}`);
      this._hubRefusedReason = why || 'the hub refused this device';
      this._writeState();
      this.emit('hub-refused', why);
    });
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
          const s = this.startSession({ prompt: m.prompt, cwd: m.cwd, agent: m.agent, model: m.model });
          result = { id: s.id, pid: s.pid, cwd: s.cwd, agentSelection: s.agentSelection };
          break;
        }
        case 'approve':
          result = await this.handle({ op: 'approve', sessionId: m.sessionId, approvalId: m.approvalId, optionId: m.optionId, answeredBy: m.answeredBy });
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
        case 'control-check':
          result = await this.handle({ op: 'control-check', sessionId: m.sessionId });
          break;
        case 'resync':
          result = await this.handle({ op: 'resync', sessionId: m.sessionId });
          break;
        case 'forget':
          // Record-keeping, not control: it removes rows for sessions that
          // have already ended. Who asked travels with it, from the hub's
          // validated identity, so the device's own log can say who tidied up.
          result = await this.handle({ op: 'forget', olderThanMs: m.olderThanMs, forgottenBy: m.forgottenBy });
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
          refusedReason: this._hubRefusedReason || null,
        };
      case 'status':
        return this.snapshot();
      case 'control-check': {
        /**
         * Can this device take a control command for this session, right now?
         *
         * Answered by the DEVICE, not by the hub, and that is the entire
         * point. The hub knowing about a session proves only that a heartbeat
         * once mentioned it -- the hub is a cache. Whether the agent process
         * is still alive and still accepting input is a fact only the machine
         * running it holds, and enabling a composer on anything less is the
         * same class of bug as reporting "connected" on an HTTP 101 before the
         * hub had registered the device.
         *
         * Never throws for an unknown session: "no, and here is why" is a
         * useful answer, and an exception here would be indistinguishable
         * from the transport failing.
         */
        const s = this.sessions.get(req.sessionId);
        if (!s) return { controllable: false, sessionId: req.sessionId, reason: 'no such session on this device' };
        if (s.isAgentDead()) {
          return { controllable: false, sessionId: s.id, status: s.status, reason: 'the agent process is gone' };
        }
        const terminal = ['done', 'failed', 'stopped'];
        if (terminal.includes(s.status)) {
          return { controllable: false, sessionId: s.id, status: s.status, reason: `the session is ${s.status}` };
        }
        return { controllable: true, sessionId: s.id, status: s.status, pid: s.pid };
      }
      case 'resync': {
        const s = this.resyncSession(req.sessionId);
        return { id: s.id, pid: s.pid, cwd: s.cwd, resyncCount: s.resyncCount };
      }
      case 'beat':
        return { transitions: this.beat(), beats: this.beats };
      case 'start-session': {
        // Reached only over the local IPC socket (see client.js) -- so
        // `req.localCwd`, when present, is trusted as the caller's own
        // directory, never a remotely-requested one.
        const s = this.startSession({ prompt: req.prompt, cwd: req.cwd, localCwd: req.localCwd, agent: req.agent, model: req.model });
        return { id: s.id, pid: s.pid, cwd: s.cwd, agentSelection: s.agentSelection };
      }
      case 'approve': {
        const s = this.sessions.get(req.sessionId);
        if (!s) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });
        const ok = s.answer(req.approvalId, req.optionId, req.answeredBy);
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
        return this._transcriptSince(s, req);
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
      case 'forget':
        return this.forgetSessions({ olderThanMs: req.olderThanMs, forgottenBy: req.forgottenBy });
      default:
        throw Object.assign(new Error(`unknown op: ${req.op}`), { code: 'UNKNOWN_OP' });
    }
  }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

module.exports = { Daemon, alive, resolveAgentArgs };
