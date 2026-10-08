'use strict';
/**
 * Per-user preferences -- pins, renames, and the saved view -- stored
 * server-side so they follow a user across every device they sign into.
 *
 * The thing worth protecting here is NOT secrecy -- a pin list is not a
 * credential -- it is PARTITIONING. Exactly one subject's record is ever read
 * or written by `get`/`set`, keyed on the caller's verified partition key
 * (`me.key` from auth.js), never on anything the request supplies. See
 * access-store.js and store-backing.js for the same rule applied to access
 * grants and sessions respectively; this module follows their shape rather
 * than reusing their code, because #166 (device kind) is in flight against
 * `store.js` and `docs/api.md` at the same time, and a shared file is a
 * rebase two sessions would otherwise collide on.
 *
 * Caps exist because this is reachable from the internet, under a token that
 * cannot start work but CAN still write: an unbounded pin list or an
 * unbounded name turns "remember my preferences" into "fill up the disk" or
 * "break the client that has to render this".
 */

const fs = require('fs');
const path = require('path');

const FILE = 'prefs.json';
const SHAPE = 'squad-hub/prefs@1';

const MAX_PINS = 500;
const MAX_NAMES = 500;
const MAX_NAME_LEN = 120;
// Not named in the issue, but a key with no bound at all would let either cap
// be defeated by a single enormous string long before the count limit bites.
const MAX_KEY_LEN = 300;
const MAX_VIEW_STRING_LEN = 300;

/** Default, empty preferences -- what every subject has before their first PUT. */
function emptyPrefs() {
  return { pins: [], names: {}, view: null };
}

/**
 * Validate and normalize a candidate preferences body.
 *
 * Returns `{ ok: true, value }` or `{ ok: false, reason }`. Never throws --
 * every rejection here is a message the API hands straight back to a caller,
 * the same convention as `access-store.js`'s `add`/`remove`.
 */
function validate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'the body must be a JSON object' };
  }
  const allowedKeys = new Set(['pins', 'names', 'view']);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) return { ok: false, reason: `unknown field "${key}"` };
  }

  const out = emptyPrefs();

  if (body.pins !== undefined) {
    if (!Array.isArray(body.pins)) return { ok: false, reason: 'pins must be an array' };
    if (body.pins.length > MAX_PINS) return { ok: false, reason: `pins may not exceed ${MAX_PINS}` };
    const pins = [];
    const seen = new Set();
    for (const p of body.pins) {
      if (typeof p !== 'string' || !p) return { ok: false, reason: 'every pin must be a non-empty string' };
      if (p.length > MAX_KEY_LEN) return { ok: false, reason: `a pin may not exceed ${MAX_KEY_LEN} characters` };
      // De-duplicated here, silently, rather than rejected: a client that
      // re-sends a pin it already holds (a retry, a race between two tabs) is
      // not sending a malformed request, so there is nothing to refuse.
      if (!seen.has(p)) { seen.add(p); pins.push(p); }
    }
    out.pins = pins;
  }

  if (body.names !== undefined) {
    if (body.names === null || typeof body.names !== 'object' || Array.isArray(body.names)) {
      return { ok: false, reason: 'names must be an object mapping a session key to a string' };
    }
    const entries = Object.entries(body.names);
    if (entries.length > MAX_NAMES) return { ok: false, reason: `names may not exceed ${MAX_NAMES} entries` };
    const names = {};
    for (const [key, value] of entries) {
      if (!key || key.length > MAX_KEY_LEN) {
        return { ok: false, reason: `a name's session key may not exceed ${MAX_KEY_LEN} characters` };
      }
      if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, reason: `the name for "${key}" must be a non-empty string` };
      }
      if (value.length > MAX_NAME_LEN) {
        return { ok: false, reason: `the name for "${key}" may not exceed ${MAX_NAME_LEN} characters` };
      }
      names[key] = value;
    }
    out.names = names;
  }

  if (body.view !== undefined) {
    if (body.view === null) {
      out.view = null;
    } else {
      if (typeof body.view !== 'object' || Array.isArray(body.view)) {
        return { ok: false, reason: 'view must be an object or null' };
      }
      const viewKeys = new Set(['scope', 'filters', 'groupBy', 'sortBy']);
      for (const key of Object.keys(body.view)) {
        if (!viewKeys.has(key)) return { ok: false, reason: `unknown view field "${key}"` };
      }
      const view = {};
      for (const field of ['scope', 'groupBy', 'sortBy']) {
        const v = body.view[field];
        if (v === undefined) continue;
        if (typeof v !== 'string' || v.length > MAX_VIEW_STRING_LEN) {
          return { ok: false, reason: `view.${field} must be a string of at most ${MAX_VIEW_STRING_LEN} characters` };
        }
        view[field] = v;
      }
      if (body.view.filters !== undefined) {
        const f = body.view.filters;
        if (f === null || typeof f !== 'object' || Array.isArray(f)) {
          return { ok: false, reason: 'view.filters must be an object' };
        }
        // A filters object is free-form (the client decides what it filters
        // on), but it is not UNBOUNDED -- the same reasoning as every other
        // cap here.
        if (JSON.stringify(f).length > 20000) {
          return { ok: false, reason: 'view.filters is too large' };
        }
        view.filters = f;
      }
      out.view = view;
    }
  }

  return { ok: true, value: out };
}

class PrefsStore {
  /**
   * @param {object}  opts
   * @param {string} [opts.dir]      where to persist; omit for memory only
   * @param {boolean}[opts.persist]  false to keep everything in memory
   */
  constructor({ dir = null, persist = true } = {}) {
    this.dir = dir;
    this.persist = persist && !!dir;
    this.file = dir ? path.join(dir, FILE) : null;

    /** subject key -> prefs record */
    this._prefs = new Map();

    /**
     * Has the file been read successfully? False means "we cannot tell", and
     * the honest response is to refuse to write -- see store-backing.js and
     * access-store.js for the identical rule and the identical reason: an
     * overwrite of a file this process could not parse would make whatever
     * was recoverable in it permanently gone.
     */
    this.ok = true;
    this.error = null;
    if (this.persist) this._load();
  }

  _load() {
    if (!this.persist) { this.ok = true; return true; }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(this.file)) {
        // No file is not corrupt. Nobody has ever saved a preference on this
        // hub yet, and that is fine.
        this.ok = true; this.error = null;
        return true;
      }
      const raw = fs.readFileSync(this.file, 'utf8');
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object' || j.shape !== SHAPE
        || typeof j.subjects !== 'object' || j.subjects === null) {
        throw new Error('not the shape this code wrote');
      }
      this._prefs = new Map(Object.entries(j.subjects));
      this.ok = true; this.error = null;
      return true;
    } catch (e) {
      this.ok = false;
      this.error = e.message;
      return false;
    }
  }

  _save() {
    if (!this.persist) return;
    if (!this.ok) throw new Error('refusing to write over a preferences file that did not load');
    const body = JSON.stringify({ shape: SHAPE, subjects: Object.fromEntries(this._prefs) }, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Same tolerance as access-store.js and store-backing.js: Defender, the
      // indexer, and Windows/CIFS all briefly hold the destination open
      // between our write and rename, and an unlink-then-rename is safe here
      // specifically because the replacement is already fully written to tmp.
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try { fs.unlinkSync(this.file); } catch { /* best effort */ }
      fs.renameSync(tmp, this.file);
    }
  }

  /** This subject's preferences, or the empty defaults if none were ever saved. */
  get(subject) {
    const rec = this._prefs.get(subject);
    return rec ? { pins: [...rec.pins], names: { ...rec.names }, view: rec.view } : emptyPrefs();
  }

  /**
   * Replace this subject's preferences wholly.
   *
   * A PUT, not a PATCH: the body is the full record the client intends this
   * subject to hold from now on, the same "whole state, every time" rule
   * `store-backing.js`'s `persist` uses for session records. A field left out
   * of the body reverts to its default (`pins: []`, `names: {}`, `view:
   * null`) rather than being left untouched, so a client never has to guess
   * what an omission means.
   *
   * Returns `{ ok: true, prefs }` or `{ ok: false, reason }`.
   */
  set(subject, body) {
    if (!this.ok) {
      return { ok: false, reason: `the preferences file could not be read (${this.error}); refusing to write over it` };
    }
    const v = validate(body);
    if (!v.ok) return v;

    const previous = this._prefs.get(subject);
    this._prefs.set(subject, v.value);
    try {
      this._save();
    } catch (e) {
      if (previous) this._prefs.set(subject, previous); else this._prefs.delete(subject);
      return { ok: false, reason: `could not save preferences: ${e.message}` };
    }
    return { ok: true, prefs: this.get(subject) };
  }
}

module.exports = {
  PrefsStore, validate, emptyPrefs, FILE, SHAPE, MAX_PINS, MAX_NAMES, MAX_NAME_LEN,
};
