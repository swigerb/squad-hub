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

/** A plain-timer retry, not one retry per failed call -- an hour offline
 * should not mean an hour of back-to-back retries once reconnected. */
let prefsRetryTimer = null;
let prefsDirty = false;

/** PUT, not PATCH (prefs-store.js): every push is the whole record. `view`
 * is `{scope, filters, groupBy, sortBy}`, not `currentViewParams()`'s shape. */
function currentPrefs() {
  return {
    pins: [...state.favorites],
    names: { ...state.names },
    view: {
      scope: state.scope, filters: state.filters, groupBy: state.groupBy, sortBy: state.sortBy,
    },
  };
}

async function pushPrefsNow() {
  try {
    await api('/api/prefs', { method: 'PUT', body: currentPrefs() });
    prefsDirty = false;
    if (prefsRetryTimer) { clearTimeout(prefsRetryTimer); prefsRetryTimer = null; }
  } catch {
    scheduleRetry(); // offline or rejected: retried once a reconnect is plausible
  }
}

function scheduleRetry() {
  prefsDirty = true;
  if (prefsRetryTimer) return;
  prefsRetryTimer = setTimeout(() => {
    prefsRetryTimer = null;
    if (prefsDirty) pushPrefsNow();
  }, 15000);
}

/**
 * Set only while a `loadPrefs()` `GET` is in flight (including its own
 * retries), so `pushPrefs()` can tell whether the local edit it is about to
 * send is racing a pull that started reading the server's OLDER snapshot
 * before this edit happened.
 */
let prefsPullInFlight = false;
/**
 * A pin, rename or view change landed while a pull was in flight. The pull's
 * own resolution must not then overwrite that edit with the stale snapshot it
 * started reading before the edit happened (PR #236 review finding 3: a
 * dirty GET/PUT race must not lose a local edit).
 */
let localEditDuringPull = false;

export function pushPrefs() {
  if (prefsPullInFlight) localEditDuringPull = true;
  pushPrefsNow(); // best-effort, never awaited
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
 * above) until one succeeds. */
export async function loadPrefs() {
  prefsPullInFlight = true;
  localEditDuringPull = false;
  let server;
  try {
    server = await api('/api/prefs');
  } catch {
    prefsPullInFlight = false;
    schedulePullRetry();
    return;
  }
  if (prefsPullRetryTimer) { clearTimeout(prefsPullRetryTimer); prefsPullRetryTimer = null; }
  const migrated = localStorage.getItem(PREFS_MIGRATED_KEY) === '1';
  // The URL still wins (#168): a shared link's `?scope=...` must show what
  // the link asked for. A local edit that raced this pull wins too -- it is
  // newer than the snapshot this pull just read.
  const urlHasView = VIEW_PARAM_KEYS.some((k) => new URLSearchParams(location.search).has(k));
  const applyServerView = !urlHasView && server.view && !localEditDuringPull;
  /** Reconcile the one saved view onto `state`, in whichever branch below
   * actually gets to use it. Shared so first-sync and every sync after agree
   * on the exact same rule (PR #236 review finding 2: a first migration that
   * skipped this handed its own very next `pushPrefs()` a fresh client's
   * default scope/group/sort to overwrite the server's saved view with). */
  const reconcileView = () => {
    const view = server.view;
    if (view.scope) state.scope = view.scope;
    if (view.filters) Object.assign(state.filters, view.filters);
    if (view.groupBy) state.groupBy = view.groupBy;
    if (view.sortBy) state.sortBy = view.sortBy;
    syncUrlFromState();
    syncControls();
  };
  if (!migrated) {
    // First sync ever: union, favoring neither side, so a browser pinning
    // before #170 shipped does not lose anything on its first sync. Local
    // wins a same-key name collision (`state.names` spread last) for the
    // same reason the view does above -- it is what this browser has right
    // now, which during a race is newer than what the server had when this
    // pull started reading.
    const pins = [...new Set([...(server.pins || []), ...state.favorites])];
    const names = { ...(server.names || {}), ...state.names };
    state.favorites = new Set(pins);
    state.names = names;
    saveFavorites();
    saveNames();
    try { localStorage.setItem(PREFS_MIGRATED_KEY, '1'); } catch { /* never fatal */ }
    if (applyServerView) reconcileView();
    pushPrefs();
  } else if (!localEditDuringPull) {
    state.favorites = new Set(server.pins || []);
    state.names = { ...(server.names || {}) };
    saveFavorites();
    saveNames();
    if (applyServerView) reconcileView();
  } // else: a local edit raced this pull -- keep the local, newer state.
    // `pushPrefs()`'s own call already queued it to reach the server.
  prefsPullInFlight = false;
  render();
}

export function toggleFavorite(key) {
  if (!key) return;
  if (state.favorites.has(key)) state.favorites.delete(key);
  else state.favorites.add(key);
  saveFavorites();
  pushPrefs();
  render();
}

/** Set, or clear, a session's display name (#170). An empty name clears it
 * -- a "rename" to nothing is "put the prompt back", not a blank name. */
export function renameSession(key, name) {
  if (!key) return;
  const trimmed = String(name == null ? '' : name).trim();
  if (trimmed) state.names[key] = trimmed;
  else delete state.names[key];
  saveNames();
  pushPrefs();
  render();
}
