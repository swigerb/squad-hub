'use strict';
/**
 * The push notifier (#175): dedupe, pruning, and the payload redaction
 * guarantee, proven end to end against a REAL HTTP server standing in for a
 * push service -- the same discipline teams-unit.js applies to Teams cards.
 *
 * The assertion that matters most is the redaction one: a "session needs
 * you" push must never carry a command or a path, because the payload
 * typically transits a push service (FCM, Mozilla autopush) and lands in an
 * OS notification tray outside the hub's custody.
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const { PushNotifier, needsYouPayload } = require('../src/notify/push');
const { WebPushSender, generateVapidKeys } = require('../src/service/web-push');
const { PushStore } = require('../src/service/push-store');

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

const session = {
  key: 'dev-a:session-1',
  id: 'session-1',
  prompt: 'Add a health endpoint and run: npm test && git push --force',
  cwd: '/home/ci/secret-repo',
  updatedAt: 1000,
};
const device = { name: 'BS-MINIDESKTOP', deviceId: 'dev-a' };

// ---------------------------------------------------------------------------
// The payload shape itself
// ---------------------------------------------------------------------------

check('the payload carries only title, device name, and session key', () => {
  const p = needsYouPayload({ title: 'A session needs you', device, session });
  assert.deepStrictEqual(Object.keys(p).sort(), ['device', 'sessionKey', 'title']);
  assert.strictEqual(p.title, 'A session needs you');
  assert.strictEqual(p.device, 'BS-MINIDESKTOP');
  assert.strictEqual(p.sessionKey, 'dev-a:session-1');
});

check('the payload never contains the prompt, command, or cwd, no matter what they say', () => {
  const p = needsYouPayload({ title: 'A session needs you', device, session });
  const serialized = JSON.stringify(p);
  assert.ok(!serialized.includes('npm test'), 'a command leaked into the push payload');
  assert.ok(!serialized.includes('secret-repo'), 'a path leaked into the push payload');
  assert.ok(!serialized.includes('Add a health endpoint'), 'the prompt leaked into the push payload');
});

check('a device with no name falls back to a generic label, not undefined', () => {
  const p = needsYouPayload({ title: 'x', device: {}, session });
  assert.strictEqual(p.device, 'a device');
});

// ---------------------------------------------------------------------------
// A fake push service: decrypts what actually crossed the wire
// ---------------------------------------------------------------------------

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
  };
}

function decryptAesGcm(subscriber, body) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const ecdhSecret = subscriber.ecdh.computeSecret(asPublic);
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const hkdfExpand1 = (prk, info, len) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).slice(0, len);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), subscriber.publicKey, asPublic]);
  const prkKey = hmac(subscriber.authSecret, ecdhSecret);
  const ikm = hkdfExpand1(prkKey, keyInfo, 32);
  const prk = hmac(salt, ikm);
  const cek = hkdfExpand1(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdfExpand1(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);
  const tag = ciphertext.slice(ciphertext.length - 16);
  const ct = ciphertext.slice(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const record = Buffer.concat([decipher.update(ct), decipher.final()]);
  return record.slice(0, record.length - 1);
}

(async () => {
  const received = [];
  let nextStatus = 201;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(nextStatus);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const vapid = generateVapidKeys();
  const sender = new WebPushSender({ publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:ops@example.com' });
  const store = new PushStore({ persist: false, allowInsecureLoopback: true });
  const notifier = new PushNotifier({ sender, store });

  const subscriber = fakeSubscriber();
  store.add('alice', { endpoint: `http://127.0.0.1:${port}/push/abc`, keys: subscriber.keys, label: 'laptop' });

  await checkAsync('notifyNeedsYou actually reaches the push service', async () => {
    const r = await notifier.notifyNeedsYou({
      subject: 'alice', device, session, title: 'A session needs you', dedupeKey: 'approval:a1',
    });
    assert.strictEqual(r.sent, true, JSON.stringify(r));
    assert.strictEqual(received.length, 1);
  });

  await checkAsync('what was actually encrypted onto the wire decrypts to the redacted payload, nothing else', async () => {
    const plaintext = decryptAesGcm(subscriber, received[0].body);
    const payload = JSON.parse(plaintext.toString('utf8'));
    assert.deepStrictEqual(payload, { title: 'A session needs you', device: 'BS-MINIDESKTOP', sessionKey: 'dev-a:session-1' });
    const raw = received[0].body.toString('latin1');
    assert.ok(!raw.includes('npm test'), 'plaintext command bytes appeared on the wire');
  });

  await checkAsync('the VAPID Authorization header is present and well formed', async () => {
    assert.match(received[0].headers.authorization, /^vapid t=.+, k=.+$/);
    assert.strictEqual(received[0].headers['content-encoding'], 'aes128gcm');
  });

  await checkAsync('the same dedupeKey is not sent twice', async () => {
    const before = received.length;
    const r = await notifier.notifyNeedsYou({
      subject: 'alice', device, session, title: 'A session needs you', dedupeKey: 'approval:a1',
    });
    assert.deepStrictEqual(r, { skipped: 'already notified' });
    assert.strictEqual(received.length, before, 'a duplicate request reached the push service');
  });

  await checkAsync('a NEW dedupeKey for the same subject IS sent', async () => {
    const before = received.length;
    await notifier.notifyNeedsYou({
      subject: 'alice', device, session, title: 'A session is waiting for your reply', dedupeKey: 'reply:dev-a:session-1:2000',
    });
    assert.strictEqual(received.length, before + 1);
  });

  await checkAsync('a subject with no subscriptions is a no-op, not an error', async () => {
    const r = await notifier.notifyNeedsYou({
      subject: 'nobody', device, session, title: 'x', dedupeKey: 'approval:zzz',
    });
    assert.deepStrictEqual(r, { skipped: 'no subscriptions' });
  });

  // Reviewer finding (#175): a no-subscriptions outcome must NOT burn the
  // dedupeKey. The real-world order of events is almost always "a heartbeat
  // fires for a pending approval before the user has gotten around to
  // enabling push" -- if THAT first, subscription-less call consumed the key,
  // the user could enable push a second later and still never hear about
  // that same still-pending approval, because its dedupeKey never changes
  // for the life of the approval.
  await checkAsync('subscribing AFTER a no-subscriptions notify still gets notified for the same dedupeKey', async () => {
    const before = received.length;
    const first = await notifier.notifyNeedsYou({
      subject: 'carol', device, session, title: 'A session needs you', dedupeKey: 'approval:late-subscriber',
    });
    assert.deepStrictEqual(first, { skipped: 'no subscriptions' });
    assert.strictEqual(received.length, before, 'nothing should have reached the push service yet');

    store.add('carol', { endpoint: `http://127.0.0.1:${port}/push/carol`, keys: fakeSubscriber().keys, label: 'phone' });

    const second = await notifier.notifyNeedsYou({
      subject: 'carol', device, session, title: 'A session needs you', dedupeKey: 'approval:late-subscriber',
    });
    assert.strictEqual(second.sent, true, JSON.stringify(second));
    assert.strictEqual(received.length, before + 1, 'the real notification never reached the push service');
  });

  // -- pruning: the push service says 410 Gone --------------------------------

  nextStatus = 410;
  await checkAsync('a 410 from the push service prunes the subscription', async () => {
    assert.strictEqual(store.list('alice').length, 1);
    await notifier.notifyNeedsYou({
      subject: 'alice', device, session, title: 'x', dedupeKey: 'approval:gone-one',
    });
    assert.strictEqual(store.list('alice').length, 0, 'the gone subscription was not pruned');
  });

  await checkAsync('after pruning, a further notify to that subject is a clean no-op', async () => {
    const r = await notifier.notifyNeedsYou({
      subject: 'alice', device, session, title: 'x', dedupeKey: 'approval:after-prune',
    });
    assert.deepStrictEqual(r, { skipped: 'no subscriptions' });
  });

  // -- forget() re-arms a dedupe key -------------------------------------------

  nextStatus = 201;
  received.length = 0;
  store.add('bob', { endpoint: `http://127.0.0.1:${port}/push/bob`, keys: fakeSubscriber().keys, label: 'phone' });
  await notifier.notifyNeedsYou({ subject: 'bob', device, session, title: 'x', dedupeKey: 'approval:b1' });
  notifier.forget('approval:b1');
  await checkAsync('forget() allows a re-notification for the same dedupeKey', async () => {
    const before = received.length;
    const r = await notifier.notifyNeedsYou({ subject: 'bob', device, session, title: 'x', dedupeKey: 'approval:b1' });
    assert.strictEqual(r.sent, true);
    assert.strictEqual(received.length, before + 1);
  });

  // -- disabled sender ----------------------------------------------------------

  check('a disabled sender makes the notifier disabled too, without needing its own flag', () => {
    const disabledNotifier = new PushNotifier({ sender: new WebPushSender({}), store });
    assert.strictEqual(disabledNotifier.enabled, false);
  });

  await checkAsync('an empty store (no subscriptions ever) is a no-op even when the sender is enabled', async () => {
    const emptyStore = new PushStore({ persist: false, allowInsecureLoopback: true });
    const n = new PushNotifier({ sender, store: emptyStore });
    const r = await n.notifyNeedsYou({ subject: 'anyone', device, session, title: 'x', dedupeKey: 'approval:x' });
    assert.deepStrictEqual(r, { skipped: 'no subscriptions' });
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
