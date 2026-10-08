'use strict';
/**
 * Web Push (#175): VAPID-signed, encrypted notifications to a browser that
 * is not necessarily open.
 *
 * WHY CRYPTO, NOT THE `web-push` PACKAGE. Squad Hub ships with zero runtime
 * dependencies -- browser-e2e-unit.js calls that out explicitly as "worth
 * keeping" -- and everything `web-push` does here is two RFCs implemented
 * against primitives Node's own `crypto` already has: VAPID is an ES256 JWT
 * (RFC 8292), and the payload is a single `aes128gcm` record (RFC 8188,
 * applied to Web Push by RFC 8291). Neither needs a library; both need care,
 * which is what the comments below are for.
 *
 * WHAT IS NEVER IN THE PAYLOAD: a command, a path, or anything else about
 * what the session is doing. Only the hub decides what goes in the plaintext
 * handed to `encrypt()` (see push.js and hub-service.js's `_notifyPush`), and
 * it is always the same three facts: that a session needs you, which device,
 * and the key to open it with. The push service and every network it crosses
 * sees only ciphertext either way -- this is belt and braces, not the
 * primary control -- but a payload that never contains the sensitive thing is
 * safer than one that merely encrypts it well.
 *
 * REFERENCES:
 *   RFC 8291 -- Message Encryption for Web Push
 *   RFC 8188 -- Encrypted Content-Encoding for HTTP (the aes128gcm scheme)
 *   RFC 8292 -- Voluntary Application Server Identification (VAPID) for WebPush
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const CURVE = 'prime256v1'; // NIST P-256, what every browser's PushManager uses
const UNCOMPRESSED_POINT_LEN = 65; // 0x04 || X(32) || Y(32)
const AUTH_SECRET_LEN = 16;

class WebPushError extends Error {
  constructor(message, { status, gone = false } = {}) {
    super(message);
    this.name = 'WebPushError';
    this.status = status || null;
    // 404/410: the push service itself says this subscription is dead. The
    // caller (push.js) prunes it; nothing else means the same thing, so a
    // transient 500 from the push service must never be mistaken for this.
    this.gone = gone;
  }
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64u(s, what) {
  const buf = Buffer.from(String(s), 'base64url');
  if (!buf.length) throw new WebPushError(`${what} is not valid base64url`);
  return buf;
}

/**
 * HKDF-Expand (RFC 5869 §2.3), the half Node does not expose on its own.
 *
 * `crypto.hkdfSync` performs extract-then-expand as one call with a single
 * salt, but RFC 8291's derivation uses TWO different salts in sequence (the
 * subscription's auth secret, then a fresh per-message salt) -- so the extract
 * and expand steps have to be driven separately. Every length this module
 * asks for is <= 32 (the SHA-256 output size), so the single-block case is
 * the only one implemented; a longer request would need to chain blocks with
 * the hash of the previous one, which nothing here needs.
 */
function hkdfExpand(prk, info, length) {
  if (length > 32) throw new Error('hkdfExpand: only single-block output (<=32 bytes) is implemented');
  return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().slice(0, length);
}

/** HKDF-Extract (RFC 5869 §2.2): PRK = HMAC-Hash(salt, IKM). */
function hkdfExtract(salt, ikm) {
  return crypto.createHmac('sha256', salt).update(ikm).digest();
}

/**
 * Generate a VAPID key pair.
 *
 * Returns the raw forms `SQUAD_HUB_VAPID_PUBLIC_KEY`/`_PRIVATE_KEY` expect:
 * an uncompressed P-256 point for the public key, a bare 32-byte scalar for
 * the private one -- both base64url, both ready to paste into app settings.
 * Exported for `squad-hub doctor` and for operators setting the hub up for
 * the first time; THE HUB ITSELF NEVER CALLS THIS, by design (see
 * push.js's class doc) -- generating one at runtime would mean a restart
 * silently invalidates every subscription in existence.
 */
function generateVapidKeys() {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.generateKeys();
  return {
    publicKey: b64u(ecdh.getPublicKey(null, 'uncompressed')),
    privateKey: b64u(ecdh.getPrivateKey()),
  };
}

/**
 * Build the Node `KeyObject` VAPID signing needs, from the raw public and
 * private key bytes an operator pasted into app settings.
 *
 * Constructed as a JWK rather than parsed as DER/SEC1: Node has supported EC
 * JWK import since v15, and a hand-built JWK from three already-known
 * numbers (x, y, d) is far less code -- and far fewer places to get a byte
 * offset wrong -- than writing an ASN.1 encoder for a key format this module
 * otherwise never touches.
 */
function vapidPrivateKeyObject(publicKeyB64u, privateKeyB64u) {
  const pub = fromB64u(publicKeyB64u, 'the VAPID public key');
  if (pub.length !== UNCOMPRESSED_POINT_LEN || pub[0] !== 0x04) {
    throw new Error('SQUAD_HUB_VAPID_PUBLIC_KEY must be an uncompressed P-256 point (65 bytes, base64url)');
  }
  const d = fromB64u(privateKeyB64u, 'the VAPID private key');
  if (d.length !== 32) {
    throw new Error('SQUAD_HUB_VAPID_PRIVATE_KEY must be a 32-byte P-256 scalar, base64url');
  }
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64u(pub.slice(1, 33)),
    y: b64u(pub.slice(33, 65)),
    d: b64u(d),
  };
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

/**
 * The VAPID `Authorization` header for one push (RFC 8292).
 *
 * `aud` is the push service's OWN origin, not the hub's and not the
 * subscriber's -- a token minted for `fcm.googleapis.com` must not be replay-
 * able against a different push service, so it is bound to whichever one this
 * particular endpoint happens to be.
 *
 * The signature is raw `r || s` (64 bytes), not the DER a bare ECDSA sign
 * produces -- `dsaEncoding: 'ieee-p1363'` is what asks Node for that, and is
 * the one line standing between a JWT every push service accepts and one
 * every push service silently refuses.
 */
function vapidAuthorizationHeader({
  endpoint, publicKey, privateKeyObject, subject,
}) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'ES256' };
  // 12 hours: comfortably inside RFC 8292's "should not exceed 24 hours"
  // ceiling, and this is minted fresh per send, never cached across one.
  const payload = { aud, exp: now + 12 * 3600, sub: subject };
  const signingInput = `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(Buffer.from(JSON.stringify(payload)))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: privateKeyObject,
    dsaEncoding: 'ieee-p1363',
  });
  const jwt = `${signingInput}.${b64u(signature)}`;
  return `vapid t=${jwt}, k=${publicKey}`;
}

/**
 * Encrypt one message for one subscription (RFC 8291, the `aes128gcm`
 * content coding from RFC 8188).
 *
 * `subscriptionKeys` is the `{ p256dh, auth }` pair `PushManager.subscribe()`
 * hands the browser and the hub stores verbatim (push-store.js) -- `p256dh`
 * is the browser's ECDH public key, `auth` a 16-byte secret shared only
 * between the browser and whoever it gave the subscription to.
 *
 * Returns `{ body, headers }`: `body` is the complete `aes128gcm` record
 * (salt, record size, the app server's own ephemeral public key, then the
 * ciphertext) exactly as the wire format wants it, ready to POST as-is.
 */
function encryptPayload(subscriptionKeys, plaintext) {
  const uaPublic = fromB64u(subscriptionKeys && subscriptionKeys.p256dh, 'keys.p256dh');
  const authSecret = fromB64u(subscriptionKeys && subscriptionKeys.auth, 'keys.auth');
  if (uaPublic.length !== UNCOMPRESSED_POINT_LEN) {
    throw new WebPushError('keys.p256dh is not an uncompressed P-256 point');
  }
  if (authSecret.length !== AUTH_SECRET_LEN) {
    throw new WebPushError('keys.auth must be 16 bytes');
  }

  // A fresh ECDH key pair PER MESSAGE -- reusing one would let a push service
  // (or anything it reveals the key to) correlate every message to this
  // server as the same sender, the exact property VAPID's own "voluntary"
  // identification is supposed to be the only intentional leak of.
  const appServer = crypto.createECDH(CURVE);
  appServer.generateKeys();
  const asPublic = appServer.getPublicKey(null, 'uncompressed');
  const ecdhSecret = appServer.computeSecret(uaPublic);

  // RFC 8291 §3.4, steps 1-2: derive the Input Keying Material for RFC 8188
  // from the ECDH secret, salted with the subscription's own auth secret so
  // that knowing the ECDH secret alone (e.g. from a compromised push service)
  // is not enough to decrypt -- the auth secret never crosses the network.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPublic,
    asPublic,
  ]);
  const prkKey = hkdfExtract(authSecret, ecdhSecret);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  // RFC 8188 §2.1: a fresh random salt per record, folded into the content
  // encryption key and nonce so the same IKM never produces the same key
  // twice.
  const salt = crypto.randomBytes(16);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // RFC 8188 §2: every record except the last ends with delimiter 0x01; the
  // last (and here, only) record ends with 0x02. No padding is added beyond
  // that single byte -- this payload is three short, fixed fields (see the
  // class doc above), not user content worth padding against size analysis.
  const recordPlaintext = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(recordPlaintext), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188 §2.1 header: salt(16) || record size(4, BE) || key id length(1)
  // || key id (the app server's own public key, so the receiver can redo the
  // ECDH on its side). One record only, so "record size" is simply this
  // record's own encrypted length.
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(ciphertext.length, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);

  return { body: Buffer.concat([header, ciphertext]) };
}

function postBinary(urlString, body, headers, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch { return reject(new WebPushError('the push endpoint is not a URL')); }
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      return reject(new WebPushError('a push endpoint must be https'));
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': body.length },
      timeout: timeoutMs,
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode });
        const gone = res.statusCode === 404 || res.statusCode === 410;
        return reject(new WebPushError(
          gone ? 'the push subscription is gone' : `the push service returned HTTP ${res.statusCode}`,
          { status: res.statusCode, gone },
        ));
      });
    });
    req.on('timeout', () => { req.destroy(new WebPushError('the push service timed out')); });
    req.on('error', (e) => reject(new WebPushError(e.message)));
    req.write(body);
    req.end();
  });
}

/**
 * Sends Web Push notifications. One instance per hub process.
 *
 * DISABLED, SILENTLY, WITHOUT CONFIGURED KEYS -- never generated at runtime.
 * A key pair minted on first boot would work right up until the next
 * restart or the next of two App Service instances, at which point every
 * subscription becomes undecipherable because the PRIVATE half changed under
 * it, and nothing told the person who subscribed. `SQUAD_HUB_VAPID_PUBLIC_KEY`
 * / `SQUAD_HUB_VAPID_PRIVATE_KEY` must be set once, out of band
 * (`generateVapidKeys()` above, run by hand or from `squad-hub doctor`), and
 * persist across every restart and every instance exactly like any other
 * secret this hub depends on.
 */
class WebPushSender {
  constructor({
    publicKey, privateKey, subject, log,
  } = {}) {
    this.publicKey = publicKey || process.env.SQUAD_HUB_VAPID_PUBLIC_KEY || null;
    this.privateKey = privateKey || process.env.SQUAD_HUB_VAPID_PRIVATE_KEY || null;
    // RFC 8292 wants a contact a push service operator can reach about abuse.
    // The hub's own public URL is a reasonable default where one is known; a
    // bare, clearly-fake mailto is the fallback so a missing setting degrades
    // to "generic" rather than throwing.
    this.subject = subject || process.env.SQUAD_HUB_PUBLIC_URL || 'mailto:squad-hub@invalid.example';
    this.log = log || (() => {});
    this.enabled = false;
    this.error = null;
    this._privateKeyObject = null;
    if (this.publicKey && this.privateKey) {
      try {
        this._privateKeyObject = vapidPrivateKeyObject(this.publicKey, this.privateKey);
        this.enabled = true;
      } catch (e) {
        this.error = e.message;
      }
    } else if (this.publicKey || this.privateKey) {
      // One without the other is not "unconfigured", it is a typo -- worth
      // surfacing distinctly rather than silently treating as disabled.
      this.error = 'both SQUAD_HUB_VAPID_PUBLIC_KEY and SQUAD_HUB_VAPID_PRIVATE_KEY must be set';
    }
  }

  /**
   * Send one message to one subscription.
   *
   * Throws `WebPushError`. The caller (push.js's notifier) decides what a
   * `.gone` error means for its store; this function's only job is the wire
   * protocol.
   */
  async send(subscription, payloadObject, { ttlSeconds = 24 * 3600 } = {}) {
    if (!this.enabled) throw new WebPushError('web push is not configured on this hub');
    const plaintext = Buffer.from(JSON.stringify(payloadObject), 'utf8');
    const { body } = encryptPayload(subscription.keys, plaintext);
    const headers = {
      Authorization: vapidAuthorizationHeader({
        endpoint: subscription.endpoint,
        publicKey: this.publicKey,
        privateKeyObject: this._privateKeyObject,
        subject: this.subject,
      }),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(Math.max(0, Math.round(ttlSeconds))),
    };
    return postBinary(subscription.endpoint, body, headers);
  }
}

module.exports = {
  WebPushSender,
  WebPushError,
  generateVapidKeys,
  vapidPrivateKeyObject,
  vapidAuthorizationHeader,
  encryptPayload,
  hkdfExpand,
  hkdfExtract,
  postBinary,
  CURVE,
};
