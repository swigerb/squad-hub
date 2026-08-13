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

const STATUS = {
  ACTIVE: 'Active',
  WORKING: 'Working',
  WAITING: 'Awaiting approval',
  DONE: 'Finished',
  FAILED: 'Failed',
};

/** How a session ended, in the words Copilot's sessionEnd hook uses. */
const END_REASONS = {
  complete: STATUS.DONE,
  user_exit: STATUS.DONE,
  abort: STATUS.DONE,
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

    this.status = source === 'resume' ? STATUS.ACTIVE : STATUS.ACTIVE;
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
    this.expiredApprovals = 0;
    this.answeredApprovals = 0;
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
    this.status = STATUS.WORKING;
    this.touch(clean ? `Working on: ${clean.slice(0, 60)}` : 'Working');
  }

  /** A tool ran. */
  noteTool(toolName) {
    this.toolCallCount += 1;
    this.status = STATUS.WORKING;
    this.touch(toolName ? `Running ${toolName}` : 'Running a tool');
  }

  /** The agent finished a turn and is waiting for the human again. */
  noteIdle() {
    if (this.status === STATUS.DONE || this.status === STATUS.FAILED) return;
    this.status = STATUS.ACTIVE;
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
    this.expiredApprovals += this.pendingApprovals.size;
    for (const p of this.pendingApprovals.values()) {
      if (typeof p._settle === 'function') p._settle('ask');
    }
    this.pendingApprovals.clear();
  }

  get ended() {
    return this.status === STATUS.DONE || this.status === STATUS.FAILED;
  }

  /**
   * Steering is not available, and says so rather than failing silently.
   *
   * The hub calls this on whatever session it is given. Returning a refusal
   * with a reason means the UI can show why, instead of a request that appears
   * to work and then does nothing.
   */
  steer() {
    return {
      ok: false,
      reason: 'this session is a Copilot TUI the hub is watching, not driving; type in that terminal to steer it',
    };
  }

  stop() {
    return {
      ok: false,
      reason: 'this session is a Copilot TUI the hub is watching, not driving; close that terminal to stop it',
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
        this.expiredApprovals += 1;
        settle('ask');
      }, timeoutMs);

      this.pendingApprovals.set(approvalId, {
        id: approvalId,
        sessionId: this.id,
        title: toolName ? `Run ${toolName}` : 'Run a tool',
        toolName: toolName || null,
        detail: typeof toolArgs === 'string' ? toolArgs.slice(0, 2000) : null,
        createdAt: now,
        expiresAt: now + timeoutMs,
        // The same option ids an ACP session offers, so the hub's existing
        // approval UI and its /api/approve path work here with no special case.
        options: [
          { id: 'allow_once', label: 'Allow once' },
          { id: 'reject_once', label: 'Deny' },
        ],
        _settle: settle,
      });

      this.status = STATUS.WAITING;
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
    this.answeredApprovals += 1;
    this.lastAnsweredBy = answeredBy || null;
    this.status = STATUS.WORKING;
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
