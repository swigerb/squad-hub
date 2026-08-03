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
 *   github validate a GitHub token by asking GitHub who it belongs to. Needs no
 *          app registration of any kind, which matters: an Entra app
 *          registration requires tenant-admin cooperation that many people
 *          simply cannot get, and without an alternative they are left running
 *          a hub on a shared secret.
 *
 *   dev    a local HMAC token carrying an explicit subject, for running the hub
 *          on a laptop with no tenant. It is NOT a fallback: in entra or github
 *          mode a dev token is rejected outright, because a helpful fallback is
 *          how auth gets bypassed.
 */

const crypto = require('crypto');
const https = require('https');

const MODES = Object.freeze({ ENTRA: 'entra', GITHUB: 'github', DEV: 'dev' });

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
    // token hash -> { claims | error, at }
    this._ghCache = new Map();
    this.githubCacheMs = opts.githubCacheMs || 300000;
    // Overridable so the tests can run offline against a stand-in. The real
    // endpoint is proven separately by spike/github-auth-probe.js -- a mock
    // alone would only prove the mock.
    this._verifyGitHubFetch = opts.githubFetch || fetchGitHubUser;
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
    if (this.mode === MODES.ENTRA) return this._verifyEntra(token);
    if (this.mode === MODES.GITHUB) return this._verifyGitHub(token);
    return this._verifyDev(token);
  }

  /**
   * Ask GitHub who a token belongs to.
   *
   * The token is the credential; GitHub is the authority. Nothing is registered
   * anywhere, which is the point -- this exists for people who cannot obtain an
   * Entra app registration and would otherwise be stuck on a shared secret.
   *
   * Results are cached, positive and negative alike:
   *
   *   positive, so a busy hub does not spend its GitHub rate limit and add a
   *   round trip to every request;
   *
   *   negative, because without it anyone can make this hub issue a GitHub API
   *   call per guess -- turning it into an amplifier for someone else's
   *   brute-force, at our rate limit.
   *
   * The cache is keyed on a HASH of the token. A process dump should not hand
   * over working GitHub credentials.
   */
  async _verifyGitHub(token) {
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const hit = this._ghCache.get(key);
    if (hit && Date.now() - hit.at < this.githubCacheMs) {
      if (hit.error) throw new AuthError(hit.error, hit.status || 401);
      return this._principal(hit.claims);
    }

    let user;
    try {
      user = await this._verifyGitHubFetch(token);
    } catch (e) {
      // Cache the refusal, but never a transport failure -- GitHub being
      // briefly unreachable must not lock the owner out for the cache window.
      if (e.status === 401 || e.status === 403) {
        this._ghCache.set(key, { at: Date.now(), error: 'GitHub rejected this token', status: 401 });
      }
      throw e.status === 401 || e.status === 403
        ? new AuthError('GitHub rejected this token')
        : new AuthError(`could not reach GitHub to verify the token: ${e.message}`, 503);
    }

    if (!user || !user.id || !user.login) {
      throw new AuthError('GitHub returned no usable identity for this token');
    }

    const claims = {
      // A synthetic tenant, so partition keys stay consistent with the other
      // providers and a GitHub identity can never collide with an Entra one.
      tid: 'github',
      // The numeric id, not the login: a login can be changed or reused, an id
      // cannot. Anchoring a partition to a mutable name would silently hand a
      // renamed account someone else's devices.
      oid: String(user.id),
      name: user.login,
      email: user.email || null,
    };
    this._ghCache.set(key, { at: Date.now(), claims });
    if (this._ghCache.size > 200) this._ghCache.delete(this._ghCache.keys().next().value);
    return this._principal(claims);
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

function fetchGitHubUser(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: '/user',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        // GitHub rejects requests without one.
        'User-Agent': 'squad-hub',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(Object.assign(new Error(`GitHub returned ${res.statusCode}`), { status: res.statusCode }));
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(Object.assign(new Error('GitHub returned unparseable JSON'), { status: 502 })); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', reject);
    req.end();
  });
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
