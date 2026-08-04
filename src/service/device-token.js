'use strict';
/**
 * Device tokens.
 *
 * THE PROBLEM THIS SOLVES. Until now a device authenticated with the same
 * credential a person uses. `auth.verify()` is called identically for the
 * browser API and for the device WebSocket, so a token good enough to register
 * a device was also good enough to call `POST /api/devices/<your-laptop>/spawn`.
 *
 * That is tolerable while the token sits on your own laptop. It stops being
 * tolerable the moment one is copied into a container in the cloud -- which is
 * exactly what running sessions on Azure Container Apps requires. A leaked job
 * secret would otherwise be a shell on the machine you are sitting at.
 *
 * So a device gets its own kind of credential:
 *
 *   - Issued BY THE HUB, so it is not a GitHub or Entra credential and carries
 *     no authority anywhere else. A leak is worth one hub, not one identity.
 *   - REFUSED BY THE USER API. That single rule is the security property; the
 *     rest of this file is plumbing.
 *   - EXPIRING, so a token that escapes stops working on its own. For a job
 *     this can be hours, which is better than any revocation story.
 *   - OPTIONALLY BOUND to a device id prefix, so a token minted for ACA jobs
 *     can register `aca-*` and nothing else -- least privilege inside the
 *     device role, not merely at its edge.
 *   - Carrying a `jti`, so one token can be revoked without disturbing the
 *     others. (The revocation store itself is B3; the id it needs is here.)
 *
 * The token embeds the PARTITION KEY it was minted for. A device therefore
 * lands in the right partition without a round trip to GitHub or Entra, which
 * also means device tokens work identically in every auth mode: they are the
 * hub's own credential, not a reinterpretation of somebody else's.
 *
 * WHAT IS NOT STORED ANYWHERE: the token. Only its `jti` is ever written down,
 * and only when revoked. See docs/security.md.
 */

const crypto = require('crypto');

// Deliberately distinctive. GitHub tokens start ghp_/gho_/github_pat_ and Entra
// tokens start eyJ, so a device token can be routed on sight rather than by
// trying each verifier in turn and hoping.
const PREFIX = 'sqhd1';

const KIND_DEVICE = 'device';
const KIND_USER = 'user';

const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;   // 30 days

class DeviceTokenError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'DeviceTokenError';
    this.status = status;
  }
}

/**
 * Sign and verify device tokens.
 *
 * The secret must OUTLIVE THE PROCESS or every device token dies on restart.
 * It comes from configuration for that reason, and is never written to disk by
 * the hub: on Azure App Service the persistent volume is a CIFS mount that
 * reports every file as world readable and silently ignores chmod, so a secret
 * written there would be a secret in plain sight. Measured, not assumed --
 * see docs/security.md.
 */
class DeviceTokens {
  constructor({ secret, ttlMs } = {}) {
    this.secret = secret || null;
    this.ttlMs = ttlMs || DEFAULT_TTL_MS;
    /**
     * With no configured secret one is generated so a local run works out of
     * the box -- but tokens minted with it stop working when the process
     * restarts. `ephemeral` exists so the CLI can say that out loud instead of
     * letting someone discover it when their device silently drops off.
     */
    this.ephemeral = false;
    if (!this.secret) {
      this.secret = crypto.randomBytes(32).toString('base64url');
      this.ephemeral = true;
    }
  }

  /**
   * @param {object}  p
   * @param {string}  p.key        partition key this device belongs to
   * @param {string} [p.name]      display name, for logs and the UI
   * @param {string} [p.label]     what this token is for, so it can be revoked knowingly
   * @param {string} [p.didPrefix] restrict which device ids it may register
   * @param {number} [p.ttlMs]     lifetime; shorter is better
   */
  mint({ key, name = null, label = null, didPrefix = null, ttlMs } = {}) {
    if (!key) throw new Error('a device token must be minted for a partition key');
    const now = Date.now();
    const claims = {
      v: 1,
      kind: KIND_DEVICE,
      key: String(key),
      name: name ? String(name) : null,
      label: label ? String(label) : null,
      // Normalised so a caller cannot accidentally widen the binding with
      // casing, and so the comparison at registration is a plain prefix test.
      did: didPrefix ? String(didPrefix).toLowerCase() : null,
      jti: crypto.randomBytes(12).toString('base64url'),
      iat: now,
      exp: now + (Number.isFinite(ttlMs) ? ttlMs : this.ttlMs),
    };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${PREFIX}.${body}.${this._sign(body)}`;
  }

  _sign(body) {
    return crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  /** Does this look like a device token at all? Cheap, and does no crypto. */
  static looksLikeDeviceToken(token) {
    return typeof token === 'string' && token.startsWith(`${PREFIX}.`);
  }

  /**
   * Verify, or throw.
   *
   * Every failure is a 401 EXCEPT expiry, which is also 401 but says so, and a
   * device-id binding violation, which is 403 -- the token is real, it simply
   * does not authorise that device.
   */
  verify(token) {
    if (!DeviceTokens.looksLikeDeviceToken(token)) {
      throw new DeviceTokenError('not a device token');
    }
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new DeviceTokenError('malformed device token');
    const [, body, sig] = parts;

    const expect = this._sign(body);
    // Length first: timingSafeEqual throws on a mismatch, and an exception here
    // would surface as a 500 rather than a refusal.
    if (sig.length !== expect.length) throw new DeviceTokenError('device token signature is invalid');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
      throw new DeviceTokenError('device token signature is invalid');
    }

    let claims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new DeviceTokenError('device token payload is unreadable');
    }
    if (!claims || claims.kind !== KIND_DEVICE || !claims.key) {
      throw new DeviceTokenError('device token is missing required claims');
    }
    if (!Number.isFinite(claims.exp) || Date.now() >= claims.exp) {
      throw new DeviceTokenError('device token has expired');
    }
    return claims;
  }

  /**
   * May this token register this device id?
   *
   * A token with no binding may register anything within its partition. One
   * minted with `didPrefix: 'aca-'` may not register 'laptop', which is the
   * point: a credential shipped to a cloud job should not be able to
   * impersonate the machine you are sitting at.
   */
  static allowsDeviceId(claims, deviceId) {
    if (!claims || !claims.did) return true;
    return String(deviceId || '').toLowerCase().startsWith(claims.did);
  }
}

module.exports = {
  DeviceTokens, DeviceTokenError, PREFIX, KIND_DEVICE, KIND_USER, DEFAULT_TTL_MS,
};
