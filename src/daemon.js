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
const { resolveSquadDoc, listSquadDocs, readFileSafe } = require('./squad-context');

/**
 * The most of a Squad document that is ever returned.
 *
 * Matches the cap `readFileSafe` already applies elsewhere. A viewer that can
 * be asked for an unbounded read is a file transfer with a friendly name.
 */
const SQUAD_DOC_LIMIT = 256 * 1024;

/** A promise-based wait, used only by the (bounded, watched-only) steer hold.
 * NOT unref'd, matching `requestApproval`'s timer -- the process must stay
 * alive for as long as somebody is waiting on this promise to settle. */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

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

    /**
     * How long a WATCHED session's tool call waits for an answer.
     *
     * Much shorter than `approvalTtlMs`, and for a different reason: an agent
     * is blocked in somebody's terminal for the whole of it. It must also stay
     * comfortably under the `timeoutSec` in the installed hook file, because if
     * COPILOT gives up first the hook produces no output -- and no output falls
     * through to the session's normal permission handling, which in a session
     * started with --allow-all-tools means the tool simply runs. Answering
     * 'ask' before that can happen is what keeps a hub outage from becoming
     * permission.
     */
    this.hookApprovalTimeoutMs = Number(
      opts.hookApprovalTimeoutMs || process.env.SQUAD_HUB_HOOK_APPROVAL_TIMEOUT_MS || 120 * 1000,
    );

    /**
     * `agentStop`'s hold, paid ONLY on a session someone was recently
     * confirmed to be watching -- see `_handleAgentStop` and
     * `TuiSession.isWatched()`. Measured (see the PR this shipped in): a flat
     * hold on every turn end is a tax charged to sessions nobody is steering,
     * which is the regression the owner's review named. Short by design: this
     * is the window that turns "the steer arrived after the turn ended" into
     * "the steer arrived during the wait", not a general-purpose delay.
     */
    this.steerHoldMs = Number(opts.steerHoldMs || process.env.SQUAD_HUB_STEER_HOLD_MS || 3000);
    this.steerPollMs = Number(opts.steerPollMs || process.env.SQUAD_HUB_STEER_POLL_MS || 200);
    /** How recent a `control-check` has to be to count as "being watched". */
    this.steerWatchWindowMs = Number(
      opts.steerWatchWindowMs || process.env.SQUAD_HUB_STEER_WATCH_WINDOW_MS || 30 * 1000,
    );
    /**
     * The runaway guard. Copilot's OWN guard gives up after 8 consecutive
     * forced turns; this must self-limit BELOW that, so the product's own
     * ceiling is what a person sees, never the CLI's. Clamped rather than
     * merely defaulted -- an operator setting this above 7 is one deploy away
     * from re-creating exactly the runaway the CLI's own guard exists to stop.
     */
    this.steerMaxForcedTurns = Math.min(
      7,
      Number(opts.steerMaxForcedTurns || process.env.SQUAD_HUB_STEER_MAX_FORCED_TURNS || 7) || 7,
    );

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
      // ONE SESSION MAY NOT TAKE DOWN THE DEVICE.
      //
      // This loop runs inside a setInterval, so anything thrown here is an
      // uncaught exception and the daemon exits -- taking every other session,
      // the hub connection, and the device itself with it. That happened: a
      // session type that did not implement `isAgentDead()` killed a daemon
      // that was otherwise perfectly healthy, and the symptom appeared as a
      // device going offline for no visible reason.
      //
      // Caught per session rather than around the loop, so one bad session
      // does not stop the others from being swept either.
      try {
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
      } catch (e) {
        // Logged loudly. A session the heartbeat cannot sweep is a real defect
        // -- it just is not one worth losing the device over.
        this.log(`heartbeat: session ${s.id} could not be swept: ${e && e.message}`);
      }
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
  startSession({
    prompt, cwd, localCwd, agent, model, mode,
  }) {
    const dir = this._resolveCwd(cwd, localCwd);
    const id = `s${(++this._seq).toString().padStart(3, '0')}-${Date.now().toString(36)}`;
    const selection = selectAgent({
      cwd: dir, explicitAgent: agent, explicitModel: model, explicitMode: mode,
    });
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
   * Register a Copilot TUI session that told us about itself through a hook.
   *
   * The opposite direction from `startSession`: the daemon did not spawn this
   * process and cannot drive it. It exists so a session a person started in
   * their own terminal is still VISIBLE -- in `status`, and in the web Hub --
   * rather than being work nobody else can see.
   *
   * Keyed by the id Copilot reports, so a repeated `sessionStart` (a resume, or
   * a hook that ran twice) updates the session already known instead of
   * accumulating duplicates for one terminal.
   */
  registerTuiSession({ copilotId, cwd, source = 'new' }) {
    if (!copilotId) throw Object.assign(new Error('a session id is required'), { code: 'NO_SESSION_ID' });

    const existing = this.tuiSessionByCopilotId(copilotId);
    if (existing) {
      existing.touch('Resumed in a terminal');
      this._persistSessions();
      return existing;
    }

    const { TuiSession } = require('./tui-session');
    const id = `t${(++this._seq).toString().padStart(3, '0')}-${Date.now().toString(36)}`;
    const s = new TuiSession({
      id, copilotId, cwd: cwd || null, source,
    });
    this.sessions.set(id, s);
    this.emit('session-status', { id, status: s.status });
    this._persistSessions();
    return s;
  }

  /** Find a registered TUI session by the id Copilot uses for it. */
  tuiSessionByCopilotId(copilotId) {
    if (!copilotId) return null;
    return [...this.sessions.values()].find((s) => s.copilotId === copilotId) || null;
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
    const modes = Array.isArray(cap.modes) ? cap.modes : [];
    if (!models.length && !agents.length && !modes.length) return;

    const cfg = config.read();
    const prior = cfg.knownCapabilities || {};
    const next = {
      agents: agents.length ? agents : (prior.agents || []),
      models: models.length ? models : (prior.models || []),
      modes: modes.length ? modes : (prior.modes || []),
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
    // Modes have no probe. Unlike agents, there is no CLI invocation that lists
    // them, so until a session has run once this device genuinely does not know
    // -- and `null` says that, where an empty array would claim the agent
    // offers none.
    const modes = (known.modes && known.modes.length) ? known.modes : null;
    return {
      /**
       * Whether this daemon is actually attached to its hub.
       *
       * Included because a daemon that cannot attach looks completely healthy
       * from here: it keeps running, keeps heartbeating locally, and keeps
       * accepting local commands. An expired device token therefore presented
       * as "everything is fine" on the device and "no devices" on the hub, with
       * nothing anywhere connecting the two.
       */
      hub: {
        configured: !!(this.link && this.link.url),
        connected: !!(this.link && this.link.connected),
        url: this.link ? this.link.url : null,
        refusedReason: this._hubRefusedReason || null,
      },
      device: {
        name: this.deviceName,
        platform: process.platform,
        kind: cfg.deviceKind || 'local',
        pid: process.pid,
        startedAt: this.startedAt,
        beats: this.beats,
        agents,
        models,
        modes,
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
          const s = this.startSession({
            prompt: m.prompt, cwd: m.cwd, agent: m.agent, model: m.model, mode: m.mode,
          });
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
        case 'squad-doc':
          // Rebuilt field by field like every other op here, and deliberately
          // so: only `sessionId` and `doc` are read, so a `cwd` or a `path` in
          // the message has no route to the resolver. The directory comes from
          // the session record on this device.
          result = await this.handle({ op: 'squad-doc', sessionId: m.sessionId, doc: m.doc });
          break;
        case 'squad-docs':
          result = await this.handle({ op: 'squad-docs', sessionId: m.sessionId });
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
        // `idle` is deliberately absent: the agent finished a turn and is
        // waiting for a reply, which is exactly when a composer should work.
        const terminal = ['done', 'failed', 'stopped'];
        if (terminal.includes(s.status)) {
          return { controllable: false, sessionId: s.id, status: s.status, reason: `the session is ${s.status}` };
        }
        // A confirmed "somebody is looking at this session right now" signal
        // -- the composer calls this when its detail panel opens. Used only
        // to decide whether `agentStop` may hold briefly for a steer that has
        // not arrived yet (see `_handleAgentStop`); it is never a promise of
        // continuous watching, only the most recent proof the hub has.
        if (typeof s.markWatched === 'function') s.markWatched();
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
        const s = this.startSession({
          prompt: req.prompt, cwd: req.cwd, localCwd: req.localCwd, agent: req.agent, model: req.model, mode: req.mode,
        });
        return { id: s.id, pid: s.pid, cwd: s.cwd, agentSelection: s.agentSelection };
      }
      case 'approve': {
        const s = this.sessions.get(req.sessionId);
        if (!s) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });
        const ok = s.answer(req.approvalId, req.optionId, req.answeredBy);
        if (!ok) throw Object.assign(new Error('no such pending approval, or unsupported option'), { code: 'NO_APPROVAL' });
        return { answered: true };
      }
      case 'hook-session-start': {
        // Reached only over the local IPC socket, from the `squad-hub hook`
        // shim that Copilot ran. `cwd` is the terminal's own directory and is
        // recorded as reported: it is a fact about a session we do not own, not
        // a path we are about to read from.
        const s = this.registerTuiSession({
          copilotId: req.sessionId, cwd: req.cwd, source: req.source,
        });
        return { id: s.id, registered: true };
      }
      case 'hook-session-end': {
        const s = this.tuiSessionByCopilotId(req.sessionId);
        // Not an error. A session that ends without ever having registered --
        // because the hook was installed mid-session, say -- is a thing that
        // simply happened, and failing here would put a scary message in
        // somebody's terminal at the moment they quit.
        if (!s) return { id: null, ended: false };
        s.end(req.reason || 'complete');
        this.emit('session-status', { id: s.id, status: s.status });
        this._persistSessions();
        return { id: s.id, ended: true };
      }
      case 'hook-approval': {
        // A tool is about to run in a terminal, and the agent is BLOCKED until
        // this returns. Everything here is written so the answer is never
        // 'allow' by accident: an unknown session, an ended one, or nobody
        // answering all resolve to 'ask', which puts the decision back at the
        // keyboard rather than letting it default to permission.
        const s = this.tuiSessionByCopilotId(req.sessionId);
        // `supervised: false` is not the same as "denied". It means the hub is
        // not watching this session at all, and the caller should get out of
        // the way rather than interpose a prompt on a session nobody agreed to
        // supervise. See hooks.js for why that distinction matters.
        if (!s || s.ended) {
          return { decision: 'ask', supervised: false, reason: 'this session is not registered with the hub' };
        }

        const approvalId = `a${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const approval = {
          id: approvalId, sessionId: s.id, toolName: req.toolName || null, detail: req.toolArgs || null,
        };
        this.emit('approval', approval);
        this._persistSessions();

        const decision = await s.requestApproval({
          approvalId,
          toolName: req.toolName,
          toolArgs: req.toolArgs,
          timeoutMs: Number(req.timeoutMs) || this.hookApprovalTimeoutMs,
        });
        this.emit('session-status', { id: s.id, status: s.status });
        this._persistSessions();
        return {
          decision,
          sessionId: s.id,
          supervised: true,
          // "Nobody answered" and "the hub was unreachable" are different
          // facts, and the person staring at their terminal is entitled to
          // know which one just happened to them.
          reason: decision === 'ask'
            ? 'nobody answered in Squad Hub in time, so this decision stays here'
            : null,
        };
      }
      case 'hook-event': {
        // What a watched session is DOING. Every one of these is
        // fire-and-forget: an unregistered session is reported back as such
        // rather than thrown, because the caller is a hook running inside
        // somebody's terminal and an error there costs them, not us.
        //
        // `agentStop` is deliberately NOT one of these any more -- it is
        // carved out into its own op, `hook-agent-stop`, because it is the
        // one event whose answer can force another turn (see
        // `_handleAgentStop`). `noteIdle()` moved with it rather than being
        // dropped; see the ceremony log (D-130-3) for why that distinction
        // mattered enough to write down.
        const s = this.tuiSessionByCopilotId(req.sessionId);
        if (!s || s.ended) return { id: s ? s.id : null, noted: false };

        switch (req.event) {
          case 'userPromptSubmitted': s.notePrompt(req.prompt); break;
          case 'postToolUse': s.noteTool(req.toolName); break;
          default: s.touch(); break;
        }
        this.emit('session-status', { id: s.id, status: s.status });
        this._persistSessions();
        return { id: s.id, noted: true };
      }
      /**
       * `agentStop` fires when a watched session's turn ends. Copilot BLOCKS
       * the session for as long as this takes, and returning
       * `{ decision: "block", reason }` forces another turn using `reason` as
       * the prompt -- measured against Copilot CLI 1.0.80 (see the Sprint 1
       * findings on #130). That is the entire mechanism steering rests on.
       *
       * The hold below is the answer to the question Sprint 1 raised but did
       * not have an environment to measure: is a steer that arrives AFTER a
       * turn has already ended ever delivered? Yes, if this hook waits for it
       * -- so it waits, but ONLY on a session recently confirmed to be
       * watched (`TuiSession.isWatched`), never as a flat tax on every turn
       * end. A plain session nobody is steering pays for exactly one local
       * IPC round trip and nothing else.
       */
      case 'hook-agent-stop':
        return this._handleAgentStop(req);
      case 'stop-session': {
        const s = this.sessions.get(req.sessionId);
        if (!s) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });
        const r = normaliseControl(s.stop());
        if (!r.ok) {
          throw Object.assign(new Error(r.reason || 'this session cannot be stopped from here'), { code: 'NOT_STOPPABLE' });
        }
        this._untrackChild(s.pid);
        return { stopped: true };
      }
      case 'transcript': {
        const s = this.sessions.get(req.sessionId);
        if (!s) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });
        return this._transcriptSince(s, req);
      }
      /**
       * Read one Squad governance document for a session this daemon owns.
       *
       * THE CALLER NAMES A DOCUMENT; THE DEVICE DECIDES WHAT THAT MEANS. The
       * directory is taken from the session record -- never from the request --
       * so no field a caller can set has any influence on which file is read.
       * `resolveSquadDoc` then refuses anything outside `.squad/`, and a member
       * name is matched against the team the workspace declares rather than
       * used as a path segment.
       *
       * Together those two rules are what keep this a viewer for a workspace
       * already visible in the hub, rather than a remote file-read primitive.
       */
      case 'squad-doc': {
        const s = this.sessions.get(req.sessionId);
        if (!s) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });
        const r = resolveSquadDoc(s.cwd, req.doc);
        if (r.error) throw Object.assign(new Error(r.error), { code: 'NO_DOC' });

        let bytes = 0;
        try { bytes = fs.statSync(r.path).size; } catch {
          throw Object.assign(new Error(`no ${req.doc} in this workspace`), { code: 'NO_DOC' });
        }
        const text = readFileSafe(r.path);
        if (text === null) throw Object.assign(new Error(`no ${req.doc} in this workspace`), { code: 'NO_DOC' });
        // Truncation is REPORTED, not silent. A charter cut off mid-sentence
        // with nothing saying so reads as a broken document rather than a
        // long one.
        return { doc: r.doc, text, bytes, truncated: bytes > SQUAD_DOC_LIMIT };
      }
      case 'squad-docs': {
        const s = this.sessions.get(req.sessionId);
        if (!s) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });
        return { docs: listSquadDocs(s.cwd) };
      }
      case 'steer': {
        const s = this.sessions.get(req.sessionId);
        if (!s) throw Object.assign(new Error('no such session'), { code: 'NO_SESSION' });
        const r = normaliseControl(s.steer(req.text));
        if (!r.ok) {
          throw Object.assign(new Error(r.reason || 'this session is not accepting input'), { code: 'NOT_STEERABLE' });
        }
        this.emit('session-status', { id: s.id, status: s.status });
        this._persistSessions();
        // `queued` never becomes `sent` here. `AcpSession.steer()` owns the
        // process and has already written the prompt over ACP by the time
        // this resolves -- `sent` is true. `TuiSession.steer()` only ever
        // enqueues; `sent` would be exactly the bug this sprint exists to fix
        // (D-130-10, the `{sent:true}` bug in better wording) until an
        // `agentStop` hook actually pops this entry -- see
        // `_handleAgentStop`.
        return r.queued ? { queued: true, position: r.position } : { sent: true };
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

  /**
   * `agentStop` fired. Decide, in one place, whether to force another turn.
   *
   * SESSION ISOLATION. `req.sessionId` is Copilot's own session id, and
   * `tuiSessionByCopilotId` is a strict lookup against sessions THIS daemon
   * registered through `sessionStart` -- there is no path from a payload to a
   * queue entry that did not go through that registration first. `req.cwd` is
   * checked against the cwd recorded at registration as a second, independent
   * signal: a payload whose cwd does not match the session it claims to be
   * cannot dequeue anything, so a sessionId collision or a tampered payload
   * gains nothing.
   *
   * FAIL TOWARD THE HUMAN. Any failure to obtain a steer ends the turn --
   * this method returns `{ decision: null }` in every case where forcing
   * another turn is not clearly correct, and the CALLER (`cmdHook`) turns
   * `decision: null` into no stdout at all, exactly as an unreachable daemon
   * would. Ending a turn is not a grant.
   */
  async _handleAgentStop(req) {
    const s = this.tuiSessionByCopilotId(req.sessionId);
    if (!s || s.ended) return { decision: null };
    if (s.cwd && req.cwd && s.cwd !== req.cwd) {
      // The payload claims a session this daemon knows, but not the directory
      // it was registered from. Treat it exactly like an unknown session --
      // note nothing, dequeue nothing.
      return { decision: null, mismatch: true };
    }

    s.noteIdle();
    this.emit('session-status', { id: s.id, status: s.status });

    // The runaway guard resets on an ordinary boundary: an agentStop that was
    // NOT itself a continuation this daemon forced. `stop_hook_active` is
    // Copilot's own signal for "this turn was already forced once" -- see the
    // Sprint 1 findings on #130. Without this reset, one long-forced chain
    // that legitimately ended would leave the counter primed against the
    // NEXT, unrelated chain.
    if (!req.stop_hook_active) s.consecutiveForcedTurns = 0;

    // The cheap check the review asked for, before paying for a wait: only a
    // session recently confirmed watched gets a hold at all. Everyone else is
    // answered as fast as `hasQueuedSteer()` resolves -- one queue read, no
    // sleep.
    const watched = s.isWatched(this.steerWatchWindowMs);
    const deadline = Date.now() + (watched ? this.steerHoldMs : 0);

    for (;;) {
      if (s.hasQueuedSteer()) {
        if (s.consecutiveForcedTurns >= this.steerMaxForcedTurns) {
          // The guard bites BELOW Copilot's own 8-block ceiling. This is an
          // observable failure, not a silent stall: the session says why it
          // stopped forcing turns, and how much is still queued.
          s.steerGuardTripped = true;
          s.touch(`steer paused: the runaway guard (max ${this.steerMaxForcedTurns}) was reached; `
            + `${s.steerQueue.length} message(s) still queued`);
          this.emit('session-status', { id: s.id, status: s.status });
          this._persistSessions();
          return { decision: null, guardTripped: true, queueLength: s.steerQueue.length };
        }
        const item = s.popSteer();
        if (!item) break; // expired between hasQueuedSteer() and here -- fall through and end the turn
        s.consecutiveForcedTurns += 1;
        s.steerGuardTripped = false;
        s.touch(`Steering: ${item.text.slice(0, 60)}`);
        this.emit('session-status', { id: s.id, status: s.status });
        this._persistSessions();
        return { decision: 'block', reason: item.text };
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(this.steerPollMs, deadline - Date.now()));
    }

    this._persistSessions();
    return { decision: null };
  }
}

/**
 * Read a control result, whichever shape the session type answers in.
 *
 * `AcpSession.steer()` returns a boolean. `TuiSession.steer()` returns
 * `{ ok: false, reason }` so the UI can say WHY -- and an object is truthy, so
 * `if (!ok)` read that refusal as success. Steering a watched session answered
 * `{ sent: true }` and sent nothing; stopping one answered `{ stopped: true }`
 * and stopped nothing.
 *
 * That is the same defect as the heartbeat crash, in a politer costume: a
 * session type was added to a collection whose contract it did not quite meet,
 * and the collection did not notice. A button that lies is worse than an absent
 * one, and this made every button lie for exactly the sessions that cannot
 * honour them.
 *
 * Normalised in one place so a third session type cannot reintroduce it by
 * picking either shape.
 */
function normaliseControl(result) {
  if (result && typeof result === 'object') {
    // Spread first, then force `ok`/`reason` to the normalised shape: a
    // steer's `queued`/`position` ride along so callers can tell an
    // acceptance from an actual send, without every OTHER control result
    // needing to know those keys exist.
    return { ...result, ok: !!result.ok, reason: result.reason || null };
  }
  // A bare `undefined` from a void method (AcpSession.stop) means "done".
  if (result === undefined) return { ok: true, reason: null };
  return { ok: !!result, reason: null };
}

function alive(pid) {  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

module.exports = { Daemon, alive, resolveAgentArgs, normaliseControl };
