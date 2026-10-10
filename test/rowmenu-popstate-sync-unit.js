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
function __setApiImpl(fn) { __apiImpl = fn; }
function __getRefreshCalls() { return __refreshCalls; }
function __getResyncCalls() { return __resyncCalls; }
function __resetCalls() { __refreshCalls = 0; __resyncCalls = []; }
module.exports = {
  openDetail, closeDetail, initDetailRouting, openRowMenu, closeRowMenu,
  syncSession, detailSyncMenuItem, sessionKey, state, composerReduce,
  handleRowMenuClick,
  __setApiImpl, __getRefreshCalls, __getResyncCalls, __resetCalls,
};`)(mod, mod.exports);

const {
  openDetail, closeDetail, initDetailRouting, openRowMenu, closeRowMenu,
  syncSession, detailSyncMenuItem, sessionKey, state, composerReduce,
  handleRowMenuClick,
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
    closest: () => null,
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
  } finally {
    if (oldWindow === undefined) delete global.window; else global.window = oldWindow;
    if (oldDocument === undefined) delete global.document; else global.document = oldDocument;
    if (oldLocation) Object.defineProperty(global, 'location', oldLocation); else delete global.location;
    if (oldHistory) Object.defineProperty(global, 'history', oldHistory); else delete global.history;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
