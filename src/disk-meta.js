'use strict';
/**
 * Disk volume reports, validated (#173).
 *
 * `src/telemetry.js` builds the raw list on the DEVICE side, from whatever
 * `fs.statfsSync` and the platform's own mount table say. A device is a
 * machine the hub does not control -- an old daemon, an odd mount, or
 * something not running this code at all could put anything on the wire --
 * so the hub re-validates every field here before it is kept, the same
 * posture `src/device-meta.js` already takes with device metadata: one
 * allowlist/cap, shared by whatever calls it, not a trust boundary that only
 * exists on paper.
 */

/** A roster entry with hundreds of volumes is not a laptop; it is a bug or
 * an attack, and either way nothing downstream should have to handle it. */
const MAX_VOLUMES = 16;

/** A drive letter or a mount point, not an essay. Generous for the deepest
 * mount point anyone is likely to scope a workspace to. */
const MAX_LABEL_LEN = 200;

/** Same injection posture as `device-meta.js`: control characters (including
 * ESC) and the two characters that turn a label into markup are rejected
 * outright, not stripped. */
const INJECTION_RE = /[\x00-\x1f\x7f<>]/;

/** A finite, non-negative byte count small enough to be a real disk. Rejects
 * `NaN`, `Infinity`, negative numbers, and a device reporting more bytes than
 * a disk could plausibly hold (a sign the field is not bytes at all). */
const MAX_PLAUSIBLE_BYTES = 2 ** 63;

function validByteCount(n) {
  return Number.isFinite(n) && n >= 0 && n < MAX_PLAUSIBLE_BYTES;
}

/**
 * Validate one volume entry. Returns a new, narrowed object, or `null` if it
 * does not have enough to be worth keeping.
 */
function sanitizeVolume(v) {
  if (!v || typeof v !== 'object') return null;
  const label = typeof v.label === 'string' ? v.label.slice(0, MAX_LABEL_LEN) : null;
  if (!label || !label.length || INJECTION_RE.test(label)) return null;
  if (!validByteCount(v.totalBytes)) return null;
  const totalBytes = v.totalBytes;
  const freeBytes = validByteCount(v.freeBytes) ? Math.min(v.freeBytes, totalBytes) : 0;
  return { label, totalBytes, freeBytes, workspace: !!v.workspace };
}

/**
 * Validate and cap a whole device's reported volume list.
 *
 * `null` passes straight through -- it means "file access is off, nothing is
 * reported", a fact the hub must keep, not coerce into an empty array that
 * would read as "file access is on, and there happen to be no volumes".
 * Anything else that is not an array is rejected outright, the same as a
 * malformed object anywhere else a device supplies one.
 */
function sanitizeDiskVolumes(input) {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input) {
    if (out.length >= MAX_VOLUMES) break;
    const v = sanitizeVolume(raw);
    if (v) out.push(v);
  }
  return out;
}

module.exports = { sanitizeDiskVolumes, MAX_VOLUMES, MAX_LABEL_LEN };
