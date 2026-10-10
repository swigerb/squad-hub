#!/usr/bin/env node
'use strict';
/**
 * Issue #246: which model each Squad member runs, checked as TEXT (the same
 * technique `ceremonies-conventions-unit.js` uses for `.squad/` prose).
 *
 * The policy is spread over files that nothing else keeps in step: the config,
 * ten charters, the routing table, the roster, Ralph's instructions and the
 * repository Squad agent. They drifted apart in three ways, and each is a named
 * check below:
 *   - an old model survived in one of them (the config and the charters named
 *     different tiers than the routing table);
 *   - the config key `Rai` never matched the lowercase member `rai`. Squad
 *     resolves `agentModelOverrides[name]` by EXACT string, so a display-cased
 *     key is not an alias, it is a typo that silently falls through to
 *     `defaultModel`;
 *   - Scribe had no model anywhere explicit, so its after-agent spawn took the
 *     vendored template default instead of `agentModelOverrides.scribe`.
 *
 * Files are read inside each check, so a broken file fails one named check
 * instead of crashing the suite. Neither `fs.existsSync` nor a path compare is
 * used for casing: both lie on a case-insensitive filesystem, so the names come
 * from the directory listing itself.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const config = () => JSON.parse(read('.squad/config.json'));

const JUDGE = 'gpt-6.1-sol';
const EXECUTOR = 'claude-sonnet-5.5';
const SCRIBE = 'claude-haiku-5.5';
const EXPECTED = {
  lead: JUDGE, advisor: JUDGE, security: JUDGE, rai: JUDGE, 'fact-checker': JUDGE,
  engineer: EXECUTOR, reviewer: EXECUTOR, ralph: EXECUTOR,
  scribe: SCRIBE, docs: SCRIBE,
};
const MEMBERS = Object.keys(EXPECTED).sort();

// Models and tiers this policy replaced. They may live only in the Superseded
// section of decisions.md, as evidence.
const STALE = [
  /claude-opus/i,
  /claude-sonnet-5(?!\.\d|\d)/,
  /claude-haiku-4/,
  /claude-haiku-5(?!\.\d|\d)/,
  /gpt-5\.6-luna/,
  /\bOpus\b/,
];

/** What Squad does: an exact, case-sensitive per-agent override, else defaultModel. */
function resolveModel(cfg, agentName) {
  const overrides = cfg.agentModelOverrides || {};
  return Object.prototype.hasOwnProperty.call(overrides, agentName) ? overrides[agentName] : cfg.defaultModel;
}

function section(text, startRe, endRe) {
  const start = text.search(startRe);
  assert.ok(start >= 0, `section not found: ${startRe}`);
  const rest = text.slice(start + 1);
  const end = rest.search(endRe);
  return end < 0 ? text.slice(start) : text.slice(start, start + 1 + end);
}

function staleIn(label, text) {
  return STALE.filter((re) => re.test(text)).map((re) => `${label} still matches ${re}`);
}

function markdownRows(text) {
  return text.split('\n')
    .filter((l) => /^\|.*\|\s*$/.test(l) && !/^\|[\s|:-]+\|\s*$/.test(l))
    .map((l) => l.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim()));
}

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

console.log('Squad model policy (#246): config, charters, routing, roster and the Squad agent agree');
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// The config: the source of truth every other file must match.
// ---------------------------------------------------------------------------

check('the config pins defaultModel and the executor model to claude-sonnet-5.5', () => {
  const cfg = config();
  assert.strictEqual(cfg.defaultModel, EXECUTOR);
  assert.strictEqual(cfg.modelPolicy.executorModel, EXECUTOR);
});

check('the config pins the advisor model to gpt-6.1-sol and the scribe model to claude-haiku-5.5', () => {
  const cfg = config();
  assert.strictEqual(cfg.modelPolicy.advisorModel, JUDGE);
  assert.strictEqual(cfg.modelPolicy.scribeModel, SCRIBE);
});

check('every member resolves to its exact model through an explicit agentModelOverrides entry', () => {
  const cfg = config();
  const wrong = [];
  for (const [name, model] of Object.entries(EXPECTED)) {
    if (!Object.prototype.hasOwnProperty.call(cfg.agentModelOverrides, name)) wrong.push(`${name}: no override, falls through to defaultModel`);
    else if (resolveModel(cfg, name) !== model) wrong.push(`${name}: ${resolveModel(cfg, name)}, expected ${model}`);
  }
  assert.deepStrictEqual(wrong, []);
});

check('agentModelOverrides keys are exactly the lowercase member folders: no alias, no display-cased key', () => {
  const cfg = config();
  const keys = Object.keys(cfg.agentModelOverrides).sort();
  const folders = fs.readdirSync(path.join(ROOT, '.squad', 'agents'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepStrictEqual(keys, folders, 'every key must be a real .squad/agents/<name>/ folder, spelled exactly like it');
  assert.deepStrictEqual(keys, MEMBERS, 'a member was added or renamed: decide its model here, on purpose');
  for (const k of keys) assert.match(k, /^[a-z][a-z-]*$/, `key "${k}" is not lowercase`);
});

check('a display-cased lookup silently falls through to defaultModel, which is why Rai and Scribe may not be keys', () => {
  const cfg = config();
  for (const display of ['Rai', 'Scribe', 'Ralph', 'Fact Checker']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(cfg.agentModelOverrides, display), `"${display}" is a config key`);
    assert.strictEqual(resolveModel(cfg, display), cfg.defaultModel);
  }
  assert.strictEqual(resolveModel(cfg, 'rai'), JUDGE);
  assert.strictEqual(resolveModel(cfg, 'scribe'), SCRIBE);
});

// ---------------------------------------------------------------------------
// The roster and the casting registry spell the members the same way.
// ---------------------------------------------------------------------------

check('team.md and the casting registry name every member by its exact lowercase config key', () => {
  const rows = markdownRows(read('.squad/team.md')).filter((r) => /^`?\.squad\/agents\//.test(r[2] || ''));
  const names = rows.map((r) => r[0]).sort();
  assert.deepStrictEqual(names, MEMBERS, 'the Members table must list each member by its config key');
  for (const r of rows) assert.strictEqual(r[2], `\`.squad/agents/${r[0]}/charter.md\``, `charter path for ${r[0]}`);
  const registry = Object.keys(JSON.parse(read('.squad/casting/registry.json')).agents).sort();
  assert.deepStrictEqual(registry, MEMBERS);
});

// ---------------------------------------------------------------------------
// The charters: each states the model it runs, and it is the configured one.
// ---------------------------------------------------------------------------

check('every charter has an explicit Model section naming exactly its configured model', () => {
  const wrong = [];
  for (const [name, model] of Object.entries(EXPECTED)) {
    const m = read(`.squad/agents/${name}/charter.md`).match(/^## Model\n\nUse `([^`]+)`\./m);
    if (!m) wrong.push(`${name}: no "## Model" section saying Use \`<model>\`.`);
    else if (m[1] !== model) wrong.push(`${name}: ${m[1]}, expected ${model}`);
  }
  assert.deepStrictEqual(wrong, []);
});

check('the Scribe charter names claude-haiku-5.5 and says its spawn passes the model explicitly', () => {
  const charter = read('.squad/agents/scribe/charter.md');
  assert.match(charter, /^## Model\n\nUse `claude-haiku-5\.5`\./m);
  assert.match(charter, /passes this model explicitly/);
});

// ---------------------------------------------------------------------------
// Routing: the tier table and the route targets.
// ---------------------------------------------------------------------------

check('the routing Model Policy table puts every member under its configured model', () => {
  const cfg = config();
  const policy = section(read('.squad/routing.md'), /^## Model Policy$/m, /^### /m);
  const seen = [];
  for (const [tier, model, who] of markdownRows(policy).filter((r) => /^`[^`]+`$/.test(r[1] || ''))) {
    for (const member of who.split(',').map((s) => s.trim())) {
      seen.push(member);
      assert.strictEqual(model, `\`${resolveModel(cfg, member)}\``, `${tier}: ${member} is under ${model}`);
    }
  }
  assert.deepStrictEqual(seen.sort(), MEMBERS);
});

check('routing.md routes work to members by their exact lowercase config keys', () => {
  const cfg = config();
  const routing = read('.squad/routing.md');
  const table = section(routing, /^## Routing Table$/m, /^## /m);
  const targets = markdownRows(table).slice(1).map((r) => r[1]);
  assert.ok(targets.length >= 9, `only ${targets.length} routes found`);
  for (const t of targets) assert.ok(Object.prototype.hasOwnProperty.call(cfg.agentModelOverrides, t), `route target "${t}" is not a config key`);
  assert.ok(targets.includes('rai') && targets.includes('scribe'));
});

check('routing.md dispatches Scribe as name scribe with the configured Scribe model', () => {
  const rule = read('.squad/routing.md').match(/^2\. \*\*Scribe always runs\*\*.*$/m);
  assert.ok(rule, 'the Scribe rule is gone');
  assert.match(rule[0], /`name: "scribe"`/);
  assert.ok(rule[0].includes(`\`model: "${config().agentModelOverrides.scribe}"\``), `rule does not pass the Scribe model: ${rule[0]}`);
});

// ---------------------------------------------------------------------------
// The repository Squad agent: the surface that actually builds each spawn.
// ---------------------------------------------------------------------------

check('the Scribe Spawn Template passes the configured Scribe model, name scribe and background mode', () => {
  const agent = read('.github/agents/squad.agent.md');
  const block = section(agent, /^\*\*Scribe Spawn Template\*\*/m, /^\*\*On-demand reference:\*\*/m);
  assert.ok(block.includes(`model: "${config().agentModelOverrides.scribe}"`), 'the template has no explicit Scribe model');
  assert.match(block, /^name: "scribe"$/m);
  assert.match(block, /^mode: "background"$/m);
  assert.match(block, /^agent_type: "general-purpose"$/m);
});

check('the Scribe model override preserves the complete reference workflow instead of replacing its prompt', () => {
  const agent = read('.github/agents/squad.agent.md');
  const block = section(agent, /^\*\*Scribe Spawn Template\*\*/m, /^\*\*On-demand reference:\*\*/m);
  assert.match(block, /use its full Scribe spawn prompt unchanged/);
  assert.match(block, /not a replacement task list/);
  assert.doesNotMatch(block, /^prompt:/m, 'the model overlay supplies a competing shortened prompt');
  for (const duty of ['spawn manifest', 'archival safety rules and size gates', 'orchestration and session logs',
    'permitted cross-agent history updates', 'history summarization gate', 'health report']) {
    assert.ok(block.includes(duty), `the reference duty is not preserved: ${duty}`);
  }
  const after = section(agent, /^### After Agent Work$/m, /^### Ceremonies$/m);
  assert.match(after, /Preserve its full Scribe prompt and follow-up sequence/);
  assert.match(after, /override only the canonical `name` and configured `model` parameters/);
});

check('every explicit model in a squad.agent.md spawn template is one the config pins', () => {
  const cfg = config();
  const pinned = new Set([cfg.defaultModel, ...Object.values(cfg.agentModelOverrides)]);
  const used = [...read('.github/agents/squad.agent.md').matchAll(/^\s*model:\s*"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(used.length >= 1, 'no template passes a model at all');
  assert.deepStrictEqual(used.filter((m) => !pinned.has(m)), []);
});

check('squad.agent.md carries the repository model policy: keys, models, Scribe and no silent downgrade', () => {
  const policy = section(read('.github/agents/squad.agent.md'), /^### Per-Agent Model Selection$/m, /^### Per-Agent Reasoning Effort$/m);
  assert.match(policy, /Repository model policy \(authoritative/);
  assert.match(policy, /The key is the lowercase member name/);
  assert.match(policy, /Scribe is not exempt/);
  assert.match(policy, /stop and report which member and model/);
  assert.match(policy, /do not omit the `model` parameter/);
  const resolved = policy.match(/\*\*Resolved models:\*\*(.*)/);
  assert.ok(resolved, 'the Resolved models line is gone');
  const tiers = new Map();
  for (const m of resolved[1].matchAll(/`([a-z0-9.-]+)` — ([^.]*?)(?:\.|$)/g)) tiers.set(m[1], m[2]);
  assert.deepStrictEqual([...tiers.keys()].sort(), [JUDGE, EXECUTOR, SCRIBE].sort());
  for (const [name, model] of Object.entries(EXPECTED)) {
    const words = tiers.get(model).split(/,|\band\b/).map((s) => s.replace(/`[^`]*`|for any.*/g, '').trim()).filter(Boolean);
    assert.ok(words.includes(name), `${name} is not listed under ${model}: ${words.join(', ')}`);
  }
});

check('the generated team capabilities block and the repository charter paths spell Rai in lowercase', () => {
  const agent = read('.github/agents/squad.agent.md');
  const block = section(agent, /<!-- SQUAD:TEAM-CAPABILITIES:BEGIN/, /<!-- SQUAD:TEAM-CAPABILITIES:END/);
  const cells = markdownRows(block).map((r) => r[0]);
  for (const display of ['Rai', 'Scribe']) assert.ok(!cells.includes(display), `"${display}" row in the capabilities block`);
  assert.ok(cells.includes('rai'));
  assert.ok(!/\.squad\/agents\/(Rai|Scribe|Ralph)\//.test(agent), 'a display-cased .squad/agents path remains in squad.agent.md');
});

check('Ralph is told to pass every spawned agent its configured model and to stop if one is unavailable', () => {
  const ralph = read('.squad/ralph-instructions.md');
  assert.match(ralph, /### Models/);
  assert.match(ralph, /`agentModelOverrides`/);
  assert.match(ralph, /You are `ralph` and run `claude-sonnet-5\.5`/);
  assert.match(ralph, /stop and report which member and model/);
});

// ---------------------------------------------------------------------------
// History is superseded, not erased.
// ---------------------------------------------------------------------------

check('no active policy file still names a superseded model or tier', () => {
  const files = ['.squad/config.json', '.squad/routing.md', '.squad/team.md', '.squad/ralph-instructions.md', '.github/agents/squad.agent.md',
    ...MEMBERS.map((m) => `.squad/agents/${m}/charter.md`)];
  const hits = files.flatMap((f) => staleIn(f, read(f)));
  const decisions = read('.squad/decisions.md');
  hits.push(...staleIn('decisions.md Active Decisions', section(decisions, /^## Active Decisions$/m, /^## (?!Active)/m)));
  assert.deepStrictEqual(hits, []);
});

check('the earlier model mapping is kept in decisions.md as a superseded entry, not erased', () => {
  const decisions = read('.squad/decisions.md');
  const active = section(decisions, /^## Active Decisions$/m, /^## (?!Active)/m);
  assert.match(active, /^### 2026-10-09: .*gpt-6\.1-sol.*claude-sonnet-5\.5.*claude-haiku-5\.5/m);
  assert.match(active, /\*\*Supersedes:\*\*/);
  const superseded = section(decisions, /^## Superseded Decisions$/m, /^## (?!Superseded)/m);
  assert.match(superseded, /^### 2026-08-04: .*superseded 2026-10-09/m);
  for (const old of ['claude-opus-5', 'claude-opus-5.5', 'claude-sonnet-5', 'claude-haiku-4.5']) {
    assert.ok(superseded.includes(old), `the evidence for ${old} was erased`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
