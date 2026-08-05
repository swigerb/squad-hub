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

function step(n, msg) { console.log(`\n[${n}] ${msg}`); }
function die(msg) { console.error(`\nFAILED: ${msg}\n`); process.exit(1); }

function publish(name, extraArgs, dryRun) {
  const args = ['publish', '--access', 'public', '--registry', REGISTRY, ...extraArgs];
  if (dryRun) args.push('--dry-run');
  console.log(`    npm ${args.join(' ')}   (as ${name})`);
  const r = run('npm', args, { stdio: ['inherit', 'pipe', 'pipe'] });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  process.stdout.write(out);
  if (r.status === 0) return 'published';
  if (isAlreadyPublished(out)) {
    console.log(`    already on the registry at this version -- skipping`);
    return 'skipped';
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
  console.log('    clean');

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

  step(4, `publishing ${PRIMARY}`);
  const primary = publish(PRIMARY, extraArgs, dryRun);

  step(5, `publishing ${ALIAS}`);
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
  if (!dryRun) {
    console.log(`\nVerify with:\n  npx ${PRIMARY}@${pkg.version} --version\n  npm view ${ALIAS} version`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    die(e.message);
  }
}

module.exports = { isAlreadyPublished, sameRegistry, withName, PRIMARY, ALIAS, REGISTRY };
