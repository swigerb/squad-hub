'use strict';
/**
 * The access API, over a real HTTP server.
 *
 * access-store-unit.js proves the store's rules. This proves the ROUTE applies
 * them to a real request from a real principal, because the store being right
 * is no help if the route never asks it.
 *
 * The assertion that matters most is the dullest one: an allowed user -- a
 * genuine, signed-in, entirely legitimate user of this hub -- gets 403 on every
 * method. If that ever returns 200, one invitation becomes the whole hub and
 * nothing in the UI would look wrong.
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

function api(port, p, token, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: p,
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqh-access-api-'));
  const secret = crypto.randomBytes(16).toString('hex');

  // An owner, a permitted guest, and a stranger -- the three cases the route
  // has to tell apart.
  const auth = new Authenticator({
    mode: MODES.DEV,
    devSecret: secret,
    owner: ['swigerb'],
    allowedUsers: ['llowevad'],
  });
  const svc = new HubService({
    auth, serveWeb: false, accessDir: dir, persistAccess: true,
  });
  const addr = await svc.listen(0, '127.0.0.1');
  const port = addr.port;

  const ownerToken = auth.mintDevToken('local', 'swigerb', 'swigerb');
  const guestToken = auth.mintDevToken('local', 'llowevad', 'llowevad');

  // -- the owner can see and change the list --------------------------------

  const seen = await api(port, '/api/access', ownerToken);
  check('an owner can read the access list', () => {
    assert.strictEqual(seen.status, 200, JSON.stringify(seen));
    const logins = seen.body.users.map((u) => u.login);
    assert.ok(logins.includes('swigerb'), 'the owner is not listed');
    assert.ok(logins.includes('llowevad'), 'the configured user is not listed');
  });

  check('the list says whether a grant would survive a restart', () => {
    assert.strictEqual(seen.body.durable, true);
  });

  const added = await api(port, '/api/access', ownerToken, {
    method: 'POST', body: { login: 'newperson', note: 'a colleague' },
  });
  check('an owner can add someone', () => {
    assert.strictEqual(added.status, 200, JSON.stringify(added));
    assert.ok(added.body.users.some((u) => u.login === 'newperson'));
  });

  check('the grant takes effect immediately, not at the next restart', () => {
    // The live authenticator is what decides the next sign-in. A store that
    // holds the name while the authenticator does not is a grant that appears
    // to work and refuses the person.
    assert.ok(auth.allowedUsers.includes('newperson'),
      'the authenticator was not updated, so the person just added would still be refused');
  });

  check('who added them is taken from the verified identity, not the request', async () => {
    const row = added.body.users.find((u) => u.login === 'newperson');
    assert.strictEqual(row.addedBy, 'swigerb');
  });

  const spoofed = await api(port, '/api/access', ownerToken, {
    method: 'POST', body: { login: 'anotherone', addedBy: 'somebody-else' },
  });
  check('a request cannot write its own name into the log', () => {
    assert.strictEqual(spoofed.status, 200);
    const row = spoofed.body.users.find((u) => u.login === 'anotherone');
    assert.strictEqual(row.addedBy, 'swigerb', 'the request body chose the actor');
  });

  const removed = await api(port, '/api/access/newperson', ownerToken, { method: 'DELETE' });
  check('an owner can remove someone they added', () => {
    assert.strictEqual(removed.status, 200, JSON.stringify(removed));
    assert.ok(!removed.body.users.some((u) => u.login === 'newperson'));
    assert.ok(!auth.allowedUsers.includes('newperson'), 'the revocation did not take effect');
  });

  // -- the refusals ---------------------------------------------------------

  const guestRead = await api(port, '/api/access', guestToken);
  const guestAdd = await api(port, '/api/access', guestToken, {
    method: 'POST', body: { login: 'smuggled' },
  });
  const guestDel = await api(port, '/api/access/llowevad', guestToken, { method: 'DELETE' });

  check('AN ALLOWED USER CANNOT ADD ANOTHER -- one invitation is not the whole hub', () => {
    assert.strictEqual(guestAdd.status, 403, JSON.stringify(guestAdd));
    assert.ok(!auth.allowedUsers.includes('smuggled'), 'a guest granted access to a stranger');
  });

  check('an allowed user cannot remove anyone', () => {
    assert.strictEqual(guestDel.status, 403);
    assert.ok(auth.allowedUsers.includes('llowevad'));
  });

  check('an allowed user cannot even read the list', () => {
    // Who has access to a system is worth something to whoever is deciding
    // whom to phish, and a guest has no reason to need it.
    assert.strictEqual(guestRead.status, 403);
  });

  check('the refusal is 403, not 404 -- the caller is signed in and the route exists', () => {
    assert.match(String(guestAdd.body.error), /owner/);
  });

  const ownerRemoval = await api(port, '/api/access/swigerb', ownerToken, { method: 'DELETE' });
  check('an owner cannot remove themselves through the API', () => {
    assert.strictEqual(ownerRemoval.status, 400, JSON.stringify(ownerRemoval));
    assert.ok(auth.owner.includes('swigerb'));
  });

  const configuredRemoval = await api(port, '/api/access/llowevad', ownerToken, { method: 'DELETE' });
  check('a deployment-configured user cannot be removed through the API', () => {
    assert.strictEqual(configuredRemoval.status, 400);
    assert.match(String(configuredRemoval.body.error), /SQUAD_HUB_ALLOWED_USERS/);
    assert.ok(auth.allowedUsers.includes('llowevad'));
  });

  const junk = await api(port, '/api/access', ownerToken, {
    method: 'POST', body: { login: '<img src=x onerror=alert(1)>' },
  });
  check('an identity that could never match anyone is refused, not stored', () => {
    assert.strictEqual(junk.status, 400);
  });

  const noBody = await api(port, '/api/access', ownerToken, { method: 'POST', body: {} });
  check('a request with no login is refused rather than throwing', () => {
    assert.strictEqual(noBody.status, 400);
  });

  const anon = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/access' }, (res) => resolve({ status: res.statusCode }))
      .on('error', () => resolve({ status: 0 }));
  });
  check('an unauthenticated caller gets nothing', () => {
    assert.strictEqual(anon.status, 401);
  });

  // The identity travels in the path deliberately. A DELETE carrying a body is
  // not reliably delivered -- Node answers 400 to its own client for a chunked
  // DELETE and the handler sees an empty body. This asserts the route does not
  // quietly go back to depending on one.
  await api(port, '/api/access', ownerToken, { method: 'POST', body: { login: 'pathtest' } });
  const viaBody = await api(port, '/api/access', ownerToken, {
    method: 'DELETE', body: { login: 'pathtest' },
  });
  check('removal does not depend on a DELETE body arriving', () => {
    assert.notStrictEqual(viaBody.status, 200,
      'the route accepted a body-carrying DELETE, which is not reliably delivered');
    assert.ok(auth.allowedUsers.includes('pathtest'), 'someone was removed by an unreliable route');
  });

  const viaPath = await api(port, '/api/access/pathtest', ownerToken, { method: 'DELETE' });
  check('removal by path works', () => {
    assert.strictEqual(viaPath.status, 200, JSON.stringify(viaPath));
    assert.ok(!auth.allowedUsers.includes('pathtest'));
  });

  // An email address is a perfectly ordinary identity and contains characters
  // that need encoding in a path.
  await api(port, '/api/access', ownerToken, { method: 'POST', body: { login: 'dave.wollerman@outlook.com' } });
  const encoded = await api(port, `/api/access/${encodeURIComponent('dave.wollerman@outlook.com')}`, ownerToken, { method: 'DELETE' });
  check('an identity with an @ in it can be removed', () => {
    assert.strictEqual(encoded.status, 200, JSON.stringify(encoded));
    assert.ok(!auth.allowedUsers.includes('dave.wollerman@outlook.com'));
  });

  await svc.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
