'use strict';
/**
 * S3: list controls.
 *
 * The time window, grouping, sort, repository/organisation scope and pinning
 * are all PURE functions in `web/app.js` -- state in, a plain value out, no
 * DOM and no globals. That is the whole point: a rule that lives inside a DOM
 * callback cannot be proven, and cannot have a mutation pointed at it.
 *
 * Loaded the same way web-xss-unit.js loads them: the file's DOM-free prefix
 * is sliced out and evaluated in Node. No jsdom, per the zero-runtime-
 * dependency constraint.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readWebSource } = require('./helpers/web-source');

let pass = 0; let fail = 0;
function check(name, fn) {
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\t')[0].split('\n')[0]}`);
  }
}

const src = readWebSource();
const mod = { exports: {} };
new Function('module', 'exports', `${src}
module.exports = { esc, buildView, matchesFilters, withinWindow, sortSessions, sessionRepo,
  sessionOrg, sessionKey, needsAttention, organizationsIn, repositoriesIn,
  TIME_WINDOWS, SORTS, GROUPINGS, sessionRow, skeletonRows, SCOPES, matchesScope, scopeCounts,
  activeFilterCount, viewStateToParams, paramsToViewState,
  sessionActivityAt, sessionName, isActionNeeded, presentStatuses, squadProject, NO_SQUAD_PROJECT,
  matchesSidebarText, sidebarEntries, sidebarRow, displayTitle, rowMenuItems, rowMenuHtml };`)(mod, mod.exports);

const {
  esc, buildView, matchesFilters, withinWindow, sortSessions, sessionRepo,
  sessionOrg, needsAttention, organizationsIn, repositoriesIn,
  TIME_WINDOWS, SORTS, GROUPINGS, sessionRow, skeletonRows, SCOPES, matchesScope, scopeCounts,
  activeFilterCount, viewStateToParams, paramsToViewState,
  sessionActivityAt, sessionName, isActionNeeded, presentStatuses, squadProject, NO_SQUAD_PROJECT,
  matchesSidebarText, sidebarEntries, sidebarRow, displayTitle, rowMenuItems, rowMenuHtml,
} = mod.exports;

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let n = 0;
function sess(over = {}) {
  n += 1;
  return {
    id: `s${n}`, key: `k${n}`, prompt: `prompt ${n}`, status: 'active',
    cwd: '/work', startedAt: NOW - HOUR, toolCallCount: 0, pendingApprovals: [],
    ...over,
  };
}
function group(deviceName, sessions, over = {}) {
  return { device: { name: deviceName, platform: 'linux', presence: 'online', deviceId: deviceName, ...over }, sessions };
}
const keysOf = (view) => view.sections.map((s) => ({ label: s.label, keys: s.entries.map((e) => e.session.key) }));

// ---------------------------------------------------------------------------
// The time window
// ---------------------------------------------------------------------------

check('the 24-hour window keeps something started an hour ago', () => {
  assert.strictEqual(withinWindow(sess({ startedAt: NOW - HOUR }), '24h', NOW), true);
});

check('the 24-hour window drops something started two days ago', () => {
  assert.strictEqual(withinWindow(sess({ startedAt: NOW - 2 * DAY }), '24h', NOW), false);
});

check('the window boundary is inclusive, not a one-millisecond cliff', () => {
  assert.strictEqual(withinWindow(sess({ startedAt: NOW - DAY }), '24h', NOW), true,
    'exactly 24 hours old is within "the last 24 hours" by any ordinary reading');
});

check('an empty window means no limit at all', () => {
  assert.strictEqual(withinWindow(sess({ startedAt: 1 }), '', NOW), true);
});

check('an unknown window key does not silently hide everything', () => {
  assert.strictEqual(withinWindow(sess({ startedAt: 1 }), 'not-a-window', NOW), true,
    'a typo in a saved preference must not empty the list');
});

check('a session with no start time is kept, not filtered out', () => {
  assert.strictEqual(withinWindow(sess({ startedAt: null }), '24h', NOW), true,
    '"we do not know when this started" is not evidence that it is old');
});

check('a BLOCKED session survives the time window', () => {
  const blocked = sess({ startedAt: NOW - 30 * DAY, pendingApprovals: [{ approvalId: 'a' }] });
  assert.strictEqual(matchesFilters(blocked, { window: '24h' }, NOW), true,
    'someone is waiting on an answer; hiding it turns a filter into a way to lose work');
});

check('an ordinary old session does NOT survive the time window', () => {
  const old = sess({ startedAt: NOW - 30 * DAY });
  assert.strictEqual(matchesFilters(old, { window: '24h' }, NOW), false,
    'the blocked-session exemption must not accidentally exempt everything');
});

// ---------------------------------------------------------------------------
// Repository and organisation scope
// ---------------------------------------------------------------------------

check('the repository comes from git, then squad, then the raw cwd', () => {
  assert.strictEqual(sessionRepo(sess({ git: { repository: 'acme/api' }, squad: { project: 'p' }, cwd: '/w' })), 'acme/api');
  assert.strictEqual(sessionRepo(sess({ git: null, squad: { project: 'proj' }, cwd: '/w' })), 'proj');
  assert.strictEqual(sessionRepo(sess({ git: null, squad: null, cwd: '/w' })), '/w');
});

check('the organisation is the owner half of owner/repo', () => {
  assert.strictEqual(sessionOrg(sess({ git: { repository: 'acme/api' } })), 'acme');
});

check('a repository with no owner reports no organisation', () => {
  assert.strictEqual(sessionOrg(sess({ git: null, cwd: 'localthing' })), '',
    'inventing an organisation from a bare directory name would populate the dropdown with nonsense');
});

check('the repository filter is a case-insensitive substring', () => {
  const s = sess({ git: { repository: 'Acme/Api-Service' } });
  assert.strictEqual(matchesFilters(s, { repo: 'api' }, NOW), true);
  assert.strictEqual(matchesFilters(s, { repo: 'ACME' }, NOW), true);
  assert.strictEqual(matchesFilters(s, { repo: 'other' }, NOW), false);
});

check('the organisation scope is an EXACT match, not a substring', () => {
  const s = sess({ git: { repository: 'acme/api' } });
  assert.strictEqual(matchesFilters(s, { org: 'acme' }, NOW), true);
  assert.strictEqual(matchesFilters(s, { org: 'acm' }, NOW), false,
    'a scope that matched prefixes would silently include a different organisation');
});

check('the organisation list is deduplicated and sorted', () => {
  const groups = [
    group('a', [sess({ git: { repository: 'zeta/one' } }), sess({ git: { repository: 'acme/two' } })]),
    group('b', [sess({ git: { repository: 'acme/three' } })]),
  ];
  assert.deepStrictEqual(organizationsIn(groups), ['acme', 'zeta']);
});

check('the repository list is deduplicated and sorted', () => {
  const groups = [
    group('a', [sess({ git: { repository: 'z/one' } }), sess({ git: { repository: 'a/two' } })]),
    group('b', [sess({ git: { repository: 'a/two' } })]),
  ];
  assert.deepStrictEqual(repositoriesIn(groups), ['a/two', 'z/one']);
});

// ---------------------------------------------------------------------------
// "Action needed" status filter (#169)
// ---------------------------------------------------------------------------

check('Action needed catches a session waiting on an approval', () => {
  assert.strictEqual(isActionNeeded(sess({ status: 'waiting_approval', pendingApprovals: [{ approvalId: 'a' }] })), true);
});

check('Action needed catches a session waiting on a reply, not only an approval', () => {
  assert.strictEqual(isActionNeeded(sess({ status: 'idle' })), true,
    'a person owes this session a reply just as much as they owe one an approval');
});

check('Action needed does not catch an ordinary working session', () => {
  assert.strictEqual(isActionNeeded(sess({ status: 'active' })), false);
});

check('Action needed excludes a stale session nobody can actually answer', () => {
  const device = { presence: 'offline' };
  const s = sess({ status: 'idle' });
  assert.strictEqual(isActionNeeded(s, device), false,
    'a card nobody can act on must not read as one more thing to act on (#225)');
});

check('isActionNeeded is not the same count as the protected actionNeeded metric', () => {
  // `idle` is deliberately NOT part of needsAttention (the pending-approvals-
  // only concept the API/MCP "actionNeeded" count is named after and tested
  // by in test/stale-approval-unit.js) -- only of the broader UI filter.
  assert.strictEqual(needsAttention(sess({ status: 'idle' })), false);
  assert.strictEqual(isActionNeeded(sess({ status: 'idle' })), true);
});

check('the "action" status filter keeps only sessions Action needed catches', () => {
  const idle = sess({ status: 'idle' });
  const active = sess({ status: 'active' });
  assert.strictEqual(matchesFilters(idle, { status: 'action' }, NOW), true);
  assert.strictEqual(matchesFilters(active, { status: 'action' }, NOW), false);
});

check('presentStatuses reports only the statuses actually on screen', () => {
  const groups = [
    group('a', [sess({ status: 'active' }), sess({ status: 'done' })]),
    group('b', [sess({ status: 'active' }), sess({ status: undefined })]),
  ];
  assert.deepStrictEqual([...presentStatuses(groups)].sort(), ['active', 'done'],
    'queued/review must stay hidden in the filter until a session with that exact status exists');
});

check('presentStatuses on an empty overview is an empty set, not a throw', () => {
  assert.deepStrictEqual([...presentStatuses([])], []);
  assert.deepStrictEqual([...presentStatuses()], []);
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

check('Started ↓ puts the newest first', () => {
  const list = [sess({ key: 'old', startedAt: 1 }), sess({ key: 'new', startedAt: 9 })];
  assert.deepStrictEqual(sortSessions(list, 'started_desc').map((s) => s.key), ['new', 'old']);
});

check('Started ↑ puts the oldest first', () => {
  const list = [sess({ key: 'new', startedAt: 9 }), sess({ key: 'old', startedAt: 1 })];
  assert.deepStrictEqual(sortSessions(list, 'started_asc').map((s) => s.key), ['old', 'new']);
});

check('a blocked session outranks the chosen sort', () => {
  // `Started ↑` would otherwise bury a blocked session precisely BECAUSE it
  // has been blocked a while, which is exactly backwards.
  const list = [
    sess({ key: 'oldest', startedAt: 1 }),
    sess({ key: 'blocked', startedAt: 9, pendingApprovals: [{ approvalId: 'a' }] }),
  ];
  assert.strictEqual(sortSessions(list, 'started_asc')[0].key, 'blocked',
    'the sort control orders the list; it does not get to bury a session that needs a person');
});

check('sorting does not mutate the array it was given', () => {
  const list = [sess({ key: 'a', startedAt: 1 }), sess({ key: 'b', startedAt: 9 })];
  const before = list.map((s) => s.key);
  sortSessions(list, 'started_desc');
  assert.deepStrictEqual(list.map((s) => s.key), before,
    'a sort that reorders its input makes the caller\'s next render depend on its last one');
});

check('an unknown sort key falls back rather than throwing', () => {
  const list = [sess({ key: 'a', startedAt: 1 }), sess({ key: 'b', startedAt: 9 })];
  assert.deepStrictEqual(sortSessions(list, 'nonsense').map((s) => s.key), ['b', 'a']);
});

check('every sort and grouping the UI offers actually exists', () => {
  for (const k of [
    'updated_desc', 'updated_asc', 'started_desc', 'started_asc',
    'name_asc', 'name_desc', 'tools_desc', 'repository',
  ]) {
    assert.ok(SORTS[k], `the sort "${k}" is offered but not implemented`);
  }
  for (const k of ['none', 'device', 'repository', 'status', 'squad']) {
    assert.ok(GROUPINGS[k], `the grouping "${k}" is offered but not implemented`);
  }
  for (const k of ['', '24h', '7d', '30d']) {
    assert.ok(TIME_WINDOWS[k], `the window "${k}" is offered but not implemented`);
  }
});

check('Latest updated puts the most recently active session first', () => {
  const list = [
    sess({ key: 'old', lastActivityAt: NOW - HOUR }),
    sess({ key: 'new', lastActivityAt: NOW - 1 }),
  ];
  assert.deepStrictEqual(sortSessions(list, 'updated_desc').map((s) => s.key), ['new', 'old']);
});

check('First updated puts the least recently active session first', () => {
  const list = [
    sess({ key: 'new', lastActivityAt: NOW - 1 }),
    sess({ key: 'old', lastActivityAt: NOW - HOUR }),
  ];
  assert.deepStrictEqual(sortSessions(list, 'updated_asc').map((s) => s.key), ['old', 'new']);
});

check('the updated sorts fall back to startedAt when lastActivityAt is missing', () => {
  const list = [
    sess({ key: 'old', startedAt: NOW - HOUR, lastActivityAt: undefined }),
    sess({ key: 'new', startedAt: NOW - 1, lastActivityAt: undefined }),
  ];
  assert.deepStrictEqual(sortSessions(list, 'updated_desc').map((s) => s.key), ['new', 'old'],
    'a session recorded before lastActivityAt existed must still sort by something, not vanish to "unknown"');
});

check('Name A-Z and Name Z-A sort by prompt, case-insensitively via localeCompare', () => {
  const list = [sess({ key: 'b', prompt: 'banana' }), sess({ key: 'a', prompt: 'Apple' })];
  assert.deepStrictEqual(sortSessions(list, 'name_asc').map((s) => s.key), ['a', 'b']);
  assert.deepStrictEqual(sortSessions(list, 'name_desc').map((s) => s.key), ['b', 'a']);
});

check('a session with no prompt sorts by its id instead', () => {
  assert.strictEqual(sessionName(sess({ prompt: '', id: 'zz-id' })), 'zz-id');
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

check('grouping by device puts each device in its own section', () => {
  const view = buildView({
    groups: [group('alpha', [sess({ key: 'a' })]), group('beta', [sess({ key: 'b' })])],
    groupBy: 'device', now: NOW,
  });
  assert.deepStrictEqual(keysOf(view), [
    { label: 'alpha', keys: ['a'] },
    { label: 'beta', keys: ['b'] },
  ]);
});

check('grouping by repository crosses device boundaries', () => {
  const view = buildView({
    groups: [
      group('alpha', [sess({ key: 'a', git: { repository: 'acme/api' } })]),
      group('beta', [sess({ key: 'b', git: { repository: 'acme/api' } })]),
    ],
    groupBy: 'repository', now: NOW,
  });
  assert.deepStrictEqual(keysOf(view), [{ label: 'acme/api', keys: ['a', 'b'] }],
    'the point of grouping by repository is seeing one repository worked from two machines');
});

check('no grouping produces exactly one section', () => {
  const view = buildView({
    groups: [group('alpha', [sess({ key: 'a' })]), group('beta', [sess({ key: 'b' })])],
    groupBy: 'none', now: NOW,
  });
  assert.strictEqual(view.sections.length, 1);
  assert.deepStrictEqual(view.sections[0].entries.map((e) => e.session.key), ['a', 'b']);
});

check('a group holding a blocked session floats to the top', () => {
  const view = buildView({
    groups: [
      group('alpha', [sess({ key: 'a', startedAt: NOW })]),
      group('zulu', [sess({ key: 'z', pendingApprovals: [{ approvalId: 'x' }] })]),
    ],
    groupBy: 'device', now: NOW,
  });
  assert.strictEqual(view.sections[0].label, 'zulu',
    'alphabetical order would hide the only group that needs a person behind one that does not');
});

check('groups without a blocked session are ordered by name, stably', () => {
  const view = buildView({
    groups: [group('zulu', [sess({ key: 'z' })]), group('alpha', [sess({ key: 'a' })])],
    groupBy: 'device', now: NOW,
  });
  assert.deepStrictEqual(view.sections.map((s) => s.label), ['alpha', 'zulu'],
    'a list that reshuffles under the cursor on every refresh is unusable');
});

check('a device section carries its device, so presence can be shown', () => {
  const view = buildView({ groups: [group('alpha', [sess({ key: 'a' })], { presence: 'stale' })], groupBy: 'device', now: NOW });
  assert.strictEqual(view.sections[0].device.presence, 'stale');
});

check('grouping by status buckets sessions by the same label the badge shows', () => {
  const view = buildView({
    groups: [group('alpha', [
      sess({ key: 'a', status: 'active' }),
      sess({ key: 'b', status: 'done' }),
      sess({ key: 'c', status: 'active' }),
    ])],
    groupBy: 'status', now: NOW,
  });
  const working = view.sections.find((s) => s.label === 'Working');
  const finished = view.sections.find((s) => s.label === 'Finished');
  assert.deepStrictEqual(working.entries.map((e) => e.session.key).sort(), ['a', 'c']);
  assert.deepStrictEqual(finished.entries.map((e) => e.session.key), ['b']);
});

check('a status section has no device, unlike a device section', () => {
  const view = buildView({ groups: [group('alpha', [sess({ key: 'a', status: 'active' })])], groupBy: 'status', now: NOW });
  assert.strictEqual(view.sections[0].device, null,
    'only the Device view names a single device per section -- Status and Squad both cross devices');
});

check('grouping by squad buckets sessions by their squad project', () => {
  const view = buildView({
    groups: [group('alpha', [
      sess({ key: 'a', squad: { project: 'checkout' } }),
      sess({ key: 'b', squad: { project: 'checkout' } }),
      sess({ key: 'c', squad: null }),
    ])],
    groupBy: 'squad', now: NOW,
  });
  const checkout = view.sections.find((s) => s.label === 'checkout');
  const none = view.sections.find((s) => s.label === NO_SQUAD_PROJECT);
  assert.deepStrictEqual(checkout.entries.map((e) => e.session.key).sort(), ['a', 'b']);
  assert.deepStrictEqual(none.entries.map((e) => e.session.key), ['c']);
});

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------

check('a pinned session is lifted into its own section, first', () => {
  const view = buildView({
    groups: [group('alpha', [sess({ key: 'a' }), sess({ key: 'b' })])],
    favorites: ['b'], groupBy: 'device', now: NOW,
  });
  assert.strictEqual(view.sections[0].label, 'Pinned');
  assert.deepStrictEqual(view.sections[0].entries.map((e) => e.session.key), ['b']);
});

check('a pinned session does not also appear in its device group', () => {
  const view = buildView({
    groups: [group('alpha', [sess({ key: 'a' }), sess({ key: 'b' })])],
    favorites: ['b'], groupBy: 'device', now: NOW,
  });
  const alpha = view.sections.find((s) => s.label === 'alpha');
  assert.deepStrictEqual(alpha.entries.map((e) => e.session.key), ['a'],
    'a starred row shown twice makes the list longer, not clearer');
});

check('pinning outranks every filter', () => {
  const view = buildView({
    groups: [group('alpha', [sess({ key: 'old', startedAt: NOW - 90 * DAY, git: { repository: 'other/thing' } })])],
    favorites: ['old'],
    filters: { window: '24h', repo: 'acme' },
    now: NOW,
  });
  assert.strictEqual(view.sections[0].label, 'Pinned');
  assert.deepStrictEqual(view.sections[0].entries.map((e) => e.session.key), ['old'],
    'a person pinned it; it stays until they unpin it');
});

check('with nothing pinned there is no empty Pinned section', () => {
  const view = buildView({ groups: [group('alpha', [sess({ key: 'a' })])], favorites: [], now: NOW });
  assert.ok(!view.sections.some((s) => s.label === 'Pinned'));
});

check('a favourite that no longer exists is simply not shown', () => {
  const view = buildView({ groups: [group('alpha', [sess({ key: 'a' })])], favorites: ['gone'], now: NOW });
  assert.ok(!view.sections.some((s) => s.label === 'Pinned'),
    'a session that ended must not leave a permanently empty Pinned section behind');
});

check('the pinned section is itself sorted, blocked first', () => {
  const view = buildView({
    groups: [group('alpha', [
      sess({ key: 'p1', startedAt: NOW }),
      sess({ key: 'p2', startedAt: NOW - HOUR, pendingApprovals: [{ approvalId: 'x' }] }),
    ])],
    favorites: ['p1', 'p2'], now: NOW,
  });
  assert.deepStrictEqual(view.sections[0].entries.map((e) => e.session.key), ['p2', 'p1']);
});

check('a pinned row renders a filled star, an unpinned one an empty star', () => {
  const on = sessionRow(sess({ key: 'x' }), 'dev', { pinned: true });
  const off = sessionRow(sess({ key: 'y' }), 'dev', { pinned: false });
  assert.match(on, /class="star on"/);
  assert.match(on, /aria-pressed="true"/);
  assert.match(off, /aria-pressed="false"/);
  assert.ok(!/class="star on"/.test(off));
});

check('the star carries the session key, so a click knows what to pin', () => {
  const html = sessionRow(sess({ key: 'the-key' }), 'dev', {});
  assert.match(html, /data-star="the-key"/);
});

check('a malicious session key cannot break out of the star attribute', () => {
  const html = sessionRow(sess({ key: '"><img src=x onerror=alert(1)>' }), 'dev', {});
  assert.ok(!html.includes('<img'), 'the session key escaped its attribute and became live markup');
});

// ---------------------------------------------------------------------------
// The whole pipeline
// ---------------------------------------------------------------------------

check('filters, grouping, sorting and pinning compose', () => {
  const groups = [
    group('alpha', [
      sess({ key: 'keep-new', startedAt: NOW - HOUR, git: { repository: 'acme/api' } }),
      sess({ key: 'drop-old', startedAt: NOW - 10 * DAY, git: { repository: 'acme/api' } }),
      sess({ key: 'drop-repo', startedAt: NOW - HOUR, git: { repository: 'other/thing' } }),
      sess({ key: 'pinned-old', startedAt: NOW - 99 * DAY, git: { repository: 'other/thing' } }),
    ]),
    group('beta', [
      sess({ key: 'blocked', startedAt: NOW - 99 * DAY, git: { repository: 'acme/api' }, pendingApprovals: [{ approvalId: 'a' }] }),
    ]),
  ];
  const view = buildView({
    groups, favorites: ['pinned-old'], groupBy: 'repository',
    sortBy: 'started_desc', filters: { org: 'acme', window: '24h' }, now: NOW,
  });

  assert.deepStrictEqual(keysOf(view), [
    { label: 'Pinned', keys: ['pinned-old'] },
    { label: 'acme/api', keys: ['blocked', 'keep-new'] },
  ]);
});

check('the counts describe what is actually on screen', () => {
  const view = buildView({
    groups: [group('alpha', [
      sess({ key: 'a', startedAt: NOW }),
      sess({ key: 'b', startedAt: NOW }),
      sess({ key: 'old', startedAt: NOW - 99 * DAY }),
    ])],
    favorites: ['a'], filters: { window: '24h' }, now: NOW,
  });
  assert.strictEqual(view.counts.pinned, 1);
  assert.strictEqual(view.counts.shown, 2, 'the filtered-out session must not be counted as shown');
});

check('an empty overview produces no sections and does not throw', () => {
  const view = buildView({});
  assert.deepStrictEqual(view.sections, []);
  assert.strictEqual(view.counts.shown, 0);
});

// ---------------------------------------------------------------------------
// The session detail sidebar (#181)
// ---------------------------------------------------------------------------

check('the sidebar filter matches the prompt, the session id, the device name and the repository', () => {
  const entry = { session: sess({ id: 'find-me-id', prompt: 'a prompt about widgets', git: { repository: 'acme/widgets' } }), device: { name: 'Dev Box', presence: 'online' } };
  assert.strictEqual(matchesSidebarText(entry, 'widgets'), true);
  assert.strictEqual(matchesSidebarText(entry, 'FIND-ME-ID'), true, 'the filter should be case-insensitive');
  assert.strictEqual(matchesSidebarText(entry, 'Dev Box'), true);
  assert.strictEqual(matchesSidebarText(entry, 'acme/widgets'), true);
  assert.strictEqual(matchesSidebarText(entry, 'nothing matches this'), false);
});

check('an empty filter matches everything', () => {
  const entry = { session: sess({}), device: { name: 'Dev Box', presence: 'online' } };
  assert.strictEqual(matchesSidebarText(entry, ''), true);
  assert.strictEqual(matchesSidebarText(entry, undefined), true);
});

check('sidebarEntries lists every session across every device, flat -- no grouping', () => {
  const groups = [
    group('alpha', [sess({ key: 'a1' }), sess({ key: 'a2' })]),
    group('beta', [sess({ key: 'b1' })]),
  ];
  const entries = sidebarEntries(groups, '');
  assert.deepStrictEqual(entries.map((e) => e.session.key).sort(), ['a1', 'a2', 'b1']);
});

check('sidebarEntries puts a session that needs attention first, regardless of start time', () => {
  const groups = [group('alpha', [
    sess({ key: 'recent', startedAt: NOW }),
    sess({ key: 'blocked', startedAt: NOW - DAY, pendingApprovals: [{ approvalId: 'x' }] }),
  ])];
  const entries = sidebarEntries(groups, '');
  assert.deepStrictEqual(entries.map((e) => e.session.key), ['blocked', 'recent']);
});

check('within the same attention state, sidebarEntries orders most-recently-started first', () => {
  const groups = [group('alpha', [
    sess({ key: 'older', startedAt: NOW - DAY }),
    sess({ key: 'newer', startedAt: NOW }),
  ])];
  const entries = sidebarEntries(groups, '');
  assert.deepStrictEqual(entries.map((e) => e.session.key), ['newer', 'older']);
});

check('sidebarEntries applies the text filter', () => {
  const groups = [group('alpha', [
    sess({ key: 'match', prompt: 'build the widget' }),
    sess({ key: 'nomatch', prompt: 'something else entirely' }),
  ])];
  const entries = sidebarEntries(groups, 'widget');
  assert.deepStrictEqual(entries.map((e) => e.session.key), ['match']);
});

check('sidebarEntries on no groups at all is an empty list, not a throw', () => {
  assert.deepStrictEqual(sidebarEntries(undefined, ''), []);
  assert.deepStrictEqual(sidebarEntries([], ''), []);
});

check('sidebarRow marks the open session as selected, and no other', () => {
  const entry = { session: sess({ key: 'open-me' }), device: { name: 'Dev Box', presence: 'online' } };
  const open = sidebarRow(entry, 'open-me');
  const closed = sidebarRow(entry, 'something-else');
  assert.match(open, /class="dt-side-row selected/);
  assert.match(open, /aria-current="true"/);
  assert.ok(!/selected/.test(closed));
  assert.match(closed, /aria-current="false"/);
});

check('sidebarRow flags a session that needs attention, so it can be styled apart from the rest', () => {
  const blocked = { session: sess({ key: 'x', pendingApprovals: [{ approvalId: 'a' }] }), device: { name: 'Dev Box', presence: 'online' } };
  const idle = { session: sess({ key: 'y' }), device: { name: 'Dev Box', presence: 'online' } };
  assert.match(sidebarRow(blocked, null), /\bdt-side-row[^"]*\battention\b/);
  assert.ok(!/\battention\b/.test(sidebarRow(idle, null)));
});

check('sidebarRow carries the session key as the click target, so a click knows what to open', () => {
  const entry = { session: sess({ key: 'the-key' }), device: { name: 'Dev Box', presence: 'online' } };
  assert.match(sidebarRow(entry, null), /data-session="the-key"/);
});

check('a malicious session key cannot break out of the sidebar row markup', () => {
  const entry = { session: sess({ key: '"><img src=x onerror=alert(1)>' }), device: { name: 'Dev Box', presence: 'online' } };
  assert.ok(!sidebarRow(entry, null).includes('<img'),
    'the session key escaped its attribute and became live markup in the sidebar');
});

// ---------------------------------------------------------------------------
// Truncated metadata gets a title tooltip (#186)
// ---------------------------------------------------------------------------

check('the device, repository and branch each carry a title with their full value', () => {
  const html = sessionRow(sess({
    key: 'k', git: { repository: 'a-very-long-organisation-name/a-very-long-repository-name', branch: 'feature/a-rather-long-branch-name' },
  }), 'A device with an extremely long and descriptive name', {});
  assert.match(html, /<span class="meta-field" title="A device with an extremely long and descriptive name">/,
    'the device name has no title, so a truncated one cannot be read in full');
  assert.match(html, /<span class="meta-field" title="a-very-long-organisation-name\/a-very-long-repository-name">/,
    'the repository has no title');
  assert.match(html, /<span class="branch" title="feature\/a-rather-long-branch-name">/,
    'the branch has no title');
});

check('a malicious device name or repository cannot break out of its title attribute', () => {
  const html = sessionRow(
    sess({ key: 'k', git: { repository: '"><img src=x onerror=alert(1)>', branch: '"><img src=x onerror=alert(2)>' } }),
    '"><img src=x onerror=alert(3)>',
    {},
  );
  assert.ok(!html.includes('<img'), 'an attacker-controlled field escaped its attribute and became live markup');
});

check('a session with no device, repository or branch renders no empty title spans', () => {
  const html = sessionRow(sess({ key: 'k', cwd: '', git: undefined }), '', {});
  assert.ok(!/title=""/.test(html), 'an empty field should not be rendered with an empty title at all');
});

// ---------------------------------------------------------------------------
// Loading skeletons (#186)
// ---------------------------------------------------------------------------

check('skeletonRows renders the requested number of placeholder rows', () => {
  const html = skeletonRows(3);
  assert.strictEqual((html.match(/class="row skeleton-row"/g) || []).length, 3);
});

check('skeletonRows defaults to a handful of rows when called with nothing', () => {
  const html = skeletonRows();
  assert.ok((html.match(/skeleton-row/g) || []).length > 0, 'no default was offered at all');
});

check('a skeleton row is marked aria-hidden, so nothing is announced for a row with no label', () => {
  const html = skeletonRows(1);
  assert.match(html, /class="row skeleton-row" aria-hidden="true"/);
});

// ---------------------------------------------------------------------------
// Scope tabs (#168): All / Local / Cloud
// ---------------------------------------------------------------------------

check('scope tabs: matchesScope partitions by device kind', () => {
  const local = { name: 'alpha' };
  const cloud = { name: 'beta', kind: 'cloud' };
  const aca = { name: 'gamma', kind: 'aca' };
  assert.strictEqual(matchesScope('all', local), true);
  assert.strictEqual(matchesScope('all', cloud), true);
  assert.strictEqual(matchesScope('local', local), true);
  assert.strictEqual(matchesScope('local', cloud), false);
  assert.strictEqual(matchesScope('cloud', local), false);
  assert.strictEqual(matchesScope('cloud', cloud), true, 'kind "cloud" belongs on the Cloud tab');
  assert.strictEqual(matchesScope('cloud', aca), true, 'kind "aca" (#166) also belongs on the Cloud tab');
});

check('scope tabs: an unknown scope key matches everything, like "all"', () => {
  assert.strictEqual(matchesScope('nonsense', { kind: 'cloud' }), true);
  assert.strictEqual(matchesScope(undefined, { kind: 'cloud' }), true);
});

check('scope tabs: a device with no kind at all is Local, not dropped', () => {
  assert.strictEqual(matchesScope('local', {}), true);
  assert.strictEqual(matchesScope('local', undefined), true);
  assert.strictEqual(matchesScope('cloud', undefined), false);
});

check('scope tabs: buildView excludes a pinned session from a scope it is not on', () => {
  const groups = [
    group('alpha', [sess({ key: 'local-1' })]),
    group('beta', [sess({ key: 'cloud-1' })], { kind: 'cloud' }),
  ];
  const localView = buildView({ groups, favorites: ['cloud-1'], scope: 'local', now: NOW });
  assert.deepStrictEqual(keysOf(localView), [{ label: 'alpha', keys: ['local-1'] }],
    'a star does not teleport a cloud session onto the Local tab');

  const cloudView = buildView({ groups, favorites: ['cloud-1'], scope: 'cloud', now: NOW });
  assert.deepStrictEqual(keysOf(cloudView), [{ label: 'Pinned', keys: ['cloud-1'] }]);
});

check('scope tabs: scope and filters compose -- a session must satisfy both', () => {
  const groups = [
    group('alpha', [
      sess({ key: 'match', git: { repository: 'acme/api' } }),
      sess({ key: 'wrong-repo', git: { repository: 'other/thing' } }),
    ], { kind: 'cloud' }),
    group('beta', [sess({ key: 'wrong-scope', git: { repository: 'acme/api' } })]),
  ];
  const view = buildView({ groups, scope: 'cloud', filters: { org: 'acme' }, now: NOW });
  assert.deepStrictEqual(keysOf(view), [{ label: 'alpha', keys: ['match'] }]);
});

check('scope tabs: scopeCounts reflects the current filters but ignores scope itself', () => {
  const groups = [
    group('alpha', [
      sess({ key: 'local-shown', startedAt: NOW }),
      sess({ key: 'local-old', startedAt: NOW - 99 * DAY }),
    ]),
    group('beta', [
      sess({ key: 'cloud-shown', startedAt: NOW }),
    ], { kind: 'cloud' }),
  ];
  const counts = scopeCounts(groups, { window: '24h' }, [], NOW);
  assert.deepStrictEqual(counts, { all: 2, local: 1, cloud: 1 });
});

check('scope tabs: scopeCounts counts a pinned session under its own scope, bypassing filters', () => {
  const groups = [
    group('alpha', [sess({ key: 'pinned-old', startedAt: NOW - 99 * DAY })]),
  ];
  const counts = scopeCounts(groups, { window: '24h' }, ['pinned-old'], NOW);
  assert.deepStrictEqual(counts, { all: 1, local: 1, cloud: 0 });
});

check('activeFilterCount counts only the dropdown filters, never the keyword box', () => {
  assert.strictEqual(activeFilterCount({}), 0);
  assert.strictEqual(activeFilterCount({ q: 'something' }), 0, 'the keyword box has its own always-visible input; it is not behind the phone filter button');
  assert.strictEqual(activeFilterCount({ status: 'active', window: '24h' }), 2);
  assert.strictEqual(activeFilterCount({ status: 'active', device: 'x', repo: 'y', org: 'z', window: '24h' }), 5);
});

check('viewStateToParams / paramsToViewState round-trip a non-default view', () => {
  const view = {
    scope: 'cloud',
    filters: { q: 'flaky', status: 'active', device: 'alpha', repo: 'acme/api', org: 'acme', window: '7d' },
    groupBy: 'repository',
    sortBy: 'tools_desc',
  };
  const params = viewStateToParams(view);
  assert.deepStrictEqual(params, {
    scope: 'cloud', q: 'flaky', status: 'active', device: 'alpha', repo: 'acme/api',
    org: 'acme', window: '7d', view: 'repository', sort: 'tools_desc',
  });
  assert.deepStrictEqual(paramsToViewState(params), view);
});

check('viewStateToParams omits whatever is already at its default', () => {
  const params = viewStateToParams({ scope: 'all', groupBy: 'device', sortBy: 'started_desc', filters: {} });
  assert.deepStrictEqual(params, {}, 'a link to the default view should not override someone else\'s own settings');
});

check('paramsToViewState ignores a stale or hand-edited value rather than applying it', () => {
  const state = paramsToViewState({ scope: 'deleted-tab', sort: 'deleted-sort', view: 'deleted-view', window: 'deleted-window' });
  assert.deepStrictEqual(state, {}, 'an option that no longer exists must never reach the UI as if it were real');
});

check('devices.css pins .star, .status, .row-main and .more to the same grid row (#169/#231, extended by #170)', () => {
  // Markup order is .star, .status, .row-main, .more (columns 1, 3, 2, 4 --
  // see the comment above `.row` in devices.css). Without an explicit
  // `grid-row`, sparse auto-placement walks that source order, and once
  // `.status` claims column 3 the cursor is past column 2, so `.row-main`
  // (column 2) is pushed onto a second implicit row -- the star/pill and the
  // title drift 32px apart instead of sharing one 22px line. The ⋯ button
  // (#170) is appended last in markup and in column 4, so it is equally at
  // risk of the same drift and is pinned the same way. This is a plain text
  // assertion, not a layout measurement: it only proves the pinning rule is
  // still present in the stylesheet, not that a browser renders it correctly
  // (see the real-Chromium check in browser-e2e-unit.js for that).
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'css', 'devices.css'), 'utf8');
  const pinned = /\.row\s*>\s*\.star\s*,\s*\.row\s*>\s*\.status\s*,\s*\.row\s*>\s*\.row-main\s*,\s*\.row\s*>\s*\.more\s*\{\s*grid-row:\s*1;?\s*\}/.test(css);
  assert.ok(pinned, '.row > .star, .row > .status, .row > .row-main, .row > .more { grid-row: 1; } is missing from devices.css -- the star/pill/title/more button can drift onto separate grid rows again');
});

// ---------------------------------------------------------------------------
// The per-row ⋯ menu: display names and menu contents (#170)
// ---------------------------------------------------------------------------

check('displayTitle falls back to the prompt when there is no custom name', () => {
  assert.strictEqual(displayTitle(sess({ key: 'k1', prompt: 'do the thing' }), {}), 'do the thing');
});

check('displayTitle prefers a custom name, keyed by session key', () => {
  const s = sess({ key: 'k2', prompt: 'do the thing' });
  assert.strictEqual(displayTitle(s, { k2: 'release branch' }), 'release branch');
});

check('displayTitle ignores a blank or whitespace-only custom name', () => {
  const s = sess({ key: 'k3', prompt: 'do the thing' });
  assert.strictEqual(displayTitle(s, { k3: '   ' }), 'do the thing');
});

check('displayTitle falls back to the id when there is no prompt either', () => {
  const s = sess({ key: 'k4', prompt: '', id: 'raw-id' });
  assert.strictEqual(displayTitle(s, {}), 'raw-id');
});

check('a renamed row shows the custom name, with the raw prompt as its tooltip', () => {
  const html = sessionRow(sess({ key: 'k5', prompt: 'do the thing' }), 'Dev', { names: { k5: 'release branch' } });
  assert.match(html, /<b title="do the thing">release branch<\/b>/,
    'the renamed title should carry a title attribute with the original prompt');
});

check('an un-renamed row carries no title on its title element', () => {
  const html = sessionRow(sess({ key: 'k6', prompt: 'do the thing' }), 'Dev', {});
  assert.match(html, /<b>do the thing<\/b>/);
});

check('a malicious custom name renders as inert text, never a live tag', () => {
  const xss = '<img src=x onerror=alert(1)>';
  const html = sessionRow(sess({ key: 'k6b', prompt: 'do the thing' }), 'Dev', { names: { k6b: xss } });
  assert.ok(!html.includes(xss), 'the raw payload must not appear unescaped in the row');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the escaped form of the custom name should still be there');
});

check('a malicious raw prompt in the renamed tooltip renders as inert text', () => {
  const xss = '<img src=x onerror=alert(1)>';
  const html = sessionRow(sess({ key: 'k6c', prompt: xss }), 'Dev', { names: { k6c: 'release branch' } });
  assert.ok(!html.includes(`title="${xss}"`), 'the raw payload must not appear unescaped in the tooltip');
  assert.ok(html.includes('title="&lt;img src=x onerror=alert(1)&gt;"'));
});

check('every row carries a ⋯ button keyed to its own session', () => {
  const html = sessionRow(sess({ key: 'k7' }), 'Dev', {});
  assert.match(html, /<button class="more" data-more="k7"/);
});

check('rowMenuItems always offers Open, Pin/Unpin, Rename… and Copy link', () => {
  const items = rowMenuItems(sess({ status: 'ended' }), null, {});
  const actions = items.filter((it) => !it.sep).map((it) => it.action);
  assert.ok(actions.includes('open'));
  assert.ok(actions.includes('pin'));
  assert.ok(actions.includes('rename'));
  assert.ok(actions.includes('copylink'));
});

check('rowMenuItems labels Pin as Unpin, with a filled star, once pinned', () => {
  const items = rowMenuItems(sess(), null, { pinned: true });
  const pin = items.find((it) => it.action === 'pin');
  assert.strictEqual(pin.label, 'Unpin');
  assert.strictEqual(pin.glyph, '★');
});

check('rowMenuItems offers Stop, never Remove, for a live session', () => {
  const items = rowMenuItems(sess({ status: 'active' }), { presence: 'online' }, {});
  const actions = items.filter((it) => !it.sep).map((it) => it.action);
  assert.ok(actions.includes('stop'));
  assert.ok(!actions.includes('remove'));
});

check('rowMenuItems offers Remove, never Stop, for an ended session', () => {
  const items = rowMenuItems(sess({ status: 'ended' }), { presence: 'online' }, {});
  const actions = items.filter((it) => !it.sep).map((it) => it.action);
  assert.ok(actions.includes('remove'));
  assert.ok(!actions.includes('stop'));
});

check('rowMenuItems disables Stop, with a reason, when the device is unreachable', () => {
  const items = rowMenuItems(sess({ status: 'active' }), { presence: 'offline' }, {});
  const stop = items.find((it) => it.action === 'stop');
  assert.strictEqual(stop.disabled, true);
  assert.ok(stop.title, 'a disabled Stop should still say WHY, not just sit greyed out');
});

check('rowMenuItems offers Run on ACA… only when the session has a GitHub checkout', () => {
  const withRepo = rowMenuItems(sess({ git: { repository: 'acme/widgets', host: 'github.com' } }), null, {});
  const withoutRepo = rowMenuItems(sess({ git: undefined, cwd: '' }), null, {});
  assert.ok(withRepo.some((it) => it.action === 'aca'));
  assert.ok(!withoutRepo.some((it) => it.action === 'aca'));
});

check('rowMenuItems offers Open pull request only when pullRequest is set', () => {
  const withPr = rowMenuItems(sess({ pullRequest: { url: 'https://github.com/acme/widgets/pull/9', number: 9 } }), null, {});
  const withoutPr = rowMenuItems(sess({ pullRequest: null }), null, {});
  const pr = withPr.find((it) => it.action === 'pr');
  assert.ok(pr);
  assert.strictEqual(pr.href, 'https://github.com/acme/widgets/pull/9');
  assert.ok(!withoutPr.some((it) => it.action === 'pr'));
});

check('rowMenuItems offers Open in Aspire only when aspireUrl is set', () => {
  const withAspire = rowMenuItems(sess({ aspireUrl: 'https://aspire.example/dash' }), null, {});
  const withoutAspire = rowMenuItems(sess({}), null, {});
  assert.ok(withAspire.some((it) => it.action === 'aspire'));
  assert.ok(!withoutAspire.some((it) => it.action === 'aspire'));
});

check('rowMenuItems only separates non-empty clusters with a divider', () => {
  // No links cluster at all (no ACA repo, no PR, no Aspire URL): exactly one
  // divider, between identity and lifecycle, never two in a row.
  const items = rowMenuItems(sess({ status: 'active', git: undefined, cwd: '', pullRequest: null }), null, {});
  const seps = items.filter((it) => it.sep).length;
  assert.strictEqual(seps, 1, `expected exactly one divider, got ${seps}`);
  assert.ok(!items[0].sep, 'the menu should never open on a divider');
  assert.ok(!items[items.length - 1].sep, 'the menu should never end on a divider');
});

check('rowMenuHtml renders a button per item, with the glyph and label, and a divider as its own element', () => {
  const html = rowMenuHtml([
    { action: 'open', label: 'Open', glyph: '↗' },
    { sep: true },
    { action: 'stop', label: 'Stop session', glyph: '■', danger: true },
  ]);
  assert.match(html, /<button type="button" data-row-action="open"[^>]*>↗ Open<\/button>/);
  assert.match(html, /<div class="menu-sep"><\/div>/);
  assert.match(html, /<button type="button" data-row-action="stop" class="danger"/);
});

check('rowMenuHtml marks a disabled item disabled, with its title as the reason', () => {
  const html = rowMenuHtml([{ action: 'stop', label: 'Stop session', glyph: '■', disabled: true, title: 'reason here' }]);
  assert.match(html, /disabled/);
  assert.match(html, /title="reason here"/);
});

check('a malicious pull-request URL cannot break out of the row menu\'s data-href attribute', () => {
  const html = rowMenuHtml(rowMenuItems(sess({ pullRequest: { url: '"><img src=x onerror=alert(1)>', number: 1 } }), null, {}));
  assert.ok(!html.includes('<img'), 'an attacker-controlled pullRequest.url escaped its attribute and became live markup');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
