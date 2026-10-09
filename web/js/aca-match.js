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
 *   Bug A -- a session can bind to a STALE historical dispatch, or to an
 *   entry dispatched well AFTER the session itself already started.
 *   `state.overview.groups` is not per-tab, it is whatever the hub currently
 *   knows about, including an `aca-` session from hours or days ago, now
 *   offline or completed, left over from an earlier unrelated dispatch that
 *   happened to target the same issue. Nothing about repo+issue alone can
 *   tell that session apart from a genuinely-fresh one, or prevent a session
 *   from being credited to a dispatch that was made after it already ran.
 *
 *   Bug B -- a same-issue RETRY (or a second, independent tab dispatching
 *   the same issue, see "cross-tab siblings" below) can be credited to the
 *   WRONG attempt. Two reviews on this exact function (see below) each found
 *   that ranking same-issue siblings by how numerically CLOSE their own
 *   `dispatchedAt` is to the session's `startedAt` is not proof of which
 *   dispatch actually produced the session -- it is a coin flip that happens
 *   to look plausible. Concretely: dispatch A at `dispatchedAt=10000` genuinely
 *   produces a session that does not start until `startedAt=25000` (a slow
 *   runner-claim or cold start); dispatch B, an unrelated later retry or a
 *   different tab's dispatch for the same issue, goes out at
 *   `dispatchedAt=20000`. Ranking by closeness to 25000 picks B (closer),
 *   not A (correct) -- proximity and provenance are different facts, and
 *   conflating them produces a confident, wrong answer instead of an honest
 *   "unknown".
 *
 * THE FIX, per the explicit direction on issue #178's follow-up review:
 * repo+issue is not dispatch-attempt identity, and TIME-ORDER PROXIMITY is
 * not proof of attempt identity either; require authoritative data when
 * available (never invent a new workflow_dispatch input the target workflow
 * would have to declare, and never invent a mapping between
 * `meta.executionName`/`meta.jobName` -- free text a SEPARATE codebase
 * chooses to report -- and a GitHub Actions run id: neither is proven, both
 * would be exactly the "fabricate mapping" the brief forbids); leave
 * ambiguous/unprovable attach unknown rather than guess. The two rules below
 * are deliberately the ONLY facts this hub treats as proof:
 *
 *   1. A session can never belong to a dispatch made AFTER the session
 *      itself already started (`session.startedAt` must be no earlier than
 *      `entry.dispatchedAt - ACA_START_TOLERANCE_MS`). This alone kills the
 *      "stale historical session" half of Bug A: an ancient historical
 *      session's `startedAt` long predates a freshly-created entry's
 *      `dispatchedAt`, so it is excluded outright, regardless of whether the
 *      device that reported it is currently online, stale, or its session
 *      has since completed -- none of that changes how long ago it STARTED,
 *      which is the one fact this check reads.
 *
 *   2. When more than one PENDING entry shares the same repo+issue -- a
 *      same-issue retry, OR a sibling dispatch this tab has never locally
 *      tracked but the server knows about (see "cross-tab siblings" below)
 *      -- a session that is independently rule-1-eligible for MORE THAN ONE
 *      of those siblings has no time-based way to prove which one actually
 *      produced it. Earlier revisions of this function tried to break that
 *      tie by ranking siblings on how closely their `dispatchedAt` preceded
 *      `startedAt`; two separate reviews (see the dated findings below)
 *      proved that ranking wrong on realistic timings. There is no
 *      replacement ranking that is actually proof rather than a guess, so
 *      there is no ranking at all: an ambiguous session matches NEITHER
 *      sibling, and every affected row stays pending until an authoritative
 *      fact (the device's own verified run/execution identity, if
 *      squad-on-aca ever reports one) resolves it, or until the siblings'
 *      own wait bounds expire and they are reported as an honest unknown
 *      outcome (see `aca-pending.js`'s `ACA_COMPLETED_WAIT_MS`).
 *
 * REVIEW HISTORY on this function's rule 2 (kept so the next change does not
 * reintroduce either mistake):
 *
 *   - An original version ranked eligible siblings by raw closeness to
 *     `startedAt`, with no before/after distinction. A reviewer found this
 *     let a dispatch that happened AFTER a session had already started still
 *     outrank the dispatch that genuinely preceded and produced it, whenever
 *     two same-issue retries landed close together.
 *   - A revision added an at-or-before/after-start distinction plus a
 *     tighter "closest preceding" tie-break among same-side candidates. A
 *     LATER review (the one this rewrite responds to) proved that revision
 *     still wrong: a genuinely-owning dispatch that simply started slowly
 *     (A, `dispatchedAt=10000`, real session `startedAt=25000`) lost to an
 *     unrelated later dispatch (B, `dispatchedAt=20000`) purely because B's
 *     `dispatchedAt` was numerically closer to 25000 -- proximity is not
 *     proof of causation. The same review found the fresh-tab/cross-tab case
 *     below independently broken for the same underlying reason: nothing
 *     about "closest" is actually about identity.
 *   - This rewrite removes the ranking entirely. Ambiguous means pending,
 *     full stop; no tolerance constant is reused as a disambiguation tool.
 *
 * CROSS-TAB SIBLINGS: `state.acaPending` is created fresh, per browser tab,
 * every page load (see `trackAcaDispatch`) -- it has no memory of a dispatch
 * made from a DIFFERENT tab (or a different device entirely) signed in as
 * the same person. `GET /api/aca/dispatches` is scoped per authenticated
 * user, not per tab, so it is the one authoritative source that already
 * knows about every dispatch this user has made recently, including ones
 * this tab never tracked locally. `aca-pending.js`'s `syncAcaPending` builds
 * `allPending` from that full per-user list (not merely this tab's own
 * `state.acaPending`) specifically so rule 2 above can see an unseen other
 * tab's sibling dispatch for the same issue and correctly treat an otherwise
 * "only candidate I know of" session as ambiguous, rather than this tab
 * falsely attaching its own row to a session that actually belongs to the
 * other tab's dispatch.
 *
 * `claimedKeys`, when supplied, is the set of `sessionKey()` identities
 * already bound to some OTHER pending entry (see `syncAcaPending`) -- the
 * existing per-session contract identifier used everywhere else in this app
 * (pinning, starring: see `list.js`) -- rather than this file inventing a
 * second notion of session identity. A session already claimed is skipped,
 * so one real attach can only ever resolve one pending row.
 *
 * `allPending`, when supplied, is every pending entry currently being
 * resolved in this pass (`syncAcaPending` passes its own enriched list,
 * including cross-tab siblings) -- used to find `entry`'s siblings (other
 * unattached entries for the SAME repo+issue) for rule 2 above. Defaults to
 * treating `entry` as having no siblings (`[entry]`) when omitted, which is
 * what `acaPendingAttached`'s plain single-entry yes/no check below does --
 * rule 1 (self time-ordering) still applies even with no sibling awareness;
 * only rule 2's ambiguity check needs the fuller list.
 */
export function acaPendingMatch(entry, groups = [], claimedKeys = null, allPending = null) {
  const want = String((entry && entry.repo) || '').toLowerCase();
  if (!want) return null;
  const wantIssue = entry && entry.issue != null ? Number(entry.issue) : null;
  if (!Number.isInteger(wantIssue)) return null; // nothing to prove correlation against

  // Every OTHER still-pending, still-ACTIVE entry for this exact repo+issue --
  // the set rule 2 needs to detect genuine ambiguity against `entry`. See the
  // function doc above for why `allPending` is optional and why it may
  // include cross-tab siblings this tab never tracked locally. A sibling
  // that has already reached its own TERMINAL `resolved` state (a
  // failed/errored run, or a completed-success run whose attach wait already
  // expired -- see `aca-pending.js`'s `ACA_COMPLETED_WAIT_MS`) has already
  // given its own final, honest answer and is no longer a live competitor
  // for a session that only now appears: it cannot silently keep blocking a
  // still-active sibling from claiming its own genuinely-arriving device
  // purely because it technically remains rule-1-eligible forever (rule 1
  // has no upper bound on how long a slow job may take to start). `entry`
  // itself is deliberately excluded here regardless of its own `resolved`
  // state -- it is never its OWN sibling -- so an explicit "Check again"
  // recheck (`retryAcaPending`, which resets `entry.resolved` to `false`
  // before calling this) is never blocked by this filter either way.
  const others = (allPending || []).filter((e) => e && e !== entry && !e.attached && !e.resolved
    && String((e && e.repo) || '').toLowerCase() === want
    && Number.isInteger(wantIssue) && e.issue != null && Number(e.issue) === wantIssue);

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
      // siblings at all (the common case -- a single dispatch, no retry, no
      // unseen cross-tab sibling), rule 2 has nothing to compare against and
      // would let anything through on its own. Rule 1 is what actually kills
      // Bug A in that (overwhelmingly common) case.
      if (startedAt < (entry.dispatchedAt || 0) - ACA_START_TOLERANCE_MS) continue;

      // Rule 2 (Bug B): if this session is ALSO rule-1-eligible for any
      // OTHER same-repo-same-issue sibling (a genuine retry, or a dispatch
      // from a tab/device this one never tracked locally), time alone cannot
      // prove which of them actually owns it -- see the function doc above
      // for why no proximity-based ranking is used to break this tie. The
      // session matches neither; the row stays pending.
      if (others.some((e) => startedAt >= (e.dispatchedAt || 0) - ACA_START_TOLERANCE_MS)) continue;

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
