/* Squad Hub service worker.
 *
 * WHAT IS CACHED, AND WHAT IS DELIBERATELY NOT.
 *
 *   Cached: the app shell -- the HTML, CSS, JS and icons. These are identical
 *           for every user and contain no session data, so a cache hit can
 *           never show one person another person's work.
 *
 *   NEVER cached: anything under /api/. That is the whole point of the
 *           distinction. This is a control surface for paused agents, and a
 *           stale API response is not a minor inconvenience -- it is a page
 *           that says "nothing needs you" while an agent sits blocked waiting
 *           for an answer. It is also per-user on a shared hub, so a cached
 *           response outliving a sign-out would be a disclosure.
 *
 * NETWORK FIRST, CACHE AS FALLBACK -- not the other way round.
 *
 * The classic service worker failure is shipping a fix and having users keep
 * running last month's code because a cache-first worker never asks. For a
 * dashboard that is annoying; for something that renders approval prompts it
 * is dangerous. So every shell request goes to the network first and only
 * falls back to the cache when the network genuinely cannot answer. The cache
 * exists for the aeroplane, not for the millisecond.
 *
 * The cost is a network round trip on load when online. That is the correct
 * trade for this application.
 */

'use strict';

// Bumping this discards every previous cache on activate. It only needs to
// change when the SHAPE of what is cached changes -- the network-first
// strategy already keeps content fresh on its own.
const CACHE = 'squad-hub-shell-v15';

/**
 * The shell. Everything here is a public static asset.
 *
 * `/` rather than `/index.html`: that is what `start_url` in the manifest
 * resolves to, and what a navigation request asks for.
 */
const SHELL = [
  '/',
  '/css/tokens.css',
  '/css/topbar.css',
  '/css/list.css',
  '/css/devices.css',
  '/css/modals.css',
  '/css/detail.css',
  '/css/squad.css',
  '/css/inbox.css',
  '/js/api.js',
  '/js/util.js',
  '/js/list.js',
  '/js/sessionrow.js',
  '/js/rowmenu.js',
  '/js/approvals.js',
  '/js/dropdowns.js',
  '/js/cleanup.js',
  '/js/composer.js',
  '/js/notifications.js',
  '/js/inbox.js',
  '/js/devices.js',
  '/js/device-detail.js',
  '/js/detail.js',
  '/js/transcript.js',
  '/js/ws.js',
  '/js/prefs-sync.js',
  '/js/aca.js',
  '/js/aca-status.js',
  '/js/access.js',
  '/js/install.js',
  '/js/connect.js',
  '/js/filters.js',
  '/js/push.js',
  '/js/wiring.js',
  '/js/signin.js',
  '/app.js',
  '/app.webmanifest',
  '/favicon.svg',
  '/icon.svg',
  '/logo.jpg',
  // The install flow (header button, "Add to Home Screen", app switcher) reads
  // these from the manifest rather than the page, so the pages network-first
  // fetches never touch them -- without a shell entry they would 404 the
  // moment the install prompt or the app switcher asks for them offline.
  '/icon-mask-512.png',
  '/screenshot-wide.png',
  '/screenshot-narrow.png',
];

self.addEventListener('install', (event) => {
  // `addAll` rejects the whole install if ANY asset 404s, which is the correct
  // behavior: a shell missing its stylesheet is not a shell worth keeping.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE) await caches.delete(name);
    }
    // Take over open tabs immediately rather than waiting for every one to be
    // closed. A worker that activates "eventually" is one nobody can reason
    // about when debugging a stale page.
    await self.clients.claim();
  })());
});

/**
 * Is this a request the shell cache may answer?
 *
 * Written as an allow-list. A deny-list would mean any route added later is
 * cacheable by default, and the route most likely to be added to this app is
 * another API one.
 */
function isShellRequest(request, url) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  // Sign-in and OAuth callbacks carry credentials in the query string and are
  // single-use. Caching one would at best replay a dead code.
  if (url.pathname.startsWith('/signin') || url.pathname.startsWith('/auth')) return false;
  return true;
}

/**
 * The cache key, with the query string removed.
 *
 * `/?token=...` and `/?session=...` are the SAME shell as `/`. Keying on the
 * full URL would store a copy per token -- and store the token itself in the
 * Cache API, which is a credential written to disk for no benefit at all.
 */
function shellKey(url) {
  return new Request(url.origin + url.pathname);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!isShellRequest(event.request, url)) return; // let the network handle it

  event.respondWith((async () => {
    const key = event.request.mode === 'navigate' ? shellKey(new URL('/', url)) : shellKey(url);
    try {
      const fresh = await fetch(event.request);
      // Only a real answer is worth keeping. Caching a 404 or a 500 would
      // serve that error back forever once the network went away.
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(key, fresh.clone());
      }
      return fresh;
    } catch {
      const cached = await caches.match(key);
      if (cached) return cached;
      // A navigation with nothing cached still deserves an answer a person can
      // read, rather than the browser's own error page.
      if (event.request.mode === 'navigate') {
        return new Response(OFFLINE_PAGE, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      throw new Error('offline and not cached');
    }
  })());
});

// ---------------------------------------------------------------------------
// Web Push (#175)
//
// This is the entire reason the service worker gets involved in push at all:
// `push` and `notificationclick` only ever fire here, never in a page, because
// the whole point is a session that needs you while nothing is open to hear
// about it.
//
// The payload is deliberately small and pre-redacted by the hub (see
// src/notify/push.js and docs/security.md's Web Push section) -- there is no
// command, prompt or cwd in it to leak, so this handler does not need to do
// any redaction of its own. It only has to render what it was sent.
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  // A push with no payload (a keepalive, or a malformed send) must still show
  // SOMETHING -- Chrome enforces "one push, one notification" and silently
  // swallowing an empty one risks the browser showing its own generic "this
  // site was updated" notification instead, which names nobody and helps no
  // one.
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* non-JSON payload */ }
  const title = data.title || 'Squad Hub';
  const body = data.device ? `${data.device} needs you` : 'A session needs you';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.sessionKey ? `push-${data.sessionKey}` : undefined,
    // A second push for the same session while the first is still showing
    // should replace it, not stack a duplicate -- `renotify` is what makes a
    // same-tag `showNotification` actually alert again rather than being a
    // silent no-op update.
    renotify: !!data.sessionKey,
    data: { sessionKey: data.sessionKey || null },
  }));
});

/**
 * Clicking the notification should bring a person to the hub, focused on the
 * session that needs them -- not just "the app happened to open". An already
 * open tab is focused rather than duplicated, since a second tab of the same
 * hub answers nothing a focus could not.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionKey = event.notification.data && event.notification.data.sessionKey;
  const url = sessionKey ? `/?session=${encodeURIComponent(sessionKey)}` : '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) { try { await client.navigate(url); } catch { /* cross-origin or closed mid-flight */ } }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

const OFFLINE_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Squad Hub — offline</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#14161a; color:#e8eaef;
         font:14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .box { text-align:center; padding:32px; max-width:34rem; }
  h1 { font-size:18px; margin:0 0 8px; }
  p { color:#a3aab8; margin:0 0 8px; }
  button { margin-top:16px; background:#4c8dff; border:0; color:#fff;
           padding:9px 18px; border-radius:8px; font:inherit; cursor:pointer; }
</style></head>
<body><div class="box">
  <h1>Squad Hub is offline</h1>
  <p>This device cannot reach the hub right now.</p>
  <p><strong>Your sessions are unaffected.</strong> They run on your devices, not here — the hub only watches them. Anything waiting for an approval is still waiting.</p>
  <button onclick="location.reload()">Try again</button>
</div></body></html>`;
