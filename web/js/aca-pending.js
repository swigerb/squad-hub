// The "Queued on ACA" pending-row tracking and rendering, split out of
// aca.js (#178) to stay under the per-module size budget (see
// test/package-unit.js's "no web/js file is anywhere near the old
// single-file size") -- the same reason #235 split device-detail.js out of
// devices.js.

import { state, api } from './api.js';
import { esc, toast } from './util.js';
// Circular by necessity, the same way devices.js's own import of wiring.js is
// (see the comment there), and the same way aca.js's own import of devices.js
// is: `acaPendingRowHtml` below needs aca.js's `acaStepsForStatus`, and aca.js's
// `submitAcaDispatch`/`wireAca` need `trackAcaDispatch`/`startAcaPolling` from
// here. Neither module touches the other at module-evaluation time, only
// from inside functions that run later, so the cycle resolves the same way
// any other two ES modules that call back into each other do.
import { acaStepsForStatus } from './aca.js';
import { acaDispatchEvidence, acaPendingMatch } from './aca-match.js';
import { render } from './devices.js';


/** How long a run may sit with a CONFIRMED execution (or, with none, a
 * `completed`/`success` run) and no matching device attached before the row
 * stops saying "Queued on ACA" and reports an honest "Unknown outcome" (#178's
 * release-gate review: bound the wait, never poll forever). 5 minutes is
 * generous against `ACA_POLL_MS`'s 15s cadence (20 polls). */
export const ACA_COMPLETED_WAIT_MS = 5 * 60 * 1000;

/** The overall ceiling from `dispatchedAt`, for a row that never gets as far
 * as a confirmed execution or a completed run (a run stuck queued, a receipt
 * that never lands). The hub itself gives up on an unmatched dispatch after an
 * hour, so this only bites when the hub keeps answering something in flight. */
export const ACA_MAX_PENDING_MS = 90 * 60 * 1000;

/** Has this entry's bounded wait run out? `Date.now()` is read here, and ONLY
 * here -- the one shared place, so the render path and the poll-exclusion
 * path can never disagree about "is this entry's wait over yet". */
export function acaWaitExpired(entry) {
  const now = Date.now();
  const since = entry.confirmedAt || entry.completedAt;
  if (since && now - since > ACA_COMPLETED_WAIT_MS) return true;
  return !!(entry.dispatchedAt && now - entry.dispatchedAt > ACA_MAX_PENDING_MS);
}

/** The one view of an entry, shared by rendering and the poll-exclusion
 * logic -- never a second hand-maintained notion of "is this terminal". */
function acaEntryView(entry) {
  return acaStepsForStatus(entry.status, false, acaWaitExpired(entry), entry.executionName);
}

/** The pending row's own markup -- a `.row`, same shape a real session row
 * uses (see `sessionRow` in list.js), so it sits in the list rather than
 * reading as a second kind of thing. Never clickable: there is no detail
 * view for a dispatch that has no session yet. */
export function acaPendingRowHtml(entry) {
  const view = acaEntryView(entry);
  const stepsHtml = view.steps.map((s) => (
    `<span class="aca-step${s.done ? ' done' : ''}${s.current ? ' now' : ''}">${esc(s.label)}</span>`
  )).join('');
  const title = entry.issue ? `#${entry.issue} \u00b7 ${entry.repo}` : entry.repo;
  const failure = view.failureReason ? `<div class="row-meta aca-fail">${esc(view.failureReason)}</div>` : '';
  // A terminal outcome (`view.resolved`) still deserves a way back: the person
  // may know the run was retried, or want one more look. This button only ever
  // re-marks the entry unresolved and asks `syncAcaPending` to recheck it
  // (wired in wiring.js's delegated `#groups` click handler) -- never
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

/** Begin tracking a dispatch this browser tab just made, so it shows as a
 * "Queued on ACA" row until its own job's device attaches (#178). In-memory
 * and per-tab, the same durability posture `DispatchTracker` documents -- a
 * reload loses the row, not the dispatch, which the hub still knows about.
 *
 * `trackerId` is the hub's own stable identity for the dispatch, straight from
 * the `POST /api/aca/dispatch` response. Everything below binds by it, never
 * by re-guessing "the newest record for this repository" (two racing
 * dispatches on one repository could resolve to each other's record). */
export function trackAcaDispatch({
  repo, issue, runUrl, trackerId,
}) {
  state.acaPending = state.acaPending || [];
  state.acaPending.push({
    localId: nextAcaLocalId(), repo, issue: issue || null, runUrl: runUrl || null,
    dispatchedAt: Date.now(), owner: repo.split('/')[0], name: repo.split('/')[1],
    trackerId: trackerId || null, status: null, attached: false,
    // The hub's own Actions run binding and the hub-confirmed execution for
    // the CURRENT run attempt (see aca-match.js's `acaDispatchEvidence`).
    // `executionName` is what the join to the job's `aca-` device id needs.
    runId: null, runAttempt: null, executionName: null, deviceId: null,
    // When the status was first seen `completed`, and when the execution was
    // first confirmed: the starts of the bounded waits (`acaWaitExpired`).
    completedAt: null, confirmedAt: null,
    // Set once the outcome is TERMINAL (`resolved` in `acaStepsForStatus`).
    // `syncAcaPending` then stops fetching for this entry, short of the
    // explicit `retryAcaPending`.
    resolved: false,
  });
}

/**
 * Attach every tracked dispatch whose job's own device is now in
 * `state.overview.devices` (#178): a local, request-free check, run before
 * any network call and from the WS overview push and `refresh()`, so the
 * pending row is replaced by the real session the moment the device
 * appears. Returns true when anything attached. `attached` is sticky: it is
 * only ever set here, from the proven identity in `acaPendingMatch`.
 */
export function acaAttachFromOverview() {
  const entries = state.acaPending || [];
  const devices = (state.overview && state.overview.devices) || [];
  let changed = false;
  for (const entry of entries) {
    if (entry.attached) continue;
    const device = acaPendingMatch(entry, devices, entries);
    if (!device) continue;
    entry.attached = true;
    entry.deviceId = device.deviceId;
    entry.resolved = false;
    changed = true;
  }
  return changed;
}

/** Re-derive `resolved` for every entry not attached (and, unless `all`, not
 * being force-rechecked) from what is ALREADY known locally. */
function acaResolveLocally(all, includeForced) {
  for (const entry of all) {
    if (entry.attached || (!includeForced && entry.forceRecheck)) continue;
    entry.resolved = !!acaEntryView(entry).resolved;
  }
}

async function acaSyncOnce() {
  state.acaPending = state.acaPending || [];
  const all = state.acaPending;

  // OFFLINE BOUND: `resolved` is decided from local knowledge BEFORE any
  // network call, so a dropped connection, a 429 or a de-configured App can
  // never EXTEND an already-expired wait and keep a tab fetching forever.
  // `forceRecheck` (set by `retryAcaPending`) skips this one step for the
  // entry a person just asked to recheck, so the request they asked for is
  // still attempted.
  acaAttachFromOverview();
  acaResolveLocally(all, false);
  const forced = all.filter((e) => e.forceRecheck);
  if (!all.some((e) => !e.attached && !e.resolved)) return;

  let dispatches = null;
  try {
    ({ dispatches } = await api('/api/aca/dispatches'));
  } catch {
    // A 429, a dropped connection, or a de-configured App (501): handled
    // below, never swallowed, and never left to re-poll an expired entry.
    dispatches = null;
  }
  // The recheck each forced entry asked for was attempted, success or not.
  for (const entry of forced) delete entry.forceRecheck;

  if (!Array.isArray(dispatches)) {
    acaResolveLocally(all, true);
    for (const entry of forced) {
      if (!entry.resolved) continue;
      // Best-effort: a DOM-less harness has no `#toast`, and this purely
      // cosmetic notice must never break the state restore above.
      try { toast(`Could not refresh "${entry.repo}" -- showing its last known status.`); } catch { /* no DOM here */ }
    }
    return;
  }

  const byId = new Map(dispatches.map((d) => [d && d.id, d]));
  for (const entry of all) {
    if (entry.attached || entry.resolved) continue;
    const ev = acaDispatchEvidence(entry, byId.get(entry.trackerId));
    if (!ev) continue;
    const named = entry.executionName;
    if (entry.runAttempt != null && ev.runAttempt !== entry.runAttempt) entry.completedAt = null;
    Object.assign(entry, ev);
    if (ev.status && ev.status.state === 'completed') {
      if (!entry.completedAt) entry.completedAt = Date.now();
    } else {
      entry.completedAt = null;
    }
    if (!entry.executionName) entry.confirmedAt = null;
    else if (entry.executionName !== named) entry.confirmedAt = Date.now();
    entry.resolved = !!acaEntryView(entry).resolved;
  }
  acaAttachFromOverview();
}

let acaSyncRun = null;
let acaSyncAgain = false;

/**
 * Refresh every tracked-but-unresolved dispatch (#178): called from
 * `refresh()` (ws.js) and every `ACA_POLL_MS` by `startAcaPolling` below.
 *
 * Free when there is nothing to learn: with nothing pending, or every entry
 * `attached` or terminally `resolved`, it returns before any request -- so a
 * fresh load (per-tab, nothing tracked) and a hub with no GitHub App never
 * touch `GET /api/aca/dispatches` here (#233).
 *
 * Overlapping calls (a refresh landing while a poll is in flight) COALESCE:
 * at most one request runs at a time, and a call that arrives meanwhile asks
 * for exactly one more pass afterwards, so a reply can never be overwritten by
 * an older one and the 30/min read limit (#213) is never stacked.
 */
export function syncAcaPending() {
  if (acaSyncRun) {
    acaSyncAgain = true;
    return acaSyncRun;
  }
  acaSyncRun = (async () => {
    try {
      do {
        acaSyncAgain = false;
        await acaSyncOnce();
      } while (acaSyncAgain);
    } finally {
      acaSyncRun = null;
    }
  })();
  return acaSyncRun;
}

/**
 * Force exactly ONE re-check of a single terminally-resolved entry (the
 * "Check again" button `acaPendingRowHtml` shows once `resolved` is true) --
 * never a new dispatch. Re-marks only THIS entry unresolved, and sets
 * `forceRecheck` so the next pass's local-resolve step does not flip it
 * straight back before the request this click asks for is made; every OTHER
 * resolved entry stays excluded. It only ever issues the same read-only
 * `GET /api/aca/dispatches` the normal poll uses. If that fails,
 * `syncAcaPending` restores the previous terminal state from local knowledge
 * and toasts -- it never leaves the entry unresolved to auto-retry forever.
 */
export async function retryAcaPending(localId) {
  const entry = (state.acaPending || []).find((e) => e.localId === localId);
  if (!entry || entry.attached) return;
  entry.resolved = false;
  entry.forceRecheck = true;
  await syncAcaPending();
}


/** How often a pending dispatch is rechecked while one exists (#178). Most of
 * this app is WS-push driven, but nothing pushes a message when a GitHub
 * Actions run moves from queued to in_progress or publishes its execution
 * receipt: `DispatchTracker` only learns that by being ASKED. So this
 * ACA-specific interval (separate from `app.js`'s own overview poll) is what
 * advances a pending row. It costs nothing once nothing is left to learn (the
 * gate below), and 15s keeps it well under the 30/min read limit (#213). */
const ACA_POLL_MS = 15000;

/** Start the interval above. Called once, from `wireAca()` (aca.js). */
export function startAcaPolling() {
  setInterval(async () => {
    if (!(state.acaPending && state.acaPending.some((e) => !e.attached && !e.resolved))) return;
    await syncAcaPending();
    render();
  }, ACA_POLL_MS);
}
