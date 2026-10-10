'use strict';
/**
 * `verifyControl`/`syncSession`/`detailSyncMenuItem` (web/js/detail-control.js,
 * split out of detail.js in the fix for PR #243's Scout review of 53e6a18).
 *
 * Two real-browser CI regressions, reproduced here deterministically with
 * hand-controlled deferred promises -- no real network, no real timers, no
 * sleeping and guessing:
 *
 *   1. `verifyControl` used to compare `state.currentSession !== current` by
 *      OBJECT reference. `syncDetailHeader` (unchanged by this fix) reassigns
 *      `state.currentSession` to a freshly-`findSession`'d wrapper on every
 *      overview refresh and WebSocket push, even for the exact same
 *      device/session -- so a heartbeat arriving while a control-check was in
 *      flight silently discarded the real answer, leaving "Checking
 *      control…" forever (`run 37888188843`: 2255 passed, 1 failed, "timed
 *      out waiting for the detail control check to settle"). The fix compares
 *      by `sessionKey` instead, while a separate `controlToken` still rejects
 *      an answer genuinely superseded by a newer verification.
 *
 *   2. Moving `Sync session` into the shared `#rowMenu` dropped the
 *      self-disabling guard the old dedicated `#dtSync` button gave for free,
 *      so reopening the menu mid-resync could fire a second one at the same
 *      target. The fix restores a one-in-flight-resync-per-target guard.
 *
 * Two further regressions, found by Scout's actual-source review of the
 * first fix (34256a0) and fixed here, with their own deterministic coverage:
 *
 *   3. The in-flight guard above was a single scalar key, not a per-target
 *      lock: starting Sync for A, navigating to B and starting Sync for B,
 *      then returning to A and clicking Sync again before either request had
 *      returned, let B's start silently overwrite A's lock -- A's second
 *      click fired a SECOND resync for A while B still only ever got one.
 *      The fix is a `Set` of in-flight target keys, where each target's own
 *      settlement only ever deletes its own key.
 *
 *   4. `controlToken` only increments once a NEW `verifyControl` call
 *      actually starts, but `openDetail` sets `state.currentSession` and
 *      awaits the transcript fetch BEFORE calling `verifyControl` again. A
 *      reply for an OLD verification (even of the exact same session, closed
 *      and reopened) can land in that gap, pass the same-key/same-token
 *      check, and get applied as if it answered the new context. The fix
 *      adds a `selectionGeneration` bumped synchronously by
 *      `invalidateSelection` -- called by `openDetail`/`closeDetail`
 *      immediately, before anything async -- which a same-session
 *      live-snapshot refresh (no open/close call) never touches.
 *
 * A fifth regression, found while adding real-call-site coverage for PR
 * #243's Scout source review (which also found the `app.js`/`detail.js`
 * stale-import module-link break covered by test/module-link-unit.js):
 * `openDetail` applied its transcript fetch's result UNCONDITIONALLY once
 * the `await` settled, with no check at all that the person had not since
 * closed, reopened (even the identical session), or opened something else
 * entirely while that fetch was in flight -- unlike `verifyControl`, which
 * already guarded its own result this way. A slow transcript fetch for an
 * abandoned session could overwrite the CURRENTLY-open, correct session's
 * transcript with stale content for a session no longer on screen, and
 * fire a redundant `verifyControl` call racing the new selection's own.
 * Fixed by having `invalidateSelection` return the generation it just set,
 * and a new `selectionStillActive(key, generation)` (detail-control.js)
 * that `openDetail` checks before applying the transcript or starting
 * `verifyControl`, the same way `verifyControl` already checks its own
 * result.
 *
 * The tests below marked "(real call sites)" exercise this through the
 * ACTUAL `openDetail`/`closeDetail` functions -- including the real
 * `await` on the transcript fetch -- rather than only simulating a
 * close/reopen with direct `invalidateSelection()`/`state.currentSession`
 * writes, so a regression in the real call sites themselves (not just the
 * guard they call) is caught too.
 *
 * Loaded the same way row-menu-action-unit.js loads app.js's whole dependency
 * graph: `readWebSource()` walks app.js's imports transitively (so
 * `detail-control.js`, reached only via detail.js's own import, is included)
 * and concatenates every reachable module's stripped source into one eval'd
 * function body -- the SAME code that ships. `api` and `refresh` are
 * reassigned (both are plain function declarations, a mutable binding) to
 * test doubles after load, exactly the way this file needs to hand-schedule
 * each deferred reply; nothing about the guard itself is faked, removed, or
 * given a longer timeout to hide behind.
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

// A fresh fake element per id, cached so repeated reads see the same object
// `renderControl` wrote to -- same shape as web-xss-unit.js's fake document,
// extended (classList/setAttribute/innerHTML/value) for the real-call-site
// tests below, which drive the actual `openDetail`/`closeDetail` DOM writes
// rather than only the composer-reducer path the earlier tests exercise.
// `closest`/`addEventListener`/`querySelectorAll` are what the Mode and Model
// bar (#183) reads whenever `renderControl` repaints; this page has no bar,
// so each answers as an element with nothing around it would.
function fakeDocument() {
  const byId = {};
  return {
    querySelectorAll: () => [],
    getElementById(id) {
      if (!byId[id]) {
        byId[id] = {
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
          classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
          setAttribute() {},
          removeAttribute() {},
          getAttribute() { return null; },
          closest: () => null,
          addEventListener() {},
          // What `dtInput`'s Enter key does to `dtSend`; the promise is kept so
          // a test can wait for the send the key started.
          click() { this.lastClick = this.onclick && this.onclick(); return this.lastClick; },
        };
      }
      return byId[id];
    },
  };
}

/** A promise plus its own resolve/reject, so a test can settle it on its own schedule. */
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Flush several microtask turns. The real-call-site tests below settle a
 * deferred reply and then need `verifyControl`'s own internal
 * `Promise.race([ask, timeout])` plus its subsequent `composerReduce`/
 * `renderControl` continuation to actually run -- more than the single
 * `await Promise.resolve()` turn the simulated (non-real-call-site) tests
 * above get away with, because the real call goes through one more promise
 * layer (`openDetail`'s own `await`, then its un-awaited `verifyControl()`
 * call, THEN that call's own await).
 */
async function tick(n = 4) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

const src = readWebSource();
const mod = { exports: {} };
new Function('module', 'exports', `${src}
// Test doubles: both \`api\` and \`refresh\` are plain function declarations
// (mutable bindings), reassigned here so each test schedules its own
// deferred replies instead of hitting a real network. \`history\` is faked
// the same way \`document\` is -- a bare global \`openDetail\`/\`closeDetail\`
// (via \`applyNav\`) call directly.
let __apiImpl = async () => { throw new Error('api not stubbed for this call'); };
let __refreshCalls = 0;
api = (...args) => __apiImpl(...args);
refresh = async () => { __refreshCalls += 1; };
function __setApiImpl(fn) { __apiImpl = fn; }
function __getRefreshCalls() { return __refreshCalls; }
// The Mode and Model bar (#183) still runs for real; this only records when it
// was painted and what the composer said at that moment.
let __ntPaints = [];
const __realRenderNextTurn = renderNextTurn;
renderNextTurn = () => {
  __ntPaints.push({ key: state.currentSession ? sessionKey(state.currentSession.session) : '', control: state.composer.control });
  return __realRenderNextTurn();
};
function __takeNtPaints() { const out = __ntPaints; __ntPaints = []; return out; }
module.exports = {
  verifyControl, syncSession, detailSyncMenuItem, invalidateSelection, state, renderControl, composerReduce,
  openDetail, closeDetail, syncDetailHeader, wireComposer,
  __setApiImpl, __getRefreshCalls, __takeNtPaints,
};`)(mod, mod.exports);

const {
  verifyControl, syncSession, detailSyncMenuItem, invalidateSelection, state, renderControl, composerReduce,
  openDetail, closeDetail, syncDetailHeader, wireComposer,
  __setApiImpl, __getRefreshCalls, __takeNtPaints,
} = mod.exports;

function session(key, overrides = {}) {
  return {
    device: { deviceId: `dev-${key}`, presence: 'online' },
    session: { id: key, key, ...overrides },
  };
}

/** Makes `key` findable by the real `openDetail` (it reads `state.overview.groups`). */
function makeFindable(key, overrides = {}) {
  const found = session(key, overrides);
  state.overview.groups = [{ device: found.device, sessions: [found.session] }];
  return found;
}

/**
 * A single `api` double that routes by path substring to its own
 * independently-controlled deferred reply, with a FRESH deferred per call --
 * `openDetail` calls `/transcript` and `verifyControl` calls `/control-check`
 * every time, including across a close+reopen of the same session, and the
 * real-call-site tests below need to resolve a specific one of several
 * in-flight calls to the SAME path independently.
 */
function apiRouter() {
  const pending = { transcript: [], controlCheck: [] };
  function impl(p) {
    const d = deferred();
    if (p.includes('/transcript')) pending.transcript.push(d);
    else if (p.includes('/control-check')) pending.controlCheck.push(d);
    else throw new Error(`unexpected path: ${p}`);
    return d.promise;
  }
  return {
    impl,
    resolveTranscript(i, value) { pending.transcript[i].resolve(value); },
    resolveControlCheck(i, value) { pending.controlCheck[i].resolve(value); },
  };
}


function resetComposer() {
  state.composer = composerReduce(undefined, { type: 'reset' });
}

// ---- the send ownership tests below drive the page's real handlers ---------

const dom = (id) => global.document.getElementById(id);

/** What a person typing in the draft box does: the box changes, then `oninput` fires. */
function typeInBox(text) {
  dom('dtInput').value = text;
  dom('dtInput').oninput({ target: dom('dtInput') });
}

/**
 * Two sessions, A and B, on one device that can change Mode. `publish()` is a
 * live push: the whole list is rebuilt as new objects, as the socket does.
 */
function sendWorld(tag) {
  const device = { deviceId: `dev-${tag}`, name: `Device ${tag}`, presence: 'online' };
  const choices = [{ id: 'm-agent', name: 'Agent' }, { id: 'm-plan', name: 'Plan' }, { id: 'm-auto', name: 'Autopilot' }];
  const build = (id, current) => ({
    id,
    key: `${tag}:${id}`,
    status: 'idle',
    nextTurn: {
      supported: true,
      mode: { supported: true, current, choices },
      model: { supported: false, reason: 'This agent did not offer a choice of model.', current: null, choices: [] },
    },
  });
  const world = {
    keyA: `${tag}:A`,
    keyB: `${tag}:B`,
    publish(modeOfA = 'm-agent') {
      state.overview.groups = [{ device, sessions: [build('A', modeOfA), build('B', 'm-agent')] }];
    },
  };
  world.publish();
  return world;
}

/** The device: transcripts and control checks answer at once, every steer is held for the test to settle. */
function steerApi() {
  const steers = [];
  __setApiImpl((path, opts) => {
    if (path.includes('/transcript')) return Promise.resolve({ transcript: [] });
    if (path.includes('/control-check')) return Promise.resolve({ controllable: true });
    if (path.includes('/steer')) {
      const held = deferred();
      steers.push({ body: opts.body, resolve: held.resolve, reject: held.reject });
      return held.promise;
    }
    throw new Error(`unexpected path: ${path}`);
  });
  return steers;
}

function captureAlerts() {
  const shown = [];
  global.alert = (message) => { shown.push(String(message)); };
  return shown;
}

/** The real `openDetail`, then enough turns for the control check to settle as synced. */
async function openSynced(key) {
  assert.strictEqual(await openDetail(key), true, `${key} could not be opened`);
  await tick(8);
  assert.strictEqual(state.composer.control, 'synced', `${key} never became controllable`);
}

/** Press Send as a person does; resolves when the handler has finished with the reply. */
const pressSend = () => dom('dtSend').onclick();

(async () => {
  global.document = fakeDocument();
  // `applyNav` (called by the real `openDetail`/`closeDetail` below) writes
  // to `history` directly as a bare global, exactly like `document`.
  global.history = { pushState() {}, replaceState() {} };

  await checkAsync('a same-session live-snapshot refresh mid-verification does not drop the valid result (stable selection, not object identity)', async () => {
    resetComposer();
    const a1 = session('alpha');
    state.currentSession = a1;
    const check = deferred();
    __setApiImpl(() => check.promise);

    const p = verifyControl();
    await Promise.resolve(); // let verifyControl reach its await
    assert.strictEqual(state.composer.control, 'verifying', 'verifyControl did not enter VERIFYING immediately');

    // The exact regression: syncDetailHeader reassigns state.currentSession
    // to a NEW wrapper for the SAME device/session key while the request is
    // still in flight, several times a second in the real app.
    state.currentSession = session('alpha');
    state.currentSession = session('alpha');

    check.resolve({ controllable: true });
    await p;

    assert.strictEqual(state.composer.control, 'synced',
      'a same-session live-snapshot refresh discarded a valid control-check result');
  });

  await checkAsync('navigating to a DIFFERENT session while verification is in flight discards the stale result', async () => {
    resetComposer();
    state.currentSession = session('beta');
    const check = deferred();
    __setApiImpl(() => check.promise);

    const p = verifyControl();
    await Promise.resolve();
    state.currentSession = session('gamma'); // a real navigation, not a refresh
    check.resolve({ controllable: true });
    await p;

    assert.strictEqual(state.composer.control, 'verifying',
      'a result meant for a session the person navigated away from was applied anyway');
  });

  await checkAsync('closing the detail page while verification is in flight discards the stale result', async () => {
    resetComposer();
    state.currentSession = session('delta');
    const check = deferred();
    __setApiImpl(() => check.promise);

    const p = verifyControl();
    await Promise.resolve();
    state.currentSession = null; // closeDetail()
    check.resolve({ controllable: true });
    await p;

    assert.strictEqual(state.composer.control, 'verifying',
      'a result for a session that was closed before it answered was applied anyway');
  });

  await checkAsync('a second verifyControl call for the same session supersedes the first; its late reply is rejected', async () => {
    resetComposer();
    state.currentSession = session('epsilon');
    const first = deferred();
    const second = deferred();
    const calls = [first, second];
    __setApiImpl(() => calls.shift().promise);

    const p1 = verifyControl();
    await Promise.resolve();
    const p2 = verifyControl(); // e.g. a reopen, or syncSession re-asking
    await Promise.resolve();

    second.resolve({ controllable: true });
    await p2;
    assert.strictEqual(state.composer.control, 'synced', 'the superseding verification result was not applied');

    first.resolve({ controllable: false, reason: 'the agent process is gone' });
    await p1;
    assert.strictEqual(state.composer.control, 'synced',
      'a superseded verification\u2019s late reply overwrote the newer, already-applied result');
  });

  await checkAsync('syncSession issues exactly one resync request per target while one is already pending', async () => {
    resetComposer();
    state.composer.control = 'not_synced'; // canSync() === true
    state.currentSession = session('zeta');
    let resyncCalls = 0;
    const resync = deferred();
    const controlCheck = deferred();
    __setApiImpl((path) => {
      if (path.includes('/resync')) { resyncCalls += 1; return resync.promise; }
      if (path.includes('/control-check')) return controlCheck.promise;
      throw new Error(`unexpected path: ${path}`);
    });

    const p1 = syncSession();
    await Promise.resolve();
    assert.strictEqual(resyncCalls, 1, 'the first click did not issue a resync request');
    const pending = detailSyncMenuItem();
    assert.strictEqual(pending.disabled, true, 'the menu item is not disabled while a resync is already in flight');
    assert.strictEqual(pending.label, 'Syncing…', 'the pending label does not say so');

    // Reopening the menu and clicking again -- the regression: the old
    // dedicated button disabled itself; the shared menu item has to too.
    const p2 = syncSession();
    await Promise.resolve();
    assert.strictEqual(resyncCalls, 1, 'a second click while one resync is pending issued ANOTHER resync request');

    resync.resolve({});
    controlCheck.resolve({ controllable: true });
    await Promise.all([p1, p2]);

    assert.strictEqual(resyncCalls, 1, 'more than one resync request reached the device for one target');
    assert.strictEqual(__getRefreshCalls(), 1, 'refresh() was not called exactly once after the resync settled');
    assert.strictEqual(state.composer.control, 'synced', 'the re-verification after a successful resync did not land');
    assert.strictEqual(detailSyncMenuItem(), null,
      'Sync session is still offered after a successful resync left the session synced');
  });

  await checkAsync('a late resync success for session A, after the person already selected session B, does not touch B\u2019s state', async () => {
    resetComposer();
    state.composer.control = 'not_synced';
    state.currentSession = session('eta-a');
    const resync = deferred();
    __setApiImpl((path) => {
      if (path.includes('/resync')) return resync.promise;
      throw new Error(`unexpected path for a late-success test: ${path}`);
    });

    const p = syncSession();
    await Promise.resolve();
    state.currentSession = session('eta-b'); // selected a different session mid-resync
    const beforeRefresh = __getRefreshCalls();
    resync.resolve({});
    await p;

    // refresh() still runs (the overview itself is not session-scoped), but
    // no re-verification was started for the session nobody is looking at
    // anymore -- state.composer (B's) was left exactly where it was.
    assert.strictEqual(__getRefreshCalls(), beforeRefresh + 1, 'refresh() did not run after the late success');
    assert.strictEqual(state.composer.control, 'not_synced',
      'a late resync success for an abandoned session re-verified or mutated the NEWLY selected session\u2019s composer');
  });

  await checkAsync('a late resync FAILURE for session A, after the person already selected session B, does not touch B\u2019s state', async () => {
    resetComposer();
    state.composer.control = 'not_synced';
    state.currentSession = session('theta-a');
    const resync = deferred();
    __setApiImpl((path) => {
      if (path.includes('/resync')) return resync.promise;
      throw new Error(`unexpected path for a late-failure test: ${path}`);
    });

    const p = syncSession();
    await Promise.resolve();
    state.currentSession = session('theta-b');
    resync.reject(new Error('device unreachable'));
    await p;

    assert.strictEqual(state.composer.control, 'not_synced',
      'a late resync FAILURE for an abandoned session mutated the newly selected session\u2019s composer/reason');
    assert.strictEqual(state.composer.reason, '',
      'the abandoned session\u2019s failure reason leaked into the newly selected session\u2019s banner');
  });

  await checkAsync('a resync failure for the STILL-open session reports the error on its own composer', async () => {
    resetComposer();
    state.composer.control = 'not_synced';
    state.currentSession = session('iota');
    const resync = deferred();
    __setApiImpl((path) => {
      if (path.includes('/resync')) return resync.promise;
      throw new Error(`unexpected path: ${path}`);
    });

    const p = syncSession();
    await Promise.resolve();
    resync.reject(new Error('device unreachable'));
    await p;

    assert.strictEqual(state.composer.control, 'unverified', 'a resync failure for the open session was not reported');
    assert.strictEqual(state.composer.reason, 'device unreachable', 'the real failure reason did not reach the banner');
    assert.strictEqual(detailSyncMenuItem().disabled, false,
      'the in-flight flag was not cleared after a failed resync, locking the menu item disabled forever');
  });

  await checkAsync('A-B-A interleaving: starting Sync for A, then B, then A again before either settles issues exactly one resync for A and one for B', async () => {
    resetComposer();
    state.composer.control = 'not_synced';
    state.currentSession = session('lockA');
    let resyncCallsA = 0; let resyncCallsB = 0;
    const resyncA = deferred();
    const resyncB = deferred();
    const controlCheck = deferred();
    __setApiImpl((path, opts) => {
      if (path.includes('/resync')) {
        if (opts.body.sessionId === 'lockA') { resyncCallsA += 1; return resyncA.promise; }
        if (opts.body.sessionId === 'lockB') { resyncCallsB += 1; return resyncB.promise; }
        throw new Error(`unexpected resync target: ${opts.body.sessionId}`);
      }
      if (path.includes('/control-check')) return controlCheck.promise;
      throw new Error(`unexpected path: ${path}`);
    });

    // A's Sync starts first.
    const pA1 = syncSession();
    await Promise.resolve();
    assert.strictEqual(resyncCallsA, 1, 'starting Sync for A did not issue A\u2019s resync request');

    // Navigate to B and start its own Sync -- a SEPARATE target, must not
    // disturb A's still-pending lock.
    state.currentSession = session('lockB');
    const pB = syncSession();
    await Promise.resolve();
    assert.strictEqual(resyncCallsB, 1, 'starting Sync for B did not issue B\u2019s resync request');

    // Return to A and click Sync again before EITHER request has returned.
    // The bug: a scalar `syncInFlightKey` was overwritten by B's start, so
    // this second click for A was no longer seen as "already pending" and
    // fired a second resync for A.
    state.currentSession = session('lockA');
    const pA2 = syncSession();
    await Promise.resolve();
    assert.strictEqual(resyncCallsA, 1,
      'clicking Sync again for A, while A was already pending and after B had separately started, issued a SECOND resync for A');

    resyncA.resolve({});
    resyncB.resolve({});
    controlCheck.resolve({ controllable: true });
    await Promise.all([pA1, pA2, pB]);

    assert.strictEqual(resyncCallsA, 1, 'more than one resync request reached the device for target A');
    assert.strictEqual(resyncCallsB, 1, 'more than one resync request reached the device for target B');
  });

  await checkAsync('out-of-order settlement: B resync finishing before A\u2019s does not clear or disturb A\u2019s own lock', async () => {
    resetComposer();
    state.composer.control = 'not_synced';
    state.currentSession = session('revA');
    let resyncCallsA = 0; let resyncCallsB = 0;
    const resyncA = deferred();
    const resyncB = deferred();
    const controlCheck = deferred();
    __setApiImpl((path, opts) => {
      if (path.includes('/resync')) {
        if (opts.body.sessionId === 'revA') { resyncCallsA += 1; return resyncA.promise; }
        resyncCallsB += 1; return resyncB.promise;
      }
      if (path.includes('/control-check')) return controlCheck.promise;
      throw new Error(`unexpected path: ${path}`);
    });

    const pA = syncSession();
    await Promise.resolve();
    state.currentSession = session('revB');
    const pB = syncSession();
    await Promise.resolve();

    // B settles FIRST, A is still pending -- reversed from the usual order.
    resyncB.resolve({});
    controlCheck.resolve({ controllable: true });
    await pB;
    assert.strictEqual(resyncCallsB, 1, 'B\u2019s own resync was requested more than once');

    // A must still show as pending for its own target, unaffected by B's
    // settlement -- the whole point of a per-target lock. Re-select A (its
    // own resync is still unresolved) and click Sync again: if B's
    // settlement had incorrectly cleared a SHARED lock instead of only its
    // own key, this would fire a second resync request for A.
    state.currentSession = session('revA');
    const pA2 = syncSession();
    await Promise.resolve();
    assert.strictEqual(resyncCallsA, 1,
      'B settling first incorrectly cleared A\u2019s still-pending in-flight lock, allowing a second resync for A');

    resyncA.resolve({});
    await Promise.all([pA, pA2]);
    assert.strictEqual(resyncCallsA, 1, 'A\u2019s resync was requested more than once overall');
  });

  await checkAsync('a verifyControl reply that arrives after close+reopen of the SAME session (before the new verification even starts) is discarded', async () => {
    resetComposer();
    const key = 'reopen-key';
    state.currentSession = session(key);
    const first = deferred();
    __setApiImpl(() => first.promise);

    const p1 = verifyControl();
    await Promise.resolve(); // old verifyControl is now in flight for `key`

    // Simulate closeDetail(): clears the selection AND invalidates it
    // immediately, same as web/js/detail.js actually does.
    invalidateSelection();
    state.currentSession = null;

    // Simulate re-opening the IDENTICAL session: openDetail sets
    // state.currentSession and invalidates again before awaiting the
    // transcript fetch -- represented here by simply NOT having started a
    // new verifyControl yet. The old reply must still be rejected even
    // though sessionKey matches and no newer verifyControl has bumped
    // controlToken.
    invalidateSelection();
    state.currentSession = session(key);

    first.resolve({ controllable: true });
    await p1;

    assert.strictEqual(state.composer.control, 'verifying',
      'a verifyControl reply for a session already closed-and-reopened (same key, before any new check started) was applied as if it answered the new context');
  });

  await checkAsync('a syncSession success that arrives after close+reopen of the SAME session must not apply or re-verify the new context', async () => {
    resetComposer();
    state.composer.control = 'not_synced';
    const key = 'reopen-sync-key';
    state.currentSession = session(key);
    const resync = deferred();
    __setApiImpl((path) => {
      if (path.includes('/resync')) return resync.promise;
      throw new Error(`unexpected path for a reopened-session test: ${path}`);
    });

    const p = syncSession();
    await Promise.resolve();

    // Close then reopen the identical session while the resync is still
    // pending -- same simulated sequence as the test above.
    invalidateSelection();
    state.currentSession = null;
    invalidateSelection();
    state.currentSession = session(key);

    resync.resolve({});
    await p;

    assert.strictEqual(state.composer.control, 'not_synced',
      'a resync success belonging to a closed-and-reopened session re-verified or otherwise touched the new context\u2019s composer');
  });

  await checkAsync('(real call sites) reopening the SAME session through the actual openDetail/closeDetail discards a verifyControl reply from before the reopen', async () => {
    resetComposer();
    const key = 'real-reopen-key';
    makeFindable(key);
    const router = apiRouter();
    __setApiImpl(router.impl);

    // First open: real openDetail, awaiting its own real transcript fetch.
    const open1 = openDetail(key);
    await Promise.resolve(); // openDetail reaches its `await api(transcript)`
    router.resolveTranscript(0, { transcript: [] });
    await open1; // transcript settles; openDetail fires its own verifyControl()
    await tick(); // let that verifyControl() call reach its own await
    assert.strictEqual(state.composer.control, 'verifying', 'the first open did not start a control-check');

    // Real close, then real reopen of the IDENTICAL session, before the
    // first open's control-check has answered.
    closeDetail();
    const open2 = openDetail(key);
    await Promise.resolve();
    router.resolveTranscript(1, { transcript: [] });
    await open2;
    await Promise.resolve();

    // The FIRST open's control-check (still pending) answers late.
    router.resolveControlCheck(0, { controllable: true });
    await tick();
    assert.strictEqual(state.composer.control, 'verifying',
      'a control-check reply for the session before it was closed and reopened (real openDetail/closeDetail) was applied to the reopened context');

    // The SECOND open's own control-check answers; this one must apply.
    router.resolveControlCheck(1, { controllable: true });
    await tick();
    assert.strictEqual(state.composer.control, 'synced',
      'the reopened session\u2019s own control-check result was not applied');
  });

  await checkAsync('(real call sites) a slow transcript fetch from an abandoned open does not overwrite the transcript or redundantly re-verify the session actually open now', async () => {
    resetComposer();
    const keyA = 'real-abandoned-a';
    const keyB = 'real-abandoned-b';
    makeFindable(keyA);
    const router = apiRouter();
    __setApiImpl(router.impl);

    // Open A; its transcript fetch is left pending (call index 0).
    const openA = openDetail(keyA);
    await Promise.resolve();

    // Before A's transcript ever answers, B becomes the one actually open
    // (its own session, so it is independently findable) and its OWN
    // transcript (call index 1) and control-check (call index 0) settle
    // first, normally.
    makeFindable(keyB);
    const openB = openDetail(keyB);
    await Promise.resolve();
    router.resolveTranscript(1, { transcript: [{ kind: 'text', text: 'B\u2019s real transcript' }] });
    await openB;
    await Promise.resolve();
    router.resolveControlCheck(0, { controllable: true });
    await tick();
    assert.strictEqual(state.composer.control, 'synced', 'B\u2019s own control-check result was not applied');
    const dtTranscript = global.document.getElementById('dtTranscript');
    const bRenderedHtml = dtTranscript.innerHTML;
    assert.ok(bRenderedHtml.includes('B'), 'B\u2019s transcript was never rendered in the first place');

    // NOW A's long-abandoned transcript fetch finally answers.
    router.resolveTranscript(0, { transcript: [{ kind: 'text', text: 'A\u2019s stale transcript' }] });
    await openA;
    await Promise.resolve();

    assert.strictEqual(dtTranscript.innerHTML, bRenderedHtml,
      'a transcript fetched for a session the person already left (A) overwrote the CURRENTLY open session\u2019s (B) transcript on screen');

    // A's late continuation must not have started its own, redundant
    // control-check either -- only B's own (already resolved above) should
    // ever have been asked for.
    assert.strictEqual(state.composer.control, 'synced',
      'an abandoned open\u2019s late transcript fetch disturbed the composer of the session actually open now');
  });

  await checkAsync('(real call sites, #182 with #183) the Mode and Model bar follows the open session on every live push and on the control answer that applies, never on one a reopen superseded', async () => {
    resetComposer();
    const key = 'real-next-turn-key';
    makeFindable(key);
    const router = apiRouter();
    __setApiImpl(router.impl);
    __takeNtPaints();

    const open1 = openDetail(key);
    await Promise.resolve();
    router.resolveTranscript(0, { transcript: [] });
    await open1;
    await tick();
    assert.ok(__takeNtPaints().some((p) => p.key === key),
      'opening a session never painted the Mode and Model bar for it');

    // A live push rebuilds the open session's record and must repaint the
    // bar from it: the session going idle or busy is what enables it.
    syncDetailHeader();
    assert.ok(__takeNtPaints().some((p) => p.key === key),
      'a live push to the open session did not repaint the Mode and Model bar');

    // Close, then reopen the identical session, with the first open's control
    // answer still pending: that answer is #182's A-B-A case and the bar must
    // not be repainted from it.
    closeDetail();
    const open2 = openDetail(key);
    await Promise.resolve();
    router.resolveTranscript(1, { transcript: [] });
    await open2;
    await tick();
    __takeNtPaints();
    router.resolveControlCheck(0, { controllable: true });
    await tick();
    assert.deepStrictEqual(__takeNtPaints(), [],
      'a control answer from before the reopen repainted the Mode and Model bar of the reopened session');

    router.resolveControlCheck(1, { controllable: true });
    await tick();
    assert.ok(__takeNtPaints().some((p) => p.key === key && p.control === 'synced'),
      'the control answer for the session actually open never repainted the Mode and Model bar as synced');
  });

  // ---------------------------------------------------------------------------
  // Send ownership (#183 follow-up). A send belongs to the SESSION it was made
  // for: it is deduplicated per session, it always settles, and the session is
  // always refreshed from what the device confirmed. What it writes to the PAGE
  // -- the draft, the note, the pick -- it writes only if the page it began on
  // is still the one on screen, decided by the selection generation that
  // `openDetail`/`closeDetail` move (never by key alone, never by object).
  //
  // Everything below runs the page's real Send, Mode, hint and draft handlers
  // (`wireComposer`), the real `ntSteer`, the real `openDetail`/`closeDetail`
  // and the real store; only the device (`api`) and the list refresh are doubles.
  // ---------------------------------------------------------------------------
  wireComposer();

  await checkAsync('(send ownership) a send held while another session is opened cannot clear that session draft or composer, even when it holds the same words', async () => {
    resetComposer();
    const world = sendWorld('own-b');
    const steers = steerApi();
    const alerts = captureAlerts();
    await openSynced(world.keyA);
    typeInBox('same words');
    const sending = pressSend();
    assert.strictEqual(steers.length, 1, 'pressing Send on A never reached the device');
    const refreshedBefore = __getRefreshCalls();

    await openSynced(world.keyB);
    typeInBox('same words');
    steers[0].resolve({ sent: true });
    await sending;

    assert.strictEqual(dom('dtInput').value, 'same words', 'the landing of the send from A cleared the box of session B, which held the same words');
    assert.strictEqual(state.composer.draft, 'same words', 'the landing of the send from A cleared the draft of session B');
    assert.ok(!state.composer.outcome, 'the landing of the send from A told the composer of session B that it had sent');
    assert.deepStrictEqual(alerts, [], 'a send that succeeded raised a dialog');
    assert.ok(__getRefreshCalls() > refreshedBefore, 'a send that outlived its page was not folded into the session list');
    assert.strictEqual(steers.length, 1, 'the landing of A caused a second request');
  });

  await checkAsync('(send ownership) a send held across a close and reopen of the SAME session cannot clear the reopened draft, even with the same key and the same words', async () => {
    resetComposer();
    const world = sendWorld('own-a');
    const steers = steerApi();
    const alerts = captureAlerts();
    await openSynced(world.keyA);
    typeInBox('same words');
    const sending = pressSend();

    closeDetail();
    await openSynced(world.keyA);
    typeInBox('same words');
    steers[0].resolve({ sent: true });
    await sending;

    assert.strictEqual(dom('dtInput').value, 'same words', 'the landing of the send from the first page of A cleared the box of the reopened A');
    assert.strictEqual(state.composer.draft, 'same words', 'the landing of the send from the first page of A cleared the draft of the reopened A');
    assert.ok(!state.composer.outcome, 'the landing of the send from the first page of A told the reopened A that it had sent');
    assert.deepStrictEqual(alerts, [], 'a send that succeeded raised a dialog');
  });

  await checkAsync('(send ownership) a confirmed choice from a send that outlived its page is still spent and does not return as a pending pick', async () => {
    resetComposer();
    const world = sendWorld('own-spent');
    const steers = steerApi();
    captureAlerts();
    await openSynced(world.keyA);
    dom('dtNtMode').onchange({ target: { value: 'm-plan' } });
    typeInBox('plan it');
    const sending = pressSend();
    assert.strictEqual(steers[0].body.mode, 'm-plan', 'the send did not carry the pick');

    closeDetail();
    await openSynced(world.keyA);
    const refreshedBefore = __getRefreshCalls();
    steers[0].resolve({ sent: true, changes: [{ field: 'mode', to: 'm-plan' }] });
    await sending;

    assert.ok(!/agent confirmed/i.test(dom('dtNtNote').textContent),
      'a send from a page that was left wrote its outcome under the bar of the reopened page');
    assert.strictEqual(dom('dtInput').value, 'plan it', 'a send from a page that was left cleared the reopened draft');
    assert.ok(__getRefreshCalls() > refreshedBefore, 'a send that outlived its page did not refresh the session it confirmed a change on');

    // The agent took Plan, then moved off it by itself: the choice was spent by
    // the send, so nothing is left to send again.
    world.publish('m-plan'); syncDetailHeader();
    world.publish('m-agent'); syncDetailHeader();
    const again = pressSend();
    assert.strictEqual(steers.length, 2, 'the second Send never reached the device');
    assert.strictEqual(steers[1].body.mode, undefined, 'a choice the agent confirmed to a page that was left came back as a pending pick');
    steers[1].resolve({ sent: true });
    await again;
  });

  await checkAsync('(send ownership) a choice made on the reopened page survives the landing of an earlier send that confirmed a different one', async () => {
    resetComposer();
    const world = sendWorld('own-newer');
    const steers = steerApi();
    captureAlerts();
    await openSynced(world.keyA);
    dom('dtNtMode').onchange({ target: { value: 'm-plan' } });
    typeInBox('plan it');
    const sending = pressSend();

    closeDetail();
    await openSynced(world.keyA);
    // The bar holds its selectors while a change is confirmed, so this drives
    // the handler itself: what it proves is that the landing does not take it.
    dom('dtNtMode').onchange({ target: { value: 'm-auto' } });
    steers[0].resolve({ sent: true, changes: [{ field: 'mode', to: 'm-plan' }] });
    await sending;

    const again = pressSend();
    assert.strictEqual(steers.length, 2, 'the second Send never reached the device');
    assert.strictEqual(steers[1].body.mode, 'm-auto', 'a send from a page that was left erased the choice made on the reopened page');
    steers[1].resolve({ sent: true, changes: [{ field: 'mode', to: 'm-auto' }] });
    await again;
  });

  await checkAsync('(send ownership) a refusal that outlives its page is shown in a dialog and leaves the reopened page note, composer and pick alone', async () => {
    resetComposer();
    const world = sendWorld('own-refused');
    const steers = steerApi();
    const alerts = captureAlerts();
    await openSynced(world.keyA);
    dom('dtNtMode').onchange({ target: { value: 'm-plan' } });
    typeInBox('plan it');
    const sending = pressSend();

    closeDetail();
    await openSynced(world.keyA);
    steers[0].reject(new Error('mode refused'));
    await sending;

    assert.strictEqual(alerts.length, 1, `a refusal that outlived its page was shown ${alerts.length} times, not once`);
    assert.ok(/mode refused/.test(alerts[0]), `the dialog did not carry the reason: ${alerts[0]}`);
    assert.ok(!/kept|refused/i.test(dom('dtNtNote').textContent) && dom('dtNtNote').dataset.kind !== 'error',
      'a refusal from a page that was left was written under the bar of the reopened page');
    assert.notStrictEqual(state.composer.outcome, 'failed', 'a refusal from a page that was left marked the reopened composer as failed');
    assert.strictEqual(dom('dtInput').value, 'plan it', 'a refusal from a page that was left changed the reopened draft');

    // The pick is where it was: the next send carries it.
    const again = pressSend();
    assert.strictEqual(steers.length, 2, 'the second Send never reached the device');
    assert.strictEqual(steers[1].body.mode, 'm-plan', 'a refusal from a page that was left dropped the pick');
    steers[1].resolve({ sent: true, changes: [{ field: 'mode', to: 'm-plan' }] });
    await again;
  });

  await checkAsync('(send ownership) a plain send error that outlives its page is shown in a dialog and does not mark the reopened composer as failed', async () => {
    resetComposer();
    const world = sendWorld('own-plain-err');
    const steers = steerApi();
    const alerts = captureAlerts();
    await openSynced(world.keyA);
    typeInBox('same words');
    const sending = pressSend();

    closeDetail();
    await openSynced(world.keyA);
    typeInBox('same words');
    steers[0].reject(new Error('device exploded'));
    await sending;

    assert.strictEqual(alerts.length, 1, `an error that outlived its page was shown ${alerts.length} times, not once`);
    assert.ok(/device exploded/.test(alerts[0]), `the dialog did not carry the reason: ${alerts[0]}`);
    assert.notStrictEqual(state.composer.outcome, 'failed', 'an error from a page that was left marked the reopened composer as failed');
    assert.strictEqual(dom('dtInput').value, 'same words', 'an error from a page that was left changed the reopened draft');
  });

  await checkAsync('(send ownership) the one message at a time guard follows the session across a close and reopen', async () => {
    resetComposer();
    const world = sendWorld('own-once');
    const steers = steerApi();
    captureAlerts();
    await openSynced(world.keyA);
    typeInBox('once');
    const first = pressSend();

    closeDetail();
    await openSynced(world.keyA);
    await pressSend();
    assert.strictEqual(steers.length, 1, 'the reopened session issued a second message while the first was still being sent');
    assert.strictEqual(dom('dtSend').disabled, true, 'the reopened session offered Send while its message was still being sent');

    steers[0].resolve({ sent: true });
    await first;
    typeInBox('twice');
    const second = pressSend();
    assert.strictEqual(steers.length, 2, 'the session stayed held after its message had landed');
    steers[1].resolve({ sent: true });
    await second;
  });

  await checkAsync('(send ownership) on the same page a live rebuild of the open record does not stop a send landing: it clears only the unchanged draft and keeps new edits', async () => {
    resetComposer();
    const world = sendWorld('same-ok');
    const steers = steerApi();
    const alerts = captureAlerts();
    await openSynced(world.keyA);

    // Sent with Enter, as a person does.
    typeInBox('first');
    dom('dtInput').onkeydown({ key: 'Enter', preventDefault() {} });
    const first = dom('dtSend').lastClick;
    assert.strictEqual(steers.length, 1, 'Enter did not send');
    const openRecord = state.currentSession;
    world.publish(); syncDetailHeader();
    assert.notStrictEqual(state.currentSession, openRecord, 'fixture: the live push did not rebuild the open record');
    typeInBox('first, and one more thing');
    steers[0].resolve({ sent: true });
    await first;
    assert.strictEqual(dom('dtInput').value, 'first, and one more thing', 'a landed send erased what was typed after it');
    assert.strictEqual(state.composer.draft, 'first, and one more thing', 'a landed send erased the draft typed after it');

    typeInBox('second');
    const second = pressSend();
    world.publish(); syncDetailHeader();
    steers[1].resolve({ queued: true });
    await second;
    assert.strictEqual(dom('dtInput').value, '', 'a send that landed on the page it began on did not clear the unchanged draft');
    assert.strictEqual(state.composer.draft, '', 'a send that landed on the page it began on did not clear the composer draft');
    assert.strictEqual(state.composer.outcome, 'queued', 'a queued reply was not reported as queued on the page that sent it');
    assert.deepStrictEqual(alerts, [], 'a send that succeeded raised a dialog');
  });

  await checkAsync('(send ownership) on the same page a send that fails says so, and a refused change is a note under the bar with the pick kept', async () => {
    resetComposer();
    const world = sendWorld('same-err');
    const steers = steerApi();
    const alerts = captureAlerts();
    await openSynced(world.keyA);

    typeInBox('hello');
    const plain = pressSend();
    steers[0].reject(new Error('device offline'));
    await plain;
    assert.deepStrictEqual(alerts, ['Could not send: device offline'], 'a failed send on its own page was not reported');
    assert.strictEqual(state.composer.outcome, 'failed', 'a failed send on its own page did not mark the composer as failed');
    assert.strictEqual(state.composer.reason, 'device offline', 'the composer did not keep the reason');
    assert.strictEqual(dom('dtInput').value, 'hello', 'a failed send threw away the draft');

    alerts.length = 0;
    dom('dtNtMode').onchange({ target: { value: 'm-plan' } });
    typeInBox('plan it');
    const carried = pressSend();
    world.publish(); syncDetailHeader();
    steers[1].reject(new Error('mode refused'));
    await carried;
    assert.deepStrictEqual(alerts, [], 'a refused change was reported twice: under the bar and in a dialog');
    assert.strictEqual(dom('dtNtNote').textContent, 'Mode refused. Your message and choices are kept.', 'a refused change was not reported under the bar');
    assert.strictEqual(dom('dtNtNote').dataset.kind, 'error', 'a refused change was not marked as an error');
    assert.strictEqual(state.composer.outcome, 'failed', 'a refused change did not mark the composer as failed');
    assert.strictEqual(dom('dtInput').value, 'plan it', 'a refused change threw away the draft');

    const again = pressSend();
    assert.strictEqual(steers[2].body.mode, 'm-plan', 'a refused change dropped the pick');
    steers[2].resolve({ sent: true, changes: [{ field: 'mode', to: 'm-plan' }] });
    await again;
    assert.strictEqual(dom('dtNtNote').textContent, 'The agent confirmed: Mode is now Plan.', 'a confirmed change was not reported on the page that sent it');
    assert.strictEqual(dom('dtInput').value, '', 'a confirmed send did not clear its draft');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})();
