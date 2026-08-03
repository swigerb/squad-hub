#!/usr/bin/env node
/**
 * What can a stranger do to this hub?
 *
 * Asked before any lockdown work, because "it needs authentication" is a
 * feeling and this produces a list. Every check is written from the position of
 * someone who knows only the URL.
 *
 * The interesting question is not whether the API rejects anonymous requests --
 * it does, and that is easy. It is:
 *
 *   - does anything leak WITHOUT a token (health, headers, error bodies)?
 *   - can a device be registered by someone who is not the owner?
 *   - in dev auth, what does holding the shared secret actually grant?
 *
 * Usage: node security-probe.js --host <host> [--secret <s>]
 *        The secret is optional: without it the probe is a pure outsider.
 */

'use strict';

const https = require('https');
const crypto = require('crypto');
const path = require('path');

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const HOST = arg('host');
const SECRET = arg('secret');
if (!HOST) { console.log('usage: node security-probe.js --host <host> [--secret <s>]'); process.exit(77); }

const { WsConnection } = require(path.join(__dirname, '..', 'src', 'service', 'ws'));

const log = (...a) => console.log('[sec]', ...a);
const results = [];
function record(severity, what, detail) {
  results.push({ severity, what, detail });
  const tag = severity === 'OPEN' ? 'OPEN  ' : severity === 'LEAK' ? 'LEAK  ' : 'closed';
  console.log(`  ${tag} ${what}${detail ? ` -- ${detail}` : ''}`);
}

function req(p, { method = 'GET', token = null, body = null } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path: p, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      timeout: 25000,
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: j, raw: b, headers: res.headers });
      });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

function tryDeviceSocket(token, deviceId) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const r = https.request({
      hostname: HOST, port: 443,
      path: `/ws?access_token=${encodeURIComponent(token || '')}&role=device&deviceId=${deviceId}`,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
      },
      timeout: 20000,
    });
    r.on('upgrade', (res, socket, head) => {
      const c = new WsConnection(socket);
      if (head && head.length) c._onData(head);
      resolve({ upgraded: true, conn: c });
    });
    r.on('response', (res) => resolve({ upgraded: false, status: res.statusCode }));
    r.on('error', (e) => resolve({ upgraded: false, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ upgraded: false, error: 'timeout' }); });
    r.end();
  });
}

(async () => {
  log(`target: ${HOST}`);
  log('');
  log('=== as a complete stranger (no token) ===');

  for (const p of ['/api/me', '/api/overview', '/api/devices', '/api/sessions']) {
    const r = await req(p);
    if (r.status === 200) record('OPEN', `GET ${p}`, `returned data anonymously`);
    else record('ok', `GET ${p}`, `HTTP ${r.status}`);
  }

  const post = await req('/api/devices/anything/spawn', { method: 'POST', body: { prompt: 'x' } });
  if (post.status === 200) record('OPEN', 'POST spawn', 'ran a command anonymously');
  else record('ok', 'POST spawn', `HTTP ${post.status}`);

  const ws = await tryDeviceSocket(null, 'intruder');
  if (ws.upgraded) { record('OPEN', 'device WebSocket with no token', 'registered anonymously'); ws.conn.close(); }
  else record('ok', 'device WebSocket with no token', `refused (${ws.status || ws.error})`);

  // What does an unauthenticated health endpoint volunteer?
  const h = await req('/healthz');
  if (h.status === 200 && h.body) {
    const fields = Object.keys(h.body);
    log(`  note   /healthz is public and returns: ${fields.join(', ')}`);
    if ('devices' in h.body) record('LEAK', '/healthz device count', `${h.body.devices} -- tells a stranger whether you are working`);
    if ('build' in h.body) record('LEAK', '/healthz build id', `${h.body.build}`);
    if ('instance' in h.body) record('LEAK', '/healthz instance id', `${h.body.instance}`);
    if ('version' in h.body) record('LEAK', '/healthz version', `${h.body.version} -- helps target a known bug`);
  }

  // Does the web app hand anything out before sign-in?
  const idx = await req('/');
  if (idx.status === 200) {
    const leaks = /token|secret|[A-Za-z0-9_-]{40,}/.test(idx.raw);
    record(leaks ? 'LEAK' : 'ok', 'GET / (the web app)', leaks ? 'the page contains token-like text' : 'no credential in the page');
  }

  log('');
  log('=== forged credentials ===');
  const forged = (() => {
    const body = Buffer.from(JSON.stringify({ tid: 'local', oid: 'attacker' })).toString('base64url');
    const sig = crypto.createHmac('sha256', 'guess').update(body).digest('base64url');
    return `${body}.${sig}`;
  })();
  const f = await req('/api/overview', { token: forged });
  record(f.status === 200 ? 'OPEN' : 'ok', 'forged token', `HTTP ${f.status}`);

  const fws = await tryDeviceSocket(forged, 'intruder2');
  if (fws.upgraded) { record('OPEN', 'device socket with forged token', 'registered'); fws.conn.close(); }
  else record('ok', 'device socket with forged token', `refused (${fws.status || fws.error})`);

  // ---- with the shared secret, which is the real question in dev auth -----
  if (SECRET) {
    log('');
    log('=== holding the shared dev secret ===');
    const mint = (tid, oid) => {
      const body = Buffer.from(JSON.stringify({ tid, oid, name: oid })).toString('base64url');
      const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
      return `${body}.${sig}`;
    };

    const asOwner = await req('/api/me', { token: mint('local', 'brswig') });
    record(asOwner.status === 200 ? 'ok' : 'OPEN', 'the owner can sign in', `HTTP ${asOwner.status}`);

    // The point: in dev auth the secret IS the authority. Anyone holding it can
    // claim to be anyone -- including a subject that has never existed.
    const asAnyone = await req('/api/me', { token: mint('any-tenant', 'somebody-else') });
    if (asAnyone.status === 200) {
      record('OPEN', 'ANY identity can be minted from the secret',
        `signed in as "${asAnyone.body.name}" in tenant "${asAnyone.body.tenantId}"`);
    } else {
      record('ok', 'arbitrary identities are refused', `HTTP ${asAnyone.status}`);
    }

    const rogue = await tryDeviceSocket(mint('any-tenant', 'somebody-else'), 'rogue-device');
    if (rogue.upgraded) {
      record('OPEN', 'a stranger holding the secret can register a device', 'their own partition, but on your hub');
      rogue.conn.close();
    } else {
      record('ok', 'device registration is restricted', `refused (${rogue.status || rogue.error})`);
    }
  }

  log('');
  log('===== SUMMARY =====');
  const open = results.filter((r) => r.severity === 'OPEN');
  const leak = results.filter((r) => r.severity === 'LEAK');
  console.log(`${results.length} checks: ${open.length} open, ${leak.length} informational leaks`);
  if (open.length) {
    console.log('\nOPEN:');
    for (const o of open) console.log(` - ${o.what}: ${o.detail}`);
  }
  if (leak.length) {
    console.log('\nLEAKS (unauthenticated):');
    for (const o of leak) console.log(` - ${o.what}: ${o.detail}`);
  }
  process.exit(0);
})().catch((e) => { console.log('[sec] ERROR: ' + e.message); process.exit(77); });
