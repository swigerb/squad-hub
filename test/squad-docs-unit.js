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
const queue = [];
function check(name, fn) {
  // Queued rather than run inline, because the Sprint 2 tests are async and a
  // summary printed before they settled would be a lie.
  queue.push(async () => {
    try {
      await fn(); pass += 1;
      console.log(`  ok   ${name}`);
      console.log(`RESULT\tok\t${name}`);
    } catch (e) {
      fail += 1;
      console.log(`  FAIL ${name}\n         ${e.message}`);
      console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
    }
  });
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

// ---------------------------------------------------------------------------
// Sprint 2: the device op
// ---------------------------------------------------------------------------
//
// The op is where the resolver becomes reachable, so these are mostly about
// what it refuses. The rule it exists to enforce: the DIRECTORY comes from the
// session record on this device, never from the request -- so no field a
// caller can set has any influence over which file is read.

const { Daemon } = require(path.join(__dirname, '..', 'src', 'daemon'));

function daemonWithSession(cwd, id = 's1') {
  const d = new Daemon();
  d.sessions.set(id, { id, cwd, status: 'done' });
  d._persistSessions = () => {};
  d._untrackChild = () => {};
  d.log = () => {};
  return d;
}

check('the op reads a document for a session this device owns', async () => {
  const cwd = workspace({ members: ['lead'] });
  const d = daemonWithSession(cwd);
  const r = await d.handle({ op: 'squad-doc', sessionId: 's1', doc: 'charter:lead' });
  assert.strictEqual(r.doc, 'charter:lead');
  assert.match(r.text, /what lead is for/);
  assert.strictEqual(r.truncated, false);
  assert.ok(r.bytes > 0);
});

check('an unknown session is refused', async () => {
  const d = daemonWithSession(workspace());
  await assert.rejects(
    () => d.handle({ op: 'squad-doc', sessionId: 'nope', doc: 'team' }),
    /no such session/,
  );
});

check('a cwd or path in the REQUEST is ignored entirely', async () => {
  // The whole boundary rests on this. The session's own directory is used, so
  // a caller naming somewhere else gets that caller's document from the
  // session's workspace -- or nothing at all.
  const mine = workspace({ members: ['lead'] });
  const theirs = workspace({ members: ['lead'] });
  fs.writeFileSync(path.join(theirs, '.squad', 'team.md'), '# SOMEONE ELSE\n');

  const d = daemonWithSession(mine);
  const r = await d.handle({
    op: 'squad-doc', sessionId: 's1', doc: 'team',
    cwd: theirs, path: path.join(theirs, '.squad', 'team.md'), filesRoot: theirs,
  });
  assert.ok(!r.text.includes('SOMEONE ELSE'),
    'a directory from the request body reached the resolver');
  assert.match(r.text, /\| Name \| Role \|/, 'it should have read the session workspace');
});

check('a document outside the allow-list is refused by the op, not just the resolver', async () => {
  const d = daemonWithSession(workspace());
  for (const bad of ['charter:../../../etc/passwd', 'secrets', 'package.json']) {
    await assert.rejects(
      () => d.handle({ op: 'squad-doc', sessionId: 's1', doc: bad }),
      (e) => !!e.message,
      `${bad} was not refused`,
    );
  }
});

check('a missing document says so rather than returning empty text', async () => {
  const cwd = workspace({ members: ['lead'] });
  fs.rmSync(path.join(cwd, '.squad', 'routing.md'));
  const d = daemonWithSession(cwd);
  await assert.rejects(
    () => d.handle({ op: 'squad-doc', sessionId: 's1', doc: 'routing' }),
    /no routing in this workspace/,
  );
});

check('an oversized document is truncated and SAYS it was truncated', async () => {
  // A charter cut off mid-sentence with nothing saying so reads as a broken
  // document rather than a long one.
  const cwd = workspace({ members: ['lead'] });
  const big = 'x'.repeat(300 * 1024);
  fs.writeFileSync(path.join(cwd, '.squad', 'decisions.md'), big);
  const d = daemonWithSession(cwd);
  const r = await d.handle({ op: 'squad-doc', sessionId: 's1', doc: 'decisions' });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.bytes, 300 * 1024, 'the real size must be reported, not the truncated one');
  assert.ok(r.text.length <= 256 * 1024, `returned ${r.text.length} bytes`);
});

check('a non-Squad session offers no documents and reads none', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain3-'));
  const d = daemonWithSession(plain);
  const list = await d.handle({ op: 'squad-docs', sessionId: 's1' });
  assert.deepStrictEqual(list.docs, []);
  await assert.rejects(() => d.handle({ op: 'squad-doc', sessionId: 's1', doc: 'team' }), /not a Squad workspace/);
});

check('the document list comes from the session workspace', async () => {
  const cwd = workspace({ members: ['lead', 'engineer'] });
  const d = daemonWithSession(cwd);
  const r = await d.handle({ op: 'squad-docs', sessionId: 's1' });
  assert.ok(r.docs.includes('team'));
  assert.ok(r.docs.includes('charter:engineer'));
});

check('the hub relays only sessionId and doc', () => {
  // The daemon narrows this op anyway, so a smuggled cwd could never reach the
  // resolver -- but a hub that relays whatever it was handed is one refactor
  // away from that mattering.
  const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'service', 'hub-service.js'), 'utf8');
  assert.match(svc, /op === 'squad-doc' \? \{ sessionId: body \? body\.sessionId : undefined, doc: body \? body\.doc : undefined \}/,
    'the hub must rebuild this op field by field, like approve and forget');
  assert.match(svc, /squad-doc\|squad-docs\)\$/, 'the ops are not on the control-op allow-list');
});

check('the device rebuilds the op from the socket message, never spreading it', () => {
  const dsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon.js'), 'utf8');
  assert.match(dsrc, /op: 'squad-doc', sessionId: m\.sessionId, doc: m\.doc/,
    'a spread here would let any field on the wire reach the handler');
});

(async () => {
  for (const run of queue) await run();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
