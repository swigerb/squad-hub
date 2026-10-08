// Web Push (#175): subscribing this browser to "a session needs you" alerts
// so they arrive even while the app is closed. Split out the same way
// install.js is -- a self-contained feature with its own state, wired into
// the account menu by wiring.js.
//
// Desktop notifications (notifications.js) already cover the case where a
// tab is OPEN. This module exists for the case that actually matters most on
// a phone: the app is not running at all, and a push is the only way in.

import { state, api } from './api.js';
import { $, esc, toast } from './util.js';

// The subscription id the hub handed back on POST, cached locally so a later
// "turn it off" can DELETE the right record without the hub ever having to
// hand back the endpoint (which would be handing back a value indistinguishable
// from a credential for that browser).
const SUB_ID_KEY = 'squad-hub-push-sub-id';

function safeLocalStorage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function storedSubId(storage = safeLocalStorage()) {
  if (!storage) return null;
  try { return storage.getItem(SUB_ID_KEY); } catch { return null; }
}

function setStoredSubId(id, storage = safeLocalStorage()) {
  if (!storage) return;
  try {
    if (id) storage.setItem(SUB_ID_KEY, id);
    else storage.removeItem(SUB_ID_KEY);
  } catch { /* quota, private mode */ }
}

/** Is this browser even capable of Web Push, independent of whether the hub is configured for it? */
export function pushSupported(win = typeof window === 'undefined' ? null : window) {
  if (!win) return false;
  return 'serviceWorker' in win.navigator && 'PushManager' in win;
}

/**
 * A base64url VAPID public key, as the hub hands it back, decoded into the
 * raw bytes `PushManager.subscribe`'s `applicationServerKey` wants.
 *
 * Exported for its own unit test -- getting this wrong produces a `subscribe`
 * rejection with a message that never says why, so it is worth proving
 * correct in isolation rather than only through the full subscribe flow.
 */
export function urlBase64ToUint8Array(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** This browser's current push subscription, if the service worker has one, without creating one. */
async function existingSubscription() {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch { return null; }
}

/**
 * Whether push is "on" from this browser's point of view right now --
 * driven by the actual platform subscription, not by a flag this app set and
 * could get out of sync with (a user can revoke notification permission from
 * their OS settings without this page ever hearing about it until asked).
 */
export async function pushEnabled() {
  return !!(await existingSubscription());
}

/**
 * Subscribe this browser and tell the hub about it.
 *
 * Requests Notification permission first and only on this click -- never on
 * load, for the same reason notifications.js never does: a prompt nobody
 * asked for is the one people reflexively deny, and a denial here is
 * permanent until the person goes digging in browser settings.
 */
export async function enablePush() {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };
  if (!state.me || !state.me.push || !state.me.push.enabled) return { ok: false, reason: 'not-configured' };

  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: perm === 'denied' ? 'denied' : 'dismissed' };
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    return { ok: false, reason: 'denied' };
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.me.push.publicKey),
    });
  }
  const json = sub.toJSON();
  // A short, human label beats the endpoint URL (which is itself the one
  // part of this record that must never be shown back -- see the API doc's
  // note on why DELETE takes an id rather than the endpoint). Browser +
  // platform is enough for someone with three devices to tell them apart in
  // the "forget this device" list a future issue may add.
  const label = (navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg|OPR)\/[\d.]+/) || [])[0] || 'This browser';
  const saved = await api('/api/push/subscriptions', {
    method: 'POST',
    body: { endpoint: json.endpoint, keys: json.keys, label },
  });
  setStoredSubId(saved.id);
  return { ok: true };
}

/**
 * Unsubscribe this browser, and tell the hub to forget it.
 *
 * Both halves matter and neither alone is enough: unsubscribing locally
 * without telling the hub leaves a dead record the hub will keep trying (and
 * failing, harmlessly) to push to until a 410 eventually prunes it; telling
 * the hub without unsubscribing locally leaves the browser still holding a
 * live subscription that "Enable" would then have to notice and re-register
 * rather than re-create.
 */
export async function disablePush() {
  const sub = await existingSubscription();
  const id = storedSubId();
  if (id) {
    try { await api(`/api/push/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* already gone */ }
  }
  if (sub) { try { await sub.unsubscribe(); } catch { /* already gone */ } }
  setStoredSubId(null);
}

/**
 * The bell inbox footer's "🔔 Push to this device On/Off" row -- state and
 * label kept in sync with reality, the same pattern install.js uses for its
 * own menu checkmark. Lives in the inbox footer (not the account menu)
 * because it is a property of THIS BROWSER's subscription, same as the bell
 * itself is scoped to this device's alerts -- see the v0.7.0 mockup (E6.2).
 */
export async function syncPushMenuItem() {
  const item = $('pushMenuItem');
  const label = $('pushMenuState');
  if (!item || !label) return;
  if (!pushSupported()) { item.hidden = true; return; }
  if (!state.me || !state.me.push || !state.me.push.enabled) {
    // The hub itself has no VAPID keys configured -- offering a toggle that
    // can never do anything would teach people the button is broken, not that
    // the hub is unconfigured.
    item.hidden = true;
    return;
  }
  item.hidden = false;
  const on = await pushEnabled();
  item.dataset.on = on ? '1' : '';
  label.textContent = on ? 'On' : 'Off';
  label.style.color = on ? 'var(--ok)' : 'var(--faint)';
  label.style.fontWeight = on ? '600' : '400';
}

/** Wire the inbox footer row's click. Called once at startup, alongside wireInstall(). */
export function wirePush() {
  if (!$('pushMenuItem')) return;
  $('pushMenuItem').onclick = async () => {
    const item = $('pushMenuItem');
    item.disabled = true;
    try {
      if (item.dataset.on) {
        await disablePush();
        toast('Push notifications turned off');
      } else {
        const r = await enablePush();
        if (r.ok) toast('Push notifications turned on');
        else if (r.reason === 'denied') toast('Notifications are blocked for this site in browser settings');
        else if (r.reason === 'not-configured') toast('Push is not configured on this hub');
        else if (r.reason === 'unsupported') toast('This browser cannot receive push notifications');
        // 'dismissed': the permission prompt was closed without an answer --
        // no toast, since the browser's own prompt already said enough and a
        // second message on top of it is noise.
      }
    } catch (e) {
      toast(`Could not change push notifications: ${esc(e.message)}`);
    } finally {
      item.disabled = false;
      await syncPushMenuItem();
    }
  };
}
