'use strict';
/**
 * Web Push subscriptions (#175) -- which browsers get a push when a session
 * needs a human, per user.
 *
 * Follows `prefs-store.js`'s shape rather than reusing its code, for the same
 * reason that file gives: a shared module is a rebase two sessions collide on
 * while related work is in flight. The rule that matters is identical --
 * PARTITIONING, not secrecy. A push subscription is not a credential an
 * attacker could reuse against this hub (the endpoint belongs to the push
 * service, and the hub still needs its own VAPID key to speak to it), so the
 * thing worth protecting is that exactly one subject's record is ever read or
 * written, keyed on the caller's verified partition key, never on anything
 * the request supplies.
 *
 * ONE RECORD PER BROWSER, not per device. A daemon "device" is a terminal the
 * agent runs in; a push subscription belongs to the installed PWA on a phone
 * or desktop that is not necessarily running any session at all -- it is just
 * somewhere the hub can reach the person. A user can hold several (a phone, a
 * laptop, a tablet), and toggling "Push to this device: Off" in one of them
 * must never touch the others.
 *
 * THE ID is derived from the endpoint, not a bare counter: re-subscribing the
 * same browser (a renewed subscription, a duplicate POST from a flaky
 * network) lands on the SAME record instead of piling up duplicates that
 * would each get their own copy of every notification.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const FILE = 'push-subscriptions.json';
const SHAPE = 'squad-hub/push-subscriptions@1';

// Nobody realistically owns more browsers than this. The cap exists for the
// same reason prefs-store.js caps pins: this is reachable from the internet
// under a token that cannot start work but can still write, and an unbounded
// list turns "remember my devices" into "fill up the disk".
const MAX_SUBSCRIPTIONS = 25;
const MAX_LABEL_LEN = 120;
const MAX_FIELD_LEN = 4096;
// Same constants web-push.js's `encryptPayload` checks against at send time
// (RFC 8291/8292: an uncompressed P-256 point is 0x04 followed by two
// 32-byte coordinates; the auth secret is a fixed 16 bytes) -- kept as a
// separate literal rather than importing web-push.js, to avoid coupling two
// modules that otherwise have no dependency on each other.
const P256DH_LEN = 65;
const AUTH_SECRET_LEN = 16;

/**
 * Is this a LITERAL IP address (not a hostname) in a private, loopback, or
 * link-local range?
 *
 * The hub itself -- not the browser -- is the one that later makes an
 * outbound HTTPS request to `endpoint` (see web-push.js's `postBinary`), so a
 * subscription is an attacker-controlled destination for a server-side
 * request. Every real Web Push service (FCM, Mozilla autopush, Apple,
 * Windows Notification Services) is reached by a public DNS name, never a
 * bare IP literal -- so rejecting IP literals in these ranges costs no
 * legitimate subscription anything, while closing off the most direct route
 * to the cloud-metadata address (169.254.169.254 falls in 169.254.0.0/16)
 * and internal-network services an attacker's browser cannot otherwise
 * reach. This is NOT a full SSRF defense (a public DNS name can still resolve
 * to a private address, including via later DNS rebinding) -- see
 * docs/security.md's Web Push section for what is and is not covered.
 */
function isPrivateOrLoopbackLiteral(hostname) {
  // A `URL`'s `hostname` getter keeps the brackets around an IPv6 literal
  // ("[::1]", not "::1") -- `net.isIP` does not recognize the bracketed
  // form at all and returns 0 ("not an IP"), which silently skipped every
  // check below for EVERY IPv6 literal (security review, finding 3): `[::1]`,
  // `[::]`, `[fd00::1]`, `[fe80::1]`, and the IPv4-mapped
  // `[::ffff:169.254.169.254]` (which the URL parser itself rewrites to its
  // hex form) all sailed through `validate()` unchallenged. Strip the
  // brackets before asking `net.isIP` so this function is actually reached
  // for IPv6 input at all.
  const bare = (hostname.startsWith('[') && hostname.endsWith(']'))
    ? hostname.slice(1, -1)
    : hostname;
  const kind = net.isIP(bare);
  if (kind === 4) {
    const [a, b] = bare.split('.').map(Number);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local + cloud metadata)
    if (a === 0) return true; // 0.0.0.0/8
    return false;
  }
  if (kind === 6) {
    // Refuse EVERY IPv6 literal outright, rather than re-enumerating
    // ::1/::/fc00::/7/fe80::/10/IPv4-mapped/IPv4-compatible in both dotted
    // and hex notation: no real push service is ever reached by a bare IPv6
    // literal (same reasoning as IPv4 above), so this costs no legitimate
    // subscription anything, and it closes off every IPv6 SSRF variant at
    // once -- including evasions this function does not yet know to name --
    // instead of only the ones a reviewer thought to test for.
    return true;
  }
  return false; // not an IP literal at all -- a hostname, judged on scheme alone
}

/** The id a subscription is stored and revoked under. Stable across re-subscribes of the same endpoint. */
function idFor(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('base64url').slice(0, 16);
}

/**
 * Validate a candidate subscription body.
 *
 * Returns `{ ok: true, value }` or `{ ok: false, reason }`, the same
 * convention as `prefs-store.js`'s `validate` and `access-store.js`'s
 * `add`/`remove` -- every rejection here is a message the API hands straight
 * back to a caller.
 */
function validate(body, { allowInsecureLoopback = false } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'the body must be a JSON object' };
  }
  const { endpoint, keys, label } = body;
  if (typeof endpoint !== 'string' || !endpoint) {
    return { ok: false, reason: 'endpoint must be a non-empty string' };
  }
  if (endpoint.length > MAX_FIELD_LEN) {
    return { ok: false, reason: `endpoint may not exceed ${MAX_FIELD_LEN} characters` };
  }
  let url;
  try { url = new URL(endpoint); } catch { return { ok: false, reason: 'endpoint is not a valid URL' }; }
  // A push service is reached over the open internet by the hub's own
  // process (security review, #175): the ENDPOINT IS SERVER-SIDE-REQUEST-
  // FORGERY INPUT, not merely browser data, because it is the hub's own
  // process that later POSTs to it (see web-push.js's `postBinary`). Loopback
  // is allowed ONLY when a caller explicitly opts in (`allowInsecureLoopback`,
  // used by tests standing in a fake push service) -- never unconditionally,
  // so a production deployment cannot be made to target the hub's own
  // loopback interface via subscription data.
  const isLoopbackHost = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]' || url.hostname === 'localhost';
  if (url.protocol === 'https:') {
    // Real push services are always reached by public DNS name, never a bare
    // IP literal -- rejecting private/link-local/loopback IP literals here
    // (including the cloud-metadata address, 169.254.169.254) closes off the
    // most direct SSRF route without costing any legitimate subscription
    // anything. This is intentionally not a full defense (a public hostname
    // can still resolve to a private address) -- see docs/security.md.
    if (isPrivateOrLoopbackLiteral(url.hostname) && !(allowInsecureLoopback && isLoopbackHost)) {
      return { ok: false, reason: 'endpoint must not target a private, loopback, or link-local address' };
    }
  } else if (!(allowInsecureLoopback && isLoopbackHost)) {
    return { ok: false, reason: 'endpoint must be https' };
  }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    return { ok: false, reason: 'keys must be an object with p256dh and auth' };
  }
  const { p256dh, auth } = keys;
  if (typeof p256dh !== 'string' || !p256dh || p256dh.length > MAX_FIELD_LEN) {
    return { ok: false, reason: 'keys.p256dh must be a non-empty string' };
  }
  if (typeof auth !== 'string' || !auth || auth.length > MAX_FIELD_LEN) {
    return { ok: false, reason: 'keys.auth must be a non-empty string' };
  }
  // Security review (#175, minor): these were previously only checked for
  // shape (non-empty string) here, with the actual byte-length validation
  // left to happen later, at SEND time, in web-push.js's `encryptPayload`.
  // That means a browser (or a hand-crafted request, since this is reachable
  // under a signed-in token) could register garbage that LOOKS like a
  // subscription and only find out it was never usable the first time
  // someone needed a push -- by then, possibly days later, with no feedback
  // to the person who could fix it. Decoding and length-checking here is the
  // same work `encryptPayload` already does (a P-256 uncompressed point is
  // always exactly 65 bytes; the auth secret is always exactly 16), so this
  // costs nothing new -- it only moves the same check to where it is cheap
  // to act on, instead of leaving it to be silently useless at send time.
  let p256dhBuf;
  try { p256dhBuf = Buffer.from(p256dh, 'base64url'); } catch { p256dhBuf = Buffer.alloc(0); }
  if (p256dhBuf.length !== P256DH_LEN) {
    return { ok: false, reason: 'keys.p256dh must be a base64url-encoded uncompressed P-256 point (65 bytes)' };
  }
  let authBuf;
  try { authBuf = Buffer.from(auth, 'base64url'); } catch { authBuf = Buffer.alloc(0); }
  if (authBuf.length !== AUTH_SECRET_LEN) {
    return { ok: false, reason: 'keys.auth must be a base64url-encoded 16-byte secret' };
  }
  let out = { endpoint, keys: { p256dh, auth }, label: null };
  if (label !== undefined) {
    if (typeof label !== 'string') return { ok: false, reason: 'label must be a string' };
    if (label.length > MAX_LABEL_LEN) return { ok: false, reason: `label may not exceed ${MAX_LABEL_LEN} characters` };
    out = { ...out, label: label || null };
  }
  return { ok: true, value: out };
}

class PushStore {
  /**
   * @param {object}  opts
   * @param {string} [opts.dir]      where to persist; omit for memory only
   * @param {boolean}[opts.persist]  false to keep everything in memory
   * @param {boolean}[opts.allowInsecureLoopback] let a subscription endpoint
   *   be a loopback address over plain http -- TEST-ONLY, so a suite can
   *   stand in a fake push service without a TLS cert. Never set this from
   *   production wiring (hub-service.js does not).
   */
  constructor({ dir = null, persist = true, allowInsecureLoopback = false } = {}) {
    this.dir = dir;
    this.persist = persist && !!dir;
    this.file = dir ? path.join(dir, FILE) : null;
    this.allowInsecureLoopback = allowInsecureLoopback;

    /** partition key -> Map(id -> record) */
    this._byKey = new Map();

    /** Same fail-closed-on-write convention as prefs-store.js and device-token-store.js. */
    this.ok = true;
    this.error = null;
    if (this.persist) this._load();
  }

  _load() {
    if (!this.persist) { this.ok = true; return true; }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(this.file)) {
        this.ok = true; this.error = null;
        return true;
      }
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!j || typeof j !== 'object' || j.shape !== SHAPE
        || typeof j.subjects !== 'object' || j.subjects === null) {
        throw new Error('not the shape this code wrote');
      }
      this._byKey = new Map(
        Object.entries(j.subjects).map(([k, v]) => [k, new Map(Object.entries(v))]),
      );
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
    if (!this.ok) throw new Error('refusing to write over a push-subscriptions file that did not load');
    const subjects = {};
    for (const [k, m] of this._byKey) subjects[k] = Object.fromEntries(m);
    const body = JSON.stringify({ shape: SHAPE, subjects }, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Same tolerance as prefs-store.js: Defender, the indexer, and
      // Windows/CIFS all briefly hold the destination open between our write
      // and rename.
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try { fs.unlinkSync(this.file); } catch { /* best effort */ }
      fs.renameSync(tmp, this.file);
    }
  }

  _bucket(key) {
    if (!this._byKey.has(key)) this._byKey.set(key, new Map());
    return this._byKey.get(key);
  }

  /** Every subscription this subject has registered, newest first. */
  list(key) {
    return [...this._bucket(key).values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Register or refresh a browser's subscription.
   *
   * Returns `{ ok: true, subscription }` or `{ ok: false, reason }`.
   * Re-subscribing the same endpoint replaces the record in place -- the id
   * is derived from the endpoint, so this is an upsert, not a duplicate.
   */
  add(key, body) {
    if (!this.ok) {
      return { ok: false, reason: `the push-subscriptions file could not be read (${this.error}); refusing to write over it` };
    }
    const v = validate(body, { allowInsecureLoopback: this.allowInsecureLoopback });
    if (!v.ok) return v;

    const bucket = this._bucket(key);
    const id = idFor(v.value.endpoint);
    const existing = bucket.get(id);
    if (!existing && bucket.size >= MAX_SUBSCRIPTIONS) {
      return { ok: false, reason: `this account already has ${MAX_SUBSCRIPTIONS} push subscriptions; remove one first` };
    }
    const record = {
      id,
      endpoint: v.value.endpoint,
      keys: v.value.keys,
      label: v.value.label,
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    bucket.set(id, record);
    try {
      this._save();
    } catch (e) {
      if (existing) bucket.set(id, existing); else bucket.delete(id);
      return { ok: false, reason: `could not save the subscription: ${e.message}` };
    }
    return { ok: true, subscription: record };
  }

  /**
   * Remove one subscription, by id, within one partition.
   *
   * Scoped to the caller's own partition on purpose, the same rule
   * `device-token-store.js`'s `revoke` follows: removing by bare id would let
   * one person silence another person's push.
   */
  remove(key, id) {
    if (!this.ok) throw new Error('refusing to write over a push-subscriptions file that did not load');
    const bucket = this._bucket(key);
    if (!bucket.has(id)) return false;
    bucket.delete(id);
    this._save();
    return true;
  }

  /**
   * Remove a subscription by its endpoint rather than its id.
   *
   * The push service tells the hub a subscription is gone (404/410) by
   * refusing a send to its ENDPOINT -- it has no idea this hub calls that
   * record an "id" -- so pruning after a failed send has to look it up the
   * same way `add` derives one, not by scanning every record for a text
   * match.
   */
  removeByEndpoint(key, endpoint) {
    return this.remove(key, idFor(endpoint));
  }

  /** How many subscriptions exist across every partition. For diagnostics only. */
  count() {
    let n = 0;
    for (const [, m] of this._byKey) n += m.size;
    return n;
  }
}

module.exports = {
  PushStore, validate, idFor, FILE, SHAPE, MAX_SUBSCRIPTIONS, MAX_LABEL_LEN,
};
