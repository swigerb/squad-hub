'use strict';
/**
 * The device rail's pending ACA rows: a dispatch this tab made whose job has
 * not attached yet is drawn inside "Squad on ACA executions" with a pulsing
 * "Starting" dot, until the job's own device arrives or the outcome is known.
 *
 * What is proven here, and why it is not helper-only:
 *
 * - the pure view (`acaRailView`) maps every state `acaStepsForStatus` can
 *   report, and only a still-open outcome pulses;
 * - the REAL tracking flow (`trackAcaDispatch`, `syncAcaPending`,
 *   `acaAttachFromOverview`, `retryAcaPending`) feeds the REAL `render()`,
 *   whose `#deviceList` markup is what the assertions read -- so identity,
 *   counts and the pending-to-attached hand-over are checked on what a person
 *   would see, not on a function that is only called from here.
 *
 * `render()` runs against a permissive stand-in for the page, so a browser
 * test (test/browser-e2e-unit.js) proves the same hand-over, and the pulse's
 * computed style, in real Chromium.
 */

const assert = require('assert');
const { readWebSource } = require('./helpers/web-source');

let pass = 0; let fail = 0;
function report(name, error) {
  if (!error) {
    pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${error.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(error.message).split('\n')[0]}`);
  }
}
function check(name, fn) {
  try { fn(); report(name); } catch (e) { report(name, e); }
}
async function checkAsync(name, fn) {
  try { await fn(); report(name); } catch (e) { report(name, e); }
}

// A page stand-in permissive enough for the whole of `render()`: every element
// remembers what is written to it, answers "nothing" to a lookup, and ignores
// any call it has no reason to answer.
function makeDom() {
  const elements = new Map();
  const none = { querySelector: () => null, querySelectorAll: () => [], closest: () => null, getAttribute: () => null };
  const element = (id) => {
    if (elements.has(id)) return elements.get(id);
    const store = {
      id, innerHTML: '', textContent: '', hidden: false, value: '', title: '', className: '', dataset: {}, style: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      ...none,
    };
    const proxy = new Proxy(store, {
      get: (target, prop) => (prop in target ? target[prop] : () => undefined),
      set: (target, prop, value) => { target[prop] = value; return true; },
    });
    elements.set(id, proxy);
    return proxy;
  };
  const document = {
    title: '',
    getElementById: element,
    ...none,
    createElement: () => element(`created-${elements.size}`),
    addEventListener() {},
    body: element('body'),
    documentElement: element('html'),
  };
  return { document, element };
}

const dom = makeDom();
const requests = [];
let dispatchRows = [];
// Stands in for the network: only the read the pending sync issues is answered.
const fakeFetch = async (url) => {
  requests.push(url);
  if (url === '/api/aca/dispatches') {
    return { ok: true, status: 200, json: async () => ({ dispatches: dispatchRows }) };
  }
  return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
};

const browser = { exports: {} };
new Function('module', 'document', 'fetch', 'navigator', `${readWebSource()}\nmodule.exports = {
  acaRailView, acaRailEntries, acaRailRowHtml, acaRailRowsHtml, acaJobsRowHtml,
  acaPendingTitle, acaEntryView, acaDeviceIdFor, ACA_MAX_PENDING_MS,
  trackAcaDispatch, syncAcaPending, retryAcaPending, acaAttachFromOverview,
  deviceSectionHtml, render, state,
};`)(browser, dom.document, fakeFetch, {});
const {
  acaRailView, acaRailEntries, acaRailRowHtml, acaRailRowsHtml, acaJobsRowHtml,
  acaPendingTitle, acaEntryView, acaDeviceIdFor, ACA_MAX_PENDING_MS,
  trackAcaDispatch, syncAcaPending, retryAcaPending, acaAttachFromOverview,
  deviceSectionHtml, render, state,
} = browser.exports;

const EXEC = 'squad-hub-job-x7k2q9p';
const EXEC_2 = 'squad-hub-job-m3n4b5v';

const entry = (over = {}) => ({
  localId: 'aca-local-1', repo: 'acme/widgets', issue: 42, runUrl: null, dispatchedAt: Date.now(),
  owner: 'acme', name: 'widgets', trackerId: 'trk-1', status: null, attached: false,
  runId: null, runAttempt: null, executionName: null, deviceId: null,
  completedAt: null, confirmedAt: null, resolved: false, ...over,
});
const device = (deviceId, over = {}) => ({
  deviceId, name: deviceId, kind: 'aca', presence: 'online', platform: 'linux', fileAccess: 'none', ...over,
});
const pulses = (html) => (html.match(/class="dot dispatching"/g) || []).length;
const railRows = (html) => (html.match(/class="device aca-rail"/g) || []).length;

// ---------------------------------------------------------------------------
// The pure view
// ---------------------------------------------------------------------------

check('rail view: a dispatch with no run seen yet pulses as Queued and does not claim a lease', () => {
  const v = acaRailView(entry());
  assert.strictEqual(v.active, true);
  assert.strictEqual(v.dot, 'dispatching');
  assert.strictEqual(v.label, 'Queued');
  assert.ok(!/starting|lease claimed/i.test(`${v.label} ${v.detail}`), `claimed too much: ${v.label} / ${v.detail}`);
});

check('rail view: a run that is only queued on Actions never says Starting or lease claimed', () => {
  const v = acaRailView(entry({ status: { state: 'queued', runId: 7, runAttempt: 1 }, runId: 7, runAttempt: 1 }));
  assert.strictEqual(v.active, true);
  assert.strictEqual(v.label, 'Queued');
  assert.ok(!/starting|lease claimed/i.test(`${v.label} ${v.detail}`), `claimed too much: ${v.label} / ${v.detail}`);
});

check('rail view: a run in progress with no receipt says Starting, from the run, not from a lease', () => {
  const v = acaRailView(entry({ status: { state: 'in_progress', runId: 7, runAttempt: 1 }, runId: 7, runAttempt: 1 }));
  assert.strictEqual(v.active, true);
  assert.strictEqual(v.dot, 'dispatching');
  assert.strictEqual(v.label, 'Starting');
  assert.match(v.detail, /run is in progress/);
  assert.ok(!/lease claimed/i.test(v.detail), 'a bare run is not proof of a lease');
});

check('rail view: a receipt-confirmed execution says Starting with the lease claimed', () => {
  const v = acaRailView(entry({
    status: { state: 'in_progress', runId: 7, runAttempt: 1 }, runId: 7, runAttempt: 1, executionName: EXEC,
  }));
  assert.strictEqual(v.active, true);
  assert.strictEqual(v.label, 'Starting');
  assert.match(v.detail, /lease claimed/);
});

check('rail view: a finished run with no receipt keeps waiting, honestly, and does not say Starting', () => {
  const v = acaRailView(entry({
    status: { state: 'completed', conclusion: 'success', runId: 7, runAttempt: 1 }, runId: 7, runAttempt: 1, completedAt: Date.now(),
  }));
  assert.strictEqual(v.active, true);
  assert.strictEqual(v.label, 'Waiting');
  assert.ok(!/starting|lease claimed/i.test(`${v.label} ${v.detail}`));
});

check('rail view: a failed dispatch stops pulsing, uses the failed dot and says why', () => {
  const failed = acaRailView(entry({ status: { state: 'error', reason: 'the workflow was not found' } }));
  assert.strictEqual(failed.active, false);
  assert.strictEqual(failed.dot, 'failed');
  assert.strictEqual(failed.label, 'Dispatch failed');
  assert.match(failed.detail, /workflow was not found/);
  const finished = acaRailView(entry({ status: { state: 'completed', conclusion: 'failure', runId: 7, runAttempt: 1 }, runId: 7, runAttempt: 1 }));
  assert.strictEqual(finished.active, false);
  assert.strictEqual(finished.dot, 'failed');
  assert.match(finished.detail, /finished \(failure\)/);
});

check('rail view: an unknown outcome stops pulsing and is not painted as a failure', () => {
  const unsupported = acaRailView(entry({ status: { state: 'unsupported', reason: 'no receipt in this repo' } }));
  assert.strictEqual(unsupported.active, false);
  assert.strictEqual(unsupported.dot, 'stale');
  assert.strictEqual(unsupported.label, 'Unknown outcome');
  assert.match(unsupported.detail, /no receipt in this repo/);
  const expired = acaRailView(entry({ dispatchedAt: Date.now() - ACA_MAX_PENDING_MS - 1000 }));
  assert.strictEqual(expired.active, false);
  assert.strictEqual(expired.dot, 'stale');
  assert.strictEqual(expired.label, 'Unknown outcome');
});

check('rail view: it pulses exactly when the shared entry view says the outcome is still open', () => {
  const states = [
    entry(),
    entry({ status: { state: 'queued', runId: 1, runAttempt: 1 }, runId: 1, runAttempt: 1 }),
    entry({ status: { state: 'in_progress', runId: 1, runAttempt: 1 }, runId: 1, runAttempt: 1 }),
    entry({ status: { state: 'in_progress', runId: 1, runAttempt: 1 }, runId: 1, runAttempt: 1, executionName: EXEC }),
    entry({ status: { state: 'completed', conclusion: 'success', runId: 1, runAttempt: 1 }, runId: 1, runAttempt: 1 }),
    entry({ status: { state: 'completed', conclusion: 'failure', runId: 1, runAttempt: 1 }, runId: 1, runAttempt: 1 }),
    entry({ status: { state: 'error', reason: 'boom' } }),
    entry({ status: { state: 'unsupported' } }),
    entry({ dispatchedAt: Date.now() - ACA_MAX_PENDING_MS - 1000 }),
  ];
  for (const e of states) {
    const resolved = acaEntryView(e).resolved;
    const html = acaRailRowHtml(e);
    assert.strictEqual(acaRailView(e).active, !resolved);
    assert.strictEqual(pulses(html), resolved ? 0 : 1, `${JSON.stringify(e.status)}: ${resolved ? 'resolved rows must not pulse' : 'an open row must pulse'}`);
  }
});

// ---------------------------------------------------------------------------
// Rows: one per tracked dispatch, the title, escaping, actionability
// ---------------------------------------------------------------------------

check('rail rows: the title is the issue, a dot and the repository', () => {
  assert.strictEqual(acaPendingTitle(entry()), '#42 \u00b7 acme/widgets');
  assert.strictEqual(acaPendingTitle(entry({ issue: null })), 'acme/widgets');
  const html = acaRailRowHtml(entry());
  assert.match(html, /<span>#42 \u00b7 acme\/widgets<\/span>/);
  assert.match(html, /class="device-name" title="#42 \u00b7 acme\/widgets"/);
});

check('rail rows: two dispatches to one repository are two rows, each its own localId', () => {
  const a = entry({ localId: 'aca-local-a', trackerId: 'trk-a', issue: 42 });
  const b = entry({ localId: 'aca-local-b', trackerId: 'trk-b', issue: 43 });
  const html = acaRailRowsHtml([a, b], []);
  assert.strictEqual(railRows(html), 2);
  assert.match(html, /data-local-id="aca-local-a"/);
  assert.match(html, /data-local-id="aca-local-b"/);
  assert.match(html, /#42 \u00b7 acme\/widgets/);
  assert.match(html, /#43 \u00b7 acme\/widgets/);
  // The same issue dispatched twice is still two jobs.
  const twin = acaRailRowsHtml([a, { ...a, localId: 'aca-local-c', trackerId: 'trk-c' }], []);
  assert.strictEqual(railRows(twin), 2);
});

check('rail rows: markup built from a repository name is escaped', () => {
  const html = acaRailRowHtml(entry({ repo: 'acme/<img src=x onerror=alert(1)>', localId: 'a"b' }));
  assert.ok(!html.includes('<img'), html);
  assert.ok(!html.includes('data-local-id="a"b"'), html);
  assert.match(html, /&lt;img/);
});

check('rail rows: an open row has no retry, a resolved one has Check again and the reason', () => {
  const open = acaRailRowHtml(entry());
  assert.ok(!/data-aca-retry|Check again/.test(open));
  const failed = acaRailRowHtml(entry({ status: { state: 'error', reason: 'the workflow was not found' } }));
  assert.match(failed, /<button type="button" class="ghost aca-retry" data-aca-retry="aca-local-1">Check again<\/button>/);
  assert.match(failed, /class="device-meta aca-fail">the workflow was not found</);
  assert.ok(!/class="dot dispatching"/.test(failed));
});

check('rail rows: a pending row is not a session row or a device card', () => {
  const html = acaRailRowHtml(entry());
  assert.ok(!/class="row[ "]|aca-pending|data-spawn|data-remove-device|data-session/.test(html), html);
});

// ---------------------------------------------------------------------------
// Which tracked dispatches the rail still draws
// ---------------------------------------------------------------------------

check('rail entries: an attached dispatch is not drawn', () => {
  assert.strictEqual(acaRailEntries([entry({ attached: true })], []).length, 0);
});

check('rail entries: the exact aca- device for the confirmed execution replaces the row', () => {
  const e = entry({ executionName: EXEC });
  assert.strictEqual(acaRailEntries([e], []).length, 1);
  assert.strictEqual(acaRailEntries([e], [device(`aca-${EXEC}`)]).length, 0);
});

check('rail entries: an older job on the same repository never replaces a newer dispatch', () => {
  const e = entry({ executionName: EXEC });
  const older = device(`aca-${EXEC_2}`, { meta: { repo: 'acme/widgets' } });
  assert.strictEqual(acaRailEntries([e], [older]).length, 1);
  assert.strictEqual(acaRailEntries([entry()], [older]).length, 1, 'no receipt, no hand-over');
});

check('rail entries: a device that contradicts the dispatch does not take its place', () => {
  const e = entry({ executionName: EXEC });
  assert.strictEqual(acaRailEntries([e], [device(`aca-${EXEC}`, { meta: { repo: 'acme/other' } })]).length, 1);
});

check('rail entries: two dispatches naming one execution never both claim its device', () => {
  const a = entry({ localId: 'a', executionName: EXEC });
  const b = entry({ localId: 'b', trackerId: 'trk-2', executionName: EXEC });
  assert.strictEqual(acaRailEntries([a, b], [device(`aca-${EXEC}`)]).length, 2);
});

check('rail entries: a hand-over to one dispatch leaves the other drawn', () => {
  const a = entry({ localId: 'a', executionName: EXEC });
  const b = entry({ localId: 'b', trackerId: 'trk-2', issue: 43 });
  const kept = acaRailEntries([a, b], [device(`aca-${EXEC}`)]);
  assert.deepStrictEqual(kept.map((e) => e.localId), ['b']);
});

// ---------------------------------------------------------------------------
// The section: counts, collapse text, devices first
// ---------------------------------------------------------------------------

check('rail section: pending rows follow the devices and are not counted as devices', () => {
  const real = device('aca-real-one');
  const html = deviceSectionHtml('aca', 'ACA runs', [real], new Map(), 'aca', 'Start an ACA run', null, acaRailRowsHtml([entry()], [real]));
  assert.match(html, /ACA runs \(1\)/);
  assert.ok(html.indexOf('aca-real-one') < html.indexOf('aca-rail'), 'devices come first');
  assert.strictEqual(railRows(html), 1);
});

check('rail section: with only a pending row the section is not empty and still counts zero devices', () => {
  const html = deviceSectionHtml('aca', 'ACA runs', [], new Map(), 'aca', 'Start an ACA run', null, acaRailRowsHtml([entry()], []));
  assert.match(html, /ACA runs \(0\)/);
  assert.ok(!/No aca runs yet/.test(html));
  assert.strictEqual(railRows(html), 1);
  const empty = deviceSectionHtml('aca', 'ACA runs', [], new Map(), 'aca', 'Start an ACA run', null, acaRailRowsHtml([], []));
  assert.match(empty, /No aca runs yet\./);
});

check('rail section: the always-visible ACA jobs row is unchanged and uncounted', () => {
  const html = acaJobsRowHtml();
  assert.match(html, /class="device ondemand"/);
  assert.match(html, /Set up to start runs/);
  assert.doesNotMatch(html, /dot online|Always available/);
  const connected = acaJobsRowHtml(true);
  assert.match(connected, /Connected service &middot; Ready to start runs/);
  assert.match(connected, /dot online/);
  assert.match(html, /data-action="aca"/);
});

// ---------------------------------------------------------------------------
// The real flow, through the real render()
// ---------------------------------------------------------------------------

function resetPage(devices = []) {
  state.acaPending = [];
  state.scope = 'all';
  state.overview = {
    devices,
    groups: devices.map((d) => ({ device: d, sessions: [] })),
    counts: {
      devices: devices.filter((d) => d.presence === 'online').length, sessions: 0, actionNeeded: 0,
    },
    hubVersion: '0.7.0',
  };
  requests.length = 0;
  dispatchRows = [];
}
const deviceList = () => dom.element('deviceList').innerHTML;
const dispatchRow = (over = {}) => ({ id: 'trk-1', ...over });
const running = (over = {}) => dispatchRow({ status: { state: 'in_progress', runId: 7, runAttempt: 1 }, ...over });

(async () => {
  await checkAsync('rail flow: a dispatch from this tab appears in the ACA section the moment it is tracked', async () => {
    resetPage();
    trackAcaDispatch({ repo: 'acme/widgets', issue: 42, trackerId: 'trk-1' });
    render();
    const html = deviceList();
    assert.strictEqual(railRows(html), 1);
    assert.strictEqual(pulses(html), 1);
    assert.match(html, /#42 \u00b7 acme\/widgets/);
    assert.ok(html.indexOf('ACA runs') < html.indexOf('class="device aca-rail"'));
    assert.ok(html.indexOf('class="device aca-rail"') < html.indexOf('Cloud devices'), 'it sits inside the ACA section');
    assert.ok(!/Starting|lease claimed/.test(html), 'nothing has proven a start yet');
  });

  await checkAsync('rail flow: counts, summary and the pending main list ignore the rail row', async () => {
    resetPage([device('local-pc', { kind: 'local' })]);
    trackAcaDispatch({ repo: 'acme/widgets', issue: 42, trackerId: 'trk-1' });
    render();
    assert.strictEqual(String(dom.element('deviceCount').textContent), '1', 'one real device');
    const html = deviceList();
    assert.match(html, /ACA runs \(0\)/);
    assert.match(html, /Local machines \(1\)/);
    assert.match(dom.element('groups').innerHTML, /class="row aca-pending"/, 'the list still has its own Queued on ACA row');
    assert.match(dom.element('groups').innerHTML, /Queued on ACA/);
    assert.ok(!/aca-rail/.test(dom.element('groups').innerHTML), 'the two places draw different rows');
  });

  await checkAsync('rail flow: the real sync moves the row from Queued to Starting from the own run and receipt of the hub', async () => {
    resetPage();
    trackAcaDispatch({ repo: 'acme/widgets', issue: 42, trackerId: 'trk-1' });
    dispatchRows = [dispatchRow({ status: { state: 'queued', runId: 7, runAttempt: 1 } })];
    await syncAcaPending(); render();
    assert.match(deviceList(), /Queued \u00b7 waiting to claim its lease/);
    assert.ok(!/Starting/.test(deviceList()), 'a queued run is not Starting');

    dispatchRows = [running()];
    await syncAcaPending(); render();
    assert.match(deviceList(), /Starting · the run is in progress/);
    assert.ok(!/lease claimed/.test(deviceList()));

    dispatchRows = [running({ executionName: EXEC })];
    await syncAcaPending(); render();
    assert.match(deviceList(), /Starting · lease claimed, waiting to attach/);
    assert.strictEqual(pulses(deviceList()), 1);
    assert.strictEqual(railRows(deviceList()), 1);
  });

  await checkAsync('rail flow: the matched aca- device replaces the pending row, once, with no duplicate', async () => {
    resetPage();
    trackAcaDispatch({ repo: 'acme/widgets', issue: 42, trackerId: 'trk-1' });
    dispatchRows = [running({ executionName: EXEC })];
    await syncAcaPending(); render();
    assert.strictEqual(railRows(deviceList()), 1);

    const real = device(`aca-${EXEC}`);
    state.overview = { ...state.overview, devices: [real], groups: [{ device: real, sessions: [] }], counts: { devices: 1, sessions: 0 } };
    // The overview lands before the attach step has run: no double draw.
    render();
    assert.strictEqual(railRows(deviceList()), 0, 'a device that proves the start hides the row at once');
    assert.strictEqual(deviceList().split(`data-spawn="aca-${EXEC}"`).length - 1, 1, 'the real device is drawn exactly once');
    assert.match(deviceList(), /ACA runs \(1\)/);

    assert.strictEqual(acaAttachFromOverview(), true);
    render();
    assert.strictEqual(railRows(deviceList()), 0);
    assert.strictEqual(deviceList().split(`data-spawn="aca-${EXEC}"`).length - 1, 1);
    assert.strictEqual(pulses(deviceList()), 0, 'nothing is left pulsing');
    assert.strictEqual(state.acaPending[0].deviceId, `aca-${EXEC}`);
  });

  await checkAsync('rail flow: a device of another job never takes over the row of a newer dispatch', async () => {
    resetPage([device(`aca-${EXEC_2}`)]);
    trackAcaDispatch({ repo: 'acme/widgets', issue: 42, trackerId: 'trk-1' });
    dispatchRows = [running({ executionName: EXEC })];
    await syncAcaPending(); render();
    const html = deviceList();
    assert.strictEqual(railRows(html), 1, 'the older job on the same repository does not hide it');
    assert.match(html, new RegExp(`data-spawn="aca-${EXEC_2}"`));
    assert.ok(!new RegExp(`data-spawn="aca-${EXEC}"`).test(html));
    assert.strictEqual(state.acaPending[0].attached, false);
  });

  await checkAsync('rail flow: two dispatches to one repository stay two rows until each own device attaches', async () => {
    resetPage();
    trackAcaDispatch({ repo: 'acme/widgets', issue: 42, trackerId: 'trk-1' });
    trackAcaDispatch({ repo: 'acme/widgets', issue: 43, trackerId: 'trk-2' });
    dispatchRows = [running(), running({ id: 'trk-2', executionName: EXEC_2 })];
    await syncAcaPending(); render();
    assert.strictEqual(railRows(deviceList()), 2);
    assert.strictEqual(pulses(deviceList()), 2);

    const second = device(`aca-${EXEC_2}`);
    state.overview = { ...state.overview, devices: [second], groups: [{ device: second, sessions: [] }], counts: { devices: 1, sessions: 0 } };
    await syncAcaPending(); render();
    const html = deviceList();
    assert.strictEqual(railRows(html), 1, 'only the dispatch whose device arrived is replaced');
    assert.match(html, /#42 \u00b7 acme\/widgets/);
    assert.ok(!/#43 \u00b7 acme\/widgets/.test(html.slice(html.indexOf('aca-rail'))), 'the attached dispatch has no pending row left');
  });

  await checkAsync('rail flow: a failed dispatch stops pulsing, says why and offers one re-read, never a second dispatch', async () => {
    resetPage();
    trackAcaDispatch({ repo: 'acme/widgets', issue: 42, trackerId: 'trk-1' });
    dispatchRows = [dispatchRow({ status: { state: 'error', reason: 'the workflow was not found' } })];
    await syncAcaPending(); render();
    let html = deviceList();
    assert.strictEqual(railRows(html), 1);
    assert.strictEqual(pulses(html), 0);
    assert.match(html, /class="dot failed"/);
    assert.match(html, /the workflow was not found/);
    assert.match(html, /data-aca-retry="aca-local-\d+-\d+">Check again</);

    // The hub now reports the run as started: Check again picks it up.
    requests.length = 0;
    dispatchRows = [running()];
    await retryAcaPending(state.acaPending[0].localId); render();
    assert.deepStrictEqual(requests, ['/api/aca/dispatches'], 'one read of the existing endpoint, no dispatch');
    html = deviceList();
    assert.strictEqual(pulses(html), 1);
    assert.match(html, /Starting · the run is in progress/);
    assert.ok(!/Check again/.test(html));
  });

  await checkAsync('rail flow: an unknown outcome is not drawn as a failure and does not pulse', async () => {
    resetPage();
    trackAcaDispatch({ repo: 'acme/widgets', issue: 42, trackerId: 'trk-1' });
    dispatchRows = [dispatchRow({ status: { state: 'unsupported', reason: 'no receipt in this repo' } })];
    await syncAcaPending(); render();
    const html = deviceList();
    assert.strictEqual(pulses(html), 0);
    assert.match(html, /class="dot stale"/);
    assert.ok(!/class="dot failed"/.test(html));
    assert.match(html, /Unknown outcome/);
    assert.match(html, /Check again/);
  });

  await checkAsync('rail flow: nothing tracked draws no rail row and the empty ACA section reads as before', async () => {
    resetPage();
    render();
    const html = deviceList();
    assert.strictEqual(railRows(html), 0);
    assert.match(html, /No aca runs yet\./);
    assert.match(html, /class="device ondemand"/);
  });

  await checkAsync('empty scopes: a local session cannot hide the Cloud connection guidance', async () => {
    const local = device('local-pc', { kind: 'local' });
    resetPage([local]);
    state.overview.groups[0].sessions = [{ id: 'local-session', deviceId: local.deviceId, status: 'active' }];
    state.overview.counts.sessions = 1;
    state.scope = 'cloud';
    render();
    assert.strictEqual(dom.element('empty').hidden, false);
    assert.match(dom.element('empty').innerHTML, /No cloud sessions available/);
    assert.match(dom.element('empty').innerHTML, /No cloud devices are connected/);
    assert.match(dom.element('empty').innerHTML, /Connect a cloud device/);
    assert.doesNotMatch(dom.element('groups').innerHTML, /local-pc/);
  });

  await checkAsync('empty scopes: a cloud session cannot hide the Local connection guidance', async () => {
    const cloud = device('cloud-worker', { kind: 'cloud' });
    resetPage([cloud]);
    state.overview.groups[0].sessions = [{ id: 'cloud-session', deviceId: cloud.deviceId, status: 'active' }];
    state.overview.counts.sessions = 1;
    state.scope = 'local';
    render();
    assert.strictEqual(dom.element('empty').hidden, false);
    const html = dom.element('empty').innerHTML;
    assert.match(html, /No local sessions available/);
    assert.match(html, /No local devices are connected/);
    assert.match(html, /generated command on your machine/);
    assert.match(html, /data-action="connect-device"/);
    assert.doesNotMatch(dom.element('groups').innerHTML, /cloud-worker/);
  });

  await checkAsync('empty scopes: a connected local device offers a session, not a false disconnected message', async () => {
    resetPage([device('local-pc', { kind: 'local' })]);
    state.scope = 'local';
    render();
    assert.match(dom.element('empty').innerHTML, /A local device is connected/);
    assert.match(dom.element('empty').innerHTML, /id="emptyLocal">New local session/);
    assert.doesNotMatch(dom.element('empty').innerHTML, /No local devices are connected/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
