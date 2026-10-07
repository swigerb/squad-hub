'use strict';
/**
 * Approval cards from a device that is gone.
 *
 * Reported against 0.6.0 before publish: a laptop whose terminal was shut down
 * left its approval card on the hub. Refreshing the page brought it straight
 * back, answering it failed with "device is offline", and the only way out
 * was to forget the device from its dropdown.
 *
 * A pending approval is a handle onto one live agent process (issue #91,
 * sanitiseSessionForDisk). The hub already honoured that across its own
 * restart; these tests hold it to the same rule when the DEVICE goes away --
 * cleanly, by token revocation, or silently (power off, network drop) -- and
 * check that a device which comes back, or merely reconnects, loses nothing.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const { HubService } = require('../src/service/hub-service');
const { Authenticator, MODES } = require('../src/service/auth');
const { HubLink } = require('../src/hub-link');

let pass = 0; let fail = 0;
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

/** Poll until `fn` returns truthy. Under a loaded CI box a fixed sleep is a flake. */
async function waitFor(fn, what, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const actionNeeded = async (h) => (await api(h.port, '/api/overview', h.token)).body.counts.actionNeeded;

function api(port, path, token) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end();
  });
}

const APPROVAL = {
  approvalId: 'ap-1',
  title: 'shell: npm test',
  requestedAt: Date.now(),
  options: [{ optionId: 'allow_once', name: 'Allow' }, { optionId: 'reject_once', name: 'Deny' }],
};

function waitingSession() {
  return {
    id: 's1', status: 'waiting_approval', activity: 'Waiting for input',
    prompt: 'run the tests', cwd: '/repo', pendingApprovals: [APPROVAL],
  };
}

async function hub(opts = {}) {
  const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex') });
  const svc = new HubService({ auth, serveWeb: false, ...opts });
  const addr = await svc.listen(0, '127.0.0.1');
  const token = auth.mintDevToken('local', crypto.randomUUID(), 'Tester');
  return { svc, port: addr.port, token, wsUrl: `ws://127.0.0.1:${addr.port}/ws` };
}

async function deviceWithApproval(h, deviceId = 'laptop') {
  const link = new HubLink({ url: h.wsUrl, token: h.token, deviceId });
  await link.connect();
  link.send({ type: 'register', device: { name: deviceId.toUpperCase(), platform: 'win32' }, sessions: [waitingSession()] });
  await waitFor(async () => {
    const ov = await api(h.port, '/api/overview', h.token);
    return ov.body.groups.some((g) => g.device.deviceId === deviceId && g.sessions.some((s) => (s.pendingApprovals || []).length));
  }, `${deviceId} to publish its approval`);
  return link;
}

const session = (ov) => ov.body.groups.flatMap((g) => g.sessions).find((s) => s.id === 's1');

(async () => {
  await checkAsync('precondition: a connected device shows its approval as needing action', async () => {
    const h = await hub();
    const link = await deviceWithApproval(h);
    const ov = await api(h.port, '/api/overview', h.token);
    assert.strictEqual(ov.body.counts.actionNeeded, 1);
    assert.strictEqual(session(ov).pendingApprovals.length, 1);
    link.stop();
    await h.svc.close();
  });

  await checkAsync('a device that disconnects cleanly no longer offers its approval, even after a refresh', async () => {
    const h = await hub();
    const link = await deviceWithApproval(h);
    link.stop();
    await waitFor(async () => (await actionNeeded(h)) === 0, 'the hub to notice the disconnect');

    for (const attempt of ['first load', 'refresh']) {
      const ov = await api(h.port, '/api/overview', h.token);
      const s = session(ov);
      assert.strictEqual(ov.body.counts.actionNeeded, 0, `${attempt}: still counted as needing action`);
      assert.deepStrictEqual(s.pendingApprovals, [], `${attempt}: the dead card is still offered`);
      assert.strictEqual(s.status, 'disconnected', `${attempt}: status ${s.status}`);
    }
    await h.svc.close();
  });

  await checkAsync('the lapsed card is kept as an expired approval that says the device disconnected', async () => {
    const h = await hub();
    const link = await deviceWithApproval(h);
    link.stop();
    await waitFor(async () => (await actionNeeded(h)) === 0, 'the hub to notice the disconnect');
    const s = session(await api(h.port, '/api/overview', h.token));
    assert.strictEqual(s.expiredApprovals.length, 1);
    assert.strictEqual(s.expiredApprovals[0].approvalId, 'ap-1');
    assert.strictEqual(s.expiredApprovals[0].title, 'shell: npm test');
    assert.strictEqual(s.expiredApprovals[0].reason, 'device disconnected');
    await h.svc.close();
  });

  await checkAsync('watchers are pushed the cleared state without having to refresh', async () => {
    const h = await hub();
    const link = await deviceWithApproval(h);
    // A watcher socket, the same one the web app holds open.
    const u = new URL(h.wsUrl);
    u.searchParams.set('access_token', h.token);
    u.searchParams.set('role', 'watcher');
    const overviews = [];
    const { WsConnection } = require('../src/service/ws');
    const watcher = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: h.port, path: `/ws${u.search}`,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' },
      });
      req.on('upgrade', (res, socket, head) => {
        const c = new WsConnection(socket);
        c.on('message', (m) => { if (m.type === 'overview') overviews.push(m); });
        // The hub's first overview can arrive in the same packet as the 101.
        if (head && head.length) c._onData(head);
        resolve(c);
      });
      req.on('error', reject);
      req.end();
    });
    await waitFor(() => overviews.length, 'the watcher to receive its first overview');
    overviews.length = 0;

    link.stop();
    const last = await waitFor(() => overviews.find((o) => o.counts.actionNeeded === 0),
      'a pushed overview with nothing needing action');
    assert.strictEqual(last.counts.actionNeeded, 0);
    watcher.close();
    await h.svc.close();
  });

  await checkAsync('a device that goes silent (powered off) is detected and its approval expired', async () => {
    const h = await hub({ keepaliveMs: 100, deviceDeadAfterMs: 1000 });
    const link = await deviceWithApproval(h);
    // Simulate the power going off: nothing is read or sent any more, and no
    // FIN ever arrives, so TCP alone would not notice for many minutes.
    link._stopped = true;
    link.conn.socket.pause();

    await waitFor(async () => (await actionNeeded(h)) === 0, 'the silent device to be detected as dead');
    const ov = await api(h.port, '/api/overview', h.token);
    assert.strictEqual(session(ov).status, 'disconnected');
    link.conn && link.conn.socket.destroy();
    await h.svc.close();
  });

  await checkAsync('an active session on a disconnected device no longer looks working', async () => {
    const h = await hub();
    const link = new HubLink({ url: h.wsUrl, token: h.token, deviceId: 'aca-job' });
    await link.connect();
    link.send({
      type: 'register',
      device: { name: 'ACA job', platform: 'linux', kind: 'cloud' },
      sessions: [{ id: 's1', status: 'active', activity: 'Processing...', prompt: 'review PR' }],
    });
    await waitFor(async () => {
      const ov = await api(h.port, '/api/overview', h.token);
      return session(ov) && session(ov).status === 'active';
    }, 'the active session to appear');

    link.stop();
    await waitFor(async () => {
      const ov = await api(h.port, '/api/overview', h.token);
      const s = session(ov);
      return s && s.status === 'disconnected';
    }, 'the active session to be marked disconnected');

    const s = session(await api(h.port, '/api/overview', h.token));
    assert.strictEqual(s.activity, 'Device disconnected');
    assert.ok(s.endedAt, 'the disconnected session should be retention-eligible');
    await h.svc.close();
  });

  await checkAsync('a live device is not mistaken for a dead one', async () => {
    const h = await hub({ keepaliveMs: 100, deviceDeadAfterMs: 1000 });
    const link = await deviceWithApproval(h);
    // Answers pings, sends nothing else: idle but alive, for 2.5x the limit.
    await sleep(2500);
    const ov = await api(h.port, '/api/overview', h.token);
    assert.strictEqual(ov.body.counts.actionNeeded, 1, 'an idle but responsive device lost its approval');
    assert.ok(link.connected, 'the hub dropped a device that was answering pings');
    link.stop();
    await h.svc.close();
  });

  await checkAsync('a device that reconnects (same id, new socket) keeps its approval', async () => {
    const h = await hub();
    const first = await deviceWithApproval(h);
    first._stopped = true; // the old link must not race the new one by retrying
    const second = new HubLink({ url: h.wsUrl, token: h.token, deviceId: 'laptop' });
    await second.connect();
    await sleep(150);
    // Before the new socket has republished anything: the old socket's close
    // must not have expired the card on its way out.
    const ov = await api(h.port, '/api/overview', h.token);
    assert.strictEqual(ov.body.counts.actionNeeded, 1, 'replacing the socket expired a live approval');
    second.stop();
    await h.svc.close();
  });

  await checkAsync('a device that comes back republishes any approval that is genuinely still live', async () => {
    const h = await hub();
    const link = await deviceWithApproval(h);
    link.stop();
    await waitFor(async () => (await actionNeeded(h)) === 0, 'the hub to notice the disconnect');

    const back = await deviceWithApproval(h);
    const ov = await api(h.port, '/api/overview', h.token);
    assert.strictEqual(ov.body.counts.actionNeeded, 1);
    assert.strictEqual(session(ov).status, 'waiting_approval');
    back.stop();
    await h.svc.close();
  });

  await checkAsync('other devices are untouched when one disconnects', async () => {
    const h = await hub();
    const gone = await deviceWithApproval(h, 'laptop');
    const stays = await deviceWithApproval(h, 'desktop');
    gone.stop();
    await waitFor(async () => (await actionNeeded(h)) === 1, 'the hub to notice the laptop leaving');
    const ov = await api(h.port, '/api/overview', h.token);
    const bySession = ov.body.groups.map((g) => [g.device.deviceId, g.sessions[0] && g.sessions[0].pendingApprovals.length]);
    assert.deepStrictEqual(Object.fromEntries(bySession), { laptop: 0, desktop: 1 });
    stays.stop();
    await h.svc.close();
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
