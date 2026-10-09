// Prefs sync (#170): pins, names and the saved view, through `/api/prefs`
// (#166), so a pin set on one device is there on another. localStorage is
// still written first on every change; the server syncs on top, best-effort
// and retried, never a blocking round trip a click waits on.
//
// Split out of `ws.js` to keep that file under the size budget
// `test/package-unit.js` holds every web/js module to (the #200 single-file-
// regression guard) -- the same reason `sessionrow.js`/`rowmenu.js` exist.
// `syncUrlFromState`/`syncControls` are imported back from `ws.js`: both are
// function DECLARATIONS there (hoisted, not `const` arrow functions), so this
// is a safe circular import -- by the time anything here actually calls
// either one, `ws.js`'s module body has long since finished running.

import { state, api } from './api.js';
import { render } from './devices.js';
import { VIEW_PARAM_KEYS } from './util.js';
import { syncUrlFromState, syncControls } from './ws.js';

export const FAVORITES_KEY = 'squad-hub-favorites';
const NAMES_KEY = 'squad-hub-names';
// Set once this browser has synced successfully -- before that, an empty
// `GET` means "never synced", not "clear what is local".
const PREFS_MIGRATED_KEY = 'squad-hub-prefs-migrated';

export function saveFavorites() {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites])); }
  catch { /* never fatal */ }
}

export function saveNames() {
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(state.names)); }
  catch { /* never fatal */ }
}

export function loadNames() {
  try {
    const parsed = JSON.parse(localStorage.getItem(NAMES_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
      state.names = out;
    }
  } catch { /* a corrupt cache is not worth a broken page */ }
}

/**
 * Hydration gate (Scout's re-review of 1313f74): true once `loadPrefs()`'s
 * `GET` has succeeded at least once THIS page load. Before that, this
 * client's cache is only ever ITS OWN localStorage -- it has no idea what
 * other devices have saved -- so a whole-record `PUT` sent before hydration
 * would ship an incomplete record that erases unrelated server pins, names,
 * or the saved view. Edits before hydration still land instantly in `state`
 * and localStorage (the optimistic UI nothing here may ever block on), they
 * just do not reach the network until `loadPrefs()` has something real to
 * merge them onto.
 */
let hydrated = false;
/** Keys explicitly UNfavorited before hydration. A plain union of "server
 * pins" with "whatever this client has now" can only ever ADD a pin back; it
 * has no way to represent "I removed this", so a pin removed during the gate
 * would otherwise be resurrected by the server's older copy the moment
 * hydration's merge ran. Cleared the instant hydration consumes it; re-added
 * before then simply removes its own tombstone (see `toggleFavorite`). */
let pendingPinRemovals = new Set();
/** Same tombstone, for a name explicitly cleared (renamed to blank) before
 * hydration -- an object spread has the identical blind spot a Set union
 * does: it can overwrite a key, never delete one the client no longer has. */
let pendingNameClears = new Set();
/** A view change (scope/filters/groupBy/sortBy) landed before hydration. That
 * edit is newer than whatever the server has saved, so hydration must keep
 * it rather than overwrite it with the server's (older) saved view -- the
 * same "a newer local edit beats a stale read" rule the old
 * `localEditDuringPull` flag was trying (too bluntly) to express. */
let pendingViewChanged = false;

/** A plain-timer retry, not one retry per failed call -- an hour offline
 * should not mean an hour of back-to-back retries once reconnected. */
let prefsRetryTimer = null;
let prefsDirty = false;

/** PUT, not PATCH (prefs-store.js): every push is the whole record. `view`
 * is `{scope, filters, groupBy, sortBy}`, not `currentViewParams()`'s shape.
 * Always reads LIVE `state`, never a snapshot captured earlier -- that is
 * what makes the write queue below safe to coalesce: the "next" write after
 * one in flight is never stale, because it rereads whatever is true right
 * now, including every edit that landed while the previous write was out. */
function currentPrefs() {
  return {
    pins: [...state.favorites],
    names: { ...state.names },
    view: {
      scope: state.scope, filters: state.filters, groupBy: state.groupBy, sortBy: state.sortBy,
    },
  };
}

/**
 * Serialized, coalescing write queue (Scout's re-review of 1313f74,
 * "remaining prefs outbox ordering"): at most ONE `PUT` is ever in flight.
 * A second `queuePush()` call while one is already out never starts a
 * competing request -- it only raises `writePending`, so the in-flight
 * write's own completion starts exactly one more write, carrying whatever is
 * true in `state` at THAT moment. This removes all three remaining data-loss
 * schedules at once, structurally rather than by tracking a revision number:
 *   - two edits can never produce two concurrent PUTs, so one can never land
 *     at the server out of order behind the other;
 *   - a write's own success/failure only ever reports on itself -- there is
 *     no SECOND in-flight write whose dirty flag it could wrongly clear;
 *   - any edit that lands while a write is out is never silently dropped:
 *     it is picked up by the very next write this queue sends, whether that
 *     next write is the immediate coalesced follow-up on success, the
 *     immediate coalesced follow-up after a failure (see `pushPrefsNow`), or
 *     the 15-second retry timer if nothing re-triggered it sooner.
 */
let writeInFlight = false;
let writePending = false;

function queuePush() {
  if (writeInFlight) { writePending = true; return; }
  writeInFlight = true;
  pushPrefsNow();
}

async function pushPrefsNow() {
  try {
    await api('/api/prefs', { method: 'PUT', body: currentPrefs() });
    prefsDirty = false;
    if (prefsRetryTimer) { clearTimeout(prefsRetryTimer); prefsRetryTimer = null; }
  } catch {
    writeInFlight = false;
    scheduleRetry(); // offline or rejected: retried once a reconnect is plausible
    if (writePending) { writePending = false; queuePush(); } // don't wait out the timer if there is already more to send
    return;
  }
  writeInFlight = false;
  if (writePending) { writePending = false; queuePush(); } // coalesced: sends whatever is live NOW, not a stale snapshot
}

function scheduleRetry() {
  prefsDirty = true;
  if (prefsRetryTimer) return;
  prefsRetryTimer = setTimeout(() => {
    prefsRetryTimer = null;
    if (prefsDirty) queuePush();
  }, 15000);
}

/**
 * Called on every pin, rename or view edit. Before hydration, this only
 * records that SOMETHING is dirty (the tombstones/flag above record WHAT) --
 * the actual network write waits for `loadPrefs()` to have a real base to
 * merge onto. After hydration, every edit goes straight into the write
 * queue, same as always.
 */
export function pushPrefs(kind) {
  if (!hydrated) {
    if (kind === 'view') pendingViewChanged = true;
    prefsDirty = true;
    return;
  }
  queuePush();
}

/**
 * A failed pull is retried as another pull -- NEVER as `pushPrefsNow()`'s
 * `PUT` (PR #236 review finding 1). `scheduleRetry()`/`pushPrefsNow()` above
 * exist to retry a failed local EDIT; reusing them for a failed initial read
 * would, on a fresh client, PUT that fresh client's empty defaults to the
 * hub the moment the connection came back -- erasing whatever pins, names or
 * view were already saved there. A pull that fails has nothing new to write;
 * it only has something it still needs to read.
 */
let prefsPullRetryTimer = null;
function schedulePullRetry() {
  if (prefsPullRetryTimer) return;
  prefsPullRetryTimer = setTimeout(() => {
    prefsPullRetryTimer = null;
    loadPrefs();
  }, 15000);
}

/** Pull pins, names and the saved view from the hub (#170) and fold them in.
 * Offline-tolerant: a failed `GET` leaves `state` as `loadView()` set it, and
 * is retried as another `GET` (never as a write -- see `schedulePullRetry`
 * above) until one succeeds.
 *
 * Every field is merged, never just replaced and never just kept: the base
 * is whatever the server actually has, with this client's own tombstones
 * (explicit removals/clears from before hydration) applied, then unioned
 * with whatever is live in `state` right now -- which already holds every
 * local add/rename/re-add, whether it happened before this call or raced it.
 * That union is also exactly what the old pre-#170 "first sync ever, nothing
 * server-side yet" migration needed, so there is only one merge rule now,
 * not a separate one for first-sync and every pull after it. */
export async function loadPrefs() {
  let server;
  try {
    server = await api('/api/prefs');
  } catch {
    schedulePullRetry();
    return;
  }
  if (prefsPullRetryTimer) { clearTimeout(prefsPullRetryTimer); prefsPullRetryTimer = null; }

  const migrated = localStorage.getItem(PREFS_MIGRATED_KEY) === '1';

  const basePins = new Set(server.pins || []);
  for (const k of pendingPinRemovals) basePins.delete(k);
  state.favorites = new Set([...basePins, ...state.favorites]);

  const baseNames = { ...(server.names || {}) };
  for (const k of pendingNameClears) delete baseNames[k];
  state.names = { ...baseNames, ...state.names };

  saveFavorites();
  saveNames();
  if (!migrated) { try { localStorage.setItem(PREFS_MIGRATED_KEY, '1'); } catch { /* never fatal */ } }

  // The URL still wins (#168): a shared link's `?scope=...` must show what
  // the link asked for. A view edit that raced this pull wins too -- it is
  // newer than the snapshot this pull just read.
  const urlHasView = VIEW_PARAM_KEYS.some((k) => new URLSearchParams(location.search).has(k));
  if (!urlHasView && server.view && !pendingViewChanged) {
    const view = server.view;
    if (view.scope) state.scope = view.scope;
    if (view.filters) Object.assign(state.filters, view.filters);
    if (view.groupBy) state.groupBy = view.groupBy;
    if (view.sortBy) state.sortBy = view.sortBy;
    syncUrlFromState();
    syncControls();
  }

  hydrated = true;
  const hadPendingEdits = pendingPinRemovals.size > 0 || pendingNameClears.size > 0
    || pendingViewChanged || prefsDirty;
  pendingPinRemovals = new Set();
  pendingNameClears = new Set();
  pendingViewChanged = false;
  // First sync ever always writes the reconciled record back (there may be
  // local-only pins/names the server has never seen); afterward, only an
  // edit that actually happened during the gate needs a push -- a plain
  // pull with nothing pending has nothing new to tell the server.
  if (!migrated || hadPendingEdits) queuePush();
  render();
}

export function toggleFavorite(key) {
  if (!key) return;
  if (state.favorites.has(key)) {
    state.favorites.delete(key);
    if (!hydrated) pendingPinRemovals.add(key);
  } else {
    state.favorites.add(key);
    if (!hydrated) pendingPinRemovals.delete(key); // re-adding cancels its own tombstone
  }
  saveFavorites();
  pushPrefs('pins');
  render();
}

/** Set, or clear, a session's display name (#170). An empty name clears it
 * -- a "rename" to nothing is "put the prompt back", not a blank name. */
export function renameSession(key, name) {
  if (!key) return;
  const trimmed = String(name == null ? '' : name).trim();
  if (trimmed) {
    state.names[key] = trimmed;
    if (!hydrated) pendingNameClears.delete(key); // re-set cancels its own tombstone
  } else {
    delete state.names[key];
    if (!hydrated) pendingNameClears.add(key);
  }
  saveNames();
  pushPrefs('names');
  render();
}
