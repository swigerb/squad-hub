'use strict';
/**
 * `npm run publish` and `npm run release`, run end to end.
 *
 * package-unit checks the release script's parts. This runs the whole script,
 * as a person would, in a throwaway git checkout of this package, with npm
 * replaced by a fake that records every call. `pack` and `install` are passed
 * to the real npm, offline, so the tarballs and smoke tests are real.
 * `whoami`, `test` and `publish` are answered by the fake, and npx is faked
 * too: NOTHING HERE EVER TALKS TO A REGISTRY. The npm environment points the
 * registry at a closed local port, so a call that slipped through would fail
 * instead of reaching the network.
 *
 * What only a full run can show:
 *   - each name is published from the tarball that was checked, primary first
 *   - --skip-tests skips the test suite and nothing else
 *   - the checkout is left exactly as it was found
 *   - a bare `npm publish` is stopped before git or npm is touched
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const release = require('../scripts/release-npm');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const TAG = `v${pkg.version}`;
const RUN_TIMEOUT_MS = 240000;

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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hub-release-e2e-'));
const repo = path.join(work, 'repo');
const fake = path.join(work, 'fake-npm');
const published = path.join(work, 'published');
const npmLog = path.join(work, 'npm-calls.jsonl');
const realNpm = release.npmCli('npm', process.env);

const FAKE_NPM = `'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG,
  JSON.stringify({ tool: 'npm', args, cwd: process.cwd() }) + '\\n');
if (process.env.FAKE_NPM_FAIL_ALL) process.exit(97);
const cmd = args[0];
if (cmd === 'whoami') { console.log('fake-publisher'); process.exit(0); }
if (cmd === 'config' && args[1] === 'get' && args[2] === 'registry') {
  console.log('https://registry.npmjs.org/');
  process.exit(0);
}
if (cmd === 'test') {
  console.log('fake npm test');
  process.exit(Number(process.env.FAKE_NPM_TEST_EXIT || 0));
}
if (cmd === 'publish') {
  const tgz = args[1];
  if (!tgz || !/\\.tgz$/.test(tgz) || !fs.existsSync(tgz)) {
    console.error('fake npm: publish was not given a tarball: ' + args.join(' '));
    process.exit(98);
  }
  const out = process.env.FAKE_NPM_OUT;
  const n = fs.readdirSync(out).length;
  fs.copyFileSync(tgz, path.join(out, n + '-' + path.basename(tgz)));
  console.log('+ fake publish ' + path.basename(tgz));
  process.exit(0);
}
if (cmd === 'pack' || cmd === 'install') {
  const r = spawnSync(process.execPath, [process.env.FAKE_NPM_REAL_CLI, ...args],
    { stdio: 'inherit', env: process.env, windowsHide: true });
  process.exit(r.status === null ? 99 : r.status);
}
console.error('fake npm: unexpected command: ' + args.join(' '));
process.exit(97);
`;

const FAKE_NPX = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG,
  JSON.stringify({ tool: 'npx', args, cwd: process.cwd() }) + '\\n');
if (process.env.FAKE_NPX_VERSION) { console.log(process.env.FAKE_NPX_VERSION); process.exit(0); }
process.exit(97);
`;

function git(args) {
  const r = spawnSync('git', args, {
    cwd: repo, encoding: 'utf8', env: cleanEnv(), windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return (r.stdout || '').trim();
}

/**
 * The environment the release runs in: this process's, minus anything npm or
 * git set for the PARENT (an outer `npm test` sets npm_command, a git hook
 * sets GIT_DIR), with npm pinned offline to a closed local registry.
 */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(npm_|GIT_)/i.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    npm_execpath: path.join(fake, 'npm-cli.js'),
    npm_config_offline: 'true',
    npm_config_registry: 'http://127.0.0.1:1/',
    npm_config_cache: path.join(work, 'npm-cache'),
    npm_config_userconfig: path.join(work, 'empty-npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    FAKE_NPM_LOG: npmLog,
    FAKE_NPM_OUT: published,
    FAKE_NPM_REAL_CLI: realNpm || '',
    ...extra,
  };
}

/** Run the copied release script in the throwaway checkout. */
function runRelease(args, extra = {}) {
  fs.writeFileSync(npmLog, '');
  fs.rmSync(published, { recursive: true, force: true });
  fs.mkdirSync(published);
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'release-npm.js'), ...args], {
    cwd: repo, encoding: 'utf8', env: cleanEnv(extra), timeout: RUN_TIMEOUT_MS,
    windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  const calls = fs.readFileSync(npmLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  return {
    status: r.status,
    error: r.error,
    stdout,
    out: `${stdout}${stderr}`,
    calls,
    npm: calls.filter((c) => c.tool === 'npm'),
    npx: calls.filter((c) => c.tool === 'npx'),
    tarballs: fs.readdirSync(published).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
      .map((f) => path.join(published, f)),
  };
}

function describe(r) {
  const calls = r.calls.map((c) => `${c.tool} ${c.args.join(' ')}`).join('\n    ');
  return `exit ${r.status}${r.error ? ` (${r.error.message})` : ''}\n  output:\n${r.out}\n  calls:\n    ${calls}`;
}

const callsOf = (r, cmd) => r.npm.filter((c) => c.args[0] === cmd);
const indexOf = (r, cmd) => r.calls.findIndex((c) => c.tool === 'npm' && c.args[0] === cmd);

/** Extract a tarball into `dir`, from inside it: GNU tar reads C:\\ as a host. */
function extract(tgz, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const local = path.join(dir, path.basename(tgz));
  fs.copyFileSync(tgz, local);
  const r = spawnSync('tar', ['-xzf', path.basename(local)], { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`tar could not extract ${path.basename(tgz)}: ${r.stderr || r.error}`);
  fs.rmSync(local);
  return path.join(dir, 'package');
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath || d.path, d.name)).replace(/\\/g, '/'))
    .sort();
}

// ---------------------------------------------------------------------------
// A throwaway checkout: the package's shipped files plus the release script.
// ---------------------------------------------------------------------------

let ready = false;
check('a throwaway checkout and a fake npm can be set up', () => {
  assert.ok(realNpm, 'could not find the real npm-cli.js to pack and install with');
  fs.mkdirSync(repo);
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(work, 'empty-npmrc'), '');
  fs.writeFileSync(path.join(fake, 'npm-cli.js'), FAKE_NPM);
  fs.writeFileSync(path.join(fake, 'npx-cli.js'), FAKE_NPX);
  for (const entry of ['package.json', ...pkg.files]) {
    fs.cpSync(path.join(ROOT, entry), path.join(repo, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'release-npm.js'), path.join(repo, 'scripts', 'release-npm.js'));
  git(['init', '-q']);
  for (const [k, v] of [
    ['user.name', 'Release Test'], ['user.email', 'release-test@example.com'],
    ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['tag.forceSignAnnotated', 'false'],
    ['core.autocrlf', 'false'], ['core.safecrlf', 'false'],
  ]) git(['config', k, v]);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'release fixture']);
  ready = true;
});

const originalManifest = ready ? fs.readFileSync(path.join(repo, 'package.json')) : null;

if (ready) try {
  // -------------------------------------------------------------------------
  // Refusals: each must stop before touching git or npm. Every npm call fails
  // here, so a refusal that leaks through stops quickly and visibly.
  // -------------------------------------------------------------------------
  const refused = runRelease(['--refuse-direct-publish'], { FAKE_NPM_FAIL_ALL: '1' });
  check('a bare npm publish is stopped before the release touches git or npm', () => {
    assert.strictEqual(refused.status, 1, describe(refused));
    assert.match(refused.out, /npm run publish/, 'the refusal does not say what to run instead');
    assert.match(refused.out, /npm run release/, 'the refusal does not mention npm run release');
    assert.strictEqual(refused.calls.length, 0, `npm was called:\n${describe(refused)}`);
    assert.ok(!refused.stdout.includes('[1]'), 'the release started its steps anyway');
  });

  const lifecycle = runRelease(['--skip-tests', '--dry-run'], { npm_command: 'publish', FAKE_NPM_FAIL_ALL: '1' });
  check('the npm publish lifecycle is refused even when publish flags are given', () => {
    assert.strictEqual(lifecycle.status, 1, describe(lifecycle));
    assert.match(lifecycle.out, /do not run `npm publish` directly/, describe(lifecycle));
    assert.strictEqual(lifecycle.calls.length, 0, `npm was called:\n${describe(lifecycle)}`);
  });

  fs.writeFileSync(path.join(repo, 'stray.txt'), 'not committed\n');
  const dirty = runRelease(['--skip-tests', '--dry-run'], { FAKE_NPM_FAIL_ALL: '1' });
  fs.rmSync(path.join(repo, 'stray.txt'));
  check('a dirty checkout is refused before anything is packed', () => {
    assert.strictEqual(dirty.status, 1, describe(dirty));
    assert.match(dirty.out, /uncommitted changes/, describe(dirty));
    assert.strictEqual(dirty.calls.length, 0, `npm was called:\n${describe(dirty)}`);
  });

  const redTests = runRelease(['--dry-run'], { FAKE_NPM_TEST_EXIT: '1' });
  check('npm run release stops when the test suite fails, before packing anything', () => {
    assert.strictEqual(redTests.status, 1, describe(redTests));
    assert.match(redTests.out, /tests failed -- nothing published/, describe(redTests));
    assert.strictEqual(callsOf(redTests, 'test').length, 1, `npm test was not run:\n${describe(redTests)}`);
    assert.strictEqual(callsOf(redTests, 'pack').length, 0, 'it packed after the tests failed');
    assert.strictEqual(callsOf(redTests, 'publish').length, 0, 'it published after the tests failed');
  });

  // -------------------------------------------------------------------------
  // npm run publish -- --dry-run, with an ANNOTATED tag on this commit: the
  // tag must be peeled to its commit, or it looks like a different commit.
  // -------------------------------------------------------------------------
  git(['tag', '-a', TAG, '-m', `release ${TAG}`]);
  const rehearsal = runRelease(['--skip-tests', '--dry-run']);
  const rehearsalPublishes = callsOf(rehearsal, 'publish');

  check('npm run publish -- --dry-run rehearses both names and exits cleanly', () => {
    assert.strictEqual(rehearsal.status, 0, describe(rehearsal));
    assert.match(rehearsal.out, /Dry run complete/, describe(rehearsal));
    assert.ok(!/FAILED/.test(rehearsal.out), describe(rehearsal));
  });

  check('npm run publish skips the test suite and says so', () => {
    assert.strictEqual(callsOf(rehearsal, 'test').length, 0, `npm test ran:\n${describe(rehearsal)}`);
    assert.match(rehearsal.out, /full test suite is skipped/, 'the skip is not announced');
  });

  check('npm run publish still installs and runs both tarballs before publishing', () => {
    const installs = rehearsal.calls
      .map((c, i) => [c, i]).filter(([c]) => c.tool === 'npm' && c.args[0] === 'install');
    assert.strictEqual(installs.length, 2, `expected two smoke installs:\n${describe(rehearsal)}`);
    const firstPublish = indexOf(rehearsal, 'publish');
    assert.ok(firstPublish > 0, `nothing was published:\n${describe(rehearsal)}`);
    for (const [c, i] of installs) {
      assert.ok(i < firstPublish, 'a tarball was installed only after publishing began');
      assert.ok(c.args.includes('--offline'), 'the smoke install is not offline');
    }
    const ran = rehearsal.out.match(/ran squad-hub --version -> /g) || [];
    assert.strictEqual(ran.length, 2, 'both packaged commands were not run');
  });

  check('each name is published from its own checked tarball, primary first', () => {
    assert.strictEqual(rehearsalPublishes.length, 2, describe(rehearsal));
    for (const c of rehearsalPublishes) {
      assert.match(String(c.args[1]), /\.tgz$/, `published something other than a tarball: ${c.args.join(' ')}`);
    }
    assert.strictEqual(rehearsal.tarballs.length, 2, 'the fake registry did not receive two tarballs');
    const [first, second] = rehearsal.tarballs.map((t) => release.tarballManifest(t));
    assert.ok(first && second, 'tar is needed to open the published tarballs');
    assert.strictEqual(first.name, release.PRIMARY);
    assert.strictEqual(second.name, release.ALIAS);
    assert.strictEqual(first.version, pkg.version);
    assert.strictEqual(second.version, pkg.version);
  });

  check('the rehearsal passes the flags a publish needs, plus --dry-run', () => {
    for (const c of rehearsalPublishes) {
      const a = c.args;
      const at = a.indexOf('--registry');
      assert.ok(at > 0 && a[at + 1] === release.REGISTRY, `no explicit public registry: ${a.join(' ')}`);
      for (const flag of ['--ignore-scripts', '--dry-run']) assert.ok(a.includes(flag), `missing ${flag}: ${a.join(' ')}`);
      assert.strictEqual(a[a.indexOf('--access') + 1], 'public', `not published as public: ${a.join(' ')}`);
    }
  });

  check('both published tarballs ship the same bytes, differing only in name', () => {
    assert.strictEqual(rehearsal.tarballs.length, 2, describe(rehearsal));
    const a = extract(rehearsal.tarballs[0], path.join(work, 'x-primary'));
    const b = extract(rehearsal.tarballs[1], path.join(work, 'x-alias'));
    assert.deepStrictEqual(filesUnder(b), filesUnder(a), 'the two tarballs list different files');
    for (const f of filesUnder(a)) {
      if (f === 'package.json') continue;
      assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))), `${f} differs`);
    }
    const ma = JSON.parse(fs.readFileSync(path.join(a, 'package.json'), 'utf8'));
    const mb = JSON.parse(fs.readFileSync(path.join(b, 'package.json'), 'utf8'));
    delete ma.name; delete mb.name;
    assert.deepStrictEqual(mb, ma, 'the alias manifest differs by more than its name');
  });

  check('the release leaves the checkout exactly as it found it', () => {
    assert.ok(fs.readFileSync(path.join(repo, 'package.json')).equals(originalManifest),
      'package.json was changed');
    assert.strictEqual(git(['status', '--porcelain']), '', 'the working tree is dirty after the release');
  });

  check('an annotated tag on this commit is not reported as another commit', () => {
    assert.ok(!/WARNING/.test(rehearsal.out), `a tag on HEAD drew a warning:\n${rehearsal.out}`);
  });

  // -------------------------------------------------------------------------
  // npm run release -- --otp=..., for real (against the fake): tests first,
  // flags passed through, both names verified, and the commit tagged.
  // -------------------------------------------------------------------------
  git(['tag', '-d', TAG]);
  const head = git(['rev-parse', 'HEAD']);
  const real = runRelease(['--otp=123456'], { FAKE_NPX_VERSION: pkg.version });

  check('npm run release runs the test suite before it packs anything', () => {
    assert.strictEqual(real.status, 0, describe(real));
    const tests = indexOf(real, 'test');
    const pack = indexOf(real, 'pack');
    assert.ok(tests >= 0, `npm test never ran:\n${describe(real)}`);
    assert.ok(pack > tests, 'the tarball was packed before the tests ran');
  });

  check('a real publish passes extra flags such as --otp through, without --dry-run', () => {
    const publishes = callsOf(real, 'publish');
    assert.strictEqual(publishes.length, 2, describe(real));
    for (const c of publishes) {
      assert.ok(c.args.includes('--otp=123456'), `--otp was not passed through: ${c.args.join(' ')}`);
      assert.ok(!c.args.includes('--dry-run'), `a real publish was a dry run: ${c.args.join(' ')}`);
    }
  });

  check('after publishing, both names are verified through npx, outside the checkout', () => {
    assert.strictEqual(real.npx.length, 2, describe(real));
    const specs = real.npx.map((c) => c.args[c.args.indexOf('--package') + 1]);
    assert.deepStrictEqual(specs, [`${release.PRIMARY}@${pkg.version}`, `${release.ALIAS}@${pkg.version}`]);
    for (const c of real.npx) {
      assert.deepStrictEqual(c.args.slice(c.args.indexOf('--')), ['--', 'squad-hub', '--version']);
      assert.ok(!path.resolve(c.cwd).startsWith(path.resolve(repo)), `npx ran inside the checkout: ${c.cwd}`);
    }
    assert.match(real.out, /Both names are live and verified/, describe(real));
  });

  check('a verified release tags the commit it published', () => {
    assert.strictEqual(git(['rev-parse', `refs/tags/${TAG}^{commit}`]), head, 'the tag is not on the published commit');
    assert.match(real.out, new RegExp(`created ${TAG.replace(/\./g, '\\.')}`), describe(real));
  });

  // -------------------------------------------------------------------------
  // A tag that already exists on ANOTHER commit is reported, and not moved.
  // -------------------------------------------------------------------------
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'a later commit\n');
  git(['add', 'notes.txt']);
  git(['commit', '-q', '-m', 'a later commit']);
  const moved = runRelease(['--skip-tests', '--dry-run'], { FAKE_NPM_FAIL_ALL: '1' });
  check('a release tag on another commit is reported, not silently accepted', () => {
    assert.match(moved.stdout, new RegExp(`WARNING: ${TAG.replace(/\./g, '\\.')} already exists at ${head.slice(0, 8)}`),
      describe(moved));
    assert.strictEqual(git(['rev-parse', `refs/tags/${TAG}^{commit}`]), head, 'the tag was moved');
  });
} catch (e) {
  // A scenario's own setup failed; report it rather than crash unsummarised.
  check('every release scenario could be set up', () => { throw e; });
}

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
