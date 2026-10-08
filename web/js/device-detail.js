import { esc, humanBytes, clamp01 } from './util.js';

// ---------------------------------------------------------------------------
// Expandable device details (#173): each volume, cores/RAM, the squad-hub and
// Copilot CLI versions (with a mismatch warning), file access/track-all, and
// the device token's label and expiry. Collapsed by default, same persistence
// pattern as the rail's own sections (see `isSectionCollapsed` in devices.js)
// -- a device someone opened to check its disk stays open across the next
// poll's `render()`, not just until the markup underneath it is thrown away.
//
// Split out of devices.js (which pulled the Disk meter and this panel in at
// the same time, #173) purely to keep that file under the same size budget
// the CSS split already holds every stylesheet to -- see
// `test/package-unit.js`'s "no ... file is anywhere near the old single-file
// size" checks.
// ---------------------------------------------------------------------------

const EXPAND_KEY = 'squad-hub-device-expanded';

function loadExpanded() {
  try { return new Set(JSON.parse(localStorage.getItem(EXPAND_KEY) || '[]')); } catch { return new Set(); }
}

let expandedDevices = loadExpanded();

function saveExpanded() {
  try { localStorage.setItem(EXPAND_KEY, JSON.stringify([...expandedDevices])); } catch { /* never fatal */ }
}

export function isDeviceExpanded(deviceId) {
  return expandedDevices.has(deviceId);
}

/**
 * The fullest reported volume's used fraction, for the Disk meter (#173).
 *
 * "Fullest", not "first" or "the workspace volume specifically": the point of
 * a one-glance meter beside CPU and RAM is "is storage the problem right
 * now", and the volume furthest from empty is the one that answers that,
 * whichever volume it happens to be.
 */
export function fullestVolume(volumes) {
  if (!Array.isArray(volumes) || !volumes.length) return null;
  let worst = null;
  let worstFraction = -1;
  for (const v of volumes) {
    if (!v || !Number.isFinite(v.totalBytes) || v.totalBytes <= 0) continue;
    const fraction = clamp01(1 - (v.freeBytes || 0) / v.totalBytes);
    if (fraction > worstFraction) { worstFraction = fraction; worst = v; }
  }
  return worst;
}

/**
 * `document.querySelector` has no native escaping for an attribute-selector
 * value, and a device id is attacker-influenced input (it comes off a device
 * token, not off anything a person typed). A device id that happened to
 * contain a `"` would otherwise break out of the selector string entirely.
 */
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

export function setDeviceExpanded(deviceId, expanded) {
  if (expanded) expandedDevices.add(deviceId); else expandedDevices.delete(deviceId);
  saveExpanded();
  const body = document.querySelector(`[data-devx="${cssEscape(deviceId)}"]`);
  const btn = document.querySelector(`[data-expand-device="${cssEscape(deviceId)}"]`);
  if (body) body.hidden = !expanded;
  if (btn) btn.setAttribute('aria-expanded', String(!!expanded));
}

/** Flip a device's expanded state, from the one click handler in connect.js. */
export function toggleDeviceExpanded(deviceId) {
  setDeviceExpanded(deviceId, !isDeviceExpanded(deviceId));
}

/** "expires in 23 days", "expires today", "expired 4 days ago" -- never a
 * bare timestamp, which answers "when" and not the question that matters
 * here, "how much runway is left". */
export function tokenExpiryLabel(ms) {
  if (!Number.isFinite(ms)) return '';
  const days = Math.round((ms - Date.now()) / 86400000);
  if (days > 0) return `expires in ${days} day${days === 1 ? '' : 's'}`;
  if (days === 0) return 'expires today';
  const ago = -days;
  return `expired ${ago} day${ago === 1 ? '' : 's'} ago`;
}

/**
 * One row of the detail table: a label on the left, right-aligned value on
 * the right, exactly like every row this panel renders (see `.device-detail`
 * in devices.css).
 */
function detailRow(label, valueHtml) {
  return `<tr><td>${esc(label)}</td><td>${valueHtml}</td></tr>`;
}

/**
 * The expandable panel underneath a device's name (#173): every volume free
 * of total, cores and total RAM, the squad-hub and Copilot CLI versions (with
 * a warning when the daemon's squad-hub differs from the hub's own), file
 * access and track-all, and the device token's label and expiry.
 *
 * Returns '' when there is nothing worth a panel for at all -- an ACA
 * execution with no telemetry, no version and no token has no detail to
 * disclose, so no chevron invites a click that would open onto an empty box.
 */
export function deviceDetailHtml(d, opts = {}) {
  const t = d.telemetrySample || null;
  const volumes = Array.isArray(d.diskVolumes) ? d.diskVolumes : [];
  const rows = [];

  for (const v of volumes) {
    const label = v.workspace ? `${v.label} (workspace volume)` : v.label;
    rows.push(detailRow(label, `${esc(humanBytes(v.freeBytes))} free of ${esc(humanBytes(v.totalBytes))}`));
  }

  if (t && (Number.isFinite(t.cores) || Number.isFinite(t.memTotalBytes))) {
    const cores = Number.isFinite(t.cores) ? t.cores : '?';
    rows.push(detailRow('Cores \u00b7 RAM', `${cores} \u00b7 ${esc(humanBytes(t.memTotalBytes))}`));
  }

  if (d.version) {
    const mismatched = opts.hubVersion && d.version !== opts.hubVersion;
    const warning = mismatched ? ` <span class="warnline">\u00b7 hub is ${esc(opts.hubVersion)}</span>` : '';
    rows.push(detailRow('squad-hub', `${esc(d.version)}${warning}`));
  }

  if (d.cliVersion) rows.push(detailRow('Copilot CLI', esc(d.cliVersion)));

  if (d.fileAccess) {
    rows.push(detailRow('File access \u00b7 track-all', `${esc(d.fileAccess)} \u00b7 ${d.trackAll ? 'on' : 'off'}`));
  }

  if (d.tokenLabel || Number.isFinite(d.tokenExpiresAt)) {
    const label = d.tokenLabel ? `&ldquo;${esc(d.tokenLabel)}&rdquo;` : 'Device token';
    const expiry = Number.isFinite(d.tokenExpiresAt) ? ` \u00b7 ${esc(tokenExpiryLabel(d.tokenExpiresAt))}` : '';
    rows.push(detailRow('Token', `${label}${expiry}`));
  }

  if (!rows.length) return '';

  return `
    <div class="device-detail" id="devx-${esc(d.deviceId)}" data-devx="${esc(d.deviceId)}"${isDeviceExpanded(d.deviceId) ? '' : ' hidden'}>
      <table>${rows.join('')}</table>
    </div>`;
}
