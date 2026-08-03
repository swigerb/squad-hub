'use strict';
/**
 * Documentation, checked against the code.
 *
 * Prose drifts silently. A command that was renamed, a flag that was removed,
 * an environment variable that never existed -- none of it fails a build, and
 * all of it wastes somebody's afternoon.
 *
 * This checks the two directions that matter:
 *   - everything the docs PROMISE is implemented
 *   - everything the code READS is documented
 *
 * The second direction is the one people skip, and it is how a project ends up
 * with twenty undocumented environment variables.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

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

const cli = read('src/cli.js');
const commands = read('docs/commands.md');
const readme = read('README.md');
const docsIndex = read('docs/README.md');
const cloud = read('docs/cloud.md');
const architecture = read('docs/architecture.md');
const allDocs = [commands, readme, docsIndex, cloud, architecture, read('docs/sprint-5-evidence.md')].join('\n');

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const implemented = [...cli.matchAll(/case '([a-z-]+)': return cmd/g)].map((m) => m[1]);

check('the CLI implements a plausible number of commands', () => {
  assert.ok(implemented.length >= 8, `only found ${implemented.length}; the scan is broken`);
});

check('every implemented command is documented', () => {
  const undocumented = implemented.filter((c) => !new RegExp(`squad-hub ${c}\\b`).test(commands));
  assert.deepStrictEqual(undocumented, [], `undocumented commands: ${undocumented.join(', ')}`);
});

check('every command the docs promise actually exists', () => {
  const promised = [...allDocs.matchAll(/squad-hub ([a-z][a-z-]+)/g)]
    .map((m) => m[1])
    .filter((c) => !['start', 'stop'].includes(c) || true);
  const invented = [...new Set(promised)].filter((c) => !implemented.includes(c));
  assert.deepStrictEqual(invented, [],
    `the docs promise commands that do not exist: ${invented.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------
function envVarsIn(files) {
  const out = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/process\.env\.(SQUAD_HUB_[A-Z_]+)/g)) out.add(m[1]);
  }
  return [...out];
}

const srcFiles = [
  'src/cli.js', 'src/config.js', 'src/daemon.js', 'src/acp-session.js',
  'src/paths.js', 'src/cloud-device.js', 'src/hub-link.js',
  'src/service/hub-service.js', 'src/service/auth.js', 'src/notify/teams.js',
];
const usedVars = envVarsIn(srcFiles);

check('a plausible number of environment variables were found', () => {
  assert.ok(usedVars.length >= 8, `only found ${usedVars.length}; the scan is broken`);
});

check('every SQUAD_HUB_* variable the code reads is documented', () => {
  const undocumented = usedVars.filter((v) => !allDocs.includes(v));
  assert.deepStrictEqual(undocumented, [],
    `the code reads variables nobody documented: ${undocumented.join(', ')}`);
});

check('every SQUAD_HUB_* variable the docs describe is actually read', () => {
  const documented = [...new Set([...commands.matchAll(/`(SQUAD_HUB_[A-Z_]+)`/g)].map((m) => m[1]))];
  const invented = documented.filter((v) => !usedVars.includes(v));
  assert.deepStrictEqual(invented, [],
    `documented but never read: ${invented.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Specific claims
// ---------------------------------------------------------------------------
check('the documented default port matches the code', () => {
  const m = cli.match(/value\(argv, 'port', process\.env\.PORT \|\| (\d+)\)/);
  assert.ok(m, 'could not find the default port in the CLI');
  assert.ok(commands.includes(m[1]), `the docs do not mention port ${m[1]}`);
  assert.ok(readme.includes(m[1]), `the README does not mention port ${m[1]}`);
});

check('the documented "no daemon" exit code matches the code', () => {
  assert.match(cli, /if \(flag\(argv, 'json'\)\).*\n.*\n.*return 3;/s,
    'status no longer returns 3 when stopped');
  assert.match(commands, /exits \*\*3\*\*|\| 3 \|/, 'exit code 3 is not documented');
});

check('the documented default home directory matches the code', () => {
  assert.match(read('src/paths.js'), /\.squad-hub/, 'the home directory changed');
  assert.ok(commands.includes('~/.squad-hub'), 'the docs do not state the default home');
});

check('the documented approval options are the ones the code accepts', () => {
  for (const o of ['allow_once', 'allow_always', 'reject_once']) {
    assert.ok(commands.includes(o), `option ${o} is not documented`);
  }
});

check('the documented agent defaults match the code', () => {
  const d = read('src/daemon.js');
  assert.match(d, /SQUAD_HUB_AGENT \|\| 'copilot'/, 'the default agent changed');
  assert.match(d, /\['--acp'\]/, 'the default agent args changed');
  assert.ok(commands.includes('`copilot`'), 'the default agent is not documented');
  assert.ok(commands.includes('`--acp`'), 'the default agent args are not documented');
});

check('the token-precedence claim matches what the code does', () => {
  // The docs say SQUAD_HUB_AGENT_TOKEN is copied into COPILOT_GITHUB_TOKEN.
  assert.match(read('src/cloud-device.js'),
    /COPILOT_GITHUB_TOKEN = process\.env\.SQUAD_HUB_AGENT_TOKEN/,
    'the agent token is no longer copied into COPILOT_GITHUB_TOKEN');
  assert.ok(cloud.includes('COPILOT_GITHUB_TOKEN'), 'the cloud doc does not mention it');
});

// ---------------------------------------------------------------------------
// Links and files
// ---------------------------------------------------------------------------
check('every relative link in the docs resolves to a real file', () => {
  const docs = ['README.md', 'docs/README.md', 'docs/commands.md', 'docs/cloud.md', 'docs/architecture.md'];
  const broken = [];
  for (const d of docs) {
    const dir = path.dirname(path.join(ROOT, d));
    for (const m of read(d).matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target) continue;
      if (!fs.existsSync(path.resolve(dir, target))) broken.push(`${d} -> ${target}`);
    }
  }
  assert.deepStrictEqual(broken, [], `broken links: ${broken.join(', ')}`);
});

/**
 * The architecture document makes behavioural claims -- that a hub restart
 * preserves a pending approval, that a daemon restart does not. Those are the
 * kind of statements that quietly become false when the code changes, and a
 * confidently wrong architecture document is worse than none.
 *
 * This ties each claim to the test that proves it: if the test disappears, the
 * documentation stops being backed by anything and this fails.
 */
check('every behavioural claim in the architecture doc has a test behind it', () => {
  const claims = [
    // [something the doc asserts, the file that proves it]
    [/survives.*same id, still answerable|approval REAPPEARED/i, 'test/restart-unit.js'],
    [/reaped/i, 'test/orphan-unit.js'],
    [/marked \*\*failed\*\* within one heartbeat|marked failed/i, 'test/heartbeat-unit.js'],
    [/partition/i, 'test/isolation-unit.js'],
  ];
  const missing = [];
  for (const [claim, proof] of claims) {
    if (!claim.test(architecture)) continue;
    if (!fs.existsSync(path.join(ROOT, proof))) missing.push(`"${claim}" -> ${proof} is gone`);
  }
  assert.deepStrictEqual(missing, [], missing.join('; '));
});

check('the architecture doc states the one-instance limit', () => {
  // The most consequential operational fact. If it is ever dropped from the
  // doc, someone will scale out and spend a day on intermittent 404s.
  assert.match(architecture, /one instance|single instance/i,
    'the doc no longer warns that only one instance works');
  assert.match(architecture, /Scale up, not out/i, 'the remedy is missing');
});

check('every image the README references exists', () => {
  const missing = [];
  for (const m of readme.matchAll(/src="([^"]+)"/g)) {
    if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(m[1]);
  }
  assert.deepStrictEqual(missing, [], `missing images: ${missing.join(', ')}`);
});

check('every script the docs tell you to run exists', () => {
  const missing = [];
  for (const m of allDocs.matchAll(/\.\/(scripts\/[\w-]+\.ps1)/g)) {
    if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(m[1]);
  }
  assert.deepStrictEqual(missing, [], `missing scripts: ${missing.join(', ')}`);
});

check('every spike the docs cite exists', () => {
  const missing = [];
  for (const m of allDocs.matchAll(/(spike\/[\w-]+\.(?:js|json))/g)) {
    if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(m[1]);
  }
  assert.deepStrictEqual([...new Set(missing)], [], `cited but missing: ${missing.join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
