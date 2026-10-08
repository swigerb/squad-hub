// ---------------------------------------------------------------------------
// Removing ended sessions
//
// The device is the source of truth: the hub replaces a device's session list
// wholesale from whatever that device reports, so anything removed only at the
// hub returns on the next heartbeat. Every removal therefore goes TO A DEVICE,
// and a device that cannot be asked is reported as skipped rather than quietly
// counted as done.
// ---------------------------------------------------------------------------

/** How long "older than N days" is, in milliseconds. `all` has no window. */
export function forgetWindowMs(scope) {
  if (scope === 'all') return undefined;
  const days = Number(scope);
  if (!Number.isFinite(days) || days <= 0) return null;
  return days * 24 * 3600 * 1000;
}

/**
 * Which devices a removal can reach, and how.
 *
 * An online device is ASKED -- it owns its session list, and a hub-side delete
 * would be undone by its next heartbeat.
 *
 * Anything not online is handled by the hub instead. That is not an override:
 * a device with no live connection has nothing left to contradict, and an
 * ephemeral job execution never reconnects. Both non-online states count --
 * a device goes `stale` before it goes `offline`, and a job that has just
 * finished is exactly the one someone wants to tidy away.
 */
export function forgetTargets(devices) {
  const all = devices || [];
  return {
    reachable: all.filter((d) => d.presence === 'online'),
    skipped: all.filter((d) => d.presence !== 'online'),
  };
}

/**
 * What to tell someone after a sweep.
 *
 * Written from the RESULTS, never from the request, so a device that refused
 * cannot be counted as a device that complied.
 */
export function forgetSummary({ removed, failed, skipped }) {
  const parts = [];
  parts.push(removed === 0
    ? 'Nothing to remove'
    : `Removed ${removed} ended session${removed === 1 ? '' : 's'}`);
  if (skipped) parts.push(`${skipped} device${skipped === 1 ? '' : 's'} offline, skipped`);
  if (failed) parts.push(`${failed} device${failed === 1 ? '' : 's'} refused`);
  return parts.join(' · ');
}

/**
 * An ACA job is a cloud device with a more specific kind (#166): on-demand,
 * never the machine at the keyboard. Every cloud-vs-local decision goes
 * through here so an 'aca' device is never mistaken for a local one.
 */
export function isCloudKind(kind) {
  return kind === 'cloud' || kind === 'aca';
}

/**
 * What the Create menu can offer, given the devices that exist.
 *
 * A session needs a device to run on, and the two kinds are not
 * interchangeable: a cloud device is on-demand, a local one is a machine
 * already sitting there. Squad Hub cannot CONJURE either -- it observes
 * devices that dial in, and holds no cloud credentials by design -- so an
 * always-live "Cloud session" would be an offer it could not keep. Each
 * unavailable kind is therefore refused WITH THE REASON and what to do about
 * it, which is the honest version of the same help.
 */
export function newMenuState(devices) {
  const usable = (devices || []).filter((d) => d.presence !== 'offline');
  const cloud = usable.filter((d) => isCloudKind(d.kind));
  const local = usable.filter((d) => !isCloudKind(d.kind));
  let note = null;
  if (!usable.length) {
    note = 'No device is connected. A session runs on a device — run squad-hub connect on a machine, or start a cloud one.';
  } else if (!cloud.length) {
    note = 'No cloud device is connected. A cloud device dials in on its own — see docs/aca.md for running one on Container Apps.';
  } else if (!local.length) {
    note = 'No local device is connected. Run squad-hub connect on a machine to add one.';
  }
  return {
    localEnabled: local.length > 0,
    cloudEnabled: cloud.length > 0,
    note,
    localDeviceId: local.length ? local[0].deviceId : null,
    cloudDeviceId: cloud.length ? cloud[0].deviceId : null,
  };
}

/**
 * What the Undo toast says while a removal is pending.
 *
 * One function, so the toast text, the browser test and any future caller
 * agree on the exact words. Three copies of this string is three places a
 * wording change could drift out of step with what the button actually does.
 */
export function forgetUndoLabel(scope) {
  const what = scope === 'all' ? 'All ended sessions' : `Sessions older than ${scope} days`;
  return `${what} will be removed in a few seconds`;
}

/** Same idea, for removing a device. */
export function removeDeviceUndoLabel(name) {
  return `Removing "${name}" in a few seconds`;
}

export const APPROVAL_LABEL = {
  allow_once: 'Allow once',
  allow_always: 'Always allow',
  reject_once: 'Deny',
};

/**
 * The options to offer, in a deliberate order, never inventing one.
 *
 * `allow_always` appears ONLY when the agent offered it. Manufacturing a
 * standing rule the agent never proposed would create a permission nobody's
 * protocol agreed on, and the daemon refuses an option the agent did not
 * offer anyway -- so a button for it could only ever produce an error.
 */
export function approvalOptions(approval) {
  const offered = (approval && approval.options) || [];
  return offered.map((o) => {
    // An older device spells these `id`/`label`. The store normalizes on
    // ingest, but reading both here means one out-of-date device cannot render
    // a card with no text and -- worse -- no VALUE, which `answer()` would
    // treat as a deny. A button that denies when it says allow is the failure
    // mode worth two lines of defense.
    const optionId = o.optionId || o.id;
    return {
      optionId,
      label: o.name || o.label || APPROVAL_LABEL[optionId] || optionId,
      danger: optionId === 'reject_once',
      standing: optionId === 'allow_always',
    };
  });
}

/**
 * What "Always allow" would actually commit to.
 *
 * A standing permission button that does not say what it makes standing is a
 * blank cheque. Returns null when the agent did not offer one, so nothing is
 * shown for a decision nobody can take.
 */
export function alwaysAllowRule(approval) {
  const opt = ((approval && approval.options) || []).find((o) => o.optionId === 'allow_always');
  if (!opt) return null;
  const subject = (approval.command || approval.title || '').trim();
  if (!subject) return 'Allow this tool without asking again in this session.';
  return `Allow "${subject}" without asking again in this session.`;
}

