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
const security = read('docs/security.md');
const allDocs = [commands, readme, docsIndex, cloud, architecture, security].join('\n');

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
  // `squad-hub daemon` and `squad-hub service` are the two COMPONENTS, named
  // after the binary on purpose. They read like commands and are not, and
  // `squad-hub service` is one letter from the real `squad-hub serve` -- so
  // they are excluded explicitly rather than by a cleverer regex that would
  // quietly stop catching genuinely invented commands.
  const componentNames = ['daemon', 'service'];
  const promised = [...allDocs.matchAll(/squad-hub ([a-z][a-z-]+)/g)].map((m) => m[1]);
  const invented = [...new Set(promised)]
    .filter((c) => !componentNames.includes(c))
    .filter((c) => !implemented.includes(c));
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
  const docs = ['README.md', 'docs/README.md', 'docs/commands.md', 'docs/cloud.md', 'docs/architecture.md', 'docs/security.md'];
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

/**
 * No private deployment details in a public repository.
 *
 * A personal hub's hostname is not a secret in the cryptographic sense, but it
 * is an invitation: it names a live endpoint that can start sessions on
 * someone's machines. It has no business in documentation that teaches people
 * to run their own.
 *
 * The pattern is GENERIC on purpose. An earlier version named the specific
 * hostname it was guarding against -- which put that hostname into the
 * repository, in the very file whose job was to keep it out. This flags any
 * concrete Azure endpoint that is not an obvious placeholder, so it protects
 * whoever forks this as well.
 */
check('no private deployment hostnames appear anywhere in the repo', () => {
  const endpoint = /\b([a-z0-9][a-z0-9-]{2,})\.(?:azurewebsites\.net|azurecontainerapps\.io)\b/gi;
  // Names a reader would recognise as "put your own here".
  const placeholder = /^(my-?hub|my-?squad-?hub|your-?hub|example|app|name|squad-?hub|contoso|fabrikam)$/i;

  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'images') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|js|ps1|ya?ml|json)$/.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);

  const hits = [];
  for (const f of files) {
    const body = fs.readFileSync(f, 'utf8');
    for (const m of body.matchAll(endpoint)) {
      // Azure Container Apps names carry a generated suffix; take the first
      // label, which is the app name a person chose.
      const label = m[1].split('.')[0];
      if (placeholder.test(label)) continue;
      hits.push(`${path.relative(ROOT, f)}: ${m[0]}`);
    }
  }
  assert.deepStrictEqual(hits, [], `a private deployment leaked into the repo:\n  ${hits.join('\n  ')}`);
});

check('the docs do not carry sprint-by-sprint history', () => {
  // Reference documentation, not a changelog. Someone arriving to USE this
  // should not have to read how it was built.
  const stale = fs.readdirSync(path.join(ROOT, 'docs'))
    .filter((f) => /sprint|evidence/i.test(f));
  assert.deepStrictEqual(stale, [], `churn documentation is back: ${stale.join(', ')}`);
});

check('every image the README references exists', () => {
  const missing = [];
  for (const m of readme.matchAll(/src="([^"]+)"/g)) {
    if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(m[1]);
  }
  assert.deepStrictEqual(missing, [], `missing images: ${missing.join(', ')}`);
});

check('every image the architecture doc references exists', () => {
  const missing = [];
  for (const m of architecture.matchAll(/src="([^"]+)"/g)) {
    if (!fs.existsSync(path.resolve(path.join(ROOT, 'docs'), m[1]))) missing.push(m[1]);
  }
  assert.deepStrictEqual(missing, [], `missing images: ${missing.join(', ')}`);
});

/**
 * The device-flow diagram makes protocol claims that a reader cannot check.
 *
 * It has already been wrong once: it showed the daemon inside the HUB box,
 * which inverted the record/cache distinction the page exists to explain. And
 * it labelled the browser link "HTTP only" -- faithfully copying an error in
 * the ASCII it replaced -- when the browser also holds a WebSocket.
 *
 * An image cannot be linted, so this pins the claims to the code that has to
 * remain true for the picture to stay honest. If any of these disappear, the
 * diagram is lying and somebody should redraw it.
 */
check('the device-flow diagram still matches the code it depicts', () => {
  const facts = [
    ['the browser opens a WebSocket, so "WebSocket updates" is right',
      'web/app.js', /new WebSocket\(/],
    ['the browser also uses HTTP, so "HTTPS commands" is right',
      'web/app.js', /await fetch\(/],
    ['the daemon runs on the DEVICE, not in the hub',
      'src/cli.js', /daemon-main\.js/],
    ['the daemon dials OUT, so "outbound WebSocket only" is right',
      'src/hub-link.js', /Outbound-only by design/],
    ['one agent process per session',
      'src/daemon.js', /new AcpSession\(/],
    ['the daemon reaps orphaned agents',
      'src/daemon.js', /reapOrphans\(\)\s*\{/],
    ['service state is partitioned per user',
      'src/service/store.js', /_bucket\(subject\)\s*\{/],
  ];
  const broken = [];
  for (const [claim, file, pattern] of facts) {
    if (!pattern.test(read(file))) broken.push(`${claim} -- no longer true in ${file}`);
  }
  assert.deepStrictEqual(broken, [], broken.join('; '));
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
