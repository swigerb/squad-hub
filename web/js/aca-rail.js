// The ACA parts of the device rail, split out of devices.js to stay under the
// per-module size budget: the always-visible "ACA jobs" row and, inside the
// "Squad on ACA executions" section, a row for every dispatch this tab made
// whose job has not attached yet (#172 with #178).
//
// Those rows are drawn from `state.acaPending` and nothing else. The hub
// reports no presence for a device that does not exist, so there is no
// "dispatching" presence to read and none is invented: what a row says is what
// `acaEntryView` (aca-pending.js) proves from the hub's own run and receipt.

import { esc } from './util.js';
import { acaEntryView, acaPendingTitle } from './aca-pending.js';
import { acaPendingAttached } from './aca-match.js';

/**
 * The always-visible "ACA jobs" row: on-demand compute, not a roster of
 * devices, so it has no count and nothing to collapse -- only the + that
 * opens the ACA dialog (#172).
 */
export function acaJobsRowHtml() {
  return `
    <div class="device ondemand">
      <span class="dot online"></span>
      <div class="device-main">
        <div class="device-name">ACA jobs</div>
        <div class="device-meta">On-demand &middot; Always available</div>
      </div>
      <button class="add" data-action="aca" title="Start an ACA job">+</button>
    </div>`;
}

/**
 * The tracked dispatches the rail still draws: not attached, and not proven
 * to have started by a device already in the overview. That second test is
 * `acaPendingMatch`'s exact `aca-<executionName>` identity, so a render that
 * lands between the overview and the attach step never shows a job twice,
 * and an older job's device for the same repository never hides a newer
 * dispatch.
 */
export function acaRailEntries(pending = [], devices = []) {
  const all = pending || [];
  return all.filter((e) => e && !e.attached && !acaPendingAttached(e, devices, all));
}

/** What the current step means, in words that claim only what it proves. */
const RAIL_STEP_TEXT = {
  // A queued run, or none seen yet: nothing says a lease was claimed.
  'Lease claimed': ['Queued', 'waiting to claim its lease'],
  // The run is running; no receipt says an execution exists.
  'Starting job': ['Starting', 'the run is in progress'],
  // The workflow's receipt names the execution, which proves the lease claim.
  Attached: ['Starting', 'lease claimed, waiting to attach'],
};

/**
 * One tracked dispatch as the rail words it. `active` is true only while the
 * outcome is still open, which is the only time its dot pulses: a failed or
 * unknown outcome has stopped changing and shows why, with a way to look
 * again.
 */
export function acaRailView(entry) {
  const view = acaEntryView(entry);
  if (view.resolved) {
    return {
      active: false, dot: view.failed ? 'failed' : 'stale', label: view.pillLabel, detail: view.failureReason || '',
    };
  }
  const current = view.steps.find((s) => s.current);
  let [label, detail] = RAIL_STEP_TEXT[current && current.label] || [current ? current.label : 'Queued', ''];
  // A run that finished successfully without publishing a receipt has stopped
  // queueing or running; nothing yet says its job started, so it is only waited on.
  if (current && current.label === 'Lease claimed' && entry.status && entry.status.state === 'completed') {
    [label, detail] = ['Waiting', 'the run finished; waiting for its job to report'];
  }
  return {
    active: true, dot: 'dispatching', label, detail,
  };
}

/** One row per tracked dispatch, keyed by its own `localId` -- never by repository. */
export function acaRailRowHtml(entry) {
  const v = acaRailView(entry);
  const title = acaPendingTitle(entry);
  const status = v.active && v.detail ? `${v.label} \u00b7 ${v.detail}` : v.label;
  const why = !v.active && v.detail ? `<div class="device-meta aca-fail">${esc(v.detail)}</div>` : '';
  const retry = v.active ? '' : `<button type="button" class="ghost aca-retry" data-aca-retry="${esc(entry.localId)}">Check again</button>`;
  return `
    <div class="device aca-rail" data-local-id="${esc(entry.localId)}">
      <span class="dot ${v.dot}"></span>
      <div class="device-main">
        <div class="device-name" title="${esc(title)}"><span>${esc(title)}</span></div>
        <div class="device-meta">${esc(status)}</div>
        ${why}
        ${retry}
      </div>
    </div>`;
}

/** The rail's pending rows for every dispatch still waiting for its device. */
export function acaRailRowsHtml(pending = [], devices = []) {
  return acaRailEntries(pending, devices).map(acaRailRowHtml).join('');
}
