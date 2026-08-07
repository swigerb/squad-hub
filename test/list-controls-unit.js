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

const APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');
const MARKER = '(async function main()';
const idx = src.indexOf(MARKER);
if (idx < 0) {
  console.log(`  FAIL could not find the "${MARKER}" extraction anchor in web/app.js -- it moved`);
  console.log('RESULT\tfail\tweb/app.js extraction anchor is present\tanchor not found');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}
const mod = { exports: {} };
new Function('module', 'exports', `${src.slice(0, idx)}
module.exports = { esc, buildView, matchesFilters, withinWindow, sortSessions, sessionRepo,
  sessionOrg, sessionKey, needsAttention, organizationsIn, repositoriesIn,
  TIME_WINDOWS, SORTS, GROUPINGS, sessionRow };`)(mod, mod.exports);

const {
  esc, buildView, matchesFilters, withinWindow, sortSessions, sessionRepo,
  sessionOrg, needsAttention, organizationsIn, repositoriesIn,
  TIME_WINDOWS, SORTS, GROUPINGS, sessionRow,
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
  for (const k of ['started_desc', 'started_asc', 'tools_desc', 'repository']) {
    assert.ok(SORTS[k], `the sort "${k}" is offered but not implemented`);
  }
  for (const k of ['device', 'repository', 'none']) {
    assert.ok(GROUPINGS[k], `the grouping "${k}" is offered but not implemented`);
  }
  for (const k of ['', '24h', '7d', '30d']) {
    assert.ok(TIME_WINDOWS[k], `the window "${k}" is offered but not implemented`);
  }
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
