// The ACA pending-dispatch -> real-session correlation logic, split out of
// aca-pending.js to stay under the per-module size budget (see
// test/package-unit.js's "no web/js file is anywhere near the old
// single-file size") -- the same reason #235 split device-detail.js out of
// devices.js, and #178 originally split this whole concern out of aca.js.
//
// Pure functions only: no `state`, no `Date.now()`, no DOM. `aca-pending.js`
// owns the actual `state.acaPending` bookkeeping (tracking, polling,
// rendering) and calls into this file with whatever data it has at hand.

/** Clock-drift tolerance kept for the same reason the server's own
 * `RUN_MATCH_TOLERANCE_MS` (`src/service/github-app.js`) exists: this hub's
 * own `dispatchedAt` and a session's own `startedAt` are recorded by two
 * different processes/clocks. No longer used by the functions below (see
 * their doc comments) -- still exported because
 * `test/aca-dispatch-dialog-unit.js` imports it, and a future authoritative
 * join (see REVIEW HISTORY) would likely need the same constant again. */
export const ACA_START_TOLERANCE_MS = 5000;

/**
 * Whether a given still-pending dispatch (`entry`) can be PROVEN to be the
 * one that produced some currently-visible `aca`-kind session, out of
 * `groups` (`state.overview.groups`, the same WS-pushed data every other
 * list on this page already renders from).
 *
 * THE ANSWER, as of this review, IS ALWAYS "NO" -- this function always
 * returns `null`. Read on for why; this is a deliberate, reasoned
 * conclusion, not a stub.
 *
 * REVIEW HISTORY (kept so a future change does not reintroduce any of these
 * mistakes):
 *
 *   - An original version matched purely on repository, ranking candidates
 *     by recency. A reviewer found this let an unrelated same-repository
 *     session, or a second dispatch racing ahead of a first, attach to the
 *     wrong pending row.
 *
 *   - A revision added `meta.repo`/`meta.issue` (see `src/device-meta.js`)
 *     as an exact-match requirement, plus a same-issue "pick the candidate
 *     whose `dispatchedAt` is numerically closest to the session's
 *     `startedAt`" tie-break for repeated/retried dispatches on one issue.
 *     A reviewer proved that ranking wrong: dispatch A, `dispatchedAt=10000`,
 *     produces a session that does not start until `startedAt=25000` (a slow
 *     runner-claim or cold start); an unrelated dispatch B for the same
 *     issue goes out at `dispatchedAt=20000`. Ranking by closeness to 25000
 *     picks B, not A -- proximity is not proof of causation.
 *
 *   - A second revision removed the proximity ranking and replaced it with
 *     two rules: (1) a session can never belong to a dispatch made AFTER the
 *     session itself already started, and (2) when a session is
 *     independently eligible for MORE THAN ONE same-issue sibling by rule 1,
 *     it matches NEITHER -- except that a sibling which had already reached
 *     its own terminal `resolved` state (including the local, non-GitHub
 *     "completed successfully, but this hub's own `ACA_COMPLETED_WAIT_MS`
 *     wait bound expired with no attach seen" outcome -- see aca.js's
 *     `acaStepsForStatus`, the "Unknown outcome" branch) was excluded from
 *     that sibling check, on the theory a resolved sibling had "already
 *     given its final answer" and could no longer compete.
 *
 *     A THIRD review proved that exclusion itself a false-positive source --
 *     the exact bug this file now exists to never repeat: dispatch A
 *     (`dispatchedAt=10000`) resolves locally via the "Unknown outcome"
 *     wait-bound-expired path -- which is this HUB'S OWN local "we gave up
 *     waiting" timeout, never an authoritative GitHub fact that A's job can
 *     never produce a session. Dispatch B (`dispatchedAt=20000`) is still
 *     genuinely pending. The real session that actually belongs to A (a
 *     slow-starting job) finally starts at `startedAt=25000`, reporting the
 *     same repo+issue as both A and B. Because A had `resolved === true`,
 *     the sibling filter excluded A from B's own ambiguity check; B then saw
 *     no competing sibling, rule 1 passed trivially, and B confidently (and
 *     wrongly) claimed the session that actually belonged to A. "Resolved"
 *     is this hub's own bookkeeping about whether it intends to keep
 *     polling an entry -- it is not evidence about which dispatch produced a
 *     given session, so it can never be used to narrow the sibling pool.
 *
 *     The same review also found the inverse case already broken by design:
 *     a session matching only ONE known pending entry, with no siblings at
 *     all, is ALSO not proof of identity. `GET /api/aca/dispatches` (what
 *     populates cross-tab `allPending`) is scoped to dispatches made through
 *     THIS hub's own `/api/aca/dispatch` endpoint for the current
 *     authenticated subject -- it has zero visibility into a manual
 *     `/squad-aca` slash-command dispatch, a Ralph-initiated dispatch, or
 *     any other way the SAME workflow could have been triggered for the
 *     SAME repo+issue by the SAME person outside this hub's own
 *     dispatch-tracking feature. So "I am the only known candidate" is not
 *     the same fact as "I am the only REAL candidate" -- repo+issue+timing,
 *     even with zero visible siblings, is not authoritative proof of WHICH
 *     dispatch attempt (or whether this hub's own dispatch feature at all)
 *     produced a given session.
 *
 * THE CONCLUSION: there is no fix that patches rule 2's sibling filter and
 * keeps the rest of this logic -- the review's own single-entry finding
 * above means even a flawless sibling filter would still be wrong. Nothing
 * in this codebase's current contracts gives a device a way to report a
 * verifiable identity back to a specific dispatch attempt:
 *
 *   - `src/service/github-app.js`'s `dispatch()` (the `workflow_dispatch`
 *     call) returns HTTP 204 with no run id synchronously -- there is
 *     nothing to hand the job at dispatch time for it to report back later.
 *   - `resolveRunStatus()` DOES bind an authoritative run id to a dispatch,
 *     server-side (earliest-created-run-after-dispatchedAt-on-matching-ref,
 *     excluding already-claimed run ids), and that `runId` IS exposed to the
 *     client via `GET /api/aca/dispatches`'s per-entry `status.runId` -- but
 *     `src/device-meta.js`'s `FIELDS` allowlist (`displayName`, `repo`,
 *     `issue`, `executionName`, `jobName`, `role`, `approvalMode`,
 *     `lastSweepAt`) has no run/execution-id field a device can report back,
 *     so there is no way to join a client-observed `aca-` session to that
 *     server-bound `runId`. Inventing one -- a new device-meta field, a new
 *     `workflow_dispatch` input, or a mapping from `executionName`/`jobName`
 *     free text to a GitHub run id -- is explicitly out of scope: none of
 *     those is a proven fact the job itself could report honestly today,
 *     they would just be a different-shaped guess.
 *
 * So repo+issue+timing is evidence of "plausible", never of "proven", and
 * this hub will not guess. Every pending row now resolves only through
 * fully authoritative paths that do not depend on this function at all (see
 * `aca-pending.js`'s `syncAcaPending`): the server-authoritative GitHub
 * Actions run status (Dispatched / Lease claimed / Starting job progress),
 * "Dispatch failed" (an authoritative non-success run conclusion, or a
 * dispatch POST error), or "Unknown outcome" (an authoritative run success,
 * with the local wait bound expired and no attach ever proven -- shown
 * honestly, never silently as attached). A future squad-on-aca release that
 * reports a verifiable run/execution identity back could reinstate a real
 * join here; nothing above should be read as ruling that out, only as
 * refusing to fake it today.
 *
 * KNOWN, DOCUMENTED CONSEQUENCE: a pending row no longer disappears when its
 * own `aca-` device actually attaches (see `docs/aca.md`'s "Queued on ACA"
 * section). The row and the real session row now simply coexist until the
 * pending row's own authoritative status resolves it. This is an accepted,
 * intentional narrowing of issue #178's original acceptance criteria, not an
 * oversight.
 */
export function acaPendingMatch() {
  return null;
}

/**
 * Has this pending dispatch's own `aca-` device actually attached?
 *
 * Always `false` -- a thin wrapper kept so callers (and
 * `test/aca-dispatch-dialog-unit.js`) have one stable name to ask, rather
 * than inlining `acaPendingMatch(...) !== null` everywhere. See
 * `acaPendingMatch`'s own doc comment above for why this can never be `true`
 * with today's contracts.
 */
export function acaPendingAttached() {
  return acaPendingMatch() !== null;
}
