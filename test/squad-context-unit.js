'use strict';
/**
 * Squad-aware rendering.
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
  resolveSquadDoc, listSquadDocs, resolveSquadDirs, resolveGlobalSquadPath,
} = require('../src/squad-context');
const hubConfig = require('../src/config');

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
    const p = path.join(dir, '.squad', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function teamMd(name) {
  return `# Team\n\n> ${name}\n\n| Name | Role | Status |\n| --- | --- | --- |\n| ${name} | lead | active |\n`;
}

function writeSquadFile(root, rel, content) {
  const p = path.join(root, '.squad', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function withGlobalEnv(fn) {
  const old = {
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOME: process.env.HOME,
    SQUAD_HOME: process.env.SQUAD_HOME,
  };
  const oldHomedir = os.homedir;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sqglobal-'));
  try {
    process.env.HOME = path.join(base, 'home');
    os.homedir = () => process.env.HOME;
    if (process.platform === 'win32') {
      process.env.APPDATA = path.join(base, 'appdata');
      process.env.LOCALAPPDATA = path.join(base, 'localappdata');
    } else {
      process.env.XDG_CONFIG_HOME = path.join(base, 'xdg');
    }
    return fn(base);
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    os.homedir = oldHomedir;
    cleanup(base);
  }
}

function assertInside(base, target, message) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  assert.ok(rel === '' || (!path.isAbsolute(rel) && !rel.startsWith('..')),
    message || `${target} is not inside ${base}`);
}

function externalProjectDir(base, key) {
  const dir = path.join(resolveGlobalSquadPath(), 'projects', key);
  assertInside(base, dir, `resolved global Squad dir escaped the test temp base: ${dir}`);
  return dir;
}

function withHubConfig(patch, fn) {
  hubConfig.setOverrides(patch);
  try { return fn(); }
  finally {
    hubConfig.setOverrides(null);
    hubConfig.invalidate();
  }
}

function pathContainsResolved(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!path.isAbsolute(rel) && !rel.startsWith('..'));
}

function withReadWatch(root, fn) {
  const rootReal = fs.realpathSync.native(root);
  const oldRead = fs.readFileSync;
  const oldOpen = fs.openSync;
  const reads = [];
  function note(p) {
    try {
      const real = fs.realpathSync.native(p);
      if (pathContainsResolved(rootReal, real)) reads.push(real);
    } catch { /* ignored */ }
  }
  fs.readFileSync = function watchedReadFileSync(p, ...args) {
    note(p);
    return oldRead.call(this, p, ...args);
  };
  fs.openSync = function watchedOpenSync(p, ...args) {
    note(p);
    return oldOpen.call(this, p, ...args);
  };
  try { return fn(reads); }
  finally {
    fs.readFileSync = oldRead;
    fs.openSync = oldOpen;
  }
}

function linkDir(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (e) {
    console.log(`  skip directory symlink/junction setup (${e.code || e.message})`);
    return false;
  }
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
  // Sprint 3: "no idea" and "the coordinator" are different facts now, so the
  // no-signal case is an honest `{name: null, coordinator: false}`, not a bare
  // `null` -- `null` is reserved for "there is no team at all".
  const members = [{ name: 'engineer', role: 'engineer', active: true }];
  const r = inferActiveMember([{ update: { title: 'ran the build' } }], members);
  assert.ok(r, 'a team with no signal produced nothing at all');
  assert.strictEqual(r.name, null);
  assert.strictEqual(r.coordinator, false);
  assert.strictEqual(r.inferred, false);
});

check('no team at all yields null, not an "unknown" payload', () => {
  assert.strictEqual(inferActiveMember([{ update: { title: 'x' } }], []), null);
  assert.strictEqual(inferActiveMember([{ update: { title: 'x' } }], null), null);
});

// ---------------------------------------------------------------------------
// Sprint 1 -- a member name must not match inside another word.
// ---------------------------------------------------------------------------
const SPRINT1_MEMBERS = [
  { name: 'Squad', role: 'Coordinator', active: true },
  { name: 'lead', role: 'lead', active: true },
  { name: 'rai', role: 'reviewer', active: true },
];

function mentionOf(text) {
  const r = inferActiveMember([{ update: { title: text } }], SPRINT1_MEMBERS);
  return r;
}

check('squad-hub does not infer the member Squad (project-path case)', () => {
  const r = mentionOf('Viewing C:\\src\\repos\\squad-hub\\src\\service\\hub-service.js');
  assert.strictEqual(r.name, null, `squad-hub falsely matched: ${JSON.stringify(r)}`);
  assert.strictEqual(r.coordinator, false, 'squad-hub was read as the coordinator acting');
});

check('squad-on-aca does not infer the member Squad', () => {
  const r = mentionOf('project=squad-on-aca members=8/8');
  assert.strictEqual(r.name, null, `squad-on-aca falsely matched: ${JSON.stringify(r)}`);
});

check('.squad/team.md does not infer the member Squad', () => {
  const r = mentionOf('Reading .squad/team.md for the roster');
  assert.strictEqual(r.name, null, `.squad/team.md falsely matched: ${JSON.stringify(r)}`);
});

check('a member genuinely named in prose still matches', () => {
  const r = mentionOf('Delegating to lead: run the retro');
  assert.strictEqual(r.name, 'lead', `prose mention of "lead" was not matched: ${JSON.stringify(r)}`);
});

check('a member whose name is a common substring does not match inside a longer word (lead/leader)', () => {
  const r = mentionOf('Waiting for the leader to sign off');
  assert.strictEqual(r.name, null, `"lead" falsely matched inside "leader": ${JSON.stringify(r)}`);
});

check('a member whose name is a common substring does not match inside a longer word (rai/raise)', () => {
  const r = mentionOf('going to raise a concern about scope');
  assert.strictEqual(r.name, null, `"rai" falsely matched inside "raise": ${JSON.stringify(r)}`);
});

// ---------------------------------------------------------------------------
// Sprint 2 -- infer from delegation, not from mention.
//
// GATE FIRST: a real captured Squad transcript is committed as a fixture, and
// the delegation signal this sprint depends on must be proven present in it
// BEFORE anything is built on top. If it were not there, the rest of this
// sprint is not buildable, and that has to be discovered by a failing
// assertion here, not by a heuristic that quietly keeps guessing.
// ---------------------------------------------------------------------------
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'squad-transcript-delegation.json');
let FIXTURE = null;
try { FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')); } catch { /* checked below */ }

check('the committed fixture is a real captured Squad transcript', () => {
  assert.ok(FIXTURE, `test/fixtures/squad-transcript-delegation.json is missing or unparsable`);
  assert.ok(Array.isArray(FIXTURE) && FIXTURE.length > 0, 'the fixture carries no entries');
  // Real ACP session-update envelopes, not a hand-rolled shape: every entry
  // has a `seq` and an `at`, and the updates use the real `sessionUpdate`
  // vocabulary this codebase already reads (see acp-session.js).
  for (const e of FIXTURE) {
    assert.ok(Number.isFinite(e.seq), `entry missing seq: ${JSON.stringify(e)}`);
    assert.ok(Number.isFinite(e.at), `entry missing a timestamp: ${JSON.stringify(e)}`);
  }
});

check('the delegation signal -- a tool_call whose rawInput.name is a team member -- is actually present in the fixture', () => {
  assert.ok(FIXTURE, 'no fixture to inspect');
  const delegations = FIXTURE
    .map((e) => e.update || e)
    .filter((u) => u && u.sessionUpdate === 'tool_call' && u.rawInput && typeof u.rawInput.name === 'string');
  assert.ok(delegations.length > 0,
    'no tool_call in the fixture carries rawInput.name -- the delegation signal this sprint depends on is not ' +
    'present, and Sprint 2 is not buildable on this fixture. STOP: do not fall back to a mention heuristic.');
  const names = delegations.map((d) => d.rawInput.name);
  assert.ok(names.includes('engineer'), `expected an "engineer" delegation in the fixture; saw: ${names.join(', ')}`);
  assert.ok(names.includes('lead'), `expected a "lead" delegation in the fixture; saw: ${names.join(', ')}`);
});

const FIXTURE_TEAM = [
  { name: 'lead', role: 'lead', active: true },
  { name: 'engineer', role: 'engineer', active: true },
  { name: 'Squad', role: 'Coordinator', active: true },
];

check('given the fixture, the member inferred is the one delegated to (the OPEN delegation, not the completed one)', () => {
  assert.ok(FIXTURE, 'no fixture to run inference against');
  const r = inferActiveMember(FIXTURE, FIXTURE_TEAM);
  // The fixture's lead delegation completes (tool_call_update -> completed);
  // the engineer delegation never does within the captured window, so
  // engineer is who is actually acting.
  assert.strictEqual(r.name, 'engineer', `expected engineer to be inferred acting; got ${JSON.stringify(r)}`);
  assert.strictEqual(r.inferred, false, 'a delegation is an assertion, not a guess -- it must not be labelled inferred');
});

check('a delegation that has since completed does not keep reporting that member as active', () => {
  const team = [{ name: 'lead', role: 'lead', active: true }];
  const transcript = [
    { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', rawInput: { name: 'lead' }, status: 'pending' } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' } },
  ];
  const r = inferActiveMember(transcript, team);
  assert.strictEqual(r.name, null, `a completed delegation still reported lead as active: ${JSON.stringify(r)}`);
  assert.strictEqual(r.coordinator, true, 'control returning to the coordinator after completion must be asserted, not left unknown');
});

check('prose that merely names a member does not override an actual open delegation', () => {
  const team = [{ name: 'lead', role: 'lead', active: true }, { name: 'engineer', role: 'engineer', active: true }];
  const transcript = [
    { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', rawInput: { name: 'engineer' }, status: 'pending' } },
    { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lead says this looks good' } } },
  ];
  const r = inferActiveMember(transcript, team);
  assert.strictEqual(r.name, 'engineer', `a later mention of "lead" wrongly overrode the open delegation to engineer: ${JSON.stringify(r)}`);
});

check('prose that merely names a member does not override a COMPLETED delegation either', () => {
  const team = [{ name: 'lead', role: 'lead', active: true }, { name: 'engineer', role: 'engineer', active: true }];
  const transcript = [
    { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', rawInput: { name: 'engineer' }, status: 'pending' } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' } },
    { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lead reviewed the diff' } } },
  ];
  const r = inferActiveMember(transcript, team);
  assert.strictEqual(r.name, null, `a completed-delegation transcript fell back to a mention: ${JSON.stringify(r)}`);
  assert.strictEqual(r.coordinator, true, 'once every known delegation has finished, the coordinator is asserted, not guessed');
});

// ---------------------------------------------------------------------------
// Sprint 3 -- say when it does not know.
// ---------------------------------------------------------------------------
check('the payload distinguishes "no idea" from "the coordinator is acting"', () => {
  const team = [{ name: 'lead', role: 'lead', active: true }];
  const unknown = inferActiveMember([{ update: { title: 'nothing relevant here' } }], team);
  const coordinator = inferActiveMember([
    { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', rawInput: { name: 'lead' }, status: 'pending' } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' } },
  ], team);
  assert.strictEqual(unknown.name, null);
  assert.strictEqual(unknown.coordinator, false, '"no idea" was reported as "the coordinator", which is a different fact');
  assert.strictEqual(coordinator.name, null);
  assert.strictEqual(coordinator.coordinator, true, '"the coordinator is acting" was not distinguished from "no idea"');
});

check('a mention-based guess is labelled inferred; a delegation-based fact is not', () => {
  const team = [{ name: 'lead', role: 'lead', active: true }];
  const guessed = mentionOf('Delegating to lead: run the retro');
  assert.strictEqual(guessed.name, 'lead');
  assert.strictEqual(guessed.inferred, true, 'a mention-only guess must be labelled inferred');

  const asserted = inferActiveMember([
    { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', rawInput: { name: 'lead' }, status: 'pending' } },
  ], team);
  assert.strictEqual(asserted.name, 'lead');
  assert.strictEqual(asserted.inferred, false, 'an open delegation is an assertion, not a guess');
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

// ---------------------------------------------------------------------------
// Issue #156 -- effective Squad state dirs.
// ---------------------------------------------------------------------------
check('local state is unchanged with no config, and teamRoot "." stays local', () => {
  for (const cfg of [null, { teamRoot: '.' }]) {
    const d = mkSquad({
      'team.md': teamMd('local'),
      'decisions.md': '## Active\n\n### 2026-01-01: local decision\n',
      ...(cfg ? { 'config.json': JSON.stringify(cfg) } : {}),
    });
    try {
      const dirs = resolveSquadDirs(d);
      assert.strictEqual(dirs.stateDir, path.join(d, '.squad'));
      assert.strictEqual(dirs.mode, 'local');
      const sq = readSquad(d);
      assert.strictEqual(sq.members[0].name, 'local');
      assert.strictEqual(sq.latestDecision.title, 'local decision');
    } finally { cleanup(d); }
  }
});

check('externalized state reads roster and decisions externally but models locally', () => withGlobalEnv((base) => withHubConfig({ followExternalSquadState: true }, () => {
  const d = mkSquad({
    'team.md': teamMd('local'),
    'decisions.md': '## Active\n\n### 2026-01-01: local decision\n',
    'config.json': JSON.stringify({
      stateLocation: 'external',
      projectKey: 'Project One',
      defaultModel: 'local-model-only',
      agentModelOverrides: { external: 'local-override-only' },
    }),
  });
  try {
    const ext = externalProjectDir(base, 'Project-One');
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'team.md'), teamMd('external'));
    fs.writeFileSync(path.join(ext, 'decisions.md'), '## Active\n\n### 2026-01-02: external decision\n');
    const sq = readSquad(d);
    assert.strictEqual(sq.members[0].name, 'external');
    assert.strictEqual(sq.latestDecision.title, 'external decision');
    assert.strictEqual(sq.models.defaultModel, 'local-model-only');
    assert.strictEqual(sq.models.overrides.external, 'local-override-only');
    assert.strictEqual(resolveSquadDoc(d, 'team').path, path.join(ext, 'team.md'));
    assert.strictEqual(resolveSquadDoc(d, 'config').path, path.join(d, '.squad', 'config.json'));
    assert.ok(listSquadDocs(d).includes('team'));
  } finally { cleanup(d); }
})));

check('remote teamRoot reads the roster from the sibling team parent', () => withHubConfig({ followExternalSquadState: true }, () => {
  const d = mkSquad({
    'team.md': teamMd('local'),
    'config.json': JSON.stringify({ teamRoot: '..' + path.sep + 'team-parent' }),
  });
  const teamParent = path.join(path.dirname(d), 'team-parent');
  try {
    fs.mkdirSync(path.join(teamParent, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(teamParent, '.squad', 'team.md'), teamMd('remote'));
    const sq = readSquad(d);
    assert.strictEqual(resolveSquadDirs(d).mode, 'remote');
    assert.strictEqual(resolveSquadDirs(d).stateDir, path.join(teamParent, '.squad'));
    assert.strictEqual(sq.members[0].name, 'remote');
  } finally { cleanup(d); cleanup(teamParent); }
}));

check('remote teamRoot wins over local external state', () => withGlobalEnv((base) => withHubConfig({ followExternalSquadState: true }, () => {
  const d = mkSquad({
    'team.md': teamMd('local'),
    'config.json': JSON.stringify({
      teamRoot: '..' + path.sep + 'team-parent',
      stateLocation: 'external',
      projectKey: 'local-external',
    }),
  });
  const teamParent = path.join(path.dirname(d), 'team-parent');
  try {
    const localExt = externalProjectDir(base, 'local-external');
    fs.mkdirSync(localExt, { recursive: true });
    fs.writeFileSync(path.join(localExt, 'team.md'), teamMd('wrong-external'));
    fs.mkdirSync(path.join(teamParent, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(teamParent, '.squad', 'team.md'), teamMd('remote'));
    const sq = readSquad(d);
    assert.strictEqual(sq.members[0].name, 'remote');
    assert.strictEqual(resolveSquadDirs(d).stateDir, path.join(teamParent, '.squad'));
  } finally { cleanup(d); cleanup(teamParent); }
})));

check('invalid projectKey is refused and empty sanitisation falls back local', () => withGlobalEnv((base) => withHubConfig({ followExternalSquadState: true }, () => {
  for (const key of ['..\\outside', '🔥', '.', 'CON', 'con.txt', 'LPT9.log', 'alias.']) {
    const d = mkSquad({
      'team.md': teamMd('local'),
      'config.json': JSON.stringify({ stateLocation: 'external', projectKey: key }),
    });
    try {
      const sanitized = String(key)
        .replace(/[/\\]/g, '-')
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .replace(/^-+|-+$/g, '');
      if (sanitized) {
        const escaped = externalProjectDir(base, sanitized);
        fs.mkdirSync(escaped, { recursive: true });
        fs.writeFileSync(path.join(escaped, 'team.md'), teamMd('refused-key-was-used'));
      }
      const sq = readSquad(d);
      assert.strictEqual(sq.members[0].name, 'local');
      assert.strictEqual(resolveSquadDirs(d).stateDir, path.join(d, '.squad'));
    } finally { cleanup(d); }
  }
})));

check('projectKey sanitisation matches upstream exactly', () => withGlobalEnv((base) => withHubConfig({ followExternalSquadState: true }, () => {
  const d = mkSquad({
    'team.md': teamMd('local'),
    'config.json': JSON.stringify({ stateLocation: 'external', projectKey: '🔥A/B C🔥\\D🔥' }),
  });
  try {
    const ext = externalProjectDir(base, 'A-B-C---D');
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'team.md'), teamMd('sanitised'));
    const sq = readSquad(d);
    assert.strictEqual(sq.members[0].name, 'sanitised');
    assert.strictEqual(resolveSquadDirs(d).stateDir, ext);
  } finally { cleanup(d); }
})));

check('externalized state outside the project is blocked unless squad-hub config enables it', () => withGlobalEnv((base) => {
  const d = mkSquad({
    'team.md': teamMd('local'),
    'config.json': JSON.stringify({
      stateLocation: 'external',
      projectKey: 'blocked-by-default',
      followExternalSquadState: true,
    }),
  });
  try {
    const ext = externalProjectDir(base, 'blocked-by-default');
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'team.md'), teamMd('external'));
    const sq = readSquad(d);
    assert.strictEqual(sq.members[0].name, 'local', 'repo-controlled config enabled an external read');
    assert.strictEqual(resolveSquadDirs(d).stateDir, path.join(d, '.squad'));
  } finally { cleanup(d); }
}));

check('externalized state outside the project is followed when squad-hub config enables it', () => withGlobalEnv((base) => withHubConfig({ followExternalSquadState: true }, () => {
  const d = mkSquad({
    'team.md': teamMd('local'),
    'config.json': JSON.stringify({ stateLocation: 'external', projectKey: 'allowed-by-hub-config' }),
  });
  try {
    const ext = externalProjectDir(base, 'allowed-by-hub-config');
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'team.md'), teamMd('external'));
    assert.strictEqual(readSquad(d).members[0].name, 'external');
    assert.strictEqual(resolveSquadDirs(d).stateDir, ext);
  } finally { cleanup(d); }
})));

check('symlinked local Squad root outside the project is blocked unless squad-hub config enables it', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sqctx-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sqctx-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'team.md'), teamMd('outside'));
    fs.writeFileSync(path.join(outside, 'config.json'), JSON.stringify({ project: 'outside' }));
    if (!linkDir(outside, path.join(d, '.squad'))) return;
    withReadWatch(outside, (reads) => {
      assert.strictEqual(readSquad(d), null);
      assert.strictEqual(resolveSquadDirs(d), null);
      assert.strictEqual(resolveSquadDoc(d, 'team').error, 'not a Squad workspace');
      assert.deepStrictEqual(listSquadDocs(d), []);
      assert.strictEqual(reads.length, 0, `blocked local symlink read outside state: ${reads.join(', ')}`);
    });
  } finally { cleanup(d); cleanup(outside); }
});

check('symlinked local Squad root outside the project is followed when squad-hub config enables it', () => withHubConfig({ followExternalSquadState: true }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sqctx-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sqctx-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'team.md'), teamMd('outside'));
    fs.writeFileSync(path.join(outside, 'config.json'), JSON.stringify({ project: 'outside' }));
    if (!linkDir(outside, path.join(d, '.squad'))) return;
    withReadWatch(outside, (reads) => {
      assert.strictEqual(readSquad(d).members[0].name, 'outside');
      assert.strictEqual(resolveSquadDirs(d).stateDir, path.join(d, '.squad'));
      assert.ok(reads.length > 0, 'enabled local symlink did not read the external state root');
    });
  } finally { cleanup(d); cleanup(outside); }
}));

check('symlinked documents cannot escape a local state root', () => {
  const d = mkSquad({
    'team.md': teamMd('escape'),
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sqctx-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'charter.md'), '# Outside\n');
    fs.mkdirSync(path.join(d, '.squad', 'agents'), { recursive: true });
    if (!linkDir(outside, path.join(d, '.squad', 'agents', 'escape'))) return;
    withReadWatch(outside, (reads) => {
      assert.strictEqual(resolveSquadDoc(d, 'charter:escape').error, 'that document is outside the workspace');
      assert.ok(!listSquadDocs(d).includes('charter:escape'), 'escaped local symlink was offered as a readable document');
      assert.strictEqual(reads.length, 0, `local escaped document was read: ${reads.join(', ')}`);
    });
  } finally { cleanup(d); cleanup(outside); }
});

check('raw trailing-space projectKey is refused before sanitisation', () => withGlobalEnv((base) => withHubConfig({ followExternalSquadState: true }, () => {
  const d = mkSquad({
    'team.md': teamMd('local'),
    'config.json': JSON.stringify({ stateLocation: 'external', projectKey: 'foo ' }),
  });
  try {
    const ext = externalProjectDir(base, 'foo');
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'team.md'), teamMd('raw-trailing-space-was-used'));
    const sq = readSquad(d);
    assert.strictEqual(sq.members[0].name, 'local');
    assert.strictEqual(resolveSquadDirs(d).stateDir, path.join(d, '.squad'));
  } finally { cleanup(d); }
})));

check('externalized state ignores SQUAD_HOME and uses the platform global root', () => withGlobalEnv((base) => withHubConfig({ followExternalSquadState: true }, () => {
  const d = mkSquad({
    'team.md': teamMd('local'),
    'config.json': JSON.stringify({ stateLocation: 'external', projectKey: 'squad-home-ignored' }),
  });
  try {
    const ext = externalProjectDir(base, 'squad-home-ignored');
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'team.md'), teamMd('right'));
    process.env.SQUAD_HOME = path.join(base, 'wrong-squad-home');
    const wrong = path.join(process.env.SQUAD_HOME, 'projects', 'squad-home-ignored');
    fs.mkdirSync(wrong, { recursive: true });
    fs.writeFileSync(path.join(wrong, 'team.md'), teamMd('wrong'));
    assert.strictEqual(readSquad(d).members[0].name, 'right');
    assert.strictEqual(resolveSquadDirs(d).stateDir, ext);
  } finally { cleanup(d); }
})));

check('teamRoot "./" is remote and targets the parent containing .squad', () => {
  const d = mkSquad({
    'team.md': teamMd('local'),
    'config.json': JSON.stringify({ teamRoot: './' }),
  });
  try {
    const dirs = resolveSquadDirs(d);
    assert.strictEqual(dirs.mode, 'remote');
    assert.strictEqual(dirs.stateDir, path.join(d, '.squad'));
    assert.strictEqual(readSquad(d).members[0].name, 'local');
  } finally { cleanup(d); }
});

check('production state resolution does not create missing external directories', () => withGlobalEnv((base) => withHubConfig({ followExternalSquadState: true }, () => {
  const d = mkSquad({
    'team.md': teamMd('local'),
    'config.json': JSON.stringify({ stateLocation: 'external', projectKey: 'missing-must-not-be-created' }),
  });
  try {
    const ext = externalProjectDir(base, 'missing-must-not-be-created');
    assert.ok(!fs.existsSync(ext), 'test setup accidentally created the external dir');
    assert.strictEqual(readSquad(d).members[0].name, 'local');
    assert.strictEqual(resolveSquadDirs(d).stateDir, path.join(d, '.squad'));
    assert.ok(!fs.existsSync(ext), 'state resolution created production state');
  } finally { cleanup(d); }
})));

check('symlinked documents cannot escape an accepted external state root', () => withGlobalEnv((base) => withHubConfig({ followExternalSquadState: true }, () => {
  const d = mkSquad({
    'team.md': teamMd('local'),
    'config.json': JSON.stringify({ stateLocation: 'external', projectKey: 'symlink-escape' }),
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sqctx-outside-'));
  try {
    const ext = externalProjectDir(base, 'symlink-escape');
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'team.md'), teamMd('escape'));
    fs.writeFileSync(path.join(outside, 'charter.md'), '# Outside\n');
    fs.mkdirSync(path.join(ext, 'agents'), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(ext, 'agents', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      console.log(`  skip symlinked documents cannot escape an accepted external state root (${e.code || e.message})`);
      return;
    }
    assert.strictEqual(readSquad(d).members[0].name, 'escape');
    assert.strictEqual(resolveSquadDoc(d, 'charter:escape').error, 'that document is outside the workspace');
    assert.ok(!listSquadDocs(d).includes('charter:escape'), 'escaped symlink was offered as a readable document');
  } finally { cleanup(d); cleanup(outside); }
})));

check('state resolution never throws and degrades to local on bad config or targets', () => withGlobalEnv((base) => {
  const cases = [
    { files: { 'config.json': '{not json' } },
    { before: (d) => { fs.rmSync(path.join(d, '.squad', 'config.json'), { force: true }); fs.mkdirSync(path.join(d, '.squad', 'config.json')); } },
    { files: { 'config.json': JSON.stringify({ teamRoot: '..' + path.sep + 'missing-team' }) } },
    { files: { 'config.json': JSON.stringify({ stateLocation: 'external', projectKey: 'state-is-file' }) },
      before: () => {
        const p = path.dirname(externalProjectDir(base, 'state-is-file'));
        fs.mkdirSync(p, { recursive: true });
        fs.writeFileSync(path.join(p, 'state-is-file'), 'not a dir');
      } },
  ];
  for (const c of cases) {
    const d = mkSquad({ 'team.md': teamMd('local'), ...(c.files || {}) });
    try {
      if (c.before) c.before(d);
      assert.doesNotThrow(() => readSquad(d));
      assert.strictEqual(readSquad(d).members[0].name, 'local');
      assert.strictEqual(resolveSquadDirs(d).stateDir, path.join(d, '.squad'));
    } finally { cleanup(d); }
  }
}));

check('global squad dir follows current platform env precedence', () => withGlobalEnv((base) => {
  assert.strictEqual(os.homedir(), path.join(base, 'home'), 'test homedir override did not take');
  if (process.platform === 'win32') {
    assert.strictEqual(resolveGlobalSquadPath(), path.join(base, 'appdata', 'squad'));
    delete process.env.APPDATA;
    assert.strictEqual(resolveGlobalSquadPath(), path.join(base, 'localappdata', 'squad'));
  } else if (process.platform === 'darwin') {
    assert.strictEqual(resolveGlobalSquadPath(), path.join(base, 'home', 'Library', 'Application Support', 'squad'));
  } else {
    assert.strictEqual(resolveGlobalSquadPath(), path.join(base, 'xdg', 'squad'));
    delete process.env.XDG_CONFIG_HOME;
    assert.strictEqual(resolveGlobalSquadPath(), path.join(base, 'home', '.config', 'squad'));
  }
}));

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
