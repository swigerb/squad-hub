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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
