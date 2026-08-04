'use strict';
/**
 * A minimal RFC 6455 WebSocket server.
 *
 * Written rather than depended on, because this repo has no dependencies and
 * the frame handling needed is small: text frames, close, ping/pong. The parts
 * that are easy to get wrong -- masking, fragmentation, 64-bit lengths -- are
 * handled explicitly and tested.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(d) {
    this._buf = Buffer.concat([this._buf, d]);
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
    }
  }

  _readFrame() {
    const b = this._buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off); off += 8;
      if (big > 8n * 1024n * 1024n) { this.close(1009); return null; }
      len = Number(big);
    }

    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.slice(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;

    const payload = Buffer.from(b.slice(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    this._buf = b.slice(off + len);
    return { fin, opcode, payload };
  }

  _handleFrame(f) {
    if (f.opcode === 0x8) {
      // Keep the code and reason before replying. Discarding them leaves the
      // other end unable to tell "the hub restarted" from "your token may not
      // register that device id" -- and a client that cannot tell the
      // difference reconnects forever against a refusal it will never satisfy.
      if (f.payload && f.payload.length >= 2) {
        this.closeCode = f.payload.readUInt16BE(0);
        this.closeReason = f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : '';
      }
      this.close(this.closeCode || 1000);
      return;
    }
    if (f.opcode === 0x9) { this._send(0xa, f.payload); return; } // ping -> pong
    if (f.opcode === 0xa) return;                                  // pong

    if (f.opcode === 0x0) {
      this._fragments.push(f.payload);
    } else {
      this._fragments = [f.payload];
      this._fragmentOpcode = f.opcode;
    }
    if (!f.fin) return;

    const full = Buffer.concat(this._fragments);
    this._fragments = [];
    if (this._fragmentOpcode !== 0x1) return; // text only
    let msg;
    try { msg = JSON.parse(full.toString('utf8')); } catch { return; }
    this.emit('message', msg);
  }

  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([header, payload])); } catch { this._onClose(); }
  }

  sendJson(obj) { this._send(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }

  /**
   * Send a protocol-level ping.
   *
   * Needed because intermediaries close connections that carry no traffic --
   * Azure App Service does so at about 240 seconds, and it is far from alone.
   * A browser watching an idle hub sends nothing and receives nothing, so
   * without this it is dropped and must reconnect, showing stale data in
   * between.
   *
   * A ping frame rather than an application message: it costs 2 bytes, needs no
   * handling on the other side, and cannot be confused with real content.
   */
  ping() {
    if (this.closed || this.socket.destroyed) return false;
    this._send(0x9, Buffer.alloc(0));
    return true;
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    // A close frame may carry a reason, and a client can read it. Without one,
    // a rejected device sees only 1008 and has no idea whether its token was
    // wrong, expired, or simply not allowed to claim that device id.
    const r = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._send(0x8, p);
    this.closed = true;
    try { this.socket.end(); } catch { /* closing */ }
    this.emit('close');
  }
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** Complete the handshake. Returns a WsConnection, or null if it was not a valid upgrade. */
function upgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return null;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '', '',
  ].join('\r\n'));
  const conn = new WsConnection(socket);
  if (head && head.length) conn._onData(head);
  return conn;
}

module.exports = { upgrade, WsConnection, acceptKey };
