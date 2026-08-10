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
  /**
   * The agent finished its turn and is waiting for you.
   *
   * NOT the same as DONE, and the difference is the whole point. ACP is a
   * conversational protocol: `session/prompt` returning means THIS TURN ended,
   * not that the conversation is over. The agent is alive and will answer a
   * reply.
   *
   * This used to be reported as DONE with the process killed, so an agent that
   * ended its turn by asking a question -- "4. Is that correct?" -- left a
   * composer that looked usable and refused every message, because there was
   * nothing on the other end any more.
   */
  IDLE: 'idle',
  DONE: 'done',
  FAILED: 'failed',
  STOPPED: 'stopped',
});

/**
 * How long an idle session stays alive before it is reaped.
 *
 * A conversation you can return to is the point, but a process that lives
 * forever because somebody closed a tab is a leak with a memory cost. Half an
 * hour is long enough to make a cup of tea and come back, short enough that a
 * forgotten session does not outlive the working day.
 */
const IDLE_TIMEOUT_MS = Number(process.env.SQUAD_HUB_IDLE_MS || 30 * 60 * 1000);


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
    // Approvals that lapsed unanswered. Kept so the UI can say what became of
    // a card someone saw, rather than letting the request vanish.
    this.expiredApprovals = [];
    // Approvals that were answered, and by whom. Kept for the same reason, and
    // because on a shared hub "who decided this" is the useful fact.
    this.answeredApprovals = [];
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
      readOnly: isReadOnlyRequest(tc, raw),
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
    /**
     * A streaming update describes what the agent is DOING. It must not
     * overwrite the activity line of a session that is not doing anything.
     *
     * Only a session that is genuinely running gets its activity from here.
     * Written as "is it running" rather than "is it not waiting", so a state
     * added later is excluded by default rather than included by omission --
     * which is exactly how an idle session ended up reading "Running <tool>".
     *
     * A trailing update can arrive just after a turn ends, and relabelling an
     * idle session as busy tells the watcher the agent is still working when it
     * is in fact waiting for them. Observed live on two sessions.
     */
    const running = this.status === STATUS.ACTIVE || this.status === STATUS.STARTING;
    if (u.sessionUpdate === 'tool_call') {
      this.toolCallCount += 1;
      if (running) {
        this.activity = u.title ? `Running ${u.title}` : 'Running a tool...';
      }
    } else if (u.sessionUpdate === 'agent_message_chunk' && running) {
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

    // THE AGENT AND MODEL ARE CHOSEN HERE, NOT ON THE COMMAND LINE.
    //
    // `copilot --acp` accepts `--agent` and `--model` and silently ignores
    // both. Not "rejects": accepts, with no error and no stderr, and then runs
    // the default agent anyway. In `-p` mode the same flags are validated and
    // an unknown value exits 1, which is what made this so easy to believe was
    // working -- and it was not. Every session ran as plain Copilot while the
    // UI reported the agent it had asked for.
    //
    // The supported path is `session/new`'s own reply, which advertises the
    // agents and models this build actually has, and `session/set_config_option`
    // / `session/set_model` to choose between them.
    //
    // Discovery matters more than the fix. The valid values come from the live
    // response rather than from anything hardcoded here, so a custom agent that
    // renames itself is matched on whatever it now calls itself, and one that
    // disappears is REPORTED rather than silently swapped for the default.
    await this._applySelection(s);

    this._setStatus(STATUS.ACTIVE, 'Processing...');

    const stop = await this._request('session/prompt', {
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text: this.prompt }],
    });
    this.stopReason = stop && stop.stopReason;
    /**
     * The turn ended. The CONVERSATION has not.
     *
     * Previously this marked the session DONE and killed the agent, which threw
     * away the thing ACP exists for. An agent that ends its turn with a
     * question left a session that displayed "Ready for review", offered a
     * composer, and refused everything typed into it.
     *
     * So the session goes idle with the agent still running, and a reply picks
     * the conversation straight back up. It is reaped after
     * SQUAD_HUB_IDLE_MS if nobody comes back.
     */
    this._goIdle();
    return stop;
  }

  /**
   * Finish a turn without ending the session.
   *
   * Separate from `run()` because `steer()` needs exactly the same thing when
   * ITS turn completes -- a second reply must leave the session as steerable as
   * the first did.
   */
  _goIdle() {
    if (this.status === STATUS.STOPPED || this.status === STATUS.FAILED) return;
    // An agent that has already exited cannot hold a conversation, whatever the
    // protocol said. Reporting idle here would re-create the original bug in a
    // narrower window.
    if (this.isAgentDead()) {
      this._setStatus(STATUS.DONE, 'Finished');
      this.endedAt = Date.now();
      return;
    }
    this._setStatus(STATUS.IDLE, 'Ready for your reply');
    this._armIdleTimer();
  }

  _armIdleTimer() {
    this._clearIdleTimer();
    if (!Number.isFinite(IDLE_TIMEOUT_MS) || IDLE_TIMEOUT_MS <= 0) return;
    this._idleTimer = setTimeout(() => {
      if (this.status !== STATUS.IDLE) return;
      this._setStatus(STATUS.DONE, 'Finished (idle)');
      this.endedAt = Date.now();
      this.shutdown();
    }, IDLE_TIMEOUT_MS);
    // Never hold the process open on account of a session nobody is watching.
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  _clearIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  /**
   * Ask for the agent and model this session was started with, and record what
   * was actually granted.
   *
   * Never throws. A session that cannot have its agent set is still a working
   * session -- it is just not the one that was asked for, and saying so is the
   * entire job here. Throwing would turn a degraded session into no session.
   */
  async _applySelection(newSession) {
    const want = this.agentSelection || {};
    this.applied = {
      agent: null, model: null, mode: null, warnings: [],
    };

    /**
     * What this agent said it can do, recorded whether or not anything was
     * requested.
     *
     * This is the ONLY place the model list exists. Unlike agents -- which can
     * be probed by running the CLI once -- models are advertised by the agent
     * at `session/new` and nowhere else, so a device cannot know them until it
     * has started a session. Capturing it here is what lets the New session
     * dialog offer models instead of asking someone to type one blind and find
     * out afterwards that it was ignored.
     *
     * Read unconditionally on purpose: it used to be read only when a model
     * had been asked for, which meant the list was thrown away in exactly the
     * case where nobody knew what to ask for.
     */
    const agentOpt = ((newSession && newSession.configOptions) || []).find((o) => o.id === 'agent');
    const modeOpt = ((newSession && newSession.configOptions) || []).find((o) => o.id === 'mode');
    this.available = {
      agents: ((agentOpt && agentOpt.options) || []).map((o) => o.name || o.value).filter(Boolean),
      models: ((newSession && newSession.models && newSession.models.availableModels) || [])
        .map((m) => m.modelId).filter(Boolean),
      // Modes are a config option like the agent, but their values are URIs
      // (`.../session-modes#autopilot`), so the readable name is what a person
      // picks from and the value is what goes back over the protocol.
      modes: ((modeOpt && modeOpt.options) || []).map((o) => o.name || o.value).filter(Boolean),
    };
    if (this.available.agents.length || this.available.models.length || this.available.modes.length) {
      this.emit('capabilities', this.available);
    }

    if (want.agent && want.agent !== 'default') {
      const opt = agentOpt;
      const choices = (opt && opt.options) || [];
      // Case-insensitively, and against the name as well as the value: Copilot
      // registers Squad's agent as "Squad" while every other surface in this
      // codebase spells it "squad".
      const hit = choices.find((o) => String(o.value).toLowerCase() === String(want.agent).toLowerCase())
        || choices.find((o) => String(o.name || '').toLowerCase() === String(want.agent).toLowerCase());
      if (!hit) {
        const offered = choices.map((o) => o.name || o.value).filter(Boolean).join(', ');
        this.applied.warnings.push(
          `the agent "${want.agent}" is not installed for this Copilot; running the default agent instead`
          + (offered ? ` (available: ${offered})` : ''),
        );
      } else {
        try {
          await this._request('session/set_config_option', {
            sessionId: this.acpSessionId, configId: 'agent', value: hit.value,
          });
          this.applied.agent = hit.value;
        } catch (e) {
          this.applied.warnings.push(`could not select the agent "${want.agent}": ${e.message}`);
        }
      }
    }

    if (want.model) {
      const available = ((newSession && newSession.models && newSession.models.availableModels) || [])
        .map((m) => m.modelId);
      const hit = available.find((id) => String(id).toLowerCase() === String(want.model).toLowerCase());
      if (!hit) {
        this.applied.warnings.push(
          `the model "${want.model}" is not available to this account; using the default`
          + (available.length ? ` (available: ${available.join(', ')})` : ''),
        );
      } else {
        try {
          await this._request('session/set_model', { sessionId: this.acpSessionId, modelId: hit });
          this.applied.model = hit;
        } catch (e) {
          this.applied.warnings.push(`could not select the model "${want.model}": ${e.message}`);
        }
      }
    }

    /**
     * The mode: interactive, plan, or autopilot.
     *
     * Applied last, deliberately. It is the option that changes how much a
     * person is asked, so if anything above it failed, the warnings describing
     * that are already in the list when this one is decided.
     *
     * Matched on the readable name as well as the value, because the value is a
     * URI (`.../session-modes#autopilot`) and nobody is going to type that. The
     * suffix is matched too, so "autopilot" finds it.
     *
     * WHAT AUTOPILOT DOES NOT DO, measured rather than assumed: it removes the
     * approval questions, not the floor. A denied tool stays denied and simply
     * does not run. So this is a supervision setting, not a permission one, and
     * choosing it cannot widen what a session is able to do.
     */
    if (want.mode && want.mode !== 'default') {
      const choices = (modeOpt && modeOpt.options) || [];
      const asked = String(want.mode).toLowerCase();
      const hit = choices.find((o) => String(o.value).toLowerCase() === asked)
        || choices.find((o) => String(o.name || '').toLowerCase() === asked)
        // `.../session-modes#autopilot` should be findable as "autopilot".
        || choices.find((o) => String(o.value).toLowerCase().split('#').pop() === asked);
      if (!hit) {
        const offered = choices.map((o) => o.name || o.value).filter(Boolean).join(', ');
        this.applied.warnings.push(
          `the mode "${want.mode}" is not offered by this agent; running its default mode`
          + (offered ? ` (available: ${offered})` : ''),
        );
      } else {
        try {
          await this._request('session/set_config_option', {
            sessionId: this.acpSessionId, configId: 'mode', value: hit.value,
          });
          this.applied.mode = hit.name || hit.value;
        } catch (e) {
          this.applied.warnings.push(`could not select the mode "${want.mode}": ${e.message}`);
        }
      }
    }

    for (const w of this.applied.warnings) this.emit('selection-warning', w);
    return this.applied;
  }

  /** Answer a pending approval. Returns false if the id is unknown. */
  answer(approvalId, optionId, answeredBy = null) {
    const a = this.pendingApprovals.get(approvalId);
    // An answer for a request that is not pending -- a stale card, a double
    // click, a second surface answering a moment later -- is refused rather
    // than applied to whatever happens to be waiting now.
    if (!a) return false;
    const known = a.options.some((o) => o.optionId === optionId);
    if (!known) return false;
    this.pendingApprovals.delete(approvalId);
    this._respond(a.rpcId, { outcome: { outcome: 'selected', optionId } });
    // Kept so every surface can show that it was resolved, and by whom. On a
    // hub two people can watch, "resolved" without "by whom" answers a
    // different question than the one anybody is asking.
    this.answeredApprovals.push({
      approvalId,
      title: a.title || a.command || 'a tool call',
      optionId,
      answeredBy: answeredBy || 'someone',
      answeredAt: Date.now(),
    });
    if (this.answeredApprovals.length > 20) this.answeredApprovals.shift();
    this._setStatus(STATUS.ACTIVE, 'Processing...');
    this.emit('approval-resolved', { approvalId, optionId, answeredBy });
    return true;
  }

  /** Let a pending approval lapse without running the tool. */
  expire(approvalId) {
    const a = this.pendingApprovals.get(approvalId);
    if (!a) return false;
    this.pendingApprovals.delete(approvalId);
    this._respond(a.rpcId, { outcome: { outcome: 'cancelled' } });
    // Someone saw a card asking for permission. When it lapses they are owed
    // an answer to "what happened to that?" -- otherwise the request simply
    // vanishes and the only visible trace is a session that quietly carried on
    // without doing the thing it asked about.
    this.expiredApprovals.push({
      approvalId,
      title: a.title || a.command || 'a tool call',
      requestedAt: a.requestedAt,
      expiredAt: Date.now(),
    });
    if (this.expiredApprovals.length > 20) this.expiredApprovals.shift();
    // An expired approval leaves the session running, not waiting. Without
    // this the status stayed `waiting_approval` with nothing pending, which
    // no badge maps -- so the row rendered the raw status string, and the
    // session looked like it still needed an answer nobody could give.
    if (!this.pendingApprovals.size && this.status === STATUS.WAITING_APPROVAL) {
      this._setStatus(STATUS.ACTIVE, 'Processing...');
    }
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
    // DONE, STOPPED and FAILED are genuinely over. IDLE is not: the agent
    // finished a turn and is waiting, which is exactly when a reply is most
    // likely.
    if (!text || this.status === STATUS.DONE || this.status === STATUS.STOPPED
      || this.status === STATUS.FAILED) {
      return false;
    }
    if (!this.acpSessionId) return false;
    // An agent that died between the check above and this line cannot be
    // steered, and saying "sent" would be a lie the UI would then display.
    if (this.isAgentDead()) return false;
    this._clearIdleTimer();
    this._pushTranscript({ sessionUpdate: 'user_message', content: { text } });
    this._request('session/prompt', {
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text }],
    }).then(() => {
      // The reply's turn ends the same way the first one does, so a
      // conversation can carry on rather than working exactly once.
      this._goIdle();
    }).catch((e) => {
      this._pushTranscript({ sessionUpdate: 'error', content: { text: e.message } });
      this._goIdle();
    });
    this._setStatus(STATUS.ACTIVE, 'Processing...');
    return true;
  }

  stop() {
    this._clearIdleTimer();
    this._setStatus(STATUS.STOPPED, 'Stopped');
    this.endedAt = Date.now();
    this.shutdown();
  }

  shutdown() {
    this._clearIdleTimer();
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
      // What the agent process ACTUALLY granted, which is not always what was
      // asked for. Reported separately rather than folded into agentSelection,
      // because "we asked for squad" and "we got squad" are different facts and
      // the UI has to be able to tell them apart.
      applied: this.applied || null,
      toolCallCount: this.toolCallCount,
      pendingApprovals: [...this.pendingApprovals.values()],
      expiredApprovals: this.expiredApprovals,
      answeredApprovals: this.answeredApprovals,
      resyncCount: this.resyncCount || 0,
      squad: this.squadContext(),
      git: this.gitContext(),
      stderrTail: this.status === STATUS.FAILED ? this._stderr.slice(-1000) : undefined,
    };
  }

  /**
   * Repository and branch for this session's working directory.
   *
   * Cached on the same reasoning as `squadContext`: `toJSON` runs on every
   * heartbeat and every status poll, and a branch changes a handful of times
   * an hour at most. The window is shorter than the squad one because
   * switching branches mid-session is a normal thing to do, and a stale branch
   * is actively misleading in a way a stale decision count is not.
   */
  gitContext() {
    const now = Date.now();
    if (this._git !== undefined && now - this._gitAt < 10000) return this._git;
    const { readGitContext } = require('./git-context');
    this._git = readGitContext(this.cwd);
    this._gitAt = now;
    return this._git;
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

/**
 * Is this permission request read-only?
 *
 * The agent's declared tool kind answers it for file tools. It does NOT answer
 * it for a shell command: every shell call arrives as kind `execute`, so
 * `git status --short` and `rm -rf build` were shown with the same "writes"
 * badge. A badge that says "writes" about a command that plainly reads nothing
 * is not merely cosmetic -- it trains people to ignore the badge, and the badge
 * only earns its place on the card by being right about the one case it exists
 * to flag.
 *
 * The classifier below is deliberately timid. It downgrades a command to
 * read-only ONLY when it recognises the whole line, and treats everything else
 * as writing. That asymmetry is the point: a missed "read-only" costs a
 * needless second look, a wrong "read-only" costs a repository.
 */
function isReadOnlyRequest(tc, raw) {
  if (tc.kind === 'read' || tc.kind === 'search') return true;
  // Only a shell tool is judged by its command. An `edit` or `delete` tool that
  // happens to carry a command-shaped field must never talk its way down.
  if (tc.kind && tc.kind !== 'execute') return false;
  const cmds = Array.isArray(raw.commands) ? raw.commands : (raw.command ? [raw.command] : []);
  if (!cmds.length) return false;
  return cmds.every(isReadOnlyCommand);
}

/* Commands that report and do not change. Anything absent is treated as
   writing, so this list being incomplete is safe by construction. */
const READ_ONLY_COMMANDS = new Set([
  // POSIX-ish
  'cat', 'head', 'tail', 'ls', 'pwd', 'wc', 'stat', 'file', 'basename', 'dirname',
  'realpath', 'readlink', 'which', 'whoami', 'hostname', 'uname', 'date', 'id',
  'printenv', 'tree', 'du', 'df', 'diff', 'sort', 'uniq', 'grep', 'egrep', 'fgrep',
  'rg', 'ripgrep', 'fd', 'echo', 'printf', 'cut', 'nl', 'md5sum', 'sha256sum', 'ps',
  // Windows shell
  'dir', 'type', 'findstr', 'where', 'ver',
  // PowerShell, the read half of the verb set
  'get-content', 'get-childitem', 'get-location', 'get-item', 'get-itemproperty',
  'get-command', 'get-process', 'get-date', 'get-help', 'get-member',
  'select-string', 'select-object', 'measure-object', 'test-path', 'where-object',
  'sort-object', 'format-table', 'format-list', 'out-string', 'resolve-path',
  'compare-object', 'write-output', 'write-host',
]);

/* `git` is a whole toolbox behind one name, so it is judged by subcommand. */
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'describe', 'blame', 'shortlog', 'whatchanged',
  'ls-files', 'ls-tree', 'ls-remote', 'rev-parse', 'rev-list', 'cat-file',
  'name-rev', 'count-objects', 'grep', 'version',
]);

/* `git branch` LISTS with these and CREATES or DELETES with anything else, so it
   is allowed only when every remaining token is one of them. */
const READ_ONLY_GIT_BRANCH_FLAGS = new Set([
  '--show-current', '--list', '-l', '-a', '--all', '-r', '--remotes', '-v', '-vv',
  '--verbose', '--merged', '--no-merged', '--contains', '--sort', '--format',
]);

/* Flags that make an otherwise-reading command write. `-i` is sed's in-place,
   `-o`/`--output` redirect to a file by another name. */
const WRITING_FLAGS = new Set(['-i', '--in-place', '-o', '--output', '--output-file', '-w', '--write', '--fix']);

/**
 * Does this single shell command only look at things?
 *
 * Anything that can chain, redirect, or substitute is refused outright rather
 * than parsed: this understands ONE command, and a line it cannot see the whole
 * of is a line it cannot vouch for.
 */
function isReadOnlyCommand(command) {
  const text = String(command == null ? '' : command).trim();
  if (!text) return false;
  if (/[|&;<>`$(){}\n\r]/.test(text)) return false;
  const tokens = text.split(/\s+/);
  for (const t of tokens.slice(1)) {
    const flag = t.split('=')[0].toLowerCase();
    if (WRITING_FLAGS.has(flag)) return false;
  }
  const head = tokens[0].replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (head === 'git') {
    const args = tokens.slice(1).filter((t) => !t.startsWith('-'));
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'branch') {
      // Bare `git branch` lists; `git branch <name>` creates one.
      const rest = tokens.slice(tokens.indexOf(args[0]) + 1);
      return rest.every((t) => READ_ONLY_GIT_BRANCH_FLAGS.has(t.split('=')[0].toLowerCase()));
    }
    return READ_ONLY_GIT.has(sub);
  }
  return READ_ONLY_COMMANDS.has(head);
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

module.exports = {
  AcpSession, STATUS, extractPaths, isReadOnlyCommand, isReadOnlyRequest,
};
