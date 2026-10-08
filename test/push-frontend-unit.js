'use strict';
/**
 * Web Push (#175): the browser-side pure logic in `web/js/push.js`.
 *
 * `web/js/push.js` has zero runtime dependencies and no build step, same as
 * every other module under `web/js/`. Its DOM-free pieces -- the VAPID key
 * decoder and the feature-detection guard -- are proven here the same way
 * `web-xss-unit.js` and `install-prompt-unit.js` prove their own modules:
 * slice the pure prefix out via `readWebSource()` and run it in a plain Node
 * sandbox with no `document`/`window`/`navigator` at all, so a stray DOM
 * reference at load time throws immediately instead of silently doing
 * nothing.
 *
 * `enablePush`/`disablePush`/`syncPushMenuItem`/`wirePush` are NOT exercised
 * here -- they call `navigator.serviceWorker`, `PushManager`, `fetch` and the
 * DOM, which is exactly what `test/browser-e2e-unit.js`'s real-browser
 * Playwright harness is for. This file only owns the part that is pure data
 * transformation and can be wrong in a way neither a human reviewer nor a
 * real browser reliably notices: an off-by-one in base64url padding produces
 * a `subscribe()` rejection whose message never says why.
 */

const assert = require('assert');
const crypto = require('crypto');
const { readWebSource } = require('./helpers/web-source');

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

const src = readWebSource();

// A bare `atob` global, the same way a real browser supplies one and Node
// does not by default -- `urlBase64ToUint8Array` is written to run in a
// browser, not under `Buffer`, so the test sandbox has to supply what a
// browser would rather than silently falling back to a Node-only path.
//
// Deliberately STRICT, unlike `Buffer.from(x, 'base64')`: Node's own base64
// decoder forgives url-safe characters ('-', '_') in a standard-base64
// string, which a real browser's `atob` does not -- it throws
// `InvalidCharacterError`. That leniency would let a broken "-"/"_"
// substitution in `urlBase64ToUint8Array` pass silently here while still
// failing in every real browser, which is exactly the bug this file exists
// to catch.
function strictAtob(b64) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new Error('InvalidCharacterError: not valid standard base64');
  }
  return Buffer.from(b64, 'base64').toString('binary');
}

function load() {
  const mod = { exports: {} };
  const fn = new Function(
    'module', 'atob',
    `${src}\nmodule.exports = { urlBase64ToUint8Array, pushSupported };`,
  );
  fn(mod, strictAtob);
  return mod.exports;
}

const { urlBase64ToUint8Array, pushSupported } = load();

// ---------------------------------------------------------------------------
// urlBase64ToUint8Array: the hub hands back a VAPID public key as base64url
// (see web-push.js's `publicKey` getter); `PushManager.subscribe()`'s
// `applicationServerKey` wants the raw uncompressed-point bytes instead.
// ---------------------------------------------------------------------------

check('a base64url VAPID key round-trips to the same bytes a standard base64 decode produces', () => {
  // A real P-256 uncompressed point: 0x04 followed by 64 bytes -- the exact
  // shape `web-push.js`'s `publicKey` getter emits.
  const raw = Buffer.concat([Buffer.from([0x04]), crypto.randomBytes(64)]);
  const standardBase64 = raw.toString('base64');
  const base64url = standardBase64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const decoded = urlBase64ToUint8Array(base64url);
  assert.ok(decoded instanceof Uint8Array);
  assert.strictEqual(Buffer.from(decoded).toString('hex'), raw.toString('hex'));
});

check('every padding remainder (0, 1, 2, 3 missing "=" characters) decodes correctly', () => {
  for (let len = 1; len <= 8; len += 1) {
    const raw = crypto.randomBytes(len);
    const base64url = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decoded = urlBase64ToUint8Array(base64url);
    assert.strictEqual(Buffer.from(decoded).toString('hex'), raw.toString('hex'), `length ${len} mis-decoded`);
  }
});

check('the URL-safe substitutions ("-" for "+", "_" for "/") are actually applied', () => {
  // Built so the byte sequence is guaranteed to need both substitutions when
  // base64-encoded, rather than hoping a random sample happens to.
  const raw = Buffer.from([0xfb, 0xff, 0xbf]); // base64: "+/+/" territory
  const standard = raw.toString('base64'); // "+/+/" or similar, contains '+'/'/'
  assert.ok(/[+/]/.test(standard), 'test input did not actually exercise +/- or //_ substitution');
  const base64url = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.strictEqual(Buffer.from(urlBase64ToUint8Array(base64url)).toString('hex'), raw.toString('hex'));
});

// ---------------------------------------------------------------------------
// pushSupported: must say no cleanly on anything that lacks the APIs, rather
// than throwing -- this runs on page load, on every browser including ones
// from a decade ago that have never heard of PushManager.
// ---------------------------------------------------------------------------

check('a window with no serviceWorker/PushManager is reported unsupported, not thrown on', () => {
  assert.strictEqual(pushSupported({ navigator: {} }), false);
  assert.strictEqual(pushSupported(null), false);
  assert.strictEqual(pushSupported(undefined), false);
});

check('a window with both serviceWorker and PushManager is reported supported', () => {
  const fakeWindow = { navigator: { serviceWorker: {} }, PushManager: function PushManager() {} };
  assert.strictEqual(pushSupported(fakeWindow), true);
});

check('serviceWorker without PushManager (Safari for a long time) is reported unsupported', () => {
  const fakeWindow = { navigator: { serviceWorker: {} } };
  assert.strictEqual(pushSupported(fakeWindow), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
