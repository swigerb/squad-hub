'use strict';
/**
 * Which device tokens exist, and which have been revoked -- across restarts.
 *
 * WHAT IS AND IS NOT WRITTEN DOWN. Never the token. What is written is what an
 * operator needs to reason about them later: an id, a label, when it was
 * issued, when it expires, what it may register, and whether it was revoked.
 * None of that is secret, and that is deliberate -- on Azure App Service the
 * persistent volume is a CIFS mount that reports every file as world readable
 * and silently ignores chmod (measured; see docs/security.md), so anything
 * written there has to be safe to read.
 *
 * THIS FAILS CLOSED. If the file exists but cannot be read -- truncated, wrong
 * shape, unreadable -- every device token is refused rather than admitted. A
 * revocation list that fails OPEN is worse than having none at all: you would
 * believe a revoked credential was dead while it was live and working. That is
 * the whole reason this file is not simply a Map.
 *
 * Storage is a plain JSON file, written atomically. It was proven before it was
 * depended on -- spike/revocation-store-probe.js, run locally and on a live App
 * Service instance.
 */

const fs = require('fs');
const path = require('path');

const FILE = 'device-tokens.json';
const SHAPE = 1;

/**
 * Rename atomically, tolerating the transient file locks Windows creates.
 *
 * Defender and the indexer can briefly open the destination between our write
 * and rename. Windows reports that as EPERM; the exact same operation succeeds
 * milliseconds later. This happened in the full suite against a real temp
 * directory.
 *
 * Do NOT delete the destination first. That would make the update non-atomic:
 * a crash in between would leave no valid revocation store at all. Retrying
 * preserves the old good file until the new one replaces it.
 */
function atomicRename(from, to) {
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (!retryable.has(e.code) || attempt >= 7) throw e;
      // Synchronous by design: _save() is synchronous, and returning before
      // the rename would let the caller report a revocation that is not stored.
      const waitMs = Math.min(10 * (2 ** attempt), 160);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

class DeviceTokenStore {
  /**
   * @param {object}  opts
   * @param {string} [opts.dir]      where to persist; omit for memory only
   * @param {boolean}[opts.persist]  false to keep everything in memory
   */
  constructor({ dir = null, persist = true } = {}) {
    this.dir = dir;
    this.persist = persist && !!dir;
    this.file = dir ? path.join(dir, FILE) : null;

    /** partition key -> Map(jti -> record) */
    this._byKey = new Map();
    /** jti -> expiry, for revoked tokens only */
    this._revoked = new Map();

    /**
     * Has the store been read successfully?
     *
     * False means "we cannot tell", and everything downstream treats that as
     * "refuse". A hub with NO file has never revoked anything and is fine; a
     * hub with an unreadable one is not.
     */
    this.ok = true;
    this.error = null;
    if (this.persist) this.load();
  }

  load() {
    if (!this.persist) { this.ok = true; return true; }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(this.file)) {
        // Absent is not broken. A hub that has issued nothing has no file and
        // must still work.
        this.ok = true; this.error = null;
        return true;
      }
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!j || typeof j !== 'object' || j.shape !== SHAPE
        || typeof j.issued !== 'object' || j.issued === null
        || typeof j.revoked !== 'object' || j.revoked === null) {
        throw new Error('not the shape this code wrote');
      }
      this._byKey = new Map(Object.entries(j.issued).map(([k, v]) => [k, new Map(Object.entries(v))]));
      this._revoked = new Map(Object.entries(j.revoked));
      this.ok = true; this.error = null;
      return true;
    } catch (e) {
      this.ok = false;
      this.error = e.message;
      // Deliberately NOT cleared. Holding the last good state in memory while
      // reporting not-ok keeps the failure visible instead of quietly starting
      // from empty, which would read as "nothing was ever revoked".
      return false;
    }
  }

  _save() {
    if (!this.persist) return;
    if (!this.ok) throw new Error('refusing to write over a store that did not load');
    const issued = {};
    for (const [k, m] of this._byKey) issued[k] = Object.fromEntries(m);
    const body = JSON.stringify({
      shape: SHAPE,
      issued,
      revoked: Object.fromEntries(this._revoked),
    }, null, 2);
    // Atomic: write a temp file then rename, so a crash between the two leaves
    // the previous good file rather than a half-written one.
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    atomicRename(tmp, this.file);
  }

  _bucket(key) {
    if (!this._byKey.has(key)) this._byKey.set(key, new Map());
    return this._byKey.get(key);
  }

  /** Record a token that was just issued. Never the token itself. */
  record(key, { jti, label, didPrefix, issuedAt, expiresAt }) {
    this._bucket(key).set(jti, {
      jti,
      label: label || null,
      didPrefix: didPrefix || null,
      issuedAt: issuedAt || Date.now(),
      expiresAt,
      revokedAt: null,
    });
    this.prune();
    this._save();
  }

  /** Everything issued in this partition, newest first. */
  list(key) {
    this.prune();
    return [...this._bucket(key).values()]
      .map((r) => ({ ...r, revoked: !!r.revokedAt }))
      .sort((a, b) => b.issuedAt - a.issuedAt);
  }

  /**
   * Revoke one token, by id, within one partition.
   *
   * Scoped to the caller's own partition on purpose: revoking by bare id would
   * let one person kill another person's devices.
   */
  revoke(key, jti) {
    if (!this.ok) throw new Error('refusing to revoke against a store that did not load');
    const rec = this._bucket(key).get(jti);
    if (!rec) return false;
    if (!rec.revokedAt) rec.revokedAt = Date.now();
    this._revoked.set(jti, rec.expiresAt);
    this.prune();
    this._save();
    return true;
  }

  /**
   * The question every request asks.
   *
   * Returns TRUE (revoked) when the store could not be read. That single line
   * is the fail-closed decision: if we cannot tell, we refuse.
   */
  isRevoked(jti) {
    if (!this.ok) return true;
    return this._revoked.has(String(jti));
  }

  /**
   * Forget what can no longer matter.
   *
   * A revoked entry is dropped once the token would have expired anyway -- it
   * could not be used either way, so keeping it only grows the file.
   */
  prune(now = Date.now()) {
    let dropped = 0;
    for (const [, m] of this._byKey) {
      for (const [jti, rec] of m) {
        if (Number.isFinite(rec.expiresAt) && rec.expiresAt <= now) { m.delete(jti); dropped += 1; }
      }
    }
    for (const [jti, exp] of this._revoked) {
      if (Number.isFinite(exp) && exp <= now) { this._revoked.delete(jti); dropped += 1; }
    }
    return dropped;
  }
}

module.exports = { DeviceTokenStore, FILE };
