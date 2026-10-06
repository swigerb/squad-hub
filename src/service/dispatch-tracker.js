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

  /**
   * Record a dispatch just made for `userKey`. `dispatchedAt` and `ref`
   * should come from `GitHubApp.dispatch`'s own return value -- the instant
   * right before the `workflow_dispatch` call actually went out, and the ref
   * it actually used -- not a fresh timestamp taken here, which would run
   * noticeably later (after the HTTP round trip) and risk excluding the very
   * run this dispatch produced. `this._now()` is only a fallback for a
   * caller that does not supply one.
   */
  record(userKey, rec) {
    const list = this._byUser.get(userKey) || [];
    list.push({
      ...rec,
      dispatchedAt: rec.dispatchedAt != null ? rec.dispatchedAt : this._now(),
      id: crypto.randomUUID(),
      /** Once a run is matched for this record, its id is kept here so a
       * later poll never re-runs the matching search (and so never risks
       * handing the same run to a different record, or flipping to a
       * different run on a borderline match). */
      boundRunId: null,
    });
    while (list.length > MAX_PER_USER) list.shift();
    this._byUser.set(userKey, list);
  }

  /** The caller's own dispatches, newest first. A copy -- nothing returned
   * here is the live array a later `record()` could mutate out from under a
   * caller still reading it. */
  list(userKey) {
    return [...(this._byUser.get(userKey) || [])].reverse();
  }

  /** Every run id already bound to some recorded dispatch, across every
   * user -- gathered so a run is never handed to two different records, even
   * ones belonging to different hub users who both dispatched the same
   * repository within a few seconds of each other. */
  _allBoundRunIds() {
    const ids = new Set();
    for (const list of this._byUser.values()) {
      for (const r of list) if (r.boundRunId != null) ids.add(r.boundRunId);
    }
    return ids;
  }

  /**
   * The caller's own dispatches, each resolved against GitHub Actions for its
   * current run status. A status lookup failing for one dispatch (a deleted
   * repo, a revoked installation) must not hide every other row, so each is
   * resolved independently and a failure becomes a `status.state: 'error'`
   * entry rather than an exception that loses the whole list.
   *
   * A record that has already matched a run (`boundRunId` set, from a prior
   * call) only ever refreshes THAT run's status -- it never re-searches, so
   * it can never be re-bound to a different run later. A record still
   * unmatched searches excluding every run id already bound to any other
   * record, live or stale, so two close dispatches on one repo never both
   * claim the same run.
   *
   * Unmatched records are resolved OLDEST dispatch first (see
   * `_resolveOrder`), because `resolveRunStatus` picks the earliest run in a
   * window that, for close dispatches, also covers the other dispatch's run.
   * Resolving the newest first would let it take the older dispatch's run
   * and swap the two bindings for good.
   */
  async listWithStatus(userKey, githubApp) {
    const recs = this.list(userKey);
    const boundElsewhere = this._allBoundRunIds();
    const mine = new Set(recs.map((r) => r.id));
    const statusById = new Map();
    for (const r of this._resolveOrder(recs)) {
      let status;
      try {
        if (r.boundRunId != null) {
          status = await githubApp._getRun(r.owner, r.repo, r.installationId, r.boundRunId);
        } else {
          status = await githubApp.resolveRunStatus({ ...r, excludeRunIds: boundElsewhere });
          if (status && status.runId != null) {
            r.boundRunId = status.runId;
            boundElsewhere.add(status.runId);
          }
        }
      } catch (e) {
        status = { state: 'error', reason: e.message };
      }
      if (mine.has(r.id)) statusById.set(r.id, status);
    }
    return recs.map((r) => ({ ...r, status: statusById.get(r.id) }));
  }

  /**
   * The records `listWithStatus` resolves, oldest dispatch first: the
   * caller's own, plus any OTHER user's still-unmatched record on the same
   * repository and ref that was dispatched no later than one of the caller's
   * unmatched records. Binding those first means the earliest dispatch on a
   * repository always claims the earliest run, whichever user polls first.
   * Only the binding is shared; another user's status is never returned.
   */
  _resolveOrder(recs) {
    const ids = new Set(recs.map((r) => r.id));
    const mineUnbound = recs.filter((r) => r.boundRunId == null);
    const sameTarget = (a, b) => a.owner === b.owner && a.repo === b.repo && (a.ref || null) === (b.ref || null);
    const others = [];
    for (const list of this._byUser.values()) {
      for (const o of list) {
        if (ids.has(o.id) || o.boundRunId != null) continue;
        if (mineUnbound.some((m) => sameTarget(m, o) && o.dispatchedAt <= m.dispatchedAt)) others.push(o);
      }
    }
    return [...recs, ...others].sort((a, b) => a.dispatchedAt - b.dispatchedAt);
  }
}

module.exports = { DispatchTracker, MAX_PER_USER };
