'use strict';
/** Talks to a running daemon over the local IPC endpoint. */

const fs = require('fs');
const net = require('net');
const paths = require('./paths');

function readState() {
  try { return JSON.parse(fs.readFileSync(paths.state(), 'utf8')); } catch { return null; }
}

function daemonAlive() {
  const st = readState();
  if (!st || !st.pid) return false;
  try { process.kill(st.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function call(op, extra = {}, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = paths.ipc();
    const sock = net.createConnection(endpoint);
    let buf = '';
    const done = (fn, arg) => { try { sock.end(); } catch { /* closing */ } clearTimeout(t); fn(arg); };
    const t = setTimeout(() => done(reject, new Error(`daemon did not answer '${op}' within ${timeoutMs}ms`)), timeoutMs);

    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, op, ...extra }) + '\n'));
    sock.on('data', (c) => {
      buf += c.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch { return done(reject, new Error('unparseable reply from daemon')); }
      if (msg.ok) return done(resolve, msg.result);
      const e = new Error(msg.error || 'daemon returned an error');
      e.code = msg.code;
      return done(reject, e);
    });
    sock.on('error', (e) => {
      clearTimeout(t);
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
        return reject(Object.assign(new Error('no daemon is running (try: squad-hub start)'), { code: 'NO_DAEMON' }));
      }
      reject(e);
    });
  });
}

module.exports = { call, readState, daemonAlive };
