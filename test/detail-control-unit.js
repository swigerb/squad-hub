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
// `renderControl` wrote to -- same shape as web-xss-unit.js's fake document.
function fakeDocument() {
  const byId = {};
  return {
    getElementById(id) {
      if (!byId[id]) {
        byId[id] = {
          id, textContent: '', className: '', hidden: false, disabled: false, placeholder: '', title: '', dataset: {},
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

const src = readWebSource();
const mod = { exports: {} };
new Function('module', 'exports', `${src}
// Test doubles: both \`api\` and \`refresh\` are plain function declarations
// (mutable bindings), reassigned here so each test schedules its own
// deferred replies instead of hitting a real network.
let __apiImpl = async () => { throw new Error('api not stubbed for this call'); };
let __refreshCalls = 0;
api = (...args) => __apiImpl(...args);
refresh = async () => { __refreshCalls += 1; };
function __setApiImpl(fn) { __apiImpl = fn; }
function __getRefreshCalls() { return __refreshCalls; }
module.exports = {
  verifyControl, syncSession, detailSyncMenuItem, state, renderControl, composerReduce,
  __setApiImpl, __getRefreshCalls,
};`)(mod, mod.exports);

const {
  verifyControl, syncSession, detailSyncMenuItem, state, renderControl, composerReduce,
  __setApiImpl, __getRefreshCalls,
} = mod.exports;

function session(key, overrides = {}) {
  return {
    device: { deviceId: `dev-${key}`, presence: 'online' },
    session: { id: key, key, ...overrides },
  };
}

function resetComposer() {
  state.composer = composerReduce(undefined, { type: 'reset' });
}

(async () => {
  global.document = fakeDocument();

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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})();
