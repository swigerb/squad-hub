'use strict';
/**
 * The WebSocket upgrade is not device registration.
 *
 * The hub accepts HTTP 101 first, then applies device-token role/prefix policy,
 * and sends `welcome` only after the device was registered. HubLink.connect()
 * must therefore stay pending until welcome, or `squad-hub connect` can report
 * success in the brief window before an immediate policy close.
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const { HubLink } = require('../src/hub-link');
const { WsConnection } = require('../src/service/ws');

let pass = 0; let fail = 0;
async function check(name, fn) {
  try {
    await fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

(async () => {
  let serverConn = null;
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    serverConn = new WsConnection(socket);
    if (head && head.length) serverConn._onData(head);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const link = new HubLink({
    url: `ws://127.0.0.1:${port}/ws`,
    token: 'test',
    deviceId: 'device-1',
  });

  try {
    const connecting = link.connect();
    await check('HubLink does NOT report connected merely because HTTP upgraded', async () => {
      const outcome = await Promise.race([
        connecting.then(() => 'resolved', () => 'rejected'),
        delay(350).then(() => 'pending'),
      ]);
      assert.strictEqual(outcome, 'pending',
        `connect() ${outcome} before the hub registered the device`);
      assert.strictEqual(link.connected, false);
    });

    await check('HubLink reports connected after the post-policy welcome', async () => {
      const deadline = Date.now() + 3000;
      while (!serverConn && Date.now() < deadline) await delay(10);
      assert.ok(serverConn, 'the server never received the upgraded socket');
      serverConn.sendJson({ type: 'welcome', deviceId: 'device-1', subject: 'u' });
      await connecting;
      assert.strictEqual(link.connected, true);
    });
  } finally {
    link.stop();
    try { if (serverConn) serverConn.close(); } catch { /* closing */ }
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(`ERROR: ${e.message}`);
  console.log(e.stack);
  process.exit(1);
});
