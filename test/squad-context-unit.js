'use strict';
/**
 * Sprint 6 gate — Squad-aware rendering.
 *
 * Tested against a REAL `.squad/` directory where one is available on this
 * machine, and against synthetic ones for the awkward cases. A parser validated
 * only on fixtures the author wrote is a parser validated against the author's
 * assumptions.
 *
 * The malformed cases matter as much as the happy path. These files are written
 * by humans and by other agents and they drift; a parser that throws would take
 * the whole session view down with it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readSquad, isSquadWorkspace, parseTeam, parseDecisions, parseModels, inferActiveMember,
} = require('../src/squad-context');

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

function mkSquad(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqctx-'));
  fs.mkdirSync(path.join(dir, '.squad'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, '.squad', name), content);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// A real workspace, if this machine has one.
// ---------------------------------------------------------------------------
const REAL = [
  path.join(os.homedir(), 'source', 'repos', 'squad-on-aca'),
  process.env.SQUAD_HUB_REAL_WORKSPACE,
].filter(Boolean).find((p) => { try { return fs.statSync(path.join(p, '.squad')).isDirectory(); } catch { return false; } });

if (REAL) {
  console.log(`real workspace: ${REAL}`);
  const sq = readSquad(REAL);
  check('a real .squad workspace is recognised', () => {
    assert.ok(sq, 'readSquad returned null for a real workspace');
    assert.strictEqual(sq.isSquad, true);
  });
  check('real members are parsed with names and roles', () => {
    assert.ok(sq.memberCount >= 3, `only found ${sq.memberCount} members`);
    for (const m of sq.members) {
      assert.ok(m.name && m.name.length, `a member has no name: ${JSON.stringify(m)}`);
      assert.ok(!m.name.includes('|'), `a table pipe leaked into a name: ${m.name}`);
      assert.ok(!/^-+$/.test(m.name), `a separator row was parsed as a member: ${m.name}`);
    }
  });
  check('real member names are the expected roles, not table furniture', () => {
    const names = sq.members.map((m) => m.name.toLowerCase());
    assert.ok(names.includes('lead'), `no lead in ${JSON.stringify(names)}`);
    assert.ok(names.includes('engineer'), `no engineer in ${JSON.stringify(names)}`);
    assert.ok(!names.includes('name'), 'the header row was parsed as a member');
  });
  check('real decisions are parsed with dates and titles', () => {
    assert.ok(sq.decisionCount > 0, 'no decisions found in a repo that has them');
    const dated = sq.decisions.filter((d) => d.date);
    assert.ok(dated.length > 0, 'no decision carried a date');
    for (const d of sq.decisions) {
      assert.ok(d.title && d.title.length > 3, `a decision has no title: ${JSON.stringify(d)}`);
      assert.ok(!d.title.startsWith('#'), `heading markers leaked into a title: ${d.title}`);
    }
  });
  check('decisions are newest first', () => {
    const dates = sq.decisions.filter((d) => d.date).map((d) => d.date);
    const sorted = [...dates].sort().reverse();
    assert.deepStrictEqual(dates, sorted, `not sorted: ${JSON.stringify(dates)}`);
  });
  check('the project name is identified', () => {
    assert.ok(sq.project && sq.project.length > 1, `bad project name: ${sq.project}`);
  });
  check('model configuration is read', () => {
    assert.ok(sq.models, 'no model info');
    assert.ok('uniform' in sq.models, 'no uniformity verdict');
  });
} else {
  console.log('no real .squad workspace on this machine; synthetic cases only');
}

// ---------------------------------------------------------------------------
// Synthetic: the shapes a real file takes.
// ---------------------------------------------------------------------------
check('a directory without .squad is not a squad workspace', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  assert.strictEqual(isSquadWorkspace(d), false);
  assert.strictEqual(readSquad(d), null);
});

check('column order is read from the header, not assumed', () => {
  const md = `# Team
| Role | Status | Name |
|------|--------|------|
| engineer | ✅ Active | alice |
| reviewer | Paused | bob |`;
  const t = parseTeam(md);
  assert.deepStrictEqual(t.map((m) => m.name), ['alice', 'bob'], JSON.stringify(t));
  assert.strictEqual(t[0].role, 'engineer');
});

check('separator rows are not members', () => {
  const t = parseTeam(`| Name | Role |
|:-----|-----:|
| alice | lead |`);
  assert.deepStrictEqual(t.map((m) => m.name), ['alice']);
});

check('a member listed twice appears once', () => {
  const t = parseTeam(`| Name | Role |
|---|---|
| squad | Coordinator |

## Members

| Name | Role |
|---|---|
| squad | Coordinator |
| alice | lead |`);
  assert.deepStrictEqual(t.map((m) => m.name), ['squad', 'alice'], JSON.stringify(t));
});

check('an undated decision is kept, not dropped', () => {
  const d = parseDecisions(`# Decisions

## Active

### 2026-01-02: Second thing

Because.

### A thing with no date

Also because.`);
  assert.strictEqual(d.length, 2, JSON.stringify(d));
  assert.ok(d.some((x) => x.title === 'A thing with no date'), 'the undated decision was dropped');
});

check('superseded decisions are marked, not silently mixed in', () => {
  const d = parseDecisions(`## Active Decisions

### 2026-02-01: Current

## Superseded

### 2026-01-01: Old`);
  const old = d.find((x) => x.title === 'Old');
  const cur = d.find((x) => x.title === 'Current');
  assert.strictEqual(old.superseded, true, 'a superseded decision was not marked');
  assert.strictEqual(cur.superseded, false, 'an active decision was marked superseded');
});

check('decision summaries are prose, not raw markdown', () => {
  const d = parseDecisions(`## Active

### 2026-01-01: A thing

**Decision:** Use \`claude-opus-5\` for [everyone](http://x).

> Superseded note`);
  const s = d[0].summary;
  assert.ok(s, 'no summary');
  assert.ok(!s.includes('**'), `bold markers survived: ${s}`);
  assert.ok(!s.includes('\`'), `backticks survived: ${s}`);
  assert.ok(!s.includes(']('), `a link survived: ${s}`);
  assert.match(s, /Decision: Use claude-opus-5 for everyone/, s);
});

check('a mixed-model team is flagged', () => {
  const m = parseModels({ defaultModel: 'a', agentModelOverrides: { lead: 'a', eng: 'b' } });
  assert.strictEqual(m.uniform, false);
  assert.deepStrictEqual(m.distinctModels.sort(), ['a', 'b']);
});

check('a uniform team is not flagged', () => {
  const m = parseModels({ defaultModel: 'x', agentModelOverrides: { lead: 'x', eng: 'x' } });
  assert.strictEqual(m.uniform, true);
});

check('the active member is inferred from the transcript, most recent first', () => {
  const members = [{ name: 'engineer', role: 'engineer', active: true }, { name: 'reviewer', role: 'reviewer', active: true }];
  const transcript = [
    { update: { sessionUpdate: 'tool_call', title: 'reviewer checks the diff' } },
    { update: { sessionUpdate: 'tool_call', title: 'engineer writes a test' } },
  ];
  assert.strictEqual(inferActiveMember(transcript, members).name, 'engineer');
});

check('no member is inferred when none is mentioned', () => {
  const members = [{ name: 'engineer', role: 'engineer', active: true }];
  assert.strictEqual(inferActiveMember([{ update: { title: 'ran the build' } }], members), null);
});

// -- the failure modes ------------------------------------------------------
check('malformed markdown does not throw', () => {
  const d = mkSquad({ 'team.md': '|||\n|--\n| broken', 'decisions.md': '###\n##\n#' });
  const sq = readSquad(d);
  assert.ok(sq, 'a malformed workspace produced no context at all');
  assert.ok(Array.isArray(sq.members));
});

check('invalid JSON in config.json does not throw', () => {
  const d = mkSquad({ 'team.md': '| Name | Role |\n|---|---|\n| a | lead |', 'config.json': '{not json' });
  const sq = readSquad(d);
  assert.ok(sq);
  assert.strictEqual(sq.models, null, 'a bad config produced a model verdict anyway');
  assert.strictEqual(sq.memberCount, 1, 'a bad config broke team parsing too');
});

check('an empty .squad directory is still a squad', () => {
  const d = mkSquad({});
  const sq = readSquad(d);
  assert.ok(sq, 'an empty .squad was treated as not-a-squad');
  assert.strictEqual(sq.memberCount, 0);
  assert.strictEqual(sq.decisionCount, 0);
});

check('a huge decisions file is truncated rather than read whole', () => {
  const big = '### 2026-01-01: x\n'.repeat(60000);
  const d = mkSquad({ 'decisions.md': big });
  const t0 = Date.now();
  const sq = readSquad(d);
  const ms = Date.now() - t0;
  assert.ok(sq, 'a large file produced nothing');
  assert.ok(ms < 3000, `parsing took ${ms}ms; a big file is on the hot path`);
});

check('a .squad that is a FILE, not a directory, is not a squad', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sqfile-'));
  fs.writeFileSync(path.join(d, '.squad'), 'not a directory');
  assert.strictEqual(isSquadWorkspace(d), false);
  assert.strictEqual(readSquad(d), null);
});

check('a non-existent path is handled', () => {
  assert.strictEqual(readSquad(path.join(os.tmpdir(), 'does-not-exist-' + Date.now())), null);
  assert.strictEqual(readSquad(null), null);
  assert.strictEqual(readSquad(undefined), null);
});

// A cwd arrives from config, from a remote spawn request, and from an env var.
// Any of those can hand over something that is not a string.
check('a cwd of the wrong type is handled, not thrown on', () => {
  for (const bad of [123, {}, [], true, Symbol('x')]) {
    let result;
    assert.doesNotThrow(() => { result = readSquad(bad); }, `threw on ${String(bad)}`);
    assert.strictEqual(result, null, `returned a context for ${String(bad)}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
