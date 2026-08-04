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

const { Authenticator, MODES } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');
const { DeviceTokens, DeviceTokenError } = require('../src/service/device-token');

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

/** Open a device socket and report whether the upgrade was accepted. */
function tryDeviceSocket(port, token, deviceId, role = 'device') {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const path = `/ws?access_token=${encodeURIComponent(token)}&role=${role}&deviceId=${encodeURIComponent(deviceId)}`;
    const req = http.request({
      port, path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on('upgrade', (res, socket, head) => {
      // The upgrade may be accepted and then closed immediately by policy, so
      // report what actually happened rather than that bytes were accepted.
      //
      // The close frame can arrive in `head` -- Node hands over whatever was
      // already buffered when the upgrade completed -- so it must be inspected
      // as well as the later 'data' events. Reading only 'data' made a refused
      // socket look accepted.
      let closedCode = null;
      let closedReason = null;
      const scan = (buf) => {
        if (buf && buf.length >= 4 && (buf[0] & 0x0f) === 0x8) {
          closedCode = buf.readUInt16BE(2);
          closedReason = buf.length > 4 ? buf.subarray(4).toString('utf8') : '';
        }
      };
      scan(head);
      socket.on('data', scan);
      setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } done({ upgraded: true, closedCode, closedReason }); }, 250);
    });
    req.on('response', (res) => done({ upgraded: false, status: res.statusCode }));
    req.on('error', (e) => done({ upgraded: false, error: e.message }));
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
    auth.isDeviceTokenRevoked = (jti) => jti === claims.jti;
    try {
      const sock = await tryDeviceSocket(port, revoked, 'cloud-3');
      assert.strictEqual(sock.upgraded, false, 'a revoked token still attached');
      const still = await tryDeviceSocket(port, deviceToken, 'cloud-4');
      assert.strictEqual(still.upgraded, true, 'revoking one token killed the others');
    } finally { auth.isDeviceTokenRevoked = null; }
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

  await svc.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`ERROR: ${e.message}`); console.log(e.stack); process.exit(1); });
