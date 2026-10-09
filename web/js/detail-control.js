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
  const token = (controlToken += 1);
  state.composer = composerReduce(state.composer, { type: 'verify-start' });
  renderControl();

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), CONTROL_TIMEOUT_MS));
  const ask = api(`/api/devices/${encodeURIComponent(current.device.deviceId)}/control-check`, {
    method: 'POST', body: { sessionId: current.session.id },
  }).catch((e) => ({ error: e.message }));

  const outcome = await Promise.race([ask, timeout]);

  // Reject when the panel closed, a DIFFERENT session is now open, or a
  // newer `verifyControl` call has since started for this session. A
  // same-session live-snapshot refresh is none of those.
  const stillSameSelection = state.currentSession && sessionKey(state.currentSession.session) === key;
  if (!stillSameSelection || token !== controlToken) return;

  state.composer = composerReduce(state.composer, { type: 'verify-result', outcome });
  renderControl();
}

/**
 * The session key `syncSession` is currently resyncing, or `null`. Moving
 * `Sync session` into the shared `#rowMenu` dropped the guard the old
 * dedicated `#dtSync` button gave for free (it disabled itself while
 * pending). A popup item is rebuilt fresh every open, so reopening it mid-sync
 * could fire a second one. This flag restores one in-flight resync per
 * target, tracked by key so it survives the same live-snapshot churn above.
 */
let syncInFlightKey = null;

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
  if (syncInFlightKey === key) return;
  syncInFlightKey = key;
  try {
    await api(`/api/devices/${encodeURIComponent(current.device.deviceId)}/resync`, {
      method: 'POST', body: { sessionId: current.session.id },
    });
    await refresh();
  } catch (e) {
    // A different session selected while this was in flight: its failure is
    // no longer anyone's business.
    if (state.currentSession && sessionKey(state.currentSession.session) === key) {
      state.composer = composerReduce(state.composer, { type: 'verify-result', outcome: { error: e.message } });
      renderControl();
    }
    return;
  } finally {
    if (syncInFlightKey === key) syncInFlightKey = null;
  }
  // Only now is the question worth asking again -- and only for the still-open
  // session, same stale-selection guard as `verifyControl` above.
  if (state.currentSession && sessionKey(state.currentSession.session) === key) await verifyControl();
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
  const pending = syncInFlightKey === sessionKey(current.session);
  return {
    action: 'sync',
    label: pending ? 'Syncing…' : 'Sync session',
    glyph: '↻',
    disabled: pending,
  };
}
