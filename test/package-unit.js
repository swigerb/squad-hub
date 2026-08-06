'use strict';
/**
 * The published package, checked against what the code actually reads.
 *
 * A test suite can be entirely green and the shipped artefact still be broken,
 * because nothing in the suite ever runs from a TARBALL. That is how this
 * project shipped a `files` whitelist of `bin, src, README, LICENSE` while the
 * server served its entire UI out of `web/`: every test passed, and a published
 * `squad-hub serve` would have started cleanly and served nothing.
 *
 * So this asserts the package CONTENTS, and derives what must be in there from
 * the code and the disk rather than from a hand-maintained list -- a list would
 * simply grow stale the first time somebody added an asset.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

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

/**
 * Ask npm itself what it would publish. Parsing `files` by hand would re-
 * implement npm's own resolution (globs, .npmignore, always-included files)
 * and would therefore agree with itself while disagreeing with reality.
 */
function packedPaths() {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', timeout: 120000,
  });
  const body = (r.stdout || '').slice((r.stdout || '').indexOf('['));
  const parsed = JSON.parse(body);
  return parsed[0].files.map((f) => f.path.replace(/\\/g, '/'));
}

const packed = packedPaths();
const inPackage = (p) => packed.includes(p.replace(/\\/g, '/'));

/** Every file under a directory, repo-relative and slash-separated. */
function filesUnder(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(ROOT, path.join(d.parentPath || d.path, d.name)).replace(/\\/g, '/'));
}

check('npm reports a plausible package (the scan is not silently empty)', () => {
  assert.ok(packed.length >= 20, `only ${packed.length} files packed; the scan is broken`);
});

// ---------------------------------------------------------------------------
// The web UI -- the asset class that was actually missing
// ---------------------------------------------------------------------------

check('the server still serves its UI from web/, so that is the directory to ship', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/service/hub-service.js'), 'utf8');
  // Pinned deliberately: if WEB_ROOT moves, this test must fail LOUDLY rather
  // than keep asserting a directory nothing reads any more.
  assert.match(src, /WEB_ROOT\s*=\s*path\.join\(__dirname,\s*'\.\.',\s*'\.\.',\s*'web'\)/,
    'WEB_ROOT no longer resolves to <root>/web -- update this suite to match');
});

check('every file in web/ is in the published package', () => {
  const assets = filesUnder('web');
  assert.ok(assets.length >= 5, `found only ${assets.length} web assets; the scan is broken`);
  const missing = assets.filter((f) => !inPackage(f));
  assert.deepStrictEqual(missing, [], `web assets missing from the package: ${missing.join(', ')}`);
});

check('the pages the UI actually requests are present, by name', () => {
  // index.html names these directly. A published hub without them is a blank
  // page, which is exactly the failure this suite exists to prevent.
  const required = ['web/index.html', 'web/app.js', 'web/app.css', 'web/app.webmanifest'];
  const missing = required.filter((f) => !inPackage(f));
  assert.deepStrictEqual(missing, [], `missing: ${missing.join(', ')}`);
});

check('every asset index.html references is shipped', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="\/([\w.-]+)"/g)].map((m) => `web/${m[1]}`);
  assert.ok(refs.length >= 4, `only ${refs.length} references found; the scan is broken`);
  const missing = [...new Set(refs)].filter((f) => !inPackage(f));
  assert.deepStrictEqual(missing, [], `referenced but not shipped: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Entry points -- a package.json may not promise files that do not exist
// ---------------------------------------------------------------------------

check('every bin target exists on disk and is shipped', () => {
  const targets = Object.values(pkg.bin || {});
  assert.ok(targets.length >= 1, 'no bin entry; the CLI would not be installable');
  const broken = [];
  for (const t of targets) {
    const rel = t.replace(/^\.\//, '');
    if (!fs.existsSync(path.join(ROOT, rel))) broken.push(`${rel} (missing on disk)`);
    else if (!inPackage(rel)) broken.push(`${rel} (not in package)`);
  }
  assert.deepStrictEqual(broken, [], `broken bin targets: ${broken.join(', ')}`);
});

check('main, if declared, resolves to a real shipped file', () => {
  // `main` previously pointed at src/index.js, which has never existed.
  // Declaring an entry point that cannot be required is a promise to callers
  // that fails only at require() time, in somebody else's project.
  if (!pkg.main) return;
  const rel = pkg.main.replace(/^\.\//, '');
  assert.ok(fs.existsSync(path.join(ROOT, rel)), `main points at ${rel}, which does not exist`);
  assert.ok(inPackage(rel), `main points at ${rel}, which is not in the package`);
});

check('every source file the CLI needs is shipped', () => {
  const missing = filesUnder('src').filter((f) => !inPackage(f));
  assert.deepStrictEqual(missing, [], `source files missing from the package: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Installability
// ---------------------------------------------------------------------------

check('the package declares where it came from, so npx and npm can resolve it', () => {
  assert.ok(pkg.name, 'no name');
  assert.ok(pkg.version, 'no version');
  assert.ok(pkg.repository && pkg.repository.url, 'no repository url');
  assert.match(pkg.repository.url, /github\.com\/[\w-]+\/[\w-]+/, 'repository url is not a GitHub repo');
});

check('the package still has no runtime dependencies', () => {
  // The zero-dependency property is load-bearing: it is why there is no
  // install step, and why `npx` is fast enough to be the recommended path.
  const deps = Object.keys(pkg.dependencies || {});
  assert.deepStrictEqual(deps, [], `runtime dependencies crept in: ${deps.join(', ')}`);
});

check('the test suite is NOT shipped to consumers', () => {
  const leaked = packed.filter((f) => f.startsWith('test/'));
  assert.deepStrictEqual(leaked, [], `test files leaked into the package: ${leaked.join(', ')}`);
});

check('the release tooling is NOT shipped to consumers', () => {
  const leaked = packed.filter((f) => f.startsWith('scripts/'));
  assert.deepStrictEqual(leaked, [], `release scripts leaked into the package: ${leaked.join(', ')}`);
});

// ---------------------------------------------------------------------------
// The release script -- publishing under two names, from one command
// ---------------------------------------------------------------------------

const release = require('../scripts/release-npm');

check('npm run release actually runs the release script', () => {
  const cmd = (pkg.scripts || {}).release;
  assert.ok(cmd, 'no release script; the documented one-command release does not exist');
  const rel = cmd.replace(/^node\s+/, '').trim();
  assert.ok(fs.existsSync(path.join(ROOT, rel)), `release script points at ${rel}, which does not exist`);
});

check('the release publishes the name the README tells people to type', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  // If the README says `npx squad-hub` while the script publishes something
  // else, every install instruction in the project is wrong.
  assert.ok(readme.includes(`npx ${release.PRIMARY}`),
    `the README does not tell people to run npx ${release.PRIMARY}`);
  assert.ok(readme.includes(release.ALIAS),
    `the README does not mention the alias ${release.ALIAS}`);
  assert.strictEqual(release.PRIMARY, pkg.name,
    'the primary published name is not this package name');
});

check('the release goes to the public registry, not a mirror or proxy', () => {
  assert.match(release.REGISTRY, /^https:\/\/registry\.npmjs\.org\/?$/, release.REGISTRY);
  assert.ok(release.sameRegistry('https://registry.npmjs.org', 'https://registry.npmjs.org/'),
    'a trailing slash is treated as a different registry');
  assert.ok(!release.sameRegistry('https://packagefeedproxy.microsoft.io/npm/', release.REGISTRY),
    'an internal proxy is mistaken for the public registry');
  assert.ok(!release.sameRegistry('', ''), 'an unset registry counts as a match');
});

check('renaming for the alias changes the name and nothing else', () => {
  const original = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const renamed = release.withName(original, release.ALIAS);
  assert.strictEqual(JSON.parse(renamed).name, release.ALIAS, 'the name was not changed');
  // Byte-for-byte identical once the name is put back: proves the rewrite is
  // surgical, so an interrupted release cannot leave a reformatted file.
  assert.strictEqual(release.withName(renamed, pkg.name), original,
    'the rewrite is not reversible -- it changed more than the name');
});

check('renaming refuses to guess when there is no name to change', () => {
  // Silently returning the input would publish the alias under the primary
  // name -- i.e. a second, duplicate publish of the same package.
  assert.throws(() => release.withName('{"version":"1.0.0"}', release.ALIAS), /name/i);
});

check('an already-published version is recognised, so a re-run converges', () => {
  assert.ok(release.isAlreadyPublished('npm error code EPUBLISHCONFLICT'));
  assert.ok(release.isAlreadyPublished(
    'npm error 403 You cannot publish over the previously published versions: 0.1.0.'));
});

check('a real publish failure is NOT mistaken for an already-published version', () => {
  // This is the load-bearing half. If an auth, payment or network failure is
  // swallowed as "already published", the script reports success having
  // published one name of two -- and versions are immutable, so the two names
  // can never be brought back into line at that version.
  const realFailures = [
    'npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in.',
    'npm error code E402\nnpm error 402 Payment Required',
    'npm error code E403\nnpm error 403 Forbidden - you do not have permission to publish',
    'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed',
    'npm error code E404\nnpm error 404 Scope not found',
  ];
  const swallowed = realFailures.filter((f) => release.isAlreadyPublished(f));
  assert.deepStrictEqual(swallowed, [], `these failures would be reported as success: ${swallowed.join(' | ')}`);
  assert.ok(!release.isAlreadyPublished(''), 'an empty output counts as already published');
});

check('the release documentation describes the release that exists', () => {
  // Release instructions are followed on a machine nobody is watching, months
  // later, usually at the worst possible moment. A stale command in here is a
  // failed release, so tie the prose to the script it describes.
  const doc = fs.readFileSync(path.join(ROOT, 'docs/releasing.md'), 'utf8');
  const missing = [release.PRIMARY, release.ALIAS, 'npm run release', release.REGISTRY.replace(/\/$/, '')]
    .filter((s) => !doc.includes(s));
  assert.deepStrictEqual(missing, [], `docs/releasing.md never mentions: ${missing.join(', ')}`);
});

check('the release refuses a checkout whose package.json omits the web UI', () => {
  // The exact shape of the bug this project already had, and the exact shape
  // of the accident the docs invite: cloning the default branch, where the
  // `files` list has not been fixed and no test suite would catch it.
  const stale = { bin: pkg.bin, files: ['bin', 'src', 'README.md', 'LICENSE'] };
  const web = () => ['web/index.html', 'web/app.js', 'web/app.css'];
  const required = release.requiredInPackage(stale, web);

  // What npm would pack from that `files` list: no web/ at all.
  const packedWithoutWeb = ['package.json', 'README.md', 'LICENSE', 'bin/squad-hub.js', 'src/cli.js'];
  const missingNow = release.missingFromPack(packedWithoutWeb, required);
  assert.deepStrictEqual(missingNow.sort(), web().sort(),
    'a package with no web/ at all is reported as complete -- the release would go out broken');
});

check('the release accepts a checkout that does ship the web UI', () => {
  // The other half: a guard that rejects everything is as useless as one that
  // rejects nothing, and would simply be disabled by whoever hits it.
  const web = () => ['web/index.html', 'web/app.js'];
  const required = release.requiredInPackage(pkg, web);
  const packed = ['package.json', 'bin/squad-hub.js', 'web/index.html', 'web/app.js'];
  assert.deepStrictEqual(release.missingFromPack(packed, required), []);
});

check('the release checks the CLI entry point, not just the UI', () => {
  const required = release.requiredInPackage({ bin: { 'squad-hub': './bin/squad-hub.js' } }, () => []);
  assert.deepStrictEqual(required, ['bin/squad-hub.js'], 'the bin target is not checked');
  assert.deepStrictEqual(release.missingFromPack(['package.json'], required), ['bin/squad-hub.js']);
});

check('the release checks every web asset, not merely that web/ exists', () => {
  // Shipping index.html without app.js is a blank page with extra steps, so
  // "some of web/ made it" is not a passing condition.
  const web = () => ['web/index.html', 'web/app.js', 'web/app.css', 'web/logo.jpg'];
  const required = release.requiredInPackage(pkg, web);
  const missing = release.missingFromPack(['bin/squad-hub.js', 'web/index.html'], required);
  assert.deepStrictEqual(missing.sort(), ['web/app.css', 'web/app.js', 'web/logo.jpg']);
});

check('the release tells you which commit it is about to publish', () => {
  // A release run on the wrong branch is unrecoverable, because versions are
  // immutable. The one cheap defence is showing the human what is happening
  // while they can still stop it.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/release-npm.js'), 'utf8');
  assert.match(src, /rev-parse[^\n]*abbrev-ref/, 'the release never reports its branch');
  assert.match(src, /rev-parse[^\n]*--short/, 'the release never reports its commit');
});

check('the release docs point at a checkout that has the release script', () => {
  // docs/releasing.md previously said `git clone <repo>` with no branch, which
  // lands on the default branch -- where, until this work merges, there is no
  // release script and package.json still omits web/. Following the document
  // exactly was the failure path.
  const doc = fs.readFileSync(path.join(ROOT, 'docs/releasing.md'), 'utf8');
  const onDefaultBranch = spawnSync('git', ['branch', '-r', '--contains', 'HEAD'],
    { cwd: ROOT, encoding: 'utf8' });
  const merged = /origin\/main\b/.test(onDefaultBranch.stdout || '');
  if (merged) return; // a plain clone is correct once this is on main
  assert.match(doc, /clone -b/,
    'the release is not on the default branch yet, but the docs tell you to clone without one');
});

// ---------------------------------------------------------------------------
// What npm does to package.json on the way to the registry
// ---------------------------------------------------------------------------

/**
 * npm rewrites `bin` at publish time and announces it as
 *   "bin[squad-hub]" script name bin/squad-hub.js was invalid and removed
 * which reads like the CLI has been dropped from the package. It has not --
 * npm keeps the entry and rewrites the path -- but nobody running a release
 * at midnight should have to read npm's source to establish that.
 *
 * So: no rewrite, no warning. Asked of npm's own normalizer rather than a
 * regex, because the rules here are npm's and they change.
 */
function npmNormalizedBin(pkgObject) {
  const npmPath = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['npm'],
    { encoding: 'utf8' });
  if (npmPath.status !== 0) return null;
  const first = (npmPath.stdout || '').split(/\r?\n/).find(Boolean);
  if (!first) return null;
  const lib = path.join(path.dirname(first.trim()), 'node_modules', 'npm',
    'node_modules', '@npmcli', 'package-json', 'lib', 'normalize.js');
  if (!fs.existsSync(lib)) return null;

  // npm normalizes `bin` inside its ASYNC step, so the synchronous entry
  // point never reaches it -- calling that instead reports no changes for any
  // input at all, which looks exactly like success. Hence a child process:
  // this harness runs checks synchronously, and correctness here matters more
  // than elegance. Arguments go through argv, not a shell, so nothing needs
  // quoting.
  const child = `
    const { normalize } = require(process.argv[1]);
    const content = JSON.parse(process.argv[2]);
    const changes = [];
    normalize({ content, path: process.argv[3] }, { steps: ['bin'], changes, root: process.argv[3] })
      .then(() => process.stdout.write(JSON.stringify({ bin: content.bin, changes })))
      .catch((e) => process.stdout.write(JSON.stringify({ error: e.message })));
  `;
  const r = spawnSync(process.execPath, ['-e', child, lib, JSON.stringify(pkgObject), ROOT],
    { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0 || !r.stdout) return null;

  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { return null; }
  if (parsed.error) return null;
  return { content: { bin: parsed.bin }, changes: parsed.changes };
}

check('publishing does not rewrite bin, so it raises no alarming warning', () => {
  const probe = npmNormalizedBin(pkg);
  if (probe === null) {
    // Falling back rather than skipping: a check that quietly evaporates when
    // its tool moves is the failure this whole suite exists to prevent.
    const offenders = Object.entries(pkg.bin || {}).filter(([, v]) => /^\.\//.test(v));
    assert.deepStrictEqual(offenders, [], 'a bin path starts with "./", which npm will rewrite');
    return;
  }
  const noisy = probe.changes.filter((c) => /bin/i.test(c));
  assert.deepStrictEqual(noisy, [],
    `npm rewrites bin on publish, and says so alarmingly:\n  ${noisy.join('\n  ')}`);
});

check('the probe can actually detect a rewrite, rather than always finding none', () => {
  // The check above passes trivially if the probe reports nothing whatever it
  // is given. Feed it the exact package.json that produced the warning.
  const probe = npmNormalizedBin({ ...pkg, bin: { 'squad-hub': './bin/squad-hub.js' } });
  if (probe === null) return; // covered by the fallback path above
  const noisy = probe.changes.filter((c) => /bin/i.test(c));
  assert.ok(noisy.length >= 1, 'the probe does not notice npm rewriting "./bin/squad-hub.js"');
});

check('the CLI command still survives whatever npm does to bin', () => {
  // The half that actually matters. A canonical path is only worth having
  // because the command it installs is still there afterwards.
  const probe = npmNormalizedBin(pkg);
  if (probe === null) {
    assert.ok(pkg.bin && pkg.bin['squad-hub'], 'no squad-hub command declared');
    return;
  }
  assert.ok(probe.content.bin, 'npm removed the entire bin field');
  assert.strictEqual(probe.content.bin['squad-hub'], 'bin/squad-hub.js',
    `npx ${release.PRIMARY} would not install a command`);
});

check('the release refuses a bin path npm would rewrite', () => {
  assert.deepStrictEqual(release.binIsCanonical(pkg), [], 'this package would trip the guard');
  assert.deepStrictEqual(
    release.binIsCanonical({ bin: { 'squad-hub': './bin/squad-hub.js' } }),
    ['squad-hub: ./bin/squad-hub.js'],
    'the exact form that produced the warning is not caught');
});

// ---------------------------------------------------------------------------
// The tarball's OWN package.json -- the file a consumer's npm reads
// ---------------------------------------------------------------------------

/**
 * `npm pack` copies package.json verbatim, so what publish-time normalization
 * reports and what a consumer actually installs are two different things.
 * v0.1.0 shipped `"bin": {"squad-hub": "./bin/squad-hub.js"}`: publish kept
 * it, the installing npm dropped it, and `npx squad-hub` answered
 * `squad-hub is not recognized`. Nothing that read the source manifest could
 * have seen that -- only the artefact.
 */
const shipped = (() => {
  try { return release.packedManifest(); } catch { return null; }
})();

/** Is `tar` actually available? Only then is a null manifest excusable. */
const hasTar = spawnSync('tar', ['--version'], { encoding: 'utf8' }).status === 0;

check('the tarball can actually be opened, so these checks are not silently skipped', () => {
  // Every check below falls back to something weaker when the tarball cannot
  // be read. That fallback must be reachable ONLY when the tool is genuinely
  // missing -- otherwise the strongest checks in this suite quietly evaporate
  // and report success, which is the exact failure they exist to prevent.
  if (!hasTar) return;
  assert.ok(shipped !== null, 'tar is available but the tarball was not read; the tarball checks are inert');
  assert.strictEqual(shipped.name, pkg.name, 'the tarball manifest is not this package');
});

check('the tarball declares a command at all', () => {
  if (shipped === null) {
    assert.ok(pkg.bin && Object.keys(pkg.bin).length, 'no bin declared');
    return;
  }
  const bins = Object.keys(shipped.bin || {});
  assert.ok(bins.length >= 1, 'the tarball installs no command; the package would do nothing');
  assert.ok(bins.includes(release.PRIMARY), `the tarball does not install "${release.PRIMARY}"`);
});

check('the tarball\'s bin survives the INSTALLING npm, not just publish', () => {
  if (shipped === null) return; // covered by the source-manifest check above
  assert.deepStrictEqual(release.binIsCanonical(shipped), [],
    'the tarball ships a bin path the installing npm drops -- this is the v0.1.0 bug');
});

check('the tarball\'s bin target is a file that is actually in the tarball', () => {
  if (shipped === null) return;
  for (const [name, target] of Object.entries(shipped.bin || {})) {
    assert.ok(fs.existsSync(path.join(ROOT, target)), `bin "${name}" points at missing ${target}`);
    assert.ok(inPackage(target), `bin "${name}" points at ${target}, which is not shipped`);
  }
});

check('the tarball carries the version being released, not a stale one', () => {
  if (shipped === null) return;
  assert.strictEqual(shipped.version, pkg.version, 'the tarball version disagrees with package.json');
});

check('the release verifies the published package by running it', () => {
  // Intent-checking is what let 0.1.0 through: everything agreed the package
  // was correct, and the registry disagreed. The release must ask the
  // registry, since that is the only answer a user ever receives.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/release-npm.js'), 'utf8');
  assert.match(src, /function verifyPublished/, 'nothing verifies the published artefact');
  assert.match(src, /npx/, 'the verification never actually installs the published package');
  assert.match(src, /deprecate/i,
    'a broken publish leaves no guidance, though the version can never be replaced');
});

check('verification names the package and the command separately', () => {
  // `npx <pkg> --version` lets npm read `--version` as its OWN flag, so the
  // check can report npm's version instead of the package's -- failing a
  // healthy release, or passing a broken one.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/release-npm.js'), 'utf8');
  assert.match(src, /'--package'/, 'the package spec is not passed explicitly');
  assert.match(src, /'--',\s*bin/, 'command arguments are not separated from npm\'s own');
});

check('verification can be re-run on its own, without publishing again', () => {
  // A release that published correctly but could not yet see itself must be
  // re-checkable. Re-running the whole release would refuse anyway, since a
  // version cannot be published twice.
  const verify = (pkg.scripts || {}).verify;
  assert.ok(verify, 'there is no way to re-check a release except by releasing again');
  assert.match(verify, /--verify-only/, 'the verify script does not run in verify-only mode');
  const src = fs.readFileSync(path.join(ROOT, 'scripts/release-npm.js'), 'utf8');
  assert.match(src, /--verify-only/, 'the script does not implement the mode its own script asks for');
});

check('verification tells "not published yet" apart from "installs no command"', () => {
  // They demand opposite responses: one is worth waiting for, the other never
  // improves and means the version is spent. Reporting both as one failure is
  // how a propagation delay gets mistaken for a broken release, and a broken
  // release for a slow one.
  //
  // Exercised against real npm output. Reading the source for the right words
  // would pass even if the logic behind them were removed.
  const c = release.classifyAttempt;

  assert.strictEqual(
    c(1, 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/squad-hub', '0.1.1'),
    'not-published-yet', 'a version that has not propagated yet is not recognised as such');

  assert.strictEqual(
    c(1, 'npm error could not determine executable to run', '0.1.1'),
    'installs-no-command', 'the failure v0.1.0 actually produced is not recognised');

  assert.strictEqual(
    c(1, "'squad-hub' is not recognized as an internal or external command", '0.1.1'),
    'installs-no-command', 'the Windows wording of a missing command is not recognised');

  assert.strictEqual(c(0, '0.1.1', '0.1.1'), 'ok', 'a healthy answer is not accepted');

  // npm printing its OWN version must never pass as the package's -- that is
  // the ambiguity the separated npx invocation exists to avoid.
  assert.notStrictEqual(c(0, '10.8.2', '0.1.1'), 'ok',
    "npm's own version is accepted as the package's");
});

check('the verification failure is reported in full, not summarised away', () => {
  const lines = ['npm error code E404', 'npm error 404 Not Found'];
  const logged = [];
  const spy = console.error;
  console.error = (m) => logged.push(String(m));
  try {
    release.reportVerification('squad-hub', '9.9.9',
      { ok: false, reason: 'unresolved', output: lines.join('\n') });
  } finally { console.error = spy; }
  const all = logged.join('\n');
  for (const l of lines) {
    assert.ok(all.includes(l), `the report drops npm's own output: ${l}`);
  }
});

// ---------------------------------------------------------------------------
// Two-factor authentication -- the thing that actually stopped the release
// ---------------------------------------------------------------------------

check('a demand for a one-time password is recognised, not reported as a failure', () => {
  const real = 'npm error code EOTP\nnpm error This operation requires a one-time password.';
  assert.ok(release.needsOneTimePassword(real), 'the real npm 2FA failure is not recognised');
  assert.ok(release.needsOneTimePassword('npm error This operation requires a one-time password.'),
    'the prose form is not recognised, only the code');
});

check('an ordinary failure is not mistaken for a one-time password prompt', () => {
  // Retrying interactively on a genuine failure would hang a release forever
  // waiting for a prompt that is never coming.
  const others = [
    'npm error code ENEEDAUTH\nnpm error need auth',
    'npm error code E403\nnpm error 403 Forbidden',
    'npm error code ENOTFOUND\nnpm error network request failed',
    '',
  ];
  const confused = others.filter((o) => release.needsOneTimePassword(o));
  assert.deepStrictEqual(confused, [], `these would be retried as a 2FA prompt: ${confused.join(' | ')}`);
});

check('a one-time password prompt is answered by handing npm the terminal', () => {
  // The prompt only arrived as an error because this script pipes npm's
  // output. Passing --otp is documented, but the release must not REQUIRE
  // reading a document to get past a prompt npm can ask for itself.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/release-npm.js'), 'utf8');
  assert.match(src, /stdio:\s*'inherit'/, 'npm is never given the terminal, so it can never ask');
  assert.match(src, /isTTY/, 'an interactive retry is attempted even with no terminal to prompt on');
});

check('the docs explain the one-time password, since 2FA is the normal case', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/releasing.md'), 'utf8');
  assert.match(doc, /one-time password|OTP|two-factor/i,
    'docs/releasing.md never mentions 2FA, which is what stopped the first real release');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
