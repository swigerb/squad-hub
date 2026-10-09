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
const { readWebClient } = require('./helpers/web-source');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => (p === 'web/app.js' ? readWebClient() : fs.readFileSync(path.join(ROOT, p), 'utf8'));

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

// PR #244 review (Finding 3): several checks below need the exact text of
// the recommended VAPID transfer script -- both as a prose target and as
// literal JS this suite can hand straight to `node -e` and actually run
// against a local stub server. One extraction, reused everywhere, so a doc
// edit that moves or grows the script cannot silently desync a hand-picked
// slice length from the text it is meant to cover.
function extractRecommendedScript() {
  const marker = 'node -e "\n';
  let idx = security.indexOf(marker);
  while (idx !== -1) {
    const after = idx + marker.length;
    const closeIdx = security.indexOf('\n"\n```', after);
    if (closeIdx !== -1) {
      const candidate = security.slice(after, closeIdx);
      if (candidate.includes('function settingsRequest')) return candidate;
    }
    idx = security.indexOf(marker, idx + 1);
  }
  return null;
}
const recommendedScript = extractRecommendedScript();

function fencedCodeBlocks(text) {
  const blocks = [];
  const re = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) blocks.push(m[1]);
  return blocks;
}

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
    try { body = fs.readFileSync(path.join(ROOT, m.file), 'utf8'); } catch { drifted.push(`${m.name} -> ${m.file} does not exist`); continue; }
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
    try { body = nl(fs.readFileSync(path.join(ROOT, m.file), 'utf8')); } catch { continue; }
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
  // One line each, no /s: with /s every .* spans the whole file and the
  // backtracking took 34 s on node 24 and over the 120 s child budget on node 18.
  assert.match(cli, /if \(flag\(argv, 'json'\)\)[^\n]*\n[^\n]*\n[^\n]*return 3;/,
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

// #172: the device rail was split into grouped sections (ACA jobs,
// ACA executions, cloud devices, local machines), with a header summary
// line, per-section collapse and new empty states. The doc's claims about
// that redesign are checked against the actual rail markup the client
// builds, not just asserted in prose that could drift the next time the
// rail changes shape.
check('docs describe the device rail\'s grouped sections, and the code matches', () => {
  const client = read('web/app.js');
  for (const label of ['ACA jobs', 'Squad on ACA executions', 'Cloud devices', 'Local machines']) {
    assert.ok(commands.includes(label), `commands.md does not mention the "${label}" section`);
    assert.ok(client.includes(label), `the rail no longer renders a "${label}" section`);
  }
  assert.match(client, /deviceSummaryLine/, 'the rail header summary line is no longer rendered');
  assert.ok(commands.includes('N online') || commands.includes('online \u00b7'),
    'commands.md does not describe the "N online · N sessions" summary line');
});

check('docs describe the devices-panel empty states, and the code matches', () => {
  const client = read('web/app.js');
  assert.ok(commands.includes('No sessions yet'), 'commands.md does not mention the "No sessions yet" empty state');
  assert.match(client, /No sessions yet/, 'the empty session list no longer says "No sessions yet"');
  assert.ok(commands.includes('npx squad-hub start'), 'commands.md does not mention the copyable npx squad-hub start command');
  assert.match(client, /npx squad-hub start/, 'the local-devices empty state no longer offers npx squad-hub start');
});

// Issue #177: the hub gained a second way to start an ACA job -- a GitHub
// App calling workflow_dispatch directly -- which moves who may trigger a
// job from "is this person a collaborator on the repo" to "is the App
// installed on the repo". That is a real widening of who can act, not an
// implementation detail, and the brief for #177 requires it be stated
// plainly rather than left to be inferred from the API shape.
check('security.md states the new GitHub-App trust boundary plainly', () => {
  // The sentence wraps across lines, and the source blockquotes it (each
  // line prefixed with "> "), so normalize both before checking.
  const normalized = security.replace(/\*\*/g, '').replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
  assert.ok(normalized.includes('any signed-in hub user can dispatch a job on it directly'),
    'the new rule -- App installation, not per-user collaborator status, gates a dispatch -- is not stated plainly');
  assert.match(security, /SQUAD_HUB_GH_APP_ID/, 'the App env var is not documented in security.md');
  assert.match(security, /never Azure/i, 'security.md must say the App token is a GitHub credential, never Azure');
});

check('aca.md documents the hub dispatching a job directly (issue #177)', () => {
  const aca = read('docs/aca.md');
  assert.match(aca, /workflow_dispatch/, 'aca.md does not mention workflow_dispatch');
  assert.match(aca, /\/api\/aca\/dispatch/, 'aca.md does not mention the dispatch endpoint');
  assert.match(aca, /squad-on-aca#135/, 'aca.md does not cite the forward-compatibility issue (#135)');
});

// Issue #187: api.md promised every endpoint would be documented, and the
// three `/api/aca/*` routes (added for #177) existed in the code with no
// matching entry here -- the exact drift this suite exists to catch.
check('api.md documents the /api/aca/* endpoints', () => {
  const api = read('docs/api.md');
  for (const route of ['GET /api/aca/status', 'GET /api/aca/repos', 'GET /api/aca/dispatches', 'POST /api/aca/dispatch']) {
    assert.ok(api.includes(route), `api.md does not document ${route}`);
  }
  assert.match(api, /501/, 'api.md does not say the aca routes answer 501 when the App is not configured');
});

// Issue #187: a hosted hub needs the GitHub App credentials to dispatch jobs
// directly, and cloud.md -- the doc that walks through deploying a hub --
// never named them.
check('cloud.md documents the GitHub App settings for direct ACA dispatch', () => {
  const cloudDoc = read('docs/cloud.md');
  assert.match(cloudDoc, /SQUAD_HUB_GH_APP_ID/, 'cloud.md does not mention SQUAD_HUB_GH_APP_ID');
  assert.match(cloudDoc, /SQUAD_HUB_GH_APP_PRIVATE_KEY/, 'cloud.md does not mention SQUAD_HUB_GH_APP_PRIVATE_KEY');
});

// Issue #187: /api/prefs is per-user state like every other partitioned
// lookup, and security.md's partitioning section did not say so.
check('security.md documents that /api/prefs follows the same per-user partitioning', () => {
  assert.match(security, /api\/prefs/, 'security.md does not mention /api/prefs under per-user isolation');
});

// PR #244 review (Finding 3): an earlier revision of this doc required the
// literal dangerous command `console.log(JSON.stringify(...generateVapidKeys()))`
// to be present, as a "DO NOT DO THIS" counter-example. Scout flagged that
// keeping a runnable, copy-pasteable version of the unsafe command around is
// itself a temptation -- it has been removed and replaced with prose that
// still explains the hazard. No fenced, runnable code block anywhere in the
// doc may print the private key, the raw generator output, or the specific
// dangerous call that used to be the counter-example.
check('security.md never shows a runnable command that prints the VAPID private key or raw generator output', () => {
  assert.ok(recommendedScript, 'no direct settings-API transfer procedure found');
  const blocks = fencedCodeBlocks(security);
  assert.ok(blocks.length > 0, 'expected at least one fenced code block in security.md');
  const dangerousLog = /(console\.log|console\.error|process\.stdout\.write)\s*\([^)]*(privateKey|generateVapidKeys\(\)|JSON\.stringify\(require\('\.\/src\/service\/web-push\.js'\)\.generateVapidKeys\(\)\))/;
  for (const block of blocks) {
    assert.ok(!dangerousLog.test(block),
      'a fenced, runnable code block in security.md prints the VAPID private key or the raw generator output');
  }
  // The recommended procedure's own code block must capture the pair in
  // process memory and hand the private half straight to the settings
  // store's own HTTPS API -- never log it.
  assert.ok(!/console\.log\([^)]*privateKey/.test(recommendedScript), 'the recommended procedure must never log the private key');
  // Removing the counter-example must not silently drop the "why" along
  // with it -- the hazard must still be explained in prose.
  assert.match(security, /stdout is not memory-only/, 'security.md must still explain the stdout/log-capture hazard in prose');
  assert.match(security, /scrollback/, 'security.md must still name a concrete stdout-capture hazard (terminal scrollback, CI step logs, session recording)');
});

// Scout review (follow-up to #244): a clipboard is not memory-only either --
// a synced/history-tracking clipboard retains the private key even after the
// current entry is overwritten or "cleared". No production key was ever
// exposed through this; the docs are being corrected before any incident,
// not after one. The recommended procedure must not use a clipboard command
// at all, only the counter-example framing may mention clipboards (to
// explain why one was removed).
check('security.md no longer recommends a clipboard for VAPID private key transfer', () => {
  assert.ok(recommendedScript, 'no direct settings-API transfer procedure found');
  for (const clipboardCmd of ['pbcopy', 'xclip', 'xsel', /\bclip\b/]) {
    assert.ok(!recommendedScript.match(clipboardCmd), `the recommended procedure must not use ${clipboardCmd} to transfer the private key`);
  }
  assert.match(security, /clipboard is not memory-only/, 'security.md must explain why a clipboard was rejected, not just silently drop it');
});

// Scout review (follow-up to #244): the recommended procedure must inspect
// the existing pair before generating anything, and refuse rather than
// silently overwrite -- both when a complete pair is already configured
// (this is initial-setup only, never a redeploy/rotation shortcut) and when
// only one half is present (never silently fill in a mismatched half).
check('security.md\'s VAPID transfer procedure refuses to run when a complete pair is already configured', () => {
  assert.match(security, /a VAPID key pair is already configured/, 'security.md must refuse when both halves are already set');
  assert.match(security, /initial setup only/, 'security.md must say this procedure is initial-setup only, not a redeploy/rotation path');
});

check('security.md\'s VAPID transfer procedure refuses to run when only one half of the pair is configured', () => {
  assert.match(security, /only one half of a VAPID pair is currently set/, 'security.md must refuse an incomplete pair rather than silently generating the missing half');
});

// Scout review (follow-up to #244): the settings API replaces the entire
// settings object rather than merging, so the recommended script must
// explicitly carry every pre-existing setting forward -- otherwise following
// this doc would silently delete every other App Service setting.
check('security.md\'s VAPID transfer procedure preserves every other existing setting', () => {
  assert.ok(recommendedScript, 'no direct settings-API transfer procedure found');
  assert.match(recommendedScript, /Object\.assign\(\{\}, existing,/, 'the recommended script must merge the new VAPID keys into the existing settings, not replace them');
  assert.match(recommendedScript, /preserved unchanged/, 'the recommended script must confirm pre-existing settings were preserved');
});

// Scout review (follow-up to #244): after writing the new pair, the
// procedure must read it back and compare, and give an explicit, safe error
// -- never a silent success -- on any failure (unreadable settings, a
// failed write, or a stored public key that does not match what was sent).
check('security.md\'s VAPID transfer procedure reads back and validates the stored public key, with explicit safe errors', () => {
  assert.ok(recommendedScript, 'no direct settings-API transfer procedure found');
  assert.match(recommendedScript, /MISMATCH/, 'the recommended script must detect and report a stored public key that does not match what was generated');
  assert.match(recommendedScript, /console\.error\('Refusing/, 'the recommended script must give an explicit refusal message, not fail silently');
});

// PR #244 review (Finding 1): Azure App Service has no documented GET for
// reading config/appsettings -- the real "List Application Settings"
// operation is a POST to .../list. The recommended script must use POST+
// /list for every READ, and must keep the write as a plain PUT with no
// /list suffix (that part was already correct).
check('security.md\'s VAPID transfer procedure reads settings via POST .../list, never GET, and writes via plain PUT', () => {
  assert.ok(recommendedScript, 'no direct settings-API transfer procedure found');
  assert.match(recommendedScript, /resourcePath \+ '\/list'/, 'reads must be sent to resourcePath + \'/list\'');
  assert.match(recommendedScript, /settingsRequest\('POST'\)/, 'the read calls must use POST, matching Azure\'s real List Application Settings operation');
  assert.ok(!/settingsRequest\('GET'\)/.test(recommendedScript), 'the recommended script must never use GET to read settings -- Azure has no documented GET for this resource');
  assert.match(recommendedScript, /settingsRequest\('PUT', \{ properties: merged \}\)/, 'the write must stay a PUT carrying the merged properties');
  // The write's own path construction must never carry a /list suffix.
  const writePathLine = recommendedScript.match(/const reqPath = .*/);
  assert.ok(writePathLine, 'could not find the request path construction');
  assert.match(writePathLine[0], /method === 'POST' \? resourcePath \+ '\/list' : resourcePath/, 'only POST (read) may append /list -- PUT (write) must use the bare resourcePath');
});

// Scout review (follow-up to #244, Finding 2a/2b): a malformed or
// unexpected-shape response must never be silently treated as "no settings"
// -- that would make the write below delete every real pre-existing
// setting. JSON.parse must be guarded (never thrown out of the response
// event handler), and the whole async IIFE must have a top-level .catch so
// a network failure produces a clean refusal, not a crash dump.
check('security.md\'s VAPID transfer procedure validates response shape and guards against malformed JSON and network failures', () => {
  assert.ok(recommendedScript, 'no direct settings-API transfer procedure found');
  assert.match(recommendedScript, /typeof res\.body !== 'object'/, 'the script must validate that the response body is actually an object');
  assert.match(recommendedScript, /typeof res\.body\.properties !== 'object'/, 'the script must validate that body.properties is actually an object, not just truthy');
  assert.match(recommendedScript, /try \{\s*\n\s*resolve\(\{ status: res\.statusCode, body: JSON\.parse\(data\) \}\);\s*\n\s*\} catch/, 'JSON.parse must be wrapped in a try/catch inside the response handler, never allowed to throw out of it');
  assert.match(recommendedScript, /\}\)\(\)\.catch\(\(err\) => \{/, 'the top-level async IIFE must have its own .catch so a network failure (req.on(\'error\', reject)) produces a clean refusal, not an unhandled rejection');
  assert.ok(!/const existing = current\.body\.properties \|\| \{\}/.test(recommendedScript), 'the script must never fall back silently to {} on an unchecked response shape');
});

// Scout review (follow-up to #244, Finding 2c): the readback after writing
// must validate status+shape exactly like the initial read (not a looser
// check), and must verify EVERY pre-existing key survived the write with
// its original value -- not just count how many input keys there were.
check('security.md\'s VAPID transfer procedure validates the readback\'s shape and checks every pre-existing key by value', () => {
  assert.ok(recommendedScript, 'no direct settings-API transfer procedure found');
  assert.match(recommendedScript, /readProperties\(readback, 'read back the settings just written'\)/, 'the readback must run through the same shape/status validation as the initial read');
  assert.match(recommendedScript, /for \(const key of Object\.keys\(existing\)\) \{/, 'the script must iterate every pre-existing key');
  assert.match(recommendedScript, /if \(stored\[key\] !== existing\[key\]\) \{/, 'the script must compare each pre-existing key\'s readback value against its original value, not just count keys');
});

// Scout review (follow-up to #244, Finding 2d): an earlier revision ran the
// public/private correspondence check as a SEPARATE manual procedure that
// told the operator to paste the private key into the shell environment --
// itself a hand-the-secret-around step the main procedure is held against
// elsewhere. That separate paste-based example must be gone; the same ECDH
// check must be folded into the one recommended script, running in memory
// on the freshly generated pair before any network write.
check('security.md folds the ECDH correspondence check into the one recommended script, with no separate paste-based example', () => {
  assert.ok(recommendedScript, 'no direct settings-API transfer procedure found');
  assert.match(recommendedScript, /crypto\.createECDH\('prime256v1'\)/, 'the recommended script must run the ECDH correspondence check itself');
  assert.match(recommendedScript, /ecdh\.setPrivateKey\(Buffer\.from\(privateKey, 'base64url'\)\)/, 'the in-script check must use the freshly generated privateKey, in memory');
  assert.match(recommendedScript, /derivedPublic !== publicKey/, 'the in-script check must compare the derived public key against the generated publicKey before any write');
  assert.ok(!/CANDIDATE_PRIVATE_KEY/.test(security), 'security.md must no longer tell an operator to paste a candidate private key into the shell environment');
  assert.ok(!/Paste the two candidate values/.test(security), 'the separate paste-based correspondence example must be removed entirely');
});

// ---------------------------------------------------------------------------
// Finding 3: mutation-grade EXECUTABLE proof for the recommended VAPID
// transfer script, not just prose assertions against the markdown text.
//
// The script is extracted verbatim (`recommendedScript` above) and actually
// run with `node -e`, against a local plain-HTTP stub standing in for
// Azure's app-settings endpoint -- the exact seam the script itself
// documents (`APP_SERVICE_SETTINGS_HOST` / `_INSECURE_TEST_TRANSPORT`,
// both production-safe-by-default, test-only when set).
//
// A single in-process `check()` cannot both run an HTTP server (event-loop
// driven) and synchronously block on the script-under-test's completion --
// Node has no way to interleave those on one thread. So each scenario below
// spawns ONE self-contained "driver" subprocess (via spawnSync, which is
// fine because the parent has nothing else to do while it runs): the driver
// starts the stub server, uses ASYNC `spawn` (not spawnSync) to run the
// extracted script so its own event loop keeps serving HTTP requests while
// waiting, then reports a single JSON result line back over stdout for this
// suite to assert against synchronously.
// ---------------------------------------------------------------------------

function vapidDriverSource() {
  return `
const http = require('http');
const { spawn } = require('child_process');

(async () => {
  const scenario = JSON.parse(process.env.__VAPID_SCENARIO__);
  const script = process.env.__VAPID_SCRIPT__;
  const requests = { lists: [], writes: [] };
  let listCallIndex = 0;
  let storedProperties = scenario.initialProperties || {};
  let server = null;
  let port = 1; // nothing listens here -- used as-is for the closed-port scenario

  if (!scenario.closedPort) {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const urlPath = req.url.split('?')[0];
        if (req.method === 'POST' && urlPath.endsWith('/list')) {
          requests.lists.push(req.method + ' ' + req.url);
          const callIdx = listCallIndex;
          listCallIndex += 1;
          if (scenario.malformedRaw !== undefined && callIdx === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(scenario.malformedRaw);
            return;
          }
          if (scenario.missingProperties && callIdx === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ notProperties: true }));
            return;
          }
          if (scenario.listStatus && scenario.listStatus !== 200 && callIdx === 0) {
            res.writeHead(scenario.listStatus, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ properties: storedProperties }));
            return;
          }
          if (scenario.forceMismatchOnSecondRead && callIdx >= 1) {
            const decoy = Object.assign({}, storedProperties, { SQUAD_HUB_VAPID_PUBLIC_KEY: 'DECOY-NOT-THE-REAL-KEY' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ properties: decoy }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ properties: storedProperties }));
          return;
        }
        if (req.method === 'PUT') {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
          requests.writes.push({ url: req.url, method: req.method, body: parsed });
          if (parsed && parsed.properties) storedProperties = parsed.properties;
          res.writeHead(scenario.writeStatus || 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ properties: storedProperties }));
          return;
        }
        requests.lists.push('UNEXPECTED ' + req.method + ' ' + req.url);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  }

  const child = spawn(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, {
      APP_SERVICE_SETTINGS_HOST: '127.0.0.1:' + port,
      APP_SERVICE_SETTINGS_INSECURE_TEST_TRANSPORT: '1',
      APP_SERVICE_SETTINGS_PATH: '/test/path',
      AZ_ACCESS_TOKEN: 'test-token',
    }),
  });
  let childStdout = '';
  let childStderr = '';
  child.stdout.on('data', (d) => { childStdout += d; });
  child.stderr.on('data', (d) => { childStderr += d; });
  const status = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } resolve(124); }, 8000);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });

  if (server) await new Promise((resolve) => server.close(resolve));

  process.stdout.write('__VAPID_RESULT__' + JSON.stringify({ status, stdout: childStdout, stderr: childStderr, requests }));
  process.exit(0);
})().catch((err) => {
  process.stdout.write('__VAPID_RESULT__' + JSON.stringify({ status: -1, stdout: '', stderr: String((err && err.stack) || err), requests: { lists: [], writes: [] } }));
  process.exit(0);
});
`;
}

function runVapidScenario(scenario) {
  assert.ok(recommendedScript, 'no direct settings-API transfer procedure found');
  const r = spawnSync(process.execPath, ['-e', vapidDriverSource()], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: Object.assign({}, process.env, {
      __VAPID_SCENARIO__: JSON.stringify(scenario),
      __VAPID_SCRIPT__: recommendedScript,
    }),
  });
  const out = r.stdout || '';
  const idx = out.indexOf('__VAPID_RESULT__');
  if (idx === -1) {
    throw new Error('vapid scenario driver produced no result; status=' + r.status + ' stdout=' + out + ' stderr=' + (r.stderr || ''));
  }
  return JSON.parse(out.slice(idx + '__VAPID_RESULT__'.length));
}

check('executable: the recommended script reads via POST .../list (not GET) and writes via PUT (not /list)', () => {
  const result = runVapidScenario({ initialProperties: { UNRELATED_SETTING: 'keep-me' } });
  assert.strictEqual(result.status, 0, 'expected success; stderr=' + result.stderr);
  assert.ok(result.requests.lists.every((l) => l.startsWith('POST') && l.includes('/list')), `every read must be POST .../list, got: ${JSON.stringify(result.requests.lists)}`);
  assert.ok(result.requests.writes.length === 1 && result.requests.writes[0].method === 'PUT' && !result.requests.writes[0].url.includes('/list'),
    `the write must be a single PUT with no /list suffix, got: ${JSON.stringify(result.requests.writes)}`);
});

check('executable: with no existing pair, the script succeeds, preserves unrelated settings, adds both VAPID keys, and never prints the private key', () => {
  const result = runVapidScenario({ initialProperties: { UNRELATED_SETTING: 'keep-me', ANOTHER_SETTING: '42' } });
  assert.strictEqual(result.status, 0, 'expected success; stderr=' + result.stderr);
  const written = result.requests.writes[0].body.properties;
  assert.strictEqual(written.UNRELATED_SETTING, 'keep-me', 'unrelated setting must survive the write unchanged');
  assert.strictEqual(written.ANOTHER_SETTING, '42', 'unrelated setting must survive the write unchanged');
  assert.ok(written.SQUAD_HUB_VAPID_PUBLIC_KEY, 'the public key must be written');
  const privateKey = written.SQUAD_HUB_VAPID_PRIVATE_KEY;
  assert.ok(privateKey, 'the private key must be written');
  const combined = result.stdout + result.stderr;
  assert.ok(!combined.includes(privateKey), 'the generated private key must never appear in the script\'s stdout or stderr');
});

check('executable: the script refuses and makes no write when a complete VAPID pair is already configured', () => {
  const result = runVapidScenario({ initialProperties: { SQUAD_HUB_VAPID_PUBLIC_KEY: 'existing-pub', SQUAD_HUB_VAPID_PRIVATE_KEY: 'existing-priv' } });
  assert.notStrictEqual(result.status, 0, 'expected a non-zero (refusal) exit');
  assert.match(result.stdout + result.stderr, /already configured/, 'expected the "already configured" refusal message');
  assert.strictEqual(result.requests.writes.length, 0, 'no write may happen when a complete pair is already configured');
});

check('executable: the script refuses and makes no write when only one half of the pair is configured', () => {
  const result = runVapidScenario({ initialProperties: { SQUAD_HUB_VAPID_PUBLIC_KEY: 'existing-pub-only' } });
  assert.notStrictEqual(result.status, 0, 'expected a non-zero (refusal) exit');
  assert.match(result.stdout + result.stderr, /only one half/, 'expected the "only one half" refusal message');
  assert.strictEqual(result.requests.writes.length, 0, 'no write may happen when only one half of the pair is configured');
});

check('executable: the script refuses safely, with no write, when the read response is not valid JSON', () => {
  const result = runVapidScenario({ malformedRaw: 'this is not { json' });
  assert.notStrictEqual(result.status, 0, 'expected a non-zero (refusal) exit');
  assert.match(result.stdout + result.stderr, /Refusing/, 'expected an explicit safe refusal, not a crash');
  assert.strictEqual(result.requests.writes.length, 0, 'no write may happen after an unreadable response');
});

check('executable: the script refuses safely, with no write, when the read response is JSON but missing properties', () => {
  const result = runVapidScenario({ missingProperties: true });
  assert.notStrictEqual(result.status, 0, 'expected a non-zero (refusal) exit');
  assert.match(result.stdout + result.stderr, /Refusing/, 'expected an explicit safe refusal, not a crash');
  assert.strictEqual(result.requests.writes.length, 0, 'no write may happen after a malformed-shape response');
});

check('executable: the script refuses safely, with no write, on a non-200 read status', () => {
  const result = runVapidScenario({ listStatus: 500 });
  assert.notStrictEqual(result.status, 0, 'expected a non-zero (refusal) exit');
  assert.match(result.stdout + result.stderr, /Refusing/, 'expected an explicit safe refusal, not a crash');
  assert.strictEqual(result.requests.writes.length, 0, 'no write may happen after a non-200 read status');
});

check('executable: the script refuses safely, with no crash and no write, on a connection failure', () => {
  const result = runVapidScenario({ closedPort: true });
  assert.notStrictEqual(result.status, 0, 'expected a non-zero (refusal) exit');
  const combined = result.stdout + result.stderr;
  assert.match(combined, /Refusing/, 'a network failure must produce a clean refusal message');
  assert.ok(!/UnhandledPromiseRejection/i.test(combined), 'a network failure must never surface as an unhandled promise rejection / crash dump');
  assert.strictEqual(result.requests.writes.length, 0, 'no write may happen after a connection failure');
});

check('executable: the script detects and reports a readback public-key mismatch after a successful write', () => {
  const result = runVapidScenario({ initialProperties: {}, forceMismatchOnSecondRead: true });
  assert.notStrictEqual(result.status, 0, 'expected a non-zero (refusal) exit after detecting the mismatch');
  assert.match(result.stdout + result.stderr, /MISMATCH/, 'expected the script to report MISMATCH');
  assert.strictEqual(result.requests.writes.length, 1, 'the write itself must still have happened before the readback caught the mismatch');
});

// PR #244 review: security.md claimed /api/me's push.publicKey is derived
// from the private key via ECDH on every read. WebPushSender actually reads
// the configured SQUAD_HUB_VAPID_PUBLIC_KEY directly (src/service/web-push.js),
// never re-deriving it -- so a mismatched pair is not automatically caught.
check('security.md accurately describes publicKey as a configured readback, not an automatic ECDH derivation', () => {
  assert.match(security, /not\*\* re-derived from the private scalar via ECDH/,
    'security.md must state the public key is read from config, never re-derived');
  assert.match(security, /not automatically caught/,
    'security.md must state a mismatched pair is not automatically caught');
});

// Issue #187: the bell and the desktop-notification behaviour it drives
// existed in the web client with no entry in commands.md.
check('commands.md documents the notification bell', () => {
  assert.match(commands, /## Desktop notifications/, 'commands.md has no Desktop notifications section');
  assert.match(commands, /actionNeeded/, 'commands.md does not tie the bell count to actionNeeded');
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

check('the docs describe the resolution follow-up, and that it is bounded', () => {
  assert.match(commands, /follow-up posts to the same channel/i,
    'the follow-up behavior (#176) is not documented');
  assert.match(commands, /answered or\s+expires/i);
  assert.match(commands, /no follow-up/i,
    'the "no card, no follow-up" rule is not documented');
  assert.match(commands, /retried a few times with/i,
    'the bounded retry is not documented');
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

// ---------------------------------------------------------------------------
// American English (#167)
// ---------------------------------------------------------------------------
check('web/ UI strings and docs/ use American English spelling', () => {
  /**
   * A small, explicit allow-list rather than a dictionary lookup or a
   * spellchecker: the handful of British spellings that have actually shown
   * up in this UI and its docs (`organisation`, `summarise`, `recognise`,
   * `honour`, `behaviour`, `colour`, and their inflections, plus a few more
   * from the same sweep), each mapped to the American form it must become.
   * A guard that tried to catch EVERY British spelling in the dictionary
   * would be noisy and slow for no benefit this project has ever needed;
   * this one is named for the mistake it has actually caught, and grows the
   * same way the day it catches a new one.
   *
   * Public API fields, CLI flags, and env vars are explicitly out of scope
   * (issue #167) and never renamed -- so a wire-protocol literal that
   * happens to spell `cancelled` the British way (MCP's own
   * `notifications/cancelled`, ACP's own `outcome`/status values) lives in
   * `src/`, not here, and is annotated at its own call site instead of
   * living in this allow-list. This guard is deliberately scoped to `web/`
   * and `docs/` only, per the issue's acceptance criteria -- it is a UI and
   * documentation check, not a sweep of every protocol literal in `src/`.
   */
  const BRITISH_TO_AMERICAN = {
    organisation: 'organization', organisations: 'organizations',
    organising: 'organizing', organised: 'organized',
    summarise: 'summarize', summarised: 'summarized', summarising: 'summarizing',
    recognise: 'recognize', recognised: 'recognized', recognising: 'recognizing',
    honour: 'honor', honours: 'honors', honoured: 'honored', honouring: 'honoring',
    behaviour: 'behavior', behaviours: 'behaviors',
    colour: 'color', colours: 'colors', coloured: 'colored', colouring: 'coloring',
    favour: 'favor', favours: 'favors', favourite: 'favorite', favourites: 'favorites',
    labelled: 'labeled', labelling: 'labeling',
    cancelled: 'canceled', cancelling: 'canceling',
    neighbour: 'neighbor', neighbours: 'neighbors', neighbouring: 'neighboring',
    centre: 'center', centres: 'centers', centred: 'centered',
    defence: 'defense', offence: 'offense',
    normalise: 'normalize', normalised: 'normalized', normalising: 'normalizing',
    normalisation: 'normalization',
    optimise: 'optimize', optimised: 'optimized', optimising: 'optimizing',
    optimisation: 'optimization',
    initialise: 'initialize', initialised: 'initialized', initialising: 'initializing',
    artefact: 'artifact', artefacts: 'artifacts',
    grey: 'gray', greys: 'grays',
    programme: 'program', programmes: 'programs',
    catalogue: 'catalog', catalogues: 'catalogs',
    dialogue: 'dialog', dialogues: 'dialogs',
    whilst: 'while', amongst: 'among',
  };
  const BRITISH_RE = new RegExp(`\\b(${Object.keys(BRITISH_TO_AMERICAN).join('|')})\\b`, 'gi');

  // The design mockup's own before/after callout exists to DOCUMENT this very
  // sweep -- it quotes the old spelling on purpose, inside quote marks, to
  // show what changed. Flagging it would be flagging the fix.
  const ALLOW_LINE = [
    /"organisation" in today\\?'s UI becomes "organization"/,
  ];

  function allFiles(dir, exts) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { out.push(...allFiles(full, exts)); continue; }
      if (exts.includes(path.extname(entry.name))) out.push(full);
    }
    return out;
  }

  const targets = [
    ...allFiles(path.join(ROOT, 'web'), ['.html', '.css', '.js', '.webmanifest', '.svg']),
    ...allFiles(path.join(ROOT, 'docs'), ['.md', '.html']),
  ];

  const offenders = [];
  for (const file of targets) {
    const rel = path.relative(ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (ALLOW_LINE.some((re) => re.test(line))) return;
      const hits = line.match(BRITISH_RE);
      if (!hits) return;
      for (const hit of hits) {
        const american = BRITISH_TO_AMERICAN[hit.toLowerCase()];
        offenders.push(`${rel}:${i + 1}: "${hit}" (use "${american}")`);
      }
    });
  }

  assert.deepStrictEqual(offenders, [],
    `British spelling found in web/ or docs/ -- American English only:\n  ${offenders.join('\n  ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
