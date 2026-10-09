import { state, api } from './api.js';
import { viewStateToParams, paramsToViewState } from './list.js';
import { render } from './devices.js';
import { renderTranscript } from './transcript.js';
import { $ } from './util.js';
import { showSignIn } from './signin.js';

// ---------------------------------------------------------------------------
// Live connection
// ---------------------------------------------------------------------------
/**
 * Keep the live view connected.
 *
 * Three things this has to get right, all of them learned the hard way:
 *
 *   BACK OFF. A fixed retry made the indicator flash connecting/down every two
 *   seconds for as long as the hub was away, which reads as a broken app rather
 *   than an absent server -- and hammers the server as it is trying to restart.
 *
 *   DO NOT RETRY A REFUSAL. If the credential is no longer accepted, trying
 *   again with the same credential never works. Go back to sign-in instead of
 *   looping forever behind a flashing badge.
 *
 *   SAY WHICH IT IS. "Reconnecting" and "the hub is not reachable" are different
 *   situations and a person can act on the second one.
 */
export function connect() {
  // Cancel anything already pending, so a stray timer cannot start a second
  // socket alongside this one.
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.ws) { try { state.ws.onclose = null; state.ws.close(); } catch { /* already gone */ } }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?role=watcher&access_token=${encodeURIComponent(state.token)}`;
  const ws = new WebSocket(url);
  state.ws = ws;
  setConn(state.reconnectAttempt ? 'retrying' : 'connecting');

  ws.onopen = () => {
    state.reconnectAttempt = 0;
    setConn('live');
  };

  ws.onclose = async (ev) => {
    if (state.ws !== ws) return;   // superseded; not ours to react to

    // 1008 is a policy refusal: the hub understood us and said no. Confirm with
    // a cheap request rather than guessing, because an expired token and an
    // unreachable hub look identical from a closed socket.
    if (ev && ev.code === 1008) {
      try {
        await api('/api/me');
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          localStorage.removeItem('squad-hub-token');
          return showSignIn();
        }
      }
    }

    state.reconnectAttempt = (state.reconnectAttempt || 0) + 1;
    // 1s, 2s, 4s, 8s, capped at 30s. Quick enough that a restart is barely
    // noticed, slow enough that a long outage is not a strobe light.
    const wait = Math.min(1000 * (2 ** (state.reconnectAttempt - 1)), 30000);
    setConn(state.reconnectAttempt > 2 ? 'offline' : 'retrying');
    state.reconnectTimer = setTimeout(connect, wait);
    return undefined;
  };

  // onerror always precedes onclose, so leave the state change to onclose --
  // otherwise the badge changes twice for one event.
  ws.onerror = () => {};

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'overview') {
      state.overview = { devices: msg.devices, groups: msg.groups, counts: msg.counts, hubVersion: msg.hubVersion };
      render();
    } else if (msg.type === 'transcript' && state.currentSession
      && msg.sessionId === state.currentSession.session.id) {
      renderTranscript(msg.entries || []);
    }
  };
}

/**
 * Show the signed-in person's avatar, or their initial.
 *
 * The initial is the FALLBACK, not a placeholder to be replaced later: if the
 * image fails -- blocked, offline, a provider with no avatar -- the initial
 * stays. A broken-image icon in the account menu would look like a bug.
 */
export function setAvatar(url, name) {
  const el = $('avatar');
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  el.textContent = initial;
  el.style.backgroundImage = '';
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    el.textContent = '';
    el.style.backgroundImage = `url("${url}")`;
  };
  // No onerror handler needed beyond doing nothing: the initial is already there.
  img.src = url;
}

const CONN_LABEL = {
  live: 'live',
  connecting: 'connecting',
  retrying: 'reconnecting',
  offline: 'hub unreachable',
};

/**
 * What each state means, in a sentence.
 *
 * The live dot has no text, so without this it would be a colored mark with
 * no explanation anywhere -- and the failures deserve to say that the DEVICES
 * are fine even when this page cannot hear them, because the obvious fear on
 * seeing a red badge is that the work has stopped.
 */
const CONN_TITLE = {
  live: 'Live: this page is receiving updates as they happen',
  connecting: 'Connecting to the live feed',
  retrying: 'The live feed dropped and is reconnecting. Your sessions keep running.',
  offline: 'The hub is not answering. This page keeps retrying; your devices are unaffected.',
};

export function setConn(s) {
  const el = $('conn');
  el.dataset.state = s;
  // A DOT when the feed is healthy, WORDS when it is not.
  //
  // "live" is true almost all of the time, so spelling it out is a permanent
  // label saying "working" -- and a label that is always there is one nobody
  // reads on the day it changes. As a dot it costs nothing and still answers
  // the question a person actually asks after ten quiet minutes: is this page
  // still being told things, or has it been showing me a corpse?
  //
  // The failures keep their words, because "reconnecting" and "hub
  // unreachable" are different situations that need different reactions, and
  // a colored dot cannot say which is which.
  el.textContent = s === 'live' ? '' : (CONN_LABEL[s] || s);
  el.title = CONN_TITLE[s] || '';
  el.setAttribute('aria-label', `Live feed: ${CONN_LABEL[s] || s}`);
}

/**
 * A session named in the URL, from a Teams card's "View live session" link,
 * or from the address bar of the detail page itself (#181).
 *
 * Unlike the token above, this is read WITHOUT being removed: the detail
 * page is a real URL now, so leaving it there is what makes a reload or a
 * shared link reopen the same session. The caller normalizes it once the key
 * is resolved (see `openDetail`'s `replace` navigation).
 */
export function takeDeepLinkSession() {
  const params = new URLSearchParams(location.search);
  return params.get('session');
}

/**
 * Which manifest `shortcut` launched this load, if any -- "New session",
 * "Needs you" or "Start ACA job" (see web/app.webmanifest). Read once and
 * stripped from the URL for the same reason the session deep link is: a
 * reload or a bookmark must not keep replaying the shortcut that opened it.
 */
export function takeShortcut() {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('shortcut');
  if (!wanted) return null;
  params.delete('shortcut');
  const rest = params.toString();
  history.replaceState({}, '', rest ? `${location.pathname}?${rest}` : location.pathname);
  return wanted;
}

/**
 * Resolve what a deep link asked for.
 *
 * Matches the hub's `deviceId:sessionId` key first. A bare session id is
 * accepted as a fallback -- cards posted before the key was included are
 * sitting in people's channels and should keep working -- but ONLY when
 * exactly one device has a session by that name. A session id is unique within
 * a device, not across them, so guessing between two would sometimes open
 * somebody else's session on another machine.
 */
export function resolveDeepLink(wanted, groups) {
  if (!wanted) return { status: 'none' };
  for (const g of groups) {
    for (const s of g.sessions || []) if (s.key === wanted) return { status: 'found', key: s.key };
  }
  const byId = [];
  for (const g of groups) {
    for (const s of g.sessions || []) if (s.id === wanted) byId.push(s.key);
  }
  if (byId.length === 1) return { status: 'found', key: byId[0] };
  if (byId.length > 1) return { status: 'ambiguous', count: byId.length };
  return { status: 'missing' };
}


/**
 * The hub could not be reached at all.
 *
 * Says the true thing and the reassuring thing, in that order. The reassurance
 * is not padding: the natural fear on seeing a dashboard fail is that the work
 * it was watching has failed too, and here that is precisely wrong -- sessions
 * run on the devices, and the hub only watches them. An agent waiting for an
 * approval is still waiting, and will still be waiting when the network comes
 * back.
 *
 * Recovers by itself. Someone who walks back into signal should not have to
 * work out that they need to reload.
 */
export function showOffline() {
  const main = document.querySelector('main.page');
  const target = main || document.body;
  target.innerHTML = `
    <div class="empty">
      <h3>Can't reach the hub</h3>
      <p>You're still signed in — this device just can't get to the hub right now.</p>
      <p><strong>Your sessions are unaffected.</strong> They run on your devices, not here.
         Anything waiting on an approval is still waiting.</p>
      <p class="empty-actions"><button class="primary" id="offlineRetry">Try again</button></p>
    </div>`;
  const retry = document.getElementById('offlineRetry');
  if (retry) retry.onclick = () => location.reload();
  // Reload the moment connectivity returns, so this state cannot outlive the
  // problem it describes.
  window.addEventListener('online', () => location.reload(), { once: true });
  return undefined;
}


/**
 * Register the service worker, which supplies the offline shell.
 *
 * Deliberately quiet about failure. A worker needs a secure context, so it
 * simply does not exist on a hub reached over plain http on a LAN -- and that
 * is a perfectly normal way to run this. An error in the console there would
 * be noise about a feature the deployment never asked for.
 *
 * It caches the SHELL only; nothing under /api/ is ever stored. See web/sw.js.
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Registration is fire-and-forget on purpose: the app must not wait on it,
  // and must work identically whether or not it succeeds.
  navigator.serviceWorker.register('/sw.js').catch(() => { /* insecure context, or blocked */ });
}

export async function refresh() {
  const params = new URLSearchParams();
  if (state.filters.q) params.set('q', state.filters.q);
  // "Action needed" (#169) aggregates two session statuses the store cannot
  // match with one equality check (needs approval OR awaiting reply), so it
  // is applied client-side in `matchesFilters`/`isActionNeeded` instead --
  // sending it as `status=action` would ask the store for a status no
  // session ever literally has, and get an empty list back every time.
  if (state.filters.status && state.filters.status !== 'action') params.set('status', state.filters.status);
  if (state.filters.device) params.set('device', state.filters.device);
  state.overview = await api(`/api/overview?${params}`);
  render();
}

const VIEW_KEY = 'squad-hub-view';
const FAVORITES_KEY = 'squad-hub-favorites';

/** The view, as the shape both the URL and localStorage agree on (#168). */
function currentViewParams() {
  return viewStateToParams({
    scope: state.scope, filters: state.filters, groupBy: state.groupBy, sortBy: state.sortBy,
  });
}

/** Every key `viewStateToParams` can ever produce, for a clean rewrite. */
const VIEW_PARAM_KEYS = ['scope', 'q', 'status', 'device', 'repo', 'org', 'window', 'view', 'sort'];

/**
 * Keep the address bar in step with the view (#168): scope, every filter,
 * the grouping and the sort all become query-string keys, so reloading the
 * page -- or sending the link to someone else -- lands on the same view,
 * not the default one.
 *
 * `replaceState`, never `pushState`: choosing a dropdown is not a navigation,
 * and a Back-button entry for every keystroke in the keyword box would make
 * Back useless for its actual job of leaving the page.
 *
 * Any OTHER query-string key already on the URL (a `token` or `session` deep
 * link not yet claimed) is left exactly alone -- this only ever touches the
 * keys it is itself responsible for.
 */
export function syncUrlFromState() {
  try {
    const params = new URLSearchParams(location.search);
    for (const k of VIEW_PARAM_KEYS) params.delete(k);
    for (const [k, v] of Object.entries(currentViewParams())) params.set(k, v);
    const qs = params.toString();
    history.replaceState({}, '', qs ? `${location.pathname}?${qs}` : location.pathname);
  } catch { /* a view that cannot reach the address bar still works on screen */ }
}

/**
 * List controls, scope and pins survive a reload (#165, extended by #168).
 *
 * The URL wins when it carries any view state at all -- that is what makes a
 * link shareable: a teammate opening `?scope=cloud&status=action` must see
 * cloud sessions needing attention, not their OWN last-saved view overriding
 * the one the link asked for. localStorage is the FALLBACK, for the case the
 * URL came with nothing: a bookmark of the bare hub, or the first visit after
 * a view was last saved.
 *
 * Kept per-browser rather than on the hub deliberately: this is how ONE
 * person likes to look at the list, not a property of the sessions. Syncing it
 * would mean a preference set on a laptop silently rearranging a phone.
 */
export function loadView() {
  try {
    const fromUrl = paramsToViewState(Object.fromEntries(new URLSearchParams(location.search)));
    const view = Object.keys(fromUrl).length
      ? fromUrl
      : paramsToViewState(JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'));
    if (view.scope) state.scope = view.scope;
    if (view.filters) Object.assign(state.filters, view.filters);
    if (view.groupBy) state.groupBy = view.groupBy;
    if (view.sortBy) state.sortBy = view.sortBy;
  } catch { /* a corrupt preference or URL is not worth a broken page */ }
  try {
    const favs = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    if (Array.isArray(favs)) state.favorites = new Set(favs.filter((k) => typeof k === 'string'));
  } catch { /* same */ }
  loadNames();
  try { state.railCollapsed = localStorage.getItem(RAIL_KEY) === '1'; } catch { /* same */ }
  state.theme = loadTheme();
  // Whatever was just restored -- from the URL or from localStorage -- is
  // written straight back to the address bar, so the two can never disagree
  // about what is currently on screen.
  syncUrlFromState();
}

export function saveView() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(currentViewParams())); }
  catch { /* private browsing, quota, whatever -- never fatal */ }
  syncUrlFromState();
  pushPrefs();
}

function saveFavorites() {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites])); }
  catch { /* never fatal */ }
}

// ---------------------------------------------------------------------------
// Prefs sync (#170): pins, names and the saved view, through `/api/prefs`
// (#166), so a pin set on one device is there on another. localStorage is
// still written first on every change; the server syncs on top, best-effort
// and retried, never a blocking round trip a click waits on.
// ---------------------------------------------------------------------------

const NAMES_KEY = 'squad-hub-names';
// Set once this browser has synced successfully -- before that, an empty
// `GET` means "never synced", not "clear what is local".
const PREFS_MIGRATED_KEY = 'squad-hub-prefs-migrated';

function saveNames() {
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(state.names)); }
  catch { /* never fatal */ }
}

function loadNames() {
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

function pushPrefs() { pushPrefsNow(); } // best-effort, never awaited

/** Pull pins, names and the saved view from the hub (#170) and fold them in.
 * Offline-tolerant: a failed `GET` leaves `state` as `loadView()` set it. */
export async function loadPrefs() {
  let server;
  try {
    server = await api('/api/prefs');
  } catch {
    scheduleRetry();
    return;
  }
  const migrated = localStorage.getItem(PREFS_MIGRATED_KEY) === '1';
  // The URL still wins (#168): a shared link's `?scope=...` must show what
  // the link asked for.
  const urlHasView = VIEW_PARAM_KEYS.some((k) => new URLSearchParams(location.search).has(k));
  if (!migrated) {
    // First sync ever: union, favoring neither side, so a browser pinning
    // before #170 shipped does not lose anything on its first sync.
    const pins = [...new Set([...(server.pins || []), ...state.favorites])];
    const names = { ...state.names, ...(server.names || {}) };
    state.favorites = new Set(pins);
    state.names = names;
    saveFavorites();
    saveNames();
    try { localStorage.setItem(PREFS_MIGRATED_KEY, '1'); } catch { /* never fatal */ }
    pushPrefs();
  } else {
    state.favorites = new Set(server.pins || []);
    state.names = { ...(server.names || {}) };
    saveFavorites();
    saveNames();
    if (!urlHasView && server.view) {
      const view = server.view;
      if (view.scope) state.scope = view.scope;
      if (view.filters) Object.assign(state.filters, view.filters);
      if (view.groupBy) state.groupBy = view.groupBy;
      if (view.sortBy) state.sortBy = view.sortBy;
      syncUrlFromState();
      syncControls();
    }
  }
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

/** Fill the controls from the restored state, so the UI matches what it does. */
export function syncControls() {
  const set = (id, value) => { const el = $(id); if (el) el.value = value; };
  set('q', state.filters.q);
  set('statusFilter', state.filters.status);
  set('deviceFilter', state.filters.device);
  set('windowFilter', state.filters.window);
  set('groupBy', state.groupBy);
  set('sortBy', state.sortBy);
  setRailCollapsed(state.railCollapsed);
  applyTheme(state.theme);
}

const THEME_KEY = 'squad-hub-theme';

/**
 * Theme, in three states rather than two.
 *
 * `system` is a real setting, not the absence of one: it means "keep following
 * this machine", and it is what someone gets before they have said anything.
 * Collapsing it into a boolean would freeze whatever the system happened to be
 * on first load, so a laptop that switches at sunset would stop switching.
 */
const THEMES = ['system', 'dark', 'light'];

/**
 * The three theme icons, as Fluent SVG (Microsoft, MIT).
 *
 * `system` gets the half-filled circle it always had, because "follow this
 * machine" is genuinely neither sun nor moon; the other two say plainly which
 * one is in force.
 */
const THEME_ICON = {
  system: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1C11.866 1 15 4.13401 15 8C15 11.866 11.866 15 8 15C4.13401 15 1 11.866 1 8C1 4.13401 4.13401 1 8 1ZM8 2V14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2Z"/></svg>',
  dark: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8.00291 1C11.8684 1.00057 15.002 4.13436 15.002 8C15.002 11.866 11.8679 15 8.00193 15C5.08888 14.9999 2.59229 13.2205 1.53805 10.6914C1.4578 10.4987 1.50656 10.2763 1.65914 10.1338C1.75673 10.0427 1.88381 9.99611 2.01168 9.99902C5.32091 9.99375 8.00193 7.31045 8.00193 4C8.00193 3.18152 7.83715 2.40245 7.54099 1.69238C7.47678 1.53815 7.49426 1.3617 7.58689 1.22266C7.67959 1.08361 7.83581 1.00006 8.00291 1ZM8.72166 2.04395C8.90245 2.66516 9.00194 3.32111 9.00194 4C9.00194 7.60283 6.27984 10.5678 2.78024 10.9551C3.81152 12.7735 5.7636 13.9999 8.00193 14C11.3157 14 14.002 11.3137 14.002 8C14.002 4.92991 11.696 2.39958 8.72166 2.04395Z"/></svg>',
  light: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1C8.27614 1 8.5 1.22386 8.5 1.5V2.5C8.5 2.77614 8.27614 3 8 3C7.72386 3 7.5 2.77614 7.5 2.5V1.5C7.5 1.22386 7.72386 1 8 1ZM8 11C9.65685 11 11 9.65685 11 8C11 6.34315 9.65685 5 8 5C6.34315 5 5 6.34315 5 8C5 9.65685 6.34315 11 8 11ZM8 10C6.89543 10 6 9.10457 6 8C6 6.89543 6.89543 6 8 6C9.10457 6 10 6.89543 10 8C10 9.10457 9.10457 10 8 10ZM14.5 8.5C14.7761 8.5 15 8.27614 15 8C15 7.72386 14.7761 7.5 14.5 7.5H13.5C13.2239 7.5 13 7.72386 13 8C13 8.27614 13.2239 8.5 13.5 8.5H14.5ZM8 13C8.27614 13 8.5 13.2239 8.5 13.5V14.5C8.5 14.7761 8.27614 15 8 15C7.72386 15 7.5 14.7761 7.5 14.5V13.5C7.5 13.2239 7.72386 13 8 13ZM2.5 8.5C2.77614 8.5 3 8.27614 3 8C3 7.72386 2.77614 7.5 2.5 7.5H1.5C1.22386 7.5 1 7.72386 1 8C1 8.27614 1.22386 8.5 1.5 8.5H2.5ZM3.14645 3.14649C3.34171 2.95123 3.65829 2.95123 3.85355 3.14649L4.85355 4.14649C5.04882 4.34175 5.04882 4.65834 4.85355 4.8536C4.65829 5.04886 4.34171 5.04886 4.14645 4.8536L3.14645 3.8536C2.95118 3.65834 2.95118 3.34175 3.14645 3.14649ZM3.85355 12.8536C3.65829 13.0489 3.34171 13.0489 3.14645 12.8536C2.95118 12.6584 2.95118 12.3418 3.14645 12.1465L4.14645 11.1465C4.34171 10.9513 4.65829 10.9513 4.85355 11.1465C5.04882 11.3418 5.04882 11.6584 4.85355 11.8536L3.85355 12.8536ZM12.8536 3.14649C12.6583 2.95123 12.3417 2.95123 12.1464 3.14649L11.1464 4.14649C10.9512 4.34175 10.9512 4.65834 11.1464 4.8536C11.3417 5.04886 11.6583 5.04886 11.8536 4.8536L12.8536 3.8536C13.0488 3.65834 13.0488 3.34175 12.8536 3.14649ZM12.1464 12.8536C12.3417 13.0489 12.6583 13.0489 12.8536 12.8536C13.0488 12.6584 13.0488 12.3418 12.8536 12.1465L11.8536 11.1465C11.6583 10.9513 11.3417 10.9513 11.1464 11.1465C10.9512 11.3418 10.9512 11.6584 11.1464 11.8536L12.1464 12.8536Z"/></svg>',
};

function loadTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return THEMES.includes(saved) ? saved : 'system';
  } catch { return 'system'; }
}

export function applyTheme(theme) {
  state.theme = THEMES.includes(theme) ? theme : 'system';
  // The attribute is REMOVED for `system`, not set to it. The stylesheet keys
  // its prefers-color-scheme block on `:root:not([data-theme])`, so an
  // attribute of any value would override the system choice it exists to
  // follow.
  if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', state.theme);

  const btn = $('themeBtn');
  if (btn) {
    const label = { system: 'Theme: follow system', dark: 'Theme: dark', light: 'Theme: light' }[state.theme];
    btn.title = `${label} (click to change)`;
    btn.setAttribute('aria-label', label);
    // SVG, not emoji. An emoji glyph is drawn by whatever font the platform
    // picks -- often in color, at its own weight, and differently on every
    // machine -- so the one control next to the account menu never matched the
    // icons around it. These are the same Fluent set as everywhere else and
    // inherit `currentColor`.
    btn.innerHTML = THEME_ICON[state.theme] || THEME_ICON.system;
  }
  try { localStorage.setItem(THEME_KEY, state.theme); } catch { /* never fatal */ }
}

/** system -> dark -> light -> system. */
export function nextTheme(theme) {
  const i = THEMES.indexOf(theme);
  return THEMES[(i === -1 ? 0 : i + 1) % THEMES.length];
}



const RAIL_KEY = 'squad-hub-rail-collapsed';

export function setRailCollapsed(collapsed) {
  state.railCollapsed = !!collapsed;
  const rail = $('deviceRail');
  const toggle = $('railToggle');
  if (rail) rail.classList.toggle('collapsed', state.railCollapsed);
  if (toggle) {
    toggle.setAttribute('aria-expanded', state.railCollapsed ? 'false' : 'true');
    toggle.title = state.railCollapsed ? 'Show the device list' : 'Collapse the device list';
  }
  try { localStorage.setItem(RAIL_KEY, state.railCollapsed ? '1' : '0'); } catch { /* never fatal */ }
}

