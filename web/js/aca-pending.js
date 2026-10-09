// The "Queued on ACA" pending-row tracking, matching and rendering, split out
// of aca.js (#178) to stay under the per-module size budget (see
// test/package-unit.js's "no web/js file is anywhere near the old
// single-file size") -- the same reason #235 split device-detail.js out of
// devices.js.

import { state, api } from './api.js';
import { esc } from './util.js';
// Circular by necessity, the same way devices.js's own import of wiring.js is
// (see the comment there), and the same way aca.js's own import of devices.js
// is: `acaPendingRowHtml` below needs aca.js's pure link helpers, and aca.js's
// `submitAcaDispatch`/`wireAca` need `trackAcaDispatch`/`startAcaPolling` from
// here. Neither module touches the other at module-evaluation time, only
// from inside functions that run later, so the cycle resolves the same way
// any other two ES modules that call back into each other do.
import { acaStepsForStatus } from './aca.js';
import { acaPendingMatch } from './aca-match.js';
import { render } from './devices.js';


/** How long a `completed`-with-`success` Actions run may sit with no `aca-`
 * device having attached before this stops showing "Queued on ACA" and
 * surfaces an honest unknown/terminal outcome instead (#178's release-gate
 * review: "bound completed-success-without-attachment waiting ... instead
 * of polling forever"). A successful run finishing and an ACA job actually
 * registering with this hub are two different systems reporting in on two
 * different clocks -- some real gap between them is normal -- but an
 * unbounded one just means the row lies forever. 5 minutes is generous
 * against `ACA_POLL_MS`'s own 15-second cadence (20 polls) while still being
 * a bounded, visible ceiling rather than none at all. */
export const ACA_COMPLETED_WAIT_MS = 5 * 60 * 1000;

/** Has a completed-successfully run's bounded wait for an attach expired?
 * `Date.now()` is read here, and ONLY here -- the one shared place that
 * reads the clock, so both callers below (the render path and the
 * poll-exclusion path) can never silently disagree about "is this entry's
 * wait over yet", and a mutation or a unit test can still exercise
 * `acaStepsForStatus` itself against a fixed instant rather than real
 * elapsed time (see that function's own doc comment in aca.js). */
function acaWaitExpired(entry) {
  return !!(entry.completedAt && (Date.now() - entry.completedAt > ACA_COMPLETED_WAIT_MS));
}

/** The pending row's own markup -- a `.row`, same shape a real session row
 * uses (see `sessionRow` in list.js), so it sits in the list rather than
 * reading as a second kind of thing. Never clickable: there is no detail
 * view for a dispatch that has no session yet. */
export function acaPendingRowHtml(entry) {
  const view = acaStepsForStatus(entry.status, false, acaWaitExpired(entry));
  const stepsHtml = view.steps.map((s) => (
    `<span class="aca-step${s.done ? ' done' : ''}${s.current ? ' now' : ''}">${esc(s.label)}</span>`
  )).join('');
  const title = entry.issue ? `#${entry.issue} \u00b7 ${entry.repo}` : entry.repo;
  const failure = view.failureReason ? `<div class="row-meta aca-fail">${esc(view.failureReason)}</div>` : '';
  // A terminal outcome (`view.resolved`, the SAME single source of truth
  // `syncAcaPending` uses to stop polling this entry -- see acaStepsForStatus
  // in aca.js) still deserves a way back: the person may know the run was
  // retried, or simply want one more look, without this hub ever starting a
  // SECOND real job on their behalf. This button only ever re-marks the
  // entry unresolved and asks `syncAcaPending` to recheck it (wired in
  // wiring.js's delegated `#groups` click handler) -- never
  // `POST /api/aca/dispatch` again.
  const retry = view.resolved ? `<button type="button" class="ghost aca-retry" data-aca-retry="${esc(entry.localId)}">Check again</button>` : '';
  return `
    <div class="row aca-pending" data-local-id="${esc(entry.localId)}">
      <span class="star" aria-hidden="true"></span>
      <div class="row-main">
        <div class="row-title"><b>${esc(title)}</b></div>
        <div class="row-meta">${esc(entry.repo)}</div>
        <div class="aca-steps">${stepsHtml}</div>
        ${failure}
        ${retry}
      </div>
      <span class="status ${view.pillClass}">${esc(view.pillLabel)}</span>
    </div>`;
}

/** The "Queued on ACA" section of the session list (#178): every pending
 * dispatch not yet attached, in the Cloud tab and in All (an ACA execution
 * counts as Cloud, same rule the scope tabs already use) -- hidden on Local,
 * where it would just be noise about a job that cannot run there. Pure, so
 * the one meaningful rule here -- WHICH scopes show it -- can be proven
 * without a browser. */
export function acaPendingSectionHtml(pending = [], scope = 'all') {
  if (scope === 'local') return '';
  const visible = (pending || []).filter((p) => p && !p.attached);
  if (!visible.length) return '';
  return `
    <div class="group">
      <div class="group-head">Queued on ACA <span class="group-meta">${visible.length} job${visible.length === 1 ? '' : 's'}</span></div>
      <div class="card">${visible.map(acaPendingRowHtml).join('')}</div>
    </div>`;
}

let acaLocalIdSeq = 0;
/** Unlikely to collide (a counter plus the time), not cryptographic --
 * nothing security-sensitive is keyed on this, it only needs to be unique
 * among the handful of jobs one browser tab dispatches. */
function nextAcaLocalId() { acaLocalIdSeq += 1; return `aca-local-${Date.now()}-${acaLocalIdSeq}`; }

/** Begin tracking a dispatch this browser tab just made, so it can show as a
 * "Queued on ACA" row until its own device attaches (#178). In-memory only
 * and per-tab, same durability posture `DispatchTracker` itself documents --
 * a reload loses the row, not the dispatch, which the hub still knows about.
 *
 * `trackerId` is this hub's own stable identity for the dispatch, straight
 * from the `POST /api/aca/dispatch` response (`hub-service.js`'s
 * `DispatchTracker.record`). Binding to it directly is what lets
 * `syncAcaPending` below look this entry's status up by id -- never by
 * re-guessing "the newest unclaimed record for this repository", which two
 * racing dispatches on the same repository could resolve to each other's
 * record (#178's release-gate review). */
export function trackAcaDispatch({
  repo, issue, runUrl, trackerId,
}) {
  state.acaPending = state.acaPending || [];
  state.acaPending.push({
    localId: nextAcaLocalId(), repo, issue: issue || null, runUrl: runUrl || null,
    dispatchedAt: Date.now(), owner: repo.split('/')[0], name: repo.split('/')[1],
    trackerId: trackerId || null, status: null, attached: false,
    // When this entry's status is last observed as `completed`, the moment
    // it was FIRST observed that way -- used to bound how long "completed
    // successfully but no session has attached yet" is still shown as
    // "Queued on ACA" before surfacing an honest unknown/terminal outcome
    // instead of polling forever (see acaStepsForStatus in aca.js and the
    // release-gate review). Cleared if status ever reports something other
    // than `completed` again (a status flap), so the window always measures
    // from the most recent completion.
    completedAt: null,
    // The sessionKey() of whichever aca- session this entry resolved to,
    // once acaPendingMatch finds one -- kept even after attached so a LATER
    // still-pending entry (a second dispatch on the same repository) can
    // never claim the same already-attached session for itself too, see
    // syncAcaPending below.
    matchedKey: null,
    // Set by syncAcaPending once this entry's outcome is TERMINAL (a failed
    // dispatch, a non-success conclusion, or a completed-success run whose
    // attach wait expired -- see acaStepsForStatus's `resolved` field, the
    // one place this is actually decided). Once true, syncAcaPending stops
    // fetching `GET /api/aca/dispatches` for this entry forever -- there is
    // nothing left this hub can learn by asking again, short of the retry
    // affordance (`retryAcaPending` below) explicitly asking once more.
    resolved: false,
  });
}

/**
 * Refresh every tracked-but-unresolved dispatch (#178): called once from
 * `refresh()` (ws.js, itself event-driven rather than on a timer), and again
 * every `ACA_POLL_MS` by the interval `startAcaPolling` below starts.
 *
 * Costs NOTHING when there is nothing pending: a fresh page load starts with
 * an empty `state.acaPending` (it is per-tab, never fetched on load -- see
 * `trackAcaDispatch`), so this returns before ever calling
 * `GET /api/aca/dispatches`. That is deliberate: it is what keeps a hub with
 * no GitHub App configured from ever hitting that 501 on an ordinary load,
 * the exact failure mode #233 broke CI with.
 *
 * Also costs nothing once every tracked entry is either `attached` or
 * terminally `resolved` (an errored/failed/unknown-outcome row -- see
 * acaStepsForStatus's `resolved` field in aca.js): the fetch below is
 * skipped for exactly the same reason, so a tab left open after every job it
 * ever dispatched has either attached or given its final honest answer never
 * touches `/api/aca/dispatches` again, even though `startAcaPolling`'s own
 * interval keeps ticking for the lifetime of the tab.
 */
export async function syncAcaPending() {
  state.acaPending = state.acaPending || [];
  const groups = (state.overview && state.overview.groups) || [];

  // Every session already bound to an entry -- including entries resolved on
  // an earlier call to this function -- so a session can never be claimed
  // twice: not by two pending entries in the same pass, and not by a LATER
  // pending entry on a later pass either, once something else has already
  // claimed it. This loop, and `acaPendingMatch` underneath it, is entirely
  // synchronous -- so two "overlapping" calls to this function (the 15s
  // interval firing while an earlier call is still awaiting
  // `GET /api/aca/dispatches` below) can never both claim the same session:
  // whichever call's synchronous portion runs first finishes marking
  // entries `attached` before yielding control at its own `await`, so the
  // second call always sees the up-to-date `matchedKey` set.
  //
  // `order` (every still-unattached entry) is also `acaPendingMatch`'s own
  // `allPending` -- the full sibling set it needs to tell two same-issue
  // retries apart by CLOSEST PRECEDING `dispatchedAt` rather than by which
  // one happens to be processed first (see that function's own doc comment,
  // "Bug B"). Iteration order no longer decides who wins a shared session,
  // so this no longer needs to be oldest-first for correctness -- sorted by
  // `dispatchedAt` anyway, for a stable/debuggable processing order.
  const claimedKeys = new Set(
    state.acaPending.filter((e) => e.matchedKey).map((e) => e.matchedKey),
  );
  const order = [...state.acaPending].filter((e) => !e.attached)
    .sort((a, b) => (a.dispatchedAt || 0) - (b.dispatchedAt || 0));
  for (const entry of order) {
    const match = acaPendingMatch(entry, groups, claimedKeys, order);
    if (match) {
      entry.attached = true;
      entry.matchedKey = match.key;
      if (match.key) claimedKeys.add(match.key);
    }
  }

  // Unattached AND not yet terminally resolved -- the only entries left
  // that polling `GET /api/aca/dispatches` could still usefully change.
  const pending = state.acaPending.filter((e) => !e.attached && !e.resolved);
  if (!pending.length) return;

  let dispatches;
  try {
    ({ dispatches } = await api('/api/aca/dispatches'));
  } catch {
    // A 429, a dropped connection, or (once a hub's App is de-configured
    // mid-session) a 501: none of these are reported to the user here --
    // this is a background refresh, and the row simply keeps its last known
    // status until the next successful poll.
    return;
  }

  // Bound by `trackerId` ONLY -- the stable id this entry's own
  // `POST /api/aca/dispatch` response returned (see `trackAcaDispatch`).
  // An entry with no `trackerId` (a hub too old to have sent one, or a
  // dispatch made before this field existed) has nothing authoritative to
  // bind to and is left with no status, rather than falling back to the
  // repository-and-recency guess this replaces -- the exact swap #178's
  // release-gate review found two racing same-repo dispatches could trigger.
  const byId = new Map((dispatches || []).map((d) => [d.id, d]));
  for (const entry of pending) {
    if (!entry.trackerId) continue;
    const d = byId.get(entry.trackerId);
    if (!d) continue;
    entry.status = d.status;
    const completed = !!(d.status && d.status.state === 'completed');
    if (completed) {
      if (!entry.completedAt) entry.completedAt = Date.now();
    } else {
      entry.completedAt = null;
    }
    // The SAME function the render path uses (acaStepsForStatus, aca.js),
    // fed the SAME waitExpired computation (acaWaitExpired, above) -- never
    // a second, hand-maintained copy of "is this terminal" that could
    // silently disagree with what the row itself shows.
    entry.resolved = !!acaStepsForStatus(entry.status, false, acaWaitExpired(entry)).resolved;
  }
}

/**
 * Force exactly ONE re-check of a single terminally-resolved entry (the
 * "Check again" button `acaPendingRowHtml` shows once `resolved` is true) --
 * never a new dispatch. Re-marks only THIS entry unresolved so the very next
 * `syncAcaPending` call includes it in its `GET /api/aca/dispatches` fetch;
 * every OTHER already-resolved entry stays excluded, so clicking one row's
 * retry can never resume polling for every row this tab has ever resolved.
 * If nothing has actually changed upstream, `syncAcaPending` simply marks it
 * `resolved` again from the same evidence -- an honest no-op, not a retry
 * that silently never terminates.
 */
export async function retryAcaPending(localId) {
  const entry = (state.acaPending || []).find((e) => e.localId === localId);
  if (!entry || entry.attached) return;
  entry.resolved = false;
  await syncAcaPending();
}


/** How often a pending dispatch is rechecked while one exists (#178).
 *
 * Most of this app IS WS-push driven -- `ws.js`'s `onmessage` calls
 * `render()` straight off an `overview` push -- and that is genuinely how
 * devices and sessions update here, because a device's own socket tells the
 * hub the instant something changes. That said, this is NOT the only timer
 * in the client: `web/app.js` (line ~176, in `main()`) already runs its own
 * unrelated `setInterval(refresh, 15000)` that has existed since before this
 * feature, polling the whole `/api/overview` for the lifetime of every tab
 * regardless of ACA dispatch state. The interval below is a SEPARATE,
 * ACA-specific one, needed for a reason `app.js`'s own poll does not cover:
 * nothing pushes a message purely because a GitHub Actions run's status
 * moved from queued to in_progress, `DispatchTracker` only ever learns that
 * by being ASKED (`GET /api/aca/dispatches`). Without a timer of its own, a
 * pending row would sit on "Dispatched" forever unless the person happened
 * to trigger an unrelated `refresh()` (a filter change, a reconnect) --
 * neither `app.js`'s poll nor a WS push ever calls `syncAcaPending` for its
 * own reasons, so this interval is what actually advances it.
 *
 * Still costs nothing while idle: `syncAcaPending` returns before any
 * network call whenever nothing is pending OR every pending entry is
 * `attached`/terminally `resolved` -- the gate below short-circuits before
 * even calling it, so this keeps firing forever but stops doing anything the
 * moment there is nothing left to learn (see `syncAcaPending` and the #233
 * note on `refresh()`). 15s keeps this well under the 30/min read limit
 * (#213) even stacked with `refresh()`'s own call to the same endpoint.
 */
const ACA_POLL_MS = 15000;

/** Start the interval above. Called once, from `wireAca()` (aca.js). */
export function startAcaPolling() {
  setInterval(async () => {
    if (!(state.acaPending && state.acaPending.some((e) => !e.attached && !e.resolved))) return;
    await syncAcaPending();
    render();
  }, ACA_POLL_MS);
}
