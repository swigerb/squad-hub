#!/usr/bin/env node
'use strict';
/**
 * Sprint C (#108): an append-only record of grants and revocations.
 *
 * The access list answers "who can get in now". After an incident the question
 * is "who let them in, and when" — and a list holding only current state has
 * already lost that. Somebody granted on Tuesday and removed on Thursday leaves
 * no trace at all.
 *
 * Two properties carry the weight here, and each has a test that fails when the
 * control is removed rather than merely describing it:
 *
 *   1. APPEND-ONLY. Earlier entries survive every later operation, byte for
 *      byte, and no function in the module can rewrite or shorten the file.
 *   2. A CHANGE THAT CANNOT BE RECORDED DOES NOT HAPPEN. If the log cannot be
 *      written, the grant is refused and rolled back — because an unrecorded
 *      grant is the one that hurts during an incident.
 *
 * Refused attempts are recorded too: a log of successes alone cannot show
 * somebody trying, repeatedly, to remove an owner.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AccessStore } = require(path.join(__dirname, '..', 'src', 'service', 'access-store'));
const { AccessAudit, FILE } = require(path.join(__dirname, '..', 'src', 'service', 'access-audit'));

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

function fresh({ envOwner = ['owner1'], envAllowed = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqaudit-'));
  const audit = new AccessAudit({ dir });
  const store = new AccessStore({
    dir, persist: true, envOwner, envAllowed, audit,
  });
  return { dir, audit, store, logPath: path.join(dir, FILE) };
}

// ---------------------------------------------------------------------------
// A. What gets recorded
// ---------------------------------------------------------------------------

check('a grant is recorded with who did it and when', () => {
  const { store, audit } = fresh();
  assert.ok(store.add('alice', { addedBy: 'owner1', note: 'reviewer' }).ok);

  const { entries } = audit.read();
  assert.strictEqual(entries.length, 1, JSON.stringify(entries));
  assert.strictEqual(entries[0].action, 'grant');
  assert.strictEqual(entries[0].login, 'alice');
  assert.strictEqual(entries[0].actor, 'owner1');
  assert.strictEqual(entries[0].ok, true);
  assert.ok(Date.parse(entries[0].at) > 0, `unusable timestamp: ${entries[0].at}`);
});

check('A REVOCATION IS RECORDED -- the event the list itself forgets', () => {
  const { store, audit } = fresh();
  store.add('bob', { addedBy: 'owner1' });
  assert.ok(store.remove('bob').ok);

  const { entries } = audit.read();
  assert.deepStrictEqual(entries.map((e) => `${e.action}:${e.login}`), ['grant:bob', 'revoke:bob']);
  // The list is back where it started; only the log knows bob was ever here.
  assert.ok(!store.list().some((u) => u.login === 'bob'), 'bob still has access');
});

check('A REFUSED REMOVAL IS RECORDED TOO, not just successes', () => {
  const { store, audit } = fresh();
  const r = store.remove('owner1');
  assert.strictEqual(r.ok, false, 'an owner was removable');

  const { entries } = audit.read();
  assert.strictEqual(entries.length, 1, 'the refused attempt left no trace');
  assert.strictEqual(entries[0].ok, false);
  assert.strictEqual(entries[0].login, 'owner1');
  assert.ok(/owners are set by the deployment/.test(entries[0].reason || ''), entries[0].reason);
});

check('restoring a revoked deployment identity is distinguishable from a fresh grant', () => {
  const { store, audit } = fresh({ envAllowed: ['carol'] });
  store.remove('carol');
  store.add('carol', { addedBy: 'owner1' });

  const { entries } = audit.read();
  assert.deepStrictEqual(entries.map((e) => e.action), ['revoke', 'restore']);
});

check('the log records no credential material, only who and when', () => {
  const { store, audit } = fresh();
  store.add('dave', { addedBy: 'owner1', note: 'contractor' });
  const raw = JSON.stringify(audit.read().entries);
  for (const word of ['token', 'secret', 'password', 'authorization', 'cookie']) {
    assert.ok(!raw.toLowerCase().includes(word), `the log mentions "${word}": ${raw}`);
  }
});

// ---------------------------------------------------------------------------
// B. Append-only -- the property, not the promise
// ---------------------------------------------------------------------------

check('EARLIER ENTRIES SURVIVE EVERY LATER OPERATION, byte for byte', () => {
  const { store, logPath } = fresh();
  store.add('e1', { addedBy: 'owner1' });
  store.add('e2', { addedBy: 'owner1' });
  const afterTwo = fs.readFileSync(logPath, 'utf8');

  store.remove('e1');
  store.add('e3', { addedBy: 'owner1' });
  store.remove('owner1'); // refused, still recorded

  const now = fs.readFileSync(logPath, 'utf8');
  assert.ok(now.startsWith(afterTwo), 'the earlier entries were rewritten or shortened');
  assert.ok(now.length > afterTwo.length, 'nothing was appended');
});

check('THE MODULE EXPOSES NO WAY TO REWRITE OR SHORTEN THE LOG', () => {
  // A log whose own code can rewrite it is not evidence of anything. If a
  // clear/prune/rotate is ever added, this fails and the reviewer has to argue
  // for it rather than let it arrive quietly.
  const audit = new AccessAudit({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sqaudit-')) });
  const surface = new Set([
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(audit)),
    ...Object.keys(audit),
  ]);
  for (const banned of ['clear', 'prune', 'rotate', 'truncate', 'delete', 'remove', 'write', 'rewrite']) {
    assert.ok(!surface.has(banned), `AccessAudit exposes ${banned}()`);
  }
});

check('the writer never opens the file for anything but appending', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'service', 'access-audit.js'), 'utf8');
  for (const call of ['writeFileSync', 'createWriteStream', 'truncateSync', 'unlinkSync', 'ftruncate']) {
    assert.ok(!src.includes(call), `access-audit.js calls ${call}`);
  }
  assert.ok(src.includes('appendFileSync'), 'the writer no longer appends');
});

check('a damaged line is REPORTED, because tampering just looks like a shorter file', () => {
  const { store, audit, logPath } = fresh();
  store.add('f1', { addedBy: 'owner1' });
  fs.appendFileSync(logPath, 'this is not json\n', 'utf8');

  const r = audit.read();
  assert.strictEqual(r.damaged, 1, `damaged not reported: ${JSON.stringify(r)}`);
  assert.strictEqual(r.entries.length, 1);
});

// ---------------------------------------------------------------------------
// C. A change that cannot be recorded does not happen
// ---------------------------------------------------------------------------

check('AN UNRECORDABLE GRANT IS REFUSED, not quietly allowed', () => {
  const { store, audit } = fresh();
  audit.record = () => { throw new Error('disk full'); };

  const r = store.add('ghost', { addedBy: 'owner1' });
  assert.strictEqual(r.ok, false, 'the grant went through with no record of it');
  assert.ok(/access log/.test(r.reason), r.reason);
  assert.ok(!store.list().some((u) => u.login === 'ghost'), 'ghost has access but nothing recorded it');
});

check('AN UNRECORDABLE REVOCATION IS REFUSED, and the person keeps access', () => {
  const { store, audit } = fresh();
  store.add('hank', { addedBy: 'owner1' });
  audit.record = () => { throw new Error('disk full'); };

  const r = store.remove('hank');
  assert.strictEqual(r.ok, false, 'the removal went through with no record of it');
  assert.ok(store.list().some((u) => u.login === 'hank'), 'hank lost access with nothing recording it');
});

check('the refusal survives a reload -- the rollback reached the file, not just memory', () => {
  const { store, audit, dir } = fresh();
  audit.record = () => { throw new Error('disk full'); };
  store.add('phantom', { addedBy: 'owner1' });

  const reloaded = new AccessStore({ dir, persist: true, envOwner: ['owner1'] });
  assert.ok(!reloaded.list().some((u) => u.login === 'phantom'), 'phantom was persisted despite the refusal');
});

check('with no audit configured the store still works, and records nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqaudit-'));
  const store = new AccessStore({ dir, persist: true, envOwner: ['owner1'] });
  assert.ok(store.add('ivy', { addedBy: 'owner1' }).ok, 'the store broke without an audit');
  assert.ok(!fs.existsSync(path.join(dir, FILE)), 'a log appeared when none was configured');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
