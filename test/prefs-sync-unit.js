'use strict';
/**
 * Prefs sync (#170), after PR #236's Scout review-gate (findings 1-3).
 *
 * `web/js/prefs-sync.js` has zero runtime dependencies and is meant to run in
 * a real browser with no build step -- so there is no jsdom here either, the
 * same posture as web-xss-unit.js/list-controls-unit.js/copy-clipboard-unit.js.
 * Its three collaborators (`api.js` for `state`/`api`, `util.js` for
 * `VIEW_PARAM_KEYS`, and `ws.js` for `syncUrlFromState`/`syncControls`) are
 * either evaluated alongside it or stubbed: `ws.js` pulls in the live
 * WebSocket connection and the whole render tree, neither of which this file
 * needs to prove, so it is stubbed rather than evaluated for real.
 *
 * Reproduces each of the three behaviors Scout's review on `1f2806d` called
 * out directly against the real functions, not a paraphrase of them:
 *
 *   1. A failed INITIAL `GET` must retry as another `GET` -- never as
 *      `pushPrefsNow()`'s `PUT`, which would hand a fresh client's empty
 *      defaults to the hub the moment the connection came back.
 *   2. A successful FIRST-EVER sync must reconcile the server's saved view
 *      before its own first `PUT`, so that `PUT` uploads what was just
 *      reconciled rather than the fresh client's own default scope/sort.
 *   3. A local edit (pin, rename, or view change) that lands WHILE a pull is
 *      in flight must survive that pull's resolution, rather than being
 *      overwritten by the stale snapshot the pull started reading before the
 *      edit happened.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripModuleSyntax } = require('./helpers/web-source');

let pass = 0; let fail = 0;
function check(name, fn) {
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}
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

const WEB_ROOT = path.join(__dirname, '..', 'web');
const apiSrc = stripModuleSyntax(fs.readFileSync(path.join(WEB_ROOT, 'js', 'api.js'), 'utf8'));
const utilSrc = stripModuleSyntax(fs.readFileSync(path.join(WEB_ROOT, 'js', 'util.js'), 'utf8'));
const prefsSyncSrc = stripModuleSyntax(fs.readFileSync(path.join(WEB_ROOT, 'js', 'prefs-sync.js'), 'utf8'));

/** A fake, synchronous, in-memory `localStorage`. */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/**
 * A fresh module instance per test -- `state` is a module-level singleton, so
 * reusing one across tests would leak pins/names/timers between them. `ws.js`
 * is stubbed rather than evaluated for real: this file's job is the prefs
 * logic, not the live socket or the render tree `syncControls`/`render`
 * actually touch.
 */
function loadModule({ storage = fakeStorage(), fetchImpl, search = '' } = {}) {
  const mod = { exports: {} };
  const fn = new Function('module', 'exports', 'localStorage', 'fetch', 'location', `
    function render() {}
    function syncUrlFromState() {}
    function syncControls() {}
    ${apiSrc}
    ${utilSrc}
    ${prefsSyncSrc}
    module.exports = {
      state, loadPrefs, pushPrefs, toggleFavorite, renameSession, FAVORITES_KEY, saveFavorites, saveNames, loadNames,
    };
  `);
  fn(mod, mod.exports, storage, fetchImpl, { search });
  return mod.exports;
}

/** A controllable fake `fetch`: each call shifts the next queued response, or
 * calls the next queued handler function for tests that need to inspect the
 * request or hold it open. */
function queueFetch(queue) {
  const calls = [];
  const impl = (requestPath, opts = {}) => {
    calls.push({ path: requestPath, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const next = queue.shift();
    if (!next) return Promise.reject(new Error('no more fake responses queued'));
    if (typeof next === 'function') return next();
    if (next.networkError) return Promise.reject(new Error('network error'));
    return Promise.resolve({ ok: next.ok !== false, status: next.status || 200, json: async () => next.body });
  };
  impl.calls = calls;
  return impl;
}

/** Captured rather than actually scheduled: lets a test fire a retry on
 * demand instead of waiting out the real 15-second timer. `flush` drains
 * whatever real microtasks/macrotasks a fire-and-forget retry callback
 * kicked off (`schedulePullRetry`'s own timer body calls `loadPrefs()`
 * without awaiting it), using the REAL timer queue this helper has not
 * patched. */
function withFakeTimers(fn) {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const scheduled = [];
  global.setTimeout = (cb) => { scheduled.push(cb); return scheduled.length; };
  global.clearTimeout = () => {};
  const flush = () => new Promise((resolve) => { realSetTimeout(resolve, 0); });
  return Promise.resolve(fn(scheduled, flush)).finally(() => {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  });
}

// ---------------------------------------------------------------------------
// 1. A failed initial pull retries as a pull, never as a destructive push
// ---------------------------------------------------------------------------

(async () => {
await checkAsync('a failed initial GET schedules another GET, not a PUT of fresh-client defaults', async () => {
  await withFakeTimers(async (scheduled, flush) => {
    const fetchImpl = queueFetch([{ networkError: true }]);
    const { loadPrefs } = loadModule({ fetchImpl });
    await loadPrefs();
    assert.strictEqual(fetchImpl.calls.length, 1, 'the failed GET itself');
    assert.strictEqual(fetchImpl.calls[0].method, 'GET');
    assert.strictEqual(scheduled.length, 1, 'a retry must have been scheduled');
    // The retry fires: it must be loadPrefs() (another GET) by itself, with no
    // PUT anywhere in between -- that PUT is exactly the destructive retry PR
    // #236's review caught (a fresh client's empty defaults overwriting
    // whatever the hub already had saved).
    scheduled[0]();
    await flush();
    assert.strictEqual(fetchImpl.calls.length, 2, 'the retry must have fired exactly one more call');
    assert.strictEqual(fetchImpl.calls[1].method, 'GET', 'the retry must be a pull, never a PUT');
  });
});

await checkAsync('once the retried pull succeeds, the server pins are adopted, not erased', async () => {
  await withFakeTimers(async (scheduled, flush) => {
    const fetchImpl = queueFetch([
      { networkError: true },
      { body: { pins: ['dev-a:s1'], names: {}, view: null } },
    ]);
    const storage = fakeStorage();
    storage.setItem('squad-hub-prefs-migrated', '1');
    const { loadPrefs, state } = loadModule({ fetchImpl, storage });
    await loadPrefs(); // fails, schedules a retry
    assert.strictEqual(scheduled.length, 1);
    scheduled[0](); // the retry: a second GET, not a PUT
    await flush();
    assert.strictEqual(fetchImpl.calls[1].method, 'GET',
      'the retry must be a pull -- a PUT here would be the fresh client overwriting the server');
    assert.deepStrictEqual([...state.favorites], ['dev-a:s1'],
      'the retried pull must still adopt what the server actually had');
  });
});

// ---------------------------------------------------------------------------
// 2. A first-ever migration reconciles the server's saved view before its
//    own first PUT -- so that PUT does not overwrite it with fresh defaults
// ---------------------------------------------------------------------------

await checkAsync('first sync ever applies the server\u2019s saved view, and its own PUT uploads that view back, not the client default', async () => {
  const fetchImpl = queueFetch([
    { body: { pins: [], names: {}, view: { scope: 'cloud', groupBy: 'repo', sortBy: 'recent', filters: {} } } },
    { body: { ok: true } }, // the migration's own first PUT
  ]);
  const { loadPrefs, state } = loadModule({ fetchImpl }); // migrated key absent: first sync ever
  await loadPrefs();
  assert.strictEqual(state.scope, 'cloud', 'the saved server scope must be adopted on first sync');
  assert.strictEqual(state.groupBy, 'repo', 'the saved server grouping must be adopted on first sync');
  assert.strictEqual(fetchImpl.calls.length, 2, 'the migration pulls once, then pushes once');
  assert.strictEqual(fetchImpl.calls[1].method, 'PUT');
  assert.strictEqual(fetchImpl.calls[1].body.view.scope, 'cloud',
    'the first-ever PUT must upload the just-reconciled server view, not a fresh client\u2019s default scope');
  assert.strictEqual(fetchImpl.calls[1].body.view.groupBy, 'repo',
    'the first-ever PUT must upload the just-reconciled server view, not a fresh client\u2019s default grouping');
});

await checkAsync('the URL still wins over the server\u2019s saved view, even on first sync', async () => {
  const fetchImpl = queueFetch([
    { body: { pins: [], names: {}, view: { scope: 'cloud', groupBy: 'repo' } } },
    { body: { ok: true } },
  ]);
  const { loadPrefs, state } = loadModule({ fetchImpl, search: '?scope=mine' });
  await loadPrefs();
  assert.strictEqual(state.scope, 'all', 'a URL-carried view must not be overridden by the server\u2019s saved one');
});

// ---------------------------------------------------------------------------
// 3. A local edit racing an in-flight pull is never lost to that pull's own,
//    now-stale, resolution
// ---------------------------------------------------------------------------

await checkAsync('a pin added while the pull is still in flight survives that pull\u2019s resolution', async () => {
  let resolveGet;
  const getPromise = new Promise((resolve) => { resolveGet = resolve; });
  const fetchImpl = queueFetch([
    () => getPromise,
    { body: { ok: true } }, // the race-triggered PUT from toggleFavorite
  ]);
  const storage = fakeStorage();
  storage.setItem('squad-hub-prefs-migrated', '1');
  const { loadPrefs, toggleFavorite, state } = loadModule({ fetchImpl, storage });

  const pulling = loadPrefs(); // starts the GET, which does not resolve yet
  await Promise.resolve(); await Promise.resolve(); // let it reach `await api(...)`

  toggleFavorite('dev-b:new-pin'); // the race: a local edit while the pull is in flight

  resolveGet({ ok: true, status: 200, json: async () => ({ pins: [], names: {}, view: null }) });
  await pulling;

  assert.ok(state.favorites.has('dev-b:new-pin'),
    'a pin added mid-pull must not be erased by that pull\u2019s own, now-stale, server snapshot');
});

await checkAsync('with no race, a normal pull still adopts the server\u2019s pins as usual', async () => {
  const fetchImpl = queueFetch([{ body: { pins: ['dev-a:s1'], names: {}, view: null } }]);
  const storage = fakeStorage();
  storage.setItem('squad-hub-prefs-migrated', '1');
  const { loadPrefs, state } = loadModule({ fetchImpl, storage });
  await loadPrefs();
  assert.deepStrictEqual([...state.favorites], ['dev-a:s1']);
});

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 100);
})();
