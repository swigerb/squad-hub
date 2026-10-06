'use strict';
/**
 * A tiny sliding-window rate limiter, per key.
 *
 * Built for `POST /api/aca/dispatch` (see `hub-service.js`), which starts
 * real Azure compute through a credential the hub itself now holds -- a
 * device token could never do this, so the floor a user hitting "dispatch"
 * in a loop bumps into has to live here instead.
 *
 * Sliding window, not a fixed bucket reset on a clock boundary: a fixed
 * window lets a caller spend the whole limit in the last second of one window
 * and the whole limit again in the first second of the next, for 2x the
 * intended rate at the boundary. A sliding log has no such seam.
 *
 * The clock is injectable so a test can assert the exact instant a request
 * starts being refused and the exact instant it is allowed again, without a
 * real five-minute sleep.
 */
class RateLimiter {
  constructor({ limit, windowMs, now } = {}) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('limit must be a positive number');
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be a positive number');
    this.limit = limit;
    this.windowMs = windowMs;
    this._now = now || (() => Date.now());
    /** key -> ascending array of hit timestamps still inside the window. */
    this._hits = new Map();
  }

  /**
   * Record an attempt for `key` and say whether it is allowed.
   *
   * Returns `{allowed, retryAfterMs}`. A refused attempt is NOT recorded as a
   * hit -- hammering the endpoint while refused must not extend how long the
   * refusal lasts, or a caller could keep itself locked out forever by
   * retrying too eagerly.
   */
  check(key) {
    const now = this._now();
    const windowStart = now - this.windowMs;
    const prior = this._hits.get(key) || [];
    const hits = prior.filter((t) => t > windowStart);

    if (hits.length >= this.limit) {
      this._hits.set(key, hits);
      return { allowed: false, retryAfterMs: Math.max(0, hits[0] + this.windowMs - now) };
    }

    hits.push(now);
    this._hits.set(key, hits);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Forgets one key's history. Mainly for tests. */
  reset(key) { this._hits.delete(key); }
}

module.exports = { RateLimiter };
