'use strict';
/**
 * Who may use this hub, changeable without a redeploy.
 *
 * The allow-list used to live only in `SQUAD_HUB_ALLOWED_USERS`, which meant
 * adding a colleague was an App Service settings edit and a restart -- so in
 * practice it did not happen, and the alternative to "add them properly" was
 * "send them a token", which is worse.
 *
 * Three rules hold this together, and each exists because its absence is a
 * privilege escalation:
 *
 *   1. OWNERS ARE NOT GRANTABLE, AND NOT REMOVABLE HERE. Owner identities share
 *      ONE partition: adding an owner does not admit a colleague, it makes them
 *      the same person as you, with your devices and your sessions. Removing
 *      one through a browser is how somebody locks themselves out of their own
 *      hub. Owners come from `SQUAD_HUB_OWNER` only.
 *
 *   2. ONLY AN OWNER MAY WRITE. An allowed user cannot add another. Otherwise
 *      one invitation is the whole hub, transitively, and the person who owns
 *      it never sees the chain.
 *
 *   3. A REMOVAL MUST ACTUALLY REMOVE. `SQUAD_HUB_ALLOWED_USERS` cannot be
 *      edited from a browser, so removing somebody it names is recorded as a
 *      revocation and applied on top of it. Without that, the one person most
 *      likely to need removing -- the colleague you added at deploy time --
 *      would be the one person the screen could not remove, and the honest
 *      version of that screen has no Remove button at all.
 *
 * Rules 1 and 3 are enforced HERE rather than at the route, so a second caller
 * added later inherits them instead of re-deriving them.
 */

const fs = require('fs');
const path = require('path');

const FILE = 'access.json';
const SHAPE = 'squad-hub/access@2';

/**
 * What counts as an identity we will store.
 *
 * A GitHub login, a UPN, an email, or an Entra object id -- the same shapes
 * `SQUAD_HUB_ALLOWED_USERS` already accepts, because a list you can edit two
 * ways must mean the same thing both ways. Anything else is refused at the
 * door rather than stored and silently never matched.
 */
const MAX_LEN = 128;
function normalise(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return { ok: false, reason: 'an empty name is not an identity' };
  if (s.length > MAX_LEN) return { ok: false, reason: `too long (limit ${MAX_LEN} characters)` };
  // Deliberately narrow. Everything the auth layer compares against is drawn
  // from this alphabet, and a value outside it could never match anyone -- so
  // storing it would add a row that looks like access and grants none.
  if (!/^[a-z0-9._@+-]+$/.test(s)) {
    return { ok: false, reason: 'may contain only letters, digits and . _ @ + -' };
  }
  return { ok: true, value: s };
}

class AccessStore {
  /**
   * @param {object}   opts
   * @param {string}  [opts.dir]           where to persist; omit for memory only
   * @param {boolean} [opts.persist]       false to keep everything in memory
   * @param {string[]}[opts.envAllowed]    SQUAD_HUB_ALLOWED_USERS, the floor
   * @param {string[]}[opts.envOwner]      SQUAD_HUB_OWNER, never editable
   */
  constructor({
    dir = null, persist = true, envAllowed = [], envOwner = [],
  } = {}) {
    this.dir = dir;
    this.persist = persist && !!dir;
    this.file = dir ? path.join(dir, FILE) : null;

    const clean = (list) => (list || [])
      .map((u) => String(u).trim().toLowerCase())
      .filter(Boolean);
    this.envAllowed = clean(envAllowed);
    this.envOwner = clean(envOwner);

    /** login -> { addedBy, addedAt, note } */
    this._added = new Map();

    /**
     * Identities from `SQUAD_HUB_ALLOWED_USERS` that have been removed here.
     *
     * The environment variable cannot be edited from a browser, so a removal
     * has to be recorded and applied on top of it. Kept as a separate set
     * rather than by rewriting `envAllowed`, so that if the deployment later
     * drops the name itself, the record is simply inert.
     */
    this._revoked = new Set();

    /**
     * Has the store been read successfully?
     *
     * False means "we cannot tell". Reads still work -- they fall back to the
     * environment, which is the floor and is always known -- but writes are
     * refused, because writing over a file we could not parse would silently
     * discard whoever was in it.
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
        // A hub that has never added anyone has no file, and that is not a
        // fault. It runs on its environment list alone.
        this.ok = true; this.error = null;
        return true;
      }
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!j || typeof j !== 'object' || j.shape !== SHAPE
        || typeof j.added !== 'object' || j.added === null) {
        throw new Error('not the shape this code wrote');
      }
      this._added = new Map(Object.entries(j.added));
      this._revoked = new Set(Array.isArray(j.revoked) ? j.revoked : []);
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
    if (!this.ok) throw new Error('refusing to write over an access list that did not load');
    const body = JSON.stringify({
      shape: SHAPE,
      added: Object.fromEntries(this._added),
      revoked: [...this._revoked],
    }, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Windows and CIFS both refuse a rename onto an existing file often
      // enough that this is the normal path, not the exceptional one.
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      fs.unlinkSync(this.file);
      fs.renameSync(tmp, this.file);
    }
  }

  /**
   * Everyone who may sign in: the environment floor plus anyone added since.
   *
   * This is what the authenticator is given, so a grant takes effect without a
   * restart.
   */
  allowedUsers() {
    const live = this.envAllowed.filter((u) => !this._revoked.has(u));
    return [...new Set([...live, ...this._added.keys()])];
  }

  /**
   * The list as a screen needs to show it: who, from where, and whether this
   * entry can be removed.
   *
   * `source` is the honest part. A row that cannot be removed must say why
   * before somebody clicks and is refused -- an X that fails is worse than no X.
   */
  list() {
    const rows = [];
    for (const login of this.envOwner) {
      rows.push({
        login, source: 'owner', removable: false, addedBy: null, addedAt: null, note: null,
      });
    }
    for (const login of this.envAllowed) {
      if (this.envOwner.includes(login)) continue;
      if (this._revoked.has(login)) continue;
      rows.push({
        login, source: 'deployment', removable: true, addedBy: null, addedAt: null, note: null,
      });
    }
    for (const [login, rec] of this._added) {
      if (this.envOwner.includes(login)) continue;
      // An identity that is BOTH in the deployment list and added here is one
      // person: re-adding somebody after removing them clears the revocation,
      // so the deployment row is live again and this would be a duplicate.
      if (this.envAllowed.includes(login) && !this._revoked.has(login)) continue;
      rows.push({
        login,
        source: 'added',
        removable: true,
        addedBy: rec.addedBy || null,
        addedAt: rec.addedAt || null,
        note: rec.note || null,
      });
    }
    // Owners first, then whatever the deployment set, then anyone added here.
    // An access list is read top-down for "who has the most authority", and
    // alphabetical order buries the owner somewhere in the middle.
    const rank = { owner: 0, deployment: 1, added: 2 };
    rows.sort((a, b) => (rank[a.source] - rank[b.source]) || a.login.localeCompare(b.login));
    return rows;
  }

  /**
   * Add someone. Returns { ok, reason } rather than throwing, because every
   * refusal here is a message a person needs to read.
   *
   * `addedAt` defaults to now, as it always has -- but an import restoring a
   * previously-exported record needs to write back the ORIGINAL timestamp, or
   * a round trip through export and import could never be identical. Passing
   * it through `add()` (rather than a second write path) keeps the ownership
   * and duplicate checks in the one place that already enforces them.
   */
  add(rawLogin, {
    addedBy = null, note = null, addedAt = null,
  } = {}) {
    if (!this.ok) return { ok: false, reason: `the access list could not be read (${this.error}); refusing to write over it` };
    const n = normalise(rawLogin);
    if (!n.ok) return { ok: false, reason: n.reason };
    const login = n.value;

    // Not an error, and deliberately not a silent success either: someone who
    // adds a name already in the deployment's own list should be told it is
    // already there rather than left thinking they changed something.
    if (this.envOwner.includes(login)) return { ok: false, reason: 'that identity is an owner of this hub already' };
    if (this.envAllowed.includes(login) && !this._revoked.has(login)) {
      return { ok: false, reason: 'that identity is in the deployment configuration already' };
    }
    if (this._added.has(login)) return { ok: false, reason: 'that identity has access already' };

    /**
     * Adding back somebody the deployment already names is an UNDO, not a
     * second grant. Clearing the revocation restores the row they had, so the
     * list does not end up holding one person twice under two sources.
     */
    if (this._revoked.has(login)) {
      this._revoked.delete(login);
      try {
        this._save();
      } catch (e) {
        this._revoked.add(login);
        return { ok: false, reason: `could not save the access list: ${e.message}` };
      }
      return { ok: true, login, restored: true };
    }

    const cleanNote = note == null ? null : String(note).trim().slice(0, 200) || null;
    this._added.set(login, {
      addedBy: addedBy ? String(addedBy).slice(0, MAX_LEN) : null,
      addedAt: Number.isFinite(addedAt) ? addedAt : Date.now(),
      note: cleanNote,
    });
    try {
      this._save();
    } catch (e) {
      this._added.delete(login);
      return { ok: false, reason: `could not save the access list: ${e.message}` };
    }
    return { ok: true, login };
  }

  /**
   * Remove somebody.
   *
   * An owner is refused: owner identities come from the deployment and removing
   * one from a browser is how a person locks themselves out of their own hub.
   *
   * Anyone else goes, including an identity named by
   * `SQUAD_HUB_ALLOWED_USERS`. That variable cannot be edited from here, so the
   * removal is recorded as a revocation and applied on top of it.
   */
  remove(rawLogin) {
    if (!this.ok) return { ok: false, reason: `the access list could not be read (${this.error}); refusing to write over it` };
    const n = normalise(rawLogin);
    if (!n.ok) return { ok: false, reason: n.reason };
    const login = n.value;

    if (this.envOwner.includes(login)) {
      return { ok: false, reason: 'owners are set by the deployment (SQUAD_HUB_OWNER) and cannot be removed here' };
    }

    const wasAdded = this._added.get(login);
    const fromEnv = this.envAllowed.includes(login) && !this._revoked.has(login);
    if (!wasAdded && !fromEnv) return { ok: false, reason: 'that identity does not have access' };

    if (wasAdded) this._added.delete(login);
    if (fromEnv) this._revoked.add(login);
    try {
      this._save();
    } catch (e) {
      if (wasAdded) this._added.set(login, wasAdded);
      if (fromEnv) this._revoked.delete(login);
      return { ok: false, reason: `could not save the access list: ${e.message}` };
    }
    return { ok: true, login, wasDeploymentEntry: fromEnv };
  }
}

module.exports = { AccessStore, normalise, FILE, SHAPE };
