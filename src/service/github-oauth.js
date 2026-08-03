'use strict';
/**
 * "Sign in with GitHub" for the browser.
 *
 * The GitHub provider in auth.js verifies a token. That is enough for a CLI,
 * which can run `gh auth token`, and useless in a browser -- which is why the
 * sign-in page said "open the link printed by the server" and left people
 * pasting URLs around.
 *
 * This is the missing half: an OAuth web flow so a person can press a button.
 *
 * WHY THIS IS WORTH DOING AT ALL. A GitHub OAuth App is free, instant, and
 * self-service -- no administrator has to approve anything. That is the whole
 * reason the GitHub provider exists, and a sign-in flow that still required a
 * pasted token would have thrown away most of the benefit.
 *
 * Two deliberate choices:
 *
 *   NO SCOPES are requested. The hub needs to know who you are, nothing more.
 *   An unscoped token can still call /user, and if this hub is ever breached
 *   the tokens it holds grant read access to public data and no more.
 *
 *   The token is never put in a URL. A redirect to `/?token=...` would write a
 *   live credential into browser history, the Referer header, and any proxy log
 *   in between. The callback returns a small page that hands it to the app in
 *   JavaScript instead.
 */

const crypto = require('crypto');
const https = require('https');

class GitHubOAuth {
  constructor({ clientId, clientSecret, publicUrl } = {}) {
    this.clientId = clientId || process.env.SQUAD_HUB_GITHUB_CLIENT_ID || null;
    this.clientSecret = clientSecret || process.env.SQUAD_HUB_GITHUB_CLIENT_SECRET || null;
    this.publicUrl = (publicUrl || process.env.SQUAD_HUB_PUBLIC_URL || '').replace(/\/+$/, '');
    this.enabled = !!(this.clientId && this.clientSecret);
    // Signs the state parameter. Per-process and ephemeral: a restart
    // invalidates in-flight sign-ins, which is a two-second inconvenience and
    // removes any need to store a long-lived secret for this.
    this._stateKey = crypto.randomBytes(32);
  }

  /** Where GitHub should send the user back to. */
  redirectUri(req) {
    if (this.publicUrl) return `${this.publicUrl}/auth/github/callback`;
    // Fall back to the host the request arrived on, so a local run works
    // without configuration. Behind a proxy this is what the proxy reports.
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    return `${proto}://${req.headers.host}/auth/github/callback`;
  }

  /**
   * A signed, expiring state parameter.
   *
   * Without it, an attacker can hand someone a crafted callback URL and log
   * them into an account they do not own -- login CSRF. The signature proves
   * this hub started the flow; the timestamp stops a captured state being
   * replayed later.
   */
  makeState() {
    const nonce = crypto.randomBytes(12).toString('base64url');
    const at = Date.now().toString(36);
    const payload = `${nonce}.${at}`;
    const sig = crypto.createHmac('sha256', this._stateKey).update(payload).digest('base64url').slice(0, 24);
    return `${payload}.${sig}`;
  }

  checkState(state, maxAgeMs = 600000) {
    const parts = String(state || '').split('.');
    if (parts.length !== 3) return false;
    const [nonce, at, sig] = parts;
    const expect = crypto.createHmac('sha256', this._stateKey).update(`${nonce}.${at}`).digest('base64url').slice(0, 24);
    if (sig.length !== expect.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
    const issued = parseInt(at, 36);
    return Number.isFinite(issued) && Date.now() - issued < maxAgeMs;
  }

  authorizeUrl(req) {
    const state = this.makeState();
    const p = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri(req),
      // Deliberately empty. Identity is all this needs.
      scope: '',
      state,
    });
    return { url: `https://github.com/login/oauth/authorize?${p}`, state };
  }

  /** Exchange the callback code for a token. */
  exchange(code, req) {
    const body = JSON.stringify({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri(req),
    });
    return new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'github.com',
        path: '/login/oauth/access_token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'squad-hub',
        },
        timeout: 15000,
      }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(b); } catch { return reject(new Error('GitHub returned unparseable JSON')); }
          if (j.error) return reject(new Error(j.error_description || j.error));
          if (!j.access_token) return reject(new Error('GitHub returned no access token'));
          return resolve(j.access_token);
        });
      });
      r.on('timeout', () => { r.destroy(new Error('timed out talking to GitHub')); });
      r.on('error', reject);
      r.write(body);
      r.end();
    });
  }
}

module.exports = { GitHubOAuth };
