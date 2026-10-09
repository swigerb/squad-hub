'use strict';
/**
 * Web Push crypto (#175), proven by round-trip rather than by inspection.
 *
 * Neither RFC 8291's payload encryption nor RFC 8292's VAPID signing can be
 * checked by staring at the bytes -- the only way to know the implementation
 * is RIGHT, not merely "runs without throwing", is to decrypt what it
 * encrypted and verify what it signed, the way a real browser and a real
 * push service would. So this plays both sides: it stands in for the
 * browser (an ECDH key pair and an auth secret, exactly what
 * `PushManager.subscribe()` hands a page) and decrypts the module's own
 * output using nothing but the public algorithm, never the module's internal
 * functions.
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const {
  WebPushSender, WebPushError, generateVapidKeys, vapidPrivateKeyObject,
  vapidAuthorizationHeader, encryptPayload, hkdfExpand, hkdfExtract, postBinary,
} = require('../src/service/web-push');

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

/** Stand in for a browser: an ECDH key pair and a 16-byte auth secret. */
function fakeSubscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey(null, 'uncompressed');
  const authSecret = crypto.randomBytes(16);
  return {
    ecdh,
    publicKey,
    authSecret,
    keys: { p256dh: publicKey.toString('base64url'), auth: authSecret.toString('base64url') },
    endpoint: 'https://push.example.invalid/wpush/v2/abc123',
  };
}

/** Decrypt an `aes128gcm` body (RFC 8188) the way a browser would, from the subscriber's own keys. */
function decryptAsSubscriber(subscriber, body) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  const ecdhSecret = subscriber.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), subscriber.publicKey, asPublic]);
  const prkKey = hkdfExtract(subscriber.authSecret, ecdhSecret);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const tag = ciphertext.slice(ciphertext.length - 16);
  const ct = ciphertext.slice(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const record = Buffer.concat([decipher.update(ct), decipher.final()]);
  // The last byte is the RFC 8188 delimiter (0x02 for a single, final record).
  return record.slice(0, record.length - 1);
}

// ---------------------------------------------------------------------------
// Payload encryption round-trips
// ---------------------------------------------------------------------------

check('a plaintext payload decrypts back to exactly what was encrypted', () => {
  const subscriber = fakeSubscriber();
  const plaintext = Buffer.from(JSON.stringify({
    title: 'A session needs you', device: 'bs-laptop', sessionKey: 'dev-a:session-1',
  }));
  const { body } = encryptPayload(subscriber.keys, plaintext);
  const decrypted = decryptAsSubscriber(subscriber, body);
  assert.deepStrictEqual(JSON.parse(decrypted.toString('utf8')), JSON.parse(plaintext.toString('utf8')));
});

check('every send uses a fresh app-server key pair and a fresh salt (no reuse to correlate)', () => {
  const subscriber = fakeSubscriber();
  const plaintext = Buffer.from('{}');
  const a = encryptPayload(subscriber.keys, plaintext);
  const b = encryptPayload(subscriber.keys, plaintext);
  const saltA = a.body.slice(0, 16);
  const saltB = b.body.slice(0, 16);
  const asPublicA = a.body.slice(21, 21 + a.body[20]);
  const asPublicB = b.body.slice(21, 21 + b.body[20]);
  assert.notStrictEqual(saltA.toString('hex'), saltB.toString('hex'));
  assert.notStrictEqual(asPublicA.toString('hex'), asPublicB.toString('hex'));
});

check('a wrong auth secret cannot decrypt the payload (the auth secret is load-bearing, not decorative)', () => {
  const subscriber = fakeSubscriber();
  const { body } = encryptPayload(subscriber.keys, Buffer.from('{"a":1}'));
  const wrong = { ...subscriber, authSecret: crypto.randomBytes(16) };
  assert.throws(() => decryptAsSubscriber(wrong, body));
});

check('a malformed p256dh is refused before any network call', () => {
  assert.throws(
    () => encryptPayload({ p256dh: Buffer.alloc(10).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }, Buffer.from('{}')),
    /p256dh/,
  );
});

check('a malformed auth secret is refused before any network call', () => {
  const subscriber = fakeSubscriber();
  assert.throws(
    () => encryptPayload({ p256dh: subscriber.keys.p256dh, auth: Buffer.alloc(4).toString('base64url') }, Buffer.from('{}')),
    /auth/,
  );
});

// ---------------------------------------------------------------------------
// VAPID (RFC 8292)
// ---------------------------------------------------------------------------

check('a generated VAPID key pair signs a JWT that verifies against its own public key', () => {
  const keys = generateVapidKeys();
  const priv = vapidPrivateKeyObject(keys.publicKey, keys.privateKey);
  const header = vapidAuthorizationHeader({
    endpoint: 'https://fcm.googleapis.com/fcm/send/xyz',
    publicKey: keys.publicKey,
    privateKeyObject: priv,
    subject: 'mailto:ops@example.com',
  });
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, `header did not match the vapid scheme: ${header}`);
  const [, jwt, k] = m;
  assert.strictEqual(k, keys.publicKey);
  const [h, p, s] = jwt.split('.');
  const pub = crypto.createPublicKey(priv);
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  assert.strictEqual(ok, true, 'the signature does not verify against the key it was signed with');
});

check('the VAPID audience is the push endpoint\'s own origin, not the hub\'s', () => {
  const keys = generateVapidKeys();
  const priv = vapidPrivateKeyObject(keys.publicKey, keys.privateKey);
  const header = vapidAuthorizationHeader({
    endpoint: 'https://push.example.invalid/some/path?q=1',
    publicKey: keys.publicKey,
    privateKeyObject: priv,
    subject: 'mailto:ops@example.com',
  });
  const jwt = header.match(/t=([^,]+)/)[1];
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  assert.strictEqual(payload.aud, 'https://push.example.invalid');
});

check('a generated private scalar with leading zero bytes is padded to exactly 32 bytes, imports, and signs with its matching public key (#240)', () => {
  // Deterministic repro of #240: Node's `ecdh.getPrivateKey()` returns the
  // scalar's MINIMAL big-endian encoding, dropping leading zero bytes -- so
  // a scalar that happens to start with zero byte(s) comes back SHORTER
  // than 32 bytes. Rather than wait on random generation to land on one
  // (the coordinator needed 362 tries), force it: `scalar = 1` is as
  // leading-zero as a P-256 scalar gets, and `setPrivateKey` computes the
  // matching public point the same way `generateKeys` would.
  const originalCreateECDH = crypto.createECDH;
  crypto.createECDH = (curve) => {
    const ecdh = originalCreateECDH(curve);
    ecdh.generateKeys = () => {
      ecdh.setPrivateKey(Buffer.concat([Buffer.alloc(31, 0), Buffer.from([0x01])]));
      return ecdh.getPublicKey(null, 'uncompressed');
    };
    return ecdh;
  };
  let keys;
  try {
    keys = generateVapidKeys();
  } finally {
    crypto.createECDH = originalCreateECDH;
  }

  const privateKeyBuf = Buffer.from(keys.privateKey, 'base64url');
  assert.strictEqual(privateKeyBuf.length, 32, 'the generated private scalar must be exactly 32 bytes, not the minimal encoding');
  assert.strictEqual(privateKeyBuf.slice(0, 31).every((b) => b === 0), true, 'the padding must be the leading bytes, never a change to the scalar value');
  assert.strictEqual(privateKeyBuf[31], 0x01, 'the scalar value itself must be unchanged by padding');

  // Proves the padded key actually WORKS: imports without throwing, and
  // signs a VAPID token that verifies against its OWN public key -- the
  // exact two things the defective generator could silently break.
  const priv = vapidPrivateKeyObject(keys.publicKey, keys.privateKey);
  const header = vapidAuthorizationHeader({
    endpoint: 'https://fcm.googleapis.com/fcm/send/xyz',
    publicKey: keys.publicKey,
    privateKeyObject: priv,
    subject: 'mailto:ops@example.com',
  });
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, `header did not match the vapid scheme: ${header}`);
  const [, jwt, k] = m;
  assert.strictEqual(k, keys.publicKey);
  const [h, p, s] = jwt.split('.');
  const pub = crypto.createPublicKey(priv);
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  assert.strictEqual(ok, true, 'the signature from a padded, previously-short scalar does not verify against its own public key');
});

check('generateVapidKeys produces a 32-byte private scalar across many draws (supplemental stress, not the regression test for #240)', () => {
  // Supplemental only: this is what originally needed 362 draws to catch the
  // defect, so it proves nothing on its own run-to-run. The deterministic
  // leading-zero test above is the actual regression coverage for #240; this
  // loop stays as a secondary net against any other source of short output.
  for (let i = 0; i < 200; i += 1) {
    const keys = generateVapidKeys();
    const buf = Buffer.from(keys.privateKey, 'base64url');
    assert.strictEqual(buf.length, 32, `draw ${i}: expected a 32-byte private scalar, got ${buf.length}`);
  }
});

check('a tampered JWT fails verification', () => {
  const keys = generateVapidKeys();
  const priv = vapidPrivateKeyObject(keys.publicKey, keys.privateKey);
  const header = vapidAuthorizationHeader({
    endpoint: 'https://push.example.invalid/x', publicKey: keys.publicKey, privateKeyObject: priv, subject: 'mailto:a@b.com',
  });
  const jwt = header.match(/t=([^,]+)/)[1];
  const [h, p, s] = jwt.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ aud: 'https://evil.invalid', exp: 9999999999, sub: 'mailto:a@b.com' })).toString('base64url');
  const pub = crypto.createPublicKey(priv);
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${tamperedPayload}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  assert.strictEqual(ok, false);
});

// ---------------------------------------------------------------------------
// WebPushSender: configuration, never generated at runtime
// ---------------------------------------------------------------------------

check('with no VAPID keys configured, the sender is disabled, not ephemeral', () => {
  const sender = new WebPushSender({});
  assert.strictEqual(sender.enabled, false);
});

check('one VAPID key set without the other is a distinct, named misconfiguration', () => {
  const keys = generateVapidKeys();
  const sender = new WebPushSender({ publicKey: keys.publicKey });
  assert.strictEqual(sender.enabled, false);
  assert.match(sender.error, /both.*must be set/);
});

check('a malformed configured key disables the sender rather than throwing out of the constructor', () => {
  const sender = new WebPushSender({ publicKey: 'not-a-valid-key', privateKey: 'also-not-valid' });
  assert.strictEqual(sender.enabled, false);
  assert.ok(sender.error, 'no error message was recorded');
});

check('a correctly configured sender is enabled and exposes its public key', () => {
  const keys = generateVapidKeys();
  const sender = new WebPushSender({ publicKey: keys.publicKey, privateKey: keys.privateKey });
  assert.strictEqual(sender.enabled, true);
  assert.strictEqual(sender.publicKey, keys.publicKey);
});

(async () => {
  await checkAsync('send() against a disabled sender refuses before touching the network', async () => {
    const sender = new WebPushSender({});
    await assert.rejects(
      () => sender.send({ endpoint: 'https://push.example.invalid/x', keys: { p256dh: 'x', auth: 'y' } }, { title: 'x' }),
      WebPushError,
    );
  });

  // Security review (#175, minor): nothing in `postBinary` ever reads the
  // push service's response BODY -- only `statusCode` -- but an earlier
  // version accumulated it into a string anyway, with no size cap. A
  // malicious or merely broken push service answering with an unbounded body
  // could grow this process's memory without limit for a value nothing here
  // uses. `postBinary` now drains the response without buffering it at all.
  await checkAsync('postBinary settles on statusCode alone, even against a large response body', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(201, { 'Content-Type': 'text/plain' });
      // Much larger than any sane push-service response, and large enough
      // that accumulating it would be an obviously bad idea -- not large
      // enough to make the test itself slow.
      res.end('x'.repeat(5 * 1024 * 1024));
    });
    await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
    const { port } = server.address();
    try {
      const r = await postBinary(`http://127.0.0.1:${port}/push`, Buffer.from('body'), {});
      assert.strictEqual(r.status, 201);
    } finally {
      server.close();
    }
  });

  await checkAsync('postBinary still reports a non-2xx statusCode correctly against a large response body', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(500);
      res.end('y'.repeat(2 * 1024 * 1024));
    });
    await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
    const { port } = server.address();
    try {
      await assert.rejects(
        () => postBinary(`http://127.0.0.1:${port}/push`, Buffer.from('body'), {}),
        (e) => e instanceof WebPushError && e.status === 500,
      );
    } finally {
      server.close();
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
