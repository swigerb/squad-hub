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
  composer: { draft: '', control: 'unknown', reason: '' },
  theme: 'system',
  // Pinned sessions survive a reload; a star that forgets itself is not a
  // favourite, it is a highlight.
  favorites: new Set(),
  ws: null,
  currentSession: null,
  seenApprovals: new Set(),
  // Approvals a desktop notification has already been raised for. Without
  // this, every poll and every reconnect would notify again about the same
  // question.
  notified: new Set(),
  openApproval: null,
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
function exact(ms) {
  if (!ms) return '';
  try { return new Date(ms).toLocaleString(); } catch { return ''; }
}

/** Relative time to read at a glance, exact time on hover. */
function timeCell(ms, label = 'Started') {
  if (!ms) return '';
  return `<span title="${esc(label)} ${esc(exact(ms))}">${esc(ago(ms))}</span>`;
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
    // The agent is alive and waiting for a reply. This is what "Ready for
    // review" always meant -- there is output to read and the conversation can
    // continue. `done` now means the session is genuinely over.
    idle: ['review', 'Ready for review'],
    done: ['', 'Finished'],
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

/**
 * The most recent resolution of a request someone was asked to approve.
 *
 * Answered and expired are folded into one line because they answer the same
 * question -- "what happened to that card?" -- and showing both at once would
 * be two answers to it. The newest wins.
 */
function lastApprovalOutcome(s) {
  const answered = ((s && s.answeredApprovals) || []).map((a) => ({ ...a, kind: 'answered', at: a.answeredAt }));
  const expired = ((s && s.expiredApprovals) || []).map((a) => ({ ...a, kind: 'expired', at: a.expiredAt }));
  const all = [...answered, ...expired].sort((a, b) => (b.at || 0) - (a.at || 0));
  return all[0] || null;
}

const ANSWER_VERB = { allow_once: 'Allowed', allow_always: 'Always allowed', reject_once: 'Denied' };

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
function agentLabel(s) {
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
  const meta = [
    esc(deviceName),
    git && git.repository ? esc(git.repository) : esc(sq ? sq.project : s.cwd),
    git && git.branch ? `<span class="branch">${esc(git.branch)}</span>` : '',
    sel ? `<span class="${agentInfo.mismatch ? 'agent-mismatch' : ''}">${esc(agentInfo.text)}</span>` : esc(s.agent || 'Copilot CLI'),
    s.startedAt ? timeCell(s.startedAt) : '',
    s.toolCallCount ? `${s.toolCallCount} tools` : '',
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
  // The pill already says "squad". When the active member is the coordinator --
  // which is literally named "Squad" -- repeating it puts SQUAD next to Squad
  // and tells the reader nothing twice. Named members (lead, engineer) still
  // show, because which one is working IS the useful fact.
  const rawActive = sq && sq.activeMember && sq.activeMember.name;
  const activeName = rawActive && String(rawActive).toLowerCase() !== 'squad' ? rawActive : '';
  const squadBits = sq ? `      <div class="squadline">
        <span class="sq-pill" title="Squad workspace">squad</span>
        ${activeName ? `<span class="sq-role">${esc(activeName)}</span>` : ''}
        ${hasCounts ? `<span class="sq-dim">${sq.activeMembers}/${sq.memberCount} members</span>` : ''}
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
        ${outcome ? (outcome.kind === 'expired'
    ? `<div class="expiredline"><span class="status expired">Expired</span><span class="sq-dim">${esc(outcome.title)} — nobody answered in time</span></div>`
    : `<div class="expiredline"><span class="status answered">${esc(ANSWER_VERB[outcome.optionId] || 'Answered')}</span><span class="sq-dim">${esc(outcome.title)} — by ${esc(outcome.answeredBy)}</span></div>`) : ''}
        ${squadBits}
      </div>
      ${statusBadge(s)}
    </div>`;
}

// ---------------------------------------------------------------------------
// Approval depth.
//
// An approval card that says only "the agent wants to run a tool" makes every
// decision look the same. Reading a file and rewriting a directory are not the
// same decision, and the card has to say which one is on the table.
// ---------------------------------------------------------------------------

/**
 * What an approval actually touches, as rows.
 *
 * The tool first, then every path it named. Each row carries whether it is
 * read-only, because that is the single fact that most changes the answer.
 * The flag is decided on the device, from the agent's declared tool kind and,
 * for a shell call, from the command itself -- every shell call arrives as one
 * kind, so the kind alone cannot tell `git status` from `rm -rf`.
 */
function approvalRows(approval) {
  if (!approval) return [];
  const readOnly = !!approval.readOnly;
  const rows = [{
    kind: 'tool',
    label: approval.command || approval.title || 'an unnamed tool',
    readOnly,
  }];
  for (const p of approval.paths || []) {
    rows.push({ kind: 'path', label: String(p), readOnly });
  }
  return rows;
}

/**
 * Is this approval read-only in its entirety?
 *
 * Used to soften the card. A mixed approval is treated as NOT read-only: one
 * writing path in a list of reads is still a write, and the badge has to
 * reflect the riskiest thing in the request rather than the average.
 */
function approvalIsReadOnly(approval) {
  const rows = approvalRows(approval);
  return rows.length > 0 && rows.every((r) => r.readOnly);
}

// ---------------------------------------------------------------------------
// Readable dropdowns
//
// A native <select>'s OPEN LIST is drawn by the operating system, not by this
// stylesheet. `option { background }` is honoured by some engines, ignored by
// others, and on Windows the popup comes back white with white separators
// whatever the page asks for -- which is why the dark theme's dropdowns were
// unreadable no matter how the options were styled.
//
// So the popup is replaced, and ONLY the popup. The native <select> stays in
// the DOM as the value, the change event and the form control: every existing
// caller still reads `sel.value`, still writes `sel.innerHTML`, and still
// listens for `change`. The list below is built FROM the select each time it
// opens, so options added later need no re-registration, and every choice is
// written back through the select so nothing downstream can tell the
// difference.
// ---------------------------------------------------------------------------

/** The label a select currently shows. */
function selectedText(select) {
  const o = select.options[select.selectedIndex];
  return o ? o.text : '';
}

function enhanceSelect(select) {
  const pill = select.closest('.selectpill');
  if (!pill || pill.dataset.enhanced) return;
  pill.dataset.enhanced = '1';

  const value = document.createElement('span');
  value.className = 'sp-value';
  pill.insertBefore(value, select);

  // The native control keeps the value but stops taking focus, so there is one
  // tab stop rather than two for one control.
  select.setAttribute('tabindex', '-1');
  select.setAttribute('aria-hidden', 'true');

  pill.setAttribute('role', 'combobox');
  pill.setAttribute('aria-haspopup', 'listbox');
  pill.setAttribute('aria-expanded', 'false');
  pill.setAttribute('tabindex', '0');
  if (select.getAttribute('aria-label')) pill.setAttribute('aria-label', select.getAttribute('aria-label'));

  const list = document.createElement('div');
  list.className = 'sp-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  pill.appendChild(list);

  const sync = () => { value.textContent = selectedText(select); };
  sync();
  select.addEventListener('change', sync);

  function build() {
    list.innerHTML = '';
    [...select.options].forEach((o, i) => {
      const row = document.createElement('div');
      row.className = 'sp-opt';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === select.selectedIndex));
      row.dataset.index = String(i);
      row.textContent = o.text;
      list.appendChild(row);
    });
  }

  function open(on) {
    if (on) {
      build();
      closeAllSelectPills(pill);
    }
    list.hidden = !on;
    pill.setAttribute('aria-expanded', String(on));
    pill.classList.toggle('open', on);
    if (on) {
      const sel = list.querySelector('[aria-selected="true"]');
      if (sel) sel.classList.add('active');
    }
  }

  function choose(index) {
    if (index < 0 || index >= select.options.length) return;
    if (index !== select.selectedIndex) {
      select.selectedIndex = index;
      // Dispatched so every existing `onchange` handler runs exactly as it did
      // when the native popup was doing the choosing.
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync();
    open(false);
    pill.focus();
  }

  pill.addEventListener('click', (e) => {
    const opt = e.target.closest('.sp-opt');
    if (opt) { choose(Number(opt.dataset.index)); return; }
    open(list.hidden);
  });

  // The keyboard's highlight and the pointer's must be the SAME highlight.
  // Without this, opening the list marks the current value and then hovering
  // another row lights up a second one, so two rows claim to be the choice.
  list.addEventListener('mousemove', (e) => {
    const opt = e.target.closest('.sp-opt');
    if (!opt || opt.classList.contains('active')) return;
    for (const o of list.querySelectorAll('.sp-opt.active')) o.classList.remove('active');
    opt.classList.add('active');
  });

  pill.addEventListener('keydown', (e) => {
    const opts = [...list.querySelectorAll('.sp-opt')];
    const active = list.querySelector('.sp-opt.active');
    const at = active ? opts.indexOf(active) : select.selectedIndex;
    if (e.key === 'Escape') { if (!list.hidden) { open(false); e.preventDefault(); } return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (list.hidden) open(true); else choose(at);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) { open(true); return; }
      const next = Math.min(opts.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
      opts.forEach((o) => o.classList.remove('active'));
      if (opts[next]) { opts[next].classList.add('active'); opts[next].scrollIntoView({ block: 'nearest' }); }
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      if (list.hidden) return;
      e.preventDefault();
      opts.forEach((o) => o.classList.remove('active'));
      const t = e.key === 'Home' ? opts[0] : opts[opts.length - 1];
      if (t) { t.classList.add('active'); t.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    // Type-ahead, because a list you can only arrow through is slower than the
    // control it replaced.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (list.hidden) open(true);
      const ch = e.key.toLowerCase();
      const from = at + 1;
      const all = [...list.querySelectorAll('.sp-opt')];
      const order = [...all.slice(from), ...all.slice(0, from)];
      const hit = order.find((o) => o.textContent.trim().toLowerCase().startsWith(ch));
      if (hit) {
        all.forEach((o) => o.classList.remove('active'));
        hit.classList.add('active');
        hit.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  pill._closeSelect = () => open(false);
}

/** Only one list may be open; two at once is a state nobody intends. */
function closeAllSelectPills(except) {
  for (const p of document.querySelectorAll('.selectpill[data-enhanced]')) {
    if (p !== except && p._closeSelect) p._closeSelect();
  }
}

function enhanceAllSelects() {
  for (const s of document.querySelectorAll('.selectpill select')) enhanceSelect(s);
}

/**
 * Repaint every pill's visible label from its select.
 *
 * Needed because replacing a select's options does not fire `change`: the
 * value can move underneath the label (a device disconnects, its option
 * vanishes, the selection falls back to "All devices") with nothing to tell
 * the visible text about it.
 */
function syncSelectPills() {
  for (const p of document.querySelectorAll('.selectpill[data-enhanced]')) {
    const s = p.querySelector('select');
    const v = p.querySelector('.sp-value');
    if (s && v) v.textContent = selectedText(s);
  }
}

// ---------------------------------------------------------------------------
// Removing ended sessions
//
// The device is the source of truth: the hub replaces a device's session list
// wholesale from whatever that device reports, so anything removed only at the
// hub returns on the next heartbeat. Every removal therefore goes TO A DEVICE,
// and a device that cannot be asked is reported as skipped rather than quietly
// counted as done.
// ---------------------------------------------------------------------------

/** How long "older than N days" is, in milliseconds. `all` has no window. */
function forgetWindowMs(scope) {
  if (scope === 'all') return undefined;
  const days = Number(scope);
  if (!Number.isFinite(days) || days <= 0) return null;
  return days * 24 * 3600 * 1000;
}

/**
 * Which devices a removal can reach, and how.
 *
 * An online device is ASKED -- it owns its session list, and a hub-side delete
 * would be undone by its next heartbeat.
 *
 * Anything not online is handled by the hub instead. That is not an override:
 * a device with no live connection has nothing left to contradict, and an
 * ephemeral job execution never reconnects. Both non-online states count --
 * a device goes `stale` before it goes `offline`, and a job that has just
 * finished is exactly the one someone wants to tidy away.
 */
function forgetTargets(devices) {
  const all = devices || [];
  return {
    reachable: all.filter((d) => d.presence === 'online'),
    skipped: all.filter((d) => d.presence !== 'online'),
  };
}

/**
 * What to tell someone after a sweep.
 *
 * Written from the RESULTS, never from the request, so a device that refused
 * cannot be counted as a device that complied.
 */
function forgetSummary({ removed, failed, skipped }) {
  const parts = [];
  parts.push(removed === 0
    ? 'Nothing to remove'
    : `Removed ${removed} ended session${removed === 1 ? '' : 's'}`);
  if (skipped) parts.push(`${skipped} device${skipped === 1 ? '' : 's'} offline, skipped`);
  if (failed) parts.push(`${failed} device${failed === 1 ? '' : 's'} refused`);
  return parts.join(' · ');
}

/**
 * What the Create menu can offer, given the devices that exist.
 *
 * A session needs a device to run on, and the two kinds are not
 * interchangeable: a cloud device is on-demand, a local one is a machine
 * already sitting there. Squad Hub cannot CONJURE either -- it observes
 * devices that dial in, and holds no cloud credentials by design -- so an
 * always-live "Cloud session" would be an offer it could not keep. Each
 * unavailable kind is therefore refused WITH THE REASON and what to do about
 * it, which is the honest version of the same help.
 */
function newMenuState(devices) {
  const usable = (devices || []).filter((d) => d.presence !== 'offline');
  const cloud = usable.filter((d) => d.kind === 'cloud');
  const local = usable.filter((d) => d.kind !== 'cloud');
  let note = null;
  if (!usable.length) {
    note = 'No device is connected. A session runs on a device — run squad-hub connect on a machine, or start a cloud one.';
  } else if (!cloud.length) {
    note = 'No cloud device is connected. A cloud device dials in on its own — see docs/aca.md for running one on Container Apps.';
  } else if (!local.length) {
    note = 'No local device is connected. Run squad-hub connect on a machine to add one.';
  }
  return {
    localEnabled: local.length > 0,
    cloudEnabled: cloud.length > 0,
    note,
    localDeviceId: local.length ? local[0].deviceId : null,
    cloudDeviceId: cloud.length ? cloud[0].deviceId : null,
  };
}

const APPROVAL_LABEL = {
  allow_once: 'Allow once',
  allow_always: 'Always allow',
  reject_once: 'Deny',
};

/**
 * The options to offer, in a deliberate order, never inventing one.
 *
 * `allow_always` appears ONLY when the agent offered it. Manufacturing a
 * standing rule the agent never proposed would create a permission nobody's
 * protocol agreed on, and the daemon refuses an option the agent did not
 * offer anyway -- so a button for it could only ever produce an error.
 */
function approvalOptions(approval) {
  const offered = (approval && approval.options) || [];
  return offered.map((o) => ({
    optionId: o.optionId,
    label: o.name || APPROVAL_LABEL[o.optionId] || o.optionId,
    danger: o.optionId === 'reject_once',
    standing: o.optionId === 'allow_always',
  }));
}

/**
 * What "Always allow" would actually commit to.
 *
 * A standing permission button that does not say what it makes standing is a
 * blank cheque. Returns null when the agent did not offer one, so nothing is
 * shown for a decision nobody can take.
 */
function alwaysAllowRule(approval) {
  const opt = ((approval && approval.options) || []).find((o) => o.optionId === 'allow_always');
  if (!opt) return null;
  const subject = (approval.command || approval.title || '').trim();
  if (!subject) return 'Allow this tool without asking again in this session.';
  return `Allow "${subject}" without asking again in this session.`;
}

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
function spawnRequest({
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
function spawnError(body) {
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

const CONTROL = Object.freeze({
  UNKNOWN: 'unknown',       // nothing asked yet
  VERIFYING: 'verifying',   // asked, waiting
  SYNCED: 'synced',         // the device says yes
  NOT_SYNCED: 'not_synced', // the device says no, and why
  UNVERIFIED: 'unverified', // nobody answered in time
});

const CONTROL_TEXT = Object.freeze({
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
function controlsEnabled(controlState) {
  return controlState === CONTROL.SYNCED;
}

/** Can the person do anything about it? Only when the answer was "no". */
function canSync(controlState) {
  return controlState === CONTROL.NOT_SYNCED || controlState === CONTROL.UNVERIFIED;
}

/**
 * Turn a control-check outcome into a state.
 *
 * A transport failure and a definite "no" are deliberately different: one is
 * worth retrying and the other is not, and telling a person "not synced" when
 * the request never arrived sends them looking in the wrong place.
 */
function controlStateFrom(outcome) {
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
function controlBanner(controlState, reason) {
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
function composerReduce(prev, event) {
  const s = { draft: '', control: CONTROL.UNKNOWN, reason: '', ...(prev || {}) };
  switch (event && event.type) {
    case 'type':
      return { ...s, draft: String(event.text == null ? '' : event.text) };
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
      return { ...s, draft: '' };
    case 'send-failed':
      return { ...s, reason: (event.error && String(event.error)) || 'the message was not delivered' };
    default:
      return s;
  }
}


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
    // Two buttons, because "start a session" has two genuinely different
    // answers: a cloud device is provisioned on demand, a local one is the
    // machine already sitting there. One button forces a person to open a
    // dialog to discover which they can have.
    const cloud = devices.filter((d) => d.kind === 'cloud' && d.presence !== 'offline');
    const local = online.filter((d) => d.kind !== 'cloud');
    emptyEl.innerHTML = online.length
      ? `<h3>No sessions yet</h3>
         <p>Start one on a device with <code>squad-hub run "…"</code>, or start one from here.</p>
         <p class="empty-actions">
           <button class="primary" id="emptyCloud"${cloud.length ? '' : ' disabled title="No cloud device is connected"'}>New cloud session</button>
           <button class="ghost" id="emptyLocal"${local.length ? '' : ' disabled title="No local device is connected"'}>New local session</button>
         </p>`
      : `<h3>No devices connected</h3><p>A device is the machine that actually runs the agent — your laptop, a dev box, or a container.</p><p><button class="primary" id="emptyConnect">Connect a device</button></p>`;
    const ec = document.getElementById('emptyConnect');
    if (ec) ec.onclick = () => openConnect();
    const cb = document.getElementById('emptyCloud');
    if (cb) cb.onclick = () => openNew(cloud.length ? cloud[0].deviceId : undefined);
    const lb = document.getElementById('emptyLocal');
    if (lb) lb.onclick = () => openNew(local.length ? local[0].deviceId : undefined);
  }

  const roster = deviceRoster(devices);
  $('deviceList').innerHTML = `<div class="card">${roster.map(deviceCard).join('')
    || '<div class="device"><div class="device-meta">No devices yet. Run <code>squad-hub connect</code>.</div></div>'}</div>`;
  const availPill = $('deviceAvailable');
  if (availPill) {
    // The count badge beside "Connected devices" already says how many there
    // are. This pill repeated that number whenever every device was online,
    // which is most of the time -- and a badge that usually agrees with the
    // one next to it is a badge nobody reads on the day it disagrees.
    //
    // So it now reports only the EXCEPTION: how many are unreachable. When
    // everything is online there is nothing to say, and it says nothing.
    const total = devices.length;
    const avail = availableCount(devices);
    const down = total - avail;
    availPill.hidden = down === 0;
    availPill.textContent = `${down} offline`;
    availPill.classList.toggle('none', down > 0);
    availPill.title = down ? 'An offline device cannot be sent work or asked to tidy up' : '';
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

  // Rebuilding a select's options does NOT fire `change`, so the visible label
  // beside it would go on showing a device that has since gone away.
  syncSelectPills();

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
// ---------------------------------------------------------------------------
// Desktop notifications
//
// The whole point of this hub is that a session can ask a human wherever that
// human is. A page you have to be LOOKING AT to notice a blocked session is
// only half of that -- so an approval raises a real notification, and the
// agent goes on waiting either way.
//
// Permission is requested ON A CLICK, never on load. A prompt that appears
// before anyone has asked for anything is the one people dismiss for good, and
// a permanently denied permission cannot be asked for again.
// ---------------------------------------------------------------------------

/** Whether this browser can notify at all, and what it has been told. */
function notifyState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;      // 'granted' | 'denied' | 'default'
}

/**
 * Ask for permission, and say what happened.
 *
 * Returns the resulting state rather than a bare boolean, because "denied"
 * and "unsupported" need different things said to a person: one is a setting
 * they can change, the other is not.
 */
async function requestNotifyPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); }
  catch { return Notification.permission; }
}

/**
 * Raise a notification for an approval, once.
 *
 * Keyed on the approval id so a re-render, a reconnect or a second poll cannot
 * produce a second notification for the same question. `renotify` is set so a
 * replacement for the same tag still alerts, rather than silently swapping.
 */
function notifyApproval(device, session, approval) {
  if (notifyState() !== 'granted') return false;
  if (state.notified.has(approval.approvalId)) return false;
  state.notified.add(approval.approvalId);
  try {
    const n = new Notification('Permission needed', {
      body: `${approval.title || 'A tool is waiting'}\n${device.name} · ${session.cwd || ''}`,
      tag: `approval-${approval.approvalId}`,
      renotify: true,
      icon: '/icon.svg',
    });
    // Clicking it should bring you to the thing it was about.
    n.onclick = () => {
      window.focus();
      showApproval(device, session, approval);
      n.close();
    };
    return true;
  } catch {
    // A browser that refuses to construct one (some mobile engines require a
    // service worker) must not take the render down with it.
    return false;
  }
}

/**
 * Say what the bell will actually do, in its tooltip.
 *
 * A bell that behaves differently depending on a permission the page never
 * mentions is a control people learn to distrust.
 */
function syncBell() {
  const b = document.getElementById('bellBtn');
  if (!b) return;
  const s = notifyState();
  b.dataset.permission = s;
  b.title = s === 'granted' ? 'Notifications are on'
    : s === 'denied' ? 'Notifications are blocked for this site'
      : s === 'unsupported' ? 'This browser cannot show notifications'
        : 'Turn on notifications';
}

function maybePromptApproval() {
  // An open card whose approval has since expired is a dialog asking for an
  // answer nobody can give any more -- and worse, answering it would fail
  // silently. Close it and say what happened.
  const open = state.openApproval;
  if (open && !$('approvalScrim').hidden) {
    const stillPending = state.overview.groups.some((g) => g.sessions.some(
      (s) => (s.pendingApprovals || []).some((a) => a.approvalId === open),
    ));
    const nowExpired = state.overview.groups.some((g) => g.sessions.some(
      (s) => (s.expiredApprovals || []).some((a) => a.approvalId === open),
    ));
    // Answered somewhere else -- another browser, a phone, the CLI. The card
    // has to close and say who, or two people both think it is theirs to
    // decide and the second one's click fails for reasons they cannot see.
    let answeredElsewhere = null;
    for (const g of state.overview.groups) {
      for (const s of g.sessions) {
        const hit = (s.answeredApprovals || []).find((a) => a.approvalId === open);
        if (hit) answeredElsewhere = hit;
      }
    }
    if (!stillPending && answeredElsewhere) {
      $('approvalScrim').hidden = true;
      state.openApproval = null;
      const verb = (ANSWER_VERB[answeredElsewhere.optionId] || 'Answered').toLowerCase();
      toast(`Already ${verb} by ${answeredElsewhere.answeredBy}`);
      return undefined;
    }
    if (!stillPending && nowExpired) {
      $('approvalScrim').hidden = true;
      state.openApproval = null;
      toast('That request expired before it was answered — the agent was told no');
      return undefined;
    }
  }
  if (!$('approvalScrim').hidden) return undefined;
  for (const g of state.overview.groups) {
    for (const s of g.sessions) {
      for (const a of s.pendingApprovals || []) {
        // Raised whether or not this tab is the one being looked at: the
        // whole point is that a blocked session can reach a person who is
        // somewhere else.
        notifyApproval(g.device, s, a);
        if (state.seenApprovals.has(a.approvalId)) continue;
        return showApproval(g.device, s, a);
      }
    }
  }
  return undefined;
}

function showApproval(device, session, approval) {
  state.seenApprovals.add(approval.approvalId);
  state.openApproval = approval.approvalId;
  $('apWhere').textContent = `${device.name} · ${session.cwd || ''}`;
  $('apDesc').textContent = approval.title || 'The agent is asking to run a tool.';
  $('apCommand').textContent = approval.command || approval.title || '(no command reported)';

  // What it actually touches, each row saying whether it is read-only.
  // Reading a file and rewriting a directory are not the same decision.
  const rows = approvalRows(approval);
  $('apPathsWrap').hidden = rows.length === 0;
  $('apPaths').innerHTML = rows.map((r) => `
    <span class="ap-row ${r.readOnly ? 'ro' : 'rw'}">
      <span class="ap-label">${esc(r.label)}</span>
      <span class="ap-badge">${r.readOnly ? 'read-only' : 'writes'}</span>
    </span>`).join('');

  // A standing permission button that does not say what it makes standing is
  // a blank cheque.
  const rule = alwaysAllowRule(approval);
  $('apRule').hidden = !rule;
  $('apRule').textContent = rule || '';

  $('apActions').innerHTML = approvalOptions(approval).map((o) => `
    <button class="${o.danger ? 'ghost danger' : o.standing ? 'ghost' : 'primary'}"
            data-answer="${esc(o.optionId)}">${esc(o.label)}</button>`).join('');

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
  // Prefilled from the session when it is on GitHub. Shown either way now that
  // the dialog takes a repository: a run does not have to be about the
  // repository you happen to be looking at.
  $('dtAca').hidden = false;

  /**
   * Say WHY the agent or model is not the one that was asked for.
   *
   * The row already reports the disagreement -- "running default agent, not
   * Squad" -- and the session records the reason, but nothing ever displayed
   * it. So the one question that reading it provokes ("why?") had no answer
   * anywhere in the product, and the honest report read as an odd glitch.
   */
  const warnings = [
    ...(((found.session.applied || {}).warnings) || []),
    ...(((found.session.agentSelection || {}).warnings) || []),
  ].filter(Boolean);
  $('dtWarn').textContent = warnings.join(' · ');
  $('dtWarn').hidden = warnings.length === 0;
  renderSquadPanel(found.session.squad);
  $('dtTranscript').innerHTML = '<div class="t-entry t-kind">loading…</div>';
  $('detailScrim').hidden = false;

  // The composer starts DISABLED and stays that way until the device itself
  // says it can take input. The draft is restored rather than reset -- someone
  // may have typed it, failed to send, and come back.
  state.composer = composerReduce(state.composer, { type: 'verify-start' });
  $('dtInput').value = state.composer.draft || '';
  renderControl();

  try {
    const r = await api(`/api/devices/${encodeURIComponent(found.device.deviceId)}/transcript`, {
      method: 'POST', body: { sessionId: found.session.id, limit: 200 },
    });
    renderTranscript(r.transcript || []);
  } catch (e) {
    $('dtTranscript').innerHTML = `<div class="t-entry t-kind">could not load the transcript: ${esc(e.message)}</div>`;
  }

  // Deliberately AFTER the transcript: a session that cannot be controlled is
  // still worth reading, and blocking the transcript on a control check would
  // make an unreachable device hide the very history explaining why.
  verifyControl();
}

/** How long to wait for the device to answer before saying so. */
const CONTROL_TIMEOUT_MS = 8000;

/**
 * Ask the device whether it can take a control command for this session.
 *
 * The answer comes from the machine running the agent, not from the hub. The
 * hub is a cache: it knowing about a session proves only that a heartbeat once
 * mentioned it.
 */
async function verifyControl() {
  const current = state.currentSession;
  if (!current) return;
  state.composer = composerReduce(state.composer, { type: 'verify-start' });
  renderControl();

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), CONTROL_TIMEOUT_MS));
  const ask = api(`/api/devices/${encodeURIComponent(current.device.deviceId)}/control-check`, {
    method: 'POST', body: { sessionId: current.session.id },
  }).catch((e) => ({ error: e.message }));

  const outcome = await Promise.race([ask, timeout]);

  // The detail panel may have been closed, or moved to another session, while
  // this was in flight. Applying a stale answer would enable the composer for
  // a session nobody verified.
  if (state.currentSession !== current) return;

  state.composer = composerReduce(state.composer, { type: 'verify-result', outcome });
  renderControl();
}

/**
 * `Sync session` -- restart the engine, keeping the session id, then re-check.
 *
 * Re-verifying alone would be a button that asks the same question twice and
 * expects a different answer. When the device has said the agent process is
 * gone, nothing changes until something restarts it.
 *
 * The id survives on purpose: it is what the row, the Teams card and anyone's
 * terminal history all refer to. A "sync" that produced a new session would
 * quietly orphan every one of those references.
 */
async function syncSession() {
  const current = state.currentSession;
  if (!current) return;
  const btn = $('dtSync');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    await api(`/api/devices/${encodeURIComponent(current.device.deviceId)}/resync`, {
      method: 'POST', body: { sessionId: current.session.id },
    });
    await refresh();
  } catch (e) {
    state.composer = composerReduce(state.composer, { type: 'verify-result', outcome: { error: e.message } });
    renderControl();
    return;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sync session'; }
  }
  // Only now is the question worth asking again.
  await verifyControl();
}

function renderControl() {
  const b = controlBanner(state.composer.control, state.composer.reason);
  const banner = $('dtControl');
  if (banner) banner.dataset.state = b.state;
  $('dtControlLabel').textContent = b.label;
  $('dtControlWhy').textContent = b.reason;
  $('dtSync').hidden = !b.canSync;
  $('dtInput').disabled = !b.enabled;
  $('dtSend').disabled = !b.enabled;
  $('dtInput').placeholder = b.enabled
    ? 'Send follow-up input to the running agent'
    : 'Controls are disabled until this session is verified';
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
    ? `all on <b>${esc((models.distinctModels || [])[0] || models.defaultModel || 'default')}</b>`
    : `<span class="sq-warn">mixed: ${esc((models.distinctModels || []).join(', '))}</span>`;

  // Same rule as the row badge: a count is shown only when there is a count,
  // and the lists are defended because a partial payload must degrade rather
  // than throw halfway through building the panel.
  const counts = Number.isFinite(sq.activeMembers) && Number.isFinite(sq.memberCount)
    ? `${sq.activeMembers}/${sq.memberCount} members &middot; ` : '';
  const members = Array.isArray(sq.members) ? sq.members : [];
  const decisions = Array.isArray(sq.decisions) ? sq.decisions : [];

  el.innerHTML = `
    <div class="sq-head">
      <b>${esc(sq.project)}</b>
      <span class="sq-dim">${counts}${modelLine}</span>
    </div>
    <div class="sq-members">
      ${members.map((m) => `
        <button type="button" class="sq-member ${sq.activeMember && sq.activeMember.name === m.name ? 'now' : ''} ${m.active ? '' : 'off'}"
                data-squaddoc="charter:${esc(m.name)}" title="Read ${esc(m.name)}'s charter">
          ${esc(m.name)}${m.role && m.role !== m.name ? `<i>${esc(m.role)}</i>` : ''}
        </button>`).join('')}
    </div>
    <div class="sq-docbar" id="dtSquadDocs"></div>
    <div class="sq-doc" id="dtSquadDoc" hidden></div>
    ${decisions.length ? `
      <div class="sq-sub">Recent decisions (${sq.decisionCount})</div>
      <ol class="sq-decisions">
        ${sq.decisions.slice(0, 5).map((d) => `
          <li class="${d.superseded ? 'old' : ''}">
            ${d.date ? `<span class="sq-date">${esc(d.date)}</span>` : ''}
            <span class="sq-title">${esc(d.title)}</span>
            ${d.summary ? `<div class="sq-why">${esc(d.summary.slice(0, 180))}${d.summary.length > 180 ? '…' : ''}</div>` : ''}
          </li>`).join('')}
      </ol>` : '<div class="sq-sub">No decisions recorded yet</div>'}`;

  renderSquadDocBar();
}

/**
 * The documents this workspace actually has.
 *
 * Asked for once, when the session is opened. Offering a document that is not
 * there is a link to a dead end; hiding one that is, is worse -- and only the
 * device can answer, so it is asked rather than guessed.
 *
 * Member charters are reached by clicking the member, so the bar carries the
 * whole-team documents and nothing else.
 */
const TEAM_DOC_LABEL = { team: 'Team', decisions: 'Decisions', routing: 'Routing', config: 'Models' };

async function renderSquadDocBar() {
  const bar = $('dtSquadDocs');
  if (!bar || !state.currentSession) return;
  const { device, session } = state.currentSession;
  bar.innerHTML = '';
  let docs = [];
  try {
    const r = await api(`/api/devices/${encodeURIComponent(device.deviceId)}/squad-docs`, {
      method: 'POST', body: { sessionId: session.id },
    });
    docs = (r && r.docs) || [];
  } catch {
    // The device holds these files, so it is the only thing that can list
    // them. Saying so beats an empty bar that looks like an empty team.
    bar.innerHTML = '<span class="sq-dim">the device is offline; these files live on it</span>';
    return;
  }
  const teamDocs = docs.filter((d) => Object.prototype.hasOwnProperty.call(TEAM_DOC_LABEL, d));
  /**
   * A member with no charter is not offered as one.
   *
   * The coordinator usually has no `charter.md`, so every panel had at least
   * one button that looked live and answered "no charter:Squad in this
   * workspace". Offering a link to a dead end is the thing the document list
   * exists to prevent -- it applies to members as much as to tabs.
   */
  const haveCharter = new Set(docs.filter((d) => d.startsWith('charter:')));
  for (const b of document.querySelectorAll('#dtSquad .sq-member[data-squaddoc]')) {
    const ok = haveCharter.has(b.dataset.squaddoc);
    b.classList.toggle('nodoc', !ok);
    b.disabled = !ok;
    if (!ok) b.title = 'no charter recorded for this member';
  }
  if (!teamDocs.length) return;
  bar.innerHTML = teamDocs
    .map((d) => `<button type="button" class="sq-doctab" data-squaddoc="${esc(d)}">${esc(TEAM_DOC_LABEL[d])}</button>`)
    .join('');
}

/**
 * Show one Squad document.
 *
 * ESCAPED TEXT, NOT RENDERED MARKDOWN. These files are written by agents as
 * well as by people, so turning them into HTML would let a careless or
 * compromised agent put markup in a charter and have the hub execute it in the
 * reader's browser, holding the reader's hub credential. Headings and list
 * markers are styled by decorating the LINE; nothing in the file ever becomes
 * markup.
 */
async function openSquadDoc(doc) {
  const box = $('dtSquadDoc');
  if (!box || !state.currentSession) return;
  const { device, session } = state.currentSession;

  for (const b of document.querySelectorAll('[data-squaddoc]')) {
    b.classList.toggle('on', b.dataset.squaddoc === doc);
  }
  box.hidden = false;
  box.innerHTML = '<div class="sq-dim">loading…</div>';

  let r;
  try {
    r = await api(`/api/devices/${encodeURIComponent(device.deviceId)}/squad-doc`, {
      method: 'POST', body: { sessionId: session.id, doc },
    });
  } catch (e) {
    box.innerHTML = `<div class="sq-dim">${esc(e.message)}</div>`;
    return;
  }

  // Split on CRLF as well as LF. These files are written on whatever machine
  // the Squad runs on, and a stray \r left on the end of every line renders as
  // an extra blank line inside <pre> -- which is why a charter appeared to be
  // double-spaced.
  const lines = String(r.text || '').split(/\r?\n/);
  box.innerHTML = `
    <div class="sq-docmeta">
      <b>${esc(doc)}</b>
      <span class="sq-dim">${Number(r.bytes || 0).toLocaleString()} bytes${
  r.truncated ? ' · showing the first 256 KB' : ''}</span>
    </div>
    <pre class="sq-doctext">${lines.map((l) => {
    const t = l.trimStart();
    const cls = t.startsWith('#') ? 'md-h' : (/^[-*+]\s|^\d+\.\s/.test(t) ? 'md-li' : (t.startsWith('>') ? 'md-q' : ''));
    return `<span class="${cls}">${esc(l)}</span>`;
  }).join('\n')}</pre>`;
}

/**
 * Pull readable text out of an ACP update, whatever shape it arrived in.
 *
 * `content` is a string on some updates, an object with `.text` on others, and
 * an array of content blocks on tool results. The old reader tried
 * `u.content.text || u.content`, so an ARRAY fell through to the second branch
 * and was printed as raw JSON -- which is why a tool result showed up as
 * `[{"type":"content","content":{"type":"text","text":"Query returned 0 rows."}}]`
 * instead of "Query returned 0 rows."
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
 * Updates that are protocol bookkeeping, not conversation.
 *
 * `usage_update` fires on every token, and `available_commands_update` and
 * `config_option_update` fire whenever the agent reconfigures itself. None of
 * them carry anything a person reads, and rendering them put a row of grey
 * noise between every useful line.
 */
const TRANSCRIPT_NOISE = new Set([
  'usage_update', 'available_commands_update', 'config_option_update',
  'current_mode_update', 'plan', 'agent_thought_chunk',
]);

/**
 * Group a raw update stream into blocks a person can read.
 *
 * THE STREAM IS TOKENS, NOT LINES. `agent_message_chunk` arrives many times per
 * sentence, and the old renderer gave each one its own row -- which is why a
 * finished answer displayed one word per line down the page. Consecutive
 * chunks from the same speaker belong to one block.
 *
 * Tool results are kept but capped: the point is to see THAT a tool ran and
 * roughly what came back, not to scroll a 96MB directory listing.
 */
const TOOL_RESULT_CAP = 600;

function transcriptBlocks(entries) {
  const blocks = [];
  const push = (kind, text) => {
    const last = blocks[blocks.length - 1];
    // Only prose is joined. Two tool results in a row are two results.
    if (last && last.kind === kind && (kind === 'agent' || kind === 'you')) last.text += text;
    else blocks.push({ kind, text });
  };

  for (const e of entries || []) {
    const u = (e && e.update) || e || {};
    const kind = u.sessionUpdate;
    if (TRANSCRIPT_NOISE.has(kind)) continue;

    if (kind === 'tool_call') {
      const title = u.title || u.kind || 'running a tool';
      blocks.push({ kind: 'tool', text: title });
      continue;
    }
    if (kind === 'tool_call_update') {
      const out = updateText(u).trim();
      if (out) blocks.push({ kind: 'result', text: out });
      continue;
    }
    if (kind === 'error') {
      blocks.push({ kind: 'error', text: updateText(u) || 'unknown error' });
      continue;
    }

    const text = updateText(u);
    if (!text) continue;
    if (kind === 'user_message' || kind === 'user_message_chunk') push('you', text);
    else push('agent', text);
  }
  return blocks;
}

function renderTranscript(entries) {
  const blocks = transcriptBlocks(entries);
  if (!blocks.length) {
    $('dtTranscript').innerHTML = '<div class="t-entry t-kind">nothing yet</div>';
    return;
  }
  $('dtTranscript').innerHTML = blocks.map((b) => {
    if (b.kind === 'tool') {
      return `<div class="t-entry t-toolrow"><span class="t-tool">tool</span> <span class="t-text">${esc(b.text)}</span></div>`;
    }
    if (b.kind === 'result') {
      const clipped = b.text.length > TOOL_RESULT_CAP;
      const shown = clipped ? `${b.text.slice(0, TOOL_RESULT_CAP)}…` : b.text;
      return `<div class="t-entry t-result"><pre>${esc(shown)}</pre>${
        clipped ? `<span class="t-more">output truncated (${b.text.length.toLocaleString()} characters)</span>` : ''}</div>`;
    }
    if (b.kind === 'error') {
      return `<div class="t-entry t-err"><span class="t-tool">error</span> <span class="t-text">${esc(b.text)}</span></div>`;
    }
    const who = b.kind === 'you' ? 'you' : 'agent';
    return `<div class="t-entry t-msg t-${who}"><span class="t-who">${who}</span><div class="t-body">${esc(b.text.trim())}</div></div>`;
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

/**
 * What each state means, in a sentence.
 *
 * The live dot has no text, so without this it would be a coloured mark with
 * no explanation anywhere -- and the failures deserve to say that the DEVICES
 * are fine even when this page cannot hear them, because the obvious fear on
 * seeing a red badge is that the work has stopped.
 */
const CONN_TITLE = {
  live: 'Live: this page is receiving updates as they happen',
  connecting: 'Connecting to the live feed',
  retrying: 'The live feed dropped and is reconnecting. Your sessions keep running.',
  offline: 'The hub is not answering. This page keeps retrying; your devices are unaffected.',
};

function setConn(s) {
  const el = $('conn');
  el.dataset.state = s;
  // A DOT when the feed is healthy, WORDS when it is not.
  //
  // "live" is true almost all of the time, so spelling it out is a permanent
  // label saying "working" -- and a label that is always there is one nobody
  // reads on the day it changes. As a dot it costs nothing and still answers
  // the question a person actually asks after ten quiet minutes: is this page
  // still being told things, or has it been showing me a corpse?
  //
  // The failures keep their words, because "reconnecting" and "hub
  // unreachable" are different situations that need different reactions, and
  // a coloured dot cannot say which is which.
  el.textContent = s === 'live' ? '' : (CONN_LABEL[s] || s);
  el.title = CONN_TITLE[s] || '';
  el.setAttribute('aria-label', `Live feed: ${CONN_LABEL[s] || s}`);
}

/**
 * A session named in the URL, from a Teams card's "View live session" link.
 *
 * Read once and removed from the address bar, like the token above: leaving it
 * there means a reload re-opens the panel someone just closed, and a bookmark
 * silently becomes "always open this session".
 */
function takeDeepLinkSession() {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('session');
  if (!wanted) return null;
  params.delete('session');
  const rest = params.toString();
  history.replaceState({}, '', rest ? `${location.pathname}?${rest}` : location.pathname);
  return wanted;
}

/**
 * Resolve what a deep link asked for.
 *
 * Matches the hub's `deviceId:sessionId` key first. A bare session id is
 * accepted as a fallback -- cards posted before the key was included are
 * sitting in people's channels and should keep working -- but ONLY when
 * exactly one device has a session by that name. A session id is unique within
 * a device, not across them, so guessing between two would sometimes open
 * somebody else's session on another machine.
 */
function resolveDeepLink(wanted, groups) {
  if (!wanted) return { status: 'none' };
  for (const g of groups) {
    for (const s of g.sessions || []) if (s.key === wanted) return { status: 'found', key: s.key };
  }
  const byId = [];
  for (const g of groups) {
    for (const s of g.sessions || []) if (s.id === wanted) byId.push(s.key);
  }
  if (byId.length === 1) return { status: 'found', key: byId[0] };
  if (byId.length > 1) return { status: 'ambiguous', count: byId.length };
  return { status: 'missing' };
}


/**
 * The hub could not be reached at all.
 *
 * Says the true thing and the reassuring thing, in that order. The reassurance
 * is not padding: the natural fear on seeing a dashboard fail is that the work
 * it was watching has failed too, and here that is precisely wrong -- sessions
 * run on the devices, and the hub only watches them. An agent waiting for an
 * approval is still waiting, and will still be waiting when the network comes
 * back.
 *
 * Recovers by itself. Someone who walks back into signal should not have to
 * work out that they need to reload.
 */
function showOffline() {
  const main = document.querySelector('main.page');
  const target = main || document.body;
  target.innerHTML = `
    <div class="empty">
      <h3>Can't reach the hub</h3>
      <p>You're still signed in — this device just can't get to the hub right now.</p>
      <p><strong>Your sessions are unaffected.</strong> They run on your devices, not here.
         Anything waiting on an approval is still waiting.</p>
      <p class="empty-actions"><button class="primary" id="offlineRetry">Try again</button></p>
    </div>`;
  const retry = document.getElementById('offlineRetry');
  if (retry) retry.onclick = () => location.reload();
  // Reload the moment connectivity returns, so this state cannot outlive the
  // problem it describes.
  window.addEventListener('online', () => location.reload(), { once: true });
  return undefined;
}


/**
 * Register the service worker, which supplies the offline shell.
 *
 * Deliberately quiet about failure. A worker needs a secure context, so it
 * simply does not exist on a hub reached over plain http on a LAN -- and that
 * is a perfectly normal way to run this. An error in the console there would
 * be noise about a feature the deployment never asked for.
 *
 * It caches the SHELL only; nothing under /api/ is ever stored. See web/sw.js.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Registration is fire-and-forget on purpose: the app must not wait on it,
  // and must work identically whether or not it succeeds.
  navigator.serviceWorker.register('/sw.js').catch(() => { /* insecure context, or blocked */ });
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
  state.theme = loadTheme();
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
  applyTheme(state.theme);
}

const THEME_KEY = 'squad-hub-theme';

/**
 * Theme, in three states rather than two.
 *
 * `system` is a real setting, not the absence of one: it means "keep following
 * this machine", and it is what someone gets before they have said anything.
 * Collapsing it into a boolean would freeze whatever the system happened to be
 * on first load, so a laptop that switches at sunset would stop switching.
 */
const THEMES = ['system', 'dark', 'light'];

/**
 * The three theme icons, as Fluent SVG (Microsoft, MIT).
 *
 * `system` gets the half-filled circle it always had, because "follow this
 * machine" is genuinely neither sun nor moon; the other two say plainly which
 * one is in force.
 */
const THEME_ICON = {
  system: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1C11.866 1 15 4.13401 15 8C15 11.866 11.866 15 8 15C4.13401 15 1 11.866 1 8C1 4.13401 4.13401 1 8 1ZM8 2V14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2Z"/></svg>',
  dark: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8.00291 1C11.8684 1.00057 15.002 4.13436 15.002 8C15.002 11.866 11.8679 15 8.00193 15C5.08888 14.9999 2.59229 13.2205 1.53805 10.6914C1.4578 10.4987 1.50656 10.2763 1.65914 10.1338C1.75673 10.0427 1.88381 9.99611 2.01168 9.99902C5.32091 9.99375 8.00193 7.31045 8.00193 4C8.00193 3.18152 7.83715 2.40245 7.54099 1.69238C7.47678 1.53815 7.49426 1.3617 7.58689 1.22266C7.67959 1.08361 7.83581 1.00006 8.00291 1ZM8.72166 2.04395C8.90245 2.66516 9.00194 3.32111 9.00194 4C9.00194 7.60283 6.27984 10.5678 2.78024 10.9551C3.81152 12.7735 5.7636 13.9999 8.00193 14C11.3157 14 14.002 11.3137 14.002 8C14.002 4.92991 11.696 2.39958 8.72166 2.04395Z"/></svg>',
  light: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1C8.27614 1 8.5 1.22386 8.5 1.5V2.5C8.5 2.77614 8.27614 3 8 3C7.72386 3 7.5 2.77614 7.5 2.5V1.5C7.5 1.22386 7.72386 1 8 1ZM8 11C9.65685 11 11 9.65685 11 8C11 6.34315 9.65685 5 8 5C6.34315 5 5 6.34315 5 8C5 9.65685 6.34315 11 8 11ZM8 10C6.89543 10 6 9.10457 6 8C6 6.89543 6.89543 6 8 6C9.10457 6 10 6.89543 10 8C10 9.10457 9.10457 10 8 10ZM14.5 8.5C14.7761 8.5 15 8.27614 15 8C15 7.72386 14.7761 7.5 14.5 7.5H13.5C13.2239 7.5 13 7.72386 13 8C13 8.27614 13.2239 8.5 13.5 8.5H14.5ZM8 13C8.27614 13 8.5 13.2239 8.5 13.5V14.5C8.5 14.7761 8.27614 15 8 15C7.72386 15 7.5 14.7761 7.5 14.5V13.5C7.5 13.2239 7.72386 13 8 13ZM2.5 8.5C2.77614 8.5 3 8.27614 3 8C3 7.72386 2.77614 7.5 2.5 7.5H1.5C1.22386 7.5 1 7.72386 1 8C1 8.27614 1.22386 8.5 1.5 8.5H2.5ZM3.14645 3.14649C3.34171 2.95123 3.65829 2.95123 3.85355 3.14649L4.85355 4.14649C5.04882 4.34175 5.04882 4.65834 4.85355 4.8536C4.65829 5.04886 4.34171 5.04886 4.14645 4.8536L3.14645 3.8536C2.95118 3.65834 2.95118 3.34175 3.14645 3.14649ZM3.85355 12.8536C3.65829 13.0489 3.34171 13.0489 3.14645 12.8536C2.95118 12.6584 2.95118 12.3418 3.14645 12.1465L4.14645 11.1465C4.34171 10.9513 4.65829 10.9513 4.85355 11.1465C5.04882 11.3418 5.04882 11.6584 4.85355 11.8536L3.85355 12.8536ZM12.8536 3.14649C12.6583 2.95123 12.3417 2.95123 12.1464 3.14649L11.1464 4.14649C10.9512 4.34175 10.9512 4.65834 11.1464 4.8536C11.3417 5.04886 11.6583 5.04886 11.8536 4.8536L12.8536 3.8536C13.0488 3.65834 13.0488 3.34175 12.8536 3.14649ZM12.1464 12.8536C12.3417 13.0489 12.6583 13.0489 12.8536 12.8536C13.0488 12.6584 13.0488 12.3418 12.8536 12.1465L11.8536 11.1465C11.6583 10.9513 11.3417 10.9513 11.1464 11.1465C10.9512 11.3418 10.9512 11.6584 11.1464 11.8536L12.1464 12.8536Z"/></svg>',
};

function loadTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return THEMES.includes(saved) ? saved : 'system';
  } catch { return 'system'; }
}

function applyTheme(theme) {
  state.theme = THEMES.includes(theme) ? theme : 'system';
  // The attribute is REMOVED for `system`, not set to it. The stylesheet keys
  // its prefers-color-scheme block on `:root:not([data-theme])`, so an
  // attribute of any value would override the system choice it exists to
  // follow.
  if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', state.theme);

  const btn = $('themeBtn');
  if (btn) {
    const label = { system: 'Theme: follow system', dark: 'Theme: dark', light: 'Theme: light' }[state.theme];
    btn.title = `${label} (click to change)`;
    btn.setAttribute('aria-label', label);
    // SVG, not emoji. An emoji glyph is drawn by whatever font the platform
    // picks -- often in colour, at its own weight, and differently on every
    // machine -- so the one control next to the account menu never matched the
    // icons around it. These are the same Fluent set as everywhere else and
    // inherit `currentColor`.
    btn.innerHTML = THEME_ICON[state.theme] || THEME_ICON.system;
  }
  try { localStorage.setItem(THEME_KEY, state.theme); } catch { /* never fatal */ }
}

/** system -> dark -> light -> system. */
function nextTheme(theme) {
  const i = THEMES.indexOf(theme);
  return THEMES[(i === -1 ? 0 : i + 1) % THEMES.length];
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
  enhanceAllSelects();
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

  // The Squad panel: members and document tabs both open a document. Delegated
  // from the panel, because its contents are re-rendered on every refresh.
  $('dtSquad').onclick = (e) => {
    const b = e.target.closest('[data-squaddoc]');
    if (b) openSquadDoc(b.dataset.squaddoc);
  };

  $('deviceList').onclick = (e) => {
    const b = e.target.closest('[data-spawn]');
    if (b) openNew(b.dataset.spawn);
  };

  // The rail collapses, and remembers. On a narrow window it is the first
  // thing worth reclaiming, and re-collapsing it on every load would make that
  // a chore rather than a setting.
  $('railToggle').onclick = () => setRailCollapsed(!$('deviceRail').classList.contains('collapsed'));

  $('themeBtn').onclick = () => applyTheme(nextTheme(state.theme));

  $('newBtn').onclick = () => openNew();

  // The split half and the kebab. Both stopPropagation so the document-level
  // close handler below does not see the same click that opened them.
  $('newMoreBtn').onclick = (e) => { e.stopPropagation(); togglePopup('newMenu', 'newMoreBtn'); };
  $('tidyBtn').onclick = (e) => { e.stopPropagation(); togglePopup('tidyMenu', 'tidyBtn'); };
  $('newMenu').onclick = (e) => {
    const b = e.target.closest('[data-new]');
    if (!b || b.disabled) return;
    togglePopup('newMenu', 'newMoreBtn', false);
    // Starting a run on ACA needs no device at all: it opens GitHub, and the
    // workflow there starts the job. So it is offered whether or not anything
    // is attached.
    if (b.dataset.new === 'aca') { openAca(); return; }
    const s = newMenuState((state.overview && state.overview.devices) || []);
    openNew(b.dataset.new === 'cloud' ? s.cloudDeviceId : s.localDeviceId);
  };
  $('tidyMenu').onclick = (e) => {
    const b = e.target.closest('[data-forget]');
    if (!b) return;
    togglePopup('tidyMenu', 'tidyBtn', false);
    forgetEnded(b.dataset.forget);
  };
  $('cnCancel').onclick = () => { $('connectScrim').hidden = true; };
  $('cnCreate').onclick = () => createDeviceToken();
  // "…anywhere" only means something once a working directory is allowed at
  // all, so it follows the box above it rather than sitting there as a live
  // control that does nothing.
  const syncFilesAll = () => {
    const on = $('cnFiles').checked;
    $('cnFilesAll').disabled = !on;
    if (!on) $('cnFilesAll').checked = false;
  };
  $('cnFiles').onchange = syncFilesAll;
  syncFilesAll();
  $('cnCopy').onclick = async () => {
    toast(await copy($('cnCmd').textContent) ? 'Command copied' : 'Select and copy the command above');
  };
  $('nsCancel').onclick = () => { $('newScrim').hidden = true; };
  $('apCancel').onclick = () => { $('approvalScrim').hidden = true; };
  $('dtClose').onclick = () => { $('detailScrim').hidden = true; state.currentSession = null; };

  $('bellBtn').onclick = async () => {
    // The click is what asks for permission. Requesting it on load would spend
    // the one prompt a browser ever shows before anyone had reason to say yes,
    // and a denial cannot be asked for again.
    const before = notifyState();
    const after = await requestNotifyPermission();
    if (after === 'granted' && before !== 'granted') {
      toast('Notifications on — you will be told when a session needs you');
    } else if (after === 'denied') {
      toast('Notifications are blocked for this site; allow them in your browser settings');
    } else if (after === 'unsupported') {
      toast('This browser cannot show notifications');
    }
    // Whatever the answer, the bell still does what it always did: bring back
    // the cards that were dismissed without being answered.
    state.seenApprovals.clear();
    maybePromptApproval();
  };
  syncBell();

  $('menuBtn').onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  $('bannerClose').onclick = () => { $('banner').hidden = true; };  $('menu').onclick = (e) => {
    const b = e.target.closest('[data-menu]');
    if (b) onMenu(b.dataset.menu);
  };
  document.addEventListener('click', (e) => {
    if (!$('menu').hidden && !e.target.closest('#menu') && !e.target.closest('#menuBtn')) toggleMenu(false);
    if (!$('newMenu').hidden && !e.target.closest('#newSplit')) togglePopup('newMenu', 'newMoreBtn', false);
    if (!$('tidyMenu').hidden && !e.target.closest('#tidySplit')) togglePopup('tidyMenu', 'tidyBtn', false);
    if (!e.target.closest('.selectpill')) closeAllSelectPills(null);
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;  });

  $('pplClose').onclick = () => { $('peopleScrim').hidden = true; };
  $('peopleScrim').onclick = (e) => { if (e.target === $('peopleScrim')) $('peopleScrim').hidden = true; };
  $('pplAdd').onclick = async () => {
    const login = $('pplLogin').value.trim();
    if (!login) { $('pplErr').textContent = 'Enter a username or email.'; $('pplErr').hidden = false; return; }
    $('pplAdd').disabled = true;
    try {
      state.people = await api('/api/access', { method: 'POST', body: { login, note: $('pplNote').value.trim() } });
      $('pplLogin').value = '';
      $('pplNote').value = '';
      $('pplErr').hidden = true;
      // Clear the filter, or someone adds a person and watches them not appear.
      $('pplSearch').value = '';
      renderPeople();
    } catch (e) {
      $('pplErr').textContent = e.message;
      $('pplErr').hidden = false;
    }
    $('pplAdd').disabled = false;
    $('pplLogin').focus();
  };
  $('pplLogin').onkeydown = (e) => { if (e.key === 'Enter') $('pplAdd').click(); };
  $('pplNote').onkeydown = (e) => { if (e.key === 'Enter') $('pplAdd').click(); };
  $('pplSearch').oninput = renderPeople;
  $('pplSource').onchange = renderPeople;

  $('dtAca').onclick = openAca;
  $('acaCancel').onclick = () => { $('acaScrim').hidden = true; };
  $('acaScrim').onclick = (e) => { if (e.target === $('acaScrim')) $('acaScrim').hidden = true; };
  $('acaRepo').oninput = updateAcaPreview;
  $('acaIssue').oninput = updateAcaPreview;
  $('acaPrompt').oninput = updateAcaPreview;
  $('acaOpen').onclick = () => {
    const url = acaNewIssueLink($('acaRepo').value, $('acaPrompt').value);
    if (!url) {
      $('acaErr').textContent = 'Enter a repository as owner/repo, and what it should do.';
      $('acaErr').hidden = false;
      return;
    }
    // `noopener` because the opened page must not get a handle back to this
    // one -- and this one holds the token.
    window.open(url, '_blank', 'noopener');
    $('acaScrim').hidden = true;
  };
  $('acaCopy').onclick = async () => {
    const cmd = acaComment($('acaPrompt').value);
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      toast('Command copied — paste it as a comment on the issue');
    } catch { toast('Could not copy; select the command and copy it'); }
  };
  $('acaOpenIssue').onclick = () => {
    const url = acaIssueLink($('acaRepo').value, $('acaIssue').value);
    if (!url) {
      $('acaErr').textContent = 'Enter a repository and an issue number.';
      $('acaErr').hidden = false;
      return;
    }
    window.open(url, '_blank', 'noopener');
  };

  // Offering to install an app that is already installed is noise, so the
  // menu item goes away once we are running from the home screen or the dock.
  if (isInstalled()) {
    const item = document.querySelector('[data-menu="install"]');
    if (item) item.hidden = true;
  }

  $('nsDevice').onchange = updateCwdHint;

  $('nsStart').onclick = async () => {
    const deviceId = $('nsDevice').value;
    // Whichever control is showing is the one the person used. Reading the
    // hidden one would silently discard their choice.
    const agentSel = $('nsAgentSelect');
    const agent = agentSel && !agentSel.hidden ? agentSel.value : $('nsAgent').value;
    const modelSel = $('nsModelSelect');
    const model = modelSel && !modelSel.hidden ? modelSel.value : $('nsModel').value;
    const body = spawnRequest({
      prompt: $('nsPrompt').value,
      cwd: $('nsCwd').value,
      agent,
      model,
      mode: $('nsMode') ? $('nsMode').value : '',
    });
    const problem = spawnError(body);
    if (problem) { showNewErr(problem); return; }
    $('nsStart').disabled = true;
    try {
      await api(`/api/devices/${encodeURIComponent(deviceId)}/spawn`, { method: 'POST', body });
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
    if (!controlsEnabled(state.composer.control)) return;
    const text = $('dtInput').value.trim();
    if (!text) return;
    const { device, session } = state.currentSession;
    try {
      await api(`/api/devices/${encodeURIComponent(device.deviceId)}/steer`, {
        method: 'POST', body: { sessionId: session.id, text },
      });
      // Cleared only once it LANDED. Clearing first meant a failed send threw
      // away what the person had written in order to report the failure.
      state.composer = composerReduce(state.composer, { type: 'sent' });
      $('dtInput').value = '';
    } catch (e) {
      state.composer = composerReduce(state.composer, { type: 'send-failed', error: e.message });
      renderControl();
      alert(`Could not send: ${e.message}`);
    }
  };

  $('dtInput').oninput = (e) => {
    state.composer = composerReduce(state.composer, { type: 'type', text: e.target.value });
  };

  // Enter sends, Shift+Enter starts a new line. The box is a textarea so a
  // follow-up can be more than one line, and a multi-line box with no way to
  // send from the keyboard makes you reach for the mouse on every message.
  $('dtInput').onkeydown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    $('dtSend').click();
  };

  $('dtSync').onclick = () => syncSession();

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    toggleMenu(false);
    togglePopup('newMenu', 'newMoreBtn', false);
    togglePopup('tidyMenu', 'tidyBtn', false);
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

/**
 * A small popup anchored to the control that opened it.
 *
 * Opening one closes the other. Two menus open at once is a state nobody
 * intends and every stray click produces.
 */
function togglePopup(menuId, btnId, force) {
  const m = $(menuId);
  if (!m) return;
  const open = force === undefined ? m.hidden : force;
  if (open) for (const other of ['newMenu', 'tidyMenu']) if (other !== menuId) togglePopup(other, other === 'newMenu' ? 'newMoreBtn' : 'tidyBtn', false);
  m.hidden = !open;
  const b = $(btnId);
  if (b) b.setAttribute('aria-expanded', String(open));
  if (open && menuId === 'newMenu') renderNewMenu();
}

/**
 * The Create menu.
 *
 * "Cloud session" is offered when a cloud device is connected and REFUSED
 * WITH A REASON when it is not. Squad Hub cannot provision a cloud device --
 * it is an observer of devices that dial in, not a control plane with cloud
 * credentials -- so an always-live button would be an offer it could not keep.
 * Saying how to start one is the honest version of the same help.
 */
function renderNewMenu() {
  const s = newMenuState((state.overview && state.overview.devices) || []);
  // Selected by what they DO rather than by id: these are delegated to the
  // menu's own click handler, the same way the account menu works, so an id
  // here would be a control that looks individually wired and is not.
  const menu = $('newMenu');
  menu.querySelector('[data-new="local"]').disabled = !s.localEnabled;
  menu.querySelector('[data-new="cloud"]').disabled = !s.cloudEnabled;
  const note = $('newMenuNote');
  note.hidden = !s.note;
  if (s.note) note.textContent = s.note;
}

/**
 * Remove the record of sessions that have already ended.
 *
 * Sent to every reachable device, because the device is the source of truth
 * and a hub-side removal would be undone by the next heartbeat. The result is
 * assembled from what each device actually reported.
 */
async function forgetEnded(scope) {
  const olderThanMs = forgetWindowMs(scope);
  if (olderThanMs === null) return;

  // Offline devices are swept too. Their ended sessions are removed by the hub
  // rather than by the device, because a device that never comes back cannot
  // be asked and cannot object -- and an ephemeral cloud job never comes back.
  const { reachable, skipped } = forgetTargets((state.overview && state.overview.devices) || []);
  const targets = [...reachable, ...skipped];
  if (!targets.length) {
    toast('No devices to remove sessions from');
    return;
  }
  if (scope === 'all' && !window.confirm(
    'Remove every ended session from the list?\n\n'
    + 'This clears the record of finished work. '
    + 'Sessions that are still running are not affected.')) return;

  let removed = 0;
  let failed = 0;
  for (const d of targets) {
    try {
      const r = await api(`/api/devices/${encodeURIComponent(d.deviceId)}/forget`, {
        method: 'POST',
        body: { olderThanMs },
      });
      removed += (r && r.count) || 0;
    } catch {
      // Counted, never swallowed: a device that refused must not be
      // indistinguishable from one that had nothing to remove.
      failed += 1;
    }
  }
  toast(forgetSummary({ removed, failed, skipped: 0 }));
  await refresh();
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
  if (action === 'people') { openPeople(); return; }
  if (action === 'install') {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      state.installPrompt = null;
      return;
    }
    showInstallHelp();
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
    /**
     * Build the command the person will actually paste.
     *
     * These are DEVICE settings rather than token claims, so the hub cannot
     * apply them itself -- the only place they can take effect is the command
     * run on the machine. Offering them here is the difference between "it
     * connected but cannot open a file, and nothing said it wouldn't" and a
     * device that works the way it was set up to.
     *
     * --allow-files-all implies --allow-files, so only one is ever emitted.
     */
    const flags = [];
    if ($('cnFilesAll').checked) flags.push('--allow-files-all');
    else if ($('cnFiles').checked) flags.push('--allow-files');
    if ($('cnTrackAll').checked) flags.push('--track-all');
    const cmd = `squad-hub connect --hub ${location.origin} --token ${r.token}${
      flags.length ? ` ${flags.join(' ')}` : ''}`;
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
  updateAgentChoices(d);
}

/**
 * Swap a free-text box for a picker when the device can say what it accepts.
 *
 * Shared by Agent and Model because the rule is the same for both: offer a
 * list where one exists, and a text box where it does not. A device that could
 * not tell reports null rather than an empty list, and rendering an empty
 * picker would be a claim it never made -- while also taking away the box
 * someone could have typed a name they know into.
 */
function choicesField(selId, boxId, list, blankLabel) {
  const sel = $(selId);
  const box = $(boxId);
  if (!sel || !box) return;
  if (!Array.isArray(list) || !list.length) {
    sel.hidden = true;
    box.hidden = false;
    return;
  }
  const prior = box.value;
  sel.innerHTML = `<option value="">${esc(blankLabel)}</option>${
    list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
  // Keep a choice already made, but only if this device really offers it.
  sel.value = list.includes(prior) ? prior : '';
  box.value = sel.value;
  sel.hidden = false;
  box.hidden = true;
}

function updateAgentChoices(device) {
  choicesField('nsAgentSelect', 'nsAgent', device && device.agents, 'whatever the project selects');
  choicesField('nsModelSelect', 'nsModel', device && device.models, "the agent's default");
}

/**
 * Links that start a Squad on ACA run.
 *
 * Squad Hub cannot start a cloud job and holds no credential that could. It
 * emits a URL; the person's own GitHub session does the rest.
 *
 * A NEW ISSUE, not a comment. GitHub prefills a new issue from `title`, `body`
 * and `labels`, and prefills nothing on an existing issue -- a `?body=` after a
 * `#fragment` is never read, so that route opens an empty box and loses the
 * instruction. The dispatch workflow triggers on the label and, with no
 * explicit command, tells the agent to read the issue: so the issue body IS the
 * instruction.
 *
 * This mirrors src/github-link.js. It is duplicated because `web/app.js` has no
 * build step, and routing it through the hub would put the hub in the path of
 * an action it deliberately has no part in. The refusals are the same, and both
 * are tested against the same cases.
 */
const ACA_LABEL = 'squad-aca';

function acaRepoName(name) {
  const parts = String(name == null ? '' : name).trim().replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) return null;
  const ok = (s) => /^[A-Za-z0-9._-]{1,100}$/.test(s) && !s.startsWith('.') && s !== '..';
  return ok(parts[0]) && ok(parts[1]) ? `${parts[0]}/${parts[1]}` : null;
}

/** The repository a session is checked out from, when it is on GitHub. */
function acaSessionRepo(session) {
  const git = (session && session.git) || {};
  const host = String(git.host || '').toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  return acaRepoName(git.repository);
}

function acaTitle(instruction) {
  const one = String(instruction == null ? '' : instruction).trim().replace(/\s*\r?\n\s*/g, ' ');
  if (!one) return null;
  return one.length <= 70 ? one : `${one.slice(0, 67).trimEnd()}\u2026`;
}

function acaNewIssueLink(repo, instruction) {
  const target = acaRepoName(repo);
  if (!target) return null;
  const body = String(instruction == null ? '' : instruction).trim();
  if (!body) return null;
  const url = `https://github.com/${target}/issues/new`
    + `?title=${encodeURIComponent(acaTitle(body))}`
    + `&body=${encodeURIComponent(body)}`
    + `&labels=${encodeURIComponent(ACA_LABEL)}`;
  // Refused rather than truncated: a truncated instruction is a different
  // instruction that still looks deliberate, on a page that starts compute.
  return url.length > 6000 ? null : url;
}

function acaComment(prompt) {
  const p = String(prompt == null ? '' : prompt).trim();
  if (!p) return null;
  return `/squad-aca ${p.replace(/\s*\r?\n\s*/g, ' ')}`;
}

function acaIssueLink(repo, issue) {
  const target = acaRepoName(repo);
  if (!target) return null;
  const n = Number(issue);
  return Number.isInteger(n) && n > 0 ? `https://github.com/${target}/issues/${n}` : null;
}

function openAca() {
  const cur = state.currentSession;
  $('acaErr').hidden = true;
  $('acaIssue').value = '';
  // Prefilled from the session when there is one, and editable either way: a
  // run does not have to be about the repository you happen to be looking at.
  $('acaRepo').value = (cur && acaSessionRepo(cur.session)) || '';
  $('acaPrompt').value = (cur && cur.session.prompt) || '';
  $('acaScrim').hidden = false;
  updateAcaPreview();
  ($('acaRepo').value ? $('acaPrompt') : $('acaRepo')).focus();
}

function updateAcaPreview() {
  const repo = $('acaRepo').value;
  const prompt = $('acaPrompt').value;
  const link = acaNewIssueLink(repo, prompt);
  const title = acaTitle(prompt);
  // What will actually appear, shown before anything opens. The point of this
  // route over a launcher is that the request is READ, not approved blind.
  $('acaPreview').textContent = link
    ? `${acaRepoName(repo)} · new issue: “${title}”`
    : 'Enter a repository as owner/repo, and what it should do.';
  $('acaOpen').disabled = !link;

  // The job runs wherever Squad on ACA is installed -- which is a property of
  // the repository, not of this hub. Saying so where the repository is typed is
  // the only place it can stop somebody expecting their own subscription.
  const name = acaRepoName(repo);
  const cur = state.currentSession;
  const fromSession = cur && acaSessionRepo(cur.session) === name;
  $('acaRepoHint').textContent = !name ? ''
    : fromSession ? 'From this session\u2019s checkout.'
      : 'Runs in whichever Azure subscription this repository\u2019s workflow is set up for.';

  const cmd = acaComment(prompt);
  $('acaComment').textContent = cmd || '/squad-aca \u2026';
  $('acaCopy').disabled = !cmd;
  $('acaOpenIssue').disabled = !acaIssueLink(repo, $('acaIssue').value);
}

/**
 * Who has access, for an owner.
 *
 * Every value rendered here is user-supplied -- a login somebody typed, a note
 * somebody wrote -- so all of it goes through `esc`, and the login travels back
 * to the API through `encodeURIComponent`. An access-control screen that could
 * be made to run someone else's markup would be a poor place to have that
 * particular bug.
 */
async function openPeople() {
  const box = $('peopleScrim');
  $('pplErr').hidden = true;
  $('pplLogin').value = '';
  $('pplNote').value = '';
  $('pplSearch').value = '';
  $('pplSource').value = '';
  state.people = null;
  box.hidden = false;
  await loadPeople();
  $('pplLogin').focus();
}

/**
 * Which rows to show, given the filter box and the source picker.
 *
 * Filtering is done here rather than by asking the hub again: the whole list is
 * already in hand, and a round trip per keystroke would make a fifty-person
 * list feel worse than a five-person one.
 */
function peopleVisible(users, query, source) {
  const q = String(query || '').trim().toLowerCase();
  return (users || []).filter((u) => {
    if (source && u.source !== source) return false;
    if (!q) return true;
    return `${u.login} ${u.note || ''} ${u.addedBy || ''}`.toLowerCase().includes(q);
  });
}

function peopleRows(data, query, source) {
  const all = (data && data.users) || [];
  const users = peopleVisible(all, query, source);
  if (!all.length) return '<p class="ppl-empty">Nobody else has access yet.</p>';
  if (!users.length) return '<p class="ppl-empty">Nobody matches that filter.</p>';
  return users.map((u) => {
    // A row that cannot be removed says WHY, in place, rather than offering an
    // action that fails. Being refused after clicking teaches nothing except
    // not to trust the buttons.
    const tag = u.source === 'owner' ? '<span class="ppl-tag owner">Owner</span>'
      : u.source === 'deployment' ? '<span class="ppl-tag">Deployment</span>'
        : '';
    const detail = u.source === 'added'
      ? [u.addedBy ? `added by ${u.addedBy}` : null, u.note].filter(Boolean).join(' · ')
      : u.source === 'owner' ? 'signs in as you, and shares your devices'
        : 'set in this hub\u2019s configuration';
    const action = u.removable
      ? `<button class="ghost danger sm" data-remove="${esc(u.login)}" data-source="${esc(u.source)}" aria-label="Remove ${esc(u.login)}">Remove</button>`
      : '';
    return `<div class="ppl-row" role="listitem">
      <div class="ppl-who">
        <div class="ppl-name"><span>${esc(u.login)}</span>${tag}</div>
        ${detail ? `<small>${esc(detail)}</small>` : ''}
      </div>
      ${action}
    </div>`;
  }).join('');
}

/** The one-line summary above the list, so a long list still says how long. */
function peopleSummary(data, shown) {
  const all = ((data && data.users) || []).length;
  const owners = ((data && data.users) || []).filter((u) => u.source === 'owner').length;
  const people = all - owners;
  const noun = people === 1 ? 'person' : 'people';
  const base = `${people} ${noun} with access, ${owners === 1 ? '1 owner' : `${owners} owners`}`;
  return shown === all ? base : `${base} · showing ${shown}`;
}

async function loadPeople() {
  const list = $('pplList');
  list.innerHTML = '<p class="ppl-empty">Loading…</p>';
  try {
    state.people = await api('/api/access');
  } catch (e) {
    list.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  renderPeople();
}

function renderPeople() {
  const data = state.people;
  if (!data) return;
  const list = $('pplList');
  const query = $('pplSearch').value;
  const source = $('pplSource').value;
  const shown = peopleVisible(data.users, query, source).length;

  const warn = data.ok === false
    ? `<p class="err">The access list could not be read (${esc(data.error || 'unknown')}), so it cannot be changed. The deployment's own list still applies.</p>`
    : !data.durable
      ? '<p class="ppl-warn">This hub cannot save its access list, so anyone added here is forgotten when it restarts.</p>'
      : '';
  list.innerHTML = warn + peopleRows(data, query, source);
  $('pplCount').textContent = peopleSummary(data, shown);

  list.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = async () => {
      const login = b.dataset.remove;
      // Revoking access is not undoable by accident, and the person on the
      // other end simply stops being able to sign in. Ask first, and say what
      // actually happens -- their own devices and sessions are theirs, not
      // yours, so "remove" is about this hub and not about their work.
      const extra = b.dataset.source === 'deployment'
        ? '\n\nThey are named in this hub\u2019s configuration, so the removal is recorded here and applied on top of it.'
        : '';
      if (!confirm(`Remove ${login}?\n\nThey will no longer be able to sign in to this hub.${extra}`)) return;
      b.disabled = true;
      try {
        state.people = await api(`/api/access/${encodeURIComponent(login)}`, { method: 'DELETE' });
        $('pplErr').hidden = true;
        renderPeople();
      } catch (e) {
        $('pplErr').textContent = e.message;
        $('pplErr').hidden = false;
        b.disabled = false;
      }
    };
  });
}

/**
 * Is this page already running as an installed app?
 *
 * Worth knowing because the menu should not offer to install something that
 * is already installed -- on iOS that offer is especially bad, since the only
 * thing behind it is a set of instructions the person has demonstrably already
 * followed.
 *
 * Two checks, because neither covers both worlds: `display-mode: standalone`
 * is the standard and is what Chromium reports, while iOS predates it and
 * exposes the non-standard `navigator.standalone` instead.
 */
function isInstalled(win = typeof window === 'undefined' ? null : window) {
  if (!win) return false;
  try {
    if (win.navigator && win.navigator.standalone === true) return true;
    if (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches) return true;
  } catch { /* matchMedia missing */ }
  return false;
}

/**
 * Where "Install as an app" leads when the browser will not do it for us.
 *
 * `beforeinstallprompt` exists only in Chromium on desktop and Android. **No
 * browser on iOS implements it** -- they all run WebKit, and adding a web app
 * to the Home Screen is a share-sheet action the page cannot trigger. So on an
 * iPhone this menu item can never open an installer, and saying "use your
 * browser's Install app option" is advice that names a button which is not
 * there.
 *
 * A refusal has to say what to do instead, on the device in front of the
 * person. That means naming the actual steps, and admitting the awkward part:
 * on iOS, Add to Home Screen belongs to Safari. Third-party browsers may offer
 * it in their own share menu and may not, so the reliable route is named
 * rather than guessed at.
 */
function installSteps() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua)
    // iPadOS 13+ reports itself as a Mac; a touch point tells them apart.
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  if (ios) {
    const safari = !/CriOS|EdgiOS|FxiOS|OPiOS/.test(ua);
    return {
      title: 'Add Squad Hub to your Home Screen',
      steps: safari
        ? ['Tap the Share button at the bottom of Safari.',
          'Scroll down and tap "Add to Home Screen".',
          'Tap Add.']
        : ['Tap this browser\u2019s Share button and look for "Add to Home Screen".',
          'If it is not there, open this page in Safari and use Share \u2192 Add to Home Screen.'],
      note: safari
        ? 'iOS has no install prompt a website can trigger, so this is the only route.'
        : 'On iOS, Home Screen web apps are a Safari feature. Other browsers may not offer it.',
    };
  }
  if (/Android/.test(ua)) {
    return {
      title: 'Add Squad Hub to your home screen',
      steps: ['Open the browser menu (\u22ee).', 'Tap "Install app" or "Add to Home screen".'],
      note: null,
    };
  }
  return {
    title: 'Install Squad Hub',
    steps: ['Look for the install icon in the address bar, or the browser menu \u2192 "Install Squad Hub".'],
    note: 'Firefox and Safari on the desktop do not install web apps; Chrome and Edge do.',
  };
}

function showInstallHelp() {
  const { title, steps, note } = installSteps();
  const box = $('installHelp');
  if (!box) { toast(steps[0]); return; }
  box.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ihTitle">
      <h2 id="ihTitle">${esc(title)}</h2>
      <ol class="ih-steps">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${note ? `<p class="sub">${esc(note)}</p>` : ''}
      <div class="modal-actions"><button class="primary" id="ihClose">Got it</button></div>
    </div>`;
  box.hidden = false;
  $('ihClose').onclick = () => { box.hidden = true; };
  box.onclick = (e) => { if (e.target === box) box.hidden = true; };
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
  // Before the sign-in gate: the shell is public, and someone installing the
  // app or opening it on a train should get a readable page either way.
  registerServiceWorker();
  state.token = loadToken();
  if (!state.token) return showSignIn();
  loadView();
  wire();
  syncControls();
  try {
    state.me = await api('/api/me');
    $('who').textContent = state.me.name || 'signed in';
    // The button says whose account it is, for anything that cannot see the
    // avatar. Without this a screen reader announces "Account, button" and
    // leaves out the only fact that matters on a shared machine.
    $('menuBtn').setAttribute('aria-label', `Account: ${state.me.name || 'signed in'}`);
    $('menuBtn').title = state.me.name || 'Account';
    // The user's own avatar where the provider supplies one, an initial
    // otherwise. The image is set up to fall back on its own if it fails to
    // load, so a blocked or broken avatar shows the initial rather than a
    // broken-image icon.
    setAvatar(state.me.avatar, state.me.name);
    // Only an owner is offered the access screen. Cosmetic, not a control: the
    // route checks the principal on every call, so revealing this item in a
    // console would buy a menu entry that returns 403.
    const peopleItem = document.querySelector('[data-menu="people"]');
    if (peopleItem) peopleItem.hidden = !state.me.isOwner;
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
    // No status at all means the request never got an ANSWER -- the hub is
    // unreachable, rather than the credential being refused. Saying "could not
    // sign in" there is confidently wrong: the person is signed in, and the
    // fix is to wait or check the network, not to hunt for a credential.
    //
    // This is what the offline shell is FOR. Caching the files is the easy
    // half; without this the cached page loads only to accuse you of not being
    // signed in, which is worse than the browser's own error page.
    if (e.status === undefined) return showOffline();
    document.body.innerHTML = `<div class="empty"><h3>Could not sign in</h3><p>${esc(e.message)}</p></div>`;
    return undefined;
  }
  await refresh();

  // A Teams card links here to answer an approval. Opening the hub's default
  // view instead would make the card's one working affordance a dead end --
  // the card exists BECAUSE it cannot approve in place.
  const wanted = takeDeepLinkSession();
  if (wanted) {
    const hit = resolveDeepLink(wanted, state.overview.groups);
    if (hit.status === 'found') openDetail(hit.key);
    else if (hit.status === 'ambiguous') toast(`More than one device has a session called "${wanted}" — open it from the list`);
    else toast(`That session is no longer here — it may have finished, or its device is offline`);
  }

  connect();
  setInterval(refresh, 15000);
  return undefined;
}());
