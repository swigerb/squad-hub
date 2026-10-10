import { state, api } from './api.js';
import { toast, undoToast } from './util.js';
import { forgetWindowMs, forgetTargets, forgetSummary, forgetUndoLabel } from './cleanup.js';
import { refresh } from './ws.js';

// The "Remove ended sessions" action, moved out of wiring.js unchanged so that
// module stays inside its size budget. The pure helpers it uses stay in
// cleanup.js, which has no DOM or network dependency and so can be unit-tested
// on its own.

/**
 * Remove the record of sessions that have already ended.
 *
 * Sent to every reachable device, because the device is the source of truth
 * and a hub-side removal would be undone by the next heartbeat. The result is
 * assembled from what each device actually reported.
 *
 * The confirm dialog (for "all") still asks once, up front. What is new is
 * the few seconds AFTER that: nothing is sent to any device until the Undo
 * toast expires, so a mis-click on a button right beside the one you meant is
 * recoverable for as long as the toast is on screen.
 */
export async function forgetEnded(scope) {
  const olderThanMs = forgetWindowMs(scope);
  if (olderThanMs === null) return;

  // Offline devices are swept too. Their ended sessions are removed by the hub
  // rather than by the device, because a device that never comes back cannot
  // be asked and cannot object -- and an ephemeral cloud job never comes back.
  const { reachable, skipped } = forgetTargets((state.overview && state.overview.devices) || []);
  const targets = [...reachable, ...skipped];
  if (!targets.length) {
    toast('No devices to remove sessions from');
    return;
  }
  if (scope === 'all' && !window.confirm(
    'Remove every ended session from the list?\n\n'
    + 'This clears the record of finished work. '
    + 'Sessions that are still running are not affected.')) return;

  undoToast(forgetUndoLabel(scope), async () => {
    let removed = 0;
    let failed = 0;
    for (const d of targets) {
      try {
        const r = await api(`/api/devices/${encodeURIComponent(d.deviceId)}/forget`, {
          method: 'POST',
          body: { olderThanMs },
        });
        removed += (r && r.count) || 0;
      } catch {
        // Counted, never swallowed: a device that refused must not be
        // indistinguishable from one that had nothing to remove.
        failed += 1;
      }
    }
    toast(forgetSummary({ removed, failed, skipped: 0 }));
    await refresh();
  }, () => toast('Removal canceled — nothing was removed'));
}
