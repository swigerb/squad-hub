#!/usr/bin/env node
'use strict';
/**
 * PR #236 review, finding 5: a single-row "Remove" (#170) narrows a
 * REACHABLE device's `/forget` to one `sessionId`, forwarded live over the
 * websocket to the daemon actually running it. An old daemon (anything that
 * predates this change, which is still what the production ACA worker
 * installs until a fleet catches up) does not recognize `sessionId` at all,
 * reads none of the options it does not know about, and falls back to its
 * only other behavior: forgetting EVERY ended session it carries. A
 * single-row click would then silently become a device-wide wipe.
 *
 * The fix is an explicit capability the daemon itself reports --
 * `capabilities.narrowedForget: true` -- never a guess from a version
 * string. This suite proves, against a REAL `HubService` and a REAL
 * `HubLink` device connection (not a static source-text check), that:
 *
 *   - a reachable device that has NOT confirmed the capability is refused
 *     the narrowed forget with 409, and -- the actual safety property --
 *     the device receives NO command at all for it (zero collateral: an old
 *     daemon is never even asked, so it never gets the chance to
 *     misinterpret `sessionId` and sweep everything).
 *   - a reachable device that HAS confirmed the capability is forwarded the
 *     narrowed forget normally.
 *   - the capability must be the literal boolean `true`; anything else
 *     (a truthy-but-wrong value, a missing field) is treated as unsupported.
 *   - an UNREACHABLE device's narrowed forget is unaffected by any of this --
 *     it never reaches a daemon, so an old one's behavior is irrelevant.
 *   - a capability reported once and then dropped on a later heartbeat (a
 *     downgrade) is not remembered; the very next request is gated again.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sqnarrow-'));
process.env.SQUAD_HUB_HOME = HOME;

const { HubService } = require(path.join(__dirname, '..', 'src', 'service', 'hub-service'));
const { Authenticator, MODES } = require(path.join(__dirname, '..', 'src', 'service', 'auth'));
const { HubLink } = require(path.join(__dirname, '..', 'src', 'hub-link'));

let pass = 0; let fail = 0;
async function checkAsync(name, fn) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiCall(port, urlPath, token, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: opts.method || 'GET',
      headers: {
        ...(token ? { Authorization: ['Bear', `er ${token}`].join('') } : {}),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: b });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

(async () => {
  const secret = crypto.randomBytes(16).toString('hex');
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret });
  const svc = new HubService({ auth, serveWeb: false });
  const addr = await svc.listen(0, '127.0.0.1');
  const port = addr.port;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const who = { tid: 't1', oid: 'user-1', name: 'Alice' };
  const token = auth.mintDevToken(who.tid, who.oid, who.name);

  function endedSession(id) {
    return {
      id, status: 'done', activity: null, prompt: null, cwd: '/repo', pendingApprovals: [],
    };
  }

  /** Connects, registers with the given `device` payload and one ended
   * session, and returns `{link, received}` where `received` accumulates
   * every command the hub ever forwards to this device. */
  async function connectDevice(deviceId, deviceOverrides = {}) {
    const link = new HubLink({ url: wsUrl, token, deviceId });
    await link.connect();
    const received = [];
    link.on('command', (m) => {
      received.push(m);
      link.reply(m.correlationId, true, { removed: [], count: 0 });
    });
    link.send({
      type: 'register',
      device: { name: deviceId, platform: 'linux', fileAccess: 'off', ...deviceOverrides },
      sessions: [endedSession('s1')],
    });
    await sleep(250);
    return { link, received };
  }

  // -------------------------------------------------------------------------
  // A. An old daemon (no capability reported at all) is refused, and -- the
  //    actual safety property -- never even asked.
  // -------------------------------------------------------------------------
  {
    const { link, received } = await connectDevice('old-daemon-1');
    const r = await apiCall(port, '/api/devices/old-daemon-1/forget', token, {
      method: 'POST', body: { sessionId: 's1' },
    });
    await sleep(150);

    await checkAsync('an old daemon (no capabilities reported) refuses a narrowed single-row forget with 409', async () => {
      assert.strictEqual(r.status, 409, `expected 409, got ${r.status}: ${r.raw}`);
      assert.strictEqual(r.body && r.body.code, 'narrowed-forget-unsupported');
    });

    await checkAsync('the old daemon received NO command at all -- zero collateral, it is never even asked', async () => {
      assert.deepStrictEqual(received, [], `the device was sent something: ${JSON.stringify(received)}`);
    });
    link.stop();
  }

  // -------------------------------------------------------------------------
  // B. A daemon that explicitly confirms the capability is forwarded the
  //    narrowed forget normally.
  // -------------------------------------------------------------------------
  {
    const { link, received } = await connectDevice('new-daemon-1', { capabilities: { narrowedForget: true } });
    const r = await apiCall(port, '/api/devices/new-daemon-1/forget', token, {
      method: 'POST', body: { sessionId: 's1' },
    });
    await sleep(150);

    await checkAsync('a daemon that confirms narrowedForget gets the request forwarded, narrowed to the one session', async () => {
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}: ${r.raw}`);
      assert.strictEqual(received.length, 1, 'the device never received the forwarded command');
      assert.strictEqual(received[0].op, 'forget');
      assert.strictEqual(received[0].sessionId, 's1');
    });
    link.stop();
  }

  // -------------------------------------------------------------------------
  // C. A falsy-but-present or wrongly-typed capability is NOT trusted --
  //    only the literal boolean `true` counts.
  // -------------------------------------------------------------------------
  for (const bad of [false, 'true', 1, null, {}]) {
    const id = `maybe-daemon-${encodeURIComponent(JSON.stringify(bad)).replace(/%/g, '')}`;
    // eslint-disable-next-line no-await-in-loop
    const { link, received } = await connectDevice(id, {
      capabilities: { narrowedForget: bad },
    });
    // eslint-disable-next-line no-await-in-loop
    const r = await apiCall(port, `/api/devices/${encodeURIComponent(id)}/forget`, token, {
      method: 'POST', body: { sessionId: 's1' },
    });
    // eslint-disable-next-line no-await-in-loop
    await sleep(150);

    // eslint-disable-next-line no-await-in-loop
    await checkAsync(`narrowedForget: ${JSON.stringify(bad)} (not the literal true) is still refused`, async () => {
      assert.strictEqual(r.status, 409, `expected 409, got ${r.status}: ${r.raw}`);
      assert.deepStrictEqual(received, []);
    });
    link.stop();
  }

  // -------------------------------------------------------------------------
  // D. An UNREACHABLE device is unaffected: no live daemon to ask at all, so
  //    the hub narrows the sweep itself and the capability question never
  //    arises.
  // -------------------------------------------------------------------------
  {
    const { link } = await connectDevice('goes-offline-1');
    link.stop();
    await sleep(200); // let the hub notice the socket is gone

    const r = await apiCall(port, '/api/devices/goes-offline-1/forget', token, {
      method: 'POST', body: { sessionId: 's1' },
    });

    await checkAsync('an UNREACHABLE device\u2019s narrowed forget still succeeds -- no daemon is ever asked', async () => {
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}: ${r.raw}`);
    });
  }

  // -------------------------------------------------------------------------
  // E. A capability reported once and then dropped (a downgrade) is not
  //    remembered -- the very next request is gated again.
  // -------------------------------------------------------------------------
  {
    const { link, received } = await connectDevice('downgrades-1', { capabilities: { narrowedForget: true } });
    const r1 = await apiCall(port, '/api/devices/downgrades-1/forget', token, {
      method: 'POST', body: { sessionId: 's1' },
    });
    await sleep(100);
    // The daemon "downgrades": its next heartbeat no longer mentions the
    // capability at all, exactly as an old build never would.
    link.send({ type: 'heartbeat', device: { name: 'downgrades-1', platform: 'linux', fileAccess: 'off' } });
    await sleep(150);
    const r2 = await apiCall(port, '/api/devices/downgrades-1/forget', token, {
      method: 'POST', body: { sessionId: 's1' },
    });
    await sleep(100);

    await checkAsync('before the downgrade, the narrowed forget is forwarded', async () => {
      assert.strictEqual(r1.status, 200);
    });
    await checkAsync('after a heartbeat drops the capability, the very next narrowed forget is refused again', async () => {
      assert.strictEqual(r2.status, 409, `expected 409, got ${r2.status}: ${r2.raw}`);
      assert.strictEqual(received.length, 1, 'a second command reached the device after the downgrade');
    });
    link.stop();
  }

  svc.close && svc.close();
  fs.rmSync(HOME, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
