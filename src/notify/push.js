'use strict';
/**
 * Push notifications for "a session needs you" (#175).
 *
 * Mirrors `notify/teams.js`'s shape deliberately: both are fire-and-forget
 * notifiers triggered from the same place in `hub-service.js` (`_notifyPending`),
 * both dedupe so a heartbeat every few seconds cannot re-notify about the same
 * thing, and both must never let a delivery failure touch the control plane.
 * The hub itself, and the actual approval, already exist independently of
 * either notifier -- this is a convenience that reaches a person who is not
 * looking at a screen right now, nothing more.
 *
 * THE PAYLOAD IS FIXED, ON PURPOSE. Unlike the Teams card (which shows a
 * command and the paths it touches, because a Teams channel is accessed the
 * same way the hub itself is), a push payload typically survives outside the
 * hub's own custody for a little while -- queued by a push service like FCM
 * or Mozilla's autopush, sometimes delivered to an OS notification tray that
 * other apps or a lock screen can read. So it carries only what the issue
 * calls for: that a session needs a human, which device, and the key to open
 * it with. No command, no paths -- see docs/security.md.
 */

const { WebPushError } = require('../service/web-push');

/** The payload's exact shape. Never anything beyond these four fields. */
function needsYouPayload({ title, device, session }) {
  return {
    title,
    device: (device && device.name) || 'a device',
    // The deep link the service worker opens on click/tap -- see web/sw.js.
    // Keyed the same way `teams.js`'s sessionDeepLink is: `deviceId:sessionId`,
    // because a bare session id is only unique WITHIN one device.
    sessionKey: session.key,
  };
}

class PushNotifier {
  constructor({ sender, store, log } = {}) {
    this.sender = sender;
    this.store = store;
    this.log = log || (() => {});
    // Keyed `${subject}\u0000${dedupeKey}` so one subject's dedupe state can
    // never collide with another's, and so forgetting never has to touch a
    // Map shared across every user of the hub.
    this.sent = new Set();
  }

  get enabled() {
    return !!(this.sender && this.sender.enabled && this.store);
  }

  /**
   * Notify every subscription a subject holds, once per `dedupeKey`.
   *
   * `dedupeKey` is the approval id for a pending approval, or
   * `${session.key}:${session.updatedAt}` for an awaiting-reply session --
   * see hub-service.js's `_notifyPush`. Either way it changes exactly when
   * the thing it describes becomes new again, which is the only time a
   * repeat notification is wanted.
   */
  async notifyNeedsYou({
    subject, device, session, title, dedupeKey,
  }) {
    if (!this.enabled) return { skipped: 'push is not configured, or no subscriptions exist' };
    const key = `${subject}\u0000${dedupeKey}`;
    if (this.sent.has(key)) return { skipped: 'already notified' };

    // Checked, but NOT recorded in `this.sent`, before any subscription
    // exists: `dedupeKey` does not change for the life of an approval or an
    // awaiting-reply session, so marking it "sent" here would be permanent --
    // the most likely person to hit this is someone who enables push only
    // AFTER missing an earlier alert, and they would then never be notified
    // about that same still-pending approval at all, even moments later once
    // their subscription exists.
    const subscriptions = this.store.list(subject);
    if (!subscriptions.length) return { skipped: 'no subscriptions' };

    this.sent.add(key);
    if (this.sent.size > 2000) this.sent.delete(this.sent.values().next().value);

    const payload = needsYouPayload({ title, device, session });
    const results = await Promise.all(subscriptions.map(async (sub) => {
      try {
        await this.sender.send(sub, payload);
        return { id: sub.id, sent: true };
      } catch (e) {
        if (e instanceof WebPushError && e.gone) {
          // The push service itself says this subscription will never work
          // again -- an uninstalled PWA, a cleared browser profile. Pruning
          // it here is the only place that fact is ever learned; nothing
          // else polls for it.
          this.store.remove(subject, sub.id);
          this.log(`push: pruned gone subscription ${sub.id} for ${subject}`);
          return { id: sub.id, sent: false, pruned: true };
        }
        this.log(`push: send failed for ${sub.id} (${e.message})`);
        return { id: sub.id, sent: false, error: e.message };
      }
    }));
    return { sent: true, results };
  }

  /** Allow a re-notification -- e.g. after a reconnect replays known state. */
  forget(dedupeKeyPrefix) {
    for (const k of this.sent) {
      if (k.endsWith(`\u0000${dedupeKeyPrefix}`)) this.sent.delete(k);
    }
  }
}

module.exports = { PushNotifier, needsYouPayload };
