'use strict';

/**
 * A Copilot session the daemon WATCHES but did not start.
 *
 * `AcpSession` owns a `copilot --acp` process: it spawned it, it can steer it,
 * and it can answer its approvals. This is the other kind. The user launched
 * the real Copilot TUI in their own terminal, and it tells the hub about itself
 * through Copilot's hook events. The daemon never owns the process, so
 * everything here is reported rather than controlled.
 *
 * That distinction is carried in the payload as `supervision`, not left to be
 * inferred from a missing pid. A UI that cannot tell the two apart will offer a
 * Stop button that does nothing, and a button that lies is worse than an absent
 * one.
 *
 * The shape of `toJSON()` deliberately matches `AcpSession`, so the hub, the
 * status command and the web UI need no special case to LIST one of these. Only
 * the things that genuinely differ differ.
 */

/**
 * THE SAME STATUS VOCABULARY AN ACP SESSION USES. Imported, not re-declared.
 *
 * This was originally a private set of prettier-looking strings ('Finished',
 * 'Active'), and it broke production. The hub, the web UI and the daemon's own
 * `forget` all match on the ACP values, so a watched session rendered as a
 * blank row and could never be tidied away. A second vocabulary for the same
 * concept is not a cosmetic choice -- everything downstream is written against
 * one of them.
 */
const { STATUS } = require('./acp-session');

/** How a session ended, in the words Copilot's sessionEnd hook uses. */
const END_REASONS = {
  complete: STATUS.DONE,
  user_exit: STATUS.STOPPED,
  abort: STATUS.STOPPED,
  error: STATUS.FAILED,
  timeout: STATUS.FAILED,
};

class TuiSession {
  /**
   * @param {object} opts
   * @param {string} opts.id          the daemon's own id for this session
   * @param {string} opts.copilotId   the sessionId Copilot reports in its hooks
   * @param {string} opts.cwd         where the TUI is running
   * @param {string} [opts.source]    "new", "startup" or "resume"
   */
  constructor({
    id, copilotId, cwd, source = 'new', startedAt = Date.now(),
  }) {
    this.id = id;
    this.copilotId = copilotId;
    this.cwd = cwd;
    this.source = source;

    // There is no process to report. Left null rather than faked, because a pid
    // is a promise that something can be signalled, and nothing here can be.
    this.pid = null;

    this.status = STATUS.ACTIVE;
    this.activity = 'Started in a terminal';
    this.prompt = null;
    this.startedAt = startedAt;
    this.endedAt = null;
    this.error = null;
    this.toolCallCount = 0;
    this.lastSeen = startedAt;

    this.agentSelection = null;
    this.applied = null;

    this.pendingApprovals = new Map();
    /**
     * ARRAYS, because that is what `AcpSession` publishes and what everything
     * downstream expects. These were counters, and the difference broke the web
     * UI outright: `lastApprovalOutcome` does `(s.expiredApprovals || []).map`,
     * which on a number throws `.map is not a function` -- inside `render()`,
     * so the WHOLE session list stopped drawing, not just this row.
     *
     * That is the fourth thing this class has broken by publishing a shape of
     * its own invention rather than the one the collection already agreed on.
     * See the contract test in test/heartbeat-tui-unit.js, which now compares
     * the two payloads field by field so a fifth cannot happen quietly.
     */
    this.expiredApprovals = [];
    this.answeredApprovals = [];

    /**
     * What this session has been seen doing, in the same shape the daemon's
     * transcript reader expects: `{ seq, at, update }`, oldest first.
     *
     * Without it, opening a watched session in the hub answered "could not load
     * the transcript: Cannot read properties of undefined (reading 'filter')" --
     * `_transcriptSince` reads `s.transcript` and there was none.
     */
    this.transcript = [];
    this._nextSeq = 1;
    this._transcriptCap = 500;
  }

  /** Record one line of what happened, for the hub to show. */
  _note(update) {
    this.transcript.push({ seq: this._nextSeq++, at: Date.now(), update });
    if (this.transcript.length > this._transcriptCap) {
      this.transcript.splice(0, this.transcript.length - this._transcriptCap);
    }
  }

  /**
   * THE HEARTBEAT CONTRACT. Every session in the daemon's map must answer
   * these, whoever started it.
   *
   * `beat()` calls `isAgentDead()` on every live session and `_setStatus()` on
   * any that has died. This class had neither, so the first heartbeat after a
   * terminal session registered threw `TypeError: s.isAgentDead is not a
   * function` inside a `setInterval` callback -- an uncaught exception, which
   * killed the whole daemon.
   *
   * What a person saw: the device went offline seconds after starting a
   * supervised TUI session, the session froze at "Working" forever, and every
   * subsequent tool call turned into a local approval prompt because the hooks
   * had nothing left to talk to. None of which points anywhere near a
   * heartbeat.
   */

  /**
   * There is no agent process here, so it cannot be dead.
   *
   * Answering `false` is the honest answer rather than a convenient one: the
   * daemon did not start this process and cannot signal it, so "is it dead" is
   * a question this class has no way to answer. A session that really has ended
   * says so through the `sessionEnd` hook, which is the only source that knows.
   */
  isAgentDead() {
    return false;
  }

  /**
   * Set the status, matching AcpSession's shape so the daemon can drive either
   * kind without asking which it has.
   */
  _setStatus(status, activity = null) {
    this.status = status;
    if (activity) this.activity = activity;
    this.lastSeen = Date.now();
  }

  /** Note that the session is still alive, whatever else just happened. */
  touch(activity = null) {
    this.lastSeen = Date.now();
    if (activity) this.activity = activity;
  }

  /** The user typed something. The first one is the session's prompt. */
  notePrompt(text) {
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!this.prompt && clean) this.prompt = clean.slice(0, 2000);
    this.status = STATUS.ACTIVE;
    this._note({ kind: 'user', text: clean.slice(0, 2000) });
    this.touch(clean ? `Working on: ${clean.slice(0, 60)}` : 'Working');
  }

  /** A tool ran. */
  noteTool(toolName) {
    this.toolCallCount += 1;
    this.status = STATUS.ACTIVE;
    this._note({ kind: 'tool', text: toolName ? `ran ${toolName}` : 'ran a tool' });
    this.touch(toolName ? `Running ${toolName}` : 'Running a tool');
  }

  /** The agent finished a turn and is waiting for the human again. */
  noteIdle() {
    if (this.ended) return;
    this.status = STATUS.ACTIVE;
    this._note({ kind: 'agent', text: 'finished a turn' });
    this.touch('Awaiting your reply');
  }

  /**
   * The session ended.
   *
   * An unknown reason is treated as a failure rather than a clean finish. A
   * session that stopped for a reason nobody anticipated is exactly the one
   * worth looking at, and calling it "Finished" would hide it.
   */
  end(reason = 'complete') {
    this.status = END_REASONS[reason] || STATUS.FAILED;
    if (this.status === STATUS.FAILED) this.error = `session ended: ${reason}`;
    this.endedAt = Date.now();
    this.activity = `Ended (${reason})`;
    this.lastSeen = this.endedAt;

    // Nothing will ever answer these now. Each waiting hook is released with
    // 'ask' rather than left to time out: the agent is blocked in a terminal
    // that is closing, and the local keyboard is the only place a decision can
    // still come from.
    for (const p of this.pendingApprovals.values()) {
      this.expiredApprovals.push({
        approvalId: p.approvalId,
        title: p.title || 'a tool call',
        requestedAt: p.requestedAt || null,
        expiredAt: Date.now(),
      });
      if (typeof p._settle === 'function') p._settle('ask');
    }
    if (this.expiredApprovals.length > 20) {
      this.expiredApprovals.splice(0, this.expiredApprovals.length - 20);
    }
    this.pendingApprovals.clear();
  }

  /**
   * Has this session finished?
   *
   * Matches the daemon's own TERMINAL_STATUS set (done / failed / stopped). It
   * used to check only DONE and FAILED, so a session that ended with
   * `user_exit` -- somebody simply closing their terminal, which is the
   * ordinary case -- was never terminal, never forgettable, and accumulated in
   * the hub forever.
   */
  get ended() {
    return this.status === STATUS.DONE
      || this.status === STATUS.FAILED
      || this.status === STATUS.STOPPED;
  }

  /**
   * Steering is not available YET, and says so rather than failing silently.
   *
   * "Not built" rather than "impossible": `agentStop` can return
   * `{ decision: "block", reason }`, which forces another agent turn using
   * `reason` as the prompt -- measured against Copilot CLI 1.0.79, and the
   * basis for real steering. Until that is built, a refusal with a reason means
   * the UI can say why, instead of a request that appears to work and does
   * nothing.
   */
  steer() {
    return {
      ok: false,
      reason: 'the hub cannot steer a Copilot TUI session yet; type in that terminal instead',
    };
  }

  stop() {
    return {
      ok: false,
      reason: 'the hub cannot stop a Copilot TUI session; close that terminal instead',
    };
  }

  /**
   * A tool is about to run. Ask whoever is watching the hub, and WAIT.
   *
   * The agent is blocked in its own terminal for as long as this takes, which
   * is the point -- it is what makes an approval from a phone meaningful rather
   * than advisory.
   *
   * Resolves to 'allow', 'deny' or 'ask'. It NEVER rejects, because the caller
   * is a hook running inside somebody's session: an exception there becomes an
   * unhandled failure in their terminal, and the honest answer to "something
   * went wrong" is 'ask' — put the decision back in front of the human at the
   * keyboard.
   */
  requestApproval({
    approvalId, toolName, toolArgs, timeoutMs = 120000, now = Date.now(),
  }) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingApprovals.delete(approvalId);
        resolve(decision);
      };

      // Deliberately resolves 'ask' rather than 'allow'. Nobody answered, so
      // nobody approved -- and the local keyboard is the only place left that
      // can. See the note on `supervision` below for why this matters even when
      // the session was started with --allow-all-tools.
      //
      // NOT unref'd, unlike most timers here. An unref'd timer lets a process
      // whose event loop is otherwise empty exit before it fires, and this
      // promise would then never settle at all -- which for the caller means no
      // answer, and no answer is the one outcome that falls through to
      // permission. The wait must be something that keeps the process alive.
      const timer = setTimeout(() => {
        this.expiredApprovals.push({
          approvalId,
          title: toolName ? `Run ${toolName}` : 'a tool call',
          requestedAt: now,
          expiredAt: Date.now(),
        });
        if (this.expiredApprovals.length > 20) this.expiredApprovals.shift();
        settle('ask');
      }, timeoutMs);

      this.pendingApprovals.set(approvalId, {
        // `approvalId`, not `id`. The web UI and /api/approve both key on
        // approvalId; `id` meant the buttons rendered with data-answer="" and
        // an empty label -- and because `answer()` treats anything that is not
        // recognisably an allow as a deny, CLICKING "ALLOW" DENIED THE TOOL.
        // It failed in the safe direction, which is why nobody noticed sooner.
        approvalId,
        sessionId: this.id,
        title: toolName ? `Run ${toolName}` : 'Run a tool',
        toolName: toolName || null,
        command: typeof toolArgs === 'string' ? toolArgs.slice(0, 2000) : null,
        detail: typeof toolArgs === 'string' ? toolArgs.slice(0, 2000) : null,
        requestedAt: now,
        createdAt: now,
        expiresAt: now + timeoutMs,
        // `optionId` and `name`, matching what AcpSession publishes: the UI
        // renders `o.name || APPROVAL_LABEL[o.optionId] || o.optionId`, so a
        // card using `id`/`label` produces a button with no text and no value.
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
        ],
        _settle: settle,
      });

      this.status = STATUS.WAITING_APPROVAL;
      this.touch(toolName ? `Waiting on approval: ${toolName}` : 'Waiting on approval');
    });
  }

  /**
   * Answer a pending approval. Same signature as an ACP session's, so the
   * daemon's `approve` op needs no special case for a watched session.
   *
   * Anything that is not recognisably an allow is treated as a deny. An option
   * id we do not understand must not become permission to run something.
   */
  answer(approvalId, optionId, answeredBy = null) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;

    const decision = optionId === 'allow_once' || optionId === 'allow_always' ? 'allow' : 'deny';
    this.answeredApprovals.push({
      approvalId,
      title: pending.title || 'a tool call',
      optionId,
      answeredBy: answeredBy || 'someone',
      answeredAt: Date.now(),
    });
    if (this.answeredApprovals.length > 20) this.answeredApprovals.shift();
    this.lastAnsweredBy = answeredBy || null;
    this.status = STATUS.ACTIVE;
    this._note({ kind: 'agent', text: `${decision === 'allow' ? 'allowed' : 'denied'} ${pending.toolName || 'a tool'}` });
    this.touch(`${decision === 'allow' ? 'Allowed' : 'Denied'} ${pending.toolName || 'a tool'}`);
    pending._settle(decision);
    return true;
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
      agent: 'Copilot CLI (terminal)',
      agentSelection: this.agentSelection,
      applied: this.applied,
      toolCallCount: this.toolCallCount,
      // `_settle` is the promise that the waiting hook is parked on. Stripped
      // here rather than left for JSON.stringify to drop, because this payload
      // is also handed to code that inspects the object directly.
      pendingApprovals: [...this.pendingApprovals.values()].map(({ _settle, ...rest }) => rest),
      expiredApprovals: this.expiredApprovals,
      answeredApprovals: this.answeredApprovals,
      resyncCount: 0,
      // Present and null, not absent. The UI reads these on every session; a
      // missing key and a null one are the same to JavaScript here, but the
      // contract test compares field by field and an absent key is how the
      // other four mismatches started.
      squad: null,
      git: null,

      /**
       * WHAT THE HUB MAY DO WITH THIS SESSION.
       *
       * 'acp'   -- the daemon owns the process: steer, approve, stop
       * 'hooks' -- the daemon only hears about it: watch, and answer approvals
       *            if the approvals sprint is in place
       *
       * Stated explicitly so a client never has to guess from the absence of a
       * pid, and so a Stop button can be hidden rather than offered and broken.
       */
      supervision: 'hooks',
      copilotId: this.copilotId,
      lastSeen: this.lastSeen,
    };
  }
}

module.exports = { TuiSession, STATUS, END_REASONS };
