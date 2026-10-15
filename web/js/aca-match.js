// The join between a "Queued on ACA" row and the real session it becomes
// (#178), split out of aca-pending.js to stay under the per-module size
// budget. Pure functions only: no `state`, no `Date.now()`, no DOM.
//
// THE IDENTITY CHAIN is server-proven end to end; nothing here guesses:
//
//   POST /api/aca/dispatch              -> `trackerId`
//   GET  /api/aca/dispatches, id === trackerId
//                                       -> `status.runId` / `runAttempt` and
//                                          `executionName`, read by the hub
//                                          from the run's OWN receipt (#245)
//   the job's device id                 -> `aca-<executionName>`
//
// An earlier version matched on repository, issue and timing, and reviewers
// proved every such rule wrong (a slow job, a second dispatch, a manual
// `/squad-aca`, a rerun). So the ONLY thing that attaches a row to a device
// is the exact device id the hub's own receipt names. No receipt means no
// attach -- the row waits (bounded) and then says "Unknown outcome".

const EXEC_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,126}[A-Za-z0-9])?$/;

/** The device id the job registers with: `aca-` plus the Container App Job
 * execution name (squad-on-aca enforces the prefix on its device token).
 * `null` for anything that is not a plausible execution name. */
export function acaDeviceIdFor(executionName) {
  return typeof executionName === 'string' && EXEC_NAME_RE.test(executionName) ? `aca-${executionName}` : null;
}

/**
 * What one `GET /api/aca/dispatches` row tells us about `entry`, or `null`
 * when the row must be ignored. Never merges across attempts or runs:
 *
 * - the row must carry this entry's own `trackerId`;
 * - the hub never rebinds a dispatch to another run, so a different `runId`
 *   is ignored, and so is a LOWER `runAttempt` (a stale or reordered reply);
 * - `executionName` counts only for an in-flight or finished run attempt, and
 *   the top-level and `status` copies must agree;
 * - within one attempt the name is sticky and never changes; a rerun (higher
 *   attempt) starts over, because the hub clears the receipt for it;
 * - a reply with no run in it (a transient `error`, say) after a run was
 *   already bound never discards what is known, a confirmed execution included.
 */
export function acaDispatchEvidence(entry, row) {
  if (!entry || !entry.trackerId || !row || row.id !== entry.trackerId) return null;
  const st = row.status && typeof row.status === 'object' ? row.status : null;
  const hasRun = !!st && st.runId != null;
  const attempt = hasRun && Number.isInteger(st.runAttempt) && st.runAttempt > 0 ? st.runAttempt : null;
  const sameAttempt = attempt !== null && attempt === entry.runAttempt;

  if (hasRun) {
    if (entry.runId != null && st.runId !== entry.runId) return null;
    if (attempt !== null && entry.runAttempt != null && attempt < entry.runAttempt) return null;
  } else if (entry.runAttempt != null || (st && st.state === 'error' && entry.executionName)) {
    return null;
  }

  const top = row.executionName == null ? null : row.executionName;
  const inner = st && st.executionName != null ? st.executionName : null;
  if (top !== null && inner !== null && top !== inner) return null;
  const named = top !== null ? top : inner;
  const live = !!st && (st.state === 'in_progress' || st.state === 'completed');
  let executionName = attempt !== null && live && acaDeviceIdFor(named) ? named : null;
  if (executionName !== null && sameAttempt && entry.executionName && executionName !== entry.executionName) return null;
  if (executionName === null && sameAttempt && entry.executionName) executionName = entry.executionName;

  return { status: st, runId: hasRun ? st.runId : entry.runId, runAttempt: attempt === null ? entry.runAttempt : attempt, executionName };
}

/** Do the device's own self-reported facts contradict this entry? Absent
 * facts never count: today's real jobs send no `meta` at all. */
function acaMetaConflicts(entry, device) {
  const meta = (device && device.meta) || {};
  if (meta.executionName != null && meta.executionName !== entry.executionName) return true;
  if (meta.repo != null && String(meta.repo).toLowerCase() !== String(entry.repo || '').toLowerCase()) return true;
  return meta.issue != null && entry.issue != null && Number(meta.issue) !== Number(entry.issue);
}

/**
 * The one device in `devices` (`state.overview.devices`) that PROVES it
 * started this dispatch, else `null`: the entry has a confirmed execution
 * name, a device carries exactly `aca-<executionName>`, nothing the device
 * reports contradicts the entry, and no other tracked entry claims the same
 * device (two rows can never both be that session).
 */
export function acaPendingMatch(entry, devices = [], entries = []) {
  const id = entry ? acaDeviceIdFor(entry.executionName) : null;
  if (!id) return null;
  const found = (devices || []).filter((d) => d && d.deviceId === id);
  if (found.length !== 1 || acaMetaConflicts(entry, found[0])) return null;
  const rivals = (entries || []).filter((e) => e !== entry && acaDeviceIdFor(e.executionName) === id);
  return rivals.length ? null : found[0];
}

/** Has this pending dispatch's own device attached? */
export function acaPendingAttached(entry, devices = [], entries = []) {
  return acaPendingMatch(entry, devices, entries) !== null;
}

/**
 * The ONE real session that a `GET /api/aca/dispatches` row provably started,
 * else `null` (#262). Built on the same proof the pending rows use: the row's
 * hub-confirmed `executionName` for a live run attempt (`acaDispatchEvidence`,
 * which also drops a lower attempt than the one this tab tracked) names the
 * device `aca-<executionName>` (`acaPendingMatch`, which rejects a device whose
 * own metadata contradicts the execution, repository or issue, and a device
 * another dispatch also claims). `tracked` is `state.acaPending`: the only
 * place a dispatch's issue is known. The device must then hold exactly one
 * session; presence and heartbeat are never an outcome.
 */
export function acaDispatchSession(row, { devices = [], groups = [], tracked = [], dispatches = [] } = {}) {
  if (!row || !row.id) return null;
  const own = (tracked || []).find((e) => e && e.trackerId === row.id);
  const base = own
    ? { ...own }
    : { trackerId: row.id, repo: `${row.owner}/${row.repo}`, issue: null, runId: null, runAttempt: null, executionName: null };
  const ev = acaDispatchEvidence(base, row);
  if (!ev || !ev.executionName) return null;
  const entry = { ...base, executionName: ev.executionName };
  const rivals = [
    ...(tracked || []).filter((e) => e && e.trackerId !== row.id),
    ...(dispatches || []).filter((d) => d && d.id !== row.id),
  ];
  const device = acaPendingMatch(entry, devices, rivals);
  if (!device) return null;
  const sessions = (groups || [])
    .flatMap((g) => (g && Array.isArray(g.sessions) ? g.sessions : []))
    .filter((s) => s && s.deviceId === device.deviceId);
  return sessions.length === 1 ? sessions[0] : null;
}
