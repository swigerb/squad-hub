#!/usr/bin/env node
'use strict';
/**
 * A0 premise: can a revocation list survive a process restart, on a plain
 * filesystem, with no database and no cloud dependency?
 *
 * This is a SPIKE. It proves the storage property before any hub code depends
 * on it. If this fails, the design changes -- not the plan.
 *
 * Four things are being tested, and the third is the one that matters:
 *
 *   1. A revoked id is still revoked after the process that wrote it is gone.
 *   2. The file self-prunes, so it cannot grow without bound.
 *   3. AN UNREADABLE STORE REFUSES EVERY TOKEN. A revocation list that fails
 *      OPEN is worse than no revocation list at all, because you would believe
 *      a revoked credential was dead when it is live. This is the whole reason
 *      the spike exists.
 *   4. A crash mid-write cannot corrupt it.
 *
 * MEASURED, and it changes the design: /home on Azure App Service is a CIFS
 * (Azure Files) mount. Every file reports mode 777, files are owned by nobody,
 * and chmod SUCCEEDS WHILE DOING NOTHING. So file permissions cannot be relied
 * on there -- which is precisely why this store persists revoked ids and no
 * token material. Nothing secret may ever be written to /home.
 *
 * Usage: node spike/revocation-store-probe.js [--dir <path>]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argDir = (() => {
  const i = process.argv.indexOf('--dir');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

// ---------------------------------------------------------------------------
// The candidate implementation. Deliberately tiny: the only thing persisted is
// a map of revoked token id -> the moment the token would have expired anyway.
//
// It stores NO token material. Knowing that an id is revoked tells an attacker
// nothing, so this file is not a secret -- which is exactly why it is allowed
// to be a plain file rather than a vault.
// ---------------------------------------------------------------------------
class RevocationStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'revocations.json');
    this.ok = false;      // has the store been read successfully?
    this.error = null;
    this._map = new Map();
  }

  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(this.file)) {
        // Absent is not broken. A hub that has never revoked anything has no
        // file, and must still work.
        this._map = new Map();
        this.ok = true;
        this.error = null;
        return true;
      }
      const raw = fs.readFileSync(this.file, 'utf8');
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object' || typeof j.revoked !== 'object' || j.revoked === null) {
        throw new Error('revocations file is not the shape this code wrote');
      }
      this._map = new Map(Object.entries(j.revoked));
      this.ok = true;
      this.error = null;
      return true;
    } catch (e) {
      // Present but unreadable is a HARD failure. See isRevoked().
      this.ok = false;
      this.error = e.message;
      this._map = new Map();
      return false;
    }
  }

  _persist() {
    // Atomic: write a temp file then rename. A crash between the two leaves the
    // previous good file intact rather than a half-written one.
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = JSON.stringify({ revoked: Object.fromEntries(this._map) }, null, 2);
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  revoke(jti, expiresAtMs) {
    if (!this.ok) throw new Error('refusing to revoke against a store that did not load');
    this._map.set(String(jti), Number(expiresAtMs));
    this.prune();
    this._persist();
  }

  /**
   * The question every request asks.
   *
   * Returns TRUE (revoked) when the store is unreadable. That is the fail-closed
   * decision, stated in one place: if we cannot tell, we refuse.
   */
  isRevoked(jti) {
    if (!this.ok) return true;
    return this._map.has(String(jti));
  }

  /** Drop entries whose token would have expired anyway. */
  prune(now = Date.now()) {
    let dropped = 0;
    for (const [jti, exp] of this._map) {
      if (Number.isFinite(exp) && exp <= now) { this._map.delete(jti); dropped += 1; }
    }
    return dropped;
  }

  size() { return this._map.size; }
}

// ---------------------------------------------------------------------------
if (process.env.PROBE_CHILD) {
  // Runs as a SEPARATE PROCESS, so "survives a restart" is a real restart and
  // not a variable that happened to stay in scope.
  const store = new RevocationStore(process.env.PROBE_DIR);
  store.load();
  const op = process.env.PROBE_CHILD;
  if (op === 'write') {
    store.revoke('jti-alive', Date.now() + 3600000);   // still valid: must persist
    store.revoke('jti-expired', Date.now() - 1000);    // already dead: must be pruned
    process.stdout.write(JSON.stringify({ size: store.size() }));
  } else if (op === 'read') {
    process.stdout.write(JSON.stringify({
      ok: store.ok,
      error: store.error,
      alive: store.isRevoked('jti-alive'),
      expired: store.isRevoked('jti-expired'),
      unknown: store.isRevoked('never-seen'),
      size: store.size(),
    }));
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n         ${e.message}`); }
}
const assert = require('assert');

function child(op, dir) {
  const r = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, PROBE_CHILD: op, PROBE_DIR: dir },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`child ${op} exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const DIR = argDir || fs.mkdtempSync(path.join(os.tmpdir(), 'revstore-'));
console.log('revocation store probe');
console.log('='.repeat(60));
console.log(`store dir: ${DIR}\n`);

check('a revoked id survives the process that revoked it', () => {
  child('write', DIR);
  const after = child('read', DIR);   // a genuinely different process
  assert.strictEqual(after.ok, true, `store did not load: ${after.error}`);
  assert.strictEqual(after.alive, true, 'the revocation was lost across a restart');
});

check('an entry is dropped once its token would have expired anyway', () => {
  const after = child('read', DIR);
  assert.strictEqual(after.expired, false, 'expired entries accumulate; the file grows forever');
  assert.strictEqual(after.size, 1, `expected 1 live entry, found ${after.size}`);
});

check('an id nobody revoked is not revoked', () => {
  const after = child('read', DIR);
  assert.strictEqual(after.unknown, false, 'everything is treated as revoked; the hub is bricked');
});

check('a hub that has never revoked anything still works', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'revstore-empty-'));
  const s = new RevocationStore(empty);
  assert.strictEqual(s.load(), true, 'a missing file was treated as an error');
  assert.strictEqual(s.isRevoked('anything'), false);
  fs.rmSync(empty, { recursive: true, force: true });
});

// THE ONE THAT MATTERS.
check('AN UNREADABLE STORE REFUSES EVERY TOKEN (fail closed)', () => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'revstore-broken-'));
  fs.writeFileSync(path.join(broken, 'revocations.json'), '{ this is not json');
  const s = new RevocationStore(broken);
  assert.strictEqual(s.load(), false, 'corrupt JSON was accepted as a valid store');
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.isRevoked('any-token-at-all'), true,
    'FAILED OPEN: a revoked credential would be accepted as live');
  fs.rmSync(broken, { recursive: true, force: true });
});

check('a store with the wrong shape is refused, not silently ignored', () => {
  // An empty object parses as JSON but is not a store this code wrote. Reading
  // it as "no revocations" would silently discard every revocation on record.
  const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'revstore-odd-'));
  fs.writeFileSync(path.join(odd, 'revocations.json'), '{}');
  const s = new RevocationStore(odd);
  assert.strictEqual(s.load(), false, 'a file with no revoked map was accepted');
  assert.strictEqual(s.isRevoked('x'), true);
  fs.rmSync(odd, { recursive: true, force: true });
});

check('revoking against a store that did not load is refused', () => {
  // Otherwise a revocation would be written on top of a file we could not read,
  // destroying every revocation already in it.
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'revstore-broken2-'));
  fs.writeFileSync(path.join(broken, 'revocations.json'), 'not json at all');
  const s = new RevocationStore(broken);
  s.load();
  assert.throws(() => s.revoke('x', Date.now() + 1000), /did not load/);
  fs.rmSync(broken, { recursive: true, force: true });
});

check('a crash mid-write cannot corrupt the store', () => {
  // Simulate the interrupted write: a stray temp file must not be mistaken for
  // the store, and the real file must still parse.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'revstore-atomic-'));
  const s = new RevocationStore(d);
  s.load();
  s.revoke('jti-1', Date.now() + 60000);
  fs.writeFileSync(path.join(d, 'revocations.json.9999.tmp'), '{ partial');
  const s2 = new RevocationStore(d);
  assert.strictEqual(s2.load(), true, 'a leftover temp file broke the store');
  assert.strictEqual(s2.isRevoked('jti-1'), true);
  fs.rmSync(d, { recursive: true, force: true });
});

check('the store is not world readable, where the filesystem can enforce that', () => {
  if (process.platform === 'win32') { console.log('       (skipped: POSIX modes)'); return; }
  const f = path.join(DIR, 'revocations.json');

  // Find out whether this filesystem honours modes AT ALL before asserting on
  // them. Azure Files (CIFS), which backs /home on App Service, reports every
  // file as 777 and silently ignores chmod -- so a plain assertion here fails
  // for a reason that has nothing to do with this code, and a plain skip would
  // hide a real regression on a normal disk.
  const probe = path.join(DIR, '.mode-support');
  fs.writeFileSync(probe, 'x', { mode: 0o600 });
  const enforced = (fs.statSync(probe).mode & 0o077) === 0;
  fs.unlinkSync(probe);

  if (!enforced) {
    console.log('       NOTE: this filesystem does not enforce permissions (chmod is a no-op).');
    console.log('       The store holds only revoked ids and no token material, which is why');
    console.log('       that is survivable -- but NOTHING SECRET may be written here.');
    return;
  }
  const st = fs.statSync(f);
  assert.strictEqual(st.mode & 0o077, 0, 'other users can read the store');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (!argDir) fs.rmSync(DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
