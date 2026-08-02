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
const { Store, PRESENCE } = require('./store');
const ws = require('./ws');

const WEB_ROOT = path.join(__dirname, '..', '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

class HubService {
  constructor(opts = {}) {
    this.auth = opts.auth || new Authenticator({
      mode: process.env.SQUAD_HUB_AUTH_MODE || MODES.DEV,
      devSecret: process.env.SQUAD_HUB_DEV_SECRET || crypto.randomBytes(16).toString('hex'),
      allowedTenants: (process.env.SQUAD_HUB_TENANTS || '').split(',').filter(Boolean),
      audience: process.env.SQUAD_HUB_AUDIENCE || null,
    });
    this.store = opts.store || new Store();
    this.serveWeb = opts.serveWeb !== false;

    /** subject -> deviceId -> WsConnection */
    this._devices = new Map();
    /** subject -> Set<WsConnection> */
    this._watchers = new Map();
    /** correlation id -> {resolve, reject, timer} */
    this._pending = new Map();

    this.server = http.createServer((req, res) => this._http(req, res));
    this.server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
  }

  listen(port = 0, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve(this.server.address()));
    });
  }

  close() {
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
    if (url.pathname === '/healthz') return send(200, { ok: true, mode: this.auth.mode });

    if (url.pathname.startsWith('/api/')) {
      let principal;
      try { principal = await this.auth.verify(req.headers.authorization); }
      catch (e) { return send(e.status || 401, { error: e.message }); }
      try { return await this._api(url, req, res, principal, send); }
      catch (e) { return send(e.status || 500, { error: e.message }); }
    }

    if (this.serveWeb) return this._static(url, send);
    return send(404, { error: 'not found' });
  }

  async _api(url, req, res, me, send) {
    const p = url.pathname;

    if (p === '/api/me' && req.method === 'GET') {
      return send(200, { name: me.name, tenantId: me.tid, subject: me.key });
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
      if (err) return send(404, { error: 'not found' });
      return send(200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    });
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
    if (role === 'device') this._attachDevice(me, conn, url);
    else this._attachWatcher(me, conn);
  }

  _attachDevice(me, conn, url) {
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) { conn.close(1008); return; }

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
  }

  _broadcast(subject, payload) {
    const set = this._watchers.get(subject);
    if (!set) return;
    for (const c of set) c.sendJson(payload);
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

function readJson(req) {
  return new Promise((resolve, reject) => {
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
