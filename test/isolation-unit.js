'use strict';
/**
 * Per-user isolation.
 *
 * THE ABANDON CONDITION. If one user can see or control another user's device
 * or session, nothing internet-reachable gets deployed. Everything else in this
 * sprint is plumbing; this is the part that decides whether it ships.
 *
 * The tests use TWO REAL PRINCIPALS with distinct tenant and object ids, each
 * driving a real daemon over a real WebSocket to a real HTTP service. Not two
 * variables in one process pretending to be users.
 *
 * Attacks asserted against, not just the happy path:
 *   - reading another user's overview
 *   - naming another user's device id directly on a control route
 *   - forging a token
 *   - connecting a device socket with no token at all
 *   - tampering with a valid token's claims
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const { HubService } = require('../src/service/hub-service');
const { Authenticator, MODES } = require('../src/service/auth');
const { HubLink } = require('../src/hub-link');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(port, path, token, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      port, path, method: opts.method || 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, raw: b, headers: res.headers });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

(async () => {
  const secret = crypto.randomBytes(16).toString('hex');
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: secret });
  const svc = new HubService({ auth, serveWeb: false });
  const addr = await svc.listen(0, '127.0.0.1');
  const port = addr.port;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  // Two genuinely different principals, in different tenants.
  const alice = { tid: '11111111-1111-1111-1111-111111111111', oid: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Alice' };
  const bob = { tid: '22222222-2222-2222-2222-222222222222', oid: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Bob' };
  const aliceToken = auth.mintDevToken(alice.tid, alice.oid, alice.name);
  const bobToken = auth.mintDevToken(bob.tid, bob.oid, bob.name);

  console.log(`service on 127.0.0.1:${port}`);

  // -- each identity is distinct -------------------------------------------
  const meA = await api(port, '/api/me', aliceToken);
  const meB = await api(port, '/api/me', bobToken);
  check('two identities resolve to two different subjects', () => {
    assert.strictEqual(meA.status, 200, JSON.stringify(meA));
    assert.strictEqual(meB.status, 200, JSON.stringify(meB));
    assert.notStrictEqual(meA.body.subject, meB.body.subject);
  });

  // -- real device connections ---------------------------------------------
  const linkA = new HubLink({ url: wsUrl, token: aliceToken, deviceId: 'alice-laptop' });
  const linkB = new HubLink({ url: wsUrl, token: bobToken, deviceId: 'bob-devbox' });
  await linkA.connect();
  await linkB.connect();

  linkA.send({
    type: 'register',
    device: { name: 'ALICE-LAPTOP', platform: 'win32', fileAccess: 'off' },
    sessions: [{ id: 's1', status: 'active', activity: 'Processing...', prompt: 'alice secret work', cwd: '/alice/repo', pendingApprovals: [] }],
  });
  linkB.send({
    type: 'register',
    device: { name: 'BOB-DEVBOX', platform: 'linux', fileAccess: 'off' },
    sessions: [{ id: 's9', status: 'active', activity: 'Processing...', prompt: 'bob secret work', cwd: '/bob/repo', pendingApprovals: [] }],
  });
  await sleep(400);

  const ovA = await api(port, '/api/overview', aliceToken);
  const ovB = await api(port, '/api/overview', bobToken);

  check('each user sees exactly their own device', () => {
    assert.deepStrictEqual(ovA.body.devices.map((d) => d.deviceId), ['alice-laptop']);
    assert.deepStrictEqual(ovB.body.devices.map((d) => d.deviceId), ['bob-devbox']);
  });

  check("no trace of the other user's device appears anywhere in the payload", () => {
    assert.ok(!JSON.stringify(ovA.body).includes('bob'), 'bob leaked into alice\'s overview');
    assert.ok(!JSON.stringify(ovB.body).includes('alice'), 'alice leaked into bob\'s overview');
  });

  check("no trace of the other user's session content appears", () => {
    assert.ok(!JSON.stringify(ovA.body).includes('bob secret work'));
    assert.ok(!JSON.stringify(ovB.body).includes('alice secret work'));
  });

  // The overview groups sessions under devices, so a cross-user session would
  // be dropped by grouping even if the store leaked it. /api/sessions returns
  // the list unmediated, which is where a leak actually shows.
  const listA = await api(port, '/api/sessions', aliceToken);
  const listB = await api(port, '/api/sessions', bobToken);
  check('the raw session list is scoped to the caller', () => {
    assert.deepStrictEqual(listA.body.sessions.map((s) => s.id), ['s1'], JSON.stringify(listA.body));
    assert.deepStrictEqual(listB.body.sessions.map((s) => s.id), ['s9'], JSON.stringify(listB.body));
  });
  check('the raw session list carries no other user content', () => {
    assert.ok(!JSON.stringify(listA.body).includes('bob secret work'), 'bob\'s prompt leaked to alice');
    assert.ok(!JSON.stringify(listB.body).includes('alice secret work'), 'alice\'s prompt leaked to bob');
  });

  // -- naming another user's device directly --------------------------------
  // Bob's device records anything it is asked to do, so we can assert the
  // command never ARRIVED -- not merely that Alice got an error. A refusal that
  // still delivered the command would be the worst of both.
  let bobReceived = [];
  linkB.on('command', (m) => { bobReceived.push(m); linkB.reply(m.correlationId, true, { stopped: true }); });

  const cross = await api(port, '/api/devices/bob-devbox/stop', aliceToken, {
    method: 'POST', body: { sessionId: 's9' },
  });
  await sleep(300);

  check("naming another user's device by id is refused", () => {
    assert.notStrictEqual(cross.status, 200, `alice reached bob's device: ${JSON.stringify(cross)}`);
    assert.strictEqual(bobReceived.length, 0,
      `THE COMMAND STILL ARRIVED at bob's device: ${JSON.stringify(bobReceived)}`);
  });
  check('the refusal does not reveal that the device exists', () => {
    assert.strictEqual(cross.status, 404, `expected 404 (indistinguishable from absent), got ${cross.status}`);
  });

  // Prove the same route DOES work for the owner, so the 404 above is about
  // ownership and not a broken route.
  const own = await api(port, '/api/devices/bob-devbox/stop', bobToken, {
    method: 'POST', body: { sessionId: 's9' },
  });
  await checkAsync('the same route works for the owner', async () => {
    assert.strictEqual(own.status, 200, `the owner was refused too: ${JSON.stringify(own)}`);
    assert.strictEqual(bobReceived.length, 1, 'the owner\'s command did not arrive');
  });

  // -- token attacks --------------------------------------------------------
  const noToken = await api(port, '/api/overview', null);
  check('no token is rejected', () => assert.strictEqual(noToken.status, 401));

  const garbage = await api(port, '/api/overview', 'not-a-token');
  check('a garbage token is rejected', () => assert.strictEqual(garbage.status, 401));

  const forged = (() => {
    const body = Buffer.from(JSON.stringify({ tid: bob.tid, oid: bob.oid })).toString('base64url');
    const badSig = crypto.createHmac('sha256', 'the-wrong-secret').update(body).digest('base64url');
    return `${body}.${badSig}`;
  })();
  const forgedRes = await api(port, '/api/overview', forged);
  check("a token forged with the wrong secret is rejected", () => {
    assert.strictEqual(forgedRes.status, 401, `a forged token was ACCEPTED: ${JSON.stringify(forgedRes)}`);
  });

  const tampered = (() => {
    const [body, sig] = aliceToken.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    claims.oid = bob.oid; // keep alice's signature, claim to be bob
    const newBody = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${newBody}.${sig}`;
  })();
  const tamperedRes = await api(port, '/api/overview', tampered);
  check("swapping the subject while keeping a valid signature is rejected", () => {
    assert.strictEqual(tamperedRes.status, 401, `tampered claims were ACCEPTED: ${JSON.stringify(tamperedRes)}`);
  });

  // -- websocket without a token -------------------------------------------
  await checkAsync('a device socket with no token is refused', async () => {
    const bad = new HubLink({ url: wsUrl, token: '', deviceId: 'intruder' });
    let refused = false;
    try { await bad.connect(); } catch { refused = true; }
    bad.stop();
    assert.ok(refused, 'an unauthenticated device socket was accepted');
  });

  await checkAsync('a device socket with a forged token is refused', async () => {
    const bad = new HubLink({ url: wsUrl, token: forged, deviceId: 'intruder2' });
    let refused = false;
    try { await bad.connect(); } catch { refused = true; }
    bad.stop();
    assert.ok(refused, 'a forged device socket was accepted');
  });

  // The intruder must not have landed in anyone's store.
  const ovA2 = await api(port, '/api/overview', aliceToken);
  const ovB2 = await api(port, '/api/overview', bobToken);
  check('a refused device appears in nobody\'s device list', () => {
    const all = JSON.stringify(ovA2.body) + JSON.stringify(ovB2.body);
    assert.ok(!all.includes('intruder'), 'a refused device was registered anyway');
  });

  // -- presence -------------------------------------------------------------
  check('a device that has just heartbeated is online', () => {
    assert.strictEqual(ovA2.body.devices[0].presence, 'online');
  });

  await checkAsync('presence decays to stale, then offline', async () => {
    const { Store } = require('../src/service/store');
    const s = new Store({ staleAfterMs: 120, offlineAfterMs: 260 });
    s.registerDevice('u1', { deviceId: 'd', name: 'D', platform: 'linux' });
    assert.strictEqual(s.listDevices('u1')[0].presence, 'online');
    await sleep(170);
    assert.strictEqual(s.listDevices('u1')[0].presence, 'stale', 'never became stale');
    await sleep(170);
    assert.strictEqual(s.listDevices('u1')[0].presence, 'offline', 'never became offline');
    s.heartbeat('u1', 'd');
    assert.strictEqual(s.listDevices('u1')[0].presence, 'online', 'a heartbeat did not restore presence');
  });

  check('an unscoped store read is refused outright', () => {
    const { Store } = require('../src/service/store');
    const s = new Store();
    assert.throws(() => s.listDevices(undefined), /subject is required/);
    assert.throws(() => s.listSessions(null), /subject is required/);
  });

  // A redeploy registered a second copy of the same container app, because the
  // device id keyed off the replica name. The roster filled with phantoms.
  check('a long-offline device with no sessions is forgotten', () => {
    const { Store } = require('../src/service/store');
    const s = new Store({ staleAfterMs: 20, offlineAfterMs: 40, forgetAfterMs: 60 });
    s.registerDevice('u1', { deviceId: 'ghost', name: 'Old Revision', platform: 'linux' });
    s.registerDevice('u1', { deviceId: 'live', name: 'Current', platform: 'linux' });
    assert.strictEqual(s.listDevices('u1').length, 2);

    // Age the ghost past the forget threshold, keep the other one beating.
    s._bucket('u1').devices.get('ghost').lastSeen = Date.now() - 5000;
    s.heartbeat('u1', 'live');

    const names = s.listDevices('u1').map((d) => d.name);
    assert.deepStrictEqual(names, ['Current'], `the phantom survived: ${JSON.stringify(names)}`);
  });

  check('an offline device that still has sessions is KEPT', () => {
    const { Store } = require('../src/service/store');
    const s = new Store({ forgetAfterMs: 60 });
    s.registerDevice('u1', { deviceId: 'd1', name: 'Slept', platform: 'linux' });
    s.upsertSession('u1', 'd1', { id: 's1', status: 'done' });
    s._bucket('u1').devices.get('d1').lastSeen = Date.now() - 5000;
    assert.strictEqual(s.listDevices('u1').length, 1,
      'a device was forgotten while its sessions were still listed, orphaning them');
  });

  // -- control round trip ---------------------------------------------------
  await checkAsync('a command reaches the owning device and its reply returns', async () => {
    linkA.removeAllListeners('command');
    let got = null;
    linkA.on('command', (m) => { got = m; linkA.reply(m.correlationId, true, { answered: true, echo: m.optionId }); });
    const r = await api(port, '/api/devices/alice-laptop/approve', aliceToken, {
      method: 'POST', body: { sessionId: 's1', approvalId: 'a1', optionId: 'allow_once' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(got, 'the device never received the command');
    assert.strictEqual(got.op, 'approve');
    assert.strictEqual(r.body.echo, 'allow_once');
  });

  await checkAsync('a device that refuses a command surfaces the refusal, not a success', async () => {
    linkA.removeAllListeners('command');
    linkA.on('command', (m) => linkA.reply(m.correlationId, false, 'no such pending approval'));
    const r = await api(port, '/api/devices/alice-laptop/approve', aliceToken, {
      method: 'POST', body: { sessionId: 's1', approvalId: 'nope', optionId: 'allow_once' },
    });
    assert.notStrictEqual(r.status, 200, 'a refusal was reported as success');
    assert.match(JSON.stringify(r.body), /no such pending approval/);
  });

  // -- the second layer, tested directly ------------------------------------
  // The ownership check above stops a cross-user request before routing is
  // reached, which means routing's own partitioning is never exercised by an
  // API call. Test it directly, so both layers are proven rather than one
  // hiding the other.
  await checkAsync('command routing refuses a device the subject does not own', async () => {
    let reached = false;
    try {
      await svc.command(meA.body.subject, 'bob-devbox', 'stop', { sessionId: 's9' }, 2000);
      reached = true;
    } catch (e) {
      assert.match(e.message, /not connected/i, `unexpected failure: ${e.message}`);
    }
    assert.ok(!reached, "routing delivered alice's command to bob's device");
  });

  await checkAsync('command routing still works within the same subject', async () => {
    linkB.removeAllListeners('command');
    linkB.on('command', (m) => linkB.reply(m.correlationId, true, { ok: true }));
    const r = await svc.command(meB.body.subject, 'bob-devbox', 'stop', { sessionId: 's9' }, 5000);
    assert.deepStrictEqual(r, { ok: true });
  });

  // -- keepalive ------------------------------------------------------------
  // Proxies close connections that carry no traffic; App Service does so at
  // ~240s. A browser watching an idle hub sends and receives nothing, so
  // without a server-side ping it is dropped and reconnects showing stale data.
  await checkAsync('the service pings idle connections to keep them alive', async () => {
    const { HubService: HS } = require('../src/service/hub-service');
    const a2 = new Authenticator({ mode: MODES.DEV, devSecret: 'ka' });
    // A short interval so the test is quick; the mechanism is what is asserted.
    const svc2 = new HS({ auth: a2, serveWeb: false, keepaliveMs: 250 });
    const addr2 = await svc2.listen(0, '127.0.0.1');
    const tok2 = a2.mintDevToken('local', 'ka', 'KA');

    const link = new HubLink({ url: `ws://127.0.0.1:${addr2.port}/ws`, token: tok2, deviceId: 'ka-dev' });
    await link.connect();

    // Count ping frames arriving at the client.
    let pings = 0;
    const conn = link.conn;
    const originalHandle = conn._handleFrame.bind(conn);
    conn._handleFrame = (f) => { if (f.opcode === 0x9) pings += 1; return originalHandle(f); };

    await sleep(900);
    assert.ok(pings >= 2, `only ${pings} pings arrived in 900ms at a 250ms interval`);

    link.stop();
    await svc2.close();
  });

  await checkAsync('a ping is answered with a pong, so the peer stays satisfied', async () => {
    const { WsConnection } = require('../src/service/ws');
    // Drive the frame machinery directly rather than over a socket: the point
    // is the protocol response, not the transport.
    const sent = [];
    const fake = { write: (b) => sent.push(b), destroyed: false, on: () => {}, end: () => {} };
    const c = new WsConnection(fake);
    c._handleFrame({ fin: true, opcode: 0x9, payload: Buffer.from('hi') });
    assert.strictEqual(sent.length, 1, 'a ping produced no reply');
    assert.strictEqual(sent[0][0] & 0x0f, 0xa, `expected a pong (0xa), got opcode ${sent[0][0] & 0x0f}`);
  });

  await checkAsync('a pong is accepted silently', async () => {
    const { WsConnection } = require('../src/service/ws');
    const sent = [];
    const fake = { write: (b) => sent.push(b), destroyed: false, on: () => {}, end: () => {} };
    const c = new WsConnection(fake);
    c._handleFrame({ fin: true, opcode: 0xa, payload: Buffer.alloc(0) });
    assert.strictEqual(sent.length, 0, 'a pong provoked a reply, which would loop');
  });

  // -- scale-out guard ------------------------------------------------------
  // The failure this warns about is silent: at two instances the device list is
  // simply wrong about half the time, with nothing anywhere saying why.
  await checkAsync('a single instance produces NO warning', async () => {
    const { HubService: HS } = require('../src/service/hub-service');
    const a3 = new Authenticator({ mode: MODES.DEV, devSecret: 's1' });
    const saved = process.env.SQUAD_HUB_INSTANCE_COUNT;
    delete process.env.SQUAD_HUB_INSTANCE_COUNT;
    const s3 = new HS({ auth: a3, serveWeb: false });
    const ad3 = await s3.listen(0, '127.0.0.1');
    const t3 = a3.mintDevToken('local', 'one', 'One');
    try {
      // Authenticated: the health detail is no longer volunteered to strangers.
      const h = await api(ad3.port, '/healthz', t3);
      assert.strictEqual(h.body.scaleOutWarning, null, `warned at one instance: ${h.body.scaleOutWarning}`);
      const me = await api(ad3.port, '/api/me', t3);
      assert.strictEqual(me.body.warning, null, 'the UI would show a false alarm');
    } finally {
      if (saved !== undefined) process.env.SQUAD_HUB_INSTANCE_COUNT = saved;
      await s3.close();
    }
  });

  await checkAsync('several instances DO produce a warning', async () => {
    const { HubService: HS } = require('../src/service/hub-service');
    const a4 = new Authenticator({ mode: MODES.DEV, devSecret: 's2' });
    process.env.SQUAD_HUB_INSTANCE_COUNT = '3';
    const s4 = new HS({ auth: a4, serveWeb: false });
    const ad4 = await s4.listen(0, '127.0.0.1');
    const t4 = a4.mintDevToken('local', 'many', 'Many');
    try {
      const h = await api(ad4.port, '/healthz', t4);
      assert.strictEqual(h.body.instances, 3);
      assert.ok(h.body.scaleOutWarning, 'healthz did not warn at three instances');
      assert.match(h.body.scaleOutWarning, /3 instances/);

      const me = await api(ad4.port, '/api/me', t4);
      assert.ok(me.body.warning, 'the UI would show nothing');
      // The warning must say what to DO, not merely that something is wrong.
      assert.match(me.body.warning, /single instance/i, 'the warning offers no remedy');
    } finally {
      delete process.env.SQUAD_HUB_INSTANCE_COUNT;
      await s4.close();
    }
  });

  await checkAsync('an unknown instance count does not raise a false alarm', async () => {
    // ACA and Kubernetes do not expose a count. Warning there would be noise on
    // every deployment, and noise is how a real warning gets ignored.
    const { HubService: HS } = require('../src/service/hub-service');
    const a5 = new Authenticator({ mode: MODES.DEV, devSecret: 's3' });
    delete process.env.SQUAD_HUB_INSTANCE_COUNT;
    delete process.env.WEBSITE_INSTANCE_COUNT;
    const s5 = new HS({ auth: a5, serveWeb: false });
    const ad5 = await s5.listen(0, '127.0.0.1');
    const t5 = a5.mintDevToken('local', 'unk', 'Unk');
    try {
      const h = await api(ad5.port, '/healthz', t5);
      assert.strictEqual(h.body.instances, null);
      assert.strictEqual(h.body.scaleOutWarning, null);
    } finally { await s5.close(); }
  });

  // -- who is allowed to use this hub at all --------------------------------
  // A tenant filter is not an owner filter. Without this, anyone holding the
  // dev secret can mint any identity, and any user in an allowed Entra tenant
  // can register a device. Measured against a live deployment before it existed.
  await checkAsync('with an allowlist, a permitted user is admitted', async () => {
    const a6 = new Authenticator({ mode: MODES.DEV, devSecret: 'al', allowedUsers: ['owner@example.com'] });
    const p = await a6.verify(`Bearer ${a6.mintDevToken('t', 'oid-1', 'owner@example.com')}`);
    assert.strictEqual(p.name, 'owner@example.com');
  });

  await checkAsync('an allowlist admits by object id as well as by name', async () => {
    const a7 = new Authenticator({ mode: MODES.DEV, devSecret: 'al', allowedUsers: ['oid-1'] });
    const p = await a7.verify(`Bearer ${a7.mintDevToken('t', 'oid-1', 'Someone')}`);
    assert.strictEqual(p.oid, 'oid-1');
  });

  await checkAsync('matching is case-insensitive, because a UPN typed by hand will not match', async () => {
    const a8 = new Authenticator({ mode: MODES.DEV, devSecret: 'al', allowedUsers: ['Owner@Example.COM'] });
    const p = await a8.verify(`Bearer ${a8.mintDevToken('t', 'oid-1', 'owner@example.com')}`);
    assert.ok(p);
  });

  await checkAsync('an identity NOT on the allowlist is refused, with a valid signature', async () => {
    const a9 = new Authenticator({ mode: MODES.DEV, devSecret: 'al', allowedUsers: ['owner@example.com'] });
    // The token is perfectly signed. The person is simply not permitted -- which
    // is the whole point, and the case a signature check alone cannot cover.
    let err = null;
    try { await a9.verify(`Bearer ${a9.mintDevToken('t', 'oid-2', 'stranger@example.com')}`); }
    catch (e) { err = e; }
    assert.ok(err, 'a stranger with a validly signed token was admitted');
    assert.strictEqual(err.status, 403, `expected 403 (valid credential, not permitted), got ${err.status}`);
  });

  await checkAsync('an empty allowlist admits anyone, which is the documented default', async () => {
    const a10 = new Authenticator({ mode: MODES.DEV, devSecret: 'al' });
    const p = await a10.verify(`Bearer ${a10.mintDevToken('any', 'anyone', 'Anyone')}`);
    assert.ok(p, 'the default should not lock a laptop out of its own hub');
  });

  await checkAsync('the allowlist is enforced on the DEVICE SOCKET, not only on the API', async () => {
    // The socket is the route that actually matters: registering a device is
    // what an intruder would want, and it authenticates through a query string
    // rather than a header. Testing only the REST path would miss it entirely.
    const { HubService: HS } = require('../src/service/hub-service');
    const a11 = new Authenticator({ mode: MODES.DEV, devSecret: 'sock', allowedUsers: ['owner@example.com'] });
    const s11 = new HS({ auth: a11, serveWeb: false });
    const ad11 = await s11.listen(0, '127.0.0.1');
    try {
      const strangerToken = a11.mintDevToken('t', 'oid-9', 'stranger@example.com');
      const bad = new HubLink({ url: `ws://127.0.0.1:${ad11.port}/ws`, token: strangerToken, deviceId: 'rogue' });
      let refused = false;
      try { await bad.connect(); } catch { refused = true; }
      bad.stop();
      assert.ok(refused, 'a non-allowlisted identity registered a device');
    } finally { await s11.close(); }
  });

  // -- what a stranger can read without any credential ----------------------
  await checkAsync('anonymous /healthz says only that the service is up', async () => {
    const { HubService: HS } = require('../src/service/hub-service');
    const a12 = new Authenticator({ mode: MODES.DEV, devSecret: 'hz' });
    const s12 = new HS({ auth: a12, serveWeb: false });
    const ad12 = await s12.listen(0, '127.0.0.1');
    try {
      const anon = await api(ad12.port, '/healthz', null);
      assert.strictEqual(anon.status, 200, 'a liveness probe must still work without a token');
      assert.deepStrictEqual(Object.keys(anon.body), ['ok'],
        `anonymous healthz volunteered: ${Object.keys(anon.body).join(', ')}`);
      // Each of these tells a stranger something: whether you are working right
      // now, and which published bugs to try.
      for (const leak of ['devices', 'version', 'build', 'instance']) {
        assert.ok(!(leak in anon.body), `"${leak}" is exposed anonymously`);
      }

      const authed = await api(ad12.port, '/healthz', a12.mintDevToken('t', 'o', 'O'));
      assert.ok('devices' in authed.body, 'an authenticated caller lost the detail it needs');
      assert.ok('build' in authed.body, 'the deploy check needs the build id');
    } finally { await s12.close(); }
  });

  // -- one person, several accounts -----------------------------------------
  // Partitioning is keyed on tenant + object id, so a single human with a work
  // account and a personal one gets two partitions: two hubs sharing a URL,
  // where devices registered by one identity are invisible to the other.
  await checkAsync('WITHOUT owner aliasing, two accounts of one person are two partitions', async () => {
    const a13 = new Authenticator({ mode: MODES.DEV, devSecret: 'own', allowedUsers: ['work@a.com', 'personal@b.com'] });
    const p1 = await a13.verify(`Bearer ${a13.mintDevToken('tenant-a', 'oid-1', 'work@a.com')}`);
    const p2 = await a13.verify(`Bearer ${a13.mintDevToken('tenant-b', 'oid-2', 'personal@b.com')}`);
    assert.notStrictEqual(p1.key, p2.key,
      'this test no longer demonstrates the problem it exists to describe');
  });

  await checkAsync('WITH owner aliasing, both accounts share one partition', async () => {
    const a14 = new Authenticator({ mode: MODES.DEV, devSecret: 'own', owner: ['work@a.com', 'personal@b.com'] });
    const p1 = await a14.verify(`Bearer ${a14.mintDevToken('tenant-a', 'oid-1', 'work@a.com')}`);
    const p2 = await a14.verify(`Bearer ${a14.mintDevToken('tenant-b', 'oid-2', 'personal@b.com')}`);
    assert.strictEqual(p1.key, p2.key,
      'the two accounts still see different devices, which is the whole point');
    assert.ok(p1.isOwner && p2.isOwner);
  });

  await checkAsync('the owner partition survives adding a third identity', async () => {
    // Keyed on a constant, not on any one alias -- otherwise adding an account
    // later would orphan every device already registered.
    const two = new Authenticator({ mode: MODES.DEV, devSecret: 'own', owner: ['a@x.com', 'b@y.com'] });
    const three = new Authenticator({ mode: MODES.DEV, devSecret: 'own', owner: ['a@x.com', 'b@y.com', 'c@z.com'] });
    const before = await two.verify(`Bearer ${two.mintDevToken('t', 'o', 'a@x.com')}`);
    const after = await three.verify(`Bearer ${three.mintDevToken('t', 'o', 'a@x.com')}`);
    assert.strictEqual(before.key, after.key, 'adding an alias moved the partition and orphaned the devices');
  });

  await checkAsync('reordering the owner list does not move the partition', async () => {
    const one = new Authenticator({ mode: MODES.DEV, devSecret: 'own', owner: ['a@x.com', 'b@y.com'] });
    const other = new Authenticator({ mode: MODES.DEV, devSecret: 'own', owner: ['b@y.com', 'a@x.com'] });
    const k1 = (await one.verify(`Bearer ${one.mintDevToken('t', 'o', 'a@x.com')}`)).key;
    const k2 = (await other.verify(`Bearer ${other.mintDevToken('t', 'o', 'b@y.com')}`)).key;
    assert.strictEqual(k1, k2);
  });

  await checkAsync('someone not listed as owner is still refused', async () => {
    const a15 = new Authenticator({ mode: MODES.DEV, devSecret: 'own', owner: ['work@a.com'] });
    let err = null;
    try { await a15.verify(`Bearer ${a15.mintDevToken('t', 'oid-9', 'stranger@c.com')}`); }
    catch (e) { err = e; }
    assert.ok(err, 'a stranger was admitted');
    assert.strictEqual(err.status, 403);
  });

  await checkAsync('an owner and a separate allowed user do NOT share a partition', async () => {
    // A colleague on the allowlist is a different person and must keep their
    // own devices. Aliasing applies only to the owner's own identities.
    const a16 = new Authenticator({
      mode: MODES.DEV, devSecret: 'own',
      owner: ['me@a.com'], allowedUsers: ['colleague@a.com'],
    });
    const me = await a16.verify(`Bearer ${a16.mintDevToken('t', 'oid-1', 'me@a.com')}`);
    const them = await a16.verify(`Bearer ${a16.mintDevToken('t', 'oid-2', 'colleague@a.com')}`);
    assert.notStrictEqual(me.key, them.key, 'a colleague was folded into the owner partition');
    assert.strictEqual(me.isOwner, true);
    assert.strictEqual(them.isOwner, false);
  });

  // -- the pages a person actually lands on ---------------------------------
  // These need a web-serving hub; the isolation service above deliberately has
  // static serving off.
  await checkAsync('the pages a person lands on', async () => {
    const { HubService: HS } = require('../src/service/hub-service');
    const aw = new Authenticator({ mode: MODES.DEV, devSecret: 'web' });
    const sw = new HS({ auth: aw, serveWeb: true });
    const adw = await sw.listen(0, '127.0.0.1');
    const p = adw.port;
    try {
      const miss = await api(p, '/no-such-page', null);
      assert.strictEqual(miss.status, 404);
      assert.match(miss.headers['content-type'] || '', /text\/html/,
        'a person who mistyped a URL got JSON, which reads as a broken site');
      assert.match(miss.raw, /404/);
      assert.match(miss.raw, /Squad Hub/);
      assert.match(miss.raw, /logo\.jpg/, 'the 404 page does not show the logo');
      assert.match(miss.raw, /Back to the hub/);

      // A script wants something it can parse. HTML here breaks the caller's
      // error handling for no benefit. (Authenticated, because the API surface
      // deliberately refuses anonymous callers before it routes at all.)
      const tokw = aw.mintDevToken('t1', 'u1', 'someone');
      const apiMiss = await api(p, '/api/nothing-here', tokw);
      assert.strictEqual(apiMiss.status, 404);
      assert.match(apiMiss.headers['content-type'] || '', /application\/json/);

      // An anonymous caller must not be able to enumerate which API routes
      // exist by reading 404 vs 401.
      const apiAnon = await api(p, '/api/nothing-here', null);
      assert.strictEqual(apiAnon.status, 401,
        'an unauthenticated caller can probe for valid API routes');

      // Both the 404 page and the sign-in page reference it.
      const logo = await api(p, '/logo.jpg', null);
      assert.strictEqual(logo.status, 200, 'the logo 404s, so both pages render broken');
      assert.match(logo.headers['content-type'] || '', /image\/jpeg/,
        'served as a generic byte stream, which browsers may download rather than draw');

      const methods = await api(p, '/api/auth-methods', null);
      assert.strictEqual(methods.status, 200, 'the sign-in page cannot ask what to offer');
      assert.ok('githubOAuth' in methods.body, 'no way to know whether to show a button');

      // Rather than a 500, or a redirect to a broken GitHub URL.
      const login = await api(p, '/auth/github/login', null);
      assert.strictEqual(login.status, 404);
    } finally { await sw.close(); }
  });

  linkA.stop(); linkB.stop();
  await svc.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
