export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (id) => document.getElementById(id);

let toastTimer = null;
export function toast(text) {
  const t = $('toast');
  clearTimeout(toastTimer);
  clearTimeout(undoTimer);
  t.textContent = text;
  t.hidden = false;
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/** How long an Undo toast waits before committing. Shortened only by the test hook below. */
let undoDelayMs = 5000;
let undoTimer = null;

/**
 * A toast that offers to cancel what it announces, instead of merely
 * reporting it after the fact.
 *
 * `commit` runs once the window passes untouched; `undo`, if given, runs
 * instead when the button is pressed. Neither the server nor anything
 * irreversible happens until exactly one of the two fires -- the confirm
 * dialog that got someone here already asked once, so the few seconds that
 * follow are the forgiving kind of second chance: silent unless you need it,
 * gone the moment you do not.
 */
export function undoToast(text, commit, undo) {
  const t = $('toast');
  clearTimeout(toastTimer);
  clearTimeout(undoTimer);
  let settled = false;
  t.innerHTML = `<span class="toast-text">${esc(text)}</span>`
    + '<button type="button" class="toast-undo" id="toastUndo">Undo</button>';
  t.hidden = false;
  const finish = async (fn) => {
    if (settled) return;
    settled = true;
    t.hidden = true;
    if (fn) await fn();
  };
  const btn = $('toastUndo');
  if (btn) btn.onclick = () => finish(undo);
  undoTimer = setTimeout(() => finish(commit), undoDelayMs);
}

/**
 * Shortens the Undo window below for tests (real deployments keep the full 5
 * seconds). It changes no behavior a person could not already see -- the
 * window is always "however long the toast says" -- it only makes that
 * window short enough for a test suite to wait out without every click
 * costing five real seconds.
 */
export function setUndoDelayForTest(ms) { undoDelayMs = ms; }

/**
 * A count, rendered as a count.
 *
 * Every number on a session row -- tool calls, member and decision counts --
 * arrives FROM A DEVICE over the WebSocket. The daemon computes them as array
 * lengths, so in normal operation they are integers and escaping them would be
 * pointless. That is exactly why it is worth doing.
 *
 * A device token is meant to be able to be a device and nothing else: it cannot
 * read the API and cannot drive another device. But a device supplies the text
 * this page renders, so a leaked device token that sent a string where a number
 * belongs would put markup in the OWNER'S browser -- and the owner's browser
 * holds the user token. That turns "can register a device" into "can take the
 * account", which is the one thing the device-token design exists to prevent.
 *
 * Coercing to a finite number closes it without depending on the daemon
 * staying honest.
 */
export const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

export function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * The same instant, written out in full and in the reader's own locale.
 *
 * "28m ago" is the right thing to SCAN a list by, and the wrong thing to
 * answer "when exactly did that run?" with -- which is the question anyone
 * correlating a session against a deployment, a job execution, or an incident
 * is actually asking. Rather than choose, the relative form stays visible and
 * this goes on the `title`, so the exact time is one hover away and costs the
 * row nothing.
 */
export function exact(ms) {
  if (!ms) return '';
  try { return new Date(ms).toLocaleString(); } catch { return ''; }
}

/** Relative time to read at a glance, exact time on hover. */
export function timeCell(ms, label = 'Started') {
  if (!ms) return '';
  return `<span title="${esc(label)} ${esc(exact(ms))}">${esc(ago(ms))}</span>`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
/**
 * The badge a row carries.
 *
  * `Needs approval` outranks the status entirely: a session blocked on a person
 * is the only row that cannot make progress on its own, so it must never be
  * described as merely working.
 *
  * The two states that want a person are named for the ACTION each one wants.
  * `Needs approval` blocks until somebody decides. `Awaiting your reply` does
  * not block anything -- the agent finished a turn and is alive, and the
  * session can be left alone. Naming both of them as a bare demand made the
  * pair indistinguishable, and a reader could not tell which one was holding
  * work up.
  */
/**
 * Cut text to a length without ending mid-word.
 *
 * A hard slice produced titles like "...as the Squad team, using y", which
 * reads as a rendering fault rather than as a prompt that is simply long.
 */
export function truncateWords(text, max) {
  const s = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  // Only back up to a word boundary if one is reasonably near the end;
  // otherwise a single very long token would collapse the whole title.
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}\u2026`;
}

/**
 * Statuses in which a session is still, as far as the hub knows, going
 * somewhere -- as opposed to `done`/`failed`/`stopped`/`disconnected`, which
 * already say the session is over.
 *
 * This is the set #225 cares about: a NON-TERMINAL session is the one that
 * can be mistaken for an actionable "Awaiting your reply" card when it is
 * really just a stale record of a device nobody can reach any more.
 */
export const NON_TERMINAL_STATUSES = new Set(['active', 'starting', 'waiting_approval', 'idle']);

/** A device the hub cannot currently reach -- `stale` counts the same as `offline`. */
export function isDeviceUnreachable(device) {
  return !!device && device.presence !== 'online';
}

/**
 * A session that LOOKS like it needs a person, but whose device cannot be
 * asked anything -- not "is this done", not "can you take input", nothing.
 *
 * Both halves matter. A non-terminal status alone is normal (plenty of
 * sessions are legitimately active on an online device); an unreachable
 * device alone is normal too (it may just have finished and gone quiet).
 * Together, the card is unanswerable: the transcript cannot load, the
 * composer cannot be verified, and `Stop` would 409. That is the state this
 * build names explicitly, rather than leaving it to read as a slow reply.
 */
export function isStaleSession(s, device) {
  if (!isDeviceUnreachable(device)) return false;
  return NON_TERMINAL_STATUSES.has(s.status) || (s.pendingApprovals || []).length > 0;
}

/** Why `Stop` cannot be used on this device right now, or '' when it can be. */
export const STOP_UNREACHABLE_REASON = 'Stop requires a live device. This device is unreachable'
  + ' — use "Forget stale session" to clear it instead.';

/**
 * What the detail header's Stop/Forget controls should look like, as a plain
 * value rather than a DOM write -- so the decision (#225's "Stop should not
 * strand the user") can be proven without a browser, the same way the list's
 * own rules are.
 *
 * `stopDisabled` fires on ANY unreachable device, not only a stale one: `Stop`
 * asks a device to end its own process, and there is nowhere for that
 * command to arrive once the socket is gone, whatever the session's status
 * says.
 *
 * `forgetVisible` is narrower on purpose. It only ever offers the cleanup
 * action for a session that is actually STUCK (`isStaleSession`) -- a
 * finished session on an offline device has nothing here to forget, and the
 * existing Tidy menu already covers that case.
 *
 * The one property that matters most: a stale session is NEVER left with
 * `stopDisabled: true` and `forgetVisible: false` at the same time. That
 * combination is exactly "only disabled controls", the dead end #225 reports.
 */
export function cleanupControls(s, device) {
  const unreachable = isDeviceUnreachable(device);
  const stale = isStaleSession(s, device);
  return {
    stopDisabled: unreachable,
    stopReason: unreachable ? STOP_UNREACHABLE_REASON : '',
    forgetVisible: stale,
  };
}

/**
 * What a session's state is CALLED.
 *
 * One source for the words, so a surface cannot invent its own name for a
 * state or fall back to printing the internal one.
 */
export function statusLabel(s, device) {
  if (isStaleSession(s, device)) return 'Unreachable — device offline';
  if ((s.pendingApprovals || []).length) return 'Needs approval';
  return {
    active: 'Working',
    starting: 'Starting',
    waiting_approval: 'Needs approval',
    idle: 'Awaiting your reply',
    done: 'Finished',
    failed: 'Failed',
    stopped: 'Stopped',
    disconnected: 'Device disconnected',
  // A status this build does not know is shown as it came, rather than as
  // "Unknown": the raw name at least says which state it is. Every caller
  // escapes it.
  }[s.status] || String(s.status == null ? '' : s.status);
}

export function statusBadge(s, device) {
  // Outranks even "Needs approval": a card nobody can answer must never be
  // confused for one that is merely waiting on a person, which is the exact
  // bug #225 reports -- a stale ACA job read as a live, actionable prompt.
  if (isStaleSession(s, device)) return '<span class="status stale">Unreachable</span>';
  const pending = (s.pendingApprovals || []).length > 0;
  if (pending) return '<span class="status attention">Needs approval</span>';
  // Named for the ACTION each one wants, because both of these used to read as
  // a demand and neither said what it wanted. A session blocked on an approval
  // cannot continue until somebody decides; a session waiting for a reply is
  // not blocking anything and may be left alone.
  const cls = {
    active: 'active',
    starting: 'active',
    waiting_approval: 'attention',
    idle: 'review',
    done: '',
    failed: 'failed',
    stopped: '',
  };
  const label = statusLabel(s, device);
  return `<span class="status ${cls[s.status] || ''}">${esc(label)}</span>`;
}

/**
 * The status PILL used on the full-page session detail header.
 *
 * Shares its words and its state mapping with `statusBadge` -- one source for
 * "what is this status called" and "how urgent is it", so the pill on the
 * header and the badge on the row can never disagree about the same session.
 * Returns only the class; the element and its leading dot are styled in CSS
 * (`.dt-pill`), because the dot is decorative and must not be read out by a
 * screen reader twice.
 */
export function statusPillClass(s) {
  const pending = (s.pendingApprovals || []).length > 0;
  if (pending) return 'attention';
  return {
    active: 'active',
    starting: 'active',
    waiting_approval: 'attention',
    idle: 'review',
    done: '',
    failed: 'failed',
    stopped: '',
  }[s.status] || '';
}

/**
 * The live activity line.
 *
 * A blocked session is described as waiting even if the last update it
 * received said otherwise, because the row must never look busy while nothing
 * is happening. Everything else is the agent's own reported activity.
 */
export function activityLine(s, device) {
  // Checked first: a session read as "waiting for input" when the device that
  // would deliver that input cannot be reached is the exact shape of #225 --
  // it tells the reader someone is needed, when nobody can do anything here
  // until the device itself comes back.
  if (isStaleSession(s, device)) return 'Device unreachable — nothing to answer here';
  const pending = (s.pendingApprovals || []).length > 0;
  if (pending || s.status === 'waiting_approval') return 'Waiting for input';
  return s.activity || '';
}

/**
 * The most recent resolution of a request someone was asked to approve.
 *
 * Answered and expired are folded into one line because they answer the same
 * question -- "what happened to that card?" -- and showing both at once would
 * be two answers to it. The newest wins.
 */
/**
 * A list field from a session, whatever the device actually sent.
 *
 * `|| []` is not enough and that is the whole point: a COUNT is truthy, so an
 * older device publishing `expiredApprovals: 3` sailed past the guard and threw
 * `.map is not a function` -- inside render(), which stopped the entire UI from
 * drawing and left the connection indicator stuck on "connecting".
 *
 * The store normalizes this on ingest now. This stays anyway: a viewer that
 * cannot survive one odd field from one device is a viewer that any device can
 * take down.
 */
export function asList(v) {
  return Array.isArray(v) ? v : [];
}

export function lastApprovalOutcome(s) {
  const answered = asList(s && s.answeredApprovals).map((a) => ({ ...a, kind: 'answered', at: a.answeredAt }));
  const expired = asList(s && s.expiredApprovals).map((a) => ({ ...a, kind: 'expired', at: a.expiredAt }));
  const all = [...answered, ...expired].sort((a, b) => (b.at || 0) - (a.at || 0));
  return all[0] || null;
}

export const ANSWER_VERB = { allow_once: 'Allowed', allow_always: 'Always allowed', reject_once: 'Denied' };

/**
 * What agent and model this session is ACTUALLY running, and whether that is
 * what was asked for.
 *
 * The row used to print the request and call it the answer. That was true for
 * as long as nothing could refuse a request, and nothing could refuse a
 * request only because the request was never being made: `--agent` on the
 * command line is silently ignored by `copilot --acp`. Every session reported
 * the agent it wanted while running the default one.
 *
 * So: `applied` is what the agent process granted. When it disagrees with the
 * request, the row says so, because a session quietly running a different
 * agent to the one named on it is worse than one that admits it.
 */
export function agentLabel(s) {
  const want = s.agentSelection;
  const got = s.applied;
  if (!want) return { text: s.agent || 'Copilot CLI', mismatch: false };

  // NOTHING WAS ACTUALLY SELECTED. The default agent, no model, chosen because
  // no rule applied -- so "default — default" spends a column saying nothing,
  // twice. What the agent actually IS answers a question someone might have.
  if ((!want.agent || want.agent === 'default') && !want.model && !want.mode && want.source === 'default') {
    return { text: s.agent || 'Copilot CLI', mismatch: false };
  }

  // The mode is named only when it is not the default, because "agent mode" is
  // what happens anyway and a row that says so on every session is noise.
  // Autopilot and plan change what a person should expect to be asked, so those
  // are worth a word.
  const modeLabel = want.mode && want.mode !== 'agent' ? `, ${want.mode}` : '';
  const asked = `${want.agent}${want.model ? ` (${want.model})` : ''}${modeLabel}`;
  // No `applied` at all means an older device that predates the fix. Report the
  // request without dressing it up as confirmation.
  if (!got) return { text: `${asked} — ${want.source}`, mismatch: false };

  const wantedAgent = want.agent && want.agent !== 'default';
  const agentOk = !wantedAgent || (got.agent && String(got.agent).toLowerCase() === String(want.agent).toLowerCase());
  const modelOk = !want.model || (got.model && String(got.model).toLowerCase() === String(want.model).toLowerCase());
  // A mode that was asked for and not applied matters MORE than the others:
  // someone who chose autopilot and silently got interactive is waiting for a
  // session that is waiting for them.
  const modeOk = !want.mode || (got.mode
    && String(got.mode).toLowerCase().includes(String(want.mode).toLowerCase()));
  if (agentOk && modelOk && modeOk) return { text: `${asked} — ${want.source}`, mismatch: false };

  const running = [got.agent || 'default agent', got.model, got.mode].filter(Boolean).join(' ');
  return { text: `running ${running}, not ${asked}`, mismatch: true };
}

/** Action-needed first, then most recently started. */
export function sessionSort(a, b) {
  const an = (a.pendingApprovals || []).length > 0 || a.status === 'waiting_approval';
  const bn = (b.pendingApprovals || []).length > 0 || b.status === 'waiting_approval';
  if (an !== bn) return an ? -1 : 1;
  return (b.startedAt || 0) - (a.startedAt || 0);
}

