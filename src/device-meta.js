'use strict';
/**
 * Optional device metadata: where a cloud job came from, for a roster entry
 * that would otherwise be a hash with a heartbeat.
 *
 * Accepted ONLY from a short allowlist of string fields -- `displayName`,
 * `repo`, `issue`, `executionName`, `jobName`, `role`, `approvalMode`,
 * `lastSweepAt` -- each size-capped and checked for the characters that turn
 * a label into something else. A device is a machine the hub does not
 * control, running whatever code its owner deployed, so its metadata is
 * INPUT, not an invariant: a free-form env var or an upstream job
 * description must not be able to smuggle a terminal escape sequence, a raw
 * `<script>` fragment, or several kilobytes of garbage into something every
 * watcher of that subject reads back on every heartbeat.
 *
 * `role`, `approvalMode` and `lastSweepAt` (#180/#233) exist so the "Squad on
 * ACA" status card can report the issue watcher and Ralph by an EXPLICIT,
 * verified fact a device chooses to send, rather than guessing from its own
 * `name` -- a label a deployment picks for operators to read, never
 * contracted to say "I am the issue watcher" or "I just finished a sweep".
 * None of the three is required: a device that never sends them is reported
 * honestly as unknown (see `web/js/aca-status.js`), not guessed at.
 *
 * Shared between the device side (`src/cloud-device.js`, reading
 * `SQUAD_HUB_DEVICE_META_JSON`) and the hub side (`src/service/store.js`,
 * which trusts nothing a device sends without checking it again here) -- one
 * allowlist, not two copies that can drift.
 */

/** The only fields a device may report. Anything else is silently dropped. */
const FIELDS = Object.freeze([
  'displayName', 'repo', 'issue', 'executionName', 'jobName',
  'role', 'approvalMode', 'lastSweepAt',
]);

/**
 * `role`'s only accepted values: the two persistent squad-on-aca jobs the
 * status card looks for. Anything else (an arbitrary, unanticipated string a
 * device might send) is dropped rather than displayed -- a card that shows
 * whatever string a device chose to send would just be guessing again, only
 * with the guess coming from the device instead of the hub.
 */
const ROLE_VALUES = Object.freeze(['watch', 'ralph']);

/**
 * `approvalMode`'s only accepted values. The card says "watch-only" (#180)
 * ONLY when this is verified `'auto'` -- never inferred from presence or
 * name alone.
 */
const APPROVAL_MODE_VALUES = Object.freeze(['auto', 'manual']);

/** A label, not an essay. Generous for a repo slug or an issue title. */
const MAX_FIELD_LEN = 200;

/** Caps the whole object, not just one field -- a hundred short fields would
 * otherwise slip past the per-field cap above. */
const MAX_TOTAL_BYTES = 4096;

/**
 * Control characters (including ESC, the first byte of a terminal escape
 * sequence) and the two characters that turn a plain label into markup.
 * Rejecting the FIELD outright, rather than stripping the characters out of
 * it, means a caller finds out its metadata did not take rather than silently
 * getting a mangled label back.
 */
const INJECTION_RE = /[\x00-\x1f\x7f<>]/;

/**
 * Validate an already-parsed object. Returns a new object containing only the
 * fields that passed, or `null` if nothing did.
 */
function sanitizeDeviceMeta(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  let raw;
  try { raw = JSON.stringify(input); } catch { return null; }
  if (Buffer.byteLength(raw, 'utf8') > MAX_TOTAL_BYTES) return null;

  const out = {};
  for (const field of FIELDS) {
    const v = input[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') continue; // non-string: rejected, not coerced
    if (!v.length || v.length > MAX_FIELD_LEN) continue; // empty or oversize
    if (INJECTION_RE.test(v)) continue; // injection-shaped
    // `role` and `approvalMode` are closed vocabularies, not free text: an
    // unrecognized value is dropped the same as a malformed one, rather than
    // displayed verbatim, so the status card never has to parse or trust a
    // string it was not expecting.
    if (field === 'role' && !ROLE_VALUES.includes(v)) continue;
    if (field === 'approvalMode' && !APPROVAL_MODE_VALUES.includes(v)) continue;
    // `lastSweepAt` is a timestamp, not a label -- a string that does not
    // parse to a real instant is worth less than having no value at all.
    if (field === 'lastSweepAt' && !Number.isFinite(Date.parse(v))) continue;
    out[field] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Parse `SQUAD_HUB_DEVICE_META_JSON`. Malformed JSON, or JSON that is not a
 * plain object, returns `null` rather than throwing: metadata is optional
 * dressing on a device record, never something that should keep a device from
 * attaching.
 */
function parseDeviceMetaEnv(raw) {
  if (!raw) return null;
  if (Buffer.byteLength(raw, 'utf8') > MAX_TOTAL_BYTES) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return sanitizeDeviceMeta(parsed);
}

module.exports = {
  FIELDS,
  ROLE_VALUES,
  APPROVAL_MODE_VALUES,
  MAX_FIELD_LEN,
  MAX_TOTAL_BYTES,
  sanitizeDeviceMeta,
  parseDeviceMetaEnv,
};
