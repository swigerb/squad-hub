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
 *   optimization, having already proven the agent supports it.
 *
 * Everything this class exposes about a permission request comes from the wire,
 * not from a summary. spike/q1-permission-payload.json shows toolCall.rawInput
 * carries the literal command; we forward it untouched so the approval surface
 * can show what will actually run.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { RequiredModelError, requireModelName } = require('./agent-select');
const { runningActivity } = require('./session-status');
const { agentChildEnv, createRedactor, secretValuesFrom } = require('./credentials');

/** Chunked updates whose text is redacted as a stream, not chunk by chunk. */
const STREAMED_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk']);

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

/**
 * How long ONE mode or model change may wait for the agent before it is
 * reported as unconfirmed.
 *
 * Read at call time, and bounded well under the hub's 20 second command
 * timeout even when a change has two steps (model, then mode): the hub gives
 * up on a device that has not answered, and "the hub timed out" says nothing
 * about which of the two steps landed. A step that outlives this is reported
 * with exactly that uncertainty rather than being assumed applied.
 */
function selectionTimeoutMs() {
  const n = Number(process.env.SQUAD_HUB_SELECTION_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

const TERMINAL = [STATUS.DONE, STATUS.STOPPED, STATUS.FAILED];

/** Longest id or name kept for a choice. A bound, not a format. */
const CHOICE_TEXT_MAX = 200;
/** Most choices kept per field; the live model list is ~30. */
const CHOICE_COUNT_MAX = 64;

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Find what a person asked for among what the agent actually offered.
 *
 * Matched against the LIVE list only, in a fixed order: the exact id, then the
 * readable name, then the part of the id after `#` -- a mode id is a URI
 * (`.../session-modes#plan`) and nobody types that. Case-insensitive, because
 * Copilot registers the agent as "Squad" where every other surface says
 * "squad". The canonical choice is returned, never the caller's spelling, so
 * what goes over the wire is a value the agent itself advertised.
 *
 * `idOnly` stops after the first rung. A required model is looked up by the id
 * it was named by and nothing looser: a display name or a fragment that happens
 * to match would be a different model answering to the requested one's name.
 */
function findChoice(choices, asked, { idOnly = false } = {}) {
  const a = norm(asked);
  if (!a) return null;
  if (idOnly) return choices.find((c) => norm(c.id) === a) || null;
  return choices.find((c) => norm(c.id) === a)
    || choices.find((c) => norm(c.name) === a)
    || choices.find((c) => norm(c.id).split('#').pop() === a)
    || null;
}

/**
 * The configOptions an agent reported, as a plain list. NOT flattened: each entry
 * is a config option that carries its own options, and flattening would take
 * the entries apart and leave only the choices inside them.
 */
function configOptionList(options) {
  return (Array.isArray(options) ? options : []).filter((o) => o && typeof o === 'object');
}

/** Flatten the choices of one select option, which the agent may have grouped. */
function flattenOptions(options) {
  const out = [];
  for (const o of Array.isArray(options) ? options : []) {
    if (o && Array.isArray(o.options)) out.push(...flattenOptions(o.options));
    else if (o && typeof o === 'object') out.push(o);
  }
  return out;
}

/** A bounded, de-duplicated list of `{id, name}`; the agent may repeat itself. */
function choiceList(items) {
  const seen = new Set();
  const out = [];
  for (const { id, name } of items) {
    if (typeof id !== 'string' || !id.trim() || id.length > CHOICE_TEXT_MAX || seen.has(id)) continue;
    seen.add(id);
    const label = typeof name === 'string' && name.trim() ? name.trim() : id;
    out.push({ id, name: label.slice(0, CHOICE_TEXT_MAX) });
    if (out.length >= CHOICE_COUNT_MAX) break;
  }
  return out;
}


class AcpSession extends EventEmitter {
  constructor({ id, cwd, prompt, agentCommand = 'copilot', agentArgs = ['--acp'], env, redactor }) {
    super();
    /**
     * Masks credentials in everything this session publishes (#287). Shared
     * with the daemon when it passes one in, so the hub token it learns at
     * `attachHub` is masked here too.
     */
    this._redactor = redactor || createRedactor(secretValuesFrom(process.env));
    // A credential handed to this one child (an agent token in `env`) is
    // masked in its output too, even though it never was in process.env.
    for (const v of secretValuesFrom(env || {})) this._redactor.add(v);
    this._streams = new Map();
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
    /**
     * The agent's own words, the last time it finished a turn.
     *
     * The bell inbox (#174) has to show WHAT the agent is waiting to hear back
     * about, not merely that it is -- "awaiting your reply" with no question
     * attached is a card nobody can act on without opening the session first.
     * Captured from the chunks of the turn that just ended, so it always
     * reflects THIS turn: a turn that only ran a tool silently clears it
     * rather than leaving a stale question from three turns ago attached to a
     * session now waiting on something else entirely.
     */
    this.lastAgentMessage = null;
    this._agentMsgBuf = '';

    this._nextId = 1;
    this._pending = new Map();
    this._buffer = '';
    this._stderr = '';
    // A steer sent while the ORIGINAL turn is still in flight ends that turn
    // early -- the agent treats the new `session/prompt` as canceling the
    // old one, so `run()`'s own request resolves before the steered turn has
    // even started. Counted, not a flag, because more than one steer can be
    // in flight (a second reply sent before the first finished). See
    // `_goIdle()`.
    this._pendingSteers = 0;

    this.proc = spawn(agentCommand, agentArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Hub control-plane credentials never reach the agent (#287); its own
      // Copilot/GitHub auth does.
      env: agentChildEnv(process.env, env),
    });
    this.pid = this.proc.pid;

    // Redacted on the way IN as well as out (`toJSON`): the 8000-character
    // window can cut a secret in half, and a half is no longer recognisable.
    const stderrRedact = this._redactor.stream();
    this.proc.stderr.on('data', (d) => {
      this._stderr = (this._stderr + stderrRedact.push(d.toString())).slice(-8000);
    });
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
      if (msg.error) {
        // The message stays the wire error (callers print it), minus any
        // credential in it (#287), and the parsed error rides along -- its
        // numeric `code` untouched -- so a caller can tell "method not found"
        // from "refused" without re-parsing a string.
        const rpcError = this._redactor.deep(msg.error);
        p.reject(Object.assign(new Error(JSON.stringify(rpcError)), { rpcError }));
      } else p.resolve(msg.result);
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

  /**
   * `_request` with a deadline.
   *
   * A request nobody answers is otherwise a promise that never settles -- and
   * a mode or model change that never settles holds the session's one
   * "change in flight" slot forever. The late reply, if it ever comes, finds
   * its pending entry and settles a promise nobody is waiting on.
   */
  _requestWithin(method, params, ms) {
    let timer;
    const deadline = new Promise((_, rej) => {
      timer = setTimeout(() => rej(Object.assign(
        new Error(`the agent did not answer ${method} within ${ms} ms`),
        { timedOut: true },
      )), ms);
    });
    return Promise.race([this._request(method, params), deadline]).finally(() => clearTimeout(timer));
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
    // What is SHOWN is redacted; what is DECIDED is not. `readOnly` reads the
    // real input, and the answer travels by `rpcId`/`optionId`, so masking a
    // token in the card changes nothing about what runs (#287).
    const shown = this._redactor.deep(raw);
    const approval = {
      approvalId: tc.toolCallId || `req-${msg.id}`,
      rpcId: msg.id,
      sessionId: this.id,
      title: tc.title ? this._redactor.text(String(tc.title)) : null,
      kind: tc.kind || null,
      // The literal thing that will run. Proven present in spike/q1.
      command: shown.command || (Array.isArray(shown.commands) ? shown.commands.join(' && ') : null),
      commands: Array.isArray(shown.commands) ? shown.commands : (shown.command ? [shown.command] : []),
      paths: extractPaths(shown),
      readOnly: isReadOnlyRequest(tc, raw),
      options: (p.options || []).map((o) => ({ optionId: o.optionId, kind: o.kind, name: o.name })),
      requestedAt: Date.now(),
      rawInput: shown,
    };
    this.pendingApprovals.set(approval.approvalId, approval);
    this._setStatus(STATUS.WAITING_APPROVAL, 'Waiting for approval');
    this.emit('approval', approval);
  }

  /** Retain a transcript entry; `redacted` says `u` has already been through the redactor. */
  _pushTranscript(u, redacted = false) {
    const update = redacted ? u : this._redactor.deep(u);
    this.transcript.push({ seq: this._nextSeq++, at: Date.now(), update });
    if (this.transcript.length > this._transcriptCap) {
      this.transcript.splice(0, this.transcript.length - this._transcriptCap);
    }
  }

  _update(params) {
    const u = (params && params.update) || {};
    // Retained and published in redacted form only (#287). The raw update is
    // still what drives tool counts, mode, config and the turn's text buffer.
    const safe = this._redactUpdate(u);
    this._pushTranscript(safe, true);
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
        this.activity = runningActivity(safe.title);
      }
    } else if (u.sessionUpdate === 'agent_message_chunk') {
      if (running) this.activity = 'Processing...';
      // Accumulated regardless of `running`: a chunk that arrives in the
      // narrow window right after a turn ends (see the note on `_update`'s
      // caller) still belongs to that turn's answer and must not be dropped.
      const text = updateText(u);
      if (text) this._agentMsgBuf = (this._agentMsgBuf || '') + text;
    } else if (u.sessionUpdate === 'current_mode_update') {
      // The agent changed its own mode (leaving plan mode, say). What the
      // composer reports as current has to follow the agent, not remember what
      // was last asked for.
      this._noteCurrent('mode', u.currentModeId);
    } else if (u.sessionUpdate === 'config_option_update') {
      this._absorbConfigOptions(u.configOptions);
    }
    this.emit('update', safe);
  }

  /**
   * The redactor and per-kind stream state, created on first use when an
   * instance was built without the constructor (`Object.create`), so nothing
   * this class publishes can skip masking (#287).
   */
  get _redactor() {
    if (!this.__redactor) this.__redactor = createRedactor(secretValuesFrom(process.env));
    return this.__redactor;
  }

  set _redactor(r) { this.__redactor = r; }

  get _streams() {
    if (!this.__streams) this.__streams = new Map();
    return this.__streams;
  }

  set _streams(m) { this.__streams = m; }

  /**
   * The redacted copy of a `session/update`.
   *
   * A streamed chunk's text is redacted against the text before it, so a
   * token split across two chunks is still masked; everything else is
   * redacted structurally. Never mutates the input.
   */
  _redactUpdate(u) {
    const safe = this._redactor.deep(u);
    const kind = u && u.sessionUpdate;
    if (STREAMED_UPDATES.has(kind) && u.content && typeof u.content.text === 'string'
      && safe && safe.content && typeof safe.content === 'object') {
      if (!this._streams.has(kind)) this._streams.set(kind, this._redactor.stream());
      safe.content = { ...safe.content, text: this._streams.get(kind).push(u.content.text) };
    }
    return safe;
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Run the session: handshake, select agent/model/mode, then the first prompt.
   *
   * A session that names a REQUIRED model (`agentSelection.requiredModel`) can
   * fail before its prompt for a reason the optional path would have shrugged
   * off, and every such failure -- the model not advertised, not offered, not
   * confirmed, no answer in time, the agent dying -- ends here as one coded
   * refusal with the agent stopped. See `_applyRequiredModel`. A failure AFTER
   * the model was confirmed is an ordinary failure and is rethrown as it was.
   */
  async run() {
    try {
      return await this._runSession();
    } catch (e) {
      throw this._requiredModel() ? this._refuseRequiredModel(e) : e;
    }
  }

  async _runSession() {
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
    /**
     * A steer is still in flight. Reporting idle here would be a lie: there
     * is a second `session/prompt` running that this very call may exist
     * only because it interrupted (see `steer()`). The caller that matters
     * most is `cloud-device.js` in one-shot mode, which polls for exactly
     * this status to decide the job is done (#164) -- an idle reported
     * before the steered turn ran stopped the session out from under it,
     * publishing half the work and dropping the steer text entirely. Staying
     * ACTIVE here costs nothing: `steer()`'s own completion calls
     * `_goIdle()` again once nothing is left in flight.
     */
    if (this._pendingSteers > 0) return;
    // Whatever the agent said this turn becomes THE question the bell inbox
    // shows beside "Awaiting your reply" -- and a turn that said nothing (it
    // only ran a tool, or produced no text at all) clears the old one rather
    // than leaving a stale question attached to a session that is waiting on
    // something new.
    const said = (this._agentMsgBuf || '').trim();
    // Redacted as one string, so a token the chunks split is masked whole.
    this.lastAgentMessage = this._redactor.text(said) || null;
    this._agentMsgBuf = '';
    for (const s of this._streams.values()) s.reset();
    this._setStatus(STATUS.IDLE, 'Ready for your reply');
    this._armIdleTimer();
  }

  _armIdleTimer() {
    this._clearIdleTimer();
    if (!Number.isFinite(IDLE_TIMEOUT_MS) || IDLE_TIMEOUT_MS <= 0) return;
    this._idleTimer = setTimeout(() => {
      if (this.status !== STATUS.IDLE) return;
      // Say what happened, in the words a person would use. "Finished (idle)"
      // named an internal state and read as though the work had completed --
      // when in fact the agent was waiting for a reply that never came, and
      // anything it had not committed was still uncommitted when it stopped.
      const mins = Math.round(IDLE_TIMEOUT_MS / 60000);
      this._setStatus(STATUS.DONE, `Stopped after ${mins} min with no reply`);
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
   * Never throws for an optional agent or model: a session that cannot have
   * them set is still a working session -- it is just not the one that was
   * asked for, and saying so is the entire job here. Throwing would turn a
   * degraded session into no session. A REQUIRED model (`want.requiredModel`)
   * is the exception: a different model answering is not a degraded session,
   * so that throws instead.
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
    // The same advertisement, kept with ids and display names for the composer's
    // next-turn mode and model selectors (see `steerWithSelection`).
    this._recordChoices(newSession);

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

    if (want.requiredModel === true) {
      // No warning, no default: this either ends with the model confirmed or
      // throws, and the caller of `run()` sees the throw before any prompt.
      await this._applyRequiredModel(want.model);
    } else if (want.model) {
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
          this._noteCurrent('model', hit);
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
          this._noteCurrent('mode', hit.value);
        } catch (e) {
          this.applied.warnings.push(`could not select the mode "${want.mode}": ${e.message}`);
        }
      }
    }

    for (const w of this.applied.warnings) this.emit('selection-warning', w);
    return this.applied;
  }

  /**
   * The required-model record of this session, or null when its model is only
   * a preference. Built on first use rather than in the constructor because the
   * daemon hands the selection over after `new`.
   *
   * `confirmed` is the one fact a supervisor can rely on: true only after the
   * agent itself reported the requested model as current.
   */
  _requiredModel() {
    const want = this.agentSelection;
    if (!want || want.requiredModel !== true) return null;
    if (!this._rm) {
      this._rm = {
        requested: typeof want.model === 'string' ? want.model : null,
        chosen: null,
        confirmed: false,
        failure: null,
      };
    }
    return this._rm;
  }

  /**
   * Why a steered prompt cannot go out yet, or null when none is in the way.
   *
   * The first prompt of a required-model session is spoken for: it is written
   * only after the agent has confirmed the model (`_applyRequiredModel`). A
   * steered prompt that got there first would run on whatever model the agent
   * happened to be on, which is the one outcome a required model exists to
   * prevent. Neither `_nt.busy` (not set while the initial selection waits) nor
   * IDLE (not reached until the first turn ends) says so; this does, from the
   * record of the confirmation itself.
   *
   * STARTING is the whole window and ends the moment the first prompt is
   * written, so it also covers the mode that is applied after the model.
   * An optional session has no requirement and is never held here.
   */
  _requiredModelBlock() {
    const rm = this._requiredModel();
    if (!rm) return null;
    if (rm.failure) {
      return `the required model was refused (${rm.failure.code}), so this session takes no input`;
    }
    if (!rm.confirmed) {
      return `the required model${rm.requested ? ` ${rm.requested}` : ''} is not confirmed by the agent yet, `
        + 'so nothing can be sent to this session; send again once it is running';
    }
    if (this.status === STATUS.STARTING) {
      return 'this session is still starting and its first prompt has not been sent; '
        + 'a message now would go ahead of it. Send again in a moment';
    }
    return null;
  }

  /** The agent process is gone, or the session already ended without us. */
  _agentGone() {
    return TERMINAL.includes(this.status) || this.isAgentDead();
  }

  /**
   * Make the requested model the one this session runs, or throw.
   *
   * Same rules as a next-turn change (`steerWithSelection`) and the same
   * helpers, because what makes a change real is the same here: the model must
   * be one the agent ADVERTISED in `session/new`, and the change must be
   * confirmed by `session/set_config_option` answering with that model as
   * current. Everything the optional path tolerates is a refusal here --
   *
   *   - no model config option advertised (an agent that lists models but
   *     cannot switch them, one that lists nothing)   -> NOT_ADVERTISED
   *   - the requested id is not among the advertised  -> UNAVAILABLE
   *   - `{}`, the old current, no entry for the model -> UNCONFIRMED
   *   - an error, or "method not found"               -> UNCONFIRMED / NOT_ADVERTISED
   *   - no answer inside the selection timeout        -> TIMEOUT
   *   - the agent exited while we waited              -> AGENT_EXITED
   *
   * An RPC that merely succeeded is not a confirmation, and neither is a model
   * that was already current: the request is always sent, so the answer is
   * always the agent's own. `applied.model` is set from that answer alone.
   */
  async _applyRequiredModel(asked) {
    const rm = this._requiredModel();
    const name = requireModelName(asked);
    const nt = this._nextTurn();
    const choices = (nt.choices && nt.choices.model) || [];
    if (nt.unsupported.has('model') || !choices.length) {
      throw new RequiredModelError('REQUIRED_MODEL_NOT_ADVERTISED',
        nt.unsupported.get('model') || 'this agent did not advertise a model it can be told to use');
    }
    const hit = findChoice(choices, name, { idOnly: true });
    if (!hit) {
      const offered = choices.slice(0, 20).map((c) => c.id).join(', ');
      throw new RequiredModelError('REQUIRED_MODEL_UNAVAILABLE',
        `the required model is not one this agent offers (available: ${offered}${choices.length > 20 ? ', ...' : ''})`);
    }

    const step = await this._applyChoice('model', hit);
    if (!step.ok) {
      let code = 'REQUIRED_MODEL_UNCONFIRMED';
      if (this._agentGone()) code = 'REQUIRED_MODEL_AGENT_EXITED';
      else if (step.unsupported) code = 'REQUIRED_MODEL_NOT_ADVERTISED';
      else if (step.timedOut) code = 'REQUIRED_MODEL_TIMEOUT';
      throw new RequiredModelError(code, step.reason);
    }
    rm.chosen = hit.id;
    rm.confirmed = true;
    this.applied.model = hit.id;
  }

  /**
   * End a required-model session that cannot run: record why, fail it, stop the
   * agent this session owns, and hand back the error `run()` throws.
   *
   * Anything that goes wrong before the model is confirmed lands here, coded,
   * so a supervisor reads one stable `code` whatever stage it was at. After
   * confirmation it is not a model problem any more, and `e` goes back as it
   * was. The agent is killed here rather than left to the caller: a refused
   * session has no prompt to run and nothing a live agent could still do for it.
   */
  _refuseRequiredModel(e) {
    const rm = this._requiredModel();
    if (rm.confirmed) return e;
    let code;
    let reason;
    if (e instanceof RequiredModelError) {
      ({ code } = e);
      reason = e.message;
    } else {
      code = this._agentGone() ? 'REQUIRED_MODEL_AGENT_EXITED' : 'REQUIRED_MODEL_UNCONFIRMED';
      reason = `the agent failed before the model was confirmed: ${(e && e.message) || 'unknown error'}`;
    }
    // The agent's own words can carry control characters; this ends up on a
    // terminal line and in the hub.
    reason = String(reason).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    rm.failure = { code, reason };
    const err = new RequiredModelError(code, `required model refused (${code}): ${reason}`);
    if (this.status !== STATUS.STOPPED) this._fail(err.message);
    this.shutdown();
    return err;
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
      // Only the hub's approve route names an answerer; a local
      // `squad-hub approve` or `/approve` does not.
      answeredVia: answeredBy ? 'hub' : 'terminal',
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
    // `cancelled` is the ACP spec's own outcome value (British spelling and
    // all) -- a wire-protocol literal, not prose, so it stays as the spec
    // defines it rather than joining the American English sweep.
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
    // First of all, before anything is checked that could let a prompt through
    // and before any state moves: see `_requiredModelBlock`.
    const blocked = text ? this._requiredModelBlock() : null;
    if (blocked) return { ok: false, reason: blocked };
    // DONE, STOPPED and FAILED are genuinely over. IDLE is not: the agent
    // finished a turn and is waiting, which is exactly when a reply is most
    // likely.
    if (!text || TERMINAL.includes(this.status)) {
      return false;
    }
    if (!this.acpSessionId) return false;
    // An agent that died between the check above and this line cannot be
    // steered, and saying "sent" would be a lie the UI would then display.
    if (this.isAgentDead()) return false;
    // A mode or model change is mid-flight and the prompt that follows it is
    // spoken for. A second prompt now would either run in the OLD mode -- the
    // change landing under it -- or interrupt the turn the change is for.
    if (this._nt && this._nt.busy) {
      return {
        ok: false,
        reason: 'a mode or model change for this session is still being applied; send again in a moment',
      };
    }
    return this._sendPrompt(text);
  }

  /** Write `text` to the agent as a new prompt. Callers have already checked the session can take it. */
  _sendPrompt(text) {
    this._clearIdleTimer();
    this._pushTranscript({ sessionUpdate: 'user_message', content: { text } });
    // Marked in flight BEFORE the request goes out, not after -- the agent
    // can interrupt a turn still in progress (run()'s own, or an earlier
    // steer's) the instant this prompt lands on the wire, which can resolve
    // that OTHER call's `_goIdle()` before this `.then` ever runs. See
    // `_goIdle()` for why that matters.
    this._pendingSteers += 1;
    this._request('session/prompt', {
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text }],
    }).then(() => {
      this._pendingSteers -= 1;
      // The reply's turn ends the same way the first one does, so a
      // conversation can carry on rather than working exactly once.
      this._goIdle();
    }).catch((e) => {
      this._pendingSteers -= 1;
      this._pushTranscript({ sessionUpdate: 'error', content: { text: e.message } });
      this._goIdle();
    });
    this._setStatus(STATUS.ACTIVE, 'Processing...');
    return true;
  }

  // -- the next turn's mode and model ---------------------------------------

  /** Per-session state for the next-turn selectors. Lazy, so a bare prototype works too. */
  _nextTurn() {
    if (!this._nt) {
      this._nt = {
        // `{ mode: [{id, name}], model: [{id, name}] }`, or null until the
        // agent has said what it offers (before `session/new` answers).
        choices: null,
        current: { mode: null, model: null },
        // field -> why this agent cannot change it. Filled when `session/new`
        // offers no way to (see `_recordChoices`) and when the agent answers
        // "method not found", so the composer says so instead of offering the
        // same change again.
        unsupported: new Map(),
        busy: false,
      };
    }
    return this._nt;
  }

  /**
   * Remember what `session/new` said the agent can do, as ids with display
   * names. Nothing here is hardcoded: a mode or model the agent does not
   * advertise is not offered, and one it stops advertising disappears.
   *
   * A field is changeable only if the agent advertised a `configOptions` entry
   * for it, because `session/set_config_option` is the one call whose answer
   * says what the value is now. `session/set_model` answers `{}` and leaves
   * the agent's own announcement as the only confirmation, so a model list
   * with no such entry is shown, but not offered (#183 spike).
   */
  _recordChoices(newSession) {
    const nt = this._nextTurn();
    const configOptions = configOptionList(newSession && newSession.configOptions);
    const opts = {
      mode: configOptions.find((o) => o.id === 'mode'),
      model: configOptions.find((o) => o.id === 'model'),
    };

    nt.choices = {};
    nt.unsupported.clear();
    for (const field of ['mode', 'model']) {
      const opt = opts[field];
      nt.choices[field] = choiceList(flattenOptions(opt && opt.options)
        .map((o) => ({ id: o.value, name: o.name })));
      if (!opt) {
        nt.unsupported.set(field, field === 'model' && ((newSession && newSession.models) || {}).availableModels
          ? 'this agent lists its models but gives no way to confirm a change while the session is running'
          : `this agent did not offer a choice of ${field}`);
      }
    }

    const currentMode = opts.mode && opts.mode.currentValue !== undefined ? opts.mode.currentValue
      : (newSession && newSession.modes && newSession.modes.currentModeId);
    const currentModel = (opts.model && opts.model.currentValue)
      || (newSession && newSession.models && newSession.models.currentModelId);
    this._noteCurrent('mode', currentMode);
    this._noteCurrent('model', currentModel);
  }

  /** Record what the agent reports as current for `field`, as the id it advertised. */
  _noteCurrent(field, value) {
    if (typeof value !== 'string' || !value.trim()) return;
    const nt = this._nextTurn();
    const hit = nt.choices ? findChoice(nt.choices[field], value) : null;
    nt.current[field] = hit ? hit.id : value.slice(0, CHOICE_TEXT_MAX);
  }

  /** Take `currentValue` for mode and model out of a `configOptions` list. */
  _absorbConfigOptions(options) {
    const list = configOptionList(options);
    for (const field of ['mode', 'model']) {
      const opt = list.find((o) => o.id === field);
      if (opt) this._noteCurrent(field, opt.currentValue);
    }
  }

  /**
   * Send `text` as the next turn, in the mode and model asked for.
   *
   * ONE ATOMIC OPERATION, because a change and the prompt it is for are not
   * separable. Done as two calls from the caller, a mode that fails to apply
   * leaves a prompt that runs anyway -- in the default mode, silently, which
   * for "plan" means an agent that was asked to only think goes and edits
   * files. So: every requested value is checked against what the agent
   * advertises BEFORE anything is sent, the changes are applied one at a time
   * and each one confirmed, and the prompt goes out only if all of them were.
   * A refusal sends no prompt and changes nothing it did not report.
   *
   * IDLE ONLY. A change applies to the NEXT turn; a session that is mid-turn
   * has a turn already running that this must not alter, and the protocol has
   * no "change it for the next one" message to queue.
   *
   * Applied model first, mode last. Autopilot is the setting that changes how
   * much a person is asked, so it is the one step that must never have taken
   * effect when something after it failed -- put last, nothing is left to fail.
   * Both go through `session/set_config_option` with the value the agent
   * advertised: it answers with the options as they now stand, which is what
   * "confirmed" means here (`session/set_mode` takes a URI and answers `{}`;
   * spike evidence in `spike/next-turn-findings.json`).
   *
   * Always resolves. `{ ok: true, sent: true, changes }` or
   * `{ ok: false, sent: false, code, reason, changes }`, where `changes` are
   * the ones the agent CONFIRMED before the refusal.
   */
  async steerWithSelection(text, selection) {
    const asked = {};
    for (const field of ['model', 'mode']) {
      const v = selection && selection[field];
      if (typeof v === 'string' && v.trim()) asked[field] = v.trim();
    }
    const refuse = (code, reason, changes = []) => ({
      ok: false, sent: false, code, reason, changes,
    });

    if (!Object.keys(asked).length) {
      const r = this.steer(text);
      return r === true
        ? { ok: true, sent: true, changes: [] }
        : refuse('not-steerable', (r && r.reason) || 'this session is not accepting input');
    }

    if (!text || TERMINAL.includes(this.status) || !this.acpSessionId || this.isAgentDead()) {
      return refuse('not-steerable', 'this session is not accepting input');
    }
    const nt = this._nextTurn();
    if (nt.busy) {
      return refuse('selection-busy',
        'another mode or model change for this session is still being applied; try again in a moment');
    }
    if (this.status !== STATUS.IDLE || this._pendingSteers > 0) {
      return refuse('turn-in-progress',
        'the agent is still working on a turn. A mode or model change applies to the next turn, '
        + 'so wait until the session is ready for your reply');
    }

    // Everything asked for is checked before anything is sent.
    const plan = [];
    for (const field of ['model', 'mode']) {
      if (!asked[field]) continue;
      const choices = (nt.choices && nt.choices[field]) || [];
      if (nt.unsupported.has(field) || !choices.length) {
        return refuse('next-turn-unsupported',
          nt.unsupported.get(field) || `this agent does not let a running session change its ${field} between turns`);
      }
      const hit = findChoice(choices, asked[field]);
      if (!hit) {
        return refuse('selection-not-offered',
          `"${asked[field].slice(0, 80)}" is not a ${field} this agent offers`
          + ` (available: ${choices.map((c) => c.name).join(', ')})`);
      }
      // Already the current one: nothing to change, and no round trip to fail.
      if (norm(nt.current[field]) !== norm(hit.id)) plan.push({ field, hit });
    }

    // From here to the prompt there is no gap another caller can step into:
    // `busy` is set in the same turn of the event loop as the checks above,
    // and cleared in the same turn as the prompt is written.
    nt.busy = true;
    this._clearIdleTimer();
    const changes = [];
    let sent = false;
    try {
      for (const { field, hit } of plan) {
        const from = nt.current[field];
        const step = await this._applyChoice(field, hit);
        if (!step.ok) {
          if (!this._canTakePrompt()) {
            return refuse('session-changed', 'the session ended while the change was being applied', changes);
          }
          const prior = changes.length
            ? ` The ${changes.map((c) => c.field).join(' and ')} change already confirmed stays in effect.`
            : '';
          const reason = `could not change the ${field} to ${hit.name}: ${step.reason}. `
            + `Your message was not sent.${prior}`;
          this._pushTranscript({ sessionUpdate: 'error', content: { text: reason } });
          return refuse(step.unsupported ? 'next-turn-unsupported' : 'selection-failed', reason, changes);
        }
        changes.push({ field, from: from || null, to: hit.id });
        const label = (nt.choices[field].find((c) => c.id === from) || {}).name || from || null;
        this._pushTranscript({
          sessionUpdate: 'selection_change',
          field,
          from: label,
          to: hit.name,
          toId: hit.id,
          content: { type: 'text', text: field === 'mode' ? `mode → ${hit.name.toLowerCase()}` : `model → ${hit.id}` },
        });
      }
      if (!this._canTakePrompt()) {
        return refuse('session-changed', 'the session ended while the change was being applied', changes);
      }
      this._sendPrompt(text);
      sent = true;
    } finally {
      nt.busy = false;
      // Nothing was sent, so nothing is running: the session is exactly as idle
      // as it was and has to stay reapable.
      if (!sent && this.status === STATUS.IDLE) this._armIdleTimer();
    }
    return { ok: true, sent: true, changes };
  }

  /** The session is still there, still idle, and its agent still alive. */
  _canTakePrompt() {
    return this.status === STATUS.IDLE && this._pendingSteers === 0 && !this.isAgentDead();
  }

  /**
   * Apply one change and wait for the agent to confirm it.
   *
   * The current value is updated from the agent's answer and nowhere else, so a
   * failed or unconfirmed change never leaves the session CLAIMING it took
   * effect. `session/set_config_option` answers with the options as they now
   * stand: an answer that does not say the value is the one asked for -- a
   * different `currentValue`, or no entry for the field at all -- is not a
   * confirmation, whatever the status of the reply was.
   */
  async _applyChoice(field, hit) {
    const nt = this._nextTurn();
    let result;
    try {
      result = await this._requestWithin('session/set_config_option',
        { sessionId: this.acpSessionId, configId: field, value: hit.id }, selectionTimeoutMs());
    } catch (e) {
      const rpc = e && e.rpcError;
      if (rpc && rpc.code === -32601) {
        const why = `this agent does not support changing the ${field} of a running session`;
        nt.unsupported.set(field, why);
        return { ok: false, unsupported: true, reason: why };
      }
      if (e && e.timedOut) {
        return { ok: false, timedOut: true, reason: 'the agent did not confirm it in time, so it may or may not have applied' };
      }
      return { ok: false, reason: String((rpc && rpc.message) || (e && e.message) || 'the agent refused').slice(0, 300) };
    }
    const reported = configOptionList(result && result.configOptions).find((o) => o.id === field);
    if (!reported || reported.currentValue === undefined) {
      return { ok: false, reason: `the agent accepted it but did not say what the ${field} is now, so it may or may not have applied` };
    }
    this._absorbConfigOptions(result.configOptions);
    if (norm(reported.currentValue) !== norm(hit.id)) {
      const now = (findChoice(nt.choices[field], reported.currentValue) || {}).name || String(reported.currentValue);
      return { ok: false, reason: `the agent reports the ${field} is still ${now.slice(0, 80)}` };
    }
    nt.current[field] = hit.id;
    return { ok: true };
  }

  /**
   * What the composer may offer for the next turn.
   *
   * Per field, because an agent can advertise models and not modes. `choices`
   * is only filled for a field that can actually be changed, and `reason` says
   * why when it cannot, so a disabled selector can explain itself in words
   * that are true rather than a generic "unavailable". `current` is whatever
   * the agent last confirmed.
   */
  nextTurnState() {
    const nt = this._nextTurn();
    const live = !TERMINAL.includes(this.status);
    const field = (key) => {
      const choices = (nt.choices && nt.choices[key]) || [];
      let reason = null;
      if (!live) reason = 'this session has ended';
      else if (!nt.choices) reason = 'the agent has not said yet what it can change';
      else if (nt.unsupported.has(key)) reason = nt.unsupported.get(key);
      else if (!choices.length) reason = `this agent did not offer a choice of ${key}`;
      return {
        supported: reason === null,
        reason,
        current: nt.current[key] || null,
        choices: reason === null ? choices.map(({ id, name }) => ({ id, name })) : [],
      };
    };
    const mode = field('mode');
    const model = field('model');
    const supported = mode.supported || model.supported;
    return { supported, reason: supported ? null : (mode.reason || model.reason), mode, model };
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
    const safe = this._redactor.text(String(message));
    this.error = safe;
    this.endedAt = Date.now();
    this._setStatus(STATUS.FAILED, 'Failed');
    for (const [, p] of this._pending) p.reject(new Error(safe));
    this._pending.clear();
  }

  _setStatus(next, activity) {
    if (this.status === next && this.activity === activity) return;
    const prev = this.status;
    this.status = next;
    if (activity) this.activity = activity;
    this.emit('status', { from: prev, to: next, activity: this.activity });
  }

  _requiredModelView() {
    const rm = this._requiredModel();
    return { ...rm, failure: rm.failure ? { ...rm.failure } : null };
  }

  toJSON() {
    return {
      id: this.id,
      pid: this.pid,
      status: this.status,
      activity: this.activity,
      // The agent's own words, for a session now sitting IDLE. Null while the
      // agent is still working, and null again once a turn ran with no text
      // of its own (see `_goIdle`) -- it is never left pointing at a question
      // from several turns back.
      lastAgentMessage: this.lastAgentMessage,
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
      // Present only for a session whose model is REQUIRED, and then the whole
      // story: what was asked for, what the agent confirmed (null until it
      // has), and the coded reason when it refused. `confirmed` is the only
      // field that says the model is really the one running.
      requiredModel: this._requiredModel() ? this._requiredModelView() : undefined,
      // What the composer may change for the next turn, and what the agent
      // last confirmed as current. Published per session because it is the
      // agent's own advertisement, not a device-wide guess.
      nextTurn: this.nextTurnState(),
      toolCallCount: this.toolCallCount,
      pendingApprovals: [...this.pendingApprovals.values()],
      expiredApprovals: this.expiredApprovals,
      answeredApprovals: this.answeredApprovals,
      resyncCount: this.resyncCount || 0,
      squad: this.squadContext(),
      git: this.gitContext(),
      stderrTail: this.status === STATUS.FAILED ? this._redactor.text(this._stderr).slice(-1000) : undefined,
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
    if (this._squad !== undefined && now - this._squadAt < 30000) {
      if (this._squad) this._squad.health = require('./squad-health').getCachedSquadHealth(this.cwd);
      return this._squad;
    }
    const { readSquad } = require('./squad-context');
    this._squad = readSquad(this.cwd, { transcript: this.transcript.slice(-40) });
    if (this._squad) {
      this._squad.health = require('./squad-health').getCachedSquadHealth(this.cwd);
    }
    this._squadAt = now;
    return this._squad;
  }
}

/**
 * The prose out of a `session/update`, whatever shape its content took.
 *
 * ACP content arrives as a single content block, an array of them, or (rarely)
 * a bare `text` field, and a block itself can nest another block under
 * `content`. Mirrors `updateText` in web/js/detail.js -- the client reads
 * transcript entries built from this same wire shape, and a server that
 * extracted text differently from the client that renders it would make
 * `lastAgentMessage` disagree with the transcript for the same turn.
 */
function updateText(u) {
  const fromBlock = (b) => {
    if (typeof b === 'string') return b;
    if (!b || typeof b !== 'object') return '';
    if (typeof b.text === 'string') return b.text;
    if (b.content) return fromBlock(b.content);
    return '';
  };
  if (Array.isArray(u.content)) return u.content.map(fromBlock).filter(Boolean).join('\n');
  const direct = fromBlock(u.content);
  if (direct) return direct;
  return typeof u.text === 'string' ? u.text : '';
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
  AcpSession, STATUS, extractPaths, isReadOnlyCommand, isReadOnlyRequest, updateText,
};
