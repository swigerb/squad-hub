'use strict';
/**
 * Push subscription storage (#175).
 *
 * Follows prefs-store-unit.js's shape: validation, partitioning, caps, and
 * fail-closed behavior on a store that could not be read, applied to
 * push-store.js instead of prefs-store.js.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PushStore, idFor, MAX_SUBSCRIPTIONS } = require('../src/service/push-store');

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

function sub(n = 1) {
  return {
    endpoint: `https://push.example.invalid/wpush/v2/${n}`,
    keys: validKeys(),
    label: `browser ${n}`,
  };
}

// Security review (#175, minor): `validate()` now checks that `p256dh`
// decodes to a 65-byte uncompressed P-256 point and `auth` to a 16-byte
// secret, the same shapes web-push.js's `encryptPayload` requires at send
// time -- so every "this subscription is accepted" fixture needs real key
// material, not placeholder strings. Tests that only exercise the ENDPOINT
// checks (which run first, and return before keys are ever examined) keep
// using throwaway 'x'/'y' values, since those never reach this validation.
function validKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

{
  const store = new PushStore({ persist: false });

  check('a well-formed subscription is accepted', () => {
    const r = store.add('alice', sub(1));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.subscription.id);
  });

  check('endpoint must be present', () => {
    const r = store.add('alice', { keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false);
  });

  check('endpoint must be a URL', () => {
    const r = store.add('alice', { endpoint: 'not a url', keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false);
  });

  check('endpoint must be https (loopback excepted for tests)', () => {
    const r = store.add('alice', { endpoint: 'http://push.example.invalid/x', keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /https/);
  });

  // Security review (#175): loopback is a PRODUCTION-UNSAFE carve-out --
  // gated behind an explicit opt-in (`allowInsecureLoopback`) that only a
  // test's own store construction sets, never the default used here (the
  // same default hub-service.js uses in production).
  check('http against loopback is refused BY DEFAULT (no opt-in)', () => {
    const r = store.add('alice', { endpoint: 'http://127.0.0.1:1234/x', keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /https/);
  });

  check('http against loopback is accepted ONLY when a store opts in explicitly', () => {
    const loopbackStore = new PushStore({ persist: false, allowInsecureLoopback: true });
    const r = loopbackStore.add('alice', { endpoint: 'http://127.0.0.1:1234/x', keys: validKeys() });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  });

  // Security review (#175, SSRF): the hub's own process -- not the browser --
  // later POSTs to `endpoint` (web-push.js's `postBinary`), so an https
  // endpoint pointed at a private/link-local/loopback IP literal is a
  // server-side-request-forgery primitive, not ordinary subscription data.
  // No real push service is ever reached by a bare IP literal, so refusing
  // these costs no legitimate subscription anything.
  check('an https endpoint targeting a private IP literal is refused', () => {
    const r = store.add('alice', { endpoint: 'https://192.168.1.5/push', keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /private|loopback|link-local/);
  });

  check('an https endpoint targeting the cloud-metadata address is refused', () => {
    const r = store.add('alice', { endpoint: 'https://169.254.169.254/latest/meta-data', keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
  });

  // Security review (#175, SSRF, finding 3): `new URL('https://[::1]/').hostname`
  // is `[::1]` WITH brackets -- `net.isIP()` does not recognize the bracketed
  // form and returns 0, so every IPv6 branch of `isPrivateOrLoopbackLiteral`
  // silently never ran and every one of these endpoints was previously
  // ACCEPTED. The fix strips the brackets before calling `net.isIP` and then
  // refuses every IPv6 literal outright.
  check('an https endpoint targeting the bracketed IPv6 loopback literal is refused', () => {
    const r = store.add('alice', { endpoint: 'https://[::1]/push', keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /private|loopback|link-local/);
  });

  check('an https endpoint targeting the bracketed IPv6 unspecified address (::) is refused', () => {
    const r = store.add('alice', { endpoint: 'https://[::]/push', keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
  });

  check('an https endpoint targeting a bracketed unique-local IPv6 literal (fd00::/7) is refused', () => {
    const r = store.add('alice', { endpoint: 'https://[fd00::1]/push', keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
  });

  check('an https endpoint targeting a bracketed link-local IPv6 literal (fe80::/10) is refused', () => {
    const r = store.add('alice', { endpoint: 'https://[fe80::1]/push', keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
  });

  check('an https endpoint targeting an IPv4-mapped IPv6 cloud-metadata literal is refused', () => {
    // The URL parser itself rewrites the dotted form to hex
    // ("[::ffff:169.254.169.254]" -> "[::ffff:a9fe:a9fe]"), so this also
    // proves the fix does not depend on the dotted notation surviving.
    const r = store.add('alice', { endpoint: 'https://[::ffff:169.254.169.254]/push', keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
  });

  check('an https endpoint targeting any other IPv6 literal is refused, even a globally-routable-looking one', () => {
    // The policy is "refuse every IPv6 literal", not "refuse the private
    // ranges" -- a public-looking IPv6 literal is still refused, same as an
    // IPv4 literal pointed at a real public address would not get a pass
    // just for being syntactically a public range.
    const r = store.add('alice', { endpoint: 'https://[2001:4860:4860::8888]/push', keys: { p256dh: 'x', auth: 'y' } });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
  });

  check('an https endpoint targeting a public DNS name is still accepted', () => {
    const r = store.add('alice', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: validKeys() });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  });

  check('keys.p256dh must be present', () => {
    const r = store.add('alice', { endpoint: 'https://push.example.invalid/x', keys: { auth: 'y' } });
    assert.strictEqual(r.ok, false);
  });

  check('keys.auth must be present', () => {
    const r = store.add('alice', { endpoint: 'https://push.example.invalid/x', keys: { p256dh: 'x' } });
    assert.strictEqual(r.ok, false);
  });

  // Security review (#175, minor): previously these were only checked for
  // shape (non-empty string) HERE, with the actual byte-length only ever
  // enforced later, at send time, in web-push.js's `encryptPayload` -- so a
  // registered subscription that could never actually be sent to looked
  // identical to a working one until the first notification tried and
  // failed. Catching it at subscribe time means the person who can fix it
  // (by re-subscribing) finds out immediately, not days later.
  check('keys.p256dh that does not decode to a 65-byte point is refused, even though it is a non-empty string', () => {
    const r = store.add('alice', { endpoint: 'https://push.example.invalid/x', keys: { p256dh: 'not-a-real-key', auth: crypto.randomBytes(16).toString('base64url') } });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /p256dh/);
  });

  check('keys.auth that does not decode to a 16-byte secret is refused, even though it is a non-empty string', () => {
    const r = store.add('alice', { endpoint: 'https://push.example.invalid/x', keys: { ...validKeys(), auth: 'short' } });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.reason, /auth/);
  });

  check('a label over the cap is refused', () => {
    const r = store.add('alice', { ...sub(99), label: 'x'.repeat(200) });
    assert.strictEqual(r.ok, false);
  });

  check('a non-object body is refused, not coerced', () => {
    const r = store.add('alice', 'nope');
    assert.strictEqual(r.ok, false);
  });
}

// ---------------------------------------------------------------------------
// Upsert by endpoint (re-subscribing the same browser)
// ---------------------------------------------------------------------------

{
  const store = new PushStore({ persist: false });
  const first = store.add('alice', sub(1));
  const second = store.add('alice', { ...sub(1), label: 'renamed' });

  check('re-subscribing the same endpoint reuses the same id (upsert, not a duplicate)', () => {
    assert.strictEqual(first.subscription.id, second.subscription.id);
    assert.strictEqual(store.list('alice').length, 1);
  });

  check('an upsert updates the label', () => {
    assert.strictEqual(store.list('alice')[0].label, 'renamed');
  });

  check('idFor is deterministic for the same endpoint', () => {
    assert.strictEqual(idFor('https://x/1'), idFor('https://x/1'));
    assert.notStrictEqual(idFor('https://x/1'), idFor('https://x/2'));
  });
}

// ---------------------------------------------------------------------------
// Partitioning -- the property that actually matters here
// ---------------------------------------------------------------------------

{
  const store = new PushStore({ persist: false });
  store.add('alice', sub(1));
  store.add('bob', sub(2));

  check("one subject's subscriptions never appear in another's list", () => {
    assert.strictEqual(store.list('alice').length, 1);
    assert.strictEqual(store.list('bob').length, 1);
    assert.notStrictEqual(store.list('alice')[0].id, store.list('bob')[0].id);
  });

  check('a subject with no subscriptions gets an empty list, not an error', () => {
    assert.deepStrictEqual(store.list('carol'), []);
  });

  check("removing by id only removes from the caller's own partition", () => {
    const aliceId = store.list('alice')[0].id;
    // Bob's partition has no such id -- removal must report false, not
    // somehow reach into Alice's bucket because the id happens to be known.
    const removedFromBob = store.remove('bob', aliceId);
    assert.strictEqual(removedFromBob, false);
    assert.strictEqual(store.list('alice').length, 1, "alice's subscription must survive");
  });

  check('removing a real id in the right partition actually removes it', () => {
    const aliceId = store.list('alice')[0].id;
    assert.strictEqual(store.remove('alice', aliceId), true);
    assert.strictEqual(store.list('alice').length, 0);
  });
}

// ---------------------------------------------------------------------------
// Pruning on a gone endpoint (404/410 from the push service)
// ---------------------------------------------------------------------------

{
  const store = new PushStore({ persist: false });
  store.add('alice', sub(1));

  check('removeByEndpoint removes the subscription that endpoint belongs to', () => {
    assert.strictEqual(store.removeByEndpoint('alice', sub(1).endpoint), true);
    assert.strictEqual(store.list('alice').length, 0);
  });

  check('removeByEndpoint for an endpoint never registered is a no-op, not an error', () => {
    assert.strictEqual(store.removeByEndpoint('alice', 'https://never.invalid/x'), false);
  });
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

{
  const store = new PushStore({ persist: false });
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) {
    const r = store.add('alice', sub(i));
    if (!r.ok) throw new Error(`setup failed at ${i}: ${r.reason}`);
  }

  check(`more than ${MAX_SUBSCRIPTIONS} subscriptions for one subject is refused`, () => {
    const r = store.add('alice', sub(9999));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(store.list('alice').length, MAX_SUBSCRIPTIONS);
  });

  check('re-subscribing an EXISTING endpoint is still allowed once the cap is hit (it is an upsert, not a new slot)', () => {
    const r = store.add('alice', { ...sub(0), label: 'still me' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  });
}

// ---------------------------------------------------------------------------
// Persistence: survives a restart, fails closed on a corrupt file
// ---------------------------------------------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqh-push-store-'));

  const store1 = new PushStore({ dir, persist: true });
  store1.add('alice', sub(1));

  const store2 = new PushStore({ dir, persist: true });
  check('a subscription survives a restart when persisted', () => {
    assert.strictEqual(store2.list('alice').length, 1);
    assert.strictEqual(store2.list('alice')[0].endpoint, sub(1).endpoint);
  });

  fs.writeFileSync(path.join(dir, 'push-subscriptions.json'), 'not json at all');
  const store3 = new PushStore({ dir, persist: true });
  check('an unreadable file sets ok=false rather than silently starting empty', () => {
    assert.strictEqual(store3.ok, false);
  });

  check('a store that failed to load refuses to write (fails closed)', () => {
    const r = store3.add('alice', sub(2));
    assert.strictEqual(r.ok, false);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
