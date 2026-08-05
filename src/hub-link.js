'use strict';
/**
 * The daemon's outbound link to the hub service.
 *
 * Outbound-only by design: the daemon dials the service, so a laptop or dev box
 * needs no inbound port and no firewall change. Control commands travel back
 * down that same connection.
 *
 * A minimal RFC 6455 client, to match the dependency-free server.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { WsConnection } = require('./service/ws');

class HubLink extends EventEmitter {
  constructor({ url, token, deviceId, heartbeatMs = 15000 }) {
    super();
    this.url = url;
    this.token = token;
    this.deviceId = deviceId;
    this.heartbeatMs = heartbeatMs;
    this.conn = null;
    this.connected = false;
    this._retry = 0;
    this._timer = null;
    this._stopped = false;
    this._req = null;
    this._reconnectTimer = null;
  }

  connect() {
    if (this._stopped) return Promise.resolve(null);
    const u = new URL(this.url);
    u.searchParams.set('access_token', this.token);
    u.searchParams.set('role', 'device');
    u.searchParams.set('deviceId', this.deviceId);

    const isTls = u.protocol === 'wss:' || u.protocol === 'https:';
    const key = crypto.randomBytes(16).toString('base64');
    const lib = isTls ? https : http;

    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (isTls ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });
      // Tracked so `stop()` can abort a handshake that never resolves --
      // otherwise the socket sits open in the agent pool and a short-lived
      // caller (a bounded validation probe, not the long-lived daemon) hangs
      // past the point it believed it had given up.
      this._req = req;

      req.on('upgrade', (res, socket, head) => {
        this._req = null;
        socket.setNoDelay(true);
        const conn = new WsConnection(socket);
        this.conn = conn;

        conn.on('message', (m) => {
          /**
           * An HTTP 101 only says the socket upgraded. The hub applies
           * device-token prefix and role policy AFTER the upgrade, then sends
           * `welcome` only when the device was actually registered. Treating
           * 101 as connected produced a brief false success before the
           * immediate 1008 refusal arrived.
           */
          if (m.type === 'welcome' && m.deviceId === this.deviceId) {
            this.connected = true;
            this._retry = 0;
            this.emit('connected');
            resolveOnce(conn);
          }
          if (m.type === 'command') this.emit('command', m);
          else this.emit('message', m);
        });
        conn.on('close', () => {
          const wasConnected = this.connected;
          this.connected = false;
          this.conn = null;

          // 1008 is a POLICY refusal: the hub understood us and said no. A bad
          // token, an expired one, or a device id this token may not register.
          // None of those become true by trying again, so retrying is a hot
          // loop that also buries the reason. Same reasoning as the 401/403
          // case below -- this one just arrives after the upgrade succeeded.
          if (conn.closeCode === 1008) {
            const why = conn.closeReason || 'the hub refused this connection';
            this.emit('refused', why);
            rejectOnce(Object.assign(new Error(why), { status: 403 }));
            return;
          }
          if (!wasConnected) {
            rejectOnce(new Error('the hub closed the socket before registering this device'));
          }
          this.emit('disconnected');
          this._scheduleReconnect();
        });

        // Attach handlers before consuming buffered upgrade bytes. A fast hub
        // can place the welcome frame in `head`; consuming it first would lose
        // the one message that proves registration succeeded.
        if (head && head.length) conn._onData(head);
      });

      req.on('response', (res) => {
        this._req = null;
        // A non-101 answer means the hub rejected us. Retry, unless it was an
        // auth failure -- a bad token will not become good by trying again, and
        // a reconnect loop against 401 is just noise.
        const status = res.statusCode;
        const e = Object.assign(new Error(`the hub refused the connection (HTTP ${status})`), { status });
        if (status === 401 || status === 403) {
          // This arrives BEFORE the upgrade, unlike the 1008 case above, so it
          // is the only signal a caller gets for a bad/expired/wrong-prefix
          // token that the server rejects outright. Emit the same event either
          // way, so `squad-hub connect` (and anything else watching daemon
          // state) sees one refusal reason regardless of which stage rejected.
          this.emit('refused', e.message);
        } else {
          this._scheduleReconnect();
        }
        rejectOnce(e);
      });
      req.on('error', (e) => {
        this._req = null;
        // The hub may simply not be up yet. An initial failure that never
        // retries leaves the device permanently and silently detached, which is
        // worse than being slow to attach.
        this._scheduleReconnect();
        rejectOnce(e);
      });
      req.end();
    });
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    this._retry += 1;
    const delay = Math.min(30000, 500 * 2 ** Math.min(this._retry, 6));
    // Tracked and cleared by `stop()`, and unref'd, so a caller that gives up
    // on this link -- the daemon on shutdown, or a short-lived validation
    // probe that never even wants a retry -- is not held open by a pending
    // timer whose callback will no-op anyway once `_stopped` is set.
    this._reconnectTimer = setTimeout(() => { this.connect().catch(() => {}); }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  send(obj) {
    if (!this.conn || !this.connected) return false;
    this.conn.sendJson(obj);
    return true;
  }

  reply(correlationId, ok, resultOrError) {
    return this.send(ok
      ? { type: 'reply', correlationId, ok: true, result: resultOrError }
      : { type: 'reply', correlationId, ok: false, error: String(resultOrError) });
  }

  startHeartbeat(getPayload) {
    this._timer = setInterval(() => {
      if (!this.connected) return;
      this.send({ type: 'heartbeat', ...getPayload() });
    }, this.heartbeatMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.conn) this.conn.close();
    // A handshake still in flight (the socket case in `connect()` above) has
    // no `conn` yet, so it would otherwise keep a socket -- and, for a
    // short-lived caller, the whole process -- alive indefinitely.
    if (this._req) {
      try { this._req.destroy(); } catch { /* best effort */ }
      this._req = null;
    }
  }
}

module.exports = { HubLink };
