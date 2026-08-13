'use strict';
/**
 * The Squad Hub service.
 *
 * Three responsibilities:
 *   1. Accept device registration and heartbeats, and derive presence.
 *   2. Hold the merged session view, partitioned per user.
 *   3. Route control commands (approve, spawn, steer, stop) down to the right
 *      device's socket, and stream updates back up to the right user's surfaces.
 *
 * The daemon connects OUTBOUND over a WebSocket, so no inbound port is opened on
 * a laptop or dev box. Control travels down that existing connection.
 *
 * EVERY route resolves a subject first and reaches only into that subject's
 * partition. There is no "list all" path that a bug could expose.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Authenticator, AuthError, MODES } = require('./auth');
const { DeviceTokens, KIND_DEVICE, KIND_USER } = require('./device-token');
const { DeviceTokenStore } = require('./device-token-store');
const { AccessStore } = require('./access-store');
const { AccessAudit } = require('./access-audit');
const paths = require('../paths');
const { GitHubOAuth } = require('./github-oauth');
const { Store } = require('./store');
const { FileBacking, MemoryBacking } = require('./store-backing');
const ws = require('./ws');

const WEB_ROOT = path.join(__dirname, '..', '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * The 404 page's stylesheet, kept as its own constant rather than inline in
 * the template so its exact bytes can be hashed for the CSP below -- a hash
 * source lets this ONE static, unchanging `<style>` block run without
 * `'unsafe-inline'` weakening style-src for every other response.
 */
const NOT_FOUND_STYLE = `
  :root { --bg:#0b0d12; --text:#e6e9f2; --dim:#98a0b5; --faint:#6a7288;
          --line:#232838; --panel:#12151d; --accent:#4c8dff; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--text);
         font:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display:flex; align-items:center; justify-content:center; text-align:center; padding:24px; }
  .wrap { max-width:520px; }
  img { width:180px; border-radius:16px; margin-bottom:28px;
        box-shadow:0 12px 40px rgba(0,0,0,.5); }
  h1 { font-size:72px; margin:0; letter-spacing:-2px; line-height:1; }
  h2 { font-size:22px; margin:10px 0 0; font-weight:600; color:var(--text); }
  p  { color:var(--dim); margin:14px 0 0; }
  .actions { margin-top:28px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }
  a.btn { text-decoration:none; padding:10px 20px; border-radius:8px; font-weight:600; font-size:14px; }
  a.primary { background:var(--accent); color:#fff; }
  a.primary:hover { filter:brightness(1.1); }
  a.ghost { border:1px solid var(--line); color:var(--text); background:var(--panel); }
  a.ghost:hover { background:#171b25; }
  code { font-family:ui-monospace,"Cascadia Code",Menlo,Consolas,monospace;
         background:var(--panel); border:1px solid var(--line);
         padding:2px 6px; border-radius:4px; font-size:13px; color:var(--dim); }
`;
const NOT_FOUND_STYLE_HASH = crypto.createHash('sha256').update(NOT_FOUND_STYLE, 'utf8').digest('base64');

/**
 * The policy that fits this app: no build step, no third-party origin for
 * anything the app runs, and every handler assigned in JavaScript rather than
 * written into markup.
 *
 * ENFORCED, not report-only -- a report-only policy would have let the sign-in
 * pages ship broken (see below) and nothing would have said so. Every
 * directive that does not fall back to `default-src 'self'` is listed
 * explicitly: `frame-ancestors`, `base-uri` and `form-action` are independent
 * of it by spec, not defaulted.
 *
 * `style-src` carries exactly one hash, for the 404 page's own stylesheet
 * (see NOT_FOUND_STYLE above) -- everything else, including the sign-in
 * pages, was moved to an external file or a class rather than earning a
 * second exception. `'unsafe-inline'` is deliberately never used: it would
 * have made this policy pass while doing nothing.
 *
 * `img-src` carries ONE external host: the account menu shows the signed-in
 * person's own GitHub avatar, fetched directly from GitHub's own CDN (see
 * `avatar` in `src/service/auth.js`, which validates the URL is on this exact
 * host before ever trusting it -- this is not a new trust boundary, only the
 * same one made visible to the browser). Nothing else -- script, style,
 * connect, everything else that falls back to `default-src` -- carries any
 * external origin at all.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  `style-src 'self' 'sha256-${NOT_FOUND_STYLE_HASH}'`,
  "img-src 'self' https://avatars.githubusercontent.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Headers sent on EVERY response, no exceptions.
 *
 * `X-Frame-Options: DENY` matters because the hub's primary control is an
 * approval button that runs a command on somebody's machine, and a page that
 * can be framed can be interacted with in ways the person did not intend.
 * `X-Content-Type-Options: nosniff` stops a browser from re-interpreting a
 * response as something other than the type it was served as.
 * `Content-Security-Policy` (above) constrains where script, style and every
 * other resource a page loads may come from.
 * `Referrer-Policy: no-referrer` stops a token EVER reaching a Referer header.
 * The manual sign-in link carries a token as `/?token=...` (see `app.js`,
 * which reads it and calls `history.replaceState` to remove it) -- until that
 * removal runs, any request this page makes (a stylesheet, a script, the
 * favicon) would otherwise hand the whole URL, token included, to whatever it
 * requested. `no-referrer` is the strictest value: no referrer at all, to any
 * origin, same-origin included, since this app has no use for one.
 *
 * `Strict-Transport-Security` is NOT here -- it is added per-request, only
 * when the request actually arrived over TLS. See `securityHeadersFor` below.
 *
 * Applied last -- after any caller-supplied headers -- in every place a
 * response is written, so a handler cannot accidentally (or a bug cannot
 * silently) override them.
 */
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
};

/**
 * How long a browser should remember to require HTTPS for this host, once it
 * has seen one HTTPS response. Six months: long enough to be worth anything,
 * short enough that a mistaken send is not a mistake for a year. Neither
 * `includeSubDomains` nor `preload` is set -- both extend the commitment
 * beyond what this issue asked for, and both are a `deploy-appservice.ps1`- or
 * DNS-level decision, not one this handler can see far enough to make.
 */
const HSTS_MAX_AGE_SECONDS = 15552000;

/**
 * Was THIS request delivered over TLS?
 *
 * This process always listens on plain HTTP (`http.createServer` above) --
 * every deployment this repo ships (App Service, Container Apps, an AKS
 * ingress) terminates TLS in front of it and forwards the original scheme in
 * `X-Forwarded-Proto`. `github-oauth.js` already trusts this same header, on
 * the same request, to build the OAuth redirect URI -- this reads it the same
 * way rather than inventing a second convention.
 *
 * `req.socket.encrypted` is checked too, in case that ever changes; it is
 * always false today, since nothing here calls `https.createServer`.
 *
 * A request with NO forwarded-proto header (a bare `curl` to a local dev
 * server, or a health check that talks plain HTTP inside a cluster) is
 * treated as insecure, not assumed secure -- sending HSTS on that response
 * would be sent over the very channel it tells a browser to stop using.
 */
function requestIsSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String((req.headers['x-forwarded-proto'] || '')).split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

/** The full set of security headers for one request: the fixed set, plus HSTS iff this request arrived over TLS. */
function securityHeadersFor(req) {
  if (!requestIsSecure(req)) return SECURITY_HEADERS;
  return { ...SECURITY_HEADERS, 'Strict-Transport-Security': `max-age=${HSTS_MAX_AGE_SECONDS}` };
}

/**
 * Hostnames that mean "this browser is talking to a hub on the same machine
 * it is running on", regardless of port -- a local dev server is not on a
 * fixed port, and refusing anything but one exact port would refuse the
 * ordinary case of running two.
 *
 * `new URL(origin).hostname` never carries brackets for a bare `::1` (Node
 * keeps them for an IPv6 literal, e.g. `[::1]`), so both forms are listed.
 */
const LOOPBACK_ORIGIN_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The hub's own origin, as seen from THIS request.
 *
 * Derived the same way `github-oauth.js redirectUri()` derives its redirect
 * target -- the forwarded scheme plus `Host` -- rather than a second
 * convention for the same fact. This is the WS-1 fallback, used only when
 * `SQUAD_HUB_PUBLIC_URL` is unset -- see `originIsAllowed()` and
 * `publicOriginFromEnv()` below for the WS-2 case, where the configured
 * value is authoritative instead of whatever `Host` a request happened to
 * carry.
 */
function selfOrigin(req) {
  if (!req.headers.host) return null;
  const proto = requestIsSecure(req) ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}

/**
 * Normalise `SQUAD_HUB_PUBLIC_URL` (or an injected override) to the origin
 * the WebSocket check compares against: scheme + host + effective port, any
 * path and trailing slash stripped.
 *
 * `URL#origin` already does exactly this normalisation -- it is the same
 * constructor `github-oauth.js` uses, per the issue's own instruction to
 * strip "trailing slash and any path... as that constructor already does" --
 * so `https://hub.example/`, `https://hub.example` and
 * `https://hub.example/some/path` all yield `https://hub.example`, and
 * `https://hub.example:443/` yields `https://hub.example` (default port
 * elided), matching the canonical form a browser's `Origin` header already
 * carries.
 *
 * A value that is SET but does not parse as an absolute `http`/`https` URL
 * throws rather than falling back to the WS-1 request-derived behaviour --
 * a typo in this setting (`SQUAD_HUB_PUBLIC_URL=hub.example`, missing the
 * scheme, say) must fail loudly at startup. Silently falling back to trusting
 * whatever `Host` a request carries would be the exact silent-permissive
 * behaviour this setting exists to remove: a misconfigured value would look
 * configured while actually granting the OLD, weaker, request-derived trust.
 */
function publicOriginFromEnv(raw) {
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch {
    throw new Error(`SQUAD_HUB_PUBLIC_URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`SQUAD_HUB_PUBLIC_URL must be an http or https URL, saw "${raw}"`);
  }
  return url.origin;
}

/**
 * Should this WebSocket upgrade be allowed to proceed, going only by its
 * `Origin` header?
 *
 * `configuredOrigin` is `HubService#publicOrigin` -- the normalised
 * `SQUAD_HUB_PUBLIC_URL`, or `null` when it is unset. Three shapes are
 * accepted, matching the three the issue names:
 *
 *   NO `Origin` header at all. A daemon or the CLI is not a browser and sends
 *   none -- `hub-link.js` issues the upgrade request with no Origin header,
 *   which is the client this hub must not break. Preserved identically
 *   whether or not `SQUAD_HUB_PUBLIC_URL` is set: a daemon does not become a
 *   browser because the deploy configured a domain.
 *
 *   A LOOPBACK origin, any port -- `localhost`, `127.0.0.1`, `[::1]` -- so a
 *   browser open against a hub running on the same machine is not refused,
 *   even on a deployment that also has `SQUAD_HUB_PUBLIC_URL` configured (a
 *   developer testing a container image built for that deployment, say).
 *
 *   THE HUB'S OWN origin -- `configuredOrigin` when set (WS-2: the deploy's
 *   `SQUAD_HUB_PUBLIC_URL`), otherwise `selfOrigin(req)` computed from this
 *   same request (WS-1: the forwarded scheme plus `Host`).
 *
 * When `configuredOrigin` is set it is authoritative, in place of, not in
 * addition to, the request-derived origin: a request whose `Host` or
 * forwarded proto disagrees with the configured domain no longer earns a
 * match by agreeing with itself. That is the point of configuring it --
 * a hub behind a proxy that forwards an unexpected `Host` should trust what
 * the deploy says its domain is, not whatever `Host` the request carries.
 *
 * Everything else is refused, including the literal string `Origin: null` --
 * sent by a sandboxed iframe or a `file://` page. That is NOT the same as no
 * header: the CLI allowance is "the header is absent", not "the header is
 * falsy", and a page with no origin of its own is exactly the case this must
 * not wave through.
 */
function originIsAllowed(req, configuredOrigin) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || origin.trim().toLowerCase() === 'null') return false;

  let url;
  try { url = new URL(origin); } catch { return false; }
  if (LOOPBACK_ORIGIN_HOSTNAMES.has(url.hostname)) return true;

  const allowed = configuredOrigin || selfOrigin(req);
  return !!allowed && origin.toLowerCase() === allowed.toLowerCase();
}

/**
 * The longest a device token may live.
 *
 * A lifetime is a security control: expiry is what makes a credential shipped
 * to a cloud job self-limiting, and an unbounded one would make that
 * decorative. Ninety days is generous for a laptop; a job should ask for hours.
 */
const MAX_DEVICE_TOKEN_HOURS = 90 * 24;

/**
 * Am I one of several instances?
 *
 * This matters because state is in memory. A device attaches to ONE instance;
 * every other instance has never heard of it and answers "no devices". Roughly
 * half of all requests then 404, intermittently, with nothing in any log to say
 * why -- measured live, see docs/plans/app-service.md.
 *
 * Azure App Service exposes the count; Container Apps and Kubernetes do not, so
 * an unknown count is treated as "probably fine" rather than raising a warning
 * nobody can act on. A false alarm on every ACA deployment would train people to
 * ignore the real one.
 */
function instanceCount() {
  const raw = process.env.WEBSITE_INSTANCE_COUNT || process.env.SQUAD_HUB_INSTANCE_COUNT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

class HubService {
  constructor(opts = {}) {
    /**
     * The deployment's own list, which is the floor everything else sits on.
     *
     * Read from an injected authenticator when there is one, and from the
     * environment otherwise. Not just the environment: a caller that supplies
     * its own `auth` -- every test, and any embedder -- would otherwise get an
     * access store that disagreed with the authenticator about who the owner
     * is, and "only an owner may edit this" would be deciding against a
     * different list to the one being edited.
     */
    const envAllowed = opts.auth && Array.isArray(opts.auth.allowedUsers)
      ? opts.auth.allowedUsers
      : (process.env.SQUAD_HUB_ALLOWED_USERS || '').split(',').filter(Boolean);
    const envOwner = opts.auth && Array.isArray(opts.auth.owner)
      ? opts.auth.owner
      : (process.env.SQUAD_HUB_OWNER || '').split(',').filter(Boolean);

    /**
     * Who may sign in, editable without a redeploy.
     *
     * Built BEFORE the authenticator, because the authenticator is given the
     * combined list -- the deployment's own configuration plus anyone added
     * since. The environment remains the floor: nothing added here can remove
     * it, and owners are not grantable at all. See access-store.js.
     */
    this.accessStore = opts.accessStore || new AccessStore({
      dir: opts.accessDir || paths.home(),
      persist: opts.persistAccess !== false,
      envAllowed,
      envOwner,
      // Who was let in, and when. Kept beside the list rather than inside it,
      // because the list is current state and this is history: the two answer
      // different questions and only one of them may ever be rewritten.
      audit: opts.accessAudit || new AccessAudit({
        dir: opts.accessDir || paths.home(),
        enabled: opts.persistAccess !== false,
      }),
    });

    this.auth = opts.auth || new Authenticator({
      mode: process.env.SQUAD_HUB_AUTH_MODE || MODES.DEV,
      devSecret: process.env.SQUAD_HUB_DEV_SECRET || crypto.randomBytes(16).toString('hex'),
      allowedTenants: (process.env.SQUAD_HUB_TENANTS || '').split(',').filter(Boolean),
      allowedUsers: this.accessStore.allowedUsers(),
      owner: envOwner,
      audience: process.env.SQUAD_HUB_AUDIENCE || null,
    });

    /**
     * Load everyone who was granted access into the authenticator, NOW.
     *
     * The line above only reaches the store when this class builds its own
     * Authenticator. `serve()` builds one first -- from SQUAD_HUB_ALLOWED_USERS
     * alone -- and passes it in, so the injected path skipped the store
     * entirely and only picked up a grant when the next add or remove happened
     * to sync it.
     *
     * The effect in production: somebody added through the UI could sign in
     * happily, and then be refused the moment the app restarted, while
     * `/api/access` still listed them -- because that reads the store and
     * sign-in reads this. Two answers to "who has access", disagreeing after
     * every deploy.
     *
     * Syncing here rather than only on mutation means the store is the single
     * source, whoever constructed the authenticator.
     */
    this._syncAllowedUsers();

    /**
     * WS-2: the origin the WebSocket upgrade trusts as "this hub", taken
     * from `SQUAD_HUB_PUBLIC_URL` -- the same setting `deploy-appservice.ps1`
     * already writes and `github-oauth.js redirectUri()` already reads --
     * rather than a new setting kept separately in step. `opts.publicUrl`
     * overrides it the same way every other env-backed option here does, for
     * tests and embedders. `null` when unset, which is what makes
     * `originIsAllowed()` fall back to the WS-1 request-derived origin.
     */
    this.publicOrigin = publicOriginFromEnv(
      opts.publicUrl !== undefined ? opts.publicUrl : (process.env.SQUAD_HUB_PUBLIC_URL || null),
    );
    this.store = opts.store || new Store({
      /**
       * Session and device records under `SQUAD_HUB_HOME`, so a terminal
       * cloud-job session survives the restart that erases the device that
       * made it -- see store-backing.js. `opts.store` (every test, and any
       * embedder) bypasses this entirely, the same escape hatch
       * `accessStore`/`deviceTokenStore` already give.
       */
      backing: opts.persistStore === false
        ? new MemoryBacking()
        : new FileBacking({ dir: opts.storeDir || paths.home(), persist: opts.persistStore !== false }),
    });
    /**
     * Device token records and revocations.
     *
     * Persisted under SQUAD_HUB_HOME so a revocation survives a restart --
     * revocation that forgets is not revocation. Where no directory is
     * configured it stays in memory and says so, rather than pretending.
     */
    this.deviceTokenStore = opts.deviceTokenStore
      || new DeviceTokenStore({ dir: opts.deviceTokenDir || paths.home(), persist: opts.persistDeviceTokens !== false });
    // The authenticator asks this on every device token it verifies. Injected
    // rather than owned, so auth.js keeps knowing nothing about storage.
    if (this.auth && !this.auth.isDeviceTokenRevoked) {
      this.auth.isDeviceTokenRevoked = (jti) => this.deviceTokenStore.isRevoked(jti);
    }
    this.serveWeb = opts.serveWeb !== false;
    this.oauth = opts.oauth || new GitHubOAuth();
    this.teams = opts.teams || new (require('../notify/teams').TeamsNotifier)({
      hubUrl: process.env.SQUAD_HUB_PUBLIC_URL || null,
    });

    /** subject -> deviceId -> WsConnection */
    this._devices = new Map();
    /** subject -> Set<WsConnection> */
    this._watchers = new Map();
    /** correlation id -> {resolve, reject, timer} */
    this._pending = new Map();

    this.server = http.createServer((req, res) => this._http(req, res));
    this.server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));

    /**
     * Keep idle connections alive.
     *
     * Proxies close connections that carry no traffic. Azure App Service does so
     * at about 240 seconds, and a browser watching an idle hub sends nothing and
     * receives nothing -- so without this it is dropped and reconnects, showing
     * stale data in the gap.
     *
     * 45 seconds is chosen to sit comfortably under the shortest idle timeout
     * we have measured, with room for a missed tick. It is a ping frame, so it
     * costs two bytes and needs no handling at the other end.
     */
    this.keepaliveMs = opts.keepaliveMs || 45000;
    this._keepalive = setInterval(() => this._pingAll(), this.keepaliveMs);
    if (this._keepalive.unref) this._keepalive.unref();
  }

  _pingAll() {
    for (const [, byDevice] of this._devices) {
      for (const [, c] of byDevice) { try { c.ping(); } catch { /* closing */ } }
    }
    for (const [, set] of this._watchers) {
      for (const c of set) { try { c.ping(); } catch { /* closing */ } }
    }
  }

  listen(port = 0, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve(this.server.address()));
    });
  }

  close() {
    if (this._keepalive) clearInterval(this._keepalive);
    for (const [, byDevice] of this._devices) for (const [, c] of byDevice) c.close();
    for (const [, set] of this._watchers) for (const c of set) c.close();
    return new Promise((r) => this.server.close(r));
  }

  // -- HTTP -----------------------------------------------------------------

  async _http(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const send = (code, body, headers = {}) => {
      const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers,
        // Spread last: no caller-supplied header, present or future, can
        // override the security headers.
        ...securityHeadersFor(req),
      });
      res.end(payload);
    };

    if (req.method === 'OPTIONS') return send(204, '');

    // -- sign-in -------------------------------------------------------------
    if (url.pathname === '/auth/github/login') {
      if (!this.oauth.enabled) {
        return send(404, { error: 'GitHub sign-in is not configured on this hub' });
      }
      const { url: authUrl } = this.oauth.authorizeUrl(req);
      res.writeHead(302, { Location: authUrl, 'Cache-Control': 'no-store', ...securityHeadersFor(req) });
      return res.end();
    }

    if (url.pathname === '/auth/github/callback') {
      if (!this.oauth.enabled) return send(404, { error: 'GitHub sign-in is not configured' });
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) return this._signinError(send, 'GitHub did not return a code.');
      if (!this.oauth.checkState(state)) {
        // Login CSRF, or simply a stale tab. Both deserve a restart rather than
        // a silent sign-in as whoever crafted the link.
        return this._signinError(send, 'That sign-in link has expired or did not come from here. Please try again.');
      }
      let token;
      try { token = await this.oauth.exchange(code, req); }
      catch (e) { return this._signinError(send, `GitHub refused the sign-in: ${e.message}`); }

      // Check the identity BEFORE handing the browser a session. Letting
      // someone in and then failing every API call is a worse experience than
      // saying plainly that they are not permitted.
      try { await this.auth.verify(`Bearer ${token}`); }
      catch (e) {
        return this._signinError(send, e.status === 403
          ? 'That GitHub account is not permitted to use this hub.'
          : `Could not verify the account: ${e.message}`);
      }
      return this._signinComplete(send, token);
    }

    if (url.pathname === '/api/auth-methods') {
      // The sign-in page asks what this hub actually supports, rather than
      // offering a button that leads nowhere.
      return send(200, {
        mode: this.auth.mode,
        githubOAuth: this.oauth.enabled,
        acceptsToken: true,
      });
    }

    if (url.pathname === '/healthz') {
      const instances = instanceCount();
      const detail = {
        // Which process answered. In-memory state is per instance, so when a
        // device seems to vanish intermittently this is the first thing worth
        // knowing -- and guessing at it from behaviour wastes an afternoon.
        instance: (process.env.WEBSITE_INSTANCE_ID || process.env.HOSTNAME || 'local').slice(0, 12),
        instances,
        /**
         * Whether session records survive a restart.
         *
         * There is no way to tell from outside otherwise, and the two cases
         * behave identically right up until a deploy -- at which point one of
         * them silently loses the record of every cloud job that has already
         * finished. Naming it here means the answer is a fact that can be read
         * rather than a property that has to be inferred from a loss.
         */
        sessionStore: this.store.durable ? 'durable' : 'memory',
        /**
         * Whether a grant made through /api/access survives a restart.
         *
         * Same rule as `sessionStore` above, and for the same reason: without
         * this, `SQUAD_HUB_HOME` being unset, mistyped, or pointed at an
         * unwritable share looks identical to a working deployment right up
         * until the next redeploy silently forgets every added user. Naming it
         * here is what lets a deploy read the running fact instead of trusting
         * the setting it just wrote.
         */
        accessStore: this.accessStore.persist ? 'durable' : 'memory',
        // Named rather than implied, so it appears in the UI and in any log
        // scrape without the reader having to know the rule.
        //
        // Durability does NOT fix scale-out: two instances each hold their own
        // live device connections, and a durable record of a session says
        // nothing about which process can still reach the device that owns it.
        scaleOutWarning: instances && instances > 1
          ? `This hub is running on ${instances} instances. A device attaches to `
            + 'ONE of them, so it is invisible to the others and commands will fail '
            + 'intermittently. Persisting session records does not change this. '
            + 'Scale to a single instance.'
          : null,
        devices: this._devices.size,
        uptimeSeconds: Math.round(process.uptime()),
        // Which build is actually serving. A deploy tool that reports failure
        // while the code lands -- or success while it does not -- is
        // indistinguishable from the truth without this.
        build: process.env.SQUAD_HUB_BUILD || 'unknown',
        version: require('../../package.json').version,
      };

      // A liveness probe needs "is it up". A stranger does not need the device
      // count -- which says whether you are working right now -- nor the
      // version, which says which published bugs to try. The detail is behind
      // the same token as everything else.
      let authed = false;
      try { await this.auth.verify(req.headers.authorization); authed = true; } catch { authed = false; }
      return send(200, authed ? { ok: true, mode: this.auth.mode, ...detail } : { ok: true });
    }

    if (url.pathname.startsWith('/api/')) {
      let principal;
      try { principal = await this.auth.verify(req.headers.authorization); }
      catch (e) { return send(e.status || 401, { error: e.message }); }

      // THE SECURITY PROPERTY, in one place.
      //
      // A device credential lives in places a user credential must not: a
      // container image, a job secret, an environment variable in the cloud.
      // Without this line, anything holding one could list your devices and
      // POST /api/devices/<your-laptop>/spawn -- so a leaked job secret would
      // be a shell on the machine you are sitting at.
      //
      // Written as "must be a user" rather than "must not be a device", so a
      // third kind added later is refused by default instead of admitted by
      // an inverted test nobody revisited.
      if (principal.kind !== KIND_USER) {
        // 403, not 401: the credential is genuine and current. It simply does
        // not authorise this surface, and saying so plainly saves someone
        // hunting for a token problem they do not have.
        return send(403, {
          error: 'a device token cannot be used to call the API; sign in with your own account',
        });
      }

      try { return await this._api(url, req, res, principal, send); }
      catch (e) { return send(e.status || 500, { error: e.message }); }
    }

    if (this.serveWeb) return this._static(url, send);
    return send(404, { error: 'not found' });
  }

  async _api(url, req, res, me, send) {
    const p = url.pathname;

    if (p === '/api/me' && req.method === 'GET') {
      const instances = instanceCount();
      return send(200, {
        name: me.name,
        tenantId: me.tid,
        subject: me.key,
        // The signed-in user's own avatar, where the provider supplies one.
        // Null everywhere else, and the UI falls back to an initial.
        avatar: me.avatar || null,
        // Whether to OFFER the access screen. The hub does not rely on this --
        // /api/access checks the principal again on every call -- so a browser
        // that lied to itself here would gain nothing but a menu item that 403s.
        isOwner: !!me.isOwner,
        // The UI shows this as a banner. A user whose devices keep vanishing
        // deserves to be told why on the screen where they notice it, not in a
        // log they will never read.
        warning: instances && instances > 1
          ? `This hub is running on ${instances} instances and holds state in memory. `
            + 'Devices will appear and disappear, and commands will fail intermittently. '
            + 'Scale the App Service plan to a single instance.'
          : null,
      });
    }

    if (p === '/api/overview' && req.method === 'GET') {
      return send(200, this.store.overview(me.key, {
        keyword: url.searchParams.get('q') || undefined,
        status: url.searchParams.get('status') || undefined,
        deviceId: url.searchParams.get('device') || undefined,
        actionNeeded: url.searchParams.get('actionNeeded') === '1' || undefined,
      }));
    }

    if (p === '/api/devices' && req.method === 'GET') {
      return send(200, { devices: this.store.listDevices(me.key) });
    }

    if (p === '/api/sessions' && req.method === 'GET') {
      return send(200, { sessions: this.store.listSessions(me.key) });
    }

    // -- who may use this hub -------------------------------------------------
    //
    // OWNER ONLY, and checked on every method including the read.
    //
    // Write, because an allowed user who can add another allowed user turns one
    // invitation into the whole hub, transitively, without the owner ever
    // seeing the chain. Read, because the list of people with access to a
    // system is worth something to someone deciding whom to phish -- and a
    // guest has no reason to need it.
    //
    // `isOwner` comes from the verified principal (auth.js), never from the
    // request. Note it is NOT the same question as "is this my partition":
    // every signed-in user has a partition of their own, and only an owner has
    // this.
    //
    // The identity to remove travels in the PATH, not in a body. A DELETE
    // carrying a body is not reliably delivered -- measured, not assumed: Node
    // answers 400 to its own client for a chunked DELETE, and the handler sees
    // an empty body. A route that works only when the body happens to arrive is
    // a route that fails silently.
    const accessMatch = p.match(/^\/api\/access(?:\/(.+))?$/);
    if (accessMatch) {
      if (!me.isOwner) {
        // 403, not 404: the caller is genuinely signed in and the route
        // genuinely exists. Pretending otherwise would send someone hunting a
        // credential problem they do not have.
        return send(403, { error: 'only an owner of this hub can manage who has access' });
      }
      const target = accessMatch[1];
      /**
       * One shape for every access response.
       *
       * GET returned `{users, durable, ok, error}` while POST and DELETE
       * returned `{ok, login, users}` -- and the web client REPLACES its state
       * with whatever the last call returned. So after adding or removing
       * anybody, `durable` was suddenly absent, `!data.durable` was true, and
       * the screen announced:
       *
       *   "This hub cannot save its access list, so anyone added here is
       *    forgotten when it restarts."
       *
       * That was false. Verified against a running deployment: the list
       * survived a full restart intact. The message appeared the moment
       * somebody added a colleague -- the exact moment they most need to trust
       * it -- and told them their change would be lost.
       *
       * `ok` was overloaded too: on GET it means "the store is readable", on
       * POST/DELETE it meant "the operation succeeded". Same field, same
       * client code path, two meanings. Failure is already carried by the HTTP
       * status (400 with a reason), so `ok` keeps the single meaning it has on
       * GET, and every response is built here so the three cannot drift again.
       */
      const accessPayload = (extra = {}) => ({
        ...extra,
        users: this.accessStore.list(),
        // A hub that cannot persist its list will forget every grant when it
        // restarts. Saying so is the difference between "added" and "added
        // until the next deploy".
        durable: this.accessStore.persist,
        ok: this.accessStore.ok,
        error: this.accessStore.ok ? null : this.accessStore.error,
      });
      if (req.method === 'GET' && !target) {
        return send(200, accessPayload());
      }
      if (req.method === 'POST' && !target) {
        const body = await readJson(req);
        // `addedBy` is taken from the verified identity, never the body, for
        // the same reason `answeredBy` is on an approval: a log that records a
        // name of the caller's choosing records nothing.
        const r = this.accessStore.add(body && body.login, {
          addedBy: me.name || me.key,
          note: body && body.note,
        });
        if (!r.ok) return send(400, { error: r.reason });
        this._syncAllowedUsers();
        return send(200, accessPayload({ login: r.login }));
      }
      if (req.method === 'DELETE' && target) {
        let login;
        try { login = decodeURIComponent(target); } catch { return send(400, { error: 'bad identity' }); }
        const r = this.accessStore.remove(login);
        if (!r.ok) return send(400, { error: r.reason });
        this._syncAllowedUsers();
        return send(200, accessPayload({ login: r.login }));
      }
      return send(405, { error: 'method not allowed' });
    }

    // -- device tokens --------------------------------------------------------
    //
    // A token is minted FOR THE CALLER'S OWN PARTITION, always. The partition
    // comes from the verified principal and is never read from the request, so
    // there is no request shape that could mint a credential into somebody
    // else's hub view. That is why this needs no separate ownership check.
    if (p === '/api/device-tokens' && req.method === 'POST') {
      if (!this.auth.deviceTokens) {
        return send(501, { error: 'device tokens are not enabled on this hub' });
      }
      const body = await readJson(req);

      // A lifetime is a security control, so it is bounded here rather than
      // trusted from the caller. An unbounded token would make expiry -- the
      // thing that makes a leaked cloud credential self-limiting -- decorative.
      const hours = Number(body.ttlHours);
      if (body.ttlHours !== undefined && (!Number.isFinite(hours) || hours <= 0)) {
        return send(400, { error: 'ttlHours must be a positive number' });
      }
      if (Number.isFinite(hours) && hours > MAX_DEVICE_TOKEN_HOURS) {
        return send(400, {
          error: `ttlHours may not exceed ${MAX_DEVICE_TOKEN_HOURS} (${MAX_DEVICE_TOKEN_HOURS / 24} days)`,
        });
      }

      const label = body.label ? String(body.label).slice(0, 80) : null;
      const didPrefix = body.didPrefix ? String(body.didPrefix).slice(0, 40) : null;
      const token = this.auth.mintDeviceToken({
        key: me.key,
        name: label,
        label,
        didPrefix,
        ...(Number.isFinite(hours) ? { ttlMs: hours * 3600 * 1000 } : {}),
      });
      const claims = this.auth.deviceTokens.verify(token);
      this.deviceTokenStore.record(me.key, {
        jti: claims.jti,
        label: claims.label,
        didPrefix: claims.did,
        issuedAt: claims.iat,
        expiresAt: claims.exp,
      });

      // Returned once and never again: the hub does not keep it. Said plainly
      // in the response so a caller who discards it knows to mint another
      // rather than go looking for a way to read it back.
      return send(201, {
        token,
        jti: claims.jti,
        label: claims.label,
        didPrefix: claims.did,
        expiresAt: claims.exp,
        note: 'This token is shown once. The hub does not store it.',
      });
    }

    if (p === '/api/device-tokens' && req.method === 'GET') {
      // Metadata only. There is no endpoint that returns a token, because
      // there is nowhere it could be read from.
      return send(200, {
        tokens: this.deviceTokenStore.list(me.key),
        // Said plainly rather than left to be discovered: a hub that cannot
        // persist will forget every revocation when it restarts.
        durable: this.deviceTokenStore.persist,
      });
    }

    // Revoke one token, within the caller's own partition. Revoking by bare id
    // across partitions would let one person kill another person's devices.
    const rv = p.match(/^\/api\/device-tokens\/([^/]+)$/);
    if (rv && req.method === 'DELETE') {
      const jti = decodeURIComponent(rv[1]);
      let done;
      try {
        done = this.deviceTokenStore.revoke(me.key, jti);
      } catch (e) {
        // The store could not be read, so it must not be written either --
        // saving on top of it would destroy every revocation already recorded.
        return send(503, { error: e.message });
      }
      // Not 403: revealing the difference between "not yours" and "does not
      // exist" is itself a disclosure.
      if (!done) return send(404, { error: 'no such device token' });
      return send(200, { revoked: jti });
    }

    // Control operations, all routed to a device the caller owns.
    //
    // The op list is an ALLOW-LIST in the pattern itself, so a new verb reaches
    // a daemon only by being named here. That is deliberate: the daemon's own
    // switch has ops the hub must never be able to call -- `start-session`,
    // which trusts a caller-supplied working directory, and `shutdown` -- and
    // the only thing keeping them out of reach is that they are not written on
    // this line.
    const m = p.match(/^\/api\/devices\/([^/]+)\/(spawn|approve|steer|stop|transcript|control-check|resync|forget|squad-doc|squad-docs)$/);
    if (m && req.method === 'POST') {
      const [, deviceId, op] = m;
      const body = await readJson(req);
      const device = this.store.getDevice(me.key, deviceId);
      // Not 403: revealing the difference between "not yours" and "does not
      // exist" is itself a disclosure.
      if (!device) return send(404, { error: 'no such device' });
      /**
       * A device that cannot be reached cannot be commanded -- except to be
       * forgotten.
       *
       * Every other op here tells a running daemon to do something, so an
       * unreachable one is a 409. `forget` is different: it removes rows the
       * hub already holds, and the reason removal is normally delegated to the
       * device (it republishes its whole list on every heartbeat, so a
       * hub-side delete would come straight back) does not apply to a device
       * that will never heartbeat again. An ephemeral job execution is exactly
       * that, and refusing here left its finished sessions with no way to be
       * cleared at all.
       *
       * Reachability is the LIVE SOCKET, not the presence label. Presence is a
       * time-based heuristic with three states, and a device goes `stale`
       * before it goes `offline` -- so testing for `offline` alone still
       * refused a job that had just finished, which is precisely when someone
       * wants to tidy it away.
       */
      const reachable = !!(this._devices.get(me.key) || new Map()).get(deviceId);
      if (!reachable) {
        if (op !== 'forget') return send(409, { error: 'device is offline' });
        const r = this.store.forgetDeviceSessions(me.key, deviceId, {
          olderThanMs: body ? body.olderThanMs : undefined,
        });
        /**
         * Once its last session is gone, the device goes too.
         *
         * An unreachable device is kept in the roster only because its
         * sessions still explain what happened -- that is the whole reason
         * `_pruneStale` skips a device that has any. With none left there is
         * nothing to explain, and the pruner would drop it anyway fifteen
         * minutes after it was last seen. Doing it here just means someone who
         * tidied up sees a tidy list, rather than a row that lingers for a
         * quarter of an hour with nothing behind it.
         *
         * A device that comes back re-registers, so this removes a record, not
         * a machine.
         */
        const left = this.store.listSessions(me.key, { deviceId }).length;
        const deviceRemoved = left === 0 ? this.store.removeDevice(me.key, deviceId) : false;
        return send(200, { ...r, count: r.removed, offline: true, deviceRemoved });
      }
      try {
        // Who is doing this travels with the command. An approval answered on
        // one surface has to show as answered on every other, and "resolved"
        // without "by whom" is the answer to a different question -- on a hub
        // two people can watch, the useful fact is which of them decided.
        // Taken from the validated identity, never from the request body.
        //
        // `forget` is rebuilt field by field rather than spread, so no request
        // body can smuggle its own actor past this line and write a name of
        // its choosing into somebody else's device log.
        const withActor = op === 'approve' ? { ...body, answeredBy: me.name || me.key }
          : op === 'forget' ? { olderThanMs: body ? body.olderThanMs : undefined, forgottenBy: me.name || me.key }
            // Narrowed here as well as at the device. The daemon rebuilds this
            // op field by field anyway, so a smuggled `cwd` could never reach
            // the resolver -- but a hub that relays whatever it was handed is
            // one refactor away from mattering, and the cost of not doing so
            // is one line.
            : op === 'squad-doc' ? { sessionId: body ? body.sessionId : undefined, doc: body ? body.doc : undefined }
              : op === 'squad-docs' ? { sessionId: body ? body.sessionId : undefined }
                : body;
        const result = await this.command(me.key, deviceId, op, withActor);
        return send(200, result);
      } catch (e) {
        return send(e.status || 502, { error: e.message });
      }
    }

    return send(404, { error: 'not found' });
  }

  /**
   * Hand the browser its token WITHOUT putting it in a URL.
   *
   * A redirect to `/?token=...` would write a live credential into browser
   * history, the Referer header, and every proxy log in between. This returns a
   * page that passes it to the app in script and then replaces itself.
   *
   * The handoff itself is a `data-*` attribute read by an EXTERNAL script
   * (`/signin-complete.js`), not an inline `<script>` -- under an enforced
   * `script-src 'self'` an inline block would simply not run, and the token
   * would never reach `localStorage`. An HTML attribute is not script, so it
   * is unaffected by that directive, and the token still never touches a URL,
   * browser history or a Referer header.
   */
  _signinComplete(send, token) {
    return send(200, `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Signing in…</title><link rel="stylesheet" href="/app.css"></head>
<body data-signin-token="${escapeHtml(token)}"><div class="empty"><h3>Signing you in…</h3></div>
<script src="/signin-complete.js"></script></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  _signinError(send, message) {
    return send(403, `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Sign-in failed</title><link rel="stylesheet" href="/app.css"></head>
<body><div class="empty">
  <img class="signin-logo" src="/logo.jpg" alt="Squad Hub" width="140">
  <h3>Sign-in failed</h3>
  <p>${escapeHtml(message)}</p>
  <p><a href="/">Back to the hub</a></p>
</div></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  _static(url, send) {
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    // Decode before resolving, so a file with a space or an encoded character
    // serves correctly.
    try { rel = decodeURIComponent(rel); } catch { return send(400, { error: 'bad path' }); }
    // NORMALIZE IS LOAD-BEARING, not tidiness. `new URL()` collapses a literal
    // `..` segment at parse time, but it leaves `%2f` encoded -- so `/..%2fetc`
    // arrives here intact, becomes `/../etc` on the line above, and is
    // collapsed by THIS call. Verified: /../ , /%2e%2e/ , /a/../../ and
    // /%2e%2e%2f are handled by URL parsing; /..%2f , /..%2f..%2f , /....// and
    // /..%5c are handled only here. Removing this is a path traversal.
    rel = path.normalize(rel).replace(/^([/\\])+/, '');
    const file = path.join(WEB_ROOT, rel);
    // Defence in depth, and reachable the moment the line above stops
    // collapsing `..` -- which is exactly what the mutation harness proves by
    // removing it and requiring this to return 403 rather than the file.
    if (!file.startsWith(WEB_ROOT + path.sep) && file !== WEB_ROOT) {
      return send(403, { error: 'nope' });
    }
    return fs.readFile(file, (err, buf) => {
      if (err) return this._notFound(send, url);
      return send(200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    });
  }

  /**
   * Push the access list into the live authenticator.
   *
   * Without this a grant would take effect on the next restart, which on App
   * Service means "whenever something else happens to recycle the process" --
   * so the person you just added would be refused, and the two of you would
   * spend a while establishing that you had in fact added them.
   *
   * Owners are pointedly not synced. They come from the environment and stay
   * there; see access-store.js.
   */
  _syncAllowedUsers() {
    if (!this.auth) return;
    // Normalised the same way the Authenticator's constructor does. Assigning
    // the field directly bypasses that, and sign-in compares lower-cased
    // candidates -- so an entry that reached this list with any capital in it
    // could never match, and the person would be refused while appearing in
    // the list. The store lower-cases today; this makes the guarantee belong
    // to the comparison rather than to a detail of another file.
    this.auth.allowedUsers = this.accessStore.allowedUsers()
      .map((u) => String(u).trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * A 404 that suits whoever asked.
   *
   * A person who mistyped a URL wants a page; a script wants JSON it can parse.
   * Returning HTML to a fetch() breaks the caller's error handling, and
   * returning `{"error":"not found"}` to a browser looks like the site is
   * broken rather than the address being wrong.
   */
  _notFound(send, url) {
    const wantsHtml = !String(url.pathname).startsWith('/api/');
    if (!wantsHtml) return send(404, { error: 'not found' });
    return send(404, notFoundPage(), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  // -- WebSocket ------------------------------------------------------------
  async _upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('access_token');
    let me;
    try { me = await this.auth.verify(`Bearer ${token}`); }
    catch {
      // A browser cannot read the body of a failed upgrade, so say it plainly.
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const conn = ws.upgrade(req, socket, head);
    if (!conn) return;

    // Checked before the role branch below, and before either attach path, so
    // a foreign Origin cannot reach device registration OR the watcher event
    // stream -- the same credential-then-role order the kind checks already
    // follow, just one gate earlier. See originIsAllowed() above for exactly
    // what is accepted and why. `this.publicOrigin` is `SQUAD_HUB_PUBLIC_URL`,
    // normalised, or null -- passing it (rather than letting the check derive
    // one from this request) is what makes a configured domain authoritative.
    if (!originIsAllowed(req, this.publicOrigin)) {
      conn.close(1008, 'this origin is not allowed to open a socket on this hub');
      return;
    }

    const role = url.searchParams.get('role') === 'device' ? 'device' : 'watcher';

    // A device token authorises exactly one thing: being a device. Letting one
    // open a WATCHER socket would hand back the live event stream -- every
    // session, every prompt, every approval -- which is most of what refusing
    // it on the API was protecting.
    if (me.kind === KIND_DEVICE && role !== 'device') {
      conn.close(1008, 'a device token cannot open a watcher socket');
      return;
    }

    // The converse, once enforcement is on: a person's own credential may not
    // stand in for a device credential. Off by default so existing deployments
    // keep working while their devices are migrated.
    if (role === 'device' && me.kind !== KIND_DEVICE && this.auth.requireDeviceTokens) {
      conn.close(1008, 'this hub requires a device token; run: squad-hub device-token --list');
      return;
    }

    if (role === 'device') this._attachDevice(me, conn, url);
    else this._attachWatcher(me, conn);
  }

  _attachDevice(me, conn, url) {
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) { conn.close(1008); return; }

    // Least privilege inside the device role, not merely at its edge. A token
    // minted for ACA jobs with didPrefix 'aca-' may register 'aca-<execution>'
    // and cannot claim to be your laptop -- so a leaked job secret cannot take
    // over the device slot of the machine you are sitting at.
    if (!DeviceTokens.allowsDeviceId({ did: me.didPrefix }, deviceId)) {
      conn.close(1008, 'this token may not register that device id');
      return;
    }

    if (!this._devices.has(me.key)) this._devices.set(me.key, new Map());
    const existing = this._devices.get(me.key).get(deviceId);
    if (existing && existing !== conn) existing.close(1000);
    this._devices.get(me.key).set(deviceId, conn);

    conn.on('message', (msg) => this._fromDevice(me, deviceId, msg));
    conn.on('close', () => {
      const map = this._devices.get(me.key);
      if (map && map.get(deviceId) === conn) map.delete(deviceId);
      this._broadcast(me.key, { type: 'device-disconnected', deviceId });
    });
    conn.sendJson({ type: 'welcome', deviceId, subject: me.key });
  }

  _attachWatcher(me, conn) {
    if (!this._watchers.has(me.key)) this._watchers.set(me.key, new Set());
    this._watchers.get(me.key).add(conn);
    conn.on('close', () => {
      const s = this._watchers.get(me.key);
      if (s) s.delete(conn);
    });
    conn.sendJson({ type: 'overview', ...this.store.overview(me.key) });
  }

  _fromDevice(me, deviceId, msg) {
    switch (msg.type) {
      case 'register':
        this.store.registerDevice(me.key, { ...msg.device, deviceId });
        if (msg.sessions) this.store.syncSessions(me.key, deviceId, msg.sessions);
        break;
      case 'heartbeat':
        this.store.heartbeat(me.key, deviceId, msg.device || {});
        if (msg.sessions) this.store.syncSessions(me.key, deviceId, msg.sessions);
        break;
      case 'sessions':
        this.store.syncSessions(me.key, deviceId, msg.sessions || []);
        break;
      case 'session':
        this.store.upsertSession(me.key, deviceId, msg.session);
        break;
      case 'transcript':
        this._broadcast(me.key, { type: 'transcript', deviceId, sessionId: msg.sessionId, entries: msg.entries });
        return;
      case 'reply': {
        const p = this._pending.get(msg.correlationId);
        if (p) {
          this._pending.delete(msg.correlationId);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(Object.assign(new Error(msg.error || 'the device refused'), { status: 400 }));
        }
        return;
      }
      default:
        return;
    }
    this._broadcast(me.key, { type: 'overview', ...this.store.overview(me.key) });
    this._notifyPending(me.key, deviceId);
  }

  _broadcast(subject, payload) {
    const set = this._watchers.get(subject);
    if (!set) return;
    for (const c of set) c.sendJson(payload);
  }

  /**
   * Push a Teams card for anything newly waiting on a human.
   *
   * Failures are swallowed on purpose. A notification is a convenience; the
   * approval is already in the hub, and a broken webhook must not take the
   * control plane with it.
   */
  _notifyPending(subject, deviceId) {
    if (!this.teams || !this.teams.enabled) return;
    const device = this.store.getDevice(subject, deviceId);
    if (!device) return;
    for (const s of this.store.listSessions(subject, { deviceId })) {
      for (const a of s.pendingApprovals || []) {
        this.teams.notifyApproval({ session: s, device, approval: a }).catch(() => {});
      }
    }
  }

  /** Send a command to a device and await its reply. */
  command(subject, deviceId, op, body, timeoutMs = 20000) {
    const map = this._devices.get(subject);
    const conn = map && map.get(deviceId);
    if (!conn) {
      return Promise.reject(Object.assign(new Error('device is not connected'), { status: 409 }));
    }
    const correlationId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(correlationId);
        reject(Object.assign(new Error(`the device did not answer '${op}' in time`), { status: 504 }));
      }, timeoutMs);
      this._pending.set(correlationId, { resolve, reject, timer });
      conn.sendJson({ type: 'command', op, correlationId, ...body });
    });
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * The page a person gets when they mistype a URL.
 *
 * Self-contained rather than a file on disk: a 404 handler that can itself 404
 * is a special kind of unhelpful, and this one has to work even if the web
 * assets are missing or the deployment is half-finished. The only external
 * reference is the logo, and the layout survives it not loading.
 */
function notFoundPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 — Not Found | Squad Hub</title>
<style>${NOT_FOUND_STYLE}</style>
</head>
<body>
  <div class="wrap">
    <img src="/logo.jpg" alt="Squad Hub">
    <h1>404</h1>
    <h2>No such session.</h2>
    <p>That page was never spawned — or it finished and got reaped. 🤖</p>
    <div class="actions">
      <a class="btn primary" href="/">Back to the hub</a>
      <a class="btn ghost" href="https://github.com/swigerb/squad-hub">Documentation</a>
    </div>
  </div>
</body>
</html>`;
}

function readJson(req) {  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
  });
}

module.exports = { HubService };
