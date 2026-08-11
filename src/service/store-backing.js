'use strict';
/**
 * Where a `Store`'s per-subject buckets actually live.
 *
 * `Store` owns the isolation rules -- a subject key is required, every lookup
 * reaches into that subject's own bucket, nothing is filtered after the fact.
 * A backing owns nothing about isolation at all; it is asked once at start-up
 * for everything there is (`loadAll`), and after every mutation for the whole
 * set to keep (`persist`). Two backings exist:
 *
 *   - `MemoryBacking`: what `Store` always used before this. `loadAll` returns
 *     nothing, `persist` is a no-op. Nothing survives a restart, and nothing
 *     here pretends otherwise.
 *
 *   - `FileBacking`: durable, under `SQUAD_HUB_HOME` -- the same directory
 *     `access.json` and `device-tokens.json` already use, so no new Azure
 *     resource is needed. Fails the same way those two do: an unreadable file
 *     is refused rather than trusted, and the hub starts EMPTY rather than not
 *     starting at all.
 *
 * A CONFORMANCE SUITE (test/store-conformance-unit.js) runs the same
 * assertions against a `Store` built on each backing, so a durable one
 * inherits the isolation rules instead of re-deriving them. The dangerous
 * failure a backing could introduce is not "loses data" -- it is "returns, or
 * shares, another subject's record". `persist`/`loadAll` deal in the WHOLE
 * user map precisely so a backing has nowhere to slip a read across subjects:
 * there is no per-subject method to get subtly wrong.
 */

const fs = require('fs');
const path = require('path');

const FILE = 'sessions.json';
const SHAPE = 'squad-hub/sessions@1';

/** Rename atomically, tolerating the transient file locks Windows creates.
 *
 * Identical reasoning to device-token-store.js's atomicRename: Defender and
 * the indexer can briefly hold the destination open between our write and
 * rename, Windows reports that as EPERM, and the exact same rename succeeds
 * milliseconds later. Do NOT delete the destination first -- that would make
 * the update non-atomic and a crash in between would leave no valid file.
 */
function atomicRename(from, to) {
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (!retryable.has(e.code) || attempt >= 7) throw e;
      const waitMs = Math.min(10 * (2 ** attempt), 160);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

function serialiseUsers(users) {
  const subjects = {};
  for (const [subject, bucket] of users) {
    subjects[subject] = {
      devices: Object.fromEntries(bucket.devices),
      sessions: Object.fromEntries(bucket.sessions),
    };
  }
  return subjects;
}

function deserialiseUsers(subjects) {
  const users = new Map();
  for (const [subject, bucket] of Object.entries(subjects || {})) {
    users.set(subject, {
      devices: new Map(Object.entries((bucket && bucket.devices) || {})),
      sessions: new Map(Object.entries((bucket && bucket.sessions) || {})),
    });
  }
  return users;
}

/** Nothing survives a restart, and `Store` never has to check which backing
 * it has to know that -- `persist` simply does nothing. */
class MemoryBacking {
  // eslint-disable-next-line class-methods-use-this
  loadAll() { return new Map(); }

  // eslint-disable-next-line class-methods-use-this
  persist() {}

  get durable() { return false; }
}

/**
 * Session and device records under `SQUAD_HUB_HOME`.
 *
 * WHAT SURVIVES A RESTART, AND WHY THAT IS SAFE TO WRITE DOWN: everything a
 * device already publishes over its own WebSocket connection -- device
 * metadata and session state. None of it is a transcript (the hub never
 * stores those, see hub-service.js) and none of it is a secret the way a
 * token is.
 */
class FileBacking {
  /**
   * @param {object}  opts
   * @param {string} [opts.dir]      where to persist; omit for memory only
   * @param {boolean}[opts.persist]  false to keep everything in memory
   */
  constructor({ dir = null, persist = true } = {}) {
    this.dir = dir;
    this.persist_ = persist && !!dir;
    this.file = dir ? path.join(dir, FILE) : null;

    /**
     * Has the file been read successfully?
     *
     * False means "we cannot tell", and the honest response to that is to
     * refuse to write -- overwriting a file we could not parse would
     * silently discard whatever was recoverable in it. Reads still work: a
     * failed load simply starts the hub from an empty map, which is the
     * `Store` behaviour before this backing existed at all.
     */
    this.ok = true;
    this.error = null;
  }

  get durable() { return this.persist_; }

  loadAll() {
    if (!this.persist_) { this.ok = true; return new Map(); }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(this.file)) {
        // No file is not corrupt. A hub that has never persisted a session
        // has nothing to read yet, and that is fine.
        this.ok = true; this.error = null;
        return new Map();
      }
      const raw = fs.readFileSync(this.file, 'utf8');
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object' || j.shape !== SHAPE
        || typeof j.subjects !== 'object' || j.subjects === null) {
        throw new Error('not the shape this code wrote');
      }
      this.ok = true; this.error = null;
      return deserialiseUsers(j.subjects);
    } catch (e) {
      // Refuse to start failing, and refuse to trust what could not be
      // parsed. A truncated write (a crash mid-write, an out-of-space disk)
      // reads exactly like this, and the safe reading of "some sessions
      // might still be in there but I cannot tell which" is to start empty,
      // not to guess.
      this.ok = false;
      this.error = e.message;
      return new Map();
    }
  }

  /**
   * Persist the WHOLE user map, every time.
   *
   * A partial write -- merging this call's changes into whatever the file
   * already holds -- is exactly the dangerous shape: a session a live device
   * just deleted would still be sitting in the old file content and would be
   * merged back in, resurrecting a row the device dropped on purpose. Writing
   * the complete, current, in-memory state instead means there is nothing on
   * disk for a deleted row to survive in.
   */
  persist(users) {
    if (!this.persist_) return;
    if (!this.ok) {
      // Refusing to write over a file that failed to load, for the same
      // reason access.json and device-tokens.json refuse: writing an empty
      // (or partial) state over one we could not read would make the loss
      // permanent instead of merely undiagnosed.
      throw new Error('refusing to write over a session store that did not load');
    }
    const body = JSON.stringify({ shape: SHAPE, subjects: serialiseUsers(users) }, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    try {
      atomicRename(tmp, this.file);
    } catch (e) {
      // A small number of platforms refuse a rename onto an existing file
      // even after the retries above (access-store.js hit the same thing).
      // Unlinking the destination first is safe here specifically because we
      // still hold the fully-written replacement in `tmp`.
      if (e.code !== 'EEXIST') {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw e;
      }
      fs.unlinkSync(this.file);
      atomicRename(tmp, this.file);
    }
  }
}

module.exports = {
  MemoryBacking, FileBacking, FILE, SHAPE,
};
