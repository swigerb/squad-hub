#!/usr/bin/env node
'use strict';
/**
 * Session `lastActivityAt` and `pullRequest`.
 *
 * `lastActivityAt` enables "Latest/First updated" sorting (#169): it moves on
 * a real status change or new tool calls (a higher `toolCallCount`, carried
 * on every heartbeat), and MUST NOT move on a read, or on a device
 * re-publishing an unchanged session (which happens on every heartbeat and
 * reconnect -- see the `endedAt` note in `src/service/store.js`).
 *
 * `pullRequest` is reported by a device the hub does not control, so it is
 * validated exactly as device metadata is (`src/device-meta.js`): a wrong
 * type, an oversize field, a non-GitHub-pull-request URL, or an
 * injection-shaped string is rejected outright, as a whole -- a pull request
 * is one fact with three parts, not a bag of independently-droppable fields.
 */

const assert = require('assert');

const { Store } = require('../src/service/store');
const { sanitizePullRequest } = require('../src/pull-request');

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

(async () => {
  // -------------------------------------------------------------------------
  // lastActivityAt
  // -------------------------------------------------------------------------

  check('a brand-new session is stamped with lastActivityAt', () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    const before = Date.now();
    const rec = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'starting' });
    assert.ok(rec.lastActivityAt >= before, 'lastActivityAt should be stamped on creation');
  });

  await checkAsync('a status change bumps lastActivityAt', async () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    const first = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'starting' });
    await new Promise((r) => setTimeout(r, 20));
    const second = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'active' });
    assert.ok(second.lastActivityAt > first.lastActivityAt, 'a status change should move lastActivityAt forward');
  });

  await checkAsync('an unchanged status on re-publish does NOT bump lastActivityAt', async () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    const first = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'active', prompt: 'first' });
    await new Promise((r) => setTimeout(r, 20));
    // A heartbeat/reconnect republish: same status, something cosmetic changed.
    const second = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'active', prompt: 'first (re-sent)' });
    assert.strictEqual(second.lastActivityAt, first.lastActivityAt, 're-publishing the same status must not look like new activity');
  });

  await checkAsync('a transcript push bumps lastActivityAt without a status change', async () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    const first = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'active' });
    // `touchSessionActivity` mutates the stored record in place, so the
    // timestamp has to be captured BEFORE the touch -- `first` and `touched`
    // below end up being the very same object, and comparing a field to
    // itself would always pass for the wrong reason.
    const beforeTouch = first.lastActivityAt;
    await new Promise((r) => setTimeout(r, 20));
    const touched = s.touchSessionActivity('u', 'd1', 'sess-1');
    assert.ok(touched.lastActivityAt > beforeTouch, 'a transcript push is activity');
    assert.strictEqual(touched.status, 'active', 'status itself is untouched by a transcript push');
  });

  check('a transcript push for an unknown session is a no-op, not a throw', () => {
    const s = new Store();
    assert.strictEqual(s.touchSessionActivity('u', 'd1', 'nope'), null);
  });

  await checkAsync('reading sessions never bumps lastActivityAt', async () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    const rec = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'active' });
    const stamped = rec.lastActivityAt;
    await new Promise((r) => setTimeout(r, 20));
    s.listSessions('u');
    s.getSession('u', 'd1:sess-1');
    s.overview('u');
    const after = s.getSession('u', 'd1:sess-1');
    assert.strictEqual(after.lastActivityAt, stamped, 'reads must never be mistaken for activity');
  });

  await checkAsync('syncSessions (bulk republish) does not bump lastActivityAt for an unchanged status', async () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    s.syncSessions('u', 'd1', [{ id: 'sess-1', status: 'active' }]);
    const first = s.getSession('u', 'd1:sess-1');
    await new Promise((r) => setTimeout(r, 20));
    s.syncSessions('u', 'd1', [{ id: 'sess-1', status: 'active' }]);
    const second = s.getSession('u', 'd1:sess-1');
    assert.strictEqual(second.lastActivityAt, first.lastActivityAt);
  });

  await checkAsync('new tool calls reported on a heartbeat republish bump lastActivityAt', async () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    s.syncSessions('u', 'd1', [{ id: 'sess-1', status: 'active', toolCallCount: 3 }]);
    const first = s.getSession('u', 'd1:sess-1').lastActivityAt;
    await new Promise((r) => setTimeout(r, 20));
    s.syncSessions('u', 'd1', [{ id: 'sess-1', status: 'active', toolCallCount: 3 }]);
    assert.strictEqual(s.getSession('u', 'd1:sess-1').lastActivityAt, first, 'the same tool count is not new activity');
    await new Promise((r) => setTimeout(r, 20));
    s.syncSessions('u', 'd1', [{ id: 'sess-1', status: 'active', toolCallCount: 4 }]);
    assert.ok(s.getSession('u', 'd1:sess-1').lastActivityAt > first, 'a busy session in an unchanged status is still activity');
  });

  await checkAsync('a session saved before lastActivityAt existed keeps its own age on the next heartbeat', async () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    s.upsertSession('u', 'd1', { id: 'sess-1', status: 'active' });
    // Shape the stored record like one persisted by a hub that predates the field.
    const stored = s._bucket('u').sessions.get('d1:sess-1');
    delete stored.lastActivityAt;
    stored.firstSeen = Date.now() - 3600 * 1000;
    await new Promise((r) => setTimeout(r, 20));
    const rec = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'active' });
    assert.strictEqual(rec.lastActivityAt, stored.firstSeen, 'an unchanged legacy session must not look freshly active after an upgrade');
  });

  // -------------------------------------------------------------------------
  // pullRequest validation
  // -------------------------------------------------------------------------

  check('a valid pull request survives', () => {
    const pr = sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191, title: 'Session lastActivityAt and pullRequest' });
    assert.deepStrictEqual(pr, { url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191, title: 'Session lastActivityAt and pullRequest' });
  });

  check('a valid pull request with no title survives, title null', () => {
    const pr = sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191 });
    assert.deepStrictEqual(pr, { url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191, title: null });
  });

  check('a non-GitHub URL is rejected', () => {
    assert.strictEqual(sanitizePullRequest({ url: 'https://evil.example.com/pull/1', number: 1 }), null);
  });

  check('a GitHub URL that is not a pull request is rejected', () => {
    assert.strictEqual(sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/issues/191', number: 191 }), null);
    assert.strictEqual(sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub', number: 191 }), null);
  });

  check('http (not https) is rejected', () => {
    assert.strictEqual(sanitizePullRequest({ url: 'http://github.com/swigerb/squad-hub/pull/191', number: 191 }), null);
  });

  check('a number that is not a positive integer is rejected', () => {
    assert.strictEqual(sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/pull/191', number: 0 }), null);
    assert.strictEqual(sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/pull/191', number: -1 }), null);
    assert.strictEqual(sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/pull/191', number: 1.5 }), null);
  });

  check('a number sent as a string is rejected, not coerced', () => {
    assert.strictEqual(sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/pull/191', number: '191' }), null);
  });

  check('a pull request number that does not match its URL is rejected', () => {
    assert.strictEqual(sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/pull/5', number: 999 }), null);
  });

  check('a non-string title is rejected, whole object', () => {
    assert.strictEqual(sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191, title: 12345 }), null);
  });

  check('an oversize title is rejected, whole object', () => {
    const title = 'x'.repeat(201);
    assert.strictEqual(sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191, title }), null);
    const ok = sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191, title: 'x'.repeat(200) });
    assert.ok(ok, 'exactly the cap should still be accepted');
  });

  check('an injection-shaped title is rejected', () => {
    assert.strictEqual(sanitizePullRequest({
      url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191, title: '<script>alert(1)</script>',
    }), null);
    assert.strictEqual(sanitizePullRequest({
      url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191, title: 'ok\x1b[31mred',
    }), null);
  });

  check('an injection-shaped or oversize url is rejected', () => {
    assert.strictEqual(sanitizePullRequest({ url: 'https://github.com/swigerb/squad-hub/pull/191\x00', number: 191 }), null);
    assert.strictEqual(sanitizePullRequest({ url: `https://github.com/${'a'.repeat(400)}/pull/1`, number: 1 }), null);
  });

  check('not-an-object input is rejected', () => {
    assert.strictEqual(sanitizePullRequest(null), null);
    assert.strictEqual(sanitizePullRequest(undefined), null);
    assert.strictEqual(sanitizePullRequest('https://github.com/swigerb/squad-hub/pull/191'), null);
    assert.strictEqual(sanitizePullRequest(['https://github.com/swigerb/squad-hub/pull/191', 191]), null);
  });

  check('the store validates pullRequest on upsert and clears it on an invalid resend', () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    const rec = s.upsertSession('u', 'd1', {
      id: 'sess-1',
      status: 'active',
      pullRequest: { url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191, title: 'Add lastActivityAt' },
    });
    assert.deepStrictEqual(rec.pullRequest, { url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191, title: 'Add lastActivityAt' });

    const bad = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'active', pullRequest: { url: 'javascript:alert(1)', number: 1 } });
    assert.strictEqual(bad.pullRequest, null, 'an invalid resend clears rather than keeping the stale value or crashing');
  });

  check('the store keeps a previously-valid pullRequest when a later update omits the field', () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    s.upsertSession('u', 'd1', {
      id: 'sess-1',
      status: 'active',
      pullRequest: { url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191 },
    });
    // Next publish says nothing about pullRequest at all -- not every device
    // message needs to re-state everything it already told the hub.
    const rec = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'waiting_approval' });
    assert.deepStrictEqual(rec.pullRequest, { url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191, title: null });
  });

  check('the store clears pullRequest when a device explicitly sends null', () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    s.upsertSession('u', 'd1', {
      id: 'sess-1',
      status: 'active',
      pullRequest: { url: 'https://github.com/swigerb/squad-hub/pull/191', number: 191 },
    });
    const rec = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'active', pullRequest: null });
    assert.strictEqual(rec.pullRequest, null);
  });

  check('a session with no pullRequest ever sent defaults to null, not undefined', () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    const rec = s.upsertSession('u', 'd1', { id: 'sess-1', status: 'active' });
    assert.strictEqual(rec.pullRequest, null);
  });

  check('a non-object session payload does not throw on the pullRequest check', () => {
    const s = new Store();
    s.registerDevice('u', { deviceId: 'd1', name: 'laptop', platform: 'linux' });
    assert.doesNotThrow(() => s.upsertSession('u', 'd1', 'not-a-session'));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(`ERROR: ${e.message}`);
  console.log(e.stack);
  process.exit(1);
});
