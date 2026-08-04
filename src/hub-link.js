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

      req.on('upgrade', (res, socket, head) => {
        socket.setNoDelay(true);
        const conn = new WsConnection(socket);
        if (head && head.length) conn._onData(head);
        this.conn = conn;
        this.connected = true;
        this._retry = 0;

        conn.on('message', (m) => {
          if (m.type === 'command') this.emit('command', m);
          else this.emit('message', m);
        });
        conn.on('close', () => {
          this.connected = false;
          this.conn = null;

          // 1008 is a POLICY refusal: the hub understood us and said no. A bad
          // token, an expired one, or a device id this token may not register.
          // None of those become true by trying again, so retrying is a hot
          // loop that also buries the reason. Same reasoning as the 401/403
          // case below -- this one just arrives after the upgrade succeeded.
          if (conn.closeCode === 1008) {
            this.emit('refused', conn.closeReason || 'the hub refused this connection');
            return;
          }
          this.emit('disconnected');
          this._scheduleReconnect();
        });

        this.emit('connected');
        resolve(conn);
      });

      req.on('response', (res) => {
        // A non-101 answer means the hub rejected us. Retry, unless it was an
        // auth failure -- a bad token will not become good by trying again, and
        // a reconnect loop against 401 is just noise.
        const status = res.statusCode;
        if (status !== 401 && status !== 403) this._scheduleReconnect();
        reject(Object.assign(new Error(`the hub refused the connection (HTTP ${status})`), { status }));
      });
      req.on('error', (e) => {
        // The hub may simply not be up yet. An initial failure that never
        // retries leaves the device permanently and silently detached, which is
        // worse than being slow to attach.
        this._scheduleReconnect();
        reject(e);
      });
      req.end();
    });
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    this._retry += 1;
    const delay = Math.min(30000, 500 * 2 ** Math.min(this._retry, 6));
    setTimeout(() => { this.connect().catch(() => {}); }, delay);
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
    if (this.conn) this.conn.close();
  }
}

module.exports = { HubLink };
