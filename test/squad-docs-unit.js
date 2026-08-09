#!/usr/bin/env node
'use strict';
/**
 * Resolving a Squad document name to a file on disk.
 *
 * This is the security boundary for the Squad views, so most of what follows
 * is about what it REFUSES. The rule the whole design rests on:
 *
 *   the hub names a DOCUMENT; it never names a file.
 *
 * A caller sends `charter:engineer`. The device decides what that means, and
 * it decides by looking up `engineer` in the team this workspace declares --
 * so the member's OWN name is what gets joined into a path. `charter:../../..`
 * is therefore not sanitised; it simply matches nobody.
 *
 * That distinction is the reason these tests assert on the REASON for a
 * refusal and not merely on the fact of one. A rewrite that swapped the
 * membership check for a regex over the string would still refuse the obvious
 * attacks and would quietly lose the property that makes the obscure ones
 * impossible -- and only an assertion about the reason notices.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveSquadDoc, listSquadDocs, isSquadWorkspace,
} = require(path.join(__dirname, '..', 'src', 'squad-context'));

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

/** A workspace with a real team file, so membership is a real lookup. */
function workspace({ members = ['lead', 'engineer'], files = {} } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sqdoc-'));
  const dir = path.join(cwd, '.squad');
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  // The real format: parseTeam reads a markdown TABLE with Name and Role
  // columns. Writing the fixture any other way would test a parser nobody has.
  fs.writeFileSync(path.join(dir, 'team.md'),
    `# Team\n\n| Name | Role | Status |\n| --- | --- | --- |\n${
      members.map((m) => `| ${m} | ${m} | active |`).join('\n')}\n`);
  for (const m of members) {
    fs.mkdirSync(path.join(dir, 'agents', m), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents', m, 'charter.md'), `# ${m}\n\nwhat ${m} is for\n`);
    fs.writeFileSync(path.join(dir, 'agents', m, 'history.md'), `# ${m} history\n`);
  }
  fs.writeFileSync(path.join(dir, 'decisions.md'), '# Decisions\n');
  fs.writeFileSync(path.join(dir, 'routing.md'), '# Routing\n');
  fs.writeFileSync(path.join(dir, 'config.json'), '{"project":"demo"}');
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return cwd;
}

console.log('squad documents: naming a document, never a file');
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// What it resolves
// ---------------------------------------------------------------------------

check('each fixed document resolves inside .squad', () => {
  const cwd = workspace();
  for (const [doc, file] of Object.entries({
    team: 'team.md', decisions: 'decisions.md', routing: 'routing.md', config: 'config.json',
  })) {
    const r = resolveSquadDoc(cwd, doc);
    assert.ok(!r.error, `${doc} was refused: ${r.error}`);
    assert.strictEqual(r.path, path.join(cwd, '.squad', file));
  }
});

check('a member document resolves only for someone on the team', () => {
  const cwd = workspace({ members: ['lead', 'engineer'] });
  const ok = resolveSquadDoc(cwd, 'charter:engineer');
  assert.strictEqual(ok.path, path.join(cwd, '.squad', 'agents', 'engineer', 'charter.md'));

  const no = resolveSquadDoc(cwd, 'charter:security');
  assert.ok(no.error, 'a stranger resolved to a path');
  assert.match(no.error, /not on this team/,
    'the refusal must be about TEAM MEMBERSHIP -- that is the property that makes traversal impossible');
});

check('a member name is matched case-insensitively, and the TEAM spelling is used', () => {
  // The path is built from the member the team declares, never from what the
  // caller typed. That is what keeps the caller's string out of the path.
  const cwd = workspace({ members: ['Engineer'] });
  const r = resolveSquadDoc(cwd, 'charter:ENGINEER');
  assert.strictEqual(r.path, path.join(cwd, '.squad', 'agents', 'Engineer', 'charter.md'));
});

check('history is a separate document from charter', () => {
  const cwd = workspace({ members: ['lead'] });
  assert.match(resolveSquadDoc(cwd, 'history:lead').path, /history\.md$/);
  assert.match(resolveSquadDoc(cwd, 'charter:lead').path, /charter\.md$/);
});

// ---------------------------------------------------------------------------
// What it refuses -- the point of the exercise
// ---------------------------------------------------------------------------

check('traversal through a member name is refused BECAUSE nobody is called that', () => {
  const cwd = workspace();
  for (const evil of [
    'charter:../../../etc/passwd',
    'charter:..',
    'charter:.',
    'charter:../lead',
    'charter:/etc/passwd',
    'charter:C:\\Windows\\win.ini',
    'charter:\\\\server\\share\\secret',
    'charter:lead/../../../../secrets',
  ]) {
    const r = resolveSquadDoc(cwd, evil);
    assert.ok(r.error, `${evil} resolved to ${r.path}`);
    assert.match(r.error, /not on this team/, `${evil} was refused for the wrong reason: ${r.error}`);
  }
});

check('an unknown document kind is refused', () => {
  const cwd = workspace();
  for (const bad of ['secrets', 'charter', 'nope:lead', '../team', 'team.md', '']) {
    const r = resolveSquadDoc(cwd, bad);
    assert.ok(r.error, `"${bad}" resolved to ${r.path}`);
  }
});

check('an empty member name is refused rather than resolving to the agents directory', () => {
  const cwd = workspace();
  const r = resolveSquadDoc(cwd, 'charter:');
  assert.ok(r.error, `it resolved to ${r.path}`);
});

check('a non-Squad directory never yields a path', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  assert.strictEqual(isSquadWorkspace(plain), false);
  const r = resolveSquadDoc(plain, 'team');
  assert.ok(r.error);
  assert.match(r.error, /not a Squad workspace/);
});

check('a missing or non-string document name cannot resolve', () => {
  const cwd = workspace();
  for (const bad of [undefined, null, 0, {}, [], true]) {
    const r = resolveSquadDoc(cwd, bad);
    assert.ok(r.error, `${JSON.stringify(bad)} resolved to ${r.path}`);
  }
  assert.ok(resolveSquadDoc(undefined, 'team').error);
});

check('a prototype key cannot be mistaken for a document', () => {
  // `SQUAD_DOCS[doc]` with a bare `in`/truthiness test would happily accept
  // "constructor" or "toString" and join whatever came back.
  const cwd = workspace();
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = resolveSquadDoc(cwd, key);
    assert.ok(r.error, `"${key}" resolved to ${r.path}`);
  }
});

check('every resolved path is inside .squad, whatever was asked for', () => {
  // The containment check is belt and braces over the membership rule. It
  // costs nothing and it catches a mistake in the resolver itself, which is
  // exactly the mistake nobody would notice.
  const cwd = workspace({ members: ['lead', 'engineer'] });
  const root = path.resolve(cwd, '.squad') + path.sep;
  const tried = ['team', 'decisions', 'routing', 'config', 'charter:lead', 'history:engineer'];
  for (const doc of tried) {
    const r = resolveSquadDoc(cwd, doc);
    assert.ok(!r.error, `${doc}: ${r.error}`);
    assert.ok(r.path.startsWith(root), `${doc} escaped: ${r.path}`);
  }
});

check('a sibling directory that merely starts with .squad is not inside it', () => {
  const cwd = workspace();
  const root = path.resolve(cwd, '.squad');
  assert.ok(!path.resolve(`${root}-other`, 'x').startsWith(root + path.sep),
    'the containment test must compare on a separator, or ".squad-other" passes for ".squad"');
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

check('listing offers only documents that exist', () => {
  const cwd = workspace({ members: ['lead'] });
  fs.rmSync(path.join(cwd, '.squad', 'routing.md'));
  const docs = listSquadDocs(cwd);
  assert.ok(docs.includes('team'));
  assert.ok(!docs.includes('routing'), 'a document that is not there must not be offered');
  assert.ok(docs.includes('charter:lead'));
});

check('listing a non-Squad directory is empty, not an error', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain2-'));
  assert.deepStrictEqual(listSquadDocs(plain), []);
  assert.deepStrictEqual(listSquadDocs(undefined), []);
});

check('a member with no charter yet is simply not offered one', () => {
  const cwd = workspace({ members: ['lead', 'engineer'] });
  fs.rmSync(path.join(cwd, '.squad', 'agents', 'engineer', 'charter.md'));
  const docs = listSquadDocs(cwd);
  assert.ok(docs.includes('charter:lead'));
  assert.ok(!docs.includes('charter:engineer'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
