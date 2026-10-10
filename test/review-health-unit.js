'use strict';
/**
 * #179: "Ready for review" and the Squad health badge.
 *
 * A session that has ENDED and reports a valid pull request reads "Ready for
 * review" (violet), links to the pull request on its row and on its detail
 * page, and is selected by the Status filter's "Ready for review" option. A
 * session's Squad health shows as "● healthy" or "● health: N failing" on its
 * row, with the per-check list in the detail page's Squad panel.
 *
 * Everything here is DOM-free (the same flattened web source the other list
 * tests load) except `syncReviewDetail`, which gets a stand-in `document`. The
 * browser-level behavior -- the link really opening, the filter really
 * narrowing the list, the pill really being 22px tall -- is in
 * browser-e2e-unit.js.
 */

const assert = require('assert');
const http = require('http');
const { readWebSource } = require('./helpers/web-source');
const { sanitizePullRequest } = require('../src/pull-request');
const server = require('../src/session-status');
const { STATUS } = require('../src/acp-session');
const { Store } = require('../src/service/store');
const { createHubClient } = require('../src/mcp-hub-client');

let pass = 0; let fail = 0;
function report(name, error) {
  if (!error) {
    pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${error.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(error.message).split('\t')[0].split('\n')[0]}`);
  }
}
function check(name, fn) {
  try { fn(); report(name); } catch (e) { report(name, e); }
}
async function checkAsync(name, fn) {
  try { await fn(); report(name); } catch (e) { report(name, e); }
}

const mod = { exports: {} };
new Function('module', 'exports', `${readWebSource()}
module.exports = {
  TERMINAL_STATUSES, NON_TERMINAL_STATUSES, pullRequestOf, isReadyForReview, isStaleSession,
  statusLabel, statusBadge, statusPillClass, matchesFilters, matchesHubFilters, narrowGroups, scopeCounts,
  presentStatuses, buildView,
  sessionRow, sidebarRow, prLinkHtml, squadHealthView, healthBadgeHtml, healthChecksHtml, syncReviewDetail,
};`)(mod, mod.exports);
const {
  TERMINAL_STATUSES, NON_TERMINAL_STATUSES, pullRequestOf, isReadyForReview, isStaleSession,
  statusLabel, statusBadge, statusPillClass, matchesFilters, matchesHubFilters, narrowGroups, scopeCounts,
  presentStatuses, buildView,
  sessionRow, sidebarRow, prLinkHtml, squadHealthView, healthBadgeHtml, healthChecksHtml, syncReviewDetail,
} = mod.exports;

const PR = { url: 'https://github.com/swigerb/squad-hub/pull/179', number: 179, title: 'Ready for review and health' };
const online = { name: 'laptop', deviceId: 'laptop', platform: 'linux', presence: 'online' };
const offline = { ...online, presence: 'offline' };
let n = 0;
function sess(over = {}) {
  n += 1;
  return {
    id: `s${n}`, key: `k${n}`, prompt: `prompt ${n}`, status: 'done', cwd: '/work', startedAt: 1_700_000_000_000,
    toolCallCount: 0, pendingApprovals: [], pullRequest: { ...PR }, ...over,
  };
}
const pill = (s, d = online) => statusPillClass(s, d);

// ---------------------------------------------------------------------------
// What "ended" means, and that every copy of it agrees
// ---------------------------------------------------------------------------

check('the ended and not-ended status sets never overlap', () => {
  const both = [...TERMINAL_STATUSES].filter((s) => NON_TERMINAL_STATUSES.has(s));
  assert.deepStrictEqual(both, []);
});

check('every status the agent can report, plus disconnected, is in exactly one set', () => {
  for (const status of [...Object.values(STATUS), 'disconnected']) {
    const inTerminal = TERMINAL_STATUSES.has(status);
    const inLive = NON_TERMINAL_STATUSES.has(status);
    assert.ok(inTerminal !== inLive, `${status} must be ended XOR live (ended=${inTerminal}, live=${inLive})`);
  }
});

check('the browser and the hub agree on which statuses are ended', () => {
  assert.deepStrictEqual([...TERMINAL_STATUSES].sort(), [...server.TERMINAL_STATUSES].sort());
  assert.deepStrictEqual([...TERMINAL_STATUSES].sort(), ['disconnected', 'done', 'failed', 'stopped']);
});

// ---------------------------------------------------------------------------
// Ready for review: which sessions, and what they read
// ---------------------------------------------------------------------------

check('an ended session with a valid pull request is ready for review', () => {
  for (const status of ['done', 'failed', 'stopped', 'disconnected']) {
    const s = sess({ status });
    assert.strictEqual(isReadyForReview(s), true, status);
    assert.strictEqual(statusLabel(s, online), 'Ready for review', status);
  }
});

check('a session that is still going is NOT ready, even with a pull request', () => {
  for (const status of ['starting', 'active', 'waiting_approval', 'idle']) {
    const s = sess({ status });
    assert.strictEqual(isReadyForReview(s), false, status);
    assert.notStrictEqual(statusLabel(s, online), 'Ready for review', status);
  }
});

check('an idle session awaiting a reply keeps its own words and class, not the violet pill', () => {
  const s = sess({ status: 'idle' });
  assert.strictEqual(statusLabel(s, online), 'Awaiting your reply');
  assert.strictEqual(pill(s), 'review');
  assert.match(statusBadge(s, online), /class="status review"/);
});

check('a status this build does not know is never treated as ended', () => {
  for (const status of ['queued', 'bogus', '', undefined, null]) {
    assert.strictEqual(isReadyForReview(sess({ status })), false, String(status));
  }
});

check('an ended session with no pull request reads exactly as it did before', () => {
  assert.strictEqual(statusLabel(sess({ status: 'done', pullRequest: null }), online), 'Finished');
  assert.strictEqual(statusLabel(sess({ status: 'done', pullRequest: undefined }), online), 'Finished');
  assert.strictEqual(statusLabel(sess({ status: 'failed', pullRequest: null }), online), 'Failed');
  assert.strictEqual(statusLabel(sess({ status: 'stopped', pullRequest: null }), online), 'Stopped');
  assert.strictEqual(statusLabel(sess({ status: 'disconnected', pullRequest: null }), online), 'Device disconnected');
});

check('the badge, the label and the detail pill give the same session the same answer', () => {
  const s = sess();
  assert.strictEqual(statusBadge(s, online), '<span class="status ready">Ready for review</span>');
  assert.strictEqual(pill(s), 'ready');
});

check('a pending approval outranks ready for review, on the label, the badge and the pill', () => {
  const s = sess({ pendingApprovals: [{ id: 'a1', title: 'run it' }] });
  assert.strictEqual(isReadyForReview(s), false);
  assert.strictEqual(statusLabel(s, online), 'Needs approval');
  assert.strictEqual(statusBadge(s, online), '<span class="status attention">Needs approval</span>');
  assert.strictEqual(pill(s), 'attention');
});

check('an unreachable device still outranks everything: a stale session is never ready', () => {
  for (const s of [sess({ status: 'idle' }), sess({ status: 'active' }), sess({ pendingApprovals: [{ id: 'a1' }] })]) {
    assert.strictEqual(isStaleSession(s, offline), true);
    assert.strictEqual(statusLabel(s, offline), 'Unreachable — device offline');
    assert.strictEqual(pill(s, offline), 'stale');
  }
});

check('an ended session with a pull request stays ready when its device is offline', () => {
  const s = sess();
  assert.strictEqual(isStaleSession(s, offline), false);
  assert.strictEqual(statusLabel(s, offline), 'Ready for review');
  assert.strictEqual(pill(s, offline), 'ready');
});

// ---------------------------------------------------------------------------
// The pull request: the browser applies the hub's own rule
// ---------------------------------------------------------------------------

const HOSTILE = [
  null, undefined, 'https://github.com/o/r/pull/1', 7, true, [], {}, { url: null, number: 1 },
  { url: 'https://github.com/o/r/pull/1' }, { url: 'https://github.com/o/r/pull/1', number: '1' },
  { url: 'https://github.com/o/r/pull/1', number: 2 }, { url: 'https://github.com/o/r/pull/1', number: 1.5 },
  { url: 'https://github.com/o/r/pull/1', number: -1 }, { url: 'https://github.com/o/r/pull/1', number: NaN },
  { url: 'https://github.com/o/r/pull/0', number: 0 }, { url: 'https://github.com/o/r/pull/01', number: 1 },
  { url: 'javascript:alert(1)', number: 1 }, { url: 'data:text/html,<script>alert(1)</script>', number: 1 },
  { url: 'http://github.com/o/r/pull/1', number: 1 }, { url: 'https://evil.example.com/o/r/pull/1', number: 1 },
  { url: 'https://github.com.evil.example/o/r/pull/1', number: 1 }, { url: 'https://github.com/o/r/issues/1', number: 1 },
  { url: 'https://github.com/o/r/pull/1/', number: 1 }, { url: 'https://github.com/o/r/pull/1?x=1', number: 1 },
  { url: 'https://github.com/o/r/pull/1#files', number: 1 }, { url: 'https://github.com/o/r/pull/1 ', number: 1 },
  { url: 'https://github.com/o/r/pull/1"onmouseover="alert(1)', number: 1 },
  { url: `https://github.com/o/${'r'.repeat(300)}/pull/1`, number: 1 },
  { url: 'https://github.com/o/r/pull/1', number: 1, title: '' },
  { url: 'https://github.com/o/r/pull/1', number: 1, title: 'x'.repeat(201) },
  { url: 'https://github.com/o/r/pull/1', number: 1, title: '<img src=x onerror=alert(1)>' },
  { url: 'https://github.com/o/r/pull/1', number: 1, title: 'two\nlines' },
  { url: 'https://github.com/o/r/pull/1', number: 1, title: 5 },
];
const VALID = [
  { url: 'https://github.com/o/r/pull/1', number: 1 },
  { url: 'https://github.com/o/r/pull/1', number: 1, title: null },
  { url: 'https://github.com/my-org/my.repo_1/pull/42', number: 42, title: 'Fix "quotes" & ampersands' },
  { url: 'https://github.com/o/r/pull/1', number: 1, title: 'x'.repeat(200) },
  PR,
];

check('the browser accepts and rejects exactly what the hub accepts and rejects', () => {
  for (const pullRequest of [...VALID, ...HOSTILE]) {
    assert.deepStrictEqual(pullRequestOf({ pullRequest }), sanitizePullRequest(pullRequest), JSON.stringify(pullRequest));
  }
});

check('a hostile or malformed pull request never makes a session ready, whatever its status', () => {
  for (const pullRequest of HOSTILE) {
    const s = sess({ pullRequest });
    assert.strictEqual(isReadyForReview(s), false, JSON.stringify(pullRequest));
    assert.strictEqual(prLinkHtml(s), '', JSON.stringify(pullRequest));
    assert.ok(!/class="row ready"|Open PR/.test(sessionRow(s, 'laptop', { device: online })), JSON.stringify(pullRequest));
  }
});

check('the hub and the browser agree on which sessions are ready, across every status and pull request', () => {
  const statuses = [...Object.values(STATUS), 'disconnected', 'queued', 'bogus', undefined];
  for (const status of statuses) {
    for (const pullRequest of [...VALID, ...HOSTILE]) {
      for (const pendingApprovals of [[], [{ id: 'a' }]]) {
        const s = { id: 'x', status, pullRequest, pendingApprovals };
        assert.strictEqual(isReadyForReview(s), server.isReadyForReview(s), JSON.stringify(s));
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The row: the link, the class, and what the link does not do
// ---------------------------------------------------------------------------

const rowHtml = (s, extra = {}) => sessionRow(s, 'laptop', { device: online, ...extra });

check('a ready row carries the violet class, the pill and an Open PR link', () => {
  const html = rowHtml(sess());
  assert.match(html, /class="row ready"/);
  assert.match(html, /<span class="status ready">Ready for review<\/span>/);
  assert.match(html, /<div class="row-links">\s*<a class="pr-link" href="https:\/\/github\.com\/swigerb\/squad-hub\/pull\/179"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer" data-pr-link/);
  assert.match(html, />Open PR ↗<\/a>/);
  assert.match(html, /aria-label="Open PR #179 \(opens in a new tab\)"/);
  assert.match(html, /title="#179 — Ready for review and health"/);
});

check('the pill is still the first status in the row, so it keeps the grid cell the CSS gives it', () => {
  const html = rowHtml(sess());
  assert.ok(html.indexOf('class="status ready"') < html.indexOf('class="row-main"'));
});

check('a session that is not ready has no link, and no violet row, even with a pull request', () => {
  for (const s of [sess({ status: 'active' }), sess({ status: 'idle' }), sess({ pullRequest: null }),
    sess({ pendingApprovals: [{ id: 'a1' }] })]) {
    const html = rowHtml(s);
    assert.ok(!html.includes('Open PR'), s.status);
    assert.ok(!html.includes('row-links'), s.status);
    assert.ok(!/class="row ready"/.test(html), s.status);
  }
});

check('a row with a pending approval stays amber, not violet', () => {
  assert.match(rowHtml(sess({ pendingApprovals: [{ id: 'a1' }] })), /class="row attention"/);
});

check('a Squad session row carries the health badge in its Squad line, and a row without Squad health carries none', () => {
  const squadRow = (health) => rowHtml(sess({ pullRequest: null, squad: { project: 'acme', health } }));
  const failing = squadRow({ status: 'fail', checks: [{ id: 'routing', status: 'fail' }, { id: 'team', status: 'pass' }] });
  assert.match(failing, /<div class="squadline">[\s\S]*<span class="health failing" title="Squad health: failing checks — routing">[\s\S]*health: 1 failing[\s\S]*<\/div>/);
  assert.match(squadRow({ status: 'pass', checks: [{ id: 'team', status: 'pass' }] }), /class="health healthy"/);
  assert.ok(!squadRow({ status: 'unknown' }).includes('class="health'), 'an unknown report draws nothing');
  assert.ok(!squadRow(undefined).includes('class="health'), 'no report draws nothing');
  assert.ok(!rowHtml(sess({ squad: null })).includes('class="health'), 'a row that is not a Squad session has no badge');
});

check('a pull request title with markup is text in the tooltip, never markup', () => {
  // The hub's sanitizer refuses `<`, so quotes and ampersands are the hostile
  // characters left -- and the page must not trust the hub to have refused.
  const s = sess({ pullRequest: { url: PR.url, number: 179, title: 'a" onmouseover="alert(1)" x=&amp;' } });
  const html = prLinkHtml(s);
  assert.ok(!html.includes('"onmouseover'), html);
  assert.match(html, /title="#179 — a&quot; onmouseover=&quot;alert\(1\)&quot; x=&amp;amp;"/);
  const evil = prLinkHtml(sess({ pullRequest: { url: PR.url, number: 179, title: '<img src=x onerror=alert(1)>' } }));
  assert.strictEqual(evil, '', 'a title with markup is rejected outright, taking the link with it');
});

check('the sidebar row shows the same ready pill', () => {
  assert.match(sidebarRow({ session: sess(), device: online }, null), /<span class="status ready">Ready for review<\/span>/);
});

// ---------------------------------------------------------------------------
// The Status filter: the browser, the store, the MCP client
// ---------------------------------------------------------------------------

const groups = () => [{
  device: online,
  sessions: [
    sess({ id: 'ready', status: 'done' }),
    sess({ id: 'failed-pr', status: 'failed' }),
    sess({ id: 'done-plain', status: 'done', pullRequest: null }),
    sess({ id: 'active-pr', status: 'active' }),
    sess({ id: 'idle-pr', status: 'idle' }),
    sess({ id: 'approval', status: 'done', pendingApprovals: [{ id: 'a' }] }),
  ],
}];
const idsOf = (view) => view.sections.flatMap((sec) => sec.entries.map((e) => e.session.id)).sort();

check('the review filter shows exactly the sessions that are ready for review', () => {
  const view = buildView({ groups: groups(), filters: { status: 'review' } });
  assert.deepStrictEqual(idsOf(view), ['failed-pr', 'ready']);
});

check('matchesFilters applies the review filter itself, because a pushed overview is unfiltered', () => {
  const [g] = groups();
  assert.strictEqual(matchesFilters(g.sessions[0], { status: 'review' }, Date.now(), online), true);
  assert.strictEqual(matchesFilters(g.sessions[2], { status: 'review' }, Date.now(), online), false);
  assert.strictEqual(matchesFilters(g.sessions[2], { status: '' }, Date.now(), online), true);
});

check('the "action" status filter belongs to the browser alone: blocked or awaiting a reply', () => {
  const action = buildView({ groups: groups(), filters: { status: 'action' } });
  assert.deepStrictEqual(idsOf(action), ['idle-pr', 'approval'].sort());
  // `action` is never a status a device reports, so the hub-side rule must not read it as one.
  assert.strictEqual(matchesHubFilters(sess({ status: 'active' }), { status: 'action' }, online), true);
});

check('the review option is offered only once a session is ready for review', () => {
  assert.strictEqual(presentStatuses(groups()).has('review'), true);
  const none = [{ device: online, sessions: [sess({ status: 'done', pullRequest: null }), sess({ status: 'active' })] }];
  assert.strictEqual(presentStatuses(none).has('review'), false);
  assert.deepStrictEqual([...presentStatuses(none)].sort(), ['active', 'done']);
});

check('the hub-side filter selects the same sessions as the browser', () => {
  assert.strictEqual(server.matchesStatusFilter(sess(), 'review'), true);
  assert.strictEqual(server.matchesStatusFilter(sess({ status: 'active' }), 'review'), false);
  assert.strictEqual(server.matchesStatusFilter(sess({ status: 'done' }), 'done'), true);
  assert.strictEqual(server.matchesStatusFilter(sess({ status: 'done' }), 'failed'), false);
  assert.strictEqual(server.matchesStatusFilter(sess({ status: 'done' }), ''), true);
  assert.strictEqual(server.matchesStatusFilter(sess({ status: 'done' }), undefined), true);
});

// ---------------------------------------------------------------------------
// q, status and device: the three filters the hub applies hold in the browser
// too. A live push carries every session, so a list that trusted the hub to
// have narrowed it would last only until the next update.
// ---------------------------------------------------------------------------

const laptop = { ...online, deviceId: 'd1', name: 'laptop' };
const desktop = { ...online, deviceId: 'd2', name: 'desktop1' };
const fleet = () => [
  {
    device: laptop,
    sessions: [
      sess({ id: 'alpha-1', key: 'd1:alpha-1', deviceId: 'd1', prompt: 'Fix the Needle bug', cwd: '/work/one', status: 'idle', pullRequest: null }),
      sess({ id: 'beta-2', key: 'd1:beta-2', deviceId: 'd1', prompt: 'tidy', cwd: '/work/NEEDLE-repo', status: 'active', pullRequest: null }),
      sess({ id: 'needle-3', key: 'd1:needle-3', deviceId: 'd1', prompt: 'ship', cwd: '/work/x', status: 'done' }),
      sess({ id: 'gamma-4', key: 'd1:gamma-4', deviceId: 'd1', prompt: 'other', cwd: '/work/x', status: 'idle', pullRequest: null }),
    ],
  },
  {
    device: desktop,
    sessions: [
      sess({ id: 'delta-5', key: 'd2:delta-5', deviceId: 'd2', prompt: 'a needle again', cwd: '/w', status: 'idle', pullRequest: null }),
      sess({ id: 'eps-6', key: 'd2:eps-6', deviceId: 'd2', prompt: 'nothing', cwd: '/w', status: 'done', pullRequest: null }),
      sess({ id: 'zeta-7', key: 'd2:zeta-7', deviceId: 'd2', prompt: 'needle review', cwd: '/w', status: 'failed' }),
    ],
  },
];
const idsFor = (filters, extra = {}) => idsOf(buildView({ groups: fleet(), filters, ...extra }));

check('the keyword filter holds on an unfiltered overview: the prompt, the working directory or the id, in any case', () => {
  const want = ['alpha-1', 'beta-2', 'delta-5', 'needle-3', 'zeta-7'];
  assert.deepStrictEqual(idsFor({ q: 'needle' }), want);
  assert.deepStrictEqual(idsFor({ q: 'NeEdLe' }), want, 'the keyword is case-insensitive');
  assert.deepStrictEqual(idsFor({ q: 'gamma' }), ['gamma-4'], 'a session id is searched');
  assert.deepStrictEqual(idsFor({ q: 'nonsense' }), []);
  assert.strictEqual(idsFor({ q: '' }).length, 7, 'an empty keyword is no filter');
});

check('the keyword filter searches the same three fields as the hub, and no others', () => {
  const g = [{ device: laptop, sessions: [
    sess({ id: 'x1', deviceId: 'd1', prompt: 'plain', cwd: '/plain', git: { repository: 'acme/needle', branch: 'needle' }, squad: { project: 'needle' } }),
    sess({ id: 'x2', deviceId: 'd1', prompt: 'plain', cwd: '/plain', key: 'k-needle' }),
  ] }];
  assert.deepStrictEqual(idsOf(buildView({ groups: g, filters: { q: 'needle' } })), [],
    'only the prompt, the working directory and the id are searched, as the store does');
  assert.deepStrictEqual(idsOf(buildView({ groups: g, filters: { q: 'plain' } })), ['x1', 'x2']);
});

check('a plain status filter holds on an unfiltered overview, exactly', () => {
  assert.deepStrictEqual(idsFor({ status: 'idle' }), ['alpha-1', 'delta-5', 'gamma-4']);
  assert.deepStrictEqual(idsFor({ status: 'done' }), ['eps-6', 'needle-3']);
  assert.deepStrictEqual(idsFor({ status: 'active' }), ['beta-2'], '"starting" is not "active" to the hub, so it is not here');
  assert.deepStrictEqual(idsFor({ status: 'queued' }), []);
  assert.strictEqual(idsFor({ status: '' }).length, 7);
});

check('the Ready for review filter uses the derived status, not an equality check', () => {
  assert.deepStrictEqual(idsFor({ status: 'review' }), ['needle-3', 'zeta-7']);
  const stillWorking = fleet();
  stillWorking[0].sessions.push(sess({ id: 'wip', key: 'd1:wip', deviceId: 'd1', status: 'active' }));
  assert.ok(!idsOf(buildView({ groups: stillWorking, filters: { status: 'review' } })).includes('wip'));
});

check('the device filter holds on an unfiltered overview', () => {
  assert.deepStrictEqual(idsFor({ device: 'd2' }), ['delta-5', 'eps-6', 'zeta-7']);
  assert.deepStrictEqual(idsFor({ device: 'd1' }), ['alpha-1', 'beta-2', 'gamma-4', 'needle-3']);
  assert.deepStrictEqual(idsFor({ device: 'nowhere' }), []);
  // A session that does not carry its own device id belongs to the device of its group.
  const bare = [{ device: desktop, sessions: [sess({ id: 'no-device-id' })] }, { device: laptop, sessions: [sess({ id: 'other' })] }];
  assert.deepStrictEqual(idsOf(buildView({ groups: bare, filters: { device: 'd2' } })), ['no-device-id']);
});

check('keyword, status and device compose: a session must satisfy all three', () => {
  assert.deepStrictEqual(idsFor({ q: 'needle', status: 'idle', device: 'd2' }), ['delta-5']);
  assert.deepStrictEqual(idsFor({ q: 'needle', status: 'idle', device: 'd1' }), ['alpha-1']);
  assert.deepStrictEqual(idsFor({ q: 'needle', status: 'review', device: 'd2' }), ['zeta-7']);
  assert.deepStrictEqual(idsFor({ q: 'needle', status: 'done', device: 'd2' }), []);
});

check('a session blocked on a person is exempt from the time window and from nothing else', () => {
  const NOW = 1_700_000_000_000;
  const blocked = sess({ id: 'blocked', status: 'waiting_approval', deviceId: 'd1', prompt: 'old needle', startedAt: NOW - 90 * 86400000, pendingApprovals: [{ id: 'a' }] });
  const g = [{ device: laptop, sessions: [blocked] }];
  const ids = (filters) => idsOf(buildView({ groups: g, filters, now: NOW }));
  assert.deepStrictEqual(ids({ window: '24h' }), ['blocked'], 'the window never hides a blocked session');
  assert.deepStrictEqual(ids({ window: '24h', q: 'needle' }), ['blocked']);
  assert.deepStrictEqual(ids({ q: 'something else' }), [], 'a keyword the person typed does hide it, as it does at the hub');
  assert.deepStrictEqual(ids({ status: 'done' }), []);
  assert.deepStrictEqual(ids({ device: 'd2' }), []);
  // buildView narrows with the hub filters before it asks matchesFilters, so the rule is also held directly.
  assert.strictEqual(matchesFilters(blocked, { window: '24h' }, NOW, laptop), true);
  assert.strictEqual(matchesFilters(blocked, { q: 'something else' }, NOW, laptop), false);
  assert.strictEqual(matchesFilters(blocked, { status: 'done' }, NOW, laptop), false);
  assert.strictEqual(matchesFilters(blocked, { device: 'd2' }, NOW, laptop), false);
});

check('a pinned session outranks the window and the browser-side filters, but not the keyword, status or device', () => {
  const NOW = 1_700_000_000_000;
  const old = sess({ id: 'old-pin', key: 'old-pin', deviceId: 'd1', prompt: 'needle', status: 'idle', startedAt: NOW - 90 * 86400000, pullRequest: null });
  const g = [{ device: laptop, sessions: [old] }];
  const sections = (filters) => buildView({ groups: g, filters, favorites: ['old-pin'], now: NOW }).sections.map((sec) => sec.label);
  assert.deepStrictEqual(sections({ window: '24h' }), ['Pinned'], 'a star outranks the time window');
  assert.deepStrictEqual(sections({ q: 'needle', status: 'idle', device: 'd1' }), ['Pinned']);
  assert.deepStrictEqual(sections({ q: 'other' }), [], 'a pinned session that does not match the keyword is not sent by the hub');
  assert.deepStrictEqual(sections({ status: 'done' }), []);
  assert.deepStrictEqual(sections({ status: 'review' }), [], 'a pinned session that is not ready for review is not in the review list');
  assert.deepStrictEqual(sections({ device: 'd2' }), []);
  // A session with no device id of its own is pinned under the device of its group.
  const bare = [{ device: desktop, sessions: [sess({ id: 'bare-pin', key: 'bare-pin', pullRequest: null })] }];
  assert.deepStrictEqual(buildView({ groups: bare, filters: { device: 'd2' }, favorites: ['bare-pin'] }).sections.map((sec) => sec.label), ['Pinned']);
  assert.deepStrictEqual(buildView({ groups: bare, filters: { device: 'd1' }, favorites: ['bare-pin'] }).sections.map((sec) => sec.label), []);
});

check('the scope tab counts follow the same three filters, pinned sessions included', () => {
  const g = fleet();
  const counts = (filters, pinned = []) => scopeCounts(g, filters, pinned);
  assert.deepStrictEqual(counts({}), { all: 7, local: 7, cloud: 0 });
  assert.deepStrictEqual(counts({ q: 'needle', status: 'idle', device: 'd2' }), { all: 1, local: 1, cloud: 0 });
  assert.deepStrictEqual(counts({ status: 'review' }), { all: 2, local: 2, cloud: 0 });
  assert.deepStrictEqual(counts({ q: 'needle' }, ['d1:gamma-4', 'd1:alpha-1']).all, 5, 'a pinned session that fails the keyword is not counted');
  const view = buildView({ groups: g, filters: { q: 'needle' }, favorites: ['d1:gamma-4'] });
  assert.strictEqual(view.counts.scopes.all, view.counts.shown);
  const bare = [{ device: desktop, sessions: [sess({ id: 'no-device-id' })] }, { device: laptop, sessions: [sess({ id: 'other' })] }];
  assert.strictEqual(scopeCounts(bare, { device: 'd2' }, []).all, 1, 'a session with no device id of its own counts under its group\'s device');
});

check('narrowGroups keeps every device, narrows its sessions and leaves the overview it was given alone', () => {
  const g = fleet();
  const out = narrowGroups(g, { q: 'needle', status: 'idle', device: 'd2' });
  assert.deepStrictEqual(out.map((x) => [x.device.deviceId, x.sessions.map((s) => s.id)]), [['d1', []], ['d2', ['delta-5']]]);
  assert.strictEqual(g[0].sessions.length, 4, 'the overview itself was narrowed in place');
  assert.deepStrictEqual(narrowGroups(g, {}).map((x) => x.sessions.length), [4, 3]);
  assert.deepStrictEqual(narrowGroups(undefined, {}), []);
});

// What the page draws after a filtered fetch and after the unfiltered push that
// can replace it must be the same list, whichever answer lands last. Driven
// from the real Store, so the hub's own rule is the one being matched.
function fleetStore() {
  const store = new Store();
  store.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
  store.registerDevice('u', { deviceId: 'd2', name: 'desktop1', platform: 'linux' });
  const seed = (device, id, over) => store.upsertSession('u', device, { id, prompt: 'p', cwd: '/w', status: 'done', ...over });
  seed('d1', 'alpha-1', { prompt: 'Fix the Needle bug', status: 'idle' });
  seed('d1', 'beta-2', { cwd: '/work/NEEDLE-repo', status: 'active' });
  seed('d1', 'needle-3', { status: 'done', pullRequest: PR });
  seed('d1', 'gamma-4', { prompt: 'other', status: 'idle' });
  seed('d1', 'pending-5', { prompt: 'needle', status: 'waiting_approval', pendingApprovals: [{ id: 'ap', title: 't' }] });
  seed('d2', 'delta-5', { prompt: 'a needle again', status: 'idle' });
  seed('d2', 'eps-6', { prompt: 'nothing', status: 'done' });
  seed('d2', 'zeta-7', { prompt: 'needle review', status: 'failed', pullRequest: PR });
  return store;
}

check('after a live push the list equals what a filtered fetch would have drawn, for every combination of the three filters', () => {
  const store = fleetStore();
  const pushed = JSON.parse(JSON.stringify(store.overview('u')));
  let compared = 0;
  for (const q of ['', 'needle', 'NEEDLE', 'work', 'gamma', 'zzz']) {
    for (const status of ['', 'idle', 'active', 'done', 'failed', 'review', 'queued', 'action', 'waiting_approval']) {
      for (const device of ['', 'd1', 'd2', 'nope']) {
        const filters = { q, status, device };
        const fetched = JSON.parse(JSON.stringify(store.overview('u', {
          keyword: q || undefined, status: status && status !== 'action' ? status : undefined, deviceId: device || undefined,
        })));
        const label = JSON.stringify(filters);
        assert.deepStrictEqual(idsOf(buildView({ groups: pushed.groups, filters })), idsOf(buildView({ groups: fetched.groups, filters })), label);
        assert.deepStrictEqual(
          narrowGroups(pushed.groups, filters).map((g) => [g.device.deviceId, g.sessions.map((s) => s.id).sort()]),
          fetched.groups.map((g) => [g.device.deviceId, g.sessions.map((s) => s.id).sort()]),
          `${label}: the groups the browser keeps are not the ones the hub keeps`,
        );
        compared += 1;
      }
    }
  }
  assert.strictEqual(compared, 6 * 9 * 4);
});

check('the review filter survives the order the answers arrive in: the unfiltered push after a filtered fetch', () => {
  const store = fleetStore();
  const filters = { q: 'needle', status: 'review', device: '' };
  const fetched = JSON.parse(JSON.stringify(store.overview('u', { keyword: 'needle', status: 'review' })));
  const pushed = JSON.parse(JSON.stringify(store.overview('u')));
  const want = ['d1:needle-3', 'd2:zeta-7'];
  const keys = (view) => view.sections.flatMap((sec) => sec.entries.map((e) => e.session.key)).sort();
  assert.deepStrictEqual(keys(buildView({ groups: fetched.groups, filters })), want);
  assert.deepStrictEqual(keys(buildView({ groups: pushed.groups, filters })), want);
});

function storeWithSessions() {
  const store = new Store();
  store.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
  for (const [id, over] of [
    ['ready', { status: 'done', pullRequest: PR }],
    ['failed-pr', { status: 'failed', pullRequest: PR }],
    ['done-plain', { status: 'done' }],
    ['active-pr', { status: 'active', pullRequest: PR }],
    ['approval', { status: 'done', pullRequest: PR, pendingApprovals: [{ id: 'a1', title: 't' }] }],
  ]) store.upsertSession('u', 'd1', { id, ...over });
  return store;
}

check('the store filters sessions by the derived review status', () => {
  const store = storeWithSessions();
  const ids = (filter) => store.listSessions('u', filter).map((s) => s.id).sort();
  assert.deepStrictEqual(ids({ status: 'review' }), ['failed-pr', 'ready']);
  assert.deepStrictEqual(ids({ status: 'done' }), ['approval', 'done-plain', 'ready']);
  assert.deepStrictEqual(ids({ status: 'active' }), ['active-pr']);
  assert.strictEqual(ids({}).length, 5);
});

check('the overview the web app reads honors the review filter', () => {
  const store = storeWithSessions();
  const overview = store.overview('u', { status: 'review' });
  const ids = overview.groups.flatMap((g) => g.sessions.map((s) => s.id)).sort();
  assert.deepStrictEqual(ids, ['failed-pr', 'ready']);
});

async function withStubHub(sessions, fn) {
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ sessions }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

(async () => {
  await checkAsync('list_sessions (the MCP tool and `sessions --status`) filters by the derived review status', async () => {
    const all = [
      { deviceId: 'd1', id: 'ready', status: 'done', pullRequest: PR, pendingApprovals: [] },
      { deviceId: 'd1', id: 'active-pr', status: 'active', pullRequest: PR, pendingApprovals: [] },
      { deviceId: 'd1', id: 'done-plain', status: 'done', pendingApprovals: [] },
    ];
    await withStubHub(all, async (hub) => {
      const client = createHubClient({ hub, token: 'a-user-token' });
      assert.deepStrictEqual((await client.listSessions({ status: 'review' })).sessions.map((s) => s.id), ['ready']);
      assert.deepStrictEqual((await client.listSessions({ status: 'done' })).sessions.map((s) => s.id), ['ready', 'done-plain']);
      assert.strictEqual((await client.listSessions()).sessions.length, 3);
    });
  });

  // -------------------------------------------------------------------------
  // The keyword, status and device through a held GET and a live push
  // (#179 with #237)
  //
  // #237's `refresh()` drops a GET reply that an unfiltered live push has
  // overtaken, which keeps the pushed session -- and leaves `state.overview`
  // holding the UNFILTERED push even though the page asked for a filtered list.
  // #179's `buildView` is what narrows it back down. These drive the actual
  // `connect`/`refresh` of web/js/ws.js, the real `Store.overview` for what the
  // hub answers and pushes, and the real `buildView` for what is drawn, in the
  // order that went wrong: a filtered GET is held, the unfiltered push lands,
  // then the old GET completes.
  //
  // Not covered here, on purpose: `counts`, the rail and the inbox badge are
  // still the hub's totals after a push, as they always were.
  // -------------------------------------------------------------------------

  const fs = require('fs');
  const path = require('path');
  const { stripModuleSyntax } = require('./helpers/web-source');
  const WS_SOURCE = stripModuleSyntax(fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'ws.js'), 'utf8'));
  const HELD_FILTERS = { q: 'needle', status: 'idle', device: 'Desktop' };
  const HELD_PATH = '/api/overview?q=needle&status=idle&device=Desktop';
  const HELD_EXEC = 'aca-squad-hub-job-x7k2q9p';
  // One of each way to miss: the right keyword on the wrong device, the right
  // device and keyword with the wrong status, the right device and status with
  // another keyword. All three are pinned, so a pin that outranks a filter shows.
  const HELD_PINS = ['Laptop:wrong-device', 'Desktop:wrong-status', 'Desktop:wrong-keyword', 'Desktop:match-cwd'];
  const BEFORE = ['match-cwd', 'match-prompt'];
  const AFTER = ['late-match', 'match-cwd', 'match-prompt'];
  const EVERY_SESSION = [
    'aca-job', 'late-match', 'match-cwd', 'match-prompt', 'wrong-device', 'wrong-keyword', 'wrong-status',
  ];
  const deferred = () => {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  };
  const sessionIdsIn = (overview) => overview.groups.flatMap((g) => g.sessions.map((s) => s.id)).sort();

  function heldFilterFixture() {
    const store = new Store();
    store.registerDevice('u', { deviceId: 'Desktop', name: 'Desktop', platform: 'linux' });
    store.registerDevice('u', { deviceId: 'Laptop', name: 'Laptop', platform: 'linux' });
    const seed = (device, id, over) => store.upsertSession('u', device, {
      id, prompt: 'p', cwd: '/w', status: 'idle', ...over,
    });
    seed('Desktop', 'match-prompt', { prompt: 'Fix the Needle bug' });
    seed('Desktop', 'match-cwd', { cwd: '/work/needle-repo' });
    seed('Desktop', 'wrong-status', { prompt: 'needle', status: 'active' });
    seed('Desktop', 'wrong-keyword', { prompt: 'something else' });
    seed('Laptop', 'wrong-device', { prompt: 'needle' });

    const requests = [];
    // The hub, as `HubService` answers GET /api/overview (asserted below).
    const api = (reqPath) => {
      const sp = new URL(reqPath, 'http://hub.test').searchParams;
      const reply = JSON.parse(JSON.stringify(store.overview('u', {
        keyword: sp.get('q') || undefined, status: sp.get('status') || undefined, deviceId: sp.get('device') || undefined,
      })));
      const held = deferred();
      requests.push({ path: reqPath, reply, resolve: held.resolve });
      return held.promise;
    };
    const clientState = {
      token: 'test',
      filters: { ...HELD_FILTERS },
      favorites: new Set(HELD_PINS),
      groupBy: 'device',
      sortBy: 'started_desc',
      scope: 'all',
      overview: { devices: [], groups: [], counts: {} },
    };
    const draw = () => idsOf(buildView({
      groups: clientState.overview.groups,
      filters: clientState.filters,
      favorites: [...clientState.favorites],
      groupBy: clientState.groupBy,
      sortBy: clientState.sortBy,
      scope: clientState.scope,
    }));
    const frames = [];
    class FakeWebSocket { close() {} }
    const client = new Function('state', 'api', '$', 'location', 'WebSocket', 'render', 'acaAttachFromOverview', 'syncAcaPending',
      `${WS_SOURCE}\nreturn { connect, refresh };`)(
      clientState, api, () => ({ dataset: {}, setAttribute() {} }), { protocol: 'http:', host: 'localhost' },
      FakeWebSocket, () => { frames.push(draw()); }, () => {}, async () => {},
    );
    client.connect();
    return {
      store, requests, frames, draw, state: clientState, refresh: () => client.refresh(),
      // The job's own device attaches, and a new matching session appears.
      attachLater() {
        seed('Desktop', 'late-match', { prompt: 'needle: started after the GET left' });
        store.registerDevice('u', { deviceId: HELD_EXEC, name: 'ACA job', platform: 'linux', kind: 'aca' });
        seed(HELD_EXEC, 'aca-job', { prompt: 'needle job' });
      },
      push() {
        const message = { type: 'overview', ...store.overview('u') };
        clientState.ws.onmessage({ data: JSON.stringify(message) });
        const { devices, groups, counts, hubVersion } = JSON.parse(JSON.stringify(message));
        return { devices, groups, counts, hubVersion };
      },
    };
  }

  await checkAsync('a held filtered GET asks the hub for exactly the keyword, status and device the page holds (#179 with #237)', async () => {
    const f = heldFilterFixture();
    const refresh = f.refresh();
    assert.deepStrictEqual(f.requests.map((r) => r.path), [HELD_PATH]);
    // The stand-in hub above maps the three parameters the way the real one does.
    const hubSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'service', 'hub-service.js'), 'utf8');
    assert.match(hubSource, /keyword: url\.searchParams\.get\('q'\) \|\| undefined,\s*status: url\.searchParams\.get\('status'\) \|\| undefined,\s*deviceId: url\.searchParams\.get\('device'\) \|\| undefined/);
    assert.deepStrictEqual(sessionIdsIn(f.requests[0].reply), BEFORE, 'the filtered reply holds only the matching sessions');
    assert.ok(sessionIdsIn(f.store.overview('u')).length > BEFORE.length, 'the hub holds sessions the filter leaves out');
    f.requests[0].resolve(f.requests[0].reply);
    await refresh;
  });

  await checkAsync('an unfiltered live push over that held GET draws only the sessions matching keyword, status and device, pinned ones included, and keeps the push whole (#179 with #237)', async () => {
    const f = heldFilterFixture();
    const refresh = f.refresh();
    f.attachLater();
    const pushed = f.push();
    assert.deepStrictEqual(sessionIdsIn(pushed), EVERY_SESSION, 'the push is unfiltered');
    assert.deepStrictEqual(f.state.overview, pushed, 'the push is the snapshot the page keeps, whole');
    assert.deepStrictEqual(f.frames, [AFTER], 'the push drew a non-matching or a pinned non-matching session');
    assert.deepStrictEqual(f.draw(), AFTER);
    f.requests[0].resolve(f.requests[0].reply);
    await refresh;
  });

  await checkAsync('completing the older filtered GET after the unfiltered push keeps the matching list and the pushed snapshot with the newly attached session (#179 with #237)', async () => {
    const f = heldFilterFixture();
    const refresh = f.refresh();
    f.attachLater();
    const pushed = f.push();
    assert.deepStrictEqual(sessionIdsIn(f.requests[0].reply), BEFORE, 'the held reply predates the attach');
    f.requests[0].resolve(f.requests[0].reply);
    await refresh;
    assert.deepStrictEqual(f.state.overview, pushed, 'the older GET replaced the pushed snapshot');
    assert.ok(f.state.overview.devices.some((d) => d.deviceId === HELD_EXEC), 'the attached device left the snapshot');
    assert.ok(sessionIdsIn(f.state.overview).includes('aca-job'), 'the attached session left the snapshot');
    assert.strictEqual(f.frames.length, 2, 'one frame for the push and one for the completed GET');
    for (const frame of f.frames) assert.deepStrictEqual(frame, AFTER);
  });

  await checkAsync('a filtered GET that lands first and the unfiltered push after it leave the same matching list, with the newly attached session (#179 with #237)', async () => {
    const f = heldFilterFixture();
    const refresh = f.refresh();
    f.requests[0].resolve(f.requests[0].reply);
    await refresh;
    assert.deepStrictEqual(sessionIdsIn(f.state.overview), BEFORE);
    f.attachLater();
    const pushed = f.push();
    assert.deepStrictEqual(f.state.overview, pushed, 'the push after the GET is the snapshot the page keeps');
    assert.deepStrictEqual(f.frames, [BEFORE, AFTER]);
  });

  check('devices.js draws the list through buildView with the overview and filters the page holds, which is what the held-GET checks stand in for (#179 with #237)', () => {
    const devicesSource = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'devices.js'), 'utf8');
    assert.match(devicesSource, /const \{ groups, devices, counts, hubVersion \} = state\.overview;/);
    assert.match(devicesSource, /const view = buildView\(\{\s*groups,\s*filters: state\.filters,\s*favorites: \[\.\.\.state\.favorites\],\s*groupBy: state\.groupBy,\s*sortBy: state\.sortBy,\s*scope: state\.scope,\s*\}\);/);
  });

  // -------------------------------------------------------------------------
  // Squad health
  // -------------------------------------------------------------------------

  const text = (html) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const checks = (...pairs) => pairs.map(([id, status]) => ({ id, status }));
  const ALL_PASS = checks(['team', 'pass'], ['registry-charters', 'pass'], ['routing', 'pass'], ['state-backend', 'pass'], ['env-vars', 'pass']);

  check('a passing health report is a "● healthy" badge with a no-failures tooltip', () => {
    const html = healthBadgeHtml({ status: 'pass', checks: ALL_PASS });
    assert.strictEqual(text(html), '● healthy');
    assert.match(html, /class="health healthy"/);
    assert.match(html, /title="Squad health: healthy — no failing checks"/);
  });

  check('a failing report counts the failing checks and names them in the tooltip', () => {
    const html = healthBadgeHtml({ status: 'fail', checks: checks(['team', 'pass'], ['routing', 'fail'], ['env-vars', 'fail']) });
    assert.strictEqual(text(html), '● health: 2 failing');
    assert.match(html, /class="health failing"/);
    assert.match(html, /title="Squad health: failing checks — routing, env-vars"/);
    assert.strictEqual(text(healthBadgeHtml({ status: 'fail', checks: checks(['routing', 'fail']) })), '● health: 1 failing');
  });

  check('a skipped check is not a failure', () => {
    const html = healthBadgeHtml({ status: 'pass', checks: checks(['team', 'pass'], ['env-vars', 'skip']) });
    assert.strictEqual(text(html), '● healthy');
  });

  check('a failing check outranks a verdict that says pass; a bare fail never invents a count', () => {
    assert.strictEqual(text(healthBadgeHtml({ status: 'pass', checks: checks(['routing', 'fail']) })), '● health: 1 failing');
    const bare = healthBadgeHtml({ status: 'fail', checks: [] });
    assert.strictEqual(text(bare), '● health: failing');
    assert.match(bare, /did not name a check/);
    assert.strictEqual(text(healthBadgeHtml({ status: 'fail' })), '● health: failing');
  });

  check('the same check reported twice counts once, and the worse report wins', () => {
    const view = squadHealthView({ status: 'fail', checks: checks(['routing', 'pass'], ['routing', 'fail'], ['routing', 'fail']) });
    assert.deepStrictEqual(view.failing, ['routing']);
    assert.deepStrictEqual(view.checks, [{ id: 'routing', status: 'fail' }]);
    assert.strictEqual(text(healthBadgeHtml({ status: 'fail', checks: checks(['routing', 'fail'], ['routing', 'pass']) })), '● health: 1 failing');
  });

  check('unknown, unavailable and garbage health draw nothing at all', () => {
    for (const health of [undefined, null, {}, { status: 'unknown' }, { status: 'unavailable' }, { status: 'maybe' },
      { status: 'PASS' }, 'pass', 5, true, [], [{ status: 'pass' }], { status: { toString: () => 'pass' } }]) {
      assert.strictEqual(healthBadgeHtml(health), '', JSON.stringify(health));
      assert.strictEqual(healthChecksHtml(health), '', JSON.stringify(health));
      assert.strictEqual(squadHealthView(health), null, JSON.stringify(health));
    }
  });

  check('malformed check entries are ignored rather than guessed at', () => {
    const noise = [null, undefined, 7, 'routing', [], {}, { id: 5, status: 'fail' }, { id: '', status: 'fail' },
      { id: 'x'.repeat(65), status: 'fail' }, { id: '<img src=x onerror=alert(1)>', status: 'fail' },
      { id: 'has space', status: 'fail' }, { id: 'routing', status: 'maybe' }, { id: 'routing', status: { x: 1 } },
      { id: 'routing', status: 'constructor' }, { id: 'routing' }];
    const view = squadHealthView({ status: 'pass', checks: [...noise, ...checks(['team', 'pass'])] });
    assert.deepStrictEqual(view.checks, [{ id: 'team', status: 'pass' }]);
    assert.strictEqual(view.healthy, true);
    assert.strictEqual(squadHealthView({ status: 'pass', checks: 'not-a-list' }).healthy, true);
    assert.strictEqual(squadHealthView({ status: 'pass', checks: { length: 3 } }).healthy, true);
  });

  check('only a bounded number of checks is ever read', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `check-${i}`, status: 'fail' }));
    assert.ok(squadHealthView({ status: 'fail', checks: many }).checks.length <= 50);
  });

  check('a check id that is not a plain id never reaches the markup, in the tooltip or the list', () => {
    for (const id of ['a&b', '<b>x</b>', 'x" onmouseover="alert(1)', "x'y"]) {
      const health = { status: 'fail', checks: checks([id, 'fail']) };
      const html = `${healthBadgeHtml(health)}${healthChecksHtml(health)}`;
      assert.ok(!html.includes(id) && !html.includes('onmouseover=') && !html.includes('<b>x'), html);
      assert.match(text(html), /health: failing/, 'the verdict still says failing, without inventing a count');
    }
    const ok = healthChecksHtml({ status: 'fail', checks: checks(['state-backend.v2:x_1', 'fail']) });
    assert.match(ok, /<b>state-backend\.v2:x_1<\/b>/);
  });

  check('the detail panel lists every check with its status, a skipped one included', () => {
    const html = healthChecksHtml({ status: 'fail', checks: checks(['team', 'pass'], ['routing', 'fail'], ['env-vars', 'skip']) });
    assert.match(html, /<li class="pass"><b>team<\/b> <span><span aria-hidden="true">✓<\/span> pass<\/span><\/li>/);
    assert.match(html, /<li class="fail"><b>routing<\/b> <span><span aria-hidden="true">✕<\/span> fail<\/span><\/li>/);
    assert.match(html, /<li class="skip"><b>env-vars<\/b> <span><span aria-hidden="true">–<\/span> skip<\/span><\/li>/);
    assert.match(text(html), /Squad health ● health: 1 failing/);
  });

  check('a verdict with no checks still gets a badge in the panel, and no empty list', () => {
    const html = healthChecksHtml({ status: 'pass', checks: [] });
    assert.match(text(html), /Squad health ● healthy/);
    assert.ok(!html.includes('<ul'));
  });

  check('a Squad session row carries the health badge, and a row with no Squad carries none', () => {
    const base = { isSquad: true, project: 'squad-hub', memberCount: 6, activeMembers: 2 };
    const failing = rowHtml(sess({ squad: { ...base, health: { status: 'fail', checks: checks(['routing', 'fail']) } } }));
    assert.match(failing, /<div class="squadline">[\s\S]*<span class="health failing"[^>]*>[\s\S]*health: 1 failing[\s\S]*<\/div>/);
    const healthy = rowHtml(sess({ squad: { ...base, health: { status: 'pass', checks: ALL_PASS } } }));
    assert.match(healthy, /<span class="health healthy"/);
    assert.ok(!rowHtml(sess({ squad: { ...base, health: { status: 'unknown' } } })).includes('class="health'));
    assert.ok(!rowHtml(sess({ squad: base })).includes('class="health'));
    assert.ok(!rowHtml(sess({ squad: null })).includes('class="health'));
  });

  check('the health badge is a plain indicator: it is not a button, link or pill', () => {
    const html = healthBadgeHtml({ status: 'fail', checks: checks(['routing', 'fail']) });
    assert.ok(!/<(button|a)\b/.test(html), html);
    assert.ok(!html.includes('class="status'), html);
  });

  // -------------------------------------------------------------------------
  // The detail page: the link and the health block follow the session
  // -------------------------------------------------------------------------

  function fakeDocument(ids) {
    const els = {};
    let writes = 0;
    for (const id of ids) {
      let html = '';
      els[id] = {
        dataset: {}, hidden: true,
        get innerHTML() { return html; },
        set innerHTML(v) { html = v; writes += 1; },
      };
    }
    global.document = { getElementById: (id) => els[id] || null };
    return { els, writes: () => writes };
  }

  check('the detail page shows the Open PR link and the health block, and hides both when there is nothing to say', () => {
    const doc = fakeDocument(['dtLinks', 'dtSquadHealth']);
    try {
      syncReviewDetail(sess({ squad: { health: { status: 'fail', checks: checks(['routing', 'fail']) } } }));
      assert.strictEqual(doc.els.dtLinks.hidden, false);
      assert.match(doc.els.dtLinks.innerHTML, /href="https:\/\/github\.com\/swigerb\/squad-hub\/pull\/179"/);
      assert.strictEqual(doc.els.dtSquadHealth.hidden, false);
      assert.match(doc.els.dtSquadHealth.innerHTML, /<li class="fail"><b>routing<\/b>/);

      syncReviewDetail(sess({ status: 'active', squad: { health: { status: 'unknown' } } }));
      assert.strictEqual(doc.els.dtLinks.hidden, true);
      assert.strictEqual(doc.els.dtLinks.innerHTML, '');
      assert.strictEqual(doc.els.dtSquadHealth.hidden, true);
      assert.strictEqual(doc.els.dtSquadHealth.innerHTML, '');
    } finally { delete global.document; }
  });

  check('an unchanged detail page is not rewritten on every refresh, so focus on the link survives', () => {
    const doc = fakeDocument(['dtLinks', 'dtSquadHealth']);
    try {
      const s = sess({ squad: { health: { status: 'pass', checks: ALL_PASS } } });
      syncReviewDetail(s);
      const first = doc.writes();
      syncReviewDetail({ ...s });
      syncReviewDetail({ ...s });
      assert.strictEqual(doc.writes(), first);
      syncReviewDetail({ ...s, pullRequest: { ...PR, number: 180, url: 'https://github.com/swigerb/squad-hub/pull/180' } });
      assert.strictEqual(doc.writes(), first + 1);
    } finally { delete global.document; }
  });

  check('a detail page without the new elements does not throw', () => {
    fakeDocument([]);
    try { syncReviewDetail(sess()); } finally { delete global.document; }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
