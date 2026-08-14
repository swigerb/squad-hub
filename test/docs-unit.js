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
const { spawnSync } = require('child_process');

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

// Walk src/ rather than listing files. A hardcoded list silently stops
// covering the codebase the moment someone adds a file, which is precisely
// when the guard is most needed.
function allSourceFiles(dir = 'src', acc = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) allSourceFiles(rel, acc);
    else if (e.name.endsWith('.js')) acc.push(rel);
  }
  return acc;
}
const srcFiles = allSourceFiles();
const usedVars = envVarsIn(srcFiles);

check('no mutation testing artefacts are left in the source tree', () => {
  // test/mutate.js edits real source files in place. If a sweep is interrupted,
  // the edit survives -- and because each one is guarded by `process.env.MUTANT`
  // it is inert, so nothing else notices and the next `git add -A` commits it.
  // That has happened.
  //
  // Skipped while mutate.js is running, since a mutation being present is the
  // entire point then; otherwise every mutant would be "caught" by this check
  // alone and the sweep would prove nothing.
  if (process.env.MUTANT) return;
  const dirty = srcFiles.filter((f) => read(f).includes('MUTATION'));
  assert.deepStrictEqual(dirty, [],
    `live mutation testing edits are still in: ${dirty.join(', ')} -- run git checkout on them`);
});

check('the source scan actually covers the source tree', () => {
  // The failure this catches is a scan that finds nothing and reports green.
  assert.ok(srcFiles.length >= 10, `only ${srcFiles.length} source files found`);
  for (const f of ['src/cli.js', 'src/service/hub-service.js', 'src/service/auth.js']) {
    assert.ok(srcFiles.includes(f), `${f} is missing from the scan`);
  }
});

check('every mutation still anchors to real source', () => {
  /**
   * A mutation whose `find` text no longer appears in the file is a mutation
   * that silently tests NOTHING. The sweep reports it, but a sweep takes hours
   * and is run rarely; this catches the same drift in milliseconds, on every
   * run, which is when it is cheap to fix.
   *
   * The drift is invisible by construction: refactoring the code under an
   * anchor produces no error anywhere, and the catalogue goes on listing a
   * guarantee nobody is checking. That is the exact failure mode the mutation
   * harness exists to prevent, applied to the harness itself.
   */
  if (process.env.MUTANT) return; // a sweep is mid-flight; the file is edited on purpose
  const { MUTATIONS } = require('./mutate');
  assert.ok(MUTATIONS.length >= 50, `only ${MUTATIONS.length} mutations found; the catalogue did not load`);

  const nl = (s) => s.replace(/\r\n/g, '\n');
  const drifted = [];
  for (const m of MUTATIONS) {
    if (m.skip) continue;
    let body;
    try { body = read(m.file); } catch { drifted.push(`${m.name} -> ${m.file} does not exist`); continue; }
    if (!nl(body).includes(nl(m.find))) drifted.push(`${m.name} -> anchor gone from ${m.file}`);
  }
  assert.deepStrictEqual(drifted, [],
    `these mutations would apply nothing and pass silently:\n  ${drifted.join('\n  ')}`);
});

check('every mutation anchor matches EXACTLY ONE place in its file', () => {
  /**
   * `String.replace` with a string pattern rewrites the FIRST match and no
   * other. So an anchor that appears twice does not fail, does not warn, and
   * does not test what it claims -- it quietly mutates whichever copy comes
   * first in the file.
   *
   * This is not hypothetical. `if (s.pid && alive(s.pid)) {` appears in BOTH
   * the forget guard and `_killAllChildren`, so a mutation written to prove
   * the forget guard was instead disabling the orphan killer, and the sweep
   * reported it as caught -- by an unrelated test, for an unrelated reason.
   * An anchor that lands somewhere else is worse than one that lands nowhere:
   * a missing anchor is reported, a misplaced one reads as a pass.
   */
  if (process.env.MUTANT) return;
  const { MUTATIONS } = require('./mutate');
  const nl = (s) => s.replace(/\r\n/g, '\n');
  const ambiguous = [];
  for (const m of MUTATIONS) {
    if (m.skip) continue;
    let body;
    try { body = nl(read(m.file)); } catch { continue; }
    const find = nl(m.find);
    if (!body.includes(find)) continue;   // absence is the other test's job
    const hits = body.split(find).length - 1;
    if (hits > 1) ambiguous.push(`${m.name} -> ${hits} matches in ${m.file}`);
  }
  assert.deepStrictEqual(ambiguous, [],
    `these anchors mutate the first match, which may not be the code under test:\n  ${ambiguous.join('\n  ')}`);
});

check('every mutation names a test that could fail', () => {
  if (process.env.MUTANT) return;
  const { MUTATIONS } = require('./mutate');
  const nameless = MUTATIONS.filter((m) => !m.skip && !m.mustFail);
  assert.deepStrictEqual(nameless.map((m) => m.name), [],
    'a mutation with no named test is caught by whatever happens to break, which proves nothing');
});

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
 * someone's machines. Account names are the same kind of thing -- they tell an
 * attacker exactly which identity to target.
 *
 * The patterns are GENERIC on purpose. An earlier version named the specific
 * hostname it was guarding against -- which put that hostname into the
 * repository, in the very file whose job was to keep it out.
 */
/**
 * Every file GIT WOULD ACTUALLY SHIP.
 *
 * These checks claim to be about what is "in the repo", so they should look at
 * what is in the repo. Walking the working tree instead scans untracked and
 * ignored files, which turned a vendored third-party template into a build
 * failure -- a file that was never going to be published in the first place.
 *
 * If git cannot answer, fall back to walking the filesystem. That is STRICTER,
 * not looser: a guard that quietly checks nothing when its tool is missing is
 * the failure this whole suite exists to prevent.
 */
function repoFiles(extensions = /\.(md|js|ps1|ya?ml|json)$/) {
  try {
    const out = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
    if (out.status === 0 && out.stdout) {
      return out.stdout.split('\0')
        .filter((p) => p && extensions.test(p))
        .map((p) => path.join(ROOT, p))
        .filter((p) => fs.existsSync(p));
    }
  } catch { /* fall through to the stricter walk */ }

  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'images') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (extensions.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  return files;
}

check('no private deployment hostnames appear anywhere in the repo', () => {
  const endpoint = /\b([a-z0-9][a-z0-9-]{2,})\.(?:azurewebsites\.net|azurecontainerapps\.io)\b/gi;
  // Names a reader would recognise as "put your own here".
  const placeholder = /^(my-?hub|my-?squad-?hub|your-?hub|example|app|name|squad-?hub|contoso|fabrikam)$/i;

  const files = repoFiles();

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

check('no GitHub PAT-shaped literal appears anywhere in the repo', () => {
  /**
   * Synthetic token fixtures are still indistinguishable from leaked
   * credentials to DLP scanners. One such fixture caused OneDrive to block
   * github-auth-probe.js for everyone except its owner.
   *
   * Assemble synthetic markers at runtime instead. The redaction tests stay
   * equally strong while the source file no longer looks compromised.
   */
  const pat = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;
  const hits = [];
  for (const f of repoFiles()) {
    const body = fs.readFileSync(f, 'utf8');
    for (const m of body.matchAll(pat)) {
      hits.push(`${path.relative(ROOT, f)}: ${m[0].slice(0, 8)}...`);
    }
  }
  assert.deepStrictEqual(hits, [],
    `a tracked file looks like it contains a GitHub PAT:\n  ${hits.join('\n  ')}`);
});

check('no real email addresses appear anywhere in the repo', () => {
  // Documentation should teach with placeholders. A real address names a
  // person to target, and is trivially committed by pasting a working command.
  const email = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
  /**
   * Domains that exist to be examples, plus the noreply address git trailers
   * use and the throwaway domains in test fixtures.
   *
   * Compared by EQUALITY, not by suffix. A suffix match treated
   * "somecompany.com" as safe because it ends with "y.com" -- so the guard
   * passed on exactly the kind of address it exists to catch.
   */
  const safeDomains = new Set([
    'example.com', 'example.org', 'example.net', 'example',
    'contoso.com', 'fabrikam.com', 'users.noreply.github.com',
    'work.example', 'personal.example',
    'a.com', 'b.com', 'c.com', 'x.com', 'y.com', 'z.com',
  ]);
  /**
   * Subdomains of the RFC 2606 reserved names are documentation too --
   * "prod.example.com" is as fictional as "example.com".
   *
   * The boundary is a leading DOT, deliberately. Matching a bare suffix is what
   * let "somecompany.com" pass as safe because it ends with "y.com".
   */
  const safeSuffixes = ['.example.com', '.example.org', '.example.net', '.example'];
  /**
   * Not an address. This is the SSH remote form every git user pastes, and
   * allowing the exact string is far narrower than trusting github.com, where a
   * real person's address could hide.
   */
  const notAddresses = new Set(['git@github.com']);

  const files = repoFiles();

  const hits = [];
  for (const f of files) {
    // Strip URLs first. A credential in a URL -- https://user:token@host --
    // looks exactly like an email address to a regex, and the redaction tests
    // deliberately contain them. Flagging those would train people to ignore
    // this check, which is how a real leak gets waved through.
    const body = fs.readFileSync(f, 'utf8').replace(/\bhttps?:\/\/\S+/gi, '');
    for (const m of body.matchAll(email)) {
      const address = m[0].toLowerCase();
      const domain = address.split('@')[1];
      if (notAddresses.has(address)) continue;
      if (safeDomains.has(domain)) continue;
      if (safeSuffixes.some((sfx) => domain.endsWith(sfx))) continue;
      hits.push(`${path.relative(ROOT, f)}: ${m[0]}`);
    }
  }
  assert.deepStrictEqual(hits, [], `a real address leaked into the repo:\n  ${hits.join('\n  ')}`);
});

/**
 * Internal-only codenames, and the internal documentation host, must never
 * reach a public repository. This is a one-way door: once pushed, the term is
 * in clones, forks, caches and the GitHub API, and deleting it later does not
 * un-publish it.
 *
 * The forbidden terms are assembled from character codes rather than written
 * out, because a guard that spells the secret it protects is itself the leak
 * -- and would match itself, making the check permanently red.
 */
check('no internal codename or internal doc host appears anywhere in the repo', () => {
  const term = (...codes) => String.fromCharCode(...codes);
  const forbidden = [
    { what: 'an internal codename', re: new RegExp(term(97, 103, 101, 110, 99, 121), 'gi') },
    { what: 'the internal doc host', re: new RegExp(term(101, 110, 103) + '\\.' + term(109, 115), 'gi') },
  ];

  // Every tracked file, not just documentation: a codename in a comment, a
  // fixture or a test name is just as public as one in the README.
  const files = repoFiles(/./);
  assert.ok(files.length >= 20, `only ${files.length} files scanned; the scan is broken`);

  // Prove the detector detects. A guard that scans everything and matches
  // nothing is indistinguishable from a guard whose pattern never matches
  // anything at all -- both are silently, permanently green.
  for (const { what, re } of forbidden) {
    const canary = what.includes('host')
      ? `see ${String.fromCharCode(101, 110, 103)}.${String.fromCharCode(109, 115)}/docs`
      : `parity with ${String.fromCharCode(97, 103, 101, 110, 99, 121)} hub`;
    re.lastIndex = 0;
    assert.ok(re.test(canary), `the detector for ${what} does not detect it`);
    re.lastIndex = 0;
  }

  const hits = [];
  for (const f of files) {
    let body;
    try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (body.includes('\0')) continue; // binary
    for (const { what, re } of forbidden) {
      const found = body.match(re);
      if (found) hits.push(`${path.relative(ROOT, f)}: ${what} (${found.length}x)`);
    }
  }
  assert.deepStrictEqual(hits, [], `internal-only terms leaked into a public repo:\n  ${hits.join('\n  ')}`);
});

check('no internal codename appears in the commit history', () => {
  // Rewriting published history is disruptive and incomplete, so the only
  // real defence is never committing the term. Catch it while it is still
  // local and a rebase is cheap.
  const term = String.fromCharCode(97, 103, 101, 110, 99, 121);
  const log = spawnSync('git', ['log', '--all', '-i', `--grep=${term}`, '--oneline'],
    { cwd: ROOT, encoding: 'utf8' });
  if (log.status !== 0) return; // no git; the file scan above still applies
  const hits = log.stdout.trim().split('\n').filter(Boolean);
  assert.deepStrictEqual(hits, [], `an internal codename is in a commit message:\n  ${hits.join('\n  ')}`);
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

check('the docs never tell you to create a retired Office 365 Connector', () => {
  /**
   * The connector this used to describe was retired -- rollout completed in
   * May 2026 -- so the old instruction ("add an Incoming Webhook to the
   * channel") cannot be followed at all any more. A setup step that is
   * impossible is worse than one that is missing: it reads as correct right up
   * until someone spends an afternoon looking for a menu item that was removed.
   *
   * The card payload did not change; only how you obtain the URL did.
   */
  const offenders = [];
  for (const [name, body] of [['docs/commands.md', commands], ['README.md', readme],
    ['docs/README.md', docsIndex], ['docs/cloud.md', cloud],
    ['docs/architecture.md', architecture], ['docs/security.md', security]]) {
    // Scoped to the PARAGRAPH, not to a character window. A window wide enough
    // to hold the disclaimer is also wide enough to be rescued by an unrelated
    // neighbouring paragraph -- which is exactly what happened when this was
    // first written, and it made the guard pass against a doc that had gone
    // back to the impossible instruction.
    for (const para of body.split(/\n\s*\n/)) {
      if (!/incoming webhook/i.test(para)) continue;
      if (/retire|no longer|replaced|Workflows|Power Automate/i.test(para)) continue;
      offenders.push(`${name}: "${para.trim().slice(0, 60)}…"`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `the docs still describe a connector that cannot be created:\n  ${offenders.join('\n  ')}`);
});

check('the Teams webhook variable is explained where it is set', () => {
  assert.match(commands, /Power Automate/,
    'telling someone to set a webhook URL without saying how to obtain one is half an instruction');
  assert.match(commands, /Workflows/);
});

check('every navigation in the browser suite tolerates being interrupted', () => {
  /**
   * The PWA cache checks have gone red on CI three times, always with
   * "Navigation to X is interrupted by another navigation to X", and twice I
   * fixed only the call site that had been seen to fail. It came back at a
   * `goto` two lines away.
   *
   * The property is that THIS APP NAVIGATES ON ITS OWN -- the offline page
   * reloads itself when the network returns, and a token in the URL is
   * stripped by a replace -- so any navigation can lose that race on a slow
   * runner. `gotoSettled` is the only navigation that survives it.
   *
   * Asserted on the source, not on behaviour, deliberately: a timing flake
   * cannot be caught reliably by running the thing that flakes. This check
   * cannot itself flake, and it fails the moment someone reintroduces the
   * shape rather than the moment CI happens to lose the race again.
   */
  const suite = read('test/browser-e2e-unit.js');
  const offenders = suite
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    // Inside gotoSettled itself the bare call is the implementation.
    .filter(({ line }) => /\bpage\.goto\(/.test(line) && !/^return (await )?page\.goto\(/.test(line))
    .map(({ line, n }) => `line ${n}: ${line}`);

  assert.deepStrictEqual(offenders, [],
    'these navigations bypass gotoSettled and will flake on a slow runner:\n  '
    + `${offenders.join('\n  ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
