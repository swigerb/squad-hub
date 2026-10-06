'use strict';
/**
 * Dispatches this hub has made through `POST /api/aca/dispatch`, held in
 * memory and scoped per user -- the same per-user partitioning discipline
 * `store.js` is built on (see the comment at the top of `hub-service.js`):
 * every read takes the caller's own `me.key` and reaches only that bucket,
 * never a list spanning every user.
 *
 * In-memory only, by design: a hub restart losing the "pending" rows this
 * feeds is an acceptable gap for a status convenience feature, not a safety
 * property. A durable version of this is #178, a different issue.
 *
 * Holds no secret: `owner`, `repo`, `installationId` (a number, not a
 * credential) and a timestamp -- never a token. `installationId` is kept so
 * `GitHubApp.resolveRunStatus` can mint whichever installation token it needs
 * without re-running the allow-list lookup for every status poll.
 */

const crypto = require('crypto');

/** Caps each user's own history -- a long-running hub must not grow this
 * list forever, and nobody needs more than this many rows of "recent". */
const MAX_PER_USER = 50;

class DispatchTracker {
  constructor({ now } = {}) {
    this._now = now || (() => Date.now());
    /** userKey -> array of records, oldest first. */
    this._byUser = new Map();
  }

  /** Record a dispatch just made for `userKey`. */
  record(userKey, rec) {
    const list = this._byUser.get(userKey) || [];
    list.push({ ...rec, dispatchedAt: this._now(), id: crypto.randomUUID() });
    while (list.length > MAX_PER_USER) list.shift();
    this._byUser.set(userKey, list);
  }

  /** The caller's own dispatches, newest first. A copy -- nothing returned
   * here is the live array a later `record()` could mutate out from under a
   * caller still reading it. */
  list(userKey) {
    return [...(this._byUser.get(userKey) || [])].reverse();
  }

  /**
   * The caller's own dispatches, each resolved against GitHub Actions for its
   * current run status. A status lookup failing for one dispatch (a deleted
   * repo, a revoked installation) must not hide every other row, so each is
   * resolved independently and a failure becomes a `status.state: 'error'`
   * entry rather than an exception that loses the whole list.
   */
  async listWithStatus(userKey, githubApp) {
    const recs = this.list(userKey);
    const out = [];
    for (const r of recs) {
      let status;
      try {
        status = await githubApp.resolveRunStatus(r);
      } catch (e) {
        status = { state: 'error', reason: e.message };
      }
      out.push({ ...r, status });
    }
    return out;
  }
}

module.exports = { DispatchTracker, MAX_PER_USER };
