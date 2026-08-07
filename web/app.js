/* Squad Hub web client.
 *
 * No framework and no build step. This is a control surface for a developer
 * tool -- it should be readable, forkable, and servable from the same process
 * as the API, without a toolchain standing between a contributor and a change.
 *
 * Live updates arrive over the same WebSocket the daemons use, on a watcher
 * connection. Control actions go over REST, because a command that must be
 * acknowledged deserves a status code.
 */

'use strict';

const state = {
  token: null,
  me: null,
  overview: { devices: [], groups: [], counts: {} },
  filters: { q: '', status: '', device: '', repo: '', org: '', window: '' },
  groupBy: 'device',
  sortBy: 'started_desc',
  railCollapsed: false,
  // Pinned sessions survive a reload; a star that forgets itself is not a
  // favourite, it is a highlight.
  favorites: new Set(),
  ws: null,
  currentSession: null,
  seenApprovals: new Set(),
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Token. In dev mode the service hands one out; with Entra, MSAL supplies it.
// ---------------------------------------------------------------------------
function loadToken() {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    localStorage.setItem('squad-hub-token', fromUrl);
    history.replaceState({}, '', location.pathname);
    return fromUrl;
  }
  return localStorage.getItem('squad-hub-token');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error((body && body.error) || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
/**
 * The badge a row carries.
 *
 * `Action needed` outranks the status entirely: a session blocked on a person
 * is the only row that cannot make progress on its own, so it must never be
 * described as merely `Active`.
 *
 * A finished session reads as `Ready for review` rather than `Done`. Nothing
 * about it is done from the watcher's side -- the work is sitting there
 * waiting to be looked at, and a badge that says `Done` invites people to
 * scroll past it.
 */
function statusBadge(s) {
  const pending = (s.pendingApprovals || []).length > 0;
  if (pending) return '<span class="status attention">Action needed</span>';
  const map = {
    active: ['active', 'Active'],
    starting: ['active', 'Starting'],
    waiting_approval: ['attention', 'Action needed'],
    done: ['review', 'Ready for review'],
    failed: ['failed', 'Failed'],
    stopped: ['', 'Stopped'],
  };
  const [cls, label] = map[s.status] || ['', s.status];
  return `<span class="status ${cls}">${esc(label)}</span>`;
}

/**
 * The live activity line.
 *
 * A blocked session is described as waiting even if the last update it
 * received said otherwise, because the row must never look busy while nothing
 * is happening. Everything else is the agent's own reported activity.
 */
function activityLine(s) {
  const pending = (s.pendingApprovals || []).length > 0;
  if (pending || s.status === 'waiting_approval') return 'Waiting for input';
  return s.activity || '';
}

/** Action-needed first, then most recently started. */
function sessionSort(a, b) {
  const an = (a.pendingApprovals || []).length > 0 || a.status === 'waiting_approval';
  const bn = (b.pendingApprovals || []).length > 0 || b.status === 'waiting_approval';
  if (an !== bn) return an ? -1 : 1;
  return (b.startedAt || 0) - (a.startedAt || 0);
}

// ---------------------------------------------------------------------------
// List controls.
//
// Every function below is PURE: state in, a plain value out, no DOM and no
// `state` global. That is not tidiness for its own sake -- it is what lets the
// filtering and sorting rules be proven in Node without a browser, and it is
// the only reason a mutation can be pointed at them at all.
// ---------------------------------------------------------------------------

/** Time windows, as milliseconds. `null` means "no limit". */
const TIME_WINDOWS = {
  '': { label: 'Any time', ms: null },
  '24h': { label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  '30d': { label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
};

const SORTS = {
  started_desc: { label: 'Started ↓', compare: (a, b) => (b.startedAt || 0) - (a.startedAt || 0) },
  started_asc: { label: 'Started ↑', compare: (a, b) => (a.startedAt || 0) - (b.startedAt || 0) },
  tools_desc: { label: 'Most tool calls', compare: (a, b) => (b.toolCallCount || 0) - (a.toolCallCount || 0) },
  repository: {
    label: 'Repository',
    compare: (a, b) => String(sessionRepo(a) || '').localeCompare(String(sessionRepo(b) || '')),
  },
};

const GROUPINGS = { device: 'Device', repository: 'Repository', none: 'No grouping' };

/**
 * Is this session blocked on a person?
 *
 * One definition, used by the badge, the row edge, the ordering and the
 * filters alike. Three copies of this predicate is three chances for the badge
 * and the sort to disagree about the same row.
 */
function needsAttention(s) {
  return (s.pendingApprovals || []).length > 0 || s.status === 'waiting_approval';
}

/** What a session is working ON, preferring the repository over a local path. */
function sessionRepo(s) {
  if (s && s.git && s.git.repository) return s.git.repository;
  if (s && s.squad && s.squad.project) return s.squad.project;
  return (s && s.cwd) || '';
}

/** The organisation half of `owner/repo`, or '' when there is no owner. */
function sessionOrg(s) {
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
function withinWindow(s, key, now = Date.now()) {
  const w = TIME_WINDOWS[key || ''];
  if (!w || w.ms == null) return true;
  if (!s.startedAt) return true;
  return (now - s.startedAt) <= w.ms;
}

/** Case-insensitive substring match, with an empty filter matching everything. */
function matchesText(value, needle) {
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
function matchesFilters(s, f = {}, now = Date.now()) {
  if (!matchesText(sessionRepo(s), f.repo)) return false;
  if (f.org && sessionOrg(s) !== f.org) return false;
  if (!needsAttention(s) && !withinWindow(s, f.window, now)) return false;
  return true;
}

/** A stable identity for a session across refreshes, for pinning. */
function sessionKey(s) {
  return s.key || s.id || '';
}

/**
 * Sort, with attention first regardless of the chosen key.
 *
 * The sort control orders the list; it does not get to bury a session that
 * cannot proceed without a person. `Started ↑` would otherwise push a blocked
 * session to the bottom precisely because it has been blocked a while.
 */
function sortSessions(list, key = 'started_desc') {
  const sort = SORTS[key] || SORTS.started_desc;
  return [...list].sort((a, b) => {
    const an = needsAttention(a);
    const bn = needsAttention(b);
    if (an !== bn) return an ? -1 : 1;
    return sort.compare(a, b);
  });
}

/** Every organisation present, for the scope dropdown. Sorted, deduplicated. */
function organizationsIn(groups = []) {
  const set = new Set();
  for (const g of groups) for (const s of g.sessions || []) {
    const org = sessionOrg(s);
    if (org) set.add(org);
  }
  return [...set].sort();
}

/** Every repository present, for the repository dropdown. */
function repositoriesIn(groups = []) {
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
function buildView({ groups = [], filters = {}, favorites = [], groupBy = 'device', sortBy = 'started_desc', now = Date.now() } = {}) {
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

function sessionRow(s, deviceName, opts = {}) {
  const pending = needsAttention(s);
  const pinned = !!opts.pinned;
  const title = (s.prompt || s.id).slice(0, 70);
  const sq = s.squad;
  const sel = s.agentSelection;
  const git = s.git;
  // `sel` (session.agentSelection), `git` (repository/branch read from the
  // session's own checkout) and `deviceName`/`sq.project`/`s.cwd` all
  // ultimately trace back to attacker-influenceable input: a project's own
  // `.squad-hub.json` (agent/model), a `.git/config` remote or branch name, a
  // device's self-reported name, or a relayed hub's session/device records.
  // None of it is trusted HTML, so every field landing in this string gets
  // `esc()`'d -- a stored payload (e.g. an `agent` of `<img src=x onerror=...>`,
  // or a branch literally named `<img src=x onerror=...>`, which git permits)
  // must render as inert text, never live markup, however it got here.
  const meta = [
    esc(deviceName),
    git && git.repository ? esc(git.repository) : esc(sq ? sq.project : s.cwd),
    git && git.branch ? `<span class="branch">${esc(git.branch)}</span>` : '',
    sel ? `${esc(sel.agent)}${sel.model ? ` (${esc(sel.model)})` : ''} — ${esc(sel.source)}` : esc(s.agent || 'Copilot CLI'),
    s.startedAt ? ago(s.startedAt) : '',
    s.toolCallCount ? `${s.toolCallCount} tools` : '',
  ].filter(Boolean).join(' &middot; ');

  // A Squad session is a team working under a charter, not a lone agent. The
  // badge says which, because "6 members, engineer active" is the difference
  // between a session list and a Squad session list.
  const squadBits = sq ? `
      <div class="squadline">
        <span class="sq-pill" title="Squad workspace">squad</span>
        ${sq.activeMember ? `<span class="sq-role">${esc(sq.activeMember.name)}</span>` : ''}
        <span class="sq-dim">${sq.activeMembers}/${sq.memberCount} members</span>
        ${sq.decisionCount ? `<span class="sq-dim">${sq.decisionCount} decisions</span>` : ''}
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
        ${squadBits}
      </div>
      ${statusBadge(s)}
    </div>`;
}

// ---------------------------------------------------------------------------
// The device roster.
//
// Pure, for the same reason the list controls are: ordering and presence
// wording are rules, and a rule that only exists inside a DOM callback cannot
// be proven.
// ---------------------------------------------------------------------------

const PLATFORM_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', freebsd: 'FreeBSD', aix: 'AIX', sunos: 'SunOS' };

/** A platform a person recognises, rather than the Node identifier. */
function platformLabel(p) {
  return PLATFORM_LABEL[p] || (p ? String(p) : 'Unknown');
}

/**
 * Presence as words, with the last-seen time when it matters.
 *
 * An offline device without a last-seen time reads as "Offline" alone rather
 * than "Offline, seen never" -- the second says less and looks broken.
 */
function presenceLabel(d) {
  if (!d) return '';
  if (d.presence === 'online') return 'Online';
  const label = d.presence === 'stale' ? 'Stale' : 'Offline';
  const seen = d.lastSeen ? ago(d.lastSeen) : '';
  return seen ? `${label} · seen ${seen}` : label;
}

/**
 * The roster, ordered.
 *
 * Cloud devices come first and stay first. A cloud device is on-demand and
 * always available -- it is the one place work can always be sent, whatever
 * laptops happen to be asleep -- so burying it below three offline machines
 * would hide the only useful answer to "where can I run this?".
 *
 * Within a kind: online before stale before offline, then by name. A roster
 * that reorders itself as machines drift between presences is one nobody can
 * click accurately.
 */
const PRESENCE_RANK = { online: 0, stale: 1, offline: 2 };

function deviceRoster(devices = []) {
  return [...devices].sort((a, b) => {
    const ak = a.kind === 'cloud' ? 0 : 1;
    const bk = b.kind === 'cloud' ? 0 : 1;
    if (ak !== bk) return ak - bk;
    const ap = PRESENCE_RANK[a.presence] ?? 3;
    const bp = PRESENCE_RANK[b.presence] ?? 3;
    if (ap !== bp) return ap - bp;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

/** How many devices can actually take work right now. */
function availableCount(devices = []) {
  return devices.filter((d) => d.presence !== 'offline').length;
}

/** Bytes as something a person reads, for the RAM meter. */
function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * One meter, or nothing at all.
 *
 * A device that does not report telemetry renders NO meter, rather than an
 * empty bar at zero. "Not reporting" and "idle" look identical on a bar at
 * zero, and they are entirely different facts.
 */
function meter(label, fraction, detail = '') {
  if (fraction == null || !Number.isFinite(fraction)) return '';
  const pct = Math.round(clamp01(fraction) * 100);
  const level = pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : '';
  return `
    <div class="meter ${level}" title="${esc(label)} ${pct}%${detail ? ` (${esc(detail)})` : ''}">
      <span class="meter-label">${esc(label)}</span>
      <span class="meter-track"><span class="meter-fill" style="width:${pct}%"></span></span>
      <span class="meter-value">${pct}%</span>
    </div>`;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function deviceCard(d) {
  const t = d.telemetrySample || null;
  const meters = t
    ? `<div class="meters">${meter('CPU', t.cpu)}${meter('RAM', t.mem, `${humanBytes(t.memUsedBytes)} of ${humanBytes(t.memTotalBytes)}`)}</div>`
    : '';
  return `
    <div class="device ${d.kind === 'cloud' ? 'cloud' : ''}">
      <span class="dot ${esc(d.presence)}"></span>
      <div class="device-main">
        <div class="device-name">${esc(d.name)}${d.kind === 'cloud' ? '<span class="kind-pill" title="On-demand, always available">cloud</span>' : ''}</div>
        <div class="device-meta">
          ${esc(platformLabel(d.platform))} &middot; ${esc(presenceLabel(d))} &middot; files: ${esc(d.fileAccess)}
        </div>
        ${meters}
      </div>
      <button class="add" data-spawn="${esc(d.deviceId)}" title="Start a session here">+</button>
    </div>`;
}

function render() {
  const { groups, devices, counts } = state.overview;

  $('sessionCount').textContent = `${counts.sessions || 0} session${counts.sessions === 1 ? '' : 's'}`;
  $('deviceCount').textContent = counts.devices || 0;

  const bell = counts.actionNeeded || 0;
  $('bellCount').hidden = bell === 0;
  $('bellCount').textContent = bell;
  document.title = bell ? `(${bell}) Squad Hub` : 'Squad Hub';

  // Every ordering, grouping and filtering decision is made by buildView, a
  // pure function proven in Node. This function only turns its answer into
  // markup, so a rule can never live only inside a DOM callback where nothing
  // can reach it.
  const view = buildView({
    groups,
    filters: state.filters,
    favorites: [...state.favorites],
    groupBy: state.groupBy,
    sortBy: state.sortBy,
  });

  const emptyDevices = groups
    .filter((g) => !g.sessions.length && g.device.presence !== 'offline')
    .map((g) => ({ key: g.device.name, label: g.device.name, device: g.device, entries: [] }));

  const html = [...view.sections, ...emptyDevices].map((sec) => `
    <div class="group ${sec.pinned ? 'pinned' : ''}">
      <div class="group-head">
        ${sec.device ? `<span class="dot ${sec.device.presence}"></span>` : sec.pinned ? '<span class="pin-mark">★</span>' : ''}
        ${esc(sec.label)}
        <span class="group-meta">${sec.entries.length} session${sec.entries.length === 1 ? '' : 's'}${sec.device ? ` &middot; ${esc(sec.device.platform)}` : ''}</span>
      </div>
      ${sec.entries.length
    ? `<div class="card">${sec.entries.map((e) => sessionRow(e.session, e.device ? e.device.name : '', { pinned: !!sec.pinned })).join('')}</div>`
    : ''}
    </div>`).join('');

  $('groups').innerHTML = html;
  $('empty').hidden = (counts.sessions || 0) > 0;

  // With no device online there is nothing + New could do, so say what to do
  // first rather than leaving a live button that opens a dialog with an empty
  // dropdown and fails on submit.
  const online = devices.filter((d) => d.presence !== 'offline');
  const newBtn = $('newBtn');
  newBtn.classList.toggle('needs-device', online.length === 0);
  newBtn.title = online.length ? 'Start a session' : 'Connect a device first';
  const emptyEl = $('empty');
  if (!emptyEl.hidden) {
    emptyEl.innerHTML = online.length
      ? `<h3>No sessions yet</h3><p>Start one on a device with <code>squad-hub run "…"</code>, or use <b>+ New</b> to launch one remotely.</p>`
      : `<h3>No devices connected</h3><p>A device is the machine that actually runs the agent — your laptop, a dev box, or a container.</p><p><button class="primary" id="emptyConnect">Connect a device</button></p>`;
    const ec = document.getElementById('emptyConnect');
    if (ec) ec.onclick = () => openConnect();
  }

  const roster = deviceRoster(devices);
  $('deviceList').innerHTML = `<div class="card">${roster.map(deviceCard).join('')
    || '<div class="device"><div class="device-meta">No devices yet. Run <code>squad-hub connect</code>.</div></div>'}</div>`;
  const availPill = $('deviceAvailable');
  if (availPill) {
    const avail = availableCount(devices);
    availPill.textContent = `${avail} available`;
    availPill.classList.toggle('none', avail === 0);
  }

  const sel = $('deviceFilter');
  const keep = sel.value;
  sel.innerHTML = '<option value="">All devices</option>'
    + devices.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.name)}</option>`).join('');
  sel.value = keep;

  // The repository and organisation dropdowns are built from what is actually
  // on screen, so they can never offer a scope that filters everything away.
  fillSelect($('repoFilter'), 'All repositories', repositoriesIn(groups), state.filters.repo);
  fillSelect($('orgFilter'), 'All organisations', organizationsIn(groups), state.filters.org);

  maybePromptApproval();
}

/**
 * Repopulate a select without losing the current choice.
 *
 * A value that is no longer on offer is KEPT as an option rather than silently
 * dropped: a repository whose last session just ended would otherwise reset
 * the filter to "all" underneath the person using it.
 */
function fillSelect(el, allLabel, values, current) {
  if (!el) return;
  const list = current && !values.includes(current) ? [...values, current].sort() : values;
  el.innerHTML = `<option value="">${esc(allLabel)}</option>`
    + list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  el.value = current || '';
}

/**
 * Surface a waiting approval as soon as it appears. The whole point of the
 * product is that a paused agent finds you, rather than waiting for you to
 * notice it.
 */
function maybePromptApproval() {
  if (!$('approvalScrim').hidden) return;
  for (const g of state.overview.groups) {
    for (const s of g.sessions) {
      for (const a of s.pendingApprovals || []) {
        if (state.seenApprovals.has(a.approvalId)) continue;
        return showApproval(g.device, s, a);
      }
    }
  }
  return undefined;
}

function showApproval(device, session, approval) {
  state.seenApprovals.add(approval.approvalId);
  $('apWhere').textContent = `${device.name} · ${session.cwd || ''}`;
  $('apDesc').textContent = approval.title || 'The agent is asking to run a tool.';
  $('apCommand').textContent = approval.command || approval.title || '(no command reported)';

  const paths = approval.paths || [];
  $('apPathsWrap').hidden = paths.length === 0;
  $('apPaths').innerHTML = paths.map((p) => `<span>${esc(p)}</span>`).join('');

  const label = { allow_once: 'Allow once', allow_always: 'Always allow', reject_once: 'Deny' };
  $('apActions').innerHTML = (approval.options || []).map((o) => `
    <button class="${o.optionId === 'reject_once' ? 'ghost danger' : 'primary'}"
            data-answer="${esc(o.optionId)}">${esc(o.name || label[o.optionId] || o.optionId)}</button>`).join('');

  $('apActions').onclick = async (ev) => {
    const btn = ev.target.closest('[data-answer]');
    if (!btn || btn.disabled) return;
    for (const b of $('apActions').querySelectorAll('button')) b.disabled = true;
    try {
      await api(`/api/devices/${encodeURIComponent(device.deviceId)}/approve`, {
        method: 'POST',
        body: { sessionId: session.id, approvalId: approval.approvalId, optionId: btn.dataset.answer },
      });
      $('approvalScrim').hidden = true;
    } catch (e) {
      $('apDesc').textContent = `Could not answer: ${e.message}`;
      for (const b of $('apActions').querySelectorAll('button')) b.disabled = false;
    }
  };

  // Answering one approval can immediately reveal the next, in the same place
  // on screen. Without a moment's delay a stray second click lands on the new
  // dialog and approves a command nobody has read. Observed happening during
  // manual testing, so the buttons stay inert briefly on each new card.
  for (const b of $('apActions').querySelectorAll('button')) b.disabled = true;
  $('approvalScrim').hidden = false;
  setTimeout(() => {
    for (const b of $('apActions').querySelectorAll('button')) b.disabled = false;
  }, 350);
}

// ---------------------------------------------------------------------------
// Session detail
// ---------------------------------------------------------------------------
function findSession(key) {
  for (const g of state.overview.groups) {
    for (const s of g.sessions) if (s.key === key) return { device: g.device, session: s };
  }
  return null;
}

async function openDetail(key) {
  const found = findSession(key);
  if (!found) return;
  state.currentSession = found;
  $('dtTitle').textContent = (found.session.prompt || found.session.id).slice(0, 80);
  $('dtMeta').textContent = `${found.device.name} · ${found.session.cwd || ''} · ${found.session.status}`;
  renderSquadPanel(found.session.squad);
  $('dtTranscript').innerHTML = '<div class="t-entry t-kind">loading…</div>';
  $('detailScrim').hidden = false;
  try {
    const r = await api(`/api/devices/${encodeURIComponent(found.device.deviceId)}/transcript`, {
      method: 'POST', body: { sessionId: found.session.id, limit: 200 },
    });
    renderTranscript(r.transcript || []);
  } catch (e) {
    $('dtTranscript').innerHTML = `<div class="t-entry t-kind">could not load the transcript: ${esc(e.message)}</div>`;
  }
}

/**
 * The Squad panel: team, models, and recent decisions beside the transcript.
 *
 * Decisions are the artifact people actually go looking for after the fact --
 * "why did it do that" is answered in decisions.md, not in a tool log.
 */
function renderSquadPanel(sq) {
  const el = $('dtSquad');
  if (!sq) { el.hidden = true; return; }
  el.hidden = false;

  const models = sq.models || {};
  const modelLine = models.uniform
    ? `all on <b>${esc(models.distinctModels[0] || models.defaultModel || 'default')}</b>`
    : `<span class="sq-warn">mixed: ${esc((models.distinctModels || []).join(', '))}</span>`;

  el.innerHTML = `
    <div class="sq-head">
      <b>${esc(sq.project)}</b>
      <span class="sq-dim">${sq.activeMembers}/${sq.memberCount} members · ${modelLine}</span>
    </div>
    <div class="sq-members">
      ${sq.members.map((m) => `
        <span class="sq-member ${sq.activeMember && sq.activeMember.name === m.name ? 'now' : ''} ${m.active ? '' : 'off'}">
          ${esc(m.name)}${m.role && m.role !== m.name ? `<i>${esc(m.role)}</i>` : ''}
        </span>`).join('')}
    </div>
    ${sq.decisions.length ? `
      <div class="sq-sub">Recent decisions (${sq.decisionCount})</div>
      <ol class="sq-decisions">
        ${sq.decisions.slice(0, 5).map((d) => `
          <li class="${d.superseded ? 'old' : ''}">
            ${d.date ? `<span class="sq-date">${esc(d.date)}</span>` : ''}
            <span class="sq-title">${esc(d.title)}</span>
            ${d.summary ? `<div class="sq-why">${esc(d.summary.slice(0, 180))}${d.summary.length > 180 ? '…' : ''}</div>` : ''}
          </li>`).join('')}
      </ol>` : '<div class="sq-sub">No decisions recorded yet</div>'}`;
}

function renderTranscript(entries) {
  if (!entries.length) {
    $('dtTranscript').innerHTML = '<div class="t-entry t-kind">nothing yet</div>';
    return;
  }
  $('dtTranscript').innerHTML = entries.map((e) => {
    const u = e.update || e;
    if (u.sessionUpdate === 'tool_call') {
      return `<div class="t-entry"><span class="t-tool">tool</span> <span class="t-text">${esc(u.title || u.kind || '')}</span></div>`;
    }
    const text = (u.content && (u.content.text || u.content)) || u.text || '';
    if (!text) return `<div class="t-entry t-kind">${esc(u.sessionUpdate || 'update')}</div>`;
    return `<div class="t-entry"><span class="t-text">${esc(typeof text === 'string' ? text : JSON.stringify(text))}</span></div>`;
  }).join('');
  const el = $('dtTranscript');
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Live connection
// ---------------------------------------------------------------------------
/**
 * Keep the live view connected.
 *
 * Three things this has to get right, all of them learned the hard way:
 *
 *   BACK OFF. A fixed retry made the indicator flash connecting/down every two
 *   seconds for as long as the hub was away, which reads as a broken app rather
 *   than an absent server -- and hammers the server as it is trying to restart.
 *
 *   DO NOT RETRY A REFUSAL. If the credential is no longer accepted, trying
 *   again with the same credential never works. Go back to sign-in instead of
 *   looping forever behind a flashing badge.
 *
 *   SAY WHICH IT IS. "Reconnecting" and "the hub is not reachable" are different
 *   situations and a person can act on the second one.
 */
function connect() {
  // Cancel anything already pending, so a stray timer cannot start a second
  // socket alongside this one.
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.ws) { try { state.ws.onclose = null; state.ws.close(); } catch { /* already gone */ } }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?role=watcher&access_token=${encodeURIComponent(state.token)}`;
  const ws = new WebSocket(url);
  state.ws = ws;
  setConn(state.reconnectAttempt ? 'retrying' : 'connecting');

  ws.onopen = () => {
    state.reconnectAttempt = 0;
    setConn('live');
  };

  ws.onclose = async (ev) => {
    if (state.ws !== ws) return;   // superseded; not ours to react to

    // 1008 is a policy refusal: the hub understood us and said no. Confirm with
    // a cheap request rather than guessing, because an expired token and an
    // unreachable hub look identical from a closed socket.
    if (ev && ev.code === 1008) {
      try {
        await api('/api/me');
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          localStorage.removeItem('squad-hub-token');
          return showSignIn();
        }
      }
    }

    state.reconnectAttempt = (state.reconnectAttempt || 0) + 1;
    // 1s, 2s, 4s, 8s, capped at 30s. Quick enough that a restart is barely
    // noticed, slow enough that a long outage is not a strobe light.
    const wait = Math.min(1000 * (2 ** (state.reconnectAttempt - 1)), 30000);
    setConn(state.reconnectAttempt > 2 ? 'offline' : 'retrying');
    state.reconnectTimer = setTimeout(connect, wait);
    return undefined;
  };

  // onerror always precedes onclose, so leave the state change to onclose --
  // otherwise the badge changes twice for one event.
  ws.onerror = () => {};

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'overview') {
      state.overview = { devices: msg.devices, groups: msg.groups, counts: msg.counts };
      render();
    } else if (msg.type === 'transcript' && state.currentSession
      && msg.sessionId === state.currentSession.session.id) {
      renderTranscript(msg.entries || []);
    }
  };
}

/**
 * Show the signed-in person's avatar, or their initial.
 *
 * The initial is the FALLBACK, not a placeholder to be replaced later: if the
 * image fails -- blocked, offline, a provider with no avatar -- the initial
 * stays. A broken-image icon in the account menu would look like a bug.
 */
function setAvatar(url, name) {
  const el = $('avatar');
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  el.textContent = initial;
  el.style.backgroundImage = '';
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    el.textContent = '';
    el.style.backgroundImage = `url("${url}")`;
  };
  // No onerror handler needed beyond doing nothing: the initial is already there.
  img.src = url;
}

const CONN_LABEL = {
  live: 'live',
  connecting: 'connecting',
  retrying: 'reconnecting',
  offline: 'hub unreachable',
};

function setConn(s) {
  const el = $('conn');
  el.dataset.state = s;
  el.textContent = CONN_LABEL[s] || s;
  el.title = s === 'offline'
    ? 'The hub is not answering. This page keeps retrying; your devices are unaffected.'
    : '';
}

async function refresh() {
  const params = new URLSearchParams();
  if (state.filters.q) params.set('q', state.filters.q);
  if (state.filters.status) params.set('status', state.filters.status);
  if (state.filters.device) params.set('device', state.filters.device);
  state.overview = await api(`/api/overview?${params}`);
  render();
}

const VIEW_KEY = 'squad-hub-view';
const FAVORITES_KEY = 'squad-hub-favorites';

/**
 * List controls and pins survive a reload.
 *
 * Kept in localStorage rather than on the hub deliberately: this is how ONE
 * person likes to look at the list, not a property of the sessions. Syncing it
 * would mean a preference set on a laptop silently rearranging a phone.
 */
function loadView() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
    if (saved.repo) state.filters.repo = saved.repo;
    if (saved.org) state.filters.org = saved.org;
    if (TIME_WINDOWS[saved.window]) state.filters.window = saved.window;
    if (GROUPINGS[saved.groupBy]) state.groupBy = saved.groupBy;
    if (SORTS[saved.sortBy]) state.sortBy = saved.sortBy;
  } catch { /* a corrupt preference is not worth a broken page */ }
  try {
    const favs = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    if (Array.isArray(favs)) state.favorites = new Set(favs.filter((k) => typeof k === 'string'));
  } catch { /* same */ }
  try { state.railCollapsed = localStorage.getItem(RAIL_KEY) === '1'; } catch { /* same */ }
}

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({
      repo: state.filters.repo,
      org: state.filters.org,
      window: state.filters.window,
      groupBy: state.groupBy,
      sortBy: state.sortBy,
    }));
  } catch { /* private browsing, quota, whatever -- never fatal */ }
}

function saveFavorites() {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites])); }
  catch { /* never fatal */ }
}

function toggleFavorite(key) {
  if (!key) return;
  if (state.favorites.has(key)) state.favorites.delete(key);
  else state.favorites.add(key);
  saveFavorites();
  render();
}

/** Fill the controls from the restored state, so the UI matches what it does. */
function syncControls() {
  const set = (id, value) => { const el = $(id); if (el) el.value = value; };
  set('windowFilter', state.filters.window);
  set('groupBy', state.groupBy);
  set('sortBy', state.sortBy);
  setRailCollapsed(state.railCollapsed);
}

const RAIL_KEY = 'squad-hub-rail-collapsed';

function setRailCollapsed(collapsed) {
  state.railCollapsed = !!collapsed;
  const rail = $('deviceRail');
  const toggle = $('railToggle');
  if (rail) rail.classList.toggle('collapsed', state.railCollapsed);
  if (toggle) {
    toggle.setAttribute('aria-expanded', state.railCollapsed ? 'false' : 'true');
    toggle.title = state.railCollapsed ? 'Show the device list' : 'Collapse the device list';
  }
  try { localStorage.setItem(RAIL_KEY, state.railCollapsed ? '1' : '0'); } catch { /* never fatal */ }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  $('q').oninput = (e) => { state.filters.q = e.target.value; refresh(); };
  $('statusFilter').onchange = (e) => { state.filters.status = e.target.value; refresh(); };
  $('deviceFilter').onchange = (e) => { state.filters.device = e.target.value; refresh(); };

  // These four are client-side: they reshape what is already loaded, so they
  // re-render immediately rather than waiting on a round trip.
  $('repoFilter').onchange = (e) => { state.filters.repo = e.target.value; saveView(); render(); };
  $('orgFilter').onchange = (e) => { state.filters.org = e.target.value; saveView(); render(); };
  $('windowFilter').onchange = (e) => { state.filters.window = e.target.value; saveView(); render(); };
  $('groupBy').onchange = (e) => { state.groupBy = e.target.value; saveView(); render(); };
  $('sortBy').onchange = (e) => { state.sortBy = e.target.value; saveView(); render(); };

  $('groups').onclick = (e) => {
    // The star sits inside the row, so it must claim the click before the row
    // does -- otherwise pinning a session also opens it.
    const star = e.target.closest('[data-star]');
    if (star) {
      toggleFavorite(star.dataset.star);
      return;
    }
    const row = e.target.closest('[data-session]');
    if (row) openDetail(row.dataset.session);
  };

  $('deviceList').onclick = (e) => {
    const b = e.target.closest('[data-spawn]');
    if (b) openNew(b.dataset.spawn);
  };

  // The rail collapses, and remembers. On a narrow window it is the first
  // thing worth reclaiming, and re-collapsing it on every load would make that
  // a chore rather than a setting.
  $('railToggle').onclick = () => setRailCollapsed(!$('deviceRail').classList.contains('collapsed'));

  $('newBtn').onclick = () => openNew();
  $('cnCancel').onclick = () => { $('connectScrim').hidden = true; };
  $('cnCreate').onclick = () => createDeviceToken();
  $('cnCopy').onclick = async () => {
    toast(await copy($('cnCmd').textContent) ? 'Command copied' : 'Select and copy the command above');
  };
  $('nsCancel').onclick = () => { $('newScrim').hidden = true; };
  $('apCancel').onclick = () => { $('approvalScrim').hidden = true; };
  $('dtClose').onclick = () => { $('detailScrim').hidden = true; state.currentSession = null; };

  $('bellBtn').onclick = () => {
    state.seenApprovals.clear();
    maybePromptApproval();
  };

  $('menuBtn').onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  $('bannerClose').onclick = () => { $('banner').hidden = true; };  $('menu').onclick = (e) => {
    const b = e.target.closest('[data-menu]');
    if (b) onMenu(b.dataset.menu);
  };
  document.addEventListener('click', (e) => {
    if (!$('menu').hidden && !e.target.closest('#menu') && !e.target.closest('#menuBtn')) toggleMenu(false);
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
  });

  $('nsDevice').onchange = updateCwdHint;

  $('nsStart').onclick = async () => {
    const deviceId = $('nsDevice').value;
    const prompt = $('nsPrompt').value.trim();
    if (!prompt) { showNewErr('a prompt is required'); return; }
    $('nsStart').disabled = true;
    try {
      await api(`/api/devices/${encodeURIComponent(deviceId)}/spawn`, {
        method: 'POST', body: { prompt, cwd: $('nsCwd').value.trim() || undefined },
      });
      $('newScrim').hidden = true;
      $('nsPrompt').value = '';
      refresh();
    } catch (e) { showNewErr(e.message); }
    $('nsStart').disabled = false;
  };

  $('dtStop').onclick = async () => {
    if (!state.currentSession) return;
    const { device, session } = state.currentSession;
    try {
      await api(`/api/devices/${encodeURIComponent(device.deviceId)}/stop`, {
        method: 'POST', body: { sessionId: session.id },
      });
      $('detailScrim').hidden = true;
      refresh();
    } catch (e) { alert(`Could not stop: ${e.message}`); }
  };

  $('dtSend').onclick = async () => {
    if (!state.currentSession) return;
    const text = $('dtInput').value.trim();
    if (!text) return;
    const { device, session } = state.currentSession;
    $('dtInput').value = '';
    try {
      await api(`/api/devices/${encodeURIComponent(device.deviceId)}/steer`, {
        method: 'POST', body: { sessionId: session.id, text },
      });
    } catch (e) { alert(`Could not send: ${e.message}`); }
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    toggleMenu(false);
    for (const id of ['approvalScrim', 'newScrim', 'detailScrim']) $(id).hidden = true;
  });
}

function showNewErr(m) { $('nsErr').hidden = false; $('nsErr').textContent = m; }

/** A persistent warning the user cannot miss and can dismiss once read. */
function showBanner(text) {
  const el = $('banner');
  if (!el) return;
  $('bannerText').textContent = text;
  el.hidden = false;
}

/**
 * The menu.
 *
 * Every entry does something. A control that opens nothing, or opens a panel of
 * greyed-out labels, is worse than no control -- it is the first thing a new
 * user clicks, and it teaches them the tool is unfinished.
 */
function toggleMenu(force) {
  const m = $('menu');
  const open = force === undefined ? m.hidden : force;
  m.hidden = !open;
  $('menuBtn').setAttribute('aria-expanded', String(open));
  if (!open) return;

  const d = state.overview.devices || [];
  const online = d.filter((x) => x.presence === 'online').length;
  $('menuMeta').innerHTML = `
    Signed in as <b>${esc((state.me && state.me.name) || 'unknown')}</b><br>
    ${online} of ${d.length} device${d.length === 1 ? '' : 's'} online<br>
    ${state.overview.counts.sessions || 0} sessions ·
    ${state.overview.counts.actionNeeded || 0} needing attention`;
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard access needs a secure context and permission. Falling back to a
    // selectable prompt is better than a silent failure.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

async function onMenu(action) {
  toggleMenu(false);
  if (action === 'refresh') {
    // A real round trip, not a cosmetic toast. The page also polls and holds a
    // live socket, so this earns its place mainly when that socket has dropped.
    //
    // The feedback has to appear WHERE THE DATA IS. This used to show only a
    // toast at the bottom of the page, so someone clicking a menu at the top
    // right saw nothing at all and reasonably concluded it had done nothing.
    const stamp = $('updated');
    stamp.hidden = false;
    stamp.textContent = 'refreshing…';
    try {
      await refresh();
    } catch (e) {
      stamp.textContent = `could not refresh: ${e.message}`;
      return;
    }
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    // A moving timestamp is evidence. "Refreshed" looks identical whether or
    // not anything happened.
    stamp.textContent = `updated ${hh}:${mm}:${ss}`;
    stamp.classList.remove('flash');
    void stamp.offsetWidth;          // restart the animation
    stamp.classList.add('flash');
    const connected = state.ws && state.ws.readyState === 1;
    toast(connected ? 'Refreshed — live updates are connected' : 'Refreshed — live updates are NOT connected');
    return;
  }
  if (action === 'connect') { openConnect(); return; }
  if (action === 'install') {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      state.installPrompt = null;
      return;
    }
    toast('Use your browser\u2019s "Install app" or "Add to Home Screen" option');
    return;
  }
  if (action === 'signout') {
    // Clearing the token is the whole of signing out here: it is the only
    // credential the browser holds.
    localStorage.removeItem('squad-hub-token');
    if (state.ws) { try { state.ws.close(); } catch { /* closing */ } }
    location.replace(location.pathname);
  }
}

function openNew(deviceId) {
  const online = state.overview.devices.filter((d) => d.presence !== 'offline');

  // With no device online this dialog used to open with an EMPTY dropdown: you
  // could type a prompt, press Start, and get a failure. Offering an action
  // that cannot succeed teaches people the product is unreliable, so say what
  // is missing and how to fix it instead.
  if (!online.length) {
    openConnect();
    return;
  }

  $('nsDevice').innerHTML = online.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.name)}</option>`).join('');
  if (deviceId) $('nsDevice').value = deviceId;
  $('nsErr').hidden = true;
  updateCwdHint();
  $('newScrim').hidden = false;
  $('nsPrompt').focus();
}

/**
 * Connect a device.
 *
 * This mints a DEVICE TOKEN rather than handing out the signed-in user's own
 * credential. An earlier build copied a command containing the user token,
 * which meant following the built-in instructions produced the insecure setup:
 * a credential on a server that could also read this page's data and start work
 * on every other device.
 */
function openConnect() {
  $('cnErr').hidden = true;
  $('cnResult').hidden = true;
  $('cnCreate').disabled = false;
  $('cnCreate').textContent = 'Create token';
  $('connectScrim').hidden = false;
  $('cnLabel').focus();
}

async function createDeviceToken() {
  const btn = $('cnCreate');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  $('cnErr').hidden = true;
  try {
    const r = await api('/api/device-tokens', {
      method: 'POST',
      body: {
        label: $('cnLabel').value.trim() || null,
        didPrefix: $('cnPrefix').value.trim() || null,
        ttlHours: Number($('cnTtl').value),
      },
    });
    const cmd = `squad-hub connect --hub ${location.origin} --token ${r.token}`;
    $('cnCmd').textContent = cmd;
    $('cnResult').hidden = false;
    btn.textContent = 'Create another';
    btn.disabled = false;
  } catch (e) {
    $('cnErr').textContent = e.message;
    $('cnErr').hidden = false;
    btn.disabled = false;
    btn.textContent = 'Create token';
  }
}

/**
 * File access is a per-device opt-in. Hiding the field on a device that has not
 * opted in is honest: offering a folder picker that the daemon will refuse
 * teaches the user nothing except that the product is unreliable.
 */
function updateCwdHint() {
  const d = state.overview.devices.find((x) => x.deviceId === $('nsDevice').value);
  const on = d && d.fileAccess && d.fileAccess !== 'off';
  $('nsCwdField').hidden = !on;
  if (on) {
    $('nsCwdHint').textContent = d.fileAccess === 'scoped'
      ? 'This device allows a working directory inside its configured root.'
      : 'This device allows any working directory.';
  }
}

/**
 * The sign-in page.
 *
 * What was here before told people to "open the link printed by the server",
 * which is not a sign-in -- it is an instruction to go and find a URL somewhere
 * else. A hub you cannot log into from its own front page is a hub people paste
 * tokens around for.
 *
 * What is offered depends on what the hub actually supports, asked rather than
 * assumed: a button that leads nowhere is worse than no button.
 */
async function showSignIn() {
  let methods = { mode: 'unknown', githubOAuth: false, acceptsToken: true };
  try { methods = await (await fetch('/api/auth-methods')).json(); } catch { /* offline */ }

  const oauth = methods.githubOAuth;
  document.body.innerHTML = `
    <div class="signin">
      <img src="/logo.jpg" alt="Squad Hub">
      <h1>Squad Hub</h1>
      <p class="signin-sub">See and control your Squad sessions.</p>

      ${oauth ? `
        <a class="signin-btn" href="/auth/github/login">
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
              0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01
              1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95
              0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27
              2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15
              0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0
              .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          Sign in with GitHub
        </a>
        <div class="signin-or">or</div>
      ` : ''}

      <form class="signin-form" id="tokenForm">
        <label for="tokenInput">${oauth ? 'Use a token instead' : 'Sign in with a token'}</label>
        <input id="tokenInput" type="password" placeholder="paste a token"
               autocomplete="off" spellcheck="false">
        <button class="primary" type="submit">Continue</button>
      </form>

      <p class="signin-hint">${signInHint(methods.mode)}</p>
      <p class="err" id="signinErr" hidden></p>
    </div>`;

  document.getElementById('tokenForm').onsubmit = async (e) => {
    e.preventDefault();
    const token = document.getElementById('tokenInput').value.trim();
    if (!token) return;
    // Check the token BEFORE storing it. Saving a bad one and then failing
    // every request leaves people staring at an empty hub with no explanation.
    try {
      const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(r.status === 403
          ? (body.error || 'That account is not permitted to use this hub.')
          : 'That token was not accepted.');
      }
      localStorage.setItem('squad-hub-token', token);
      location.replace('/');
    } catch (err) {
      const el = document.getElementById('signinErr');
      el.hidden = false;
      el.textContent = err.message;
    }
  };
}

function signInHint(mode) {
  if (mode === 'github') return 'Any GitHub token works — <code>gh auth token</code> prints one.';
  if (mode === 'entra') return 'Use a Microsoft Entra ID access token for this hub.';
  return 'Use the token printed by <code>squad-hub serve</code>.';
}

// ---------------------------------------------------------------------------
(async function main() {
  state.token = loadToken();
  if (!state.token) return showSignIn();
  loadView();
  wire();
  syncControls();
  try {
    state.me = await api('/api/me');
    $('who').textContent = state.me.name || 'signed in';
    // The user's own avatar where the provider supplies one, an initial
    // otherwise. The image is set up to fall back on its own if it fails to
    // load, so a blocked or broken avatar shows the initial rather than a
    // broken-image icon.
    setAvatar(state.me.avatar, state.me.name);
    // A hub split across instances loses devices intermittently. Say so where
    // the user will notice it, not only in a log.
    if (state.me.warning) showBanner(state.me.warning);
  } catch (e) {
    // A token that no longer works should return you to sign-in, not to a dead
    // end. Expired GitHub tokens are ordinary, not exceptional.
    if (e.status === 401 || e.status === 403) {
      localStorage.removeItem('squad-hub-token');
      return showSignIn();
    }
    document.body.innerHTML = `<div class="empty"><h3>Could not sign in</h3><p>${esc(e.message)}</p></div>`;
    return undefined;
  }
  await refresh();
  connect();
  setInterval(refresh, 15000);
  return undefined;
}());
