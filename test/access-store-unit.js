'use strict';
/**
 * Who may use this hub, and who may decide that.
 *
 * The allow-list became editable at runtime, which turns three quiet
 * assumptions into things that must be asserted. Each of these, if it were
 * wrong, would be a privilege escalation that looks like a working feature:
 *
 *   1. An ALLOWED USER must not be able to add another. Otherwise one
 *      invitation is the whole hub, transitively, and the owner never sees it.
 *   2. An OWNER must not be grantable through the API. Owner identities share
 *      ONE partition -- adding an owner does not admit a colleague, it makes
 *      them you, with your devices and sessions.
 *   3. The DEPLOYMENT'S OWN LIST must survive anything done through the UI,
 *      including the mistake of removing yourself.
 *
 * Most of what follows is a refusal, on purpose. The interesting behaviour of
 * an access-control surface is what it will not do.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AccessStore, normalise } = require('../src/service/access-store');

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

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sqh-access-'));
}
function store(opts = {}) {
  return new AccessStore({
    dir: tmpdir(), envAllowed: ['llowevad'], envOwner: ['swigerb'], ...opts,
  });
}

// --- the environment is a floor ---------------------------------------------

check('an owner cannot be removed through the store', () => {
  const s = store();
  const r = s.remove('swigerb');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /SQUAD_HUB_OWNER/, 'the refusal does not say where the entry comes from');
  assert.ok(s.allowedUsers().length >= 1);
});

check('a deployment-configured user cannot be removed through the store', () => {
  const s = store();
  const r = s.remove('llowevad');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /SQUAD_HUB_ALLOWED_USERS/);
  assert.ok(s.allowedUsers().includes('llowevad'), 'the entry was removed anyway');
});

check('removing the last added user cannot empty the deployment list', () => {
  const s = store();
  s.add('guest');
  s.remove('guest');
  assert.deepStrictEqual(s.allowedUsers().sort(), ['llowevad']);
});

check('the environment list is present with no file at all', () => {
  const s = new AccessStore({ dir: tmpdir(), envAllowed: ['a', 'b'], envOwner: ['o'] });
  assert.deepStrictEqual(s.allowedUsers().sort(), ['a', 'b']);
  assert.strictEqual(s.ok, true, 'a hub that has never added anyone is not broken');
});

// --- owners are not grantable ------------------------------------------------

check('adding an identity that is already an owner is refused, not silently merged', () => {
  // The dangerous version of this is not an error -- it is a success that
  // appears to grant access and actually says "you are me".
  const r = store().add('swigerb');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /owner/);
});

check('there is no way to add an owner at all', () => {
  const s = store();
  // The store exposes add/remove and nothing else. If an `addOwner` ever
  // appears, this fails and somebody has to justify it.
  const surface = Object.getOwnPropertyNames(AccessStore.prototype).filter((n) => n !== 'constructor');
  const grants = surface.filter((n) => /owner/i.test(n) && !/^_/.test(n));
  assert.deepStrictEqual(grants, [], `the store exposes owner-granting methods: ${grants.join(', ')}`);
  assert.ok(!s.list().some((u) => u.source === 'owner' && u.removable));
});

// --- what the list says about itself ----------------------------------------

check('a row that cannot be removed says so before anyone clicks', () => {
  const s = store();
  s.add('guest');
  const rows = s.list();
  const byLogin = Object.fromEntries(rows.map((r) => [r.login, r]));
  assert.strictEqual(byLogin.swigerb.removable, false);
  assert.strictEqual(byLogin.swigerb.source, 'owner');
  assert.strictEqual(byLogin.llowevad.removable, false);
  assert.strictEqual(byLogin.llowevad.source, 'deployment');
  assert.strictEqual(byLogin.guest.removable, true);
  assert.strictEqual(byLogin.guest.source, 'added');
});

check('an identity in both the environment and the file appears once, as the stronger', () => {
  const dir = tmpdir();
  const s = new AccessStore({ dir, envAllowed: [], envOwner: ['swigerb'] });
  // Simulate a file written before the identity was promoted to owner.
  s._added.set('swigerb', { addedBy: 'someone', addedAt: 1, note: null });
  const rows = s.list().filter((r) => r.login === 'swigerb');
  assert.strictEqual(rows.length, 1, 'the identity is listed twice');
  assert.strictEqual(rows[0].source, 'owner');
  assert.strictEqual(rows[0].removable, false);
});

check('who added someone, and when, is recorded', () => {
  const s = store();
  s.add('guest', { addedBy: 'swigerb', note: 'testing the hub' });
  const row = s.list().find((r) => r.login === 'guest');
  assert.strictEqual(row.addedBy, 'swigerb');
  assert.ok(row.addedAt > 0);
  assert.strictEqual(row.note, 'testing the hub');
});

// --- what is a valid identity -----------------------------------------------

check('an identity outside the alphabet is refused at the door', () => {
  // Storing one would add a row that LOOKS like access and grants none,
  // because nothing the authenticator compares against could ever match it.
  for (const bad of ['', '   ', 'a b', 'a/b', '<script>', 'a\nb', 'a,b', 'a;b']) {
    const r = store().add(bad);
    assert.strictEqual(r.ok, false, `"${bad}" was accepted`);
  }
});

check('the shapes the deployment list already accepts are accepted here too', () => {
  // A list you can edit two ways has to mean the same thing both ways.
  for (const good of ['someone', 'dave.wollerman@outlook.com', 'user+tag@example.com',
    '11111111-2222-3333-4444-555555555555', 'first.last@contoso.onmicrosoft.com']) {
    const r = store().add(good);
    assert.strictEqual(r.ok, true, `"${good}" was refused: ${r.reason}`);
  }
});

check('an absurdly long identity is refused rather than stored', () => {
  assert.strictEqual(store().add('a'.repeat(500)).ok, false);
});

check('identities are matched case-insensitively, so one person is not two rows', () => {
  const s = store();
  assert.strictEqual(s.add('Guest').ok, true);
  assert.strictEqual(s.add('guest').ok, false, 'the same person was added twice under different case');
  assert.ok(s.allowedUsers().includes('guest'));
});

check('a note cannot become unbounded storage', () => {
  const s = store();
  s.add('guest', { note: 'x'.repeat(5000) });
  assert.ok(s.list().find((r) => r.login === 'guest').note.length <= 200);
});

// --- durability --------------------------------------------------------------

check('a grant survives a restart', () => {
  const dir = tmpdir();
  const a = new AccessStore({ dir, envAllowed: [], envOwner: ['swigerb'] });
  a.add('guest', { addedBy: 'swigerb' });
  const b = new AccessStore({ dir, envAllowed: [], envOwner: ['swigerb'] });
  assert.ok(b.allowedUsers().includes('guest'), 'the grant was forgotten across a restart');
});

check('a removal survives a restart too', () => {
  const dir = tmpdir();
  const a = new AccessStore({ dir, envAllowed: [], envOwner: ['swigerb'] });
  a.add('guest');
  a.remove('guest');
  const b = new AccessStore({ dir, envAllowed: [], envOwner: ['swigerb'] });
  assert.ok(!b.allowedUsers().includes('guest'), 'a removed user came back after a restart');
});

check('an unreadable list refuses to be written over, rather than starting empty', () => {
  // Starting from empty here would silently revoke everyone who had been
  // added -- the failure would look like a working hub with fewer people on it.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'access.json'), '{ this is not json');
  const s = new AccessStore({ dir, envAllowed: ['llowevad'], envOwner: ['swigerb'] });
  assert.strictEqual(s.ok, false, 'a corrupt file was treated as fine');
  const r = s.add('guest');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /could not be read/);
  // The floor still holds, so the hub is usable by whoever the deployment says.
  assert.ok(s.allowedUsers().includes('llowevad'));
});

check('a file of the wrong shape is treated as unreadable, not trusted', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify({ added: { evil: {} } }));
  const s = new AccessStore({ dir, envAllowed: [], envOwner: ['swigerb'] });
  assert.strictEqual(s.ok, false, 'a file with no shape marker was loaded anyway');
  assert.ok(!s.allowedUsers().includes('evil'), 'an unversioned file granted someone access');
});

check('a memory-only store works, and says it is not durable', () => {
  const s = new AccessStore({ dir: null, envAllowed: [], envOwner: ['swigerb'] });
  assert.strictEqual(s.persist, false);
  assert.strictEqual(s.add('guest').ok, true);
  assert.ok(s.allowedUsers().includes('guest'));
});

// --- normalise, directly -----------------------------------------------------

check('normalise lowercases and trims, so the stored form is the compared form', () => {
  assert.strictEqual(normalise('  SwigerB  ').value, 'swigerb');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
