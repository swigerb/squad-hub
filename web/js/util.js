export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (id) => document.getElementById(id);

let toastTimer = null;
export function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

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
 * What a session's state is CALLED.
 *
 * One source for the words, so a surface cannot invent its own name for a
 * state or fall back to printing the internal one.
 */
export function statusLabel(s) {
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

export function statusBadge(s) {
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
  const label = statusLabel(s);
  return `<span class="status ${cls[s.status] || ''}">${esc(label)}</span>`;
}

/**
 * The live activity line.
 *
 * A blocked session is described as waiting even if the last update it
 * received said otherwise, because the row must never look busy while nothing
 * is happening. Everything else is the agent's own reported activity.
 */
export function activityLine(s) {
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
 * The store normalises this on ingest now. This stays anyway: a viewer that
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

