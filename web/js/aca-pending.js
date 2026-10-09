// The "Queued on ACA" pending-row tracking, matching and rendering, split out
// of aca.js (#178) to stay under the per-module size budget (see
// test/package-unit.js's "no web/js file is anywhere near the old
// single-file size") -- the same reason #235 split device-detail.js out of
// devices.js.

import { state, api } from './api.js';
import { esc } from './util.js';
// `sessionKey` is the one identifier the rest of this app already uses to
// mean "this exact session, not merely this repository" (pinning, starring --
// see list.js). Reusing it here is what lets acaPendingMatch below tell two
// pending dispatches on the same repository apart instead of inventing a
// second notion of session identity just for this file.
import { sessionKey } from './list.js';
// Circular by necessity, the same way devices.js's own import of wiring.js is
// (see the comment there), and the same way aca.js's own import of devices.js
// is: `acaPendingMatch`/`acaPendingRowHtml` below need aca.js's pure link
// helpers, and aca.js's `submitAcaDispatch`/`wireAca` need `trackAcaDispatch`/
// `startAcaPolling` from here. Neither module touches the other at
// module-evaluation time, only from inside functions that run later, so the
// cycle resolves the same way any other two ES modules that call back into
// each other do.
import { acaRepoName, acaStepsForStatus } from './aca.js';
import { render } from './devices.js';

/**
 * The best still-unclaimed `aca`-kind session matching this pending
 * dispatch's repository, or `null` -- the earliest-started one, so that when
 * more than one qualifies the SAME dispatch/attach ordering the server side
 * already uses (`DispatchTracker._resolveOrder`'s "earliest dispatch claims
 * the earliest eligible run") applies here too.
 *
 * Checked against `state.overview.groups` -- the same WS-pushed data every
 * other list on this page already renders from -- rather than a dedicated
 * lookup, so this never costs an extra request of its own: a device's WS
 * message updates `state.overview` and calls `render()` the instant it
 * attaches, no poll required. A candidate is a session on a device of kind
 * `aca` whose own checkout is the SAME repository this dispatch targeted,
 * started no earlier than the dispatch itself (with two minutes of slack for
 * clock drift between this browser and the device) -- the same tolerance
 * style `resolveRunStatus` uses server-side for the same reason.
 *
 * THE REPOSITORY ALONE IS NOT A SAFE MATCH, and this is the one place that
 * matters: a hub user can have two dispatches queued on the same repository
 * at once (two issues, dispatched minutes apart), or an unrelated/
 * pre-existing `aca-` session can already be running against it. Matching on
 * repository and timing alone would let BOTH pending rows -- or a row that
 * has nothing to do with this dispatch -- resolve the instant any ONE
 * matching session appeared. `claimedKeys`, when supplied, is the set of
 * `sessionKey()` identities already bound to some OTHER pending entry (see
 * `syncAcaPending`) -- the existing per-session contract identifier used
 * everywhere else in this app (pinning, starring: see `list.js`) -- rather
 * than this file inventing a second notion of session identity. A session
 * already claimed is skipped, so one real attach can only ever resolve one
 * pending row.
 */
export function acaPendingMatch(entry, groups = [], claimedKeys = null) {
  const want = String((entry && entry.repo) || '').toLowerCase();
  if (!want) return null;
  const floor = (entry.dispatchedAt || 0) - (2 * 60 * 1000);
  let best = null;
  for (const g of groups) {
    if (!g || !g.device || g.device.kind !== 'aca') continue;
    for (const s of g.sessions || []) {
      const repo = s && s.git && s.git.repository ? acaRepoName(s.git.repository) : null;
      if (!repo || repo.toLowerCase() !== want) continue;
      const startedAt = s.startedAt || 0;
      if (startedAt < floor) continue;
      const key = sessionKey(s);
      if (claimedKeys && key && claimedKeys.has(key)) continue;
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

/** The pending row's own markup -- a `.row`, same shape a real session row
 * uses (see `sessionRow` in list.js), so it sits in the list rather than
 * reading as a second kind of thing. Never clickable: there is no detail
 * view for a dispatch that has no session yet. */
export function acaPendingRowHtml(entry) {
  const view = acaStepsForStatus(entry.status, false);
  const stepsHtml = view.steps.map((s) => (
    `<span class="aca-step${s.done ? ' done' : ''}${s.current ? ' now' : ''}">${esc(s.label)}</span>`
  )).join('');
  const title = entry.issue ? `#${entry.issue} \u00b7 ${entry.repo}` : entry.repo;
  const failure = view.failureReason ? `<div class="row-meta aca-fail">${esc(view.failureReason)}</div>` : '';
  return `
    <div class="row aca-pending" data-local-id="${esc(entry.localId)}">
      <span class="star" aria-hidden="true"></span>
      <div class="row-main">
        <div class="row-title"><b>${esc(title)}</b></div>
        <div class="row-meta">${esc(entry.repo)}</div>
        <div class="aca-steps">${stepsHtml}</div>
        ${failure}
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
 * a reload loses the row, not the dispatch, which the hub still knows about. */
export function trackAcaDispatch({ repo, issue, runUrl }) {
  state.acaPending = state.acaPending || [];
  state.acaPending.push({
    localId: nextAcaLocalId(), repo, issue: issue || null, runUrl: runUrl || null,
    dispatchedAt: Date.now(), owner: repo.split('/')[0], name: repo.split('/')[1],
    trackerId: null, status: null, attached: false,
    // The sessionKey() of whichever aca- session this entry resolved to,
    // once acaPendingMatch finds one -- kept even after attached so a LATER
    // still-pending entry (a second dispatch on the same repository) can
    // never claim the same already-attached session for itself too, see
    // syncAcaPending below.
    matchedKey: null,
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
 */
export async function syncAcaPending() {
  state.acaPending = state.acaPending || [];
  const groups = (state.overview && state.overview.groups) || [];

  // Every session already bound to an entry -- including entries resolved on
  // an earlier call to this function -- so a session can never be claimed
  // twice: not by two pending entries in the same pass, and not by a LATER
  // pending entry on a later pass either, once something else has already
  // claimed it. Oldest dispatch first mirrors DispatchTracker's own
  // "earliest dispatch claims the earliest eligible run" rule server-side
  // (see dispatch-tracker.js's _resolveOrder) -- so when two dispatches
  // target the same repository, the OLDER one gets first claim on whichever
  // matching session exists, rather than depending on array order.
  const claimedKeys = new Set(
    state.acaPending.filter((e) => e.matchedKey).map((e) => e.matchedKey),
  );
  const order = [...state.acaPending].filter((e) => !e.attached)
    .sort((a, b) => (a.dispatchedAt || 0) - (b.dispatchedAt || 0));
  for (const entry of order) {
    const match = acaPendingMatch(entry, groups, claimedKeys);
    if (match) {
      entry.attached = true;
      entry.matchedKey = match.key;
      if (match.key) claimedKeys.add(match.key);
    }
  }

  const pending = state.acaPending.filter((e) => !e.attached);
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

  const claimed = new Set(pending.filter((e) => e.trackerId).map((e) => e.trackerId));
  for (const entry of pending) {
    if (entry.trackerId) continue;
    const ownerRepo = entry.repo.toLowerCase();
    const candidates = (dispatches || [])
      .filter((d) => !claimed.has(d.id) && `${d.owner}/${d.repo}`.toLowerCase() === ownerRepo)
      .sort((a, b) => (b.dispatchedAt || 0) - (a.dispatchedAt || 0));
    const match = candidates[0];
    if (match) { entry.trackerId = match.id; claimed.add(match.id); }
  }
  const byId = new Map((dispatches || []).map((d) => [d.id, d]));
  for (const entry of pending) {
    if (!entry.trackerId) continue;
    const d = byId.get(entry.trackerId);
    if (d) entry.status = d.status;
  }
}

/** How often a pending dispatch is rechecked while one exists (#178).
 *
 * The rest of this app is entirely WS-push driven -- `ws.js`'s `onmessage`
 * calls `render()` straight off an `overview` push, with no timer anywhere
 * else in `web/js/`. That works for devices and sessions because a device's
 * own socket tells the hub the instant something changes. It does NOT work
 * for a GitHub Actions run: nothing pushes a message purely because a run
 * moved from queued to in_progress, `DispatchTracker` only ever learns that
 * by being ASKED (`GET /api/aca/dispatches`). Without a timer, a pending row
 * would sit on "Dispatched" forever unless the person happened to trigger an
 * unrelated `refresh()` (a filter change, a reconnect) -- this interval is
 * what actually advances it.
 *
 * Still costs nothing while idle: `syncAcaPending` returns before any
 * network call whenever nothing is pending, the same gate that keeps an
 * ordinary page load (zero pending, always) from ever touching
 * `/api/aca/*` -- see `syncAcaPending` and the #233 note on `refresh()`.
 * 15s keeps this well under the 30/min read limit (#213) even stacked with
 * `refresh()`'s own call to the same endpoint.
 */
const ACA_POLL_MS = 15000;

/** Start the interval above. Called once, from `wireAca()` (aca.js). */
export function startAcaPolling() {
  setInterval(async () => {
    if (!(state.acaPending && state.acaPending.some((e) => !e.attached))) return;
    await syncAcaPending();
    render();
  }, ACA_POLL_MS);
}
