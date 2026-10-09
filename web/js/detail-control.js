// Control-check verification and Sync session for the open detail page
// (#181 part 2), split out of detail.js to keep that file under the size
// budget `test/package-unit.js` holds every web/js module to -- the same
// reason rowmenu.js was split out of list.js.
//
// Circular import, same pattern rowmenu.js/wiring.js already use:
// `renderControl` is a hoisted `export function` declaration in detail.js,
// never read at either module's top level, so by the time the async
// functions below actually call it, detail.js's module body has long
// finished.

import { state, api } from './api.js';
import { composerReduce, canSync } from './composer.js';
import { isDeviceUnreachable } from './util.js';
import { sessionKey } from './list.js';
import { refresh } from './ws.js';
import { renderControl } from './detail.js';

/** How long to wait for the device to answer before saying so. */
const CONTROL_TIMEOUT_MS = 8000;

/**
 * Bumped by every `verifyControl` call so an earlier answer can never
 * clobber a later one -- a reopen of the same session, or a sync-triggered
 * recheck, must win over whatever request it superseded.
 */
let controlToken = 0;

/**
 * Bumped IMMEDIATELY by `openDetail`/`closeDetail` -- before either awaits
 * anything, including the transcript fetch -- so a verify/resync reply
 * already in flight for the PREVIOUS selection can never be applied after
 * an open, a close, or a close-then-reopen of the identical session. Scout's
 * review of 34256a0: `openDetail` sets `state.currentSession` and only
 * starts a new `verifyControl` call (which bumps `controlToken`) after
 * awaiting the transcript, so a stale reply for the same session key can
 * land in that gap and pass a same-key, same-token check. This generation
 * is the one thing that always changes at the instant of navigation,
 * independent of when (or whether) a new verification actually starts.
 * `syncDetailHeader`'s live-snapshot reassignment of `state.currentSession`
 * (no open/close call) never touches it, so same-session snapshot churn
 * mid-verification is still tolerated exactly as before.
 */
let selectionGeneration = 0;

/**
 * Called by `openDetail`/`closeDetail` to mark the selection superseded.
 * Returns the new generation so the caller can capture exactly the value
 * its own call just set, for `selectionStillActive` below.
 */
export function invalidateSelection() {
  selectionGeneration += 1;
  return selectionGeneration;
}

/**
 * Whether the selection an earlier `openDetail` call captured -- its own
 * `key` and the generation `invalidateSelection` handed back at the time --
 * is STILL the one actually open. `openDetail` awaits the transcript fetch
 * before doing anything else with the result; if the person closed,
 * reopened (even the identical session), or opened something else entirely
 * while that fetch was in flight, this old continuation must not render a
 * transcript, or start a redundant control-check, for a context that is no
 * longer the one on screen -- `verifyControl` already guards its OWN
 * result this way (by `sessionKey` and `controlToken`), but nothing
 * previously stopped `openDetail`'s transcript render from applying
 * unconditionally once its fetch settled, even for a session the person
 * had since left.
 */
export function selectionStillActive(key, generation) {
  return !!state.currentSession
    && sessionKey(state.currentSession.session) === key
    && generation === selectionGeneration;
}

/**
 * Ask the device whether it can take a control command for this session.
 *
 * The answer comes from the machine running the agent, not from the hub --
 * the hub is a cache. What makes an in-flight answer still worth applying is
 * SAME SELECTION, not same object: `syncDetailHeader` reassigns
 * `state.currentSession` to a freshly-`findSession`'d wrapper on every
 * overview refresh/WebSocket push, even for the exact same device/session.
 * Comparing by object reference discarded a valid answer every time that
 * happened, leaving "Checking control…" forever (the real-browser CI
 * regression this fixes). Comparing by `sessionKey` survives that
 * live-snapshot churn, while `controlToken` still rejects a result
 * superseded by a genuinely new verification: closed, a different session
 * opened, this session closed and reopened, or `syncSession` re-asked.
 */
export async function verifyControl() {
  const current = state.currentSession;
  if (!current) return;
  const key = sessionKey(current.session);
  const generation = selectionGeneration;
  const token = (controlToken += 1);
  state.composer = composerReduce(state.composer, { type: 'verify-start' });
  renderControl();

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), CONTROL_TIMEOUT_MS));
  const ask = api(`/api/devices/${encodeURIComponent(current.device.deviceId)}/control-check`, {
    method: 'POST', body: { sessionId: current.session.id },
  }).catch((e) => ({ error: e.message }));

  const outcome = await Promise.race([ask, timeout]);

  // Reject when the panel closed, a DIFFERENT session is now open, a newer
  // `verifyControl` call has since started for this session, OR the
  // selection was invalidated (closed, reopened -- same or different
  // session) since this call began. A same-session live-snapshot refresh is
  // none of those: it changes only the `state.currentSession` object and
  // `sessionKey` still matches, and it never calls `invalidateSelection`.
  const stillSameSelection = state.currentSession && sessionKey(state.currentSession.session) === key;
  if (!stillSameSelection || token !== controlToken || generation !== selectionGeneration) return;

  state.composer = composerReduce(state.composer, { type: 'verify-result', outcome });
  renderControl();
}

/**
 * The session keys `syncSession` is currently resyncing. Moving `Sync
 * session` into the shared `#rowMenu` dropped the guard the old dedicated
 * `#dtSync` button gave for free (it disabled itself while pending). A
 * popup item is rebuilt fresh every open, so reopening it mid-sync could
 * fire a second one for the SAME target. A single scalar is not enough,
 * though: Scout's review of 34256a0 reproduced starting Sync for A,
 * navigating to B and starting Sync for B, then returning to A and
 * clicking Sync again before either had returned -- B's start overwrote a
 * scalar lock, so A's second click was no longer blocked and fired a
 * second resync for A while B still had exactly one in flight. A `Set`
 * keyed by target, where each target's own settlement only ever deletes
 * its own key, is a real per-target lock that survives navigating away and
 * back, independent of what any other target is doing.
 */
const syncInFlightKeys = new Set();

/**
 * `Sync session` -- restart the engine, keeping the session id, then re-check.
 * The id survives on purpose: it is what the row, the Teams card and
 * anyone's terminal history all refer to.
 */
export async function syncSession() {
  const current = state.currentSession;
  if (!current) return;
  const key = sessionKey(current.session);
  // Already resyncing this target: `detailSyncMenuItem` disables the menu
  // item while true, and the row-menu click handler also checks `b.disabled`
  // itself (see wiring.js), so this only guards a caller bypassing the UI.
  if (syncInFlightKeys.has(key)) return;
  syncInFlightKeys.add(key);
  // Captured before awaiting anything, same reasoning as `verifyControl`:
  // closing or reopening this (or any) session before the resync settles
  // must stop its result from reaching a since-superseded context.
  const generation = selectionGeneration;
  try {
    await api(`/api/devices/${encodeURIComponent(current.device.deviceId)}/resync`, {
      method: 'POST', body: { sessionId: current.session.id },
    });
    await refresh();
  } catch (e) {
    // A different session selected, or this one closed and reopened, while
    // this was in flight: its failure is no longer anyone's business.
    if (
      state.currentSession
      && sessionKey(state.currentSession.session) === key
      && generation === selectionGeneration
    ) {
      state.composer = composerReduce(state.composer, { type: 'verify-result', outcome: { error: e.message } });
      renderControl();
    }
    return;
  } finally {
    syncInFlightKeys.delete(key);
  }
  // Only now is the question worth asking again -- and only for the still-open
  // session (same selection, not merely the same key), same stale-context
  // guard as `verifyControl` above.
  if (
    state.currentSession
    && sessionKey(state.currentSession.session) === key
    && generation === selectionGeneration
  ) await verifyControl();
}

/**
 * Whether the detail header's ⋯ menu should also offer "Sync session": the
 * same condition the detail controls expose (`canSync` AND device reachable).
 * While a resync for THIS session is in flight, the item still shows but
 * `disabled: true` keeps a reopened menu from restarting it -- the regression
 * introduced when Sync's old self-disabling dedicated button was replaced by
 * this shared item.
 */
export function detailSyncMenuItem() {
  const current = state.currentSession;
  if (!current) return null;
  if (!canSync(state.composer.control) || isDeviceUnreachable(current.device)) return null;
  const pending = syncInFlightKeys.has(sessionKey(current.session));
  return {
    action: 'sync',
    label: pending ? 'Syncing…' : 'Sync session',
    glyph: '↻',
    disabled: pending,
  };
}
