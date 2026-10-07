import { esc, num, timeCell, activityLine, lastApprovalOutcome, ANSWER_VERB, agentLabel, statusBadge } from './util.js';

// ---------------------------------------------------------------------------
// List controls.
//
// Every function below is PURE: state in, a plain value out, no DOM and no
// `state` global. That is not tidiness for its own sake -- it is what lets the
// filtering and sorting rules be proven in Node without a browser, and it is
// the only reason a mutation can be pointed at them at all.
// ---------------------------------------------------------------------------

/** Time windows, as milliseconds. `null` means "no limit". */
export const TIME_WINDOWS = {
  '': { label: 'Any time', ms: null },
  '24h': { label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  '30d': { label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
};

export const SORTS = {
  started_desc: { label: 'Started ↓', compare: (a, b) => (b.startedAt || 0) - (a.startedAt || 0) },
  started_asc: { label: 'Started ↑', compare: (a, b) => (a.startedAt || 0) - (b.startedAt || 0) },
  tools_desc: { label: 'Most tool calls', compare: (a, b) => (b.toolCallCount || 0) - (a.toolCallCount || 0) },
  repository: {
    label: 'Repository',
    compare: (a, b) => String(sessionRepo(a) || '').localeCompare(String(sessionRepo(b) || '')),
  },
};

export const GROUPINGS = { device: 'Device', repository: 'Repository', none: 'No grouping' };

/**
 * Is this session blocked on a person?
 *
 * One definition, used by the badge, the row edge, the ordering and the
 * filters alike. Three copies of this predicate is three chances for the badge
 * and the sort to disagree about the same row.
 */
export function needsAttention(s) {
  return (s.pendingApprovals || []).length > 0 || s.status === 'waiting_approval';
}

/** What a session is working ON, preferring the repository over a local path. */
export function sessionRepo(s) {
  if (s && s.git && s.git.repository) return s.git.repository;
  if (s && s.squad && s.squad.project) return s.squad.project;
  return (s && s.cwd) || '';
}

/** The organisation half of `owner/repo`, or '' when there is no owner. */
export function sessionOrg(s) {
  const repo = sessionRepo(s);
  const i = repo.indexOf('/');
  return i > 0 ? repo.slice(0, i) : '';
}

/**
 * Started within the window.
 *
 * A session with no start time is KEPT rather than filtered out. A time filter
 * exists to hide old things, and "we do not know when this started" is not
 * evidence that it is old -- dropping it would make a live session vanish from
 * a list because of a missing field.
 */
export function withinWindow(s, key, now = Date.now()) {
  const w = TIME_WINDOWS[key || ''];
  if (!w || w.ms == null) return true;
  if (!s.startedAt) return true;
  return (now - s.startedAt) <= w.ms;
}

/** Case-insensitive substring match, with an empty filter matching everything. */
export function matchesText(value, needle) {
  if (!needle) return true;
  return String(value || '').toLowerCase().includes(String(needle).toLowerCase());
}

/**
 * Every client-side filter, applied together.
 *
 * A session blocked on a person is NEVER filtered out by the time window.
 * Someone is waiting on an answer; hiding that row because the session started
 * yesterday turns a filter into a way to lose work, which is the one thing a
 * dashboard for paused agents must not do.
 */
export function matchesFilters(s, f = {}, now = Date.now()) {
  if (!matchesText(sessionRepo(s), f.repo)) return false;
  if (f.org && sessionOrg(s) !== f.org) return false;
  if (!needsAttention(s) && !withinWindow(s, f.window, now)) return false;
  return true;
}

/** A stable identity for a session across refreshes, for pinning. */
export function sessionKey(s) {
  return s.key || s.id || '';
}

/**
 * Sort, with attention first regardless of the chosen key.
 *
 * The sort control orders the list; it does not get to bury a session that
 * cannot proceed without a person. `Started ↑` would otherwise push a blocked
 * session to the bottom precisely because it has been blocked a while.
 */
export function sortSessions(list, key = 'started_desc') {
  const sort = SORTS[key] || SORTS.started_desc;
  return [...list].sort((a, b) => {
    const an = needsAttention(a);
    const bn = needsAttention(b);
    if (an !== bn) return an ? -1 : 1;
    return sort.compare(a, b);
  });
}

/** Every organisation present, for the scope dropdown. Sorted, deduplicated. */
export function organizationsIn(groups = []) {
  const set = new Set();
  for (const g of groups) for (const s of g.sessions || []) {
    const org = sessionOrg(s);
    if (org) set.add(org);
  }
  return [...set].sort();
}

/** Every repository present, for the repository dropdown. */
export function repositoriesIn(groups = []) {
  const set = new Set();
  for (const g of groups) for (const s of g.sessions || []) {
    const repo = sessionRepo(s);
    if (repo) set.add(repo);
  }
  return [...set].sort();
}

/**
 * The whole list, as sections ready to render.
 *
 * Pinned sessions are lifted into their own section and do NOT appear again
 * below -- a starred row shown twice makes the list longer, not clearer.
 * Pinning also outranks the time window: a person pinned it, so it stays until
 * they unpin it.
 */
export function buildView({ groups = [], filters = {}, favorites = [], groupBy = 'device', sortBy = 'started_desc', now = Date.now() } = {}) {
  const pinnedKeys = new Set(favorites);
  const pinned = [];
  const rest = [];

  for (const g of groups) {
    for (const s of g.sessions || []) {
      const entry = { session: s, device: g.device };
      if (pinnedKeys.has(sessionKey(s))) { pinned.push(entry); continue; }
      if (matchesFilters(s, filters, now)) rest.push(entry);
    }
  }

  const sortEntries = (entries) => {
    const sorted = sortSessions(entries.map((e) => e.session), sortBy);
    const byKey = new Map(entries.map((e) => [sessionKey(e.session), e]));
    return sorted.map((s) => byKey.get(sessionKey(s))).filter(Boolean);
  };

  const sections = [];
  if (pinned.length) {
    sections.push({ key: '__pinned', label: 'Pinned', pinned: true, entries: sortEntries(pinned) });
  }

  if (groupBy === 'none') {
    if (rest.length) sections.push({ key: '__all', label: 'All sessions', entries: sortEntries(rest) });
    return { sections, counts: { pinned: pinned.length, shown: pinned.length + rest.length } };
  }

  const keyOf = groupBy === 'repository'
    ? (e) => sessionRepo(e.session) || 'No repository'
    : (e) => (e.device && e.device.name) || 'Unknown device';

  const buckets = new Map();
  for (const e of rest) {
    const k = keyOf(e);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }

  // A group holding a blocked session floats up, on the same rule as the rows
  // inside it. Otherwise the list is sorted by name, which is stable across
  // refreshes -- a list that reshuffles under the cursor is unusable.
  const names = [...buckets.keys()].sort((a, b) => {
    const an = buckets.get(a).some((e) => needsAttention(e.session));
    const bn = buckets.get(b).some((e) => needsAttention(e.session));
    if (an !== bn) return an ? -1 : 1;
    return a.localeCompare(b);
  });

  for (const name of names) {
    const entries = sortEntries(buckets.get(name));
    sections.push({
      key: name,
      label: name,
      device: groupBy === 'device' ? (entries[0] && entries[0].device) || null : null,
      entries,
    });
  }

  return { sections, counts: { pinned: pinned.length, shown: pinned.length + rest.length } };
}

export function sessionRow(s, deviceName, opts = {}) {
  const pending = needsAttention(s);
  const pinned = !!opts.pinned;
  const title = (s.prompt || s.id).slice(0, 70);
  const sq = s.squad;
  const sel = s.agentSelection;
  const git = s.git;
  const outcome = lastApprovalOutcome(s);
  const agentInfo = agentLabel(s);
  // `sel` (session.agentSelection), `git` (repository/branch read from the
  // session's own checkout) and `deviceName`/`sq.project`/`s.cwd` all
  // ultimately trace back to attacker-influenceable input: a project's own
  // `.squad-hub.json` (agent/model), a `.git/config` remote or branch name, a
  // device's self-reported name, or a relayed hub's session/device records.
  // None of it is trusted HTML, so every field landing in this string gets
  // `esc()`'d -- a stored payload (e.g. an `agent` of `<img src=x onerror=...>`,
  // or a branch literally named `<img src=x onerror=...>`, which git permits)
  // must render as inert text, never live markup, however it got here.
  const deviceText = esc(deviceName);
  const repoRaw = git && git.repository ? git.repository : (sq ? sq.project : s.cwd);
  const repoText = esc(repoRaw);
  // Device, repository and branch each carry a `title` with their own full
  // value. The meta line as a whole is clipped with an ellipsis by CSS once
  // it runs out of room, and a clipped field with nothing to hover is a fact
  // the row knows and simply does not tell you -- the title is what makes
  // the full value one hover away instead of a trip to the detail panel.
  const meta = [
    deviceText ? `<span class="meta-field" title="${deviceText}">${deviceText}</span>` : '',
    repoText ? `<span class="meta-field" title="${repoText}">${repoText}</span>` : '',
    git && git.branch ? `<span class="branch" title="${esc(git.branch)}">${esc(git.branch)}</span>` : '',
    sel ? `<span class="${agentInfo.mismatch ? 'agent-mismatch' : ''}">${esc(agentInfo.text)}</span>` : esc(s.agent || 'Copilot CLI'),
    s.startedAt ? timeCell(s.startedAt) : '',
    s.toolCallCount ? `${num(s.toolCallCount)} tools` : '',
  ].filter(Boolean).join(' &middot; ');

  // A Squad session is a team working under a charter, not a lone agent. The
  // badge says which, because "6 members, engineer active" is the difference
  // between a session list and a Squad session list.
  //
  // Every part is rendered ONLY when the number behind it is really there. A
  // device on an older version, or any partial payload, otherwise puts the
  // literal text "undefined/undefined members" in front of a user -- which
  // reads as a broken product rather than as missing data.
  const hasCounts = Number.isFinite(sq && sq.activeMembers) && Number.isFinite(sq && sq.memberCount);
  // `activeMember` is now `null` (no idea), `{name: null, coordinator: true}`
  // (the coordinator itself is acting) or `{name: '<member>', ...}` (a named
  // member is acting) -- three different facts, and only the named-member
  // case is worth a slot in the row. The pill already says "squad"; repeating
  // the coordinator's own name there would put SQUAD next to Squad and tell
  // the reader nothing twice, and inventing a name for "unknown" would be
  // worse than showing nothing. `inferred` (a mention, not a delegation) gets
  // a title rather than its own badge, since it is the same fact shown with
  // less confidence, not a different fact.
  const am = sq && sq.activeMember;
  const activeName = am && am.name ? am.name : '';
  const squadBits = sq ? `      <div class="squadline">
        <span class="sq-pill" title="Squad workspace">squad</span>
        ${activeName ? `<span class="sq-role"${am.inferred ? ' title="inferred, not asserted"' : ''}>${esc(activeName)}</span>` : ''}
        ${hasCounts ? `<span class="sq-dim">${num(sq.activeMembers)}/${num(sq.memberCount)} members</span>` : ''}
        ${sq.decisionCount ? `<span class="sq-dim">${num(sq.decisionCount)} decisions</span>` : ''}
        ${sq.models && !sq.models.uniform ? '<span class="sq-warn" title="Members are not all on the same model">mixed models</span>' : ''}
      </div>` : '';

  return `
    <div class="row ${pending ? 'attention' : ''}" data-session="${esc(s.key)}">
      <button class="star ${pinned ? 'on' : ''}" data-star="${esc(sessionKey(s))}"
              title="${pinned ? 'Unpin this session' : 'Pin this session'}"
              aria-label="${pinned ? 'Unpin' : 'Pin'}" aria-pressed="${pinned ? 'true' : 'false'}">${pinned ? '★' : '☆'}</button>
      <div class="row-main">
        <div class="row-title">
          <b>${esc(title)}</b>
          <span class="activity">${esc(activityLine(s))}</span>
        </div>
        <div class="row-meta">${meta}</div>
        ${outcome ? (outcome.kind === 'expired'
    ? `<div class="expiredline"><span class="status expired">Expired</span><span class="sq-dim">${esc(outcome.title)} — ${outcome.reason === 'device disconnected' ? 'the device disconnected before anyone answered' : 'nobody answered in time'}</span></div>`
    : `<div class="expiredline"><span class="status answered">${esc(ANSWER_VERB[outcome.optionId] || 'Answered')}</span><span class="sq-dim">${esc(outcome.title)} — by ${esc(outcome.answeredBy)}</span></div>`) : ''}
        ${squadBits}
      </div>
      ${statusBadge(s)}
    </div>`;
}

/**
 * Placeholder rows shown before the first overview has arrived.
 *
 * Not the word "loading…" sitting alone in an otherwise-empty box: a lone
 * sentence reads as a near-blank page for the second it takes real rows to
 * arrive, while shapes the size of the rows about to appear read as "the page
 * is already here, just not filled in yet". `aria-hidden` because there is
 * nothing here worth a screen reader announcing -- the real rows that replace
 * this carry their own labels, and this is gone by the time anything could act
 * on it.
 */
export function skeletonRows(n = 4) {
  return Array.from({ length: n }, () => `
    <div class="row skeleton-row" aria-hidden="true">
      <span class="skel skel-star"></span>
      <div class="row-main">
        <div class="skel skel-line skel-title"></div>
        <div class="skel skel-line skel-meta"></div>
      </div>
    </div>`).join('');
}

