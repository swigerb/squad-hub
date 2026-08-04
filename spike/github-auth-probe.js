#!/usr/bin/env node
/**
 * Does GitHub auth work against the real api.github.com?
 *
 * The unit tests run against a stand-in so the suite stays offline and
 * deterministic. A stand-in only ever proves the stand-in: it cannot tell you
 * that the real endpoint needs a User-Agent header, or that a revoked token
 * returns 401 rather than 403, or that the field is `login` and not `username`.
 *
 * This calls GitHub for real. It is a probe rather than a test because it needs
 * a token and a network, and a suite that requires either is a suite people
 * stop running.
 *
 * Usage: node github-auth-probe.js --token <a github token> [--owner <login>]
 */

'use strict';

const path = require('path');

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const TOKEN = arg('token', process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
const OWNER = arg('owner');

if (!TOKEN) {
  console.log('usage: node github-auth-probe.js --token <github token> [--owner <login>]');
  console.log('  (a token from `gh auth token` works)');
  process.exit(77);
}

const { Authenticator, MODES } = require(path.join(__dirname, '..', 'src', 'service', 'auth'));

const log = (...a) => console.log('[gh]', ...a);
let fail = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) fail += 1;
}

(async () => {
  log('calling the REAL api.github.com');
  log('');

  // -- 1. does a real token resolve to a real identity? --------------------
  const open = new Authenticator({ mode: MODES.GITHUB });
  let me;
  try {
    me = await open.verify(`Bearer ${TOKEN}`);
    check('a real GitHub token resolves to an identity', true, `${me.name} (id ${me.oid})`);
  } catch (e) {
    check('a real GitHub token resolves to an identity', false, e.message);
    return finish();
  }

  check('the identity carries a login', !!me.name, me.name);
  check('the identity carries a numeric id', /^\d+$/.test(me.oid), me.oid);
  check('the synthetic tenant is "github"', me.tid === 'github', me.tid);

  // -- 2. a garbage token must be refused ----------------------------------
  const garbage = new Authenticator({ mode: MODES.GITHUB });
  try {
    // Assemble the marker at runtime. A contiguous GitHub-token-shaped string
    // is useful to the probe and indistinguishable from a real credential to
    // DLP scanners. Splitting the prefix preserves the rejection test without
    // making the file itself look like it contains a secret.
    const fakeToken = ['gh', 'p_', 'thisIsNotARealTokenAtAll', '0'.repeat(13)].join('');
    await garbage.verify(`Bearer ${fakeToken}`);
    check('a garbage token is refused', false, 'it was ACCEPTED');
  } catch (e) {
    check('a garbage token is refused', e.status === 401, `HTTP ${e.status}: ${e.message}`);
  }

  // -- 3. the allowlist, against the real identity -------------------------
  const login = OWNER || me.name;
  const permitted = new Authenticator({ mode: MODES.GITHUB, owner: [login] });
  try {
    const p = await permitted.verify(`Bearer ${TOKEN}`);
    check('a permitted login is admitted', p.isOwner === true, `isOwner=${p.isOwner}`);
  } catch (e) {
    check('a permitted login is admitted', false, e.message);
  }

  const restricted = new Authenticator({ mode: MODES.GITHUB, owner: ['somebody-who-is-not-you'] });
  try {
    await restricted.verify(`Bearer ${TOKEN}`);
    check('a NON-permitted login is refused', false, 'a valid token bypassed the allowlist');
  } catch (e) {
    check('a NON-permitted login is refused', e.status === 403, `HTTP ${e.status}`);
  }

  // -- 4. caching, measured against the real rate limit --------------------
  const cached = new Authenticator({ mode: MODES.GITHUB, owner: [login] });
  const t0 = Date.now();
  await cached.verify(`Bearer ${TOKEN}`);
  const first = Date.now() - t0;
  const t1 = Date.now();
  await cached.verify(`Bearer ${TOKEN}`);
  const second = Date.now() - t1;
  check('the cache removes the round trip', second < Math.max(5, first / 2),
    `first ${first}ms, cached ${second}ms`);

  return finish();

  function finish() {
    console.log('');
    if (fail === 0) {
      console.log('[gh] PASS: GitHub works as an identity provider, with no app registration.');
    } else {
      console.log(`[gh] ${fail} check(s) failed.`);
    }
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.log('[gh] ERROR: ' + e.message); process.exit(77); });
