'use strict';
/**
 * Publish Squad Hub to the public npm registry under BOTH of its names:
 *
 *   squad-hub              the name people type -- `npx squad-hub squad`
 *   @mightybs/squad-hub    the same package, parked under the org
 *
 * Both names are published from tarballs that this script packs, checks,
 * installs and runs first. The alias tarball is built in a temporary staging
 * directory from the files in the primary tarball; only its package.json name
 * differs. The checkout itself is never modified.
 *
 * Usage, from a clean checkout on a machine that can reach registry.npmjs.org:
 *
 *   npm login
 *   npm run publish                # publish both; skips the full test suite
 *   npm run publish -- --dry-run   # rehearse, publishing nothing
 *   npm run release                # the same, after running `npm test`
 *   npm run release -- --otp=123456
 *
 * Anything after `--` that this script does not recognise is handed to
 * `npm publish` untouched, which is how OTP codes get through.
 *
 * A bare `npm publish` is refused through the `prepublishOnly` script: it
 * would upload the directory under one name only and skip every check here.
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

/** Flags this script consumes; everything else is passed to `npm publish`. */
const OWN_FLAGS = new Set(['--dry-run', '--verify-only', '--skip-tests', '--refuse-direct-publish']);

function parseArgs(argv) {
  const args = Array.from(argv || []);
  return {
    dryRun: args.includes('--dry-run'),
    verifyOnly: args.includes('--verify-only'),
    skipTests: args.includes('--skip-tests'),
    refuseDirectPublish: args.includes('--refuse-direct-publish'),
    extraArgs: args.filter((a) => !OWN_FLAGS.has(a)),
  };
}

/**
 * True when npm is running this script as part of `npm publish` (through the
 * `prepublishOnly` or `publish` lifecycle scripts). `npm run publish` sets
 * npm_command to `run` (or `run-script` on older npm), so it is not affected.
 */
function invokedByPublishLifecycle(env) {
  return String((env || {}).npm_command || '') === 'publish';
}

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
 * Swap the package name without reformatting the file, so the alias manifest
 * differs from the primary one by the name and nothing else.
 */
function withName(json, name) {
  const next = json.replace(/("name"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(name)}`);
  if (next === json) throw new Error('could not find the "name" field in package.json');
  return next;
}

const NPM_CLI_FILES = { npm: 'npm-cli.js', npx: 'npx-cli.js' };

/**
 * The JavaScript entry point of npm or npx, so they can be run with node
 * directly instead of through a shell. Prefers the npm that is running this
 * script (`npm_execpath`), then the npm bundled next to node.
 */
function npmCli(tool, env = process.env, execPath = process.execPath, exists = fs.existsSync) {
  const file = NPM_CLI_FILES[tool];
  if (!file) return null;
  const candidates = [];
  const via = (env || {}).npm_execpath;
  if (via && /^np[mx]-cli\.js$/.test(path.basename(via))) {
    candidates.push(path.join(path.dirname(via), file));
  }
  const nodeDir = path.dirname(execPath);
  candidates.push(path.join(nodeDir, 'node_modules', 'npm', 'bin', file));
  candidates.push(path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', file));
  return candidates.find((c) => exists(c)) || null;
}

function quoteArg(a) {
  const s = String(a);
  return /[\s"&|<>^()%!]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/**
 * How to spawn `cmd args`. npm and npx run under node without a shell, so
 * arguments are passed exactly and paths with spaces work. A shell is used
 * only where Windows requires one: a `.cmd` or `.bat` file, or an npm that
 * cannot be located. Those get a single quoted command string.
 */
function commandFor(cmd, args, {
  env = process.env, platform = process.platform, execPath = process.execPath, exists = fs.existsSync,
} = {}) {
  if (cmd === 'npm' || cmd === 'npx') {
    const cli = npmCli(cmd, env, execPath, exists);
    if (cli) return { file: execPath, args: [cli, ...args], shell: false };
    if (platform === 'win32') return { file: [cmd, ...args].map(quoteArg).join(' '), args: [], shell: true };
    return { file: cmd, args: [...args], shell: false };
  }
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
    return { file: [cmd, ...args].map(quoteArg).join(' '), args: [], shell: true };
  }
  return { file: cmd, args: [...args], shell: false };
}

function run(cmd, args, opts = {}) {
  const c = commandFor(cmd, args);
  const options = {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, ...opts, shell: c.shell,
  };
  return c.shell ? spawnSync(c.file, options) : spawnSync(c.file, c.args, options);
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

/**
 * Entries (path and size) that are not the same in both tarballs, ignoring
 * package.json, whose name is expected to differ. Empty when the two
 * tarballs ship the same files.
 */
function fileSetDifference(first, second) {
  const norm = (f) => String(f.path).replace(/\\/g, '/');
  const key = (f) => `${norm(f)} (${f.size} bytes)`;
  const keys = (list) => new Set(list.filter((f) => norm(f) !== 'package.json').map(key));
  const a = keys(first);
  const b = keys(second);
  return [
    ...[...a].filter((k) => !b.has(k)).map((k) => `only in the first: ${k}`),
    ...[...b].filter((k) => !a.has(k)).map((k) => `only in the second: ${k}`),
  ];
}

/**
 * Keep `bin` in the form npm itself writes: no leading `./`.
 *
 * This is hygiene, not a bug fix. A `./` prefix has drawn a publish-time
 * rewrite reported with the alarming wording `script name <path> was invalid
 * and removed`, which reads as though the CLI had vanished from the package.
 * Writing the canonical value means there is nothing to rewrite and nothing
 * for the next person to interpret.
 *
 * It is deliberately NOT claimed that a `./` prefix breaks installation. That
 * was this project's working theory for a time and it did not survive testing:
 * on npm 11 the prefix survives pack and install intact and still yields a
 * working command, and the published 0.1.0 tarball never carried one.
 */
function binIsCanonical(pkg) {
  const offenders = Object.entries(pkg.bin || {})
    .filter(([, target]) => typeof target === 'string')
    .filter(([, target]) => target !== target.replace(/^\.\//, '').replace(/\\/g, '/'));
  return offenders.map(([key, target]) => `${key}: ${target}`);
}

/**
 * Pack `source` into `dest` (created if needed) and return the tarball path
 * with the file list npm reported for it. The caller owns `dest`.
 */
function packInto(dest, source = ROOT, extra = []) {
  fs.mkdirSync(dest, { recursive: true });
  const r = run('npm', ['pack', '--json', '--pack-destination', dest, ...extra],
    { cwd: source, timeout: 180000 });
  const out = r.stdout || '';
  const start = out.indexOf('[');
  if (r.status !== 0 || start === -1) {
    throw new Error(`npm pack failed:\n${out}${r.stderr || (r.error && r.error.message) || ''}`);
  }
  const [info] = JSON.parse(out.slice(start));
  const named = info && info.filename ? path.join(dest, path.basename(info.filename)) : null;
  const tgz = named && fs.existsSync(named)
    ? named
    : (fs.readdirSync(dest).filter((f) => f.endsWith('.tgz')).map((f) => path.join(dest, f))[0]);
  if (!tgz) throw new Error('npm pack produced no tarball');
  const entries = ((info && info.files) || []).map((f) => ({ path: f.path.replace(/\\/g, '/'), size: f.size }));
  return { tgz, files: entries.map((f) => f.path), entries };
}

/**
 * Every bin target must start with a shebang.
 *
 * Found while testing the smoke test, on a deliberately broken package whose
 * bin lacked one: npm's Windows shim then invokes the `.js` DIRECTLY and lets
 * the file association decide what happens. On a machine where `.js` is bound
 * to something inert that means the command silently does nothing, exits 0, and
 * prints neither stdout nor stderr -- indistinguishable from success to
 * anything watching the exit code. On Unix the same file is simply not
 * executable as a program.
 *
 * With `#!/usr/bin/env node` present npm writes a shim that runs node itself,
 * which is why the real package works. Nothing checked that it was there.
 */
function binMissingShebang(pkg, readFile) {
  return Object.entries(pkg.bin || {})
    .filter(([, target]) => typeof target === 'string')
    .filter(([, target]) => {
      let head = '';
      try { head = readFile(target.replace(/^\.\//, '')); } catch { return true; }
      return !/^#!/.test(head);
    })
    .map(([key, target]) => `${key}: ${target}`);
}

/**
 * Install the tarball and RUN it, before anything is published.
 *
 * Every other pre-publish check reads a manifest or a file list. None of them
 * runs the thing. That gap is not theoretical: a package whose `files` omits
 * `src` still has a real `bin` target, still ships every `web/` file, and still
 * declares a canonical `bin` -- so it passes all of them, installs cleanly, and
 * dies on `Cannot find module '../src/cli.js'` the first time anyone types the
 * command. Verified by building exactly that package.
 *
 * Offline on purpose. `--offline` makes npm fail rather than reach the network,
 * which keeps this honest (it can only be reading the tarball) and lets it run
 * on a machine that cannot see the registry at all. It relies on this package
 * having no dependencies -- if that ever changes, the install fails and says so
 * rather than blaming the tarball.
 */
function smokeTestTarball(tgz, binName, version) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hub-smoke-'));
  try {
    const install = run('npm', [
      'install', '--offline', '--no-audit', '--no-fund', '--prefix', prefix, tgz,
    ], { timeout: 180000, cwd: prefix });

    if (install.status !== 0) {
      const out = `${install.stdout || ''}${install.stderr || ''}`;
      if (/ENOTCACHED|request to .* failed|offline mode/i.test(out)) {
        return {
          ok: false,
          reason: 'this package now has dependencies, so it cannot be installed offline;'
            + ' the smoke test needs adjusting rather than the tarball',
          output: out,
        };
      }
      return { ok: false, reason: 'the tarball would not install', output: out };
    }

    // Run npm's OWN shim, not the file directly: that is what a user gets, and
    // it proves the bin linking as well as the code.
    const shim = path.join(prefix, 'node_modules', '.bin',
      process.platform === 'win32' ? `${binName}.cmd` : binName);
    if (!fs.existsSync(shim)) {
      return { ok: false, reason: `installing it produced no ${binName} command`, output: shim };
    }

    const ran = run(shim, ['--version'], { timeout: 60000, cwd: prefix });
    const out = `${ran.stdout || ''}${ran.stderr || ''}`.trim();
    if (ran.status !== 0) return { ok: false, reason: 'the installed command failed to run', output: out };
    if (!out) {
      // Exit 0 and total silence is what a Windows shim does when the bin has
      // no shebang: it hands the .js to the file association, which may do
      // nothing at all. Success and this are indistinguishable by exit code.
      return {
        ok: false,
        reason: 'the installed command produced no output at all'
          + ' (on Windows that is what a bin with no shebang does)',
        output: '(nothing on stdout or stderr)',
      };
    }
    if (!out.split(/\s+/).includes(version)) {
      return { ok: false, reason: `the installed command reported "${out}" rather than ${version}`, output: out };
    }
    return { ok: true, output: out };
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
}

/**
 * The package.json INSIDE a tarball -- the file a consumer's npm reads. It is
 * not necessarily what publish-time normalization reports. Returns null only
 * when `tar` is not installed.
 */
function tarballManifest(tgz) {
  // Run from the tarball's directory with a bare file name: GNU tar reads a
  // drive-letter path such as C:\... as a remote host.
  const out = run('tar', ['-xzOf', path.basename(tgz), 'package/package.json'], {
    timeout: 60000, cwd: path.dirname(tgz),
  });
  if (out.error && out.error.code === 'ENOENT') return null;
  if (out.status !== 0 || !out.stdout) {
    throw new Error(`could not read the packed manifest:\n${out.stderr || (out.error && out.error.message) || `tar exited ${out.status}`}`);
  }
  return JSON.parse(out.stdout);
}

/** Pack this checkout into a temporary directory and read the tarball's manifest. */
function packedManifest() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hub-pack-'));
  try {
    return tarballManifest(packInto(dest).tgz);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

/**
 * Decide what a single verification attempt actually means.
 *
 * Kept separate, and pure, so it can be tested against real npm output
 * instead of by reading this file for the right words -- a check that stays
 * green even when the logic behind it is gutted.
 *
 * The failures are not interchangeable. A version that has not propagated yet
 * is worth waiting for; a package that resolves but installs no command never
 * improves and means the version is spent. Collapsing the two is how a delay
 * gets mistaken for a broken release, and a broken release for a delay.
 */
function classifyAttempt(status, output, version) {
  const text = String(output || '');
  if (status === 0 && text.split(/\s+/).includes(version)) return 'ok';
  if (/could not determine executable|is not recognized|command not found/i.test(text)) {
    return 'installs-no-command';
  }
  if (/E404|404 Not Found|no matching version|is not in this registry/i.test(text)) {
    return 'not-published-yet';
  }
  return 'no-answer';
}

/**
 * Prove the published package actually installs a working command. Everything
 * before this checks intent; this checks the registry's answer, which is the
 * only one a user ever sees.
 *
 * The package spec and the command are named separately, and the arguments
 * for the command sit after `--`. `npx <pkg> --version` leaves npm free to
 * read `--version` as its own flag, which makes a healthy package look broken
 * and, worse, could make a broken one look healthy.
 *
 * IT RUNS FROM A TEMPORARY DIRECTORY, NEVER FROM THE CHECKOUT. This directory
 * holds a package.json named `squad-hub`, and npx asked for a command matching
 * the name of the project it is standing in resolves that project first. There
 * is no `node_modules/.bin/squad-hub` in a checkout, so it reports
 * "'squad-hub' is not recognized" -- a healthy package, condemned by where the
 * test was run. That is not hypothetical: it failed exactly this way on the
 * 0.2.0 release, while the SCOPED name, whose name cannot collide, passed from
 * the identical tarball. Two names, one tarball, opposite verdicts is what
 * gave it away.
 *
 * A newly published version is not resolvable immediately, so a miss is
 * retried with a growing wait rather than treated as a verdict.
 */
function verifyPublished(name, version, bin = PRIMARY, waits = [5, 10, 20, 30, 60]) {
  let last = '';
  // Outside the repo, and outside any parent of it, so nothing on the path up
  // to the root can shadow what the registry serves.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hub-verify-'));
  try {
    for (let i = 0; i <= waits.length; i += 1) {
      const r = run('npx', ['--yes', '--package', `${name}@${version}`, '--', bin, '--version'],
        { timeout: 300000, cwd: sandbox });
      last = `${r.stdout || ''}${r.stderr || ''}`.trim();

      const verdict = classifyAttempt(r.status, last, version);
      if (verdict === 'ok') return { ok: true, output: last };

      // Only "not there yet" is worth waiting on. A package that resolves and
      // installs no command is a verdict, not a delay.
      if (verdict === 'installs-no-command') {
        return { ok: false, reason: 'installs-no-command', output: last };
      }

      if (i < waits.length) {
        const s = waits[i];
        console.log(`    ${verdict === 'not-published-yet' ? 'not on the registry yet' : 'no answer yet'}`
          + `; retrying in ${s}s (${i + 1}/${waits.length})`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
      }
    }
    return { ok: false, reason: 'unresolved', output: last };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

/** Report a verification result in full, since a bad one cannot be undone. */
function reportVerification(name, version, result) {
  if (result.ok) {
    console.log(`    ${name}@${version} installs and runs -- reports ${version}`);
    return true;
  }
  console.error(`\n    ${name}@${version} did NOT verify (${result.reason}).`);
  console.error(`    npx said:\n${result.output.split('\n').map((l) => `      ${l}`).join('\n')}`);
  if (result.reason === 'installs-no-command') {
    console.error(`\n    The package resolved but installs no command.`);
  } else {
    console.error(`\n    The package did not resolve. That is often just propagation:`);
    console.error(`    wait a minute and run  npm run verify`);
  }
  return false;
}

/** The commit a tag points at, peeled through an annotated tag; null if absent. */
function tagCommit(tag) {
  const r = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]);
  return r.status === 0 ? (r.stdout || '').trim() || null : null;
}

function step(n, msg) { console.log(`\n[${n}] ${msg}`); }
function die(msg) { console.error(`\nFAILED: ${msg}\n`); process.exit(1); }

/** Publish one tarball. `command` names how the user started this, for hints. */
function publish(name, tgz, extraArgs, dryRun, command = 'npm run release') {
  const args = ['publish', tgz, '--access', 'public', '--registry', REGISTRY, '--ignore-scripts', ...extraArgs];
  if (dryRun) args.push('--dry-run');
  console.log(`    npm ${args.join(' ')}   (as ${name})`);

  // Piped, so the output can be inspected -- that is how an already-published
  // version is told apart from a real failure.
  const r = run('npm', args, { stdio: ['inherit', 'pipe', 'pipe'] });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  process.stdout.write(out);
  if (r.status === 0) return dryRun ? 'rehearsed' : 'published';

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
        + `Re-run it yourself with a code:  ${command} -- --otp=<code>`);
    }
    console.log('\n    npm needs a one-time password for this publish.');
    console.log('    Handing the terminal to npm -- follow its prompt, then it will continue.\n');
    const retry = run('npm', args, { stdio: 'inherit' });
    if (retry.status === 0) return 'published';
    throw new Error(`npm publish failed for ${name} after the one-time password prompt (exit ${retry.status})`);
  }

  throw new Error(`npm publish failed for ${name} (exit ${r.status || (r.error && r.error.message)})`);
}

function verifyOnly(pkg) {
  console.log(`Verifying v${pkg.version} on ${REGISTRY}\n`);
  const results = [
    [PRIMARY, verifyPublished(PRIMARY, pkg.version)],
    [ALIAS, verifyPublished(ALIAS, pkg.version)],
  ];
  let allOk = true;
  for (const [name, result] of results) {
    console.log(`\n[${name}]`);
    if (!reportVerification(name, pkg.version, result)) allOk = false;
  }
  if (!allOk) {
    process.exitCode = 1;
    return;
  }
  console.log(`\nBoth names are live and verified at ${pkg.version}.`);
}

/** Check one tarball's own manifest. Returns false when tar is unavailable. */
function checkTarballManifest(tgz, name, version, packedFiles) {
  const shipped = tarballManifest(tgz);
  if (shipped === null) return false;
  if (shipped.name !== name) throw new Error(`the tarball ${path.basename(tgz)} is named ${shipped.name}, not ${name}`);
  if (shipped.version !== version) {
    throw new Error(`the tarball ${path.basename(tgz)} carries version ${shipped.version}, not ${version}`);
  }
  const shippedBin = binIsCanonical(shipped);
  if (shippedBin.length) {
    throw new Error(`the TARBALL declares bin paths npm will drop on install:\n  ${shippedBin.join('\n  ')}`);
  }
  const bins = Object.keys(shipped.bin || {});
  if (!bins.length) {
    throw new Error('the tarball declares no bin at all -- installing it would give the user no command.');
  }
  const have = new Set(packedFiles);
  for (const [bin, target] of Object.entries(shipped.bin)) {
    if (!have.has(String(target).replace(/^\.\//, '').replace(/\\/g, '/'))) {
      throw new Error(`the tarball's bin "${bin}" points at ${target}, which is not in the tarball`);
    }
  }
  return true;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.refuseDirectPublish || invokedByPublishLifecycle(process.env)) {
    throw new Error('do not run `npm publish` directly. It uploads this directory under one name only '
      + 'and skips the packaging checks and smoke tests.\n'
      + 'Use  npm run publish  (fast; skips the test suite) or  npm run release  (runs the full test suite first).');
  }

  const original = fs.readFileSync(PKG_PATH, 'utf8');
  const pkg = JSON.parse(original);

  // Verification is separable from publishing on purpose. A release that
  // published correctly but could not yet SEE itself on the registry must be
  // re-checkable without touching the registry again -- there is nothing left
  // to publish, and a version can never be published twice anyway.
  if (opts.verifyOnly) {
    verifyOnly(pkg);
    return;
  }

  const command = opts.skipTests ? 'npm run publish' : 'npm run release';
  const tag = `v${pkg.version}`;
  let n = 0;
  const next = (msg) => step(++n, msg);

  console.log(`Squad Hub ${opts.skipTests ? 'publish' : 'release'} -- v${pkg.version}`
    + `${opts.dryRun ? '  (DRY RUN, nothing is published)' : ''}`);
  if (opts.skipTests) {
    console.log('  The full test suite is skipped (--skip-tests). Every packaging check and both');
    console.log('  smoke tests still run. Use  npm run release  to run the test suite as well.');
  }

  next('checking the working tree is clean');
  const status = run('git', ['status', '--porcelain']);
  if (status.status !== 0) throw new Error('git status failed; run this from the checkout');
  if (status.stdout.trim()) {
    throw new Error(`the working tree has uncommitted changes:\n${status.stdout}\nCommit or stash them -- a release must match a commit.`);
  }
  const branch = (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim();
  const commit = (run('git', ['rev-parse', '--short', 'HEAD']).stdout || '').trim();
  const head = (run('git', ['rev-parse', 'HEAD']).stdout || '').trim();
  console.log(`    clean -- ${branch} @ ${commit}`);
  console.log(`    publishing THIS commit. If that is not what you meant, stop now.`);
  const taggedAt = tagCommit(tag);
  if (taggedAt && taggedAt !== head) {
    console.log(`    WARNING: ${tag} already exists at ${taggedAt.slice(0, 8)}, not this commit.`);
    console.log(`    The tag will not be moved. Make sure this commit is the ${tag} you mean to publish.`);
  }

  next('checking you are logged in to the public registry');
  const who = run('npm', ['whoami', '--registry', REGISTRY]);
  if (who.status !== 0) {
    if (!opts.dryRun) throw new Error(`not logged in to ${REGISTRY}\nRun:  npm login --registry=${REGISTRY}`);
    console.log(`    not logged in to ${REGISTRY} -- the rehearsal continues, a real publish would stop here`);
  } else {
    console.log(`    logged in as ${who.stdout.trim()}`);
  }
  const configured = run('npm', ['config', 'get', 'registry']).stdout;
  if (!sameRegistry(configured, REGISTRY)) {
    console.log(`    note: your default registry is ${String(configured).trim()} -- publishing explicitly to ${REGISTRY}`);
  }

  if (!opts.skipTests) {
    next('running the full test suite');
    const tests = run('npm', ['test'], { stdio: 'inherit' });
    if (tests.status !== 0) throw new Error('tests failed -- nothing published');
  }

  const binName = Object.keys(pkg.bin || {})[0] || PRIMARY;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hub-release-'));
  let primary;
  let alias;
  try {
    next('packing the tarball and checking it contains what the code reads');
    // Independent of the test suite on purpose: this runs on whatever commit
    // is checked out, with or without --skip-tests.
    const primaryPack = packInto(path.join(work, 'primary'));
    const required = requiredInPackage(pkg, webFilesOnDisk);
    const missing = missingFromPack(primaryPack.files, required);
    if (missing.length) {
      throw new Error(`the package would ship without files the code reads:\n  ${missing.join('\n  ')}\n`
        + `\nThe "files" list in package.json does not cover them. This checkout is not `
        + `releasable -- publishing it would put a broken ${pkg.version} on the registry permanently.`);
    }
    console.log(`    ${required.length} runtime files present in the tarball`);

    const rewritten = binIsCanonical(pkg);
    if (rewritten.length) {
      throw new Error(`npm would rewrite these bin entries on publish:\n  ${rewritten.join('\n  ')}\n`
        + `\nIt reports that as "script name ... was invalid and removed", which reads like the\n`
        + `CLI is being dropped. Write the path without a leading "./" so there is nothing to rewrite.`);
    }
    console.log('    bin is in npm\'s canonical form, so publish will not rewrite it');

    const noShebang = binMissingShebang(pkg, (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').slice(0, 2));
    if (noShebang.length) {
      throw new Error(`these bin targets do not start with a shebang:\n  ${noShebang.join('\n  ')}\n`
        + `\nWithout one, npm's Windows shim hands the .js to the file association instead of\n`
        + `running node -- which can exit 0 having done nothing, printing neither stdout nor\n`
        + `stderr. Add "#!/usr/bin/env node" as the first line.`);
    }
    console.log('    every bin target starts with a shebang, so npm will shim it through node');

    // The tarball's own package.json is what a consumer's npm reads; no check
    // of the source file can see it.
    if (checkTarballManifest(primaryPack.tgz, PRIMARY, pkg.version, primaryPack.files)) {
      console.log(`    the tarball is ${PRIMARY}@${pkg.version} and installs: ${binName}`);
    } else {
      console.log('    note: no tar available to open the tarball -- checked the source manifest only');
    }

    next(`building the ${ALIAS} tarball from the same files`);
    const stage = path.join(work, 'alias-source');
    for (const f of primaryPack.files) {
      if (f === 'package.json') continue;
      const to = path.join(stage, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), to);
    }
    fs.writeFileSync(path.join(stage, 'package.json'), withName(original, ALIAS));
    const aliasPack = packInto(path.join(work, 'alias'), stage, ['--ignore-scripts']);
    const drift = fileSetDifference(primaryPack.entries, aliasPack.entries);
    if (drift.length) {
      throw new Error(`the two tarballs do not ship the same files:\n  ${drift.join('\n  ')}`);
    }
    if (checkTarballManifest(aliasPack.tgz, ALIAS, pkg.version, aliasPack.files)) {
      console.log(`    ${ALIAS}@${pkg.version}: the same ${primaryPack.files.length} files; only the name differs`);
    } else {
      console.log(`    ${ALIAS}: the same ${primaryPack.files.length} files (no tar to open the manifest)`);
    }

    // Everything above reads a manifest or a file list. This runs each
    // package -- offline, from its tarball, through npm's own shim -- because
    // the alternative is finding out after an immutable publish.
    next('installing both tarballs and running them, before anything is published');
    for (const [name, tgz] of [[PRIMARY, primaryPack.tgz], [ALIAS, aliasPack.tgz]]) {
      const smoke = smokeTestTarball(tgz, binName, pkg.version);
      if (!smoke.ok) {
        throw new Error(`the packaged ${name} does not work: ${smoke.reason}\n\n`
          + `${String(smoke.output).split('\n').map((l) => `      ${l}`).join('\n')}\n\n`
          + `Nothing has been published. Fix this first -- a published version cannot be replaced.`);
      }
      console.log(`    ${name}: installed from the tarball and ran ${binName} --version -> ${smoke.output}`);
    }

    next(`publishing ${PRIMARY}`);
    primary = publish(PRIMARY, primaryPack.tgz, opts.extraArgs, opts.dryRun, command);

    next(`publishing ${ALIAS}`);
    alias = publish(ALIAS, aliasPack.tgz, opts.extraArgs, opts.dryRun, command);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  if (opts.dryRun) {
    console.log(`\nDry run complete. v${pkg.version} would publish as ${PRIMARY} and ${ALIAS};`
      + ' nothing was published, verified, or tagged.');
    return;
  }

  console.log(`\nv${pkg.version}: ${PRIMARY} ${primary}, ${ALIAS} ${alias}.`);

  next('proving the published packages actually install a working command');
  // BOTH NAMES, not just the primary. They are separate packages to npm and
  // have already disagreed from an identical tarball: on 0.2.0 the unscoped
  // name failed while the scoped one passed, and it was the disagreement that
  // located the fault.
  let verified = true;
  for (const name of [PRIMARY, ALIAS]) {
    console.log(`\n  [${name}]`);
    if (!reportVerification(name, pkg.version, verifyPublished(name, pkg.version))) verified = false;
  }
  if (!verified) {
    console.error(`\nPUBLISHED, BUT NOT VERIFIED.`);
    console.error(`If it is only propagation, re-check with:  npm run verify`);
    console.error(`If it genuinely installs no command, this version cannot be replaced:`);
    console.error(`  1. npm deprecate ${PRIMARY}@${pkg.version} "broken packaging, use a later version"`);
    console.error(`     npm deprecate ${ALIAS}@${pkg.version} "broken packaging, use a later version"`);
    console.error(`  2. fix the cause, bump the version, and release again.\n`);
    process.exitCode = 1;
    return;
  }

  next('tagging this commit');
  // A published version that cannot be checked out is a version nobody can
  // reproduce a bug against later. Created locally and never pushed for you.
  const existing = tagCommit(tag);
  if (existing) {
    console.log(existing === head
      ? `    ${tag} already points at this commit`
      : `    WARNING: ${tag} already exists and points at ${existing.slice(0, 8)}, not this commit`);
  } else {
    const made = run('git', ['tag', tag]);
    console.log(made.status === 0
      ? `    created ${tag}`
      : `    could not create ${tag}: ${(made.stderr || '').trim()}`);
  }
  console.log(`\nBoth names are live and verified at ${pkg.version}.`);
  console.log(`Push the tag when you are ready:  git push origin ${tag}`);
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
  requiredInPackage, missingFromPack, binIsCanonical, packedManifest,
  tarballManifest, packInto, smokeTestTarball, binMissingShebang,
  classifyAttempt, verifyPublished, reportVerification,
  parseArgs, invokedByPublishLifecycle, npmCli, commandFor, fileSetDifference,
  PRIMARY, ALIAS, REGISTRY,
};
