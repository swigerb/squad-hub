'use strict';
/**
 * `squad-hub access export` / `squad-hub access import` (issue #108, Sprint B).
 *
 * If the app or its file share is ever recreated, this is the only way back --
 * so the property that matters most is not "export produces a file". It is:
 *
 *   1. Import is additive, never silent about what it did.
 *   2. A file it cannot read fully is refused ENTIRELY, before anything is
 *      written -- a half-applied restore is worse than a refused one.
 *   3. It cannot be used to mint an owner. Owners come from SQUAD_HUB_OWNER
 *      alone, and a file naming one is refused outright, not skipped.
 *   4. A round trip through export and import leaves the list identical.
 *   5. The file is plain text, diffable, and carries nothing that could be a
 *      credential.
 *
 * Every test below runs the REAL CLI binary against a private SQUAD_HUB_HOME,
 * so a mutation in the argument parsing or the reporting is exercised exactly
 * as an operator would hit it -- not just the module underneath it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');

const { AccessStore } = require('../src/service/access-store');

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

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cli(env, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env, encoding: 'utf8', cwd: ROOT, timeout: 15000, windowsHide: true,
  });
}

function envFor(home, { owner = ['owner1'], allowed = [] } = {}) {
  return {
    ...process.env,
    SQUAD_HUB_HOME: home,
    SQUAD_HUB_OWNER: owner.join(','),
    SQUAD_HUB_ALLOWED_USERS: allowed.join(','),
  };
}

function storeAt(home, { owner = ['owner1'], allowed = [] } = {}) {
  return new AccessStore({ dir: home, envOwner: owner, envAllowed: allowed });
}

// --- export writes where chosen, import restores from there ----------------

check('export writes to the path given, and import restores from it', () => {
  const homeA = tmpdir('sqx-export-a-');
  const homeB = tmpdir('sqx-export-b-');
  const exportPath = path.join(tmpdir('sqx-export-file-'), 'export.txt');

  // Seed A directly against the store, the same way a real grant would land.
  const a = storeAt(homeA);
  assert.strictEqual(a.add('guest', { addedBy: 'owner1', note: 'testing' }).ok, true);

  const envA = envFor(homeA);
  const r1 = cli(envA, ['access', 'export', exportPath]);
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.ok(fs.existsSync(exportPath), 'the export file was not created at the given path');

  const envB = envFor(homeB);
  const r2 = cli(envB, ['access', 'import', exportPath]);
  assert.strictEqual(r2.status, 0, r2.stderr);

  const b = storeAt(homeB);
  assert.ok(b.allowedUsers().includes('guest'), 'the grant did not come back through import');
  const row = b.list().find((u) => u.login === 'guest');
  assert.strictEqual(row.addedBy, 'owner1');
  assert.strictEqual(row.note, 'testing');
});

// --- additive, and honest about what happened -------------------------------

check('an import says what it added and what was already present', () => {
  const home = tmpdir('sqx-report-');
  const exportPath = path.join(tmpdir('sqx-report-file-'), 'export.txt');

  const existing = storeAt(home);
  assert.strictEqual(existing.add('alice', { addedBy: 'owner1' }).ok, true);

  const text = [
    '# squad-hub/access-export@1',
    JSON.stringify({
      login: 'alice', kind: 'grant', addedBy: 'owner1', addedAt: 1, note: null,
    }),
    JSON.stringify({
      login: 'newguy', kind: 'grant', addedBy: 'owner1', addedAt: 2, note: null,
    }),
  ].join('\n');
  fs.writeFileSync(exportPath, text);

  const r = cli(envFor(home), ['access', 'import', exportPath]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /added 1/, `the report does not say what was added:\n${r.stdout}`);
  assert.match(r.stdout, /already present 1/, `the report does not say what was skipped:\n${r.stdout}`);

  const after = storeAt(home);
  assert.ok(after.allowedUsers().includes('newguy'), 'the new grant was not applied');
  assert.ok(after.allowedUsers().includes('alice'), 'the existing grant was dropped');
});

// --- refuses rather than guesses ---------------------------------------------

check('a malformed record refuses the whole import and changes nothing', () => {
  const home = tmpdir('sqx-malformed-');
  const exportPath = path.join(tmpdir('sqx-malformed-file-'), 'export.txt');

  const before = storeAt(home);
  assert.strictEqual(before.add('alice', { addedBy: 'owner1' }).ok, true);

  const text = [
    '# squad-hub/access-export@1',
    JSON.stringify({
      login: 'bob', kind: 'grant', addedBy: 'owner1', addedAt: 1, note: null,
    }),
    'this is not even json',
  ].join('\n');
  fs.writeFileSync(exportPath, text);

  const r = cli(envFor(home), ['access', 'import', exportPath]);
  assert.notStrictEqual(r.status, 0, 'a malformed record was accepted');
  assert.match(r.stderr, /refusing the import/);

  const after = storeAt(home);
  assert.ok(!after.allowedUsers().includes('bob'), 'the valid record before the bad one was still applied');
  assert.deepStrictEqual(after.list().map((u) => u.login).sort(), ['alice', 'owner1'],
    'the import changed something despite refusing');
});

// --- cannot grant ownership --------------------------------------------------

check('an export file naming an owner cannot make anybody an owner on import', () => {
  const home = tmpdir('sqx-owner-');
  const exportPath = path.join(tmpdir('sqx-owner-file-'), 'export.txt');

  const text = [
    '# squad-hub/access-export@1',
    JSON.stringify({
      login: 'owner1', kind: 'grant', addedBy: 'someone', addedAt: 1, note: 'tampered',
    }),
  ].join('\n');
  fs.writeFileSync(exportPath, text);

  const r = cli(envFor(home), ['access', 'import', exportPath]);
  assert.notStrictEqual(r.status, 0, 'an owner-claiming record was accepted');
  assert.match(r.stderr, /owner/i);

  const after = storeAt(home);
  const rows = after.list().filter((u) => u.login === 'owner1');
  assert.strictEqual(rows.length, 1, 'owner1 appears more than once after the attempt');
  assert.strictEqual(rows[0].source, 'owner', 'owner1 stopped being recorded as an owner');
  assert.strictEqual(rows[0].removable, false, 'owner1 became removable');
});

// --- round trip is identical --------------------------------------------------

check('a round trip through export and import leaves the list identical', () => {
  const homeA = tmpdir('sqx-round-a-');
  const homeB = tmpdir('sqx-round-b-');
  const exportPath = path.join(tmpdir('sqx-round-file-'), 'export.txt');
  const opts = { owner: ['owner1'], allowed: ['dep1', 'dep2'] };

  const a = storeAt(homeA, opts);
  assert.strictEqual(a.add('alice', { addedBy: 'owner1', note: 'hi' }).ok, true);
  assert.strictEqual(a.remove('dep2').ok, true); // a revoked deployment identity

  const r1 = cli(envFor(homeA, opts), ['access', 'export', exportPath]);
  assert.strictEqual(r1.status, 0, r1.stderr);

  const r2 = cli(envFor(homeB, opts), ['access', 'import', exportPath, '--apply-revocations']);
  assert.strictEqual(r2.status, 0, r2.stderr);

  const before = storeAt(homeA, opts).list();
  const after = storeAt(homeB, opts).list();
  assert.deepStrictEqual(after, before, 'the round trip did not leave the list identical');
  // Named explicitly, since a shorter list could pass deepStrictEqual for the
  // wrong reason -- the revoked entry has to be ABSENT from both.
  assert.ok(!after.some((u) => u.login === 'dep2'), 'the revoked entry came back on import');
});

check('a round trip WITHOUT --apply-revocations does not remove anyone, on purpose', () => {
  const homeA = tmpdir('sqx-round-noapply-a-');
  const homeB = tmpdir('sqx-round-noapply-b-');
  const exportPath = path.join(tmpdir('sqx-round-noapply-file-'), 'export.txt');
  const opts = { owner: ['owner1'], allowed: ['dep1', 'dep2'] };

  const a = storeAt(homeA, opts);
  assert.strictEqual(a.remove('dep2').ok, true);

  cli(envFor(homeA, opts), ['access', 'export', exportPath]);
  const r = cli(envFor(homeB, opts), ['access', 'import', exportPath]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /not applied/, 'the report does not mention the revocation it did not apply');

  const after = storeAt(homeB, opts);
  assert.ok(after.allowedUsers().includes('dep2'), 'a revocation was applied without --apply-revocations');
});

// --- plain text, no secrets ---------------------------------------------------

check('an export carries logins, notes and timestamps, and nothing that could be a credential', () => {
  const home = tmpdir('sqx-secrets-');
  const exportPath = path.join(tmpdir('sqx-secrets-file-'), 'export.txt');

  const s = storeAt(home);
  assert.strictEqual(s.add('guest', { addedBy: 'owner1', note: 'a note' }).ok, true);
  const r = cli(envFor(home), ['access', 'export', exportPath]);
  assert.strictEqual(r.status, 0, r.stderr);

  const text = fs.readFileSync(exportPath, 'utf8');
  assert.match(text, /^# squad-hub\/access-export@1/, 'the header is missing or wrong');

  const allowed = new Set(['login', 'kind', 'addedBy', 'addedAt', 'note']);
  const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.ok(lines.length >= 1, 'no records were written');
  for (const line of lines) {
    const obj = JSON.parse(line);
    for (const key of Object.keys(obj)) {
      assert.ok(allowed.has(key), `an unexpected field "${key}" appeared in the export: ${line}`);
    }
  }
  // A credential-shaped value (a JWT is three base64url segments joined by
  // dots) must never appear, whatever field it rides in on.
  assert.doesNotMatch(text, /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    'the export contains a token-shaped value');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
