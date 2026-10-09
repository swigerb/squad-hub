// The ACA pending-dispatch -> real-session correlation logic, split out of
// aca-pending.js to stay under the per-module size budget (see
// test/package-unit.js's "no web/js file is anywhere near the old
// single-file size") -- the same reason #235 split device-detail.js out of
// devices.js, and #178 originally split this whole concern out of aca.js.
//
// Pure functions only: no `state`, no `Date.now()`, no DOM. `aca-pending.js`
// owns the actual `state.acaPending` bookkeeping (tracking, polling,
// rendering) and calls into `acaPendingMatch` here with whatever data it has
// at hand -- that split is what lets this file's matching rules be proven
// against fixed inputs in test/aca-dispatch-dialog-unit.js, with no fake
// timers or DOM required.

import { sessionKey } from './list.js';
import { acaRepoName } from './aca.js';

/** Clock-drift tolerance for binding a session to the dispatch that
 * produced it -- mirrors the server's own `RUN_MATCH_TOLERANCE_MS`
 * (`src/service/github-app.js`): this hub's own `dispatchedAt` and a
 * session's own `startedAt` are recorded by two different
 * processes/clocks, so a session that genuinely IS a given dispatch's own
 * job can still report starting a few seconds "before" the dispatch by this
 * process's clock, or vice versa. Same number, same justification -- not
 * invented fresh here. */
export const ACA_START_TOLERANCE_MS = 5000;

/** Tolerance used ONLY when rule 2 (below) picks which of several
 * same-issue sibling entries is the CLOSEST PRECEDING dispatch for a given
 * session -- deliberately much smaller than `ACA_START_TOLERANCE_MS`. Every
 * `dispatchedAt` being compared here is recorded by THIS SAME process's own
 * clock (there is no cross-process drift between one entry's dispatchedAt
 * and another's, unlike a dispatchedAt-vs-session-startedAt comparison), so
 * only ordinary clock-tick/scheduling noise needs covering, not the several
 * seconds of cross-clock drift `ACA_START_TOLERANCE_MS` exists for. Reusing
 * the larger tolerance here was a confirmed regression (see rule 2's doc
 * comment below): it let a sibling whose dispatch happened MEANINGFULLY
 * AFTER a session had already started still outrank -- and permanently
 * steal the session from -- the sibling whose dispatch the session had
 * genuinely started shortly after, whenever two same-issue retries were
 * dispatched less than `ACA_START_TOLERANCE_MS` apart. */
export const ACA_RETRY_PRECEDENCE_TOLERANCE_MS = 1000;

/**
 * The best still-unclaimed `aca`-kind session matching this pending
 * dispatch's repository AND issue -- among those, the one whose timing
 * actually proves it is THIS dispatch's own job, never merely "the
 * earliest-started one that happens to share an issue number".
 *
 * Checked against `state.overview.groups` -- the same WS-pushed data every
 * other list on this page already renders from -- rather than a dedicated
 * lookup, so this never costs an extra request of its own: a device's WS
 * message updates `state.overview` and calls `render()` the instant it
 * attaches, no poll required.
 *
 * THE FIRST SIGNAL TREATED AS PROOF: the candidate device's own
 * `meta.repo`/`meta.issue` (see `src/device-meta.js`, already shipped --
 * squad-on-aca's worker reports these at registration, the same metadata the
 * device rail elsewhere trusts for ITS OWN "where did this come from"
 * display) must equal this entry's repository and issue number EXACTLY. That
 * is the same fact this entry's own dispatch supplied to GitHub's
 * `workflow_dispatch` call in the first place (see `acaBuildDispatchBody`'s
 * `issue`/`newIssue`, and `buildWorkflowInputs`'s `issue` input) -- not a
 * coincidence of timing.
 *
 * A device that does not report `meta.issue` (an older squad-on-aca worker,
 * or one mis-deployed with no metadata) can never be proven to belong to any
 * particular dispatch -- this returns `null` for it, same as "no candidate
 * yet", rather than falling back to a guess. The row stays pending; it is
 * never falsely marked attached. This is the explicit, intentional
 * compatibility cost of requiring proof: an unreported `issue` is treated as
 * "cannot be confirmed", never as "assume yes".
 *
 * BUT repo+issue alone is NOT a complete identity for one dispatch ATTEMPT
 * -- it is only proof of "the right repository and issue", not "the right
 * occasion". Two real bugs follow if that is all that is checked (found
 * against an earlier, issue-#178-era version of this function that only
 * checked repo+issue):
 *
 *   Bug A -- a FRESH tab (`state.acaPending` starts empty every page load,
 *   see `trackAcaDispatch`) can bind to a STALE historical session:
 *   `state.overview.groups` is not per-tab, it is whatever the hub currently
 *   knows about, including an `aca-` session from hours or days ago, now
 *   offline or completed, left over from an earlier unrelated dispatch that
 *   happened to target the same issue (a plausible case: someone re-opens
 *   the same issue to try again later). Nothing about repo+issue alone can
 *   tell that session apart from a genuinely-fresh one.
 *
 *   Bug B -- a same-issue RETRY can swap with its own predecessor: dispatch
 *   A (`dispatchedAt=1000`) appears to stall, so the same issue is
 *   dispatched again as B (`dispatchedAt=5000`). Two real sessions
 *   eventually exist, sessionA (really A's own job) and sessionB (really
 *   B's), but GitHub/Azure timing can attach them in EITHER order. If
 *   sessionB attaches first and is the only candidate available, "pick
 *   whichever qualifying session is earliest-started" has no way to know it
 *   is NOT entry A's own job -- A (processed first, being older) wrongly
 *   claims it. When sessionA later attaches, A is already resolved and
 *   excluded from re-evaluation, so B is left to claim sessionA instead. The
 *   two entries end up PERMANENTLY SWAPPED, each showing the other's actual
 *   job.
 *
 * THE FIX, per the explicit direction on issue #178's follow-up: repo+issue
 * is not dispatch-attempt identity; require authoritative data when
 * available (never invent a new workflow_dispatch input the target workflow
 * would have to declare, and never invent a mapping between
 * `meta.executionName`/`meta.jobName` -- free text a SEPARATE codebase
 * chooses to report -- and a GitHub Actions run id: neither is proven, both
 * would be exactly the "fabricate mapping" the brief forbids); leave
 * ambiguous/unprovable attach unknown rather than guess. The one additional
 * authoritative, already-available, zero-new-cost fact this hub has for
 * every pending entry AND every session is TIME ORDERING:
 *
 *   1. A session can never belong to a dispatch made AFTER the session
 *      itself already started (`session.startedAt` must be no earlier than
 *      `entry.dispatchedAt - ACA_START_TOLERANCE_MS`). This alone kills Bug
 *      A: an ancient historical session's `startedAt` long predates a
 *      freshly-created entry's `dispatchedAt`, so it is excluded outright,
 *      regardless of whether the device that reported it is currently
 *      online, stale, or its session has since completed -- none of that
 *      changes how long ago it STARTED, which is the one fact this check
 *      reads.
 *
 *   2. When more than one PENDING entry shares the same repo+issue (a
 *      same-issue retry), a session binds to the entry with the CLOSEST
 *      PRECEDING `dispatchedAt` -- the largest `dispatchedAt` that is still
 *      `<= session.startedAt + ACA_RETRY_PRECEDENCE_TOLERANCE_MS` -- not to
 *      whichever entry's turn came up first in iteration order. Note this
 *      uses `ACA_RETRY_PRECEDENCE_TOLERANCE_MS`, NOT the much larger
 *      `ACA_START_TOLERANCE_MS` rule 1 uses -- see that constant's own doc
 *      comment for why a sibling-vs-sibling comparison needs a tighter
 *      window than an entry-vs-session comparison does. A candidate (be it
 *      `entry` itself or a sibling) is excluded from this comparison
 *      ENTIRELY -- a hard exclusion, not merely a losing tie-break -- the
 *      moment its own `dispatchedAt` is meaningfully after the session's
 *      `startedAt`: such a dispatch could not have produced a session that
 *      already existed before it was even made, regardless of how its raw
 *      `dispatchedAt` number compares to any other candidate's. Walking Bug
 *      B through this rule: sessionB (`startedAt` ~5500) is eligible against
 *      BOTH A (`dispatchedAt` 1000) and B (`dispatchedAt` 5000) -- both
 *      precede it -- and B is the closer/later preceding dispatch, so
 *      sessionB binds to B on the very first poll, independent of
 *      processing order. When sessionA (`startedAt` ~1200) later appears, B
 *      (`dispatchedAt` 5000) is excluded outright -- it is well AFTER
 *      sessionA's `startedAt`, not merely "further than the tolerance
 *      allows" but excluded regardless of A's own candidacy -- so A
 *      correctly claims sessionA. No swap.
 *
 *      A CLOSELY-SPACED retry (the reviewer-found regression this upper
 *      bound fixes): if B is instead dispatched only, say, 4 seconds after
 *      A (still inside `ACA_START_TOLERANCE_MS`'s 5-second window), and a
 *      session genuinely started 500ms after A's own dispatch -- i.e.
 *      BEFORE B was even dispatched -- the OLD code let B's `dispatchedAt`
 *      win this tie-break purely because it was numerically closer to the
 *      session's `startedAt`, even though B's dispatch had not happened yet
 *      when the session started. That session could only ever have been
 *      A's own job. The fix: B's `dispatchedAt` being after the session's
 *      `startedAt` (by more than `ACA_RETRY_PRECEDENCE_TOLERANCE_MS`)
 *      excludes B from this comparison outright, so A -- the only candidate
 *      whose dispatch actually precedes the session -- correctly wins.
 *
 *      Ties -- two sibling entries whose `dispatchedAt` are equally the
 *      closest preceding value for one candidate session -- are the
 *      genuinely ambiguous case the brief's "leave unknown, do not
 *      fabricate" instruction is actually about: there is no time-based
 *      way to prefer one over the other, so the session resolves to
 *      NEITHER of them (see the `closest.length > 1` branch below) rather
 *      than guessing. This is DIFFERENT from "two entries exist" (the
 *      ordinary retry case above, where one is unambiguously closer) --
 *      it only applies when neither sibling is a strictly better match
 *      than the other for this specific session.
 *
 * ON THE PRE-EXISTING "single ambiguous session, two same-issue entries"
 * TEST (`test/aca-dispatch-dialog-unit.js`): that test's ORIGINAL assertion
 * was that the OLDER of two same-issue entries wins a session either of
 * them could plausibly match, mirroring `DispatchTracker`'s own
 * oldest-dispatch-claims-first server-side tie-break. That assumption does
 * not survive this fix, and deliberately so: oldest-first was always a
 * fallback for when NOTHING ELSE distinguishes two candidates -- pure
 * iteration order, no real evidence either way. A session's own `startedAt`
 * IS real evidence about which dispatch actually produced it (closer in
 * time is more likely to be the actual cause), where "older entry" is not
 * evidence about the SESSION at all, only about the entries' own relative
 * age. Once time ordering is available (and it always is now), it is a
 * strictly better signal than an arbitrary convention, so the test was
 * updated to assert the CLOSEST-PRECEDING entry wins -- which, for that
 * test's own fixture, is the NEWER entry, not the older one. Genuine ties
 * (rule 2's `closest.length > 1` case, where closest-preceding cannot
 * distinguish either) still resolve to neither, preserving "do not
 * fabricate a guess" for the cases that are actually ambiguous.
 *
 * `claimedKeys`, when supplied, is the set of `sessionKey()` identities
 * already bound to some OTHER pending entry (see `syncAcaPending`) -- the
 * existing per-session contract identifier used everywhere else in this app
 * (pinning, starring: see `list.js`) -- rather than this file inventing a
 * second notion of session identity. A session already claimed is skipped,
 * so one real attach can only ever resolve one pending row.
 *
 * `allPending`, when supplied, is every pending entry currently being
 * resolved in this pass (`syncAcaPending` passes its own `order`) -- used to
 * find `entry`'s siblings (other unattached entries for the SAME repo+issue)
 * for rule 2 above. Defaults to treating `entry` as having no siblings
 * (`[entry]`) when omitted, which is what `acaPendingAttached`'s plain
 * single-entry yes/no check below does -- rule 1 (self time-ordering) still
 * applies even with no sibling awareness; only rule 2's cross-entry
 * tie-break needs the fuller list.
 */
export function acaPendingMatch(entry, groups = [], claimedKeys = null, allPending = null) {
  const want = String((entry && entry.repo) || '').toLowerCase();
  if (!want) return null;
  const wantIssue = entry && entry.issue != null ? Number(entry.issue) : null;
  if (!Number.isInteger(wantIssue)) return null; // nothing to prove correlation against

  // Every OTHER still-pending entry for this exact repo+issue, plus `entry`
  // itself -- the full set rule 2 needs to decide which of them a given
  // session's own startedAt most plausibly belongs to. See the function doc
  // above for why `allPending` is optional.
  const siblings = (allPending || [entry]).filter((e) => e && !e.attached
    && String((e && e.repo) || '').toLowerCase() === want
    && Number.isInteger(wantIssue) && e.issue != null && Number(e.issue) === wantIssue);
  if (!siblings.includes(entry)) siblings.push(entry);

  let best = null;
  for (const g of groups) {
    if (!g || !g.device || g.device.kind !== 'aca') continue;
    const meta = g.device.meta || null;
    if (!meta || !meta.repo || !meta.issue) continue; // no proof available -- never guessed
    const metaRepo = acaRepoName(meta.repo);
    if (!metaRepo || metaRepo.toLowerCase() !== want) continue;
    const metaIssue = Number(meta.issue);
    if (!Number.isInteger(metaIssue) || metaIssue !== wantIssue) continue;
    for (const s of g.sessions || []) {
      const key = sessionKey(s);
      if (claimedKeys && key && claimedKeys.has(key)) continue;
      const startedAt = s.startedAt || 0;

      // Rule 1 (Bug A): this session cannot be `entry`'s own job if it
      // started well before `entry` was even dispatched. This is the
      // standalone gate for `entry` itself -- not merely a special case of
      // rule 2 below, because rule 2 only ever compares `entry` against its
      // OTHER siblings (`others`, excluding `entry`): when `entry` has no
      // siblings at all (the common case -- a single dispatch, no retry),
      // rule 2 has nothing to compare against and would let anything
      // through on its own. Rule 1 is what actually kills Bug A in that
      // (overwhelmingly common) case.
      if (startedAt < (entry.dispatchedAt || 0) - ACA_START_TOLERANCE_MS) continue;

      // Rule 2 (Bug B): among `entry`'s OTHER same-repo-same-issue pending
      // siblings (a genuine retry), this session binds to whichever one has
      // the CLOSEST PRECEDING dispatchedAt -- not to `entry` merely because
      // `entry` happens to be who is asking. If some other sibling is a
      // strictly closer (later, but still time-eligible) preceding dispatch
      // than `entry`, `entry` loses this session to that sibling (handled
      // the next time THAT sibling is resolved, see `syncAcaPending`). If
      // another sibling ties `entry` exactly (equally the closest
      // preceding dispatch -- genuinely ambiguous, no time-based way to
      // prefer one over the other), this session resolves to NEITHER: no
      // fabricated guess, see the function doc above.
      const others = siblings.filter((e) => e !== entry);
      if (others.length) {
        // `precedes` is the hard exclusion this rule needs, reviewer-found
        // regression fix: a candidate (`entry` OR a sibling) whose OWN
        // `dispatchedAt` is meaningfully after THIS session's `startedAt`
        // cannot possibly be the dispatch that produced it, no matter how
        // numerically close its `dispatchedAt` is to `startedAt` -- that
        // closeness is exactly what let a same-issue retry dispatched only
        // a few seconds after an earlier one (inside
        // `ACA_START_TOLERANCE_MS`'s 5-second window, but AFTER a session
        // that had already started) wrongly outrank the earlier dispatch
        // for a session that could only ever have been the earlier one's
        // own job. `ACA_RETRY_PRECEDENCE_TOLERANCE_MS` (see its own doc
        // comment) is the tight single-process-clock allowance -- not
        // `ACA_START_TOLERANCE_MS`'s generous cross-process one -- that
        // decides "meaningfully after" here.
        const precedes = (e) => (e.dispatchedAt || 0) <= startedAt + ACA_RETRY_PRECEDENCE_TOLERANCE_MS;
        if (!precedes(entry)) continue; // entry's own dispatch happened after this session already started -- not a plausible owner at all
        const entryDispatchedAt = entry.dispatchedAt || 0;
        const otherEligible = others.filter(precedes);
        const maxOtherDispatchedAt = otherEligible.length
          ? Math.max(...otherEligible.map((e) => e.dispatchedAt || 0)) : -Infinity;
        if (maxOtherDispatchedAt >= entryDispatchedAt) continue; // a closer-or-tied sibling wins instead
      }

      if (!best || startedAt < best.startedAt) best = { key, startedAt };
    }
  }
  return best;
}

/**
 * Has this pending dispatch's own `aca-` device actually attached?
 *
 * A thin yes/no wrapper over `acaPendingMatch` with no exclusivity applied --
 * used directly only where a single entry is being checked in isolation (see
 * `test/aca-dispatch-dialog-unit.js`). `syncAcaPending` below calls
 * `acaPendingMatch` itself so it can track which session each entry claimed.
 */
export function acaPendingAttached(entry, groups = []) {
  return acaPendingMatch(entry, groups, null) !== null;
}
