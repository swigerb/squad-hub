'use strict';
/**
 * The preferences API, over a real HTTP server.
 *
 * prefs-store-unit.js proves the store's rules. This proves the ROUTE applies
 * them to a real request from a real principal: a user token works, a device
 * token is refused, no token is refused differently, and two users never see
 * each other's record.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Authenticator, MODES } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');

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
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: b });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (opts.body !== undefined) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqh-prefs-api-'));
  const secret = crypto.randomBytes(16).toString('hex');
  const deviceSecret = crypto.randomBytes(16).toString('hex');

  const auth = new Authenticator({
    mode: MODES.DEV, devSecret: secret, deviceSecret, owner: ['swigerb'], allowedUsers: ['llowevad'],
  });
  const svc = new HubService({
    auth, serveWeb: false, prefsDir: dir, persistPrefs: true, persistAccess: false, persistStore: false,
  });
  const addr = await svc.listen(0, '127.0.0.1');
  const { port } = addr;

  const aliceToken = auth.mintDevToken('local', 'swigerb', 'swigerb');
  const bobToken = auth.mintDevToken('local', 'llowevad', 'llowevad');
  const deviceToken = auth.mintDeviceToken({ key: 'whatever-partition', name: 'a cloud job' });

  // -- the three credentials the issue calls out explicitly -------------------

  const noToken = await api(port, '/api/prefs', null);
  check('no token gets 401', () => {
    assert.strictEqual(noToken.status, 401, JSON.stringify(noToken));
  });

  const deviceGet = await api(port, '/api/prefs', deviceToken);
  check('a device token gets 403 on GET', () => {
    assert.strictEqual(deviceGet.status, 403, JSON.stringify(deviceGet));
  });

  const devicePut = await api(port, '/api/prefs', deviceToken, { method: 'PUT', body: { pins: ['x'] } });
  check('a device token gets 403 on PUT, and nothing was stored', () => {
    assert.strictEqual(devicePut.status, 403, JSON.stringify(devicePut));
  });

  const userGet = await api(port, '/api/prefs', aliceToken);
  check('a user (watcher) token works', () => {
    assert.strictEqual(userGet.status, 200, JSON.stringify(userGet));
    assert.deepStrictEqual(userGet.body, { pins: [], names: {}, view: null });
  });

  // -- a real write, read back ------------------------------------------------

  const put = await api(port, '/api/prefs', aliceToken, {
    method: 'PUT',
    body: {
      pins: ['dev-a:session-1'],
      names: { 'dev-a:session-1': 'release branch' },
      view: { scope: 'mine', groupBy: 'device', sortBy: 'recent' },
    },
  });
  check('a user can save preferences', () => {
    assert.strictEqual(put.status, 200, JSON.stringify(put));
    assert.deepStrictEqual(put.body.pins, ['dev-a:session-1']);
  });

  const readBack = await api(port, '/api/prefs', aliceToken);
  check('a saved preference is read back exactly', () => {
    assert.strictEqual(readBack.status, 200, JSON.stringify(readBack));
    assert.deepStrictEqual(readBack.body, put.body);
  });

  // -- partitioning -------------------------------------------------------------

  const bobGet = await api(port, '/api/prefs', bobToken);
  check("a different, entirely legitimate user does not see the first user's preferences", () => {
    assert.strictEqual(bobGet.status, 200, JSON.stringify(bobGet));
    assert.deepStrictEqual(bobGet.body, { pins: [], names: {}, view: null });
  });

  await api(port, '/api/prefs', bobToken, { method: 'PUT', body: { pins: ['dev-b:session-9'] } });
  const aliceStill = await api(port, '/api/prefs', aliceToken);
  check("the other user writing their own preferences does not touch the first user's", () => {
    assert.deepStrictEqual(aliceStill.body.pins, ['dev-a:session-1']);
  });

  // -- rejection of wrong shapes and types, and caps -----------------------------

  const badShape = await api(port, '/api/prefs', aliceToken, { method: 'PUT', body: { pins: 'not-an-array' } });
  check('a wrong-typed field is refused with 400, not coerced', () => {
    assert.strictEqual(badShape.status, 400, JSON.stringify(badShape));
    assert.ok(badShape.body && badShape.body.error, 'no error message on a 400');
  });

  const tooManyPins = await api(port, '/api/prefs', aliceToken, {
    method: 'PUT',
    body: { pins: Array.from({ length: 501 }, (_, i) => `dev:${i}`) },
  });
  check('more than 500 pins is refused with 400', () => {
    assert.strictEqual(tooManyPins.status, 400, JSON.stringify(tooManyPins));
  });

  const tooLongName = await api(port, '/api/prefs', aliceToken, {
    method: 'PUT',
    body: { names: { 'dev:1': 'x'.repeat(121) } },
  });
  check('a name over 120 characters is refused with 400', () => {
    assert.strictEqual(tooLongName.status, 400, JSON.stringify(tooLongName));
  });

  const afterRefusals = await api(port, '/api/prefs', aliceToken);
  check('a refused PUT does not change what was already stored', () => {
    assert.deepStrictEqual(afterRefusals.body.pins, ['dev-a:session-1']);
  });

  const malformed = await api(port, '/api/prefs', aliceToken, {
    method: 'PUT',
    body: '{ this is not json',
  });
  check('malformed JSON is refused, not a 500', () => {
    assert.strictEqual(malformed.status, 400, JSON.stringify(malformed));
  });

  // -- durability ----------------------------------------------------------------

  const health = await api(port, '/healthz', aliceToken);
  check('authenticated /healthz reports whether preferences are durable', () => {
    assert.strictEqual(health.status, 200, JSON.stringify(health));
    assert.strictEqual(health.body.prefsStore, 'durable');
  });

  await svc.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
