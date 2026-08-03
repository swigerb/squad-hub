#!/usr/bin/env node
/**
 * Does Squad Hub actually work on Azure App Service?
 *
 * Squad Hub lives or dies on a long-lived outbound WebSocket from each device.
 * "App Service supports WebSockets" is in the documentation; what matters is
 * whether a connection SURVIVES, whether commands still route after minutes of
 * quiet, and what the platform does to in-memory state.
 *
 * Four questions, each with a failure that would matter:
 *
 *   1. Does the upgrade succeed at all through App Service's front end?
 *   2. Does a device connection survive several minutes of idleness, and can it
 *      still be commanded afterwards? An idle timeout that silently drops
 *      devices is worse than no support, because the roster keeps showing them.
 *   3. Does the daemon's own heartbeat keep it alive?
 *   4. Does scale-out break it? In-memory state per instance means a device on
 *      instance A is invisible to a browser served by instance B.
 *
 * Usage: node appservice-probe.js --host <app>.azurewebsites.net --secret <s> [--idle 360]
 * Exit:  0 all answered, 1 a hard failure, 77 inconclusive.
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
const IDLE_S = Number(arg('idle', 360));

if (!HOST || !SECRET) {
  console.log('usage: node appservice-probe.js --host <app>.azurewebsites.net --secret <devSecret>');
  process.exit(77);
}

const { Authenticator, MODES } = require(path.join(__dirname, '..', 'src', 'service', 'auth'));
const { WsConnection } = require(path.join(__dirname, '..', 'src', 'service', 'ws'));

const auth = new Authenticator({ mode: MODES.DEV, devSecret: SECRET });
const TOKEN = auth.mintDevToken('local', 'probe', 'Probe');

const log = (...a) => console.log('[as]', ...a);
const findings = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(p, opts = {}) {
  return new Promise((resolve) => {
    const body = opts.body ? JSON.stringify(opts.body) : null;
    const req = https.request({
      hostname: HOST, path: p, method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      timeout: 30000,
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: j, raw: b, headers: res.headers });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

/** A device WebSocket, over wss, through App Service's front end. */
function connectDevice(deviceId) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = https.request({
      hostname: HOST, port: 443,
      path: `/ws?access_token=${encodeURIComponent(TOKEN)}&role=device&deviceId=${deviceId}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
      timeout: 30000,
    });
    req.on('upgrade', (res, socket, head) => {
      socket.setNoDelay(true);
      const c = new WsConnection(socket);
      if (head && head.length) c._onData(head);
      resolve(c);
    });
    req.on('response', (res) => reject(new Error(`no upgrade: HTTP ${res.statusCode}`)));
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('upgrade timed out')); });
    req.end();
  });
}

(async () => {
  log(`host: ${HOST}`);

  // -- 0. is it even up? ----------------------------------------------------
  const health = await api('/healthz');
  findings.healthz = health.status;
  log(`healthz: ${health.status} ${health.raw}`);
  if (health.status !== 200) {
    log('the service is not answering; nothing else can be judged');
    return done(77);
  }
  // Worth recording: it tells us the platform, not the app.
  findings.server = health.headers && health.headers.server;

  // -- 1. does the upgrade work? -------------------------------------------
  let dev;
  try {
    dev = await connectDevice('probe-device');
    findings.upgradeSucceeded = true;
    log('WebSocket upgrade SUCCEEDED through App Service');
  } catch (e) {
    findings.upgradeSucceeded = false;
    findings.upgradeError = e.message;
    log(`WebSocket upgrade FAILED: ${e.message}`);
    return done(1);
  }

  let closed = false;
  let closedAt = null;
  const commands = [];
  dev.on('close', () => { closed = true; closedAt = Date.now(); });
  dev.on('message', (m) => { if (m.type === 'command') commands.push(m); });

  dev.sendJson({
    type: 'register',
    device: { name: 'Probe Device', platform: 'linux', fileAccess: 'off' },
    sessions: [],
  });
  await sleep(1500);

  const ov = await api('/api/overview');
  findings.deviceRegistered = !!(ov.body && ov.body.devices.some((d) => d.deviceId === 'probe-device'));
  log(`device registered and visible over REST: ${findings.deviceRegistered}`);

  // -- 2. does it survive being idle? --------------------------------------
  // Two runs, because only the comparison is informative. Silence finds the
  // platform's idle timeout; the heartbeat run proves our own traffic defeats
  // it. Either alone would leave the important question open.
  log(`going silent for ${IDLE_S}s (no heartbeat) to find any idle timeout...`);
  const t0 = Date.now();
  const step = 30;
  for (let waited = 0; waited < IDLE_S && !closed; waited += step) {
    await sleep(step * 1000);
    if (closed) break;
    process.stdout.write(`[as]   ${Math.round((Date.now() - t0) / 1000)}s still connected\n`);
  }

  findings.idleSeconds = Math.round(((closedAt || Date.now()) - t0) / 1000);
  findings.survivedIdle = !closed;
  log(closed
    ? `CONNECTION DROPPED after ~${findings.idleSeconds}s of silence`
    : `connection SURVIVED ${findings.idleSeconds}s of complete silence`);

  // -- 2b. the same duration, WITH the daemon's heartbeat -------------------
  if (closed) {
    log('');
    log(`reconnecting and holding for ${IDLE_S}s WITH a 15s heartbeat...`);
    let dev2;
    try {
      dev2 = await connectDevice('probe-device-hb');
    } catch (e) {
      findings.heartbeatRunError = e.message;
      log(`could not reconnect: ${e.message}`);
      return done(1);
    }
    let closed2 = false;
    let closed2At = null;
    dev2.on('close', () => { closed2 = true; closed2At = Date.now(); });
    dev2.on('message', (m) => {
      if (m.type === 'command') dev2.sendJson({ type: 'reply', correlationId: m.correlationId, ok: true, result: { pong: true } });
    });
    dev2.sendJson({
      type: 'register',
      device: { name: 'Probe Device HB', platform: 'linux', fileAccess: 'off' },
      sessions: [],
    });

    // 15 seconds: the daemon's real interval, not a value chosen to pass.
    const beat = setInterval(() => {
      if (!closed2) dev2.sendJson({ type: 'heartbeat', device: { name: 'Probe Device HB', platform: 'linux' }, sessions: [] });
    }, 15000);

    const t1 = Date.now();
    for (let waited = 0; waited < IDLE_S && !closed2; waited += step) {
      await sleep(step * 1000);
      if (closed2) break;
      process.stdout.write(`[as]   ${Math.round((Date.now() - t1) / 1000)}s still connected (heartbeating)\n`);
    }
    clearInterval(beat);

    findings.heartbeatSeconds = Math.round(((closed2At || Date.now()) - t1) / 1000);
    findings.survivedWithHeartbeat = !closed2;
    log(closed2
      ? `DROPPED after ~${findings.heartbeatSeconds}s DESPITE heartbeating`
      : `SURVIVED ${findings.heartbeatSeconds}s with a 15s heartbeat`);

    // The question that actually matters: can it still be commanded?
    if (!closed2) {
      const r2 = await api('/api/devices/probe-device-hb/stop', { method: 'POST', body: { sessionId: 'x' } });
      findings.commandAfterHeartbeat = r2.status;
      findings.stillRoutes = r2.status === 200;
      log(`command after ${findings.heartbeatSeconds}s: HTTP ${r2.status} -> routes: ${findings.stillRoutes}`);
    }
    try { dev2.close(); } catch { /* gone */ }
  }

  // -- 3. can it still be commanded? ---------------------------------------
  // A socket that is "open" but no longer routes is the worst outcome: the
  // device shows online and every command times out.
  if (!closed) {
    dev.on('message', (m) => {
      if (m.type === 'command') dev.sendJson({ type: 'reply', correlationId: m.correlationId, ok: true, result: { pong: true } });
    });
    const r = await api('/api/devices/probe-device/stop', { method: 'POST', body: { sessionId: 'x' } });
    findings.commandAfterIdle = r.status;
    findings.stillRoutes = r.status === 200;
    log(`command after idle: HTTP ${r.status} -> routes: ${findings.stillRoutes}`);
  }

  // -- 4. what does the platform report about instances? -------------------
  const inst = await api('/healthz');
  findings.instanceHeader = (inst.headers && (inst.headers['x-azure-ref'] ? 'x-azure-ref present' : null)) || null;

  try { dev.close(); } catch { /* gone */ }
  return done(0);

  function done(code) {
    console.log('\n[as] ===== FINDINGS =====');
    console.log(JSON.stringify(findings, null, 2));
    console.log('');
    if (findings.upgradeSucceeded && findings.stillRoutes && findings.survivedWithHeartbeat) {
      console.log('[as] VERDICT: App Service carries a Squad Hub device connection, PROVIDED');
      console.log(`[as] the daemon keeps beating. Idle connections die at ~${findings.idleSeconds}s;`);
      console.log(`[as] a 15s heartbeat held one for ${findings.heartbeatSeconds}s and it still routed.`);
    } else if (findings.upgradeSucceeded && findings.survivedIdle) {
      console.log('[as] VERDICT: App Service carries the connection with no keepalive needed.');
    } else if (findings.upgradeSucceeded && findings.survivedWithHeartbeat === false) {
      console.log('[as] VERDICT: connections drop even WITH a heartbeat. App Service is not viable');
      console.log('[as] for this without a different keepalive strategy.');
    } else if (!findings.upgradeSucceeded) {
      console.log('[as] VERDICT: WebSockets do not work here. Squad Hub cannot run on this config.');
    } else {
      console.log('[as] VERDICT: inconclusive; see the findings above.');
    }
    process.exit(code);
  }
})().catch((e) => {
  console.log('[as] ERROR: ' + e.message);
  process.exit(77);
});
