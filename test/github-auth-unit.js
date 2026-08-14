'use strict';
/**
 * GitHub as an identity provider.
 *
 * This exists because an Entra app registration needs tenant-admin cooperation
 * that many people cannot get. Without an alternative they are left running a
 * hub on a shared secret, where anyone holding the secret is anyone.
 *
 * A GitHub token needs no registration of any kind: the token is the
 * credential and GitHub is the authority.
 *
 * The tests below run against a local stand-in for api.github.com so the suite
 * stays offline and deterministic. The real endpoint is proven separately by
 * spike/github-auth-probe.js, which calls GitHub for real -- a mock alone would
 * only prove the mock.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const { Authenticator, MODES, AuthError } = require('../src/service/auth');

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

/**
 * A stand-in for GitHub. Counts calls, so the caching claims can be asserted
 * rather than asserted-about.
 */
function fakeGitHub(users) {
  const calls = { total: 0, byToken: {} };
  const server = http.createServer((req, res) => {
    calls.total += 1;
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    calls.byToken[tok] = (calls.byToken[tok] || 0) + 1;
    if (!req.headers['user-agent']) { res.writeHead(403); return res.end('{"message":"no UA"}'); }
    const u = users[tok];
    if (!u) { res.writeHead(401); return res.end('{"message":"Bad credentials"}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(u));
  });
  return { server, calls };
}

/** Point the authenticator at the stand-in instead of api.github.com. */
function withFakeGitHub(auth, port) {
  auth._verifyGitHubFetch = (token) => new Promise((resolve, reject) => {
    const req = http.request({
      // The stand-in listens on 127.0.0.1. Omitting `host` defaults to
      // `localhost`, which can resolve to ::1; Node 20+ papers over that with
      // Happy Eyeballs, Node 18 fails with ECONNREFUSED.
      host: '127.0.0.1',
      port, path: '/user', headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'squad-hub' },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error(`GitHub returned ${res.statusCode}`), { status: res.statusCode }));
        try { resolve(JSON.parse(b)); } catch { reject(new Error('bad json')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const users = {
    'tok-owner': {
      id: 111, login: 'owner-login', email: 'owner@example.com',
      avatar_url: 'https://avatars.githubusercontent.com/u/111?v=4',
    },
    'tok-other': { id: 222, login: 'someone-else', email: null },
    'tok-renamed': { id: 111, login: 'owner-renamed', email: null },
    'tok-bad-avatar': {
      id: 333, login: 'bad-avatar', email: null,
      avatar_url: 'https://attacker.example/avatar.png',
    },
  };
  const { server, calls } = fakeGitHub(users);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const make = (opts = {}) => {
    const a = new Authenticator({ mode: MODES.GITHUB, ...opts });
    withFakeGitHub(a, port);
    return a;
  };

  await checkAsync('a valid GitHub token resolves to that GitHub identity', async () => {
    const a = make();
    const p = await a.verify('Bearer tok-owner');
    assert.strictEqual(p.name, 'owner-login');
    assert.strictEqual(p.oid, '111');
    assert.strictEqual(p.tid, 'github');
    assert.strictEqual(p.avatar, 'https://avatars.githubusercontent.com/u/111?v=4');
  });

  await checkAsync('only a GitHub-hosted avatar is kept', async () => {
    // /api/me is consumed by the browser as an image URL. Do not turn an
    // identity response into a general-purpose third-party request primitive.
    const a = make();
    const p = await a.verify('Bearer tok-bad-avatar');
    assert.strictEqual(p.avatar, null,
      'an arbitrary avatar host was handed to the browser');
  });

  await checkAsync('an invalid token is refused', async () => {
    const a = make();
    let err = null;
    try { await a.verify('Bearer nonsense'); } catch (e) { err = e; }
    assert.ok(err, 'a bad token was accepted');
    assert.strictEqual(err.status, 401);
  });

  await checkAsync('a token with no Bearer prefix is refused', async () => {
    const a = make();
    let err = null;
    try { await a.verify('tok-owner'); } catch (e) { err = e; }
    assert.ok(err);
  });

  await checkAsync('the owner list admits by GitHub login', async () => {
    const a = make({ owner: ['owner-login'] });
    const p = await a.verify('Bearer tok-owner');
    assert.strictEqual(p.isOwner, true);
  });

  await checkAsync('the owner list also admits the numeric github:<id> form (F-2)', async () => {
    // A login can be changed or reused by someone else; the numeric id
    // cannot. `github:<id>` must be accepted as an alias for the same
    // identity, and it must keep working across a rename -- the whole point
    // of anchoring to the id instead of the mutable name.
    const a = make({ owner: [`github:111`] });
    const p = await a.verify(['Bear', 'er tok-owner'].join(''));
    assert.strictEqual(p.isOwner, true, 'the numeric github:<id> owner form was not recognised');
  });

  await checkAsync('the github:<id> owner form survives a login rename', async () => {
    const a = make({ owner: ['github:111'] });
    const before = await a.verify(['Bear', 'er tok-owner'].join(''));
    const after = await a.verify(['Bear', 'er tok-renamed'].join(''));
    assert.strictEqual(before.isOwner, true);
    assert.strictEqual(after.isOwner, true,
      'renaming the GitHub account dropped ownership pinned by id (F-2)');
  });

  await checkAsync('a GitHub identity NOT on the list is refused with 403', async () => {
    const a = make({ owner: ['owner-login'] });
    let err = null;
    try { await a.verify('Bearer tok-other'); } catch (e) { err = e; }
    assert.ok(err, 'a stranger with a VALID GitHub token was admitted');
    assert.strictEqual(err.status, 403, 'the credential was valid; the person is not permitted');
  });

  await checkAsync('the partition follows the numeric id, not the login', async () => {
    // A login can be changed or reused. Anchoring a partition to a mutable name
    // would hand a renamed account someone else's devices.
    const a = make({ owner: ['owner-login', 'owner-renamed'] });
    const before = await a.verify('Bearer tok-owner');
    const after = await a.verify('Bearer tok-renamed');
    assert.strictEqual(before.key, after.key,
      'renaming the GitHub account moved the partition and orphaned its devices');
  });

  await checkAsync('a GitHub identity cannot collide with an Entra one', async () => {
    const gh = make({ owner: ['owner-login'] });
    const ghKey = (await gh.verify('Bearer tok-owner')).key;
    // An Entra principal that happens to share the object id.
    const dev = new Authenticator({ mode: MODES.DEV, devSecret: 'x' });
    const entraKey = (await dev.verify(`Bearer ${dev.mintDevToken('some-tenant', '111', 'x')}`)).key;
    assert.notStrictEqual(ghKey, entraKey, 'a GitHub id collided with an Entra object id');
  });

  await checkAsync('a GitHub account and a work account can share one owner view', async () => {
    // The reason this provider exists: one person, accounts in unrelated
    // identity systems, one hub.
    const gh = make({ owner: ['owner-login', 'you@work.example'] });
    const ghPrincipal = await gh.verify('Bearer tok-owner');
    const dev = new Authenticator({ mode: MODES.DEV, devSecret: 'x', owner: ['owner-login', 'you@work.example'] });
    const workPrincipal = await dev.verify(`Bearer ${dev.mintDevToken('corp', 'oid-9', 'you@work.example')}`);
    assert.strictEqual(ghPrincipal.key, workPrincipal.key,
      'the two accounts of one person still see different devices');
  });

  // -- caching --------------------------------------------------------------
  await checkAsync('a repeated token does not call GitHub again', async () => {
    const a = make({ owner: ['owner-login'] });
    const before = calls.byToken['tok-owner'] || 0;
    await a.verify('Bearer tok-owner');
    await a.verify('Bearer tok-owner');
    await a.verify('Bearer tok-owner');
    const spent = (calls.byToken['tok-owner'] || 0) - before;
    assert.strictEqual(spent, 1, `spent ${spent} GitHub calls for three requests`);
  });

  await checkAsync('a REJECTED token is also cached, so the hub is not an amplifier', async () => {
    // Without this, anyone can make this hub issue a GitHub API call per guess,
    // at our rate limit, on their behalf.
    const a = make();
    const before = calls.byToken['bad-guess'] || 0;
    for (let i = 0; i < 5; i += 1) {
      try { await a.verify('Bearer bad-guess'); } catch { /* expected */ }
    }
    const spent = (calls.byToken['bad-guess'] || 0) - before;
    assert.strictEqual(spent, 1, `five guesses cost ${spent} GitHub calls`);
  });

  await checkAsync('the cache expires, so a revoked token stops working', async () => {
    const a = make({ owner: ['owner-login'], githubCacheMs: 60 });
    const before = calls.byToken['tok-owner'] || 0;
    await a.verify('Bearer tok-owner');
    await new Promise((r) => setTimeout(r, 120));
    await a.verify('Bearer tok-owner');
    const spent = (calls.byToken['tok-owner'] || 0) - before;
    assert.strictEqual(spent, 2, 'the cache never expired; a revoked token would work forever');
  });

  check('the cache is keyed on a hash, never the raw token', () => {
    const a = make({ owner: ['owner-login'] });
    return a.verify('Bearer tok-owner').then(() => {
      const keys = [...a._ghCache.keys()];
      assert.ok(keys.length > 0, 'nothing was cached');
      for (const k of keys) {
        assert.ok(!k.includes('tok-owner'), 'a raw GitHub token is sitting in memory as a cache key');
        assert.match(k, /^[a-f0-9]{64}$/, 'the cache key is not a sha256 hash');
      }
    });
  });

  await checkAsync('a dev token is refused in github mode', async () => {
    // Modes are exclusive. A helpful fallback is how auth gets bypassed.
    const a = make();
    const dev = new Authenticator({ mode: MODES.DEV, devSecret: 'x' });
    let err = null;
    try { await a.verify(`Bearer ${dev.mintDevToken('t', 'o', 'n')}`); } catch (e) { err = e; }
    assert.ok(err, 'a dev token authenticated against a GitHub-mode hub');
  });

  await checkAsync('GitHub being unreachable is a 503, not a silent admission', async () => {
    const a = new Authenticator({ mode: MODES.GITHUB });
    // Point at a port nothing is listening on.
    a._verifyGitHubFetch = () => Promise.reject(Object.assign(new Error('ECONNREFUSED'), { status: 0 }));
    let err = null;
    try { await a.verify('Bearer anything'); } catch (e) { err = e; }
    assert.ok(err, 'an unreachable GitHub let someone in');
    assert.strictEqual(err.status, 503, 'a transport failure was reported as an auth failure');
  });

  await checkAsync('a transport failure is NOT cached', async () => {
    // GitHub being briefly unreachable must not lock the owner out for the
    // whole cache window.
    const a = new Authenticator({ mode: MODES.GITHUB, owner: ['owner-login'] });
    let attempts = 0;
    a._verifyGitHubFetch = () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(Object.assign(new Error('down'), { status: 0 }));
      return Promise.resolve({ id: 111, login: 'owner-login' });
    };
    try { await a.verify('Bearer tok-owner'); } catch { /* expected */ }
    const p = await a.verify('Bearer tok-owner');
    assert.strictEqual(p.name, 'owner-login', 'a brief outage locked the owner out');
  });

  // ---- the browser sign-in flow -------------------------------------------
  // A token works for a CLI. A browser needs a button, and the button is worth
  // nothing if the flow it starts can be forged or replayed.
  const { GitHubOAuth } = require('../src/service/github-oauth');
  const REQ = { headers: { host: 'hub.example', 'x-forwarded-proto': 'https' } };

  check('a half-configured OAuth App leaves the hub usable, not broken', () => {
    // Setting only the id is an easy mistake. It must not produce a button that
    // sends people to a GitHub error page.
    assert.strictEqual(new GitHubOAuth({}).enabled, false);
    assert.strictEqual(new GitHubOAuth({ clientId: 'a' }).enabled, false);
    assert.strictEqual(new GitHubOAuth({ clientSecret: 'b' }).enabled, false);
    assert.strictEqual(new GitHubOAuth({ clientId: 'a', clientSecret: 'b' }).enabled, true);
  });

  const oa = new GitHubOAuth({ clientId: 'cid', clientSecret: 'sec' });

  check('the authorize URL asks for no scopes at all', () => {
    // Identity is all the hub needs. Requesting repo scope would mean a hub
    // breach exposed the user's source, for no functional gain.
    const u = new URL(oa.authorizeUrl(REQ).url);
    assert.strictEqual(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
    assert.strictEqual(u.searchParams.get('scope'), '', 'the flow requests access it does not need');
    assert.strictEqual(u.searchParams.get('client_id'), 'cid');
    assert.ok(u.searchParams.get('state'), 'no state means login CSRF is unguarded');
  });

  check('the callback URL follows the proxy, not the socket', () => {
    // App Service terminates TLS, so the request arrives as http. Deriving the
    // redirect from the socket would build an http:// callback that GitHub
    // rejects for not matching the registered one.
    assert.strictEqual(oa.redirectUri(REQ), 'https://hub.example/auth/github/callback');
    const cfg = new GitHubOAuth({ clientId: 'c', clientSecret: 's', publicUrl: 'https://fixed.example/' });
    assert.strictEqual(cfg.redirectUri(REQ), 'https://fixed.example/auth/github/callback',
      'a trailing slash in the configured URL produced a double slash');
  });

  check('state that this hub issued is accepted', () => {
    assert.strictEqual(oa.checkState(oa.makeState()), true);
  });

  check('state that this hub did not issue is refused', () => {
    // The whole point: a state minted anywhere else must not pass.
    const other = new GitHubOAuth({ clientId: 'cid', clientSecret: 'sec' });
    assert.strictEqual(oa.checkState(other.makeState()), false,
      'any hub could start a sign-in this hub would complete');
    assert.strictEqual(oa.checkState('a.b.c'), false);
    assert.strictEqual(oa.checkState(''), false);
    assert.strictEqual(oa.checkState(null), false);
    assert.strictEqual(oa.checkState(undefined), false);
  });

  check('a tampered state is refused rather than throwing', () => {
    // timingSafeEqual throws on a length mismatch, which would surface as a 500
    // and, worse, as an unhandled rejection.
    const s = oa.makeState();
    const parts = s.split('.');
    assert.strictEqual(oa.checkState(`${parts[0]}.${parts[1]}.short`), false);
    assert.strictEqual(oa.checkState(`${parts[0]}.${parts[1]}.${'x'.repeat(24)}`), false);
    assert.strictEqual(oa.checkState(`tampered.${parts[1]}.${parts[2]}`), false);
  });

  check('a captured state cannot be replayed a day later', () => {
    const s = oa.makeState();
    assert.strictEqual(oa.checkState(s, 600000), true);
    assert.strictEqual(oa.checkState(s, -1), false, 'state never expires');
  });

  check('a restart invalidates in-flight sign-ins rather than trusting them', () => {
    // The signing key is per-process on purpose: it means no long-lived secret
    // has to be stored anywhere for this.
    const s = oa.makeState();
    const restarted = new GitHubOAuth({ clientId: 'cid', clientSecret: 'sec' });
    assert.strictEqual(restarted.checkState(s), false);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR: ' + e.message); console.log(e.stack); process.exit(1); });
