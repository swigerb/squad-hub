'use strict';
/**
 * The Web Push subscription API (#175), over a real HTTP server.
 *
 * push-store-unit.js proves the store's rules; this proves the ROUTE applies
 * them to a real request from a real principal, the same shape
 * prefs-api-unit.js uses for /api/prefs: a user token works, a device token
 * is refused, partitioning holds across two users, and /api/me and /healthz
 * report push status honestly.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Authenticator, MODES } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');
const { generateVapidKeys } = require('../src/service/web-push');

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

const AUTH_SCHEME = 'Bearer';

function api(port, p, token, opts = {}) {
  return new Promise((resolve) => {
    const headers = {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    };
    if (token) headers.Authorization = [AUTH_SCHEME, token].join(' ');
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: opts.method || 'GET', headers,
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json, or empty 204 body */ }
        resolve({ status: res.statusCode, body: json, raw: b });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (opts.body !== undefined) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

function sub(n = 1) {
  return {
    endpoint: `https://push.example.invalid/wpush/v2/${n}`,
    keys: { p256dh: `p256dh-value-${n}`, auth: `auth-value-${n}` },
    label: `browser ${n}`,
  };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqh-push-api-'));
  const secret = crypto.randomBytes(16).toString('hex');
  const deviceSecret = crypto.randomBytes(16).toString('hex');

  const auth = new Authenticator({
    mode: MODES.DEV, devSecret: secret, deviceSecret, owner: ['swigerb'], allowedUsers: ['llowevad'],
  });
  const vapid = generateVapidKeys();
  const svc = new HubService({
    auth,
    serveWeb: false,
    pushDir: dir,
    persistPush: true,
    persistPrefs: false,
    persistAccess: false,
    persistStore: false,
    webPush: new (require('../src/service/web-push').WebPushSender)({ publicKey: vapid.publicKey, privateKey: vapid.privateKey }),
  });
  const addr = await svc.listen(0, '127.0.0.1');
  const { port } = addr;

  const aliceToken = auth.mintDevToken('local', 'swigerb', 'swigerb');
  const bobToken = auth.mintDevToken('local', 'llowevad', 'llowevad');
  const deviceToken = auth.mintDeviceToken({ key: 'whatever-partition', name: 'a cloud job' });

  // -- the three credentials the issue calls out explicitly -------------------

  const noToken = await api(port, '/api/push/subscriptions', null);
  check('no token gets 401', () => {
    assert.strictEqual(noToken.status, 401, JSON.stringify(noToken));
  });

  const deviceGet = await api(port, '/api/push/subscriptions', deviceToken);
  check('a device token gets 403 on GET (watcher-token only, per the issue)', () => {
    assert.strictEqual(deviceGet.status, 403, JSON.stringify(deviceGet));
  });

  const devicePost = await api(port, '/api/push/subscriptions', deviceToken, { method: 'POST', body: sub(1) });
  check('a device token gets 403 on POST, and nothing was stored', () => {
    assert.strictEqual(devicePost.status, 403, JSON.stringify(devicePost));
  });

  const deviceDelete = await api(port, '/api/push/subscriptions/whatever', deviceToken, { method: 'DELETE' });
  check('a device token gets 403 on DELETE', () => {
    assert.strictEqual(deviceDelete.status, 403, JSON.stringify(deviceDelete));
  });

  // -- /api/me reports push configuration honestly -----------------------------

  const me = await api(port, '/api/me', aliceToken);
  check('/api/me reports push is enabled with the configured public key, since VAPID keys are set', () => {
    assert.strictEqual(me.status, 200, JSON.stringify(me));
    assert.strictEqual(me.body.push.enabled, true);
    assert.strictEqual(me.body.push.publicKey, vapid.publicKey);
  });

  // -- a user token can list (empty), then subscribe ---------------------------

  const emptyList = await api(port, '/api/push/subscriptions', aliceToken);
  check('a user with no subscriptions gets an empty list, not an error', () => {
    assert.strictEqual(emptyList.status, 200, JSON.stringify(emptyList));
    assert.deepStrictEqual(emptyList.body.subscriptions, []);
    assert.strictEqual(emptyList.body.enabled, true);
  });

  const posted = await api(port, '/api/push/subscriptions', aliceToken, { method: 'POST', body: sub(1) });
  check('a user can register a subscription, and the keys are never echoed back', () => {
    assert.strictEqual(posted.status, 201, JSON.stringify(posted));
    assert.ok(posted.body.id);
    assert.strictEqual(posted.body.label, 'browser 1');
    assert.strictEqual(posted.body.keys, undefined, 'the raw keys were echoed back in the response');
  });

  const listed = await api(port, '/api/push/subscriptions', aliceToken);
  check('the registered subscription shows up on the list, without its keys', () => {
    assert.strictEqual(listed.status, 200, JSON.stringify(listed));
    assert.strictEqual(listed.body.subscriptions.length, 1);
    assert.strictEqual(listed.body.subscriptions[0].id, posted.body.id);
    assert.strictEqual(listed.body.subscriptions[0].keys, undefined);
  });

  // -- rejection of malformed subscriptions ------------------------------------

  const badEndpoint = await api(port, '/api/push/subscriptions', aliceToken, {
    method: 'POST', body: { endpoint: 'http://not-https.example.com/x', keys: { p256dh: 'a', auth: 'b' } },
  });
  check('a non-https endpoint is refused with 400', () => {
    assert.strictEqual(badEndpoint.status, 400, JSON.stringify(badEndpoint));
    assert.ok(badEndpoint.body && badEndpoint.body.error);
  });

  const missingKeys = await api(port, '/api/push/subscriptions', aliceToken, {
    method: 'POST', body: { endpoint: 'https://push.example.invalid/x' },
  });
  check('a subscription with no keys is refused with 400', () => {
    assert.strictEqual(missingKeys.status, 400, JSON.stringify(missingKeys));
  });

  const malformed = await api(port, '/api/push/subscriptions', aliceToken, {
    method: 'POST', body: '{ not json',
  });
  check('malformed JSON is refused, not a 500', () => {
    assert.strictEqual(malformed.status, 400, JSON.stringify(malformed));
  });

  const afterRefusals = await api(port, '/api/push/subscriptions', aliceToken);
  check('a refused POST does not change what was already stored', () => {
    assert.strictEqual(afterRefusals.body.subscriptions.length, 1);
  });

  // -- partitioning --------------------------------------------------------------

  const bobEmpty = await api(port, '/api/push/subscriptions', bobToken);
  check("a different, entirely legitimate user does not see the first user's subscriptions", () => {
    assert.strictEqual(bobEmpty.status, 200, JSON.stringify(bobEmpty));
    assert.deepStrictEqual(bobEmpty.body.subscriptions, []);
  });

  const bobPosted = await api(port, '/api/push/subscriptions', bobToken, { method: 'POST', body: sub(2) });
  check('bob can register his own subscription independently', () => {
    assert.strictEqual(bobPosted.status, 201, JSON.stringify(bobPosted));
  });

  const bobDeletingAlice = await api(port, `/api/push/subscriptions/${posted.body.id}`, bobToken, { method: 'DELETE' });
  check("bob deleting alice's subscription id gets 404, not a cross-account removal", () => {
    assert.strictEqual(bobDeletingAlice.status, 404, JSON.stringify(bobDeletingAlice));
  });

  const aliceStillThere = await api(port, '/api/push/subscriptions', aliceToken);
  check("alice's subscription survives bob's attempt to delete it by id", () => {
    assert.strictEqual(aliceStillThere.body.subscriptions.length, 1);
  });

  // -- deletion -------------------------------------------------------------------

  const unknownDelete = await api(port, '/api/push/subscriptions/does-not-exist', aliceToken, { method: 'DELETE' });
  check('deleting an id that was never registered gets 404', () => {
    assert.strictEqual(unknownDelete.status, 404, JSON.stringify(unknownDelete));
  });

  const realDelete = await api(port, `/api/push/subscriptions/${posted.body.id}`, aliceToken, { method: 'DELETE' });
  check("a user removing their OWN subscription by id succeeds with 204", () => {
    assert.strictEqual(realDelete.status, 204, JSON.stringify(realDelete));
  });

  const afterDelete = await api(port, '/api/push/subscriptions', aliceToken);
  check('after deletion, the subscription is actually gone', () => {
    assert.deepStrictEqual(afterDelete.body.subscriptions, []);
  });

  // -- durability -------------------------------------------------------------------

  const health = await api(port, '/healthz', aliceToken);
  check('authenticated /healthz reports whether push subscriptions are durable', () => {
    assert.strictEqual(health.status, 200, JSON.stringify(health));
    assert.strictEqual(health.body.pushStore, 'durable');
  });

  await svc.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
