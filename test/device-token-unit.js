#!/usr/bin/env node
'use strict';
/**
 * Device tokens: a credential that can be a device and NOTHING ELSE.
 *
 * Before this existed, `auth.verify()` was called identically for the browser
 * API and for the device WebSocket, so the token you gave a device was also a
 * token that could call `POST /api/devices/<your-laptop>/spawn`. Fine while it
 * sat on your own laptop; not fine once one is copied into a container in the
 * cloud, which is what running sessions on Azure Container Apps requires.
 *
 * The tests below are written so that REMOVING the refusal makes them fail.
 * A test that merely observes the happy path would let the security property
 * be deleted in silence, which is the failure mode worth guarding against.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the persisted device-token store. Without this the suite writes into
// the developer's real ~/.squad-hub and accumulates records there -- which it
// did, and which nothing noticed until the file was looked at.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devtok-'));
process.env.SQUAD_HUB_HOME = TEST_HOME;

const { Authenticator, MODES } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');
const { DeviceTokens, DeviceTokenError } = require('../src/service/device-token');
const { DeviceTokenStore } = require('../src/service/device-token-store');
const { WsConnection } = require('../src/service/ws');

let pass = 0; let fail = 0;
function check(name, fn) {
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}
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

function api(port, path, token, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body ? JSON.stringify(opts.body) : null;
    const req = http.request({
      // The stand-in listens on 127.0.0.1. Omitting `host` makes Node default
      // to `localhost`, which can resolve to ::1 -- and Happy Eyeballs (Node
      // 20+) quietly retries over IPv4 while Node 18 just gets ECONNREFUSED.
      host: '127.0.0.1',
      port, path, method: opts.method || 'GET',
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
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
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Open a device (or watcher) socket and report whether the upgrade was
 * accepted, what closed it if anything did, and every message that arrived.
 *
 * `opts.origin` sets the `Origin` header; omitted entirely (the default)
 * means NO header at all, which is the "daemon/CLI" case and must stay
 * distinct from an explicit empty value. `opts.host` overrides the `Host`
 * header the request carries, so a test can prove the hub's own-origin
 * derivation without relying on the loopback allowance covering it too.
 * `opts.sendAfterUpgrade`, if given, is sent as a JSON message right after
 * the handshake completes -- e.g. a `register` frame, so a test can show a
 * refused socket never gets to register rather than merely that it closed.
 *
 * `WsConnection` (the same class the server and `hub-link.js` use) parses
 * frames from here too: close code/reason land on `.closeCode`/`.closeReason`
 * exactly as they do server-side, so this reads the wire the same way
 * production code does rather than a second, test-only parser that could
 * disagree with it.
 */
function tryDeviceSocket(port, token, deviceId, role = 'device', opts = {}) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const path = `/ws?access_token=${encodeURIComponent(token)}&role=${role}&deviceId=${encodeURIComponent(deviceId)}`;
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' };
    if (opts.origin !== undefined) headers.Origin = opts.origin;
    if (opts.host) headers.Host = opts.host;
    const req = http.request({ host: '127.0.0.1', port, path, headers });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on('upgrade', (res, socket, head) => {
      const conn = new WsConnection(socket);
      const messages = [];
      conn.on('message', (m) => messages.push(m));
      if (head && head.length) conn._onData(head);
      if (opts.sendAfterUpgrade) conn.sendJson(opts.sendAfterUpgrade);
      setTimeout(() => {
        const result = {
          upgraded: true,
          closedCode: conn.closeCode || null,
          closedReason: conn.closeReason || null,
          messages,
        };
        try { socket.destroy(); } catch { /* gone */ }
        done(result);
      }, 250);
    });
    req.on('response', (res) => done({ upgraded: false, status: res.statusCode, messages: [] }));
    req.on('error', (e) => done({ upgraded: false, error: e.message, messages: [] }));
    req.end();
  });
}

(async () => {
  const KEY = 'partition-abc';

  // ---- the token itself ---------------------------------------------------
  const dt = new DeviceTokens({ secret: 'test-device-secret' });

  check('a minted token verifies and carries its partition', () => {
    const t = dt.mint({ key: KEY, name: 'laptop' });
    const c = dt.verify(t);
    assert.strictEqual(c.key, KEY);
    assert.strictEqual(c.kind, 'device');
    assert.ok(c.jti, 'no id, so this token could never be revoked individually');
  });

  check('a token signed with a different secret is refused', () => {
    const other = new DeviceTokens({ secret: 'not-the-same' });
    const t = other.mint({ key: KEY });
    assert.throws(() => dt.verify(t), /signature is invalid/);
  });

  check('a tampered payload is refused rather than throwing', () => {
    // timingSafeEqual throws on a length mismatch; unhandled, that surfaces as
    // a 500 and, worse, as an unhandled rejection.
    const t = dt.mint({ key: KEY });
    const [p, body, sig] = t.split('.');
    assert.throws(() => dt.verify(`${p}.${body}.short`), DeviceTokenError);
    assert.throws(() => dt.verify(`${p}.${Buffer.from('{"kind":"device","key":"evil"}').toString('base64url')}.${sig}`), DeviceTokenError);
    assert.throws(() => dt.verify('sqhd1.only-two-parts'), DeviceTokenError);
    assert.throws(() => dt.verify(''), DeviceTokenError);
    assert.throws(() => dt.verify(null), DeviceTokenError);
  });

  check('an expired token is refused', () => {
    // Expiry is the substitute for instant revocation. If it does not bite,
    // a leaked job credential is good forever.
    const t = dt.mint({ key: KEY, ttlMs: -1 });
    assert.throws(() => dt.verify(t), /expired/);
  });

  check('a device-id binding restricts what may be registered', () => {
    const c = dt.verify(dt.mint({ key: KEY, didPrefix: 'aca-' }));
    assert.strictEqual(DeviceTokens.allowsDeviceId(c, 'aca-exec-123'), true);
    assert.strictEqual(DeviceTokens.allowsDeviceId(c, 'laptop'), false,
      'a token minted for cloud jobs could claim to be the laptop');
    assert.strictEqual(DeviceTokens.allowsDeviceId(c, ''), false);
  });

  check('an unbound token may register anything in its own partition', () => {
    const c = dt.verify(dt.mint({ key: KEY }));
    assert.strictEqual(DeviceTokens.allowsDeviceId(c, 'anything'), true);
  });

  check('a device token is recognisable without doing any crypto', () => {
    // So a github-mode hub does not spend a GitHub rate-limit call to be told
    // something it could see from the first six characters.
    assert.strictEqual(DeviceTokens.looksLikeDeviceToken(dt.mint({ key: KEY })), true);
    assert.strictEqual(DeviceTokens.looksLikeDeviceToken('gho_abc'), false);
    assert.strictEqual(DeviceTokens.looksLikeDeviceToken('eyJhbGciOi'), false);
    assert.strictEqual(DeviceTokens.looksLikeDeviceToken(undefined), false);
  });

  check('the label survives to the device, so it can name itself what you called it', () => {
    // "What is it for?" in the Connect a device dialog is the name someone
    // expects to find in the roster afterwards. It rides along in the token,
    // and used to be read by nobody -- so a machine labelled "bs-minidesktop"
    // showed up under a hostname, and the label appeared nowhere at all.
    //
    // Unverified on purpose: only the hub holds the signing secret, so a
    // device cannot check its own credential. It is used for a DISPLAY NAME
    // and nothing else, and the hub still verifies the signature before the
    // device may register -- so a forged label buys an attacker a label.
    const tok = dt.mint({ key: KEY, label: 'bs-minidesktop', name: 'bs-minidesktop' });
    const claims = DeviceTokens.unverifiedClaims(tok);
    assert.strictEqual(claims.label, 'bs-minidesktop');
  });

  check('an unreadable token yields no claims rather than throwing', () => {
    // It runs before anything is validated, on whatever someone pasted.
    assert.strictEqual(DeviceTokens.unverifiedClaims('sqhd1.not-base64!.sig'), null);
    assert.strictEqual(DeviceTokens.unverifiedClaims('sqhd1.only-two-parts'), null);
    assert.strictEqual(DeviceTokens.unverifiedClaims('gho_abc'), null);
    assert.strictEqual(DeviceTokens.unverifiedClaims(undefined), null);
  });

  check('an ephemeral secret is reported, not hidden', () => {
    // Tokens minted with a generated secret die on restart. Someone should be
    // told that rather than discovering it when a device silently drops off.
    assert.strictEqual(new DeviceTokens({}).ephemeral, true);
    assert.strictEqual(new DeviceTokens({ secret: 'x' }).ephemeral, false);
  });

  // ---- the same token, through the service --------------------------------
  const auth = new Authenticator({
    mode: MODES.DEV, devSecret: 'user-secret', deviceSecret: 'test-device-secret',
  });
  const svc = new HubService({ auth });
  const addr = await svc.listen(0, '127.0.0.1');
  const port = addr.port;

  const userToken = auth.mintDevToken('t1', 'u1', 'a person');
  const me = await api(port, '/api/me', userToken);
  const partition = me.body.subject;
  const deviceToken = auth.mintDeviceToken({ key: partition, name: 'cloud', label: 'aca' });
  const boundToken = auth.mintDeviceToken({ key: partition, didPrefix: 'aca-', label: 'aca jobs' });

  await checkAsync('a person can still use the API', () => {
    assert.strictEqual(me.status, 200, 'the ordinary path broke');
  });

  // THE SECURITY PROPERTY.
  await checkAsync('a device token CANNOT read the API', async () => {
    for (const p of ['/api/me', '/api/overview', '/api/devices', '/api/sessions']) {
      const r = await api(port, p, deviceToken);
      assert.strictEqual(r.status, 403, `${p} answered ${r.status} to a device token`);
    }
  });

  await checkAsync('a device token CANNOT spawn work on another device', async () => {
    // The escalation this whole feature exists to stop: a credential shipped to
    // a cloud container must not be able to run a command on the laptop.
    const r = await api(port, '/api/devices/laptop/spawn', deviceToken, {
      method: 'POST', body: { prompt: 'rm -rf /' },
    });
    assert.strictEqual(r.status, 403,
      'a device token could ask another device to run a command');
  });

  await checkAsync('a device token CANNOT erase another device\'s session history', async () => {
    // The same escalation wearing a tidier hat. A leaked job secret that can
    // wipe the record of what ran on your laptop is a leaked job secret that
    // can cover its own tracks.
    const r = await api(port, '/api/devices/laptop/forget', deviceToken, {
      method: 'POST', body: { olderThanMs: 0 },
    });
    assert.strictEqual(r.status, 403,
      'a device token could erase the session history of another device');
  });

  await checkAsync('the refusal says why, and is 403 rather than 401', async () => {
    // 401 sends someone hunting for a token problem they do not have.
    const r = await api(port, '/api/me', deviceToken);
    assert.strictEqual(r.status, 403);
    assert.match(r.body.error || '', /device token/i);
  });

  await checkAsync('a device token CAN attach as a device', async () => {
    const r = await tryDeviceSocket(port, deviceToken, 'cloud-1');
    assert.strictEqual(r.upgraded, true, `the device socket was refused: ${JSON.stringify(r)}`);
    assert.strictEqual(r.closedCode, null, `attached and was then closed with ${r.closedCode}`);
  });

  await checkAsync('a device token CANNOT open a watcher socket', async () => {
    // A watcher receives the live event stream -- every session, prompt and
    // approval. Allowing it would give back most of what the API refusal
    // protects.
    const r = await tryDeviceSocket(port, deviceToken, 'cloud-1', 'watcher');
    const denied = !r.upgraded || r.closedCode === 1008;
    assert.ok(denied, `a device token opened a watcher socket: ${JSON.stringify(r)}`);
  });

  await checkAsync('a bound token cannot register a device outside its prefix', async () => {
    const ok = await tryDeviceSocket(port, boundToken, 'aca-exec-9');
    assert.strictEqual(ok.upgraded, true, 'the token could not register its own prefix');
    assert.strictEqual(ok.closedCode, null);

    const bad = await tryDeviceSocket(port, boundToken, 'laptop');
    const denied = !bad.upgraded || bad.closedCode === 1008;
    assert.ok(denied, `a job token claimed the laptop device slot: ${JSON.stringify(bad)}`);
  });

  await checkAsync('an expired device token cannot attach', async () => {
    const dead = auth.mintDeviceToken({ key: partition, ttlMs: -1 });
    const r = await tryDeviceSocket(port, dead, 'cloud-2');
    assert.strictEqual(r.upgraded, false, 'an expired token still attached');
  });

  await checkAsync('a revoked device token is refused everywhere', async () => {
    // The store itself is a separate sprint; what is proven here is that the
    // hook is actually consulted, so wiring a store to it will work.
    const revoked = auth.mintDeviceToken({ key: partition, label: 'doomed' });
    const claims = auth.deviceTokens.verify(revoked);
    const prior = auth.isDeviceTokenRevoked;
    auth.isDeviceTokenRevoked = (jti) => jti === claims.jti;
    try {
      const sock = await tryDeviceSocket(port, revoked, 'cloud-3');
      assert.strictEqual(sock.upgraded, false, 'a revoked token still attached');
      const still = await tryDeviceSocket(port, deviceToken, 'cloud-4');
      assert.strictEqual(still.upgraded, true, 'revoking one token killed the others');
    } finally { auth.isDeviceTokenRevoked = prior; }
  });

  await checkAsync('device tokens work in github mode without calling GitHub', async () => {
    // They are the hub's own credential, not a reinterpretation of GitHub's.
    // If this ever routed to GitHub it would burn rate limit to be told
    // something the first six characters already said.
    let calledGitHub = false;
    const gh = new Authenticator({
      mode: MODES.GITHUB,
      deviceSecret: 'test-device-secret',
      githubFetch: async () => { calledGitHub = true; throw new Error('should not be reached'); },
    });
    const p = await gh.verify(`Bearer ${dt.mint({ key: 'ghkey', name: 'cloud' })}`);
    assert.strictEqual(p.kind, 'device');
    assert.strictEqual(p.key, 'ghkey');
    assert.strictEqual(calledGitHub, false, 'a device token was sent to GitHub');
  });

  await checkAsync('a device principal is never an owner', async () => {
    // Owner status grants reach. A device must not inherit it from the person
    // who minted its token.
    const ownerAuth = new Authenticator({
      mode: MODES.DEV, devSecret: 's', deviceSecret: 'test-device-secret', owner: ['boss'],
    });
    const p = await ownerAuth.verify(`Bearer ${dt.mint({ key: 'k', name: 'boss' })}`);
    assert.strictEqual(p.isOwner, false, 'a device token inherited owner status');
  });

  await checkAsync('a hub with device tokens disabled refuses them outright', async () => {
    const off = new Authenticator({ mode: MODES.DEV, devSecret: 's', deviceTokens: false });
    await assert.rejects(() => off.verify(`Bearer ${dt.mint({ key: 'k' })}`), /not enabled/);
  });

  // ---- minting ------------------------------------------------------------
  await checkAsync('a person can mint a device token for their own partition', async () => {
    const r = await api(port, '/api/device-tokens', userToken, {
      method: 'POST', body: { label: 'aca jobs', didPrefix: 'aca-', ttlHours: 4 },
    });
    assert.strictEqual(r.status, 201, `minting failed: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.token, 'no token came back');
    const claims = auth.deviceTokens.verify(r.body.token);
    assert.strictEqual(claims.key, partition, 'the token was minted for the wrong partition');
    assert.strictEqual(claims.did, 'aca-');
  });

  await checkAsync('a minted token cannot be read back afterwards', async () => {
    // The hub keeps no copy, so the listing must expose metadata and never the
    // credential. A "show me that token again" endpoint would recreate exactly
    // the store this design avoids.
    const r = await api(port, '/api/device-tokens', userToken);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.tokens.length > 0, 'nothing was recorded, so nothing could be revoked later');
    for (const t of r.body.tokens) {
      assert.ok(t.jti, 'a record with no id could never be revoked');
      assert.strictEqual(JSON.stringify(t).includes('sqhd1.'), false, 'the listing leaked a token');
    }
  });

  await checkAsync('the partition comes from the caller, never the request', async () => {
    // The security-relevant bit: there is no request shape that mints a
    // credential into somebody else's hub view.
    const r = await api(port, '/api/device-tokens', userToken, {
      method: 'POST', body: { label: 'x', key: 'someone-elses-partition', sub: 'evil' },
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(auth.deviceTokens.verify(r.body.token).key, partition,
      'a request body chose the partition');
  });

  await checkAsync('an unbounded lifetime is refused', async () => {
    // Expiry is what makes a leaked cloud credential self-limiting. Letting a
    // caller ask for ten years would make it decorative.
    const tooLong = await api(port, '/api/device-tokens', userToken, {
      method: 'POST', body: { label: 'forever', ttlHours: 24 * 365 },
    });
    assert.strictEqual(tooLong.status, 400, 'a one-year device token was issued');
    for (const bad of [0, -5, 'soon', NaN]) {
      const r = await api(port, '/api/device-tokens', userToken, {
        method: 'POST', body: { label: 'bad', ttlHours: bad },
      });
      assert.strictEqual(r.status, 400, `ttlHours ${bad} was accepted`);
    }
  });

  await checkAsync('a device token cannot mint another device token', async () => {
    // Otherwise the expiry and the prefix binding are both escapable: a job
    // token could mint itself an unbound, longer-lived one.
    const r = await api(port, '/api/device-tokens', deviceToken, {
      method: 'POST', body: { label: 'escalation' },
    });
    assert.strictEqual(r.status, 403, 'a device token minted another credential');
  });

  await checkAsync('one person cannot see another person s device tokens', async () => {
    const other = auth.mintDevToken('t2', 'u2', 'somebody else');
    const mine = await api(port, '/api/device-tokens', userToken);
    const theirs = await api(port, '/api/device-tokens', other);
    assert.ok(mine.body.tokens.length > 0);
    assert.strictEqual(theirs.body.tokens.length, 0, 'device tokens leaked across partitions');
  });

  await checkAsync('a minted token actually works as a device', async () => {
    // End to end rather than in pieces: mint through the API, then attach with
    // what came back.
    const r = await api(port, '/api/device-tokens', userToken, {
      method: 'POST', body: { label: 'real', didPrefix: 'job-' },
    });
    const ok = await tryDeviceSocket(port, r.body.token, 'job-1');
    assert.strictEqual(ok.upgraded, true, 'a freshly minted token could not attach');
    assert.strictEqual(ok.closedCode, null, `attached then closed with ${ok.closedCode}`);
  });

  await checkAsync('a refused device is told WHY, not just closed', async () => {
    // A close with no reason leaves someone unable to tell "the hub restarted"
    // from "your token may not register that id" -- and a client that cannot
    // tell reconnects forever against a refusal it will never satisfy.
    const r = await api(port, '/api/device-tokens', userToken, {
      method: 'POST', body: { label: 'bound', didPrefix: 'only-' },
    });
    const bad = await tryDeviceSocket(port, r.body.token, 'something-else');
    assert.strictEqual(bad.closedCode, 1008, `expected a policy close, saw ${bad.closedCode}`);
    assert.match(bad.closedReason || '', /device id/i,
      `the refusal carried no usable reason: "${bad.closedReason}"`);
  });

  // ---- WS-1: Origin validation on the WebSocket upgrade -------------------
  //
  // The check must run BEFORE role branching or registration, on BOTH the
  // device and watcher paths -- see hub-service.js originIsAllowed(). Each
  // case below mints its own fresh partition, so "the roster is empty"
  // (or "contains exactly this one device") is a real assertion rather than
  // one that happens to hold because nothing else used this partition yet.
  const originUser = auth.mintDevToken('ws1-tenant', 'ws1-user', 'origin test');
  const originMe = await api(port, '/api/me', originUser);
  const originPartition = originMe.body.subject;
  const originDeviceToken = auth.mintDeviceToken({ key: originPartition, name: 'origin-test-device' });

  async function devicesIn(userTok) {
    const r = await api(port, '/api/devices', userTok);
    assert.strictEqual(r.status, 200, `could not read the roster: ${JSON.stringify(r.body)}`);
    return r.body.devices;
  }

  await checkAsync('a foreign Origin is refused, and the device it tried to register never appears in the roster', async () => {
    const r = await tryDeviceSocket(port, originDeviceToken, 'foreign-origin-device', 'device', {
      origin: 'https://evil.example',
      sendAfterUpgrade: { type: 'register', device: { name: 'evil', platform: 'linux' } },
    });
    assert.strictEqual(r.closedCode, 1008, `a foreign Origin was not refused: ${JSON.stringify(r)}`);
    assert.match(r.closedReason || '', /origin/i, `the refusal did not name Origin: "${r.closedReason}"`);
    const devices = await devicesIn(originUser);
    assert.deepStrictEqual(devices.map((d) => d.deviceId), [],
      'a device registered over a socket that should have been refused for its Origin');
  });

  await checkAsync('Origin: null is refused, not treated as an allowed origin', async () => {
    // A sandboxed iframe or a file:// page sends the literal string "null" --
    // distinct from sending no header at all -- and it must not be waved
    // through as if it were absent.
    const r = await tryDeviceSocket(port, originDeviceToken, 'null-origin-device', 'device', {
      origin: 'null',
      sendAfterUpgrade: { type: 'register', device: { name: 'evil', platform: 'linux' } },
    });
    assert.strictEqual(r.closedCode, 1008, `"Origin: null" was not refused: ${JSON.stringify(r)}`);
    const devices = await devicesIn(originUser);
    assert.deepStrictEqual(devices.map((d) => d.deviceId), [],
      'a device registered over a socket sending Origin: null');
  });

  await checkAsync('a malformed Origin is refused rather than crashing the upgrade', async () => {
    const r = await tryDeviceSocket(port, originDeviceToken, 'malformed-origin-device', 'device', {
      origin: 'not a url at all',
    });
    assert.strictEqual(r.closedCode, 1008, `a malformed Origin was not refused: ${JSON.stringify(r)}`);
  });

  await checkAsync('a same-origin socket still attaches and registers', async () => {
    const r = await tryDeviceSocket(port, originDeviceToken, 'same-origin-device', 'device', {
      origin: `http://127.0.0.1:${port}`,
      sendAfterUpgrade: { type: 'register', device: { name: 'laptop', platform: 'linux' } },
    });
    assert.strictEqual(r.upgraded, true, `a same-origin socket was refused: ${JSON.stringify(r)}`);
    assert.strictEqual(r.closedCode, null, `a same-origin socket was closed: ${r.closedCode} ${r.closedReason}`);
    const devices = await devicesIn(originUser);
    assert.deepStrictEqual(devices.map((d) => d.deviceId), ['same-origin-device'],
      'a same-origin socket did not register its device');
  });

  await checkAsync("the hub's own derived origin is accepted off loopback too, not just via the loopback allowance", async () => {
    // Exercised on a Host that is NOT in the loopback allowlist, so this
    // proves selfOrigin()'s own scheme+Host comparison, rather than every
    // other test here being able to pass on the loopback branch alone.
    const r = await tryDeviceSocket(port, originDeviceToken, 'custom-host-device', 'device', {
      host: 'hub.internal.example:4242',
      origin: 'http://hub.internal.example:4242',
      sendAfterUpgrade: { type: 'register', device: { name: 'custom-host', platform: 'linux' } },
    });
    assert.strictEqual(r.upgraded, true, `a matching derived origin was refused: ${JSON.stringify(r)}`);
    assert.strictEqual(r.closedCode, null, `closed with ${r.closedCode} ${r.closedReason}`);
    const devices = await devicesIn(originUser);
    assert.ok(devices.some((d) => d.deviceId === 'custom-host-device'),
      'a socket whose Origin matched its own request Host did not register');
  });

  await checkAsync('localhost and [::1] are accepted as loopback, any port', async () => {
    for (const origin of ['http://localhost:9999', 'http://[::1]:9999']) {
      const r = await tryDeviceSocket(port, originDeviceToken, `loopback-dev-${origin.replace(/\W+/g, '-')}`, 'device', { origin });
      assert.strictEqual(r.upgraded, true, `${origin} was refused: ${JSON.stringify(r)}`);
      assert.strictEqual(r.closedCode, null, `${origin} was closed: ${r.closedCode}`);
    }
  });

  await checkAsync('a CLI client with no Origin header at all still attaches and registers', async () => {
    // hub-link.js -- the daemon's own client -- sends no Origin header at
    // all. This must be the one client the check never breaks.
    const r = await tryDeviceSocket(port, originDeviceToken, 'no-origin-device', 'device', {
      sendAfterUpgrade: { type: 'register', device: { name: 'daemon', platform: 'linux' } },
    });
    assert.strictEqual(r.upgraded, true, `a socket with no Origin header was refused: ${JSON.stringify(r)}`);
    assert.strictEqual(r.closedCode, null, `closed with ${r.closedCode} ${r.closedReason}`);
    const devices = await devicesIn(originUser);
    assert.ok(devices.some((d) => d.deviceId === 'no-origin-device'),
      'a socket with no Origin header did not register');
  });

  await checkAsync('the Origin check runs before the role branch: a foreign-Origin watcher is refused and never receives the overview', async () => {
    const r = await tryDeviceSocket(port, originUser, 'unused', 'watcher', {
      origin: 'https://evil.example',
    });
    assert.strictEqual(r.closedCode, 1008, `a foreign-Origin watcher was not refused: ${JSON.stringify(r)}`);
    assert.deepStrictEqual(r.messages, [],
      'a refused watcher still received a message -- the Origin check ran after the watcher was already attached');
  });

  await checkAsync('a same-origin watcher still attaches and receives the overview', async () => {
    const r = await tryDeviceSocket(port, originUser, 'unused', 'watcher', {
      origin: `http://127.0.0.1:${port}`,
    });
    assert.strictEqual(r.closedCode, null, `a same-origin watcher was closed: ${r.closedCode} ${r.closedReason}`);
    assert.ok(r.messages.some((m) => m.type === 'overview'),
      'a same-origin watcher never received the overview it is owed');
  });

  // ---- persistence and revocation (B3) ------------------------------------
  await checkAsync('the suite is NOT writing to the real home directory', async () => {
    // It was. Nothing noticed until the file was looked at, so this asserts it
    // from now on: a test that pollutes the developer's machine is a test that
    // will eventually be debugged as a product bug.
    assert.ok(String(TEST_HOME).includes(os.tmpdir().split(path.sep).pop()) || TEST_HOME.startsWith(os.tmpdir()),
      `tests are persisting to ${TEST_HOME}`);
    const real = path.join(os.homedir(), '.squad-hub', 'device-tokens.json');
    assert.strictEqual(fs.existsSync(real), false, `the suite wrote to ${real}`);
  });

  await checkAsync('a revocation survives a restart', async () => {
    // The whole point of persisting anything. Revocation that forgets is not
    // revocation -- you would believe a credential was dead while it was live.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-'));
    const s1 = new DeviceTokenStore({ dir });
    s1.record('k', { jti: 'j1', label: 'x', expiresAt: Date.now() + 3600000 });
    s1.revoke('k', 'j1');

    const s2 = new DeviceTokenStore({ dir });   // a genuinely fresh instance
    assert.strictEqual(s2.isRevoked('j1'), true, 'the revocation was lost on restart');
    assert.strictEqual(s2.list('k')[0].revoked, true, 'the listing forgot it was revoked');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await checkAsync('a transient Windows file lock is retried without losing atomicity', async () => {
    // Defender/indexing can briefly lock the destination and make rename
    // return EPERM. This happened in the full suite. The store must retry the
    // atomic rename, never delete the old file first.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revlock-'));
    const realRename = fs.renameSync;
    let calls = 0;
    fs.renameSync = (...args) => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('simulated Windows lock'), { code: 'EPERM' });
      return realRename(...args);
    };
    try {
      const s = new DeviceTokenStore({ dir });
      s.record('k', { jti: 'locked', expiresAt: Date.now() + 3600000 });
      assert.strictEqual(calls, 3, `expected two retries, got ${calls} rename attempt(s)`);
      const after = new DeviceTokenStore({ dir });
      assert.strictEqual(after.list('k')[0].jti, 'locked',
        'the write reported success but did not survive a reload');
    } finally {
      fs.renameSync = realRename;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await checkAsync('AN UNREADABLE STORE REFUSES EVERY DEVICE TOKEN', async () => {
    // Fail closed. A store that fails OPEN is worse than none at all.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revbroken-'));
    fs.writeFileSync(path.join(dir, 'device-tokens.json'), '{ not json');
    const s = new DeviceTokenStore({ dir });
    assert.strictEqual(s.ok, false, 'a corrupt store loaded successfully');
    assert.strictEqual(s.isRevoked('anything-at-all'), true,
      'FAILED OPEN: a revoked credential would have been accepted as live');
    assert.throws(() => s.revoke('k', 'j'), /did not load/,
      'writing over an unreadable store would destroy every revocation in it');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await checkAsync('a hub that has revoked nothing still works', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revempty-'));
    const s = new DeviceTokenStore({ dir });
    assert.strictEqual(s.ok, true, 'a missing file was treated as an error');
    assert.strictEqual(s.isRevoked('x'), false, 'everything was refused; the hub is bricked');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await checkAsync('revoking a token stops it attaching, immediately', async () => {
    const r = await api(port, '/api/device-tokens', userToken, {
      method: 'POST', body: { label: 'doomed' },
    });
    const live = await tryDeviceSocket(port, r.body.token, 'doomed-1');
    assert.strictEqual(live.upgraded, true, 'the token did not work before revocation');

    const del = await api(port, `/api/device-tokens/${encodeURIComponent(r.body.jti)}`, userToken, { method: 'DELETE' });
    assert.strictEqual(del.status, 200, `revoke failed: ${JSON.stringify(del.body)}`);

    const dead = await tryDeviceSocket(port, r.body.token, 'doomed-2');
    assert.strictEqual(dead.upgraded, false, 'a revoked token still attached');

    const api2 = await api(port, '/api/me', r.body.token);
    assert.strictEqual(api2.status, 401, 'a revoked token was still authenticated');
  });

  await checkAsync('revoking one token does not disturb the others', async () => {
    const keep = await api(port, '/api/device-tokens', userToken, { method: 'POST', body: { label: 'keep' } });
    const drop = await api(port, '/api/device-tokens', userToken, { method: 'POST', body: { label: 'drop' } });
    await api(port, `/api/device-tokens/${encodeURIComponent(drop.body.jti)}`, userToken, { method: 'DELETE' });
    const still = await tryDeviceSocket(port, keep.body.token, 'keep-1');
    assert.strictEqual(still.upgraded, true, 'revoking one token killed another');
  });

  await checkAsync('one person cannot revoke another person s token', async () => {
    const mine = await api(port, '/api/device-tokens', userToken, { method: 'POST', body: { label: 'mine' } });
    const other = auth.mintDevToken('t9', 'u9', 'somebody else');
    const attempt = await api(port, `/api/device-tokens/${encodeURIComponent(mine.body.jti)}`, other, { method: 'DELETE' });
    assert.strictEqual(attempt.status, 404, 'someone else revoked my device token');
    const still = await tryDeviceSocket(port, mine.body.token, 'mine-1');
    assert.strictEqual(still.upgraded, true, 'the token was revoked by someone else after all');
  });

  await checkAsync('a device token cannot revoke anything', async () => {
    const victim = await api(port, '/api/device-tokens', userToken, { method: 'POST', body: { label: 'victim' } });
    const r = await api(port, `/api/device-tokens/${encodeURIComponent(victim.body.jti)}`, deviceToken, { method: 'DELETE' });
    assert.strictEqual(r.status, 403, 'a device token revoked a credential');
  });

  await checkAsync('the store says when it cannot persist', async () => {
    // A hub that will forget its revocations on restart must say so, rather
    // than letting someone believe a revocation is durable when it is not.
    const r = await api(port, '/api/device-tokens', userToken);
    assert.strictEqual(typeof r.body.durable, 'boolean', 'no way to know whether revocation survives');
  });

  await checkAsync('expired records are dropped so the file cannot grow forever', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revprune-'));
    const s = new DeviceTokenStore({ dir });
    s.record('k', { jti: 'old', expiresAt: Date.now() - 1000 });
    s.record('k', { jti: 'new', expiresAt: Date.now() + 3600000 });
    const ids = s.list('k').map((t) => t.jti);
    assert.deepStrictEqual(ids, ['new'], `expected only the live record, saw ${ids.join(', ')}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await checkAsync('enforcement refuses a user credential as a device credential', async () => {
    // The end state, and it must be opt-in: turning it on disconnects every
    // device still using the old credential, which is the point but should be
    // a decision rather than a surprise.
    const strictAuth = new Authenticator({
      mode: MODES.DEV, devSecret: 'user-secret', deviceSecret: 'test-device-secret',
      requireDeviceTokens: true,
    });
    const strict = new HubService({ auth: strictAuth, deviceTokenDir: TEST_HOME });
    const a2 = await strict.listen(0, '127.0.0.1');
    try {
      const u = strictAuth.mintDevToken('t1', 'u1', 'a person');
      const meR = await api(a2.port, '/api/me', u);
      const dTok = strictAuth.mintDeviceToken({ key: meR.body.subject, label: 'ok' });

      const refused = await tryDeviceSocket(a2.port, u, 'laptop');
      const denied = !refused.upgraded || refused.closedCode === 1008;
      assert.ok(denied, 'a user credential still registered a device under enforcement');

      const allowed = await tryDeviceSocket(a2.port, dTok, 'laptop');
      assert.strictEqual(allowed.upgraded, true, 'a device token was refused under enforcement');
      assert.strictEqual(allowed.closedCode, null);

      // A person must still be able to USE the hub; enforcement is about
      // device registration, not about locking the owner out of the browser.
      assert.strictEqual((await api(a2.port, '/api/me', u)).status, 200,
        'enforcement locked the person out of their own hub');
    } finally { await strict.close(); }
  });

  await checkAsync('enforcement is off unless it is asked for', async () => {
    const relaxed = new Authenticator({ mode: MODES.DEV, devSecret: 's', deviceSecret: 'd' });
    assert.strictEqual(relaxed.requireDeviceTokens, false,
      'existing deployments would break on upgrade');
  });

  await svc.close();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`ERROR: ${e.message}`); console.log(e.stack); process.exit(1); });
