// ---------------------------------------------------------------------------
// The new-session composer.
// ---------------------------------------------------------------------------

/**
 * Build a spawn request, dropping anything the person left alone.
 *
 * An empty agent field means "whatever this project selects", which is not the
 * same as the string "". Sending an empty value would override the project's
 * own choice with nothing at all -- see agent-select.js, where an explicit
 * flag beats every other source precisely because it was explicit.
 */
export function spawnRequest({
  prompt, cwd, agent, model, mode,
} = {}) {
  const body = { prompt: String(prompt == null ? '' : prompt).trim() };
  const cleanCwd = String(cwd == null ? '' : cwd).trim();
  const cleanAgent = String(agent == null ? '' : agent).trim();
  const cleanModel = String(model == null ? '' : model).trim();
  const cleanMode = String(mode == null ? '' : mode).trim();
  if (cleanCwd) body.cwd = cleanCwd;
  if (cleanAgent) body.agent = cleanAgent;
  if (cleanModel) body.model = cleanModel;
  // Omitted when empty, so "no preference" reaches the device as an absent
  // field rather than as a mode named "".
  if (cleanMode) body.mode = cleanMode;
  return body;
}

/** A prompt is the one thing a session cannot be started without. */
export function spawnError(body) {
  if (!body || !body.prompt) return 'A prompt is required — say what the agent should do.';
  return null;
}


//
// A composer that is live before anything has confirmed the far end can
// actually take input is a promise the UI cannot keep. The hub knowing about
// a session proves only that a heartbeat once mentioned it -- the hub is a
// cache. Whether the agent is still alive and still accepting input is a fact
// only the device holds, so it is asked, and the controls stay disabled until
// it answers.
//
// This is the same class of bug as reporting "connected" on an HTTP 101 before
// the hub had registered the device, which HubLink already had to be fixed for.
// ---------------------------------------------------------------------------

export const CONTROL = Object.freeze({
  UNKNOWN: 'unknown',       // nothing asked yet
  VERIFYING: 'verifying',   // asked, waiting
  SYNCED: 'synced',         // the device says yes
  NOT_SYNCED: 'not_synced', // the device says no, and why
  UNVERIFIED: 'unverified', // nobody answered in time
});

export const CONTROL_TEXT = Object.freeze({
  [CONTROL.UNKNOWN]: 'Checking control…',
  [CONTROL.VERIFYING]: 'Checking control…',
  [CONTROL.SYNCED]: 'Synced',
  [CONTROL.NOT_SYNCED]: 'Not synced',
  [CONTROL.UNVERIFIED]: "Control couldn't be verified",
});

/**
 * Controls are live in exactly one state.
 *
 * Written as an allow-list rather than a deny-list on purpose: a state added
 * later defaults to DISABLED, which is the safe direction. A deny-list would
 * silently enable the composer for any state nobody remembered to add.
 */
export function controlsEnabled(controlState) {
  return controlState === CONTROL.SYNCED;
}

/** Can the person do anything about it? Only when the answer was "no". */
export function canSync(controlState) {
  return controlState === CONTROL.NOT_SYNCED || controlState === CONTROL.UNVERIFIED;
}

/**
 * Turn a control-check outcome into a state.
 *
 * A transport failure and a definite "no" are deliberately different: one is
 * worth retrying and the other is not, and telling a person "not synced" when
 * the request never arrived sends them looking in the wrong place.
 */
export function controlStateFrom(outcome) {
  if (!outcome) return CONTROL.UNKNOWN;
  if (outcome.pending) return CONTROL.VERIFYING;
  if (outcome.timedOut) return CONTROL.UNVERIFIED;
  if (outcome.error) return CONTROL.UNVERIFIED;
  return outcome.controllable ? CONTROL.SYNCED : CONTROL.NOT_SYNCED;
}

/**
 * What the person is told, and what they can do about it.
 *
 * The reason from the device is passed through when there is one -- "the agent
 * process is gone" and "the session is done" call for very different next
 * steps, and "Not synced" alone tells nobody which they are looking at.
 */
export function controlBanner(controlState, reason) {
  return {
    state: controlState,
    label: CONTROL_TEXT[controlState] || CONTROL_TEXT[CONTROL.UNKNOWN],
    reason: canSync(controlState) ? (reason || '') : '',
    enabled: controlsEnabled(controlState),
    canSync: canSync(controlState),
  };
}

/**
 * The composer, as a reducer.
 *
 * The one property worth stating outright: THE DRAFT SURVIVES EVERYTHING
 * except a successful send. Someone typed that. Clearing it because a
 * verification timed out would throw away work in order to report a transport
 * problem, which is the wrong trade in every case -- and it is exactly what a
 * naive "reset the panel on failure" does.
 */
export function composerReduce(prev, event) {
  const s = { draft: '', control: CONTROL.UNKNOWN, reason: '', ...(prev || {}) };
  switch (event && event.type) {
    case 'type':
      // A new draft supersedes whatever happened to the last message, so the
      // outcome note goes with it rather than lingering over unrelated text.
      return {
        ...s, draft: String(event.text == null ? '' : event.text), outcome: null, outcomeNote: '',
      };
    case 'verify-start':
      return { ...s, control: CONTROL.VERIFYING, reason: '' };
    case 'verify-result': {
      const control = controlStateFrom(event.outcome);
      const reason = (event.outcome && event.outcome.reason)
        || (event.outcome && event.outcome.error)
        || (control === CONTROL.UNVERIFIED ? 'the device did not answer in time' : '');
      return { ...s, control, reason: canSync(control) ? reason : '' };
    }
    case 'sent':
      // The ONLY event that clears the draft, and only because it landed.
      //
      // `queued` and `sent` are DIFFERENT OUTCOMES and are reported as such.
      // A watched (`--tui`) session cannot be written to directly: the daemon
      // does not own that process, so a steer goes onto a queue and is only
      // delivered when the session's next turn ends. Reporting that as "sent"
      // is the same lie as #129's controls -- and worse here, because on an
      // IDLE session nothing will end a turn until somebody types at that
      // keyboard, so the message can sit unread indefinitely while the person
      // who sent it believes it arrived.
      return {
        ...s,
        draft: '',
        outcome: event.queued ? 'queued' : 'sent',
        outcomeNote: event.queued
          ? 'Queued. A watched terminal session picks this up when its current turn ends'
            + ' — if it is idle, that means the next time somebody types there.'
          : '',
      };
    case 'send-failed':
      return {
        ...s,
        outcome: 'failed',
        reason: (event.error && String(event.error)) || 'the message was not delivered',
      };
    default:
      return s;
  }
}
