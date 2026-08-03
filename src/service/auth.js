'use strict';
/**
 * Identity for the hub service.
 *
 * ISOLATION IS THE ABANDON CONDITION FOR THIS SPRINT. If one user can see
 * another user's device or session, nothing internet-reachable gets deployed.
 * So the identity boundary is not a middleware detail -- it is the product
 * requirement, and every route goes through one place to enforce it.
 *
 * Two modes:
 *
 *   entra  validate a Microsoft Entra ID JWT, taking the subject from the `oid`
 *          and `tid` claims, with signatures checked against the issuing
 *          tenant's JWKS.
 *
 *   dev    a local HMAC token carrying an explicit subject, for running the hub
 *          on a laptop with no tenant. It is NOT a fallback: in entra mode a dev
 *          token is rejected outright, because a helpful fallback is how auth
 *          gets bypassed.
 */

const crypto = require('crypto');
const https = require('https');

const MODES = Object.freeze({ ENTRA: 'entra', DEV: 'dev' });

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

/** A stable, opaque per-user key. Never the raw oid, so logs cannot deanonymise. */
function subjectKey(tid, oid) {
  return crypto.createHash('sha256').update(`${tid}|${oid}`).digest('hex').slice(0, 32);
}

function b64urlJson(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8'));
}

class Authenticator {
  constructor(opts = {}) {
    this.mode = opts.mode || MODES.DEV;
    this.allowedTenants = opts.allowedTenants || [];
    /**
     * Who is allowed to use this hub at all.
     *
     * A tenant filter is not an owner filter: in Entra mode every user in an
     * allowed tenant would otherwise be able to register a device, and in dev
     * mode anyone holding the shared secret can mint any identity they like.
     * Measured, not assumed -- spike/security-probe.js signs in as
     * "somebody-else" in tenant "any-tenant" without this.
     *
     * Entries may be an Entra object id, a UPN, or an email. Empty means
     * anyone who authenticates, which is the right default for a laptop and
     * the wrong one for anything reachable from the internet.
     */
    this.allowedUsers = (opts.allowedUsers || [])
      .map((u) => String(u).trim().toLowerCase())
      .filter(Boolean);
    /**
     * Identities that are all the SAME person.
     *
     * Partitioning is keyed on tenant + object id, so one human with accounts
     * in two tenants gets two partitions -- two separate hubs sharing a URL,
     * where devices registered by one identity are invisible to the other.
     * That is correct for two colleagues and wrong for one person with a work
     * account and a personal one.
     *
     * Listing identities here says "these are all me": each may sign in, and
     * they share a single partition.
     */
    this.owner = (opts.owner || [])
      .map((u) => String(u).trim().toLowerCase())
      .filter(Boolean);
    this.audience = opts.audience || null;
    this.devSecret = opts.devSecret || null;
    this._jwks = new Map();
    if (this.mode === MODES.DEV && !this.devSecret) {
      throw new Error('dev mode requires a secret; refusing to run an unauthenticated hub');
    }
  }

  /** Mint a dev token. Only meaningful in dev mode. */
  mintDevToken(tid, oid, name) {
    if (this.mode !== MODES.DEV) throw new Error('dev tokens are not issuable in entra mode');
    const body = Buffer.from(JSON.stringify({ tid, oid, name, iat: Date.now() })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.devSecret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  async verify(authorizationHeader) {
    const raw = String(authorizationHeader || '');
    const m = raw.match(/^Bearer\s+(.+)$/i);
    if (!m) throw new AuthError('missing bearer token');
    const token = m[1].trim();
    return this.mode === MODES.ENTRA ? this._verifyEntra(token) : this._verifyDev(token);
  }

  _verifyDev(token) {
    const parts = token.split('.');
    // A JWT has three segments. Seeing one here means a real token reached a
    // dev-mode service -- refuse rather than guess.
    if (parts.length !== 2) throw new AuthError('malformed dev token');
    const [body, sig] = parts;
    const expect = crypto.createHmac('sha256', this.devSecret).update(body).digest('base64url');
    // Length first: timingSafeEqual throws on a length mismatch.
    if (sig.length !== expect.length
      || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
      throw new AuthError('bad dev token signature');
    }
    let claims;
    try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch { throw new AuthError('unparseable dev token'); }
    if (!claims.tid || !claims.oid) throw new AuthError('dev token is missing tid/oid');
    return this._principal(claims);
  }

  async _verifyEntra(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('malformed JWT');
    const header = b64urlJson(parts[0]);
    const claims = b64urlJson(parts[1]);

    if (!claims.tid || !claims.oid) throw new AuthError('token is missing tid/oid');
    if (claims.exp && Date.now() / 1000 > claims.exp) throw new AuthError('token expired');
    if (this.audience && claims.aud !== this.audience) throw new AuthError('wrong audience');

    const key = await this._jwk(claims.tid, header.kid);
    if (!key) throw new AuthError('no signing key for this token');

    const signed = `${parts[0]}.${parts[1]}`;
    const sig = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const ok = crypto.createVerify('RSA-SHA256').update(signed).verify(
      crypto.createPublicKey({ key, format: 'jwk' }), sig,
    );
    if (!ok) throw new AuthError('bad token signature');

    return this._principal(claims);
  }

  _principal(claims) {
    if (this.allowedTenants.length && !this.allowedTenants.includes(claims.tid)) {
      throw new AuthError('tenant not allowed', 403);
    }

    const name = claims.name || claims.preferred_username || claims.upn || claims.email || null;
    // Any of the identifiers a person would recognise. Checked case-
    // insensitively, because a UPN typed by hand will not match the casing
    // Entra returns.
    const candidates = [claims.oid, claims.sub, name, claims.preferred_username, claims.upn, claims.email]
      .filter(Boolean).map((c) => String(c).toLowerCase());

    const isOwner = this.owner.length > 0 && candidates.some((c) => this.owner.includes(c));

    const permitted = this.allowedUsers.length || this.owner.length
      ? isOwner || candidates.some((c) => this.allowedUsers.includes(c))
      : true;
    if (!permitted) {
      // 403, not 401: the credential was valid, the person is not permitted.
      // Saying so plainly beats an authentication error that sends someone
      // hunting for a token problem they do not have.
      throw new AuthError('this account is not permitted to use this hub', 403);
    }

    return {
      tid: claims.tid,
      oid: claims.oid,
      name,
      isOwner,
      // An owner's identities share one partition, so signing in with either
      // account shows the same devices. Keyed on a constant rather than on any
      // one of them, so adding or reordering an alias later does not orphan
      // devices already registered.
      key: isOwner ? subjectKey('owner', 'squad-hub') : subjectKey(claims.tid, claims.oid),
    };
  }

  async _jwk(tid, kid) {
    const cached = this._jwks.get(tid);
    const fresh = cached && Date.now() - cached.at < 3600000;
    let keys = fresh ? cached.keys : null;
    if (!keys) {
      keys = await fetchJwks(tid);
      this._jwks.set(tid, { keys, at: Date.now() });
    }
    return keys.find((k) => k.kid === kid) || null;
  }
}

function fetchJwks(tid) {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tid)}/discovery/v2.0/keys`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).keys || []); }
        catch { reject(new AuthError('could not read the tenant signing keys', 503)); }
      });
    }).on('error', () => reject(new AuthError('could not reach the identity provider', 503)));
  });
}

module.exports = { Authenticator, AuthError, MODES, subjectKey };
