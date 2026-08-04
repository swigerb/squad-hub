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
const paths = require('../paths');
const { GitHubOAuth } = require('./github-oauth');
const { Store, PRESENCE } = require('./store');
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
    this.auth = opts.auth || new Authenticator({
      mode: process.env.SQUAD_HUB_AUTH_MODE || MODES.DEV,
      devSecret: process.env.SQUAD_HUB_DEV_SECRET || crypto.randomBytes(16).toString('hex'),
      allowedTenants: (process.env.SQUAD_HUB_TENANTS || '').split(',').filter(Boolean),
      allowedUsers: (process.env.SQUAD_HUB_ALLOWED_USERS || '').split(',').filter(Boolean),
      owner: (process.env.SQUAD_HUB_OWNER || '').split(',').filter(Boolean),
      audience: process.env.SQUAD_HUB_AUDIENCE || null,
    });
    this.store = opts.store || new Store();
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
      res.writeHead(302, { Location: authUrl, 'Cache-Control': 'no-store' });
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
        // Named rather than implied, so it appears in the UI and in any log
        // scrape without the reader having to know the rule.
        scaleOutWarning: instances && instances > 1
          ? `This hub is running on ${instances} instances. State is held in memory, `
            + 'so a device attached to one instance is invisible to the others and '
            + 'commands will fail intermittently. Scale to a single instance.'
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
    const m = p.match(/^\/api\/devices\/([^/]+)\/(spawn|approve|steer|stop|transcript)$/);
    if (m && req.method === 'POST') {
      const [, deviceId, op] = m;
      const body = await readJson(req);
      const device = this.store.getDevice(me.key, deviceId);
      // Not 403: revealing the difference between "not yours" and "does not
      // exist" is itself a disclosure.
      if (!device) return send(404, { error: 'no such device' });
      if (device.presence === PRESENCE.OFFLINE) return send(409, { error: 'device is offline' });
      try {
        const result = await this.command(me.key, deviceId, op, body);
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
   */
  _signinComplete(send, token) {
    const safe = JSON.stringify(token);
    return send(200, `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Signing in…</title><link rel="stylesheet" href="/app.css"></head>
<body><div class="empty"><h3>Signing you in…</h3></div>
<script>
  try { localStorage.setItem('squad-hub-token', ${safe}); } catch (e) {}
  location.replace('/');
</script></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  _signinError(send, message) {
    return send(403, `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Sign-in failed</title><link rel="stylesheet" href="/app.css"></head>
<body><div class="empty">
  <img src="/logo.jpg" alt="Squad Hub" width="140" style="border-radius:12px;margin-bottom:20px">
  <h3>Sign-in failed</h3>
  <p>${escapeHtml(message)}</p>
  <p><a href="/">Back to the hub</a></p>
</div></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  _static(url, send) {
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    // Decode before resolving, so a file with a space or an encoded character
    // serves correctly. That decoding is also what makes the containment check
    // below load-bearing: without it, `%2e%2e` never becomes `..` and the guard
    // is unreachable dead code.
    try { rel = decodeURIComponent(rel); } catch { return send(400, { error: 'bad path' }); }
    rel = path.normalize(rel).replace(/^([/\\])+/, '');
    const file = path.join(WEB_ROOT, rel);
    // Defence in depth. `new URL()` has already collapsed any `..`, so this is
    // currently unreachable -- verified for /../ , /%2e%2e/ , /a/../../ and
    // /..%2f , all of which resolve inside web/. It stays because it becomes
    // load-bearing the moment this handler stops going through URL parsing.
    if (!file.startsWith(WEB_ROOT + path.sep) && file !== WEB_ROOT) {
      return send(403, { error: 'nope' });
    }
    return fs.readFile(file, (err, buf) => {
      if (err) return this._notFound(send, url);
      return send(200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    });
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
<style>
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
</style>
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
