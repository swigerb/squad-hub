'use strict';
/**
 * Candidate selection (test/helpers/acceptance-policy.js) for a change to this
 * repository's own Squad team files.
 *
 * Product code names `.squad/...` and `.github/agents/...` because it reads a
 * USER's repository at run time. Treating every such reader as impacted by a
 * change to THESE files selected 904 mutations for a policy-only pull request
 * on 2026-10-19. A real git repository with real files; the policy is the real
 * one, so this measures what CI would select.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const policy = require('./helpers/acceptance-policy');

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); console.log(`RESULT\tok\t${name}`); } catch (e) {
    fail += 1; console.log(`  FAIL ${name}\n         ${e.message}`); console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-policy-'));
const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

function repo(name) {
  const root = path.join(TMP, name);
  write(root, 'src/reader.js', "const path = require('path');\nconst CONFIG = path.join('.squad', 'config.json');\nconst AGENT = '.github/agents/squad.agent.md';\nmodule.exports = { where: () => [CONFIG, AGENT], add: (a, b) => a + b };\n");
  write(root, 'src/plain.js', "module.exports = { mul: (a, b) => a * b };\n");
  write(root, '.squad/config.json', '{ "lead": "model-a" }\n');
  write(root, '.github/agents/squad.agent.md', '# agent\nlead: model-a\n');
  write(root, 'test/reader-unit.js', "const r = require('../src/reader');\nconsole.log(r.add(1, 2) === 3 ? 'ok' : 'FAIL');\n");
  write(root, 'test/plain-unit.js', "const p = require('../src/plain');\nconsole.log(p.mul(2, 3) === 6 ? 'ok' : 'FAIL');\n");
  write(root, 'test/config-unit.js', "const fs = require('fs');\nconsole.log(fs.readFileSync('.squad/config.json', 'utf8').includes('lead') ? 'ok' : 'FAIL');\n");
  write(root, 'test/mutate.js', 'module.exports = [];\n');
  sh(['init', '-q'], root);
  sh(['add', '-A'], root);
  sh(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base'], root);
  return { root, base: sh(['rev-parse', 'HEAD'], root) };
}

const MUTATIONS = [
  { file: 'src/reader.js', name: 'reader add mutant', find: 'a + b', replace: 'a - b', mustFail: 'reader adds' },
  { file: 'src/plain.js', name: 'plain mul mutant', find: 'a * b', replace: 'a + b', mustFail: 'plain multiplies' },
  { file: '.squad/config.json', name: 'config lead mutant', find: '"lead"', replace: '"leed"', mustFail: 'config names a lead' },
];
const SUITES = { 'reader adds': 'reader-unit.js', 'plain multiplies': 'plain-unit.js', 'config names a lead': 'config-unit.js' };
const plan = (r) => policy.planAcceptance({ root: r.root, baseRef: r.base, mutations: MUTATIONS, suiteFor: (mustFail) => SUITES[mustFail] || null, scope: 'candidate', critical: [] });
const names = (list) => list.map((e) => e.mutation.name).sort();

check("a change to this repository's own .squad/ and .github/agents/ files does not select every file that merely names those paths", () => {
  const r = repo('self-config');
  write(r.root, '.squad/config.json', '{ "lead": "model-b" }\n');
  write(r.root, '.github/agents/squad.agent.md', '# agent\nlead: model-b\n');
  const p = plan(r);
  assert.ok(!names(p.selected).includes('reader add mutant'), `src/reader.js only names those paths, but was selected: ${JSON.stringify(p.selected.map((e) => [e.mutation.name, e.reasons]))}`);
  assert.ok(names(p.deferred).includes('reader add mutant'));
  assert.ok(p.warnings.some((w) => /own Squad configuration changed/.test(w)), p.warnings.join('|'));
});

check('...while a mutation IN a changed .squad/ file is still selected', () => {
  const r = repo('self-config-target');
  write(r.root, '.squad/config.json', '{ "lead": "model-c" }\n');
  assert.ok(names(plan(r).selected).includes('config lead mutant'));
});

check('...and a change to production code still reaches the files that depend on it', () => {
  const r = repo('production');
  write(r.root, 'src/plain.js', "module.exports = { mul: (a, b) => a * b, two: 2 };\n");
  const selected = names(plan(r).selected);
  assert.ok(selected.includes('plain mul mutant'), selected.join(', '));
  assert.ok(!selected.includes('reader add mutant'), 'an unrelated file is not selected');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
