'use strict';
/**
 * Export and restore the access list, as a plain-text file a person can read
 * and diff -- not a second copy of `access.json`.
 *
 * That distinction is deliberate: `access.json`'s shape belongs to
 * `access-store.js` alone and is free to change (Sprint C bumps it). An export
 * that copied the file verbatim would couple a recovery artefact to whatever
 * the store happens to look like today, and break the moment it does not.
 * This format instead names two THINGS the store already knows how to make
 * true again -- a grant, and a revocation -- and nothing about how it stores
 * them.
 *
 * Format:
 *
 *   # squad-hub/access-export@1
 *   {"login":"...","kind":"grant","addedBy":"...","addedAt":123,"note":"..."}
 *   {"login":"...","kind":"revoked"}
 *
 * One JSON object per line, sorted by login, so the file is diffable and a
 * change to one person's row does not reflow the rest of it. Owners are never
 * written here at all: they come from `SQUAD_HUB_OWNER` alone, and a file that
 * cannot even represent an owner is a file that cannot be tampered into
 * minting one.
 */

const { AccessStore, normalise } = require('./access-store');

const SHAPE = 'squad-hub/access-export@1';
const HEADER = `# ${SHAPE}`;

const ALLOWED_KEYS = {
  grant: ['login', 'kind', 'addedBy', 'addedAt', 'note'],
  revoked: ['login', 'kind'],
};

/**
 * Build the export text for the current state of `store`.
 *
 * Only two things need to travel: the grants recorded in `_added`, and which
 * deployment-configured identities are currently revoked. Everything else --
 * the owner list, and any deployment identity that is still active -- comes
 * back on its own from `SQUAD_HUB_OWNER` / `SQUAD_HUB_ALLOWED_USERS` the
 * moment the file is imported onto the same deployment, so writing it here
 * too would just be a second, driftable copy of the environment.
 */
function buildExportText(store) {
  const records = [];
  for (const [login, rec] of store._added) {
    records.push({
      login,
      kind: 'grant',
      addedBy: rec.addedBy || null,
      addedAt: Number.isFinite(rec.addedAt) ? rec.addedAt : null,
      note: rec.note || null,
    });
  }
  for (const login of store._revoked) {
    records.push({ login, kind: 'revoked' });
  }
  records.sort((a, b) => a.login.localeCompare(b.login) || a.kind.localeCompare(b.kind));

  const lines = [HEADER];
  for (const rec of records) {
    lines.push(rec.kind === 'grant'
      ? JSON.stringify({
        login: rec.login, kind: rec.kind, addedBy: rec.addedBy, addedAt: rec.addedAt, note: rec.note,
      })
      : JSON.stringify({ login: rec.login, kind: rec.kind }));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parse export text into records, or refuse.
 *
 * Every line is checked before anything is returned. A single bad line
 * refuses the WHOLE file -- naming the line number -- rather than accepting
 * the lines either side of it. A half-parsed import is worse than a refused
 * one: it leaves the operator unsure what state they are actually in.
 */
function parseExportText(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i >= lines.length || lines[i].trim() !== HEADER) {
    return { ok: false, reason: `line ${i + 1}: missing or unrecognised header (expected "${HEADER}")` };
  }

  const records = [];
  for (let n = i + 1; n < lines.length; n += 1) {
    const raw = lines[n].trim();
    if (!raw) continue;
    const lineNo = n + 1;

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: `line ${lineNo}: not valid JSON (${e.message})` };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, reason: `line ${lineNo}: not a JSON object` };
    }
    if (obj.kind !== 'grant' && obj.kind !== 'revoked') {
      return { ok: false, reason: `line ${lineNo}: unrecognised record kind ${JSON.stringify(obj.kind)}` };
    }
    const allowed = ALLOWED_KEYS[obj.kind];
    const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
    if (extra.length) {
      return { ok: false, reason: `line ${lineNo}: unexpected field(s): ${extra.join(', ')}` };
    }

    const idn = normalise(obj.login);
    if (!idn.ok) {
      return { ok: false, reason: `line ${lineNo}: ${idn.reason}` };
    }

    if (obj.kind === 'grant') {
      if (obj.addedAt != null && !Number.isFinite(obj.addedAt)) {
        return { ok: false, reason: `line ${lineNo}: addedAt must be a number or null` };
      }
      if (obj.addedBy != null && typeof obj.addedBy !== 'string') {
        return { ok: false, reason: `line ${lineNo}: addedBy must be a string or null` };
      }
      if (obj.note != null && typeof obj.note !== 'string') {
        return { ok: false, reason: `line ${lineNo}: note must be a string or null` };
      }
      records.push({
        kind: 'grant',
        login: idn.value,
        addedBy: obj.addedBy || null,
        addedAt: obj.addedAt == null ? null : obj.addedAt,
        note: obj.note || null,
        line: lineNo,
      });
    } else {
      records.push({ kind: 'revoked', login: idn.value, line: lineNo });
    }
  }
  return { ok: true, records };
}

/**
 * Refuse the whole import outright if any record claims to be an owner.
 *
 * Owners come from `SQUAD_HUB_OWNER` alone (see access-store.js, rule 1), and
 * this checks the SAME list `AccessStore.add()` already checks -- it does not
 * re-derive the rule, it reads the one piece of state the rule is defined
 * against. A file that names today's owner is refused rather than merely
 * skipped, because silently treating it as "already present" would hide
 * exactly the tampering this exists to catch.
 */
function planImport(store, records) {
  const claim = records.find((r) => r.kind === 'grant' && store.envOwner.includes(r.login));
  if (claim) {
    return {
      ok: false,
      reason: `line ${claim.line}: "${claim.login}" is an owner of this hub (SQUAD_HUB_OWNER); an import file cannot claim one`,
    };
  }
  return { ok: true };
}

/**
 * Apply already-validated records to `store`.
 *
 * Grants are additive by default and go through `AccessStore.add()` -- never
 * a direct write to `_added` -- so the ownership and duplicate rules that
 * live there apply to an import exactly as they apply to the API. Add()
 * writes only on success, so a duplicate or refused record leaves nothing
 * behind; it is simply reported.
 *
 * Revocations are reported either way, but only APPLIED when
 * `applyRevocations` is set: a revoked deployment identity is absent from
 * `list()`, and a round trip that dropped that fact silently would not be
 * identical -- but applying one without being asked would also be a way an
 * import removes someone nobody asked to remove.
 */
function applyImport(store, records, { applyRevocations = false } = {}) {
  const added = [];
  const alreadyPresent = [];
  const revoked = [];
  const pendingRevocations = [];

  for (const rec of records) {
    if (rec.kind !== 'grant') continue;
    const r = store.add(rec.login, { addedBy: rec.addedBy, note: rec.note, addedAt: rec.addedAt });
    if (r.ok) added.push(rec.login);
    else alreadyPresent.push(rec.login);
  }
  for (const rec of records) {
    if (rec.kind !== 'revoked') continue;
    pendingRevocations.push(rec.login);
    if (!applyRevocations) continue;
    const r = store.remove(rec.login);
    if (r.ok) revoked.push(rec.login);
  }

  return {
    added, alreadyPresent, revoked, pendingRevocations,
  };
}

module.exports = {
  SHAPE, HEADER, buildExportText, parseExportText, planImport, applyImport, AccessStore,
};
