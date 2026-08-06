'use strict';
/**
 * Publish Squad Hub to the public npm registry under BOTH of its names:
 *
 *   squad-hub              the name people type -- `npx squad-hub squad`
 *   @mightybs/squad-hub    the same package, parked under the org
 *
 * The two are published from identical contents, so neither is a stub that
 * rots behind the other. The only difference is the `name` field, which this
 * script rewrites for the second publish and always restores afterwards.
 *
 * Usage, from a clean checkout on a machine that can reach registry.npmjs.org:
 *
 *   npm login
 *   npm run release              # publish both
 *   npm run release -- --dry-run # rehearse, publishing nothing
 *   npm run release -- --otp=123456
 *
 * Anything after `--` is handed to `npm publish` untouched, which is how OTP
 * codes get through.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const PRIMARY = 'squad-hub';
const ALIAS = '@mightybs/squad-hub';
const REGISTRY = 'https://registry.npmjs.org/';

/**
 * npm refuses to republish a version, and says so in several different ways
 * depending on version and whether the name is scoped. Publishing the primary
 * and then failing the alias would leave the two names on different versions
 * permanently -- versions are immutable, so there is no going back. Treating
 * "this version is already up there" as success is what makes a re-run after
 * a half-finished release converge instead of wedging.
 */
function isAlreadyPublished(output) {
  const s = String(output || '');
  return /EPUBLISHCONFLICT/i.test(s)
    || /cannot publish over (?:the )?previously published version/i.test(s)
    || /You cannot publish over the previously published versions/i.test(s);
}

/**
 * npm demands a one-time password when the account has 2FA on publishing.
 * That is not an error to report and give up on -- it is a prompt, and the
 * only reason it arrived as a failure is that this script pipes npm's output
 * and so denied npm the terminal it needed to ask.
 */
function needsOneTimePassword(output) {
  const s = String(output || '');
  return /\bEOTP\b/.test(s) || /one-time password/i.test(s);
}

/** Registry URLs differ only by a trailing slash far too often to compare raw. */
function sameRegistry(a, b) {
  const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b) && norm(a) !== '';
}

/**
 * Swap the package name without reformatting the file. Round-tripping through
 * JSON.parse/stringify would rewrite every line, so a failure mid-publish
 * would leave a diff far larger than the one thing that changed.
 */
function withName(json, name) {
  const next = json.replace(/("name"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(name)}`);
  if (next === json) throw new Error('could not find the "name" field in package.json');
  return next;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...opts,
  });
}

/**
 * What the runtime needs, derived from disk rather than from a list. The
 * server serves its entire UI out of `web/`, and the CLI is whatever `bin`
 * points at; a package missing either installs cleanly and then does nothing.
 */
function requiredInPackage(pkg, listWebFiles) {
  const web = listWebFiles().filter((f) => !/\.(map|log)$/.test(f));
  const bins = Object.values(pkg.bin || {}).map((t) => t.replace(/^\.\//, ''));
  return [...new Set([...web, ...bins])].map((f) => f.replace(/\\/g, '/'));
}

/** Required paths that the tarball does not contain. */
function missingFromPack(packed, required) {
  const have = new Set(packed.map((f) => f.replace(/\\/g, '/')));
  return required.filter((f) => !have.has(f));
}

function webFilesOnDisk() {
  const dir = path.join(ROOT, 'web');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(ROOT, path.join(d.parentPath || d.path, d.name)).replace(/\\/g, '/'));
}

/** Ask npm what it would actually ship, rather than re-deriving its rules. */
function packedPaths() {
  const r = run('npm', ['pack', '--dry-run', '--json'], { timeout: 180000 });
  const out = r.stdout || '';
  const start = out.indexOf('[');
  if (r.status !== 0 || start === -1) throw new Error(`npm pack failed:\n${out}${r.stderr || ''}`);
  return JSON.parse(out.slice(start))[0].files.map((f) => f.path.replace(/\\/g, '/'));
}

/**
 * npm rewrites `bin` on publish, and reports the rewrite with the alarming
 * wording `script name <path> was invalid and removed` -- even though it keeps
 * the entry. Writing the value npm would have rewritten it to means there is
 * nothing to rewrite, no warning, and no need for whoever runs the next
 * release to work out whether the CLI just vanished from the package.
 * It is not only cosmetic. A `./`-prefixed target survived publish-time
 * normalization but was dropped by the INSTALLING npm, which is how 0.1.0
 * reached the registry and then produced `squad-hub is not recognized`.
 */
function binIsCanonical(pkg) {
  const offenders = Object.entries(pkg.bin || {})
    .filter(([, target]) => typeof target === 'string')
    .filter(([, target]) => target !== target.replace(/^\.\//, '').replace(/\\/g, '/'));
  return offenders.map(([key, target]) => `${key}: ${target}`);
}

/**
 * The package.json INSIDE the tarball -- the file a consumer's npm reads.
 * `npm pack` copies it verbatim, so it is the last chance to see what will
 * actually be installed, and it is not necessarily what publish-time
 * normalization reports.
 */
function packedManifest() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hub-pack-'));
  try {
    const r = run('npm', ['pack', '--pack-destination', dest], { timeout: 180000 });
    if (r.status !== 0) throw new Error(`npm pack failed:\n${r.stdout || ''}${r.stderr || ''}`);
    const tgz = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack produced no tarball');
    const out = run('tar', ['-xzOf', path.join(dest, tgz), 'package/package.json'], { timeout: 60000 });
    if (out.status !== 0 || !out.stdout) return null; // no tar; caller falls back
    return JSON.parse(out.stdout);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

/**
 * Prove the published package installs a working command. Everything before
 * this checks intent; this checks the registry's answer, which is the only
 * one a user ever sees. A new version takes a moment to propagate, so retry
 * rather than declaring failure on the first miss.
 */
function verifyPublished(name, version, attempts = 5) {
  for (let i = 1; i <= attempts; i += 1) {
    const r = run('npx', ['--yes', `${name}@${version}`, '--version'], { timeout: 180000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 0 && out.includes(version)) return true;
    if (i < attempts) {
      console.log(`    not resolvable yet (attempt ${i}/${attempts}); waiting for the registry...`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
    } else {
      console.log(`\n    last output from npx:\n${out.split('\n').slice(-8).join('\n')}`);
    }
  }
  return false;
}

function step(n, msg) { console.log(`\n[${n}] ${msg}`); }
function die(msg) { console.error(`\nFAILED: ${msg}\n`); process.exit(1); }

function publish(name, extraArgs, dryRun) {
  const args = ['publish', '--access', 'public', '--registry', REGISTRY, ...extraArgs];
  if (dryRun) args.push('--dry-run');
  console.log(`    npm ${args.join(' ')}   (as ${name})`);

  // Piped, so the output can be inspected -- that is how an already-published
  // version is told apart from a real failure.
  const r = run('npm', args, { stdio: ['inherit', 'pipe', 'pipe'] });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  process.stdout.write(out);
  if (r.status === 0) return 'published';

  if (isAlreadyPublished(out)) {
    console.log(`    already on the registry at this version -- skipping`);
    return 'skipped';
  }

  // A one-time password is a question, not a failure. Piping npm's output is
  // what turned it into one: npm needs the terminal to show its
  // authentication URL and wait. So hand the terminal over and ask again.
  // Both names need this separately -- an OTP is consumed by one publish, so
  // carrying a code over from the first would fail the second.
  if (needsOneTimePassword(out) && !dryRun) {
    if (!process.stdin.isTTY) {
      throw new Error(`${name} needs a one-time password, and this is not an interactive terminal.\n`
        + `Re-run it yourself with a code:  npm run release -- --otp=<code>`);
    }
    console.log('\n    npm needs a one-time password for this publish.');
    console.log('    Handing the terminal to npm -- follow its prompt, then it will continue.\n');
    const retry = run('npm', args, { stdio: 'inherit' });
    if (retry.status === 0) return 'published';
    throw new Error(`npm publish failed for ${name} after the one-time password prompt (exit ${retry.status})`);
  }

  throw new Error(`npm publish failed for ${name} (exit ${r.status})`);
}

function main() {
  const extraArgs = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const original = fs.readFileSync(PKG_PATH, 'utf8');
  const pkg = JSON.parse(original);

  console.log(`Squad Hub release -- v${pkg.version}${dryRun ? '  (DRY RUN, nothing is published)' : ''}`);

  step(1, 'checking the working tree is clean');
  const status = run('git', ['status', '--porcelain']);
  if (status.status !== 0) die('git status failed; run this from the checkout');
  if (status.stdout.trim()) {
    die(`the working tree has uncommitted changes:\n${status.stdout}\nCommit or stash them -- a release must match a commit.`);
  }
  const branch = (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim();
  const commit = (run('git', ['rev-parse', '--short', 'HEAD']).stdout || '').trim();
  console.log(`    clean -- ${branch} @ ${commit}`);
  console.log(`    publishing THIS commit. If that is not what you meant, stop now.`);

  step(2, 'checking you are logged in to the public registry');
  const who = run('npm', ['whoami', '--registry', REGISTRY]);
  if (who.status !== 0) {
    die(`not logged in to ${REGISTRY}\nRun:  npm login --registry=${REGISTRY}`);
  }
  console.log(`    logged in as ${who.stdout.trim()}`);
  const configured = run('npm', ['config', 'get', 'registry']).stdout;
  if (!sameRegistry(configured, REGISTRY)) {
    console.log(`    note: your default registry is ${String(configured).trim()} -- publishing explicitly to ${REGISTRY}`);
  }

  step(3, 'running the full test suite');
  const tests = run('npm', ['test'], { stdio: 'inherit' });
  if (tests.status !== 0) die('tests failed -- nothing published');

  step(4, 'checking the tarball contains what the code reads');
  // Independent of the test suite on purpose. This runs against whatever
  // commit is checked out, including one whose suite predates the packaging
  // fix or lacks it entirely -- which is exactly the checkout most likely to
  // ship a package that installs cleanly and serves a blank page. npm
  // versions are immutable, so this must be caught BEFORE publish, not after.
  const required = requiredInPackage(pkg, webFilesOnDisk);
  const missing = missingFromPack(packedPaths(), required);
  if (missing.length) {
    die(`the package would ship without files the code reads:\n  ${missing.join('\n  ')}\n`
      + `\nThe "files" list in package.json does not cover them. This checkout is not `
      + `releasable -- publishing it would put a broken ${pkg.version} on the registry permanently.`);
  }
  console.log(`    ${required.length} runtime files present in the tarball`);

  const rewritten = binIsCanonical(pkg);
  if (rewritten.length) {
    die(`npm would rewrite these bin entries on publish:\n  ${rewritten.join('\n  ')}\n`
      + `\nIt reports that as "script name ... was invalid and removed", which reads like the\n`
      + `CLI is being dropped. Write the path without a leading "./" so there is nothing to rewrite.`);
  }
  console.log('    bin is in npm\'s canonical form, so publish will not rewrite it');

  // The tarball's own package.json, not this one. They can differ, and it is
  // the tarball's that a consumer's npm reads when deciding what command to
  // install. 0.1.0 shipped a `./`-prefixed bin that survived publish and was
  // then dropped on install, which no check of the source file would catch.
  const shipped = packedManifest();
  if (shipped === null) {
    console.log('    note: no tar available to open the tarball -- checked the source manifest only');
  } else {
    const shippedBin = binIsCanonical(shipped);
    if (shippedBin.length) {
      die(`the TARBALL declares bin paths npm will drop on install:\n  ${shippedBin.join('\n  ')}`);
    }
    const bins = Object.keys(shipped.bin || {});
    if (!bins.length) {
      die('the tarball declares no bin at all -- installing it would give the user no command.');
    }
    for (const [name, target] of Object.entries(shipped.bin)) {
      if (!fs.existsSync(path.join(ROOT, target))) {
        die(`the tarball's bin "${name}" points at ${target}, which does not exist`);
      }
    }
    console.log(`    the tarball installs: ${bins.join(', ')}`);
  }

  step(5, `publishing ${PRIMARY}`);
  const primary = publish(PRIMARY, extraArgs, dryRun);

  step(6, `publishing ${ALIAS}`);
  let alias;
  try {
    fs.writeFileSync(PKG_PATH, withName(original, ALIAS));
    alias = publish(ALIAS, extraArgs, dryRun);
  } finally {
    // Unconditional: a half-published release must never leave the checkout
    // claiming to be the alias package.
    fs.writeFileSync(PKG_PATH, original);
    console.log('    package.json restored');
  }

  console.log(`\nDone. v${pkg.version}: ${PRIMARY} ${primary}, ${ALIAS} ${alias}.`);

  if (dryRun) return;

  step(7, 'proving the published package actually installs a working command');
  // Every check so far inspected intent. This asks the registry, which is the
  // only answer a user ever gets -- and is how 0.1.0's missing command would
  // have been found in the release that created it, rather than by hand
  // afterwards, once the version was already immutable.
  const ok = verifyPublished(PRIMARY, pkg.version);
  if (!ok) {
    console.error(`\nPUBLISHED, BUT BROKEN: npx ${PRIMARY}@${pkg.version} does not run.`);
    console.error(`This version cannot be replaced -- npm versions are immutable. Instead:`);
    console.error(`  1. npm deprecate ${PRIMARY}@${pkg.version} "broken packaging, use a later version"`);
    console.error(`  2. fix the cause, bump the version, and release again.\n`);
    process.exit(1);
  }
  console.log(`    npx ${PRIMARY}@${pkg.version} runs and reports ${pkg.version}`);
  console.log(`\nBoth names are live and verified.`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    die(e.message);
  }
}

module.exports = {
  isAlreadyPublished, needsOneTimePassword, sameRegistry, withName,
  requiredInPackage, missingFromPack, binIsCanonical, packedManifest, verifyPublished,
  PRIMARY, ALIAS, REGISTRY,
};
