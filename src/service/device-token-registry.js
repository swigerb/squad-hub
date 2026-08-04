'use strict';
/**
 * What device tokens exist, and which have been revoked.
 *
 * WHAT IS AND IS NOT RECORDED. The token is never stored -- there is no table
 * of live credentials to leak. What is recorded is what an operator needs in
 * order to reason about them later: an id, a label, when it was issued, when it
 * expires, and what it is allowed to register. None of that is secret, which is
 * the whole reason it is allowed to be written to a plain file at all. On Azure
 * App Service the persistent volume cannot enforce file permissions (measured;
 * see docs/security.md), so anything written there must be safe to read.
 *
 * In-memory for now. The interface is the design decision; where it is backed
 * is a swap, and the backing arrives with revocation.
 *
 * Entries are pruned once the token they describe would have expired anyway,
 * so this cannot grow without bound.
 */

class DeviceTokenRegistry {
  constructor() {
    /** partition key -> Map(jti -> record) */
    this._byKey = new Map();
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
    });
    this.prune(key);
  }

  /**
   * Everything still live in this partition, newest first.
   *
   * Scoped to one partition on purpose: this is called with the caller's own
   * key, so there is no request shape that could ask about somebody else's.
   */
  list(key) {
    this.prune(key);
    return [...this._bucket(key).values()].sort((a, b) => b.issuedAt - a.issuedAt);
  }

  /** Drop records whose token has expired; it can no longer be used anyway. */
  prune(key, now = Date.now()) {
    const b = this._bucket(key);
    let dropped = 0;
    for (const [jti, rec] of b) {
      if (Number.isFinite(rec.expiresAt) && rec.expiresAt <= now) { b.delete(jti); dropped += 1; }
    }
    return dropped;
  }
}

module.exports = { DeviceTokenRegistry };
