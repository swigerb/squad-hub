'use strict';
/**
 * Stale shared `#rowMenu` identity across real navigation (#243 Scout review
 * of ab5ef90, PR comment 6091670737): open session A's detail page, open its
 * header `⋯` menu (the shared `#rowMenu`, with the detail header's own
 * `Sync session` item appended), then navigate away through the browser's
 * own Back/Forward -- a real `popstate`, no outside click -- to session B.
 * The menu stayed visible, still keyed to A. Its Sync click handler closed
 * the menu, then called `syncSession()`, which read `state.currentSession`
 * FRESH: it resynced whichever session popstate had just opened (B), not
 * the one the menu was actually offered for (A). Ordinary row actions kept
 * their identity (`onRowMenuAction(rowMenuKey, ...)`); the Sync branch alone
 * discarded it.
 *
 * Fixed two independent ways, both exercised below through the REAL
 * exported functions -- `openDetail`/`closeDetail`/`initDetailRouting`
 * (detail.js), `openRowMenu`/`closeRowMenu` (wiring.js) and `syncSession`
 * (detail-control.js) -- not a reimplementation of any of them:
 *
 *   1. `openDetail`/`closeDetail` now close the shared menu unconditionally,
 *      before anything else -- including through the real `popstate`
 *      listener `initDetailRouting` installs, driven below exactly as a
 *      browser's Back/Forward fires it (no outside click, no simulated
 *      guard standing in for the real one).
 *   2. `syncSession` now takes the target its caller's menu item was built
 *      for and refuses to act for any other session -- a second,
 *      independent guard, in case a stale menu ever reached a click despite
 *      (1). The row-menu click handler (wiring.js) passes its own
 *      `rowMenuKey`, captured before `closeRowMenu()` clears it; mirrored
 *      here as `clickSyncRowAction` the same way escape-focus-unit.js's
 *      `pressEscapeLikeApp` mirrors the Escape handler, since neither
 *      handler is its own exported function.
 *
 * Loaded the same flattened way as detail-control-unit.js/escape-focus-unit.js:
 * `readWebSource()` walks app.js's real import graph (so `wiring.js`'s
 * `openRowMenu`/`closeRowMenu` and detail.js's new circular import of
 * `closeRowMenu` are both the SAME code that ships) and concatenates every
 * reachable module's stripped source into one eval'd function body.
 *
 * `clickSyncRowAction` below dispatches through `handleRowMenuClick`, the
 * exact function wiring.js's `wire()` installs as `$('rowMenu').onclick` --
 * not a reimplementation of its body. A mutation that dropped or broke the
 * target capture inside the real handler would be caught here; a restated
 * copy of the handler's logic would not catch it.
 */

const assert = require('assert');
const { readWebSource } = require('./helpers/web-source');

let pass = 0; let fail = 0;
async function checkAsync(name, fn) {
  try {
    await fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

/** Flush several microtask turns, same helper as detail-control-unit.js. */
async function tick(n = 4) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

const src = readWebSource();
const mod = { exports: {} };
new Function('module', 'exports', `${src}
// Test doubles: both \`api\` and \`refresh\` are plain function declarations
// (mutable bindings), reassigned here so this never hits a real network.
let __apiImpl = async () => ({});
let __refreshCalls = 0;
let __resyncCalls = [];
api = (...args) => __apiImpl(...args);
refresh = async () => { __refreshCalls += 1; };
// render() (devices.js) paints the whole page from a real DOM; its tail is
// exactly syncDetailHeader(); syncRowMenu(); -- the real functions under test.
render = () => { syncDetailHeader(); syncRowMenu(); };
function __setApiImpl(fn) { __apiImpl = fn; }
function __getRefreshCalls() { return __refreshCalls; }
function __getResyncCalls() { return __resyncCalls; }
function __resetCalls() { __refreshCalls = 0; __resyncCalls = []; }
module.exports = {
  openDetail, closeDetail, initDetailRouting, openRowMenu, closeRowMenu,
  syncSession, detailSyncMenuItem, sessionKey, state, composerReduce,
  handleRowMenuClick, syncRowMenu, syncDetailHeader, retainedSelection,
  __setApiImpl, __getRefreshCalls, __getResyncCalls, __resetCalls,
};`)(mod, mod.exports);

const {
  openDetail, closeDetail, initDetailRouting, openRowMenu, closeRowMenu,
  syncSession, detailSyncMenuItem, sessionKey, state, composerReduce,
  handleRowMenuClick, syncRowMenu, syncDetailHeader, retainedSelection,
  __setApiImpl, __getRefreshCalls, __getResyncCalls, __resetCalls,
} = mod.exports;

function makeElement(id) {
  const attrs = new Map();
  const el = {
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    className: '',
    hidden: false,
    disabled: false,
    placeholder: '',
    title: '',
    dataset: {},
    children: [],
    style: {},
    classList: {
      toggle() {}, add() {}, remove() {}, contains() { return false; },
    },
    onclick: null,
    onkeydown: null,
    oninput: null,
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); },
    getBoundingClientRect: () => ({
      left: 0, right: 0, top: 0, bottom: 0, width: 100, height: 50,
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: (node) => node === el,
    closest: () => null,
    addEventListener() {},
    focus() { fakeDoc.activeElement = el; },
  };
  return el;
}

let fakeDoc;
/** Auto-creates any element by id on first read, same convention as
 * detail-control-unit.js's own `fakeDocument`, extended with the DOM methods
 * `openRowMenu`'s positioning code reads (`getBoundingClientRect`,
 * `querySelector`, `focus`) so the REAL `openRowMenu`/`closeRowMenu` run
 * unmodified. */
function fakeDocument() {
  const byId = new Map();
  fakeDoc = {
    activeElement: null,
    querySelectorAll: () => [],
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement(id));
      return byId.get(id);
    },
  };
  return fakeDoc;
}

function session(key, overrides = {}) {
  return {
    device: { deviceId: `dev-${key}`, presence: 'online' },
    session: { id: key, key, ...overrides },
  };
}

/** Makes every key findable by the real `openDetail`/`resolveDeepLink`. */
function makeFindable(...keys) {
  state.overview.groups = keys.map((k) => {
    const found = session(k);
    return { device: found.device, sessions: [found.session] };
  });
}

function resetState() {
  state.overview = {
    devices: [], groups: [], counts: { devices: 1, sessions: 1, actionNeeded: 0 }, hubVersion: '',
  };
  state.filters = {
    q: '', status: '', device: '', repo: '', org: '', window: '',
  };
  state.scope = 'all';
  state.groupBy = 'device';
  state.sortBy = 'started_desc';
  state.favorites = new Set();
  state.names = {};
  state.currentSession = null;
  state.seenApprovals = new Set();
  state.notified = new Set();
  state.openApproval = null;
  state.composer = composerReduce(undefined, { type: 'reset' });
  __resetCalls();
}

/** Not-synced AND reachable -- the one state `detailSyncMenuItem` offers Sync in. */
function forceNotSynced() {
  state.composer = composerReduce(state.composer, { type: 'verify-result', outcome: { controllable: false } });
}

/**
 * Dispatches a real click on the shared `#rowMenu`'s Sync item through
 * `handleRowMenuClick` -- the exact function wiring.js's `wire()` installs
 * as `$('rowMenu').onclick`, unchanged and unduplicated. `menuOpenKey` is
 * the key the test itself last passed to the real `openRowMenu`, asserted
 * against the resulting resync call below so a mutation that drops or
 * breaks the production target capture inside `handleRowMenuClick` cannot
 * silently pass.
 */
function clickSyncRowAction(doc, menuOpenKey) {
  assert.strictEqual(doc.getElementById('rowMenu').hidden, false,
    'test setup bug: clickSyncRowAction called with no row menu actually open');
  const syncButton = { dataset: { rowAction: 'sync' }, disabled: false };
  const fakeClickEvent = {
    target: { closest: (sel) => (sel === '[data-row-action]' ? syncButton : null) },
  };
  void menuOpenKey; // documents which session the caller expects; verified via __getResyncCalls()
  return handleRowMenuClick(fakeClickEvent);
}

/** A resolvable `/resync` + `/control-check` double that records every call. */
function wireApiDouble() {
  __setApiImpl(async (p, opts) => {
    if (p.includes('/resync')) {
      __getResyncCalls().push((opts && opts.body && opts.body.sessionId) || null);
      return { id: 'ok' };
    }
    if (p.includes('/control-check')) return { controllable: false, reason: 'forced not-synced' };
    if (p.includes('/transcript')) return { transcript: [] };
    throw new Error(`unexpected path in this suite: ${p}`);
  });
}

/** Records every device-facing request; `/control-check` answers "synced" so no Sync item is offered. */
function recordApiDouble(calls) {
  __setApiImpl(async (p, opts) => {
    calls.push({ path: p, method: opts && opts.method, body: opts && opts.body });
    if (p.includes('/control-check')) return { controllable: true };
    if (p.includes('/transcript')) return { transcript: [] };
    return {};
  });
}

/** One device with one session in it, the shape `state.overview.groups` has. */
function listOne(key, sessionOverrides = {}, deviceOverrides = {}) {
  const device = {
    deviceId: `dev-${key}`, presence: 'online', name: 'Laptop', ...deviceOverrides,
  };
  state.overview.groups = [{ device, sessions: [{ id: key, key, ...sessionOverrides }] }];
}

/**
 * What a server-side status/search/device filter does to the overview
 * (`refresh()` sends them as query parameters): the device's own group is
 * still listed, the session that stopped matching is not.
 */
function filterOutSessions(deviceOverrides = {}) {
  state.overview.groups = [{ device: { ...state.overview.groups[0].device, ...deviceOverrides }, sessions: [] }];
}

const menuIsOpen = () => global.document.getElementById('rowMenu').hidden === false;
const menuHtml = () => global.document.getElementById('rowMenu').innerHTML;
const menuActions = () => [...menuHtml().matchAll(/data-row-action="(\w+)"/g)].map((m) => m[1]);
const stopIsDisabled = () => /data-row-action="stop"[^>]*\sdisabled/.test(menuHtml());

/** A real click on one item of the shared menu, through the same `handleRowMenuClick` as above. */
async function clickRowAction(action, href) {
  assert.strictEqual(menuIsOpen(), true, `test setup bug: clicking "${action}" with no row menu open`);
  const button = { dataset: { rowAction: action, ...(href ? { href } : {}) }, disabled: false };
  handleRowMenuClick({ target: { closest: (sel) => (sel === '[data-row-action]' ? button : null) } });
  await tick(10);
}

(async () => {
  const oldWindow = global.window;
  const oldDocument = global.document;
  const oldLocation = Object.getOwnPropertyDescriptor(global, 'location');
  const oldHistory = Object.getOwnPropertyDescriptor(global, 'history');
  const setLocation = (v) => Object.defineProperty(global, 'location', { value: v, configurable: true });
  const setHistory = (v) => Object.defineProperty(global, 'history', { value: v, configurable: true });

  /** A fake `window` that records the real `popstate` listener `initDetailRouting` installs. */
  function fakeWindow() {
    const listeners = {};
    return {
      innerWidth: 1280,
      innerHeight: 900,
      confirm: () => true,
      prompt: () => null,
      navigator: {},
      addEventListener(type, fn) { listeners[type] = fn; },
      removeEventListener(type) { delete listeners[type]; },
      __fireListener(type) {
        assert.ok(listeners[type], `no real listener was ever registered for "${type}"`);
        listeners[type]();
      },
    };
  }

  /** A fresh fake page: closed shared menu, no leftover module menu state. */
  function setup() {
    resetState();
    global.document = fakeDocument();
    global.document.getElementById('rowMenu').hidden = true;
    global.window = fakeWindow();
    setLocation({ origin: 'https://hub.example', pathname: '/', search: '' });
    setHistory({ pushState() {}, replaceState() {} });
    closeRowMenu();
  }

  try {
    await checkAsync('a real popstate from session A to session B closes A\'s stale shared Sync menu BEFORE anything else -- synchronously, not after an await', async () => {
      resetState();
      wireApiDouble();
      global.document = fakeDocument();
      global.window = fakeWindow();
      setLocation({ origin: 'https://hub.example', pathname: '/', search: '' });
      setHistory({ pushState() {}, replaceState() {} });
      makeFindable('A', 'B');

      await openDetail('A');
      assert.strictEqual(sessionKey(state.currentSession.session), 'A', 'setup failed: detail did not open on A');
      forceNotSynced();
      const opener = global.document.getElementById('dtMoreBtn');
      const extra = detailSyncMenuItem();
      assert.ok(extra && extra.action === 'sync', 'setup failed: Sync session was not offered for A (Not-synced, reachable)');
      openRowMenu(sessionKey(state.currentSession.session), opener, { extra: [extra] });
      assert.strictEqual(global.document.getElementById('rowMenu').hidden, false, 'setup failed: the shared row menu never opened for A');

      initDetailRouting();
      // The browser already rewrote the address bar before firing popstate
      // -- this never goes through `applyNav`/`history`, exactly per the
      // NAV.NONE contract `initDetailRouting`'s listener documents.
      global.location.search = '?session=B';
      global.window.__fireListener('popstate');

      // Asserted IMMEDIATELY, with no `await` in between: `openDetail`'s
      // `closeRowMenu()` call is its very first statement, run synchronously
      // before the function's own first `await` -- the same reasoning
      // `invalidateSelection()` already relies on next to it. If this ever
      // regressed to running after an await, a real click dispatched in
      // that gap could still reach the stale menu.
      assert.strictEqual(global.document.getElementById('rowMenu').hidden, true,
        'the shared row menu was still visible immediately after a real popstate to a different session -- the stale-menu regression is back');

      await tick(6);
      assert.strictEqual(sessionKey(state.currentSession.session), 'B', 'popstate did not actually open session B');
      assert.deepStrictEqual(__getResyncCalls(), [], 'no Sync click was simulated, yet a resync request was issued');
    });

    await checkAsync('closing the detail page (the back link, Escape, or a NAV.NONE popstate to "/") also closes a stale shared Sync menu, with no outside click', async () => {
      resetState();
      wireApiDouble();
      global.document = fakeDocument();
      global.window = fakeWindow();
      setLocation({ origin: 'https://hub.example', pathname: '/', search: '' });
      setHistory({ pushState() {}, replaceState() {} });
      makeFindable('A');

      await openDetail('A');
      forceNotSynced();
      const opener = global.document.getElementById('dtMoreBtn');
      openRowMenu('A', opener, { extra: [detailSyncMenuItem()] });
      assert.strictEqual(global.document.getElementById('rowMenu').hidden, false, 'setup failed: the shared row menu never opened');

      closeDetail();
      assert.strictEqual(global.document.getElementById('rowMenu').hidden, true,
        'closeDetail left the shared row menu visible after leaving the detail page');
      assert.strictEqual(state.currentSession, null, 'closeDetail did not actually clear the open selection');
    });

    await checkAsync('reopening the SAME session after closing it does not inherit a menu bound to the earlier open, and a fresh Sync click on the reopened session still works', async () => {
      resetState();
      wireApiDouble();
      global.document = fakeDocument();
      global.window = fakeWindow();
      setLocation({ origin: 'https://hub.example', pathname: '/', search: '' });
      setHistory({ pushState() {}, replaceState() {} });
      makeFindable('A');

      await openDetail('A');
      forceNotSynced();
      const opener = global.document.getElementById('dtMoreBtn');
      openRowMenu('A', opener, { extra: [detailSyncMenuItem()] });
      assert.strictEqual(global.document.getElementById('rowMenu').hidden, false, 'setup failed: the shared row menu never opened');

      closeDetail();
      await openDetail('A'); // same key, a fresh open
      assert.strictEqual(global.document.getElementById('rowMenu').hidden, true,
        'reopening the identical session inherited a menu left over from before it was closed');
      forceNotSynced();

      const extra2 = detailSyncMenuItem();
      openRowMenu('A', opener, { extra: [extra2] });
      assert.strictEqual(global.document.getElementById('rowMenu').hidden, false, 'setup failed: the reopened menu did not open');
      const outcome = clickSyncRowAction(global.document, 'A');
      await outcome;
      await tick(4);
      assert.deepStrictEqual(__getResyncCalls(), ['A'], 'a genuine Sync click on the reopened session did not reach the device exactly once');
    });

    await checkAsync('syncSession refuses a stale target: a menu\'s Sync item bound to A does not resync whatever is open now, even called directly with the real function', async () => {
      resetState();
      wireApiDouble();
      global.document = fakeDocument();
      global.window = fakeWindow();
      setLocation({ origin: 'https://hub.example', pathname: '/', search: '' });
      setHistory({ pushState() {}, replaceState() {} });
      makeFindable('A', 'B');

      await openDetail('A');
      forceNotSynced();
      const staleTarget = sessionKey(state.currentSession.session); // 'A', captured at menu-open time

      await openDetail('B'); // a real navigation away from A, same as popstate would cause
      forceNotSynced();
      assert.strictEqual(sessionKey(state.currentSession.session), 'B', 'setup failed: the second open did not switch to B');

      await syncSession(staleTarget); // the stale menu's Sync item, clicked after the switch
      await tick(4);
      assert.deepStrictEqual(__getResyncCalls(), [], 'syncSession resynced B using a Sync item that was built for A');

      // The currently-open session's OWN Sync item is unaffected: bound to
      // "B" rather than discarding its identity, it still fires exactly once.
      await syncSession(sessionKey(state.currentSession.session));
      await tick(4);
      assert.deepStrictEqual(__getResyncCalls(), ['B'], 'Sync session, correctly targeted at the CURRENT selection, did not reach the device');
    });

    await checkAsync('the accepted-positive path is unaffected: Sync for the session actually open fires exactly once through the real row-menu click dispatch, and re-enables once it settles', async () => {
      resetState();
      wireApiDouble();
      global.document = fakeDocument();
      global.window = fakeWindow();
      setLocation({ origin: 'https://hub.example', pathname: '/', search: '' });
      setHistory({ pushState() {}, replaceState() {} });
      makeFindable('A');

      await openDetail('A');
      forceNotSynced();
      const opener = global.document.getElementById('dtMoreBtn');
      const extra = detailSyncMenuItem();
      assert.strictEqual(extra.disabled, false, 'Sync session should not start disabled');
      openRowMenu('A', opener, { extra: [extra] });

      await clickSyncRowAction(global.document, 'A');
      await tick(6);

      assert.deepStrictEqual(__getResyncCalls(), ['A'], 'exactly one resync request should have reached the device for the session actually open');
      assert.strictEqual(__getRefreshCalls() >= 1, true, 'a successful Sync should trigger a refresh');

      forceNotSynced();
      const afterSettle = detailSyncMenuItem();
      assert.strictEqual(afterSettle.disabled, false,
        'Sync session is still disabled after its own resync settled -- the per-target in-flight guard was never cleared');
    });

    // ---- #181 review finding 1: the header menu for a session a server-side
    // filter has dropped from `state.overview` -------------------------------

    await checkAsync('the detail header ⋯ still opens for the open session after a server-side filter drops it from the overview, offering the actions of the retained session', async () => {
      setup();
      recordApiDouble([]);
      listOne('A', { status: 'done' });
      await openDetail('A');
      filterOutSessions();
      assert.strictEqual(state.overview.groups[0].sessions.length, 0, 'setup bug: the filtered overview still lists A');

      openRowMenu('A', global.document.getElementById('dtMoreBtn'));
      assert.strictEqual(menuIsOpen(), true,
        'the detail header ⋯ did nothing once its session left the filtered overview');
      const actions = menuActions();
      for (const wanted of ['open', 'pin', 'rename', 'copylink', 'remove']) {
        assert.ok(actions.includes(wanted), `the retained header menu lost "${wanted}" (offered: ${actions.join(', ')})`);
      }
      assert.ok(!actions.includes('stop'), 'an ended retained session must not offer Stop');
    });

    await checkAsync('a refresh or WebSocket render keeps the header menu open on the retained session and rebuilds it for a changed pin', async () => {
      setup();
      recordApiDouble([]);
      listOne('A', { status: 'done' });
      await openDetail('A');
      openRowMenu('A', global.document.getElementById('dtMoreBtn')); // opened while A was still listed
      assert.strictEqual(menuIsOpen(), true, 'setup failed: the header menu did not open for the listed session');

      filterOutSessions();
      syncRowMenu();
      assert.strictEqual(menuIsOpen(), true,
        'a refresh that dropped the session from the overview closed the detail header\'s own menu');
      assert.ok(menuHtml().includes('Pin') && !menuHtml().includes('Unpin'), 'setup failed: A should start unpinned');

      state.favorites.add('A');
      syncRowMenu();
      assert.strictEqual(menuIsOpen(), true, 'pinning while retained closed the header menu');
      assert.ok(menuHtml().includes('Unpin'), 'the retained header menu did not rebuild for a changed pin');
    });

    await checkAsync('the DEVICE of the retained session is re-read from the overview, so Stop and the header controls follow its presence rather than the open-time snapshot', async () => {
      setup();
      recordApiDouble([]);
      listOne('A', { status: 'active' });
      await openDetail('A');
      openRowMenu('A', global.document.getElementById('dtMoreBtn'));
      assert.ok(menuActions().includes('stop'), 'setup failed: a live session on an online device should offer Stop');
      assert.strictEqual(stopIsDisabled(), false, 'setup failed: Stop should start enabled on an online device');
      assert.strictEqual(global.document.getElementById('dtStop').disabled, false, 'setup failed: the header Stop should start enabled');

      filterOutSessions({ presence: 'offline' });
      syncRowMenu();
      syncDetailHeader();
      assert.strictEqual(menuIsOpen(), true, 'the retained header menu closed when its device went offline');
      assert.strictEqual(retainedSelection('A').device.presence, 'offline',
        'the retained selection kept the open-time device instead of the overview\'s latest record');
      assert.strictEqual(stopIsDisabled(), true, 'Stop stayed enabled in the menu for a session on a device that went offline');
      assert.strictEqual(global.document.getElementById('dtStop').disabled, true, 'the header Stop stayed enabled for a device that went offline');
    });

    await checkAsync('a LIST row menu never falls back to the retained session of the open page: it closes when its row leaves the overview and will not open for a row that is not there', async () => {
      setup();
      recordApiDouble([]);
      listOne('A', { status: 'done' });
      await openDetail('A');
      const rowButton = makeElement('rowMore-A');
      openRowMenu('A', rowButton);
      assert.strictEqual(menuIsOpen(), true, 'setup failed: a list row menu did not open for a listed session');

      filterOutSessions();
      syncRowMenu();
      assert.strictEqual(menuIsOpen(), false,
        'a list row menu stayed open for a session that is no longer in the overview, kept alive only because the detail page retains it');

      openRowMenu('A', rowButton);
      assert.strictEqual(menuIsOpen(), false, 'a list row ⋯ opened for a row that is not in the overview');
      openRowMenu('Z', global.document.getElementById('dtMoreBtn'));
      assert.strictEqual(menuIsOpen(), false, 'the detail header ⋯ opened for a session that is neither listed nor the open page');
    });

    await checkAsync('a stale LIST row menu cannot act on the retained session of the open page: a click that lands before the next render does nothing', async () => {
      setup();
      const calls = [];
      recordApiDouble(calls);
      listOne('A', { status: 'done' }, { capabilities: { narrowedForget: true } });
      await openDetail('A');
      openRowMenu('A', makeElement('rowMore-A'));
      assert.strictEqual(menuIsOpen(), true, 'setup failed: a list row menu did not open for a listed session');

      filterOutSessions(); // the row is gone; nothing has re-rendered or closed the menu yet
      calls.length = 0;
      __resetCalls();
      await clickRowAction('remove');
      assert.deepStrictEqual(calls, [],
        'a list row menu acted on the open page\'s retained session after its own row left the overview');
      assert.strictEqual(sessionKey(state.currentSession.session), 'A', 'a refused list row action closed the open detail page');
      assert.strictEqual(menuIsOpen(), false, 'the stale list row menu stayed open after its refused action');
    });

    await checkAsync('the device of the retained session is the overview group with its OWN device id, never the record of another device', async () => {
      setup();
      const calls = [];
      recordApiDouble(calls);
      listOne('A', { status: 'active' });
      await openDetail('A');
      const own = { ...state.overview.groups[0].device, name: 'Laptop (renamed)' };
      const decoy = { deviceId: 'dev-decoy', presence: 'offline', name: 'Another box' };
      state.overview.groups = [{ device: decoy, sessions: [] }, { device: own, sessions: [] }];

      assert.strictEqual(retainedSelection('A').device.deviceId, 'dev-A',
        'the retained selection took another device\'s record because it was listed first');
      openRowMenu('A', global.document.getElementById('dtMoreBtn'));
      assert.strictEqual(menuIsOpen(), true, 'setup failed: the retained header menu did not open');
      calls.length = 0;
      await clickRowAction('stop');
      assert.deepStrictEqual(calls, [{ path: '/api/devices/dev-A/stop', method: 'POST', body: { sessionId: 'A' } }],
        'Stop from the retained header menu went to a device that does not own the session');
    });

    await checkAsync('Remove from the retained header menu forgets exactly that session on the retained device, then leaves the detail page', async () => {
      setup();
      const calls = [];
      recordApiDouble(calls);
      listOne('A', { status: 'done' }, { capabilities: { narrowedForget: true } });
      await openDetail('A');
      filterOutSessions();
      openRowMenu('A', global.document.getElementById('dtMoreBtn'));
      calls.length = 0;
      __resetCalls();

      await clickRowAction('remove');
      assert.deepStrictEqual(calls, [{ path: '/api/devices/dev-A/forget', method: 'POST', body: { sessionId: 'A' } }],
        'Remove from the retained header menu did not forget exactly session A on its device');
      assert.strictEqual(state.currentSession, null, 'removing the retained open session did not close its detail page');
      assert.strictEqual(__getRefreshCalls(), 1, 'removing the retained session did not refresh the list');
      assert.strictEqual(menuIsOpen(), false, 'the header menu stayed open after Remove');
    });

    await checkAsync('Stop from the retained header menu stops exactly that session on the retained device and leaves the detail page open', async () => {
      setup();
      const calls = [];
      recordApiDouble(calls);
      listOne('A', { status: 'active' });
      await openDetail('A');
      filterOutSessions();
      openRowMenu('A', global.document.getElementById('dtMoreBtn'));
      calls.length = 0;

      await clickRowAction('stop');
      assert.deepStrictEqual(calls, [{ path: '/api/devices/dev-A/stop', method: 'POST', body: { sessionId: 'A' } }],
        'Stop from the retained header menu did not stop exactly session A on its device');
      assert.strictEqual(sessionKey(state.currentSession.session), 'A', 'stopping closed or switched the open detail page');
    });

    await checkAsync('Rename, Pin and Open pull request from the retained header menu all act on the retained session, and the header follows the new name and pin', async () => {
      setup();
      recordApiDouble([]);
      const url = 'https://github.com/o/r/pull/9';
      listOne('A', { status: 'done', prompt: 'build the thing', pullRequest: { url } });
      await openDetail('A');
      filterOutSessions();
      const opener = global.document.getElementById('dtMoreBtn');

      openRowMenu('A', opener);
      global.window.prompt = () => 'Fresh name';
      await clickRowAction('rename');
      assert.strictEqual(state.names.A, 'Fresh name', 'Rename from the retained header menu did not store the name');
      assert.strictEqual(global.document.getElementById('dtTitle').textContent, 'Fresh name',
        'the detail header title did not follow the rename once the session left the overview');

      openRowMenu('A', opener);
      await clickRowAction('pin');
      assert.strictEqual(state.favorites.has('A'), true, 'Pin from the retained header menu did not pin the session');
      const star = global.document.getElementById('dtStar');
      assert.strictEqual(star.getAttribute('aria-pressed'), 'true', 'the header star did not follow a pin made from the menu');
      assert.strictEqual(star.title, 'Unpin this session', 'the header star title did not follow a pin made from the menu');

      const opened = [];
      global.window.open = (...args) => opened.push(args);
      openRowMenu('A', opener);
      assert.ok(menuActions().includes('pr'), 'setup failed: the retained session\'s pull request link was not offered');
      await clickRowAction('pr', url);
      assert.deepStrictEqual(opened, [[url, '_blank', 'noopener']], 'Open pull request did not open the retained session\'s PR');
    });

    await checkAsync('stale target safety holds for a retained header menu: once the open page is a different session it neither acts on it nor survives a sync', async () => {
      setup();
      const calls = [];
      recordApiDouble(calls);
      const device = { deviceId: 'dev-A', presence: 'online', name: 'Laptop', capabilities: { narrowedForget: true } };
      const a = { id: 'A', key: 'A', status: 'done' };
      const b = { id: 'B', key: 'B', status: 'done' };
      state.overview.groups = [{ device, sessions: [a, b] }];
      await openDetail('A');
      state.overview.groups = [{ device, sessions: [b] }]; // A filtered out, B still listed
      const opener = global.document.getElementById('dtMoreBtn');

      openRowMenu('A', opener);
      assert.strictEqual(menuIsOpen(), true, 'setup failed: the retained header menu did not open for A');
      state.currentSession = { device, session: b }; // the open page moved on without the menu being closed
      calls.length = 0;
      await clickRowAction('remove');
      assert.deepStrictEqual(calls, [], 'a header menu opened for A acted on a session the open page is no longer showing');
      assert.strictEqual(menuIsOpen(), false, 'the stale header menu stayed open after a refused action');

      state.currentSession = { device, session: a };
      openRowMenu('A', opener);
      assert.strictEqual(menuIsOpen(), true, 'setup failed: the retained header menu did not reopen for A');
      state.currentSession = { device, session: b };
      syncRowMenu();
      assert.strictEqual(menuIsOpen(), false, 'a render kept a header menu alive for a session that is no longer the open page');
    });

    await checkAsync('the detail header keeps following the retained session after it leaves the overview, and defers to the live row as soon as it is listed again', async () => {
      setup();
      recordApiDouble([]);
      listOne('A', { status: 'active', prompt: 'build the thing' });
      await openDetail('A');

      filterOutSessions({ name: 'Desktop', presence: 'offline' });
      state.names.A = 'Mine';
      syncDetailHeader();
      assert.strictEqual(global.document.getElementById('dtTitle').textContent, 'Mine',
        'the header title froze on its open-time value once the session left the overview');
      assert.ok(global.document.getElementById('dtMeta').textContent.includes('Desktop'),
        'the header meta did not follow the retained device\'s refreshed record');
      assert.strictEqual(state.currentSession.device.presence, 'offline', 'the open selection kept a stale device');

      const live = { id: 'A', key: 'A', status: 'done', prompt: 'build the thing' };
      state.overview.groups = [{ device: { ...state.overview.groups[0].device, presence: 'online' }, sessions: [live] }];
      syncDetailHeader();
      assert.strictEqual(state.currentSession.session, live,
        'a session listed again did not replace the retained snapshot with the live row');
    });
  } finally {
    if (oldWindow === undefined) delete global.window; else global.window = oldWindow;
    if (oldDocument === undefined) delete global.document; else global.document = oldDocument;
    if (oldLocation) Object.defineProperty(global, 'location', oldLocation); else delete global.location;
    if (oldHistory) Object.defineProperty(global, 'history', oldHistory); else delete global.history;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
