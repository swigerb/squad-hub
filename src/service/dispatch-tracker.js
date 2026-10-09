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
 * Holds no GitHub credential: `owner`, `repo`, `installationId` (a number, not
 * a credential), a timestamp, and the hub's own per-attempt correlation id
 * when the target workflow supports it. That correlation id is internal-only:
 * used solely so `GitHubApp.resolveRunStatus` can prove which run belongs to
 * this record, never returned to a browser or stored as a reusable token.
 */

const crypto = require('crypto');

/** Caps each user's own history -- a long-running hub must not grow this
 * list forever, and nobody needs more than this many rows of "recent". */
const MAX_PER_USER = 50;

/**
 * How old an unmatched record may get before `listWithStatus` stops trying
 * to match it against live Actions runs at all (#213, a follow-up from
 * #211's review). A real `workflow_dispatch` run normally appears within
 * seconds to a couple of minutes; a record still unmatched an hour later
 * means the run was deleted, the dispatch failed upstream after this record
 * was already written, or something else has gone wrong -- not that GitHub
 * is merely slow. Past this age, `listWithStatus` reports the record as
 * errored instead of searching for it, so a dispatch that never receives a
 * provable run receipt does not stay "pending" forever. */
const MAX_UNMATCHED_RECORD_AGE_MS = 60 * 60 * 1000;
const UNSUPPORTED_STATUS = {
  state: 'unsupported',
  reason: "this repository's squad-dispatch.yml does not declare hub_correlation_id, so this dispatch's run cannot be proven from here",
};

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
   * it actually used. `this._now()` is only a fallback for a caller that does
   * not supply one.
   */
  record(userKey, rec) {
    const list = this._byUser.get(userKey) || [];
    list.push({
      ...rec,
      dispatchedAt: rec.dispatchedAt != null ? rec.dispatchedAt : this._now(),
      correlationId: rec.correlationId != null ? rec.correlationId : null,
      correlationSupported: rec.correlationSupported === true,
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

  _publicRecord(rec, status) {
    return {
      owner: rec.owner,
      repo: rec.repo,
      ref: rec.ref,
      dispatchedAt: rec.dispatchedAt,
      status,
    };
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
   * Unmatched records are still resolved OLDEST dispatch first (see
   * `_resolveOrder`) as a defence-in-depth layer alongside `excludeRunIds`:
   * even with exact correlation matching, the oldest record should win any
   * impossible-to-expect contention before a newer one can bind. A record
   * older than `MAX_UNMATCHED_RECORD_AGE_MS` is skipped entirely rather than
   * searched, because a stale unmatched record must not sit in "pending"
   * forever.
   *
   * `boundRunId` is re-checked immediately after the `await` on
   * `resolveRunStatus`, before this record is bound -- two concurrent polls
   * of this same tracker (two browser tabs, or a poll overlapping a
   * refresh) can both start this record still unbound, and the first to
   * finish its own `await` must win. Without the re-check, the second call
   * to finish would blindly overwrite an already-bound `boundRunId` with
   * whatever ITS OWN (possibly different, since the two calls raced with
   * different `boundElsewhere` snapshots) search turned up, silently
   * flipping which run this record is bound to. Re-checking means the
   * second call instead defers to the binding that already won, by
   * refreshing that exact run the same way an already-bound record always
   * does.
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
        } else if (r.correlationSupported === false) {
          status = UNSUPPORTED_STATUS;
        } else if (this._now() - r.dispatchedAt > MAX_UNMATCHED_RECORD_AGE_MS) {
          status = { state: 'error', reason: 'no matching Actions run appeared within an hour of this dispatch' };
        } else {
          status = await githubApp.resolveRunStatus({ ...r, excludeRunIds: boundElsewhere });
          if (r.boundRunId != null) {
            // Another concurrent call already bound this record while this
            // one was awaiting GitHub -- defer to that binding rather than
            // risk overwriting it with a possibly different run.
            status = await githubApp._getRun(r.owner, r.repo, r.installationId, r.boundRunId);
          } else if (status && status.runId != null) {
            r.boundRunId = status.runId;
            boundElsewhere.add(status.runId);
          }
        }
      } catch (e) {
        status = { state: 'error', reason: e.message };
      }
      if (mine.has(r.id)) statusById.set(r.id, status);
    }
    return recs.map((r) => this._publicRecord(r, statusById.get(r.id)));
  }

  /**
   * The records `listWithStatus` resolves, oldest dispatch first: the
   * caller's own, plus any OTHER user's still-unmatched record on the same
   * repository and ref that was dispatched no later than one of the caller's
   * unmatched records. Binding those first means the earliest dispatch on a
   * repository always claims the earliest run, whichever user polls first.
   * Only the binding is shared; another user's status is never returned.
   *
   * `owner`/`repo` are compared case-insensitively (#213, a follow-up from
   * #211's review): GitHub treats `Acme/Widgets` and `acme/widgets` as the
   * same repository, and `findInstallation` already allow-lists a dispatch
   * target that way (see `github-app.js`). Comparing this binding
   * case-sensitively would let two differently-cased spellings of the same
   * repository each think they have no other dispatch to coordinate with,
   * and independently resolve against -- and potentially double-claim -- the
   * same run.
   */
  _resolveOrder(recs) {
    const ids = new Set(recs.map((r) => r.id));
    const mineUnbound = recs.filter((r) => r.boundRunId == null);
    const sameTarget = (a, b) => a.owner.toLowerCase() === b.owner.toLowerCase()
      && a.repo.toLowerCase() === b.repo.toLowerCase()
      && (a.ref || null) === (b.ref || null);
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

module.exports = {
  DispatchTracker,
  MAX_PER_USER,
  MAX_UNMATCHED_RECORD_AGE_MS,
  UNSUPPORTED_STATUS,
};
