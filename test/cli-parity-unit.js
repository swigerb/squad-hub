'use strict';
/**
 * S1: CLI parity.
 *
 * The four gaps against the reference command surface -- `config edit`,
 * `autostart enable|disable|status`, `--env prod|ppe`, and `--no-config-cache`
 * -- plus the promise that the OLD service verbs never stop working.
 *
 * Every case drives the real binary in a private `SQUAD_HUB_HOME`, so nothing
 * here can touch the developer's own daemon or config. `config edit` is proven
 * with a scripted editor: `$EDITOR` is just a command, so a Node one-liner
 * makes an interactive command testable without a terminal.
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');

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

/** A private device home. Never the developer's own. */
function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sqhub-s1-'));
}

function run(home, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      SQUAD_HUB_HOME: home,
      // Never inherit the developer's real editor or environment URLs: an
      // inherited $EDITOR would open a window and hang the suite.
      VISUAL: '',
      EDITOR: '',
      SQUAD_HUB_PROD_URL: '',
      SQUAD_HUB_PPE_URL: '',
      SQUAD_HUB_URL: '',
      ...extraEnv,
    },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function readConfig(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
}

/**
 * An "editor" that is really a Node script. Takes the config path as its
 * argument, exactly as a real editor would, and applies `mutateSource` to the
 * parsed JSON -- or writes raw bytes when `raw` is given, which is how the
 * invalid-JSON case is produced.
 */
function fakeEditor(dir, { patch = null, raw = null, exitCode = 0 } = {}) {
  const file = path.join(dir, 'fake-editor.js');
  const body = raw !== null
    ? `fs.writeFileSync(f, ${JSON.stringify(raw)});`
    : patch
      ? `const j = JSON.parse(fs.readFileSync(f, 'utf8'));
         Object.assign(j, ${JSON.stringify(patch)});
         fs.writeFileSync(f, JSON.stringify(j, null, 2));`
      : '/* leaves the file exactly as it found it */';
  fs.writeFileSync(file, `const fs = require('fs');
const f = process.argv[2];
${body}
process.exit(${exitCode});
`);
  // Quoted: the temp path may contain spaces, and this string is handed to a
  // shell exactly as a user's own $EDITOR would be.
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;
}

// ===========================================================================
// autostart: the primary spelling
// ===========================================================================

check('`autostart status --dry-run` reports without touching the machine', () => {
  const home = makeHome();
  const r = run(home, ['autostart', 'status', '--dry-run', '--json']);
  assert.strictEqual(r.status, 0, r.out);
  const j = JSON.parse(r.out);
  assert.strictEqual(j.dryRun, true, 'a dry run must say so');
});

check('`autostart enable --dry-run` names the command it would run', () => {
  const home = makeHome();
  const r = run(home, ['autostart', 'enable', '--dry-run']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /^autostart enable:/m,
    'the label must name the spelling the user actually typed');
  assert.match(r.out, /dry run -- nothing was changed/);
});

check('`autostart disable --dry-run` is labelled as disable, not uninstall', () => {
  const home = makeHome();
  const r = run(home, ['autostart', 'disable', '--dry-run']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /^autostart disable:/m);
});

check('`autostart` with no verb is a usage error, not a silent no-op', () => {
  const home = makeHome();
  const r = run(home, ['autostart']);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /usage: squad-hub autostart <enable\|disable\|status>/);
});

check('`autostart nonsense` is refused rather than guessed at', () => {
  const home = makeHome();
  const r = run(home, ['autostart', 'enabl']);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /usage: squad-hub autostart/);
});

// ===========================================================================
// autostart: the OLD spellings still work
// ===========================================================================

check('`install-service` still works, and is still labelled by its own name', () => {
  const home = makeHome();
  const r = run(home, ['install-service', '--dry-run']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /^install-service:/m,
    'an alias must not start reporting itself under the new name');
});

check('`uninstall-service` still works', () => {
  const home = makeHome();
  const r = run(home, ['uninstall-service', '--dry-run']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /^uninstall-service:/m);
});

check('`service-status` still works', () => {
  const home = makeHome();
  const r = run(home, ['service-status', '--dry-run']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /^service-status:/m);
});

check('the alias and the new spelling describe the SAME login task', () => {
  const home = makeHome();
  const viaAlias = JSON.parse(run(home, ['service-status', '--dry-run', '--json']).out);
  const viaNew = JSON.parse(run(home, ['autostart', 'status', '--dry-run', '--json']).out);
  assert.deepStrictEqual(viaNew, viaAlias,
    'the alias must be the same command, not a second implementation');
});

// ===========================================================================
// config edit
// ===========================================================================

check('`config edit` creates the config file before opening an editor on it', () => {
  const home = makeHome();
  const file = path.join(home, 'config.json');
  assert.ok(!fs.existsSync(file), 'precondition: a fresh home has no config file');
  const r = run(home, ['config', 'edit'], { EDITOR: fakeEditor(home) });
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(fs.existsSync(file),
    'an editor opened on a nonexistent path is how someone edits nothing at all');
});

check('`config edit` persists what the editor saved', () => {
  const home = makeHome();
  const r = run(home, ['config', 'edit'], {
    EDITOR: fakeEditor(home, { patch: { trackAll: true } }),
  });
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /^saved /m);
  assert.strictEqual(readConfig(home).trackAll, true);
});

check('`config edit` says nothing changed when nothing changed', () => {
  const home = makeHome();
  const r = run(home, ['config', 'edit'], { EDITOR: fakeEditor(home) });
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /^no changes /m);
});

check('`config edit` refuses to call invalid JSON a success', () => {
  const home = makeHome();
  const r = run(home, ['config', 'edit'], {
    EDITOR: fakeEditor(home, { raw: '{ "trackAll": true,, }' }),
  });
  assert.strictEqual(r.status, 1, 'a broken config must be a nonzero exit');
  assert.match(r.out, /no longer valid JSON/);
  assert.match(r.out, /read as its default/,
    'the consequence is what makes this actionable, not just the parse error');
});

check('`config edit` reports an editor that will not launch', () => {
  const home = makeHome();
  const r = run(home, ['config', 'edit'], { EDITOR: 'squad-hub-no-such-editor-xyz' });
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /could not launch an editor/);
  assert.match(r.out, /Set \$EDITOR/, 'it must say how to fix it');
});

check('`config edit` reports an editor that exits nonzero', () => {
  const home = makeHome();
  const r = run(home, ['config', 'edit'], { EDITOR: fakeEditor(home, { exitCode: 3 }) });
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /exited with 3/);
});

check('$VISUAL is preferred over $EDITOR', () => {
  const home = makeHome();
  const r = run(home, ['config', 'edit'], {
    VISUAL: fakeEditor(home, { patch: { trackAll: true } }),
    EDITOR: 'squad-hub-no-such-editor-xyz',
  });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(readConfig(home).trackAll, true,
    '$VISUAL is the full-screen editor; $EDITOR may be a line editor for scripts');
});

// ===========================================================================
// ===========================================================================
// config allow-files: the one setting that decides whether a session can
// open a file, previously reachable only as a launch flag
// ===========================================================================

check('`config allow-files <root>` scopes to the root you NAME, not the one you stand in', () => {
  // `--allow-files` uses process.cwd(), so getting the root you meant depends
  // on remembering to `cd` first and nothing afterwards tells you what you
  // got. Naming it is the entire point of this form.
  const home = makeHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqh-root-'));
  const r = run(home, ['config', 'allow-files', root]);
  assert.strictEqual(r.status, 0, r.out);
  const cfg = readConfig(home);
  assert.strictEqual(cfg.allowFiles, true);
  assert.strictEqual(cfg.allowFilesAll, false);
  assert.strictEqual(cfg.filesRoot, fs.realpathSync(root) === root ? root : path.resolve(root));
});

check('`config allow-files --all` lifts the confinement', () => {
  const home = makeHome();
  const r = run(home, ['config', 'allow-files', '--all']);
  assert.strictEqual(r.status, 0, r.out);
  const cfg = readConfig(home);
  assert.strictEqual(cfg.allowFilesAll, true);
  assert.strictEqual(cfg.filesRoot, null, 'a root alongside "all" would be two answers to one question');
});

check('`config disable-files` turns it back off completely', () => {
  const home = makeHome();
  run(home, ['config', 'allow-files', '--all']);
  const r = run(home, ['config', 'disable-files']);
  assert.strictEqual(r.status, 0, r.out);
  const cfg = readConfig(home);
  assert.strictEqual(cfg.allowFiles, false);
  assert.strictEqual(cfg.allowFilesAll, false, 'leaving allowFilesAll set would re-grant everything on the next enable');
  assert.strictEqual(cfg.filesRoot, null);
});

check('`config allow-files` refuses a directory that does not exist', () => {
  // Writing it anyway produces a device that reports file access and then
  // refuses every working directory, with nothing saying why.
  const home = makeHome();
  const missing = path.join(os.tmpdir(), 'sqh-definitely-not-here-9c1f');
  const r = run(home, ['config', 'allow-files', missing]);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /no such directory/);
  assert.ok(!fs.existsSync(path.join(home, 'config.json')) || readConfig(home).allowFiles !== true,
    'a refused root must not leave file access switched on');
});

check('file access is discoverable in the usage text', () => {
  const r = run(makeHome(), ['help']);
  assert.match(r.out, /config \[show\|edit[\s\S]*allow-files/,
    'someone reading `squad-hub help` must be able to find the setting that decides file access');
});


check('`config env` lists both environments, unset', () => {
  const home = makeHome();
  const r = run(home, ['config', 'env']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /prod\s+\(not set\)/);
  assert.match(r.out, /ppe\s+\(not set\)/);
});

check('`config env <name> <url>` persists it', () => {
  const home = makeHome();
  const r = run(home, ['config', 'env', 'ppe', 'https://ppe.example.com']);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(readConfig(home).environments.ppe, 'https://ppe.example.com');
});

check('`config env <name> none` clears it', () => {
  const home = makeHome();
  run(home, ['config', 'env', 'ppe', 'https://ppe.example.com']);
  const r = run(home, ['config', 'env', 'ppe', 'none']);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(readConfig(home).environments.ppe, undefined);
});

check('`config env` refuses a non-http URL', () => {
  const home = makeHome();
  const r = run(home, ['config', 'env', 'ppe', 'ftp://ppe.example.com']);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /must be http:\/\/ or https:\/\//);
  assert.ok(!fs.existsSync(path.join(home, 'config.json')) || !readConfig(home).environments.ppe,
    'a refused URL must not be written');
});

check('`config env` refuses an unknown environment name', () => {
  const home = makeHome();
  const r = run(home, ['config', 'env', 'staging', 'https://x.example.com']);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /unknown environment: staging/);
});

check('the environment VARIABLE wins over the persisted value', () => {
  const home = makeHome();
  run(home, ['config', 'env', 'prod', 'https://saved.example.com']);
  const r = run(home, ['config', 'env'], { SQUAD_HUB_PROD_URL: 'https://fromenv.example.com' });
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /https:\/\/fromenv\.example\.com/);
  assert.match(r.out, /from SQUAD_HUB_PROD_URL/,
    'it must say WHERE the value came from, or an override looks like corruption');
});

// ===========================================================================
// --env
// ===========================================================================

check('--env is accepted BEFORE the subcommand', () => {
  const home = makeHome();
  run(home, ['config', 'env', 'ppe', 'https://ppe.example.com']);
  const r = run(home, ['--env', 'ppe', 'status']);
  assert.strictEqual(r.status, 3, 'no daemon is running, so 3 -- the point is it got that far');
  assert.doesNotMatch(r.out, /unknown command/,
    'a global option before the subcommand must not be mistaken for one');
});

check('--env is accepted AFTER the subcommand', () => {
  const home = makeHome();
  run(home, ['config', 'env', 'ppe', 'https://ppe.example.com']);
  const r = run(home, ['status', '--env', 'ppe']);
  assert.strictEqual(r.status, 3, r.out);
  assert.doesNotMatch(r.out, /unknown/);
});

check('--env=name is accepted too', () => {
  const home = makeHome();
  run(home, ['config', 'env', 'ppe', 'https://ppe.example.com']);
  const r = run(home, ['status', '--env=ppe']);
  assert.strictEqual(r.status, 3, r.out);
  assert.doesNotMatch(r.out, /unknown --env/);
});

check('an unknown --env value is refused, never guessed', () => {
  const home = makeHome();
  const r = run(home, ['--env', 'staging', 'status']);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /unknown --env: staging/);
  assert.match(r.out, /expected prod or ppe/);
});

check('--env with no value is a usage error', () => {
  const home = makeHome();
  const r = run(home, ['status', '--env']);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /--env needs a value/);
});

check('an UNCONFIGURED --env fails loudly instead of falling back to local-only', () => {
  const home = makeHome();
  const r = run(home, ['--env', 'prod', 'status']);
  assert.strictEqual(r.status, 2, 'silently ignoring it is how work lands in the wrong place');
  assert.match(r.out, /--env prod is not configured/);
  assert.match(r.out, /config env prod <url>/, 'it must say how to configure it');
});

check('a pinned server WINS over --env, and says so', () => {
  const home = makeHome();
  run(home, ['config', 'env', 'ppe', 'https://ppe.example.com']);
  run(home, ['config', 'server', 'https://pinned.example.com']);
  const r = run(home, ['--env', 'ppe', 'status']);
  assert.match(r.out, /--env ppe ignored: a server is pinned \(https:\/\/pinned\.example\.com\)/,
    'an option dropped on the floor in silence is worse than one refused');
  assert.match(r.out, /unset-server/, 'it must say how to make --env take effect');
});

check('--env resolves through SQUAD_HUB_PROD_URL with nothing persisted', () => {
  const home = makeHome();
  const r = run(home, ['--env', 'prod', 'status'], { SQUAD_HUB_PROD_URL: 'https://fromenv.example.com' });
  assert.strictEqual(r.status, 3, r.out);
  assert.doesNotMatch(r.out, /not configured/);
});

check('--env refuses a configured value that is not an http(s) URL', () => {
  const home = makeHome();
  const r = run(home, ['--env', 'prod', 'status'], { SQUAD_HUB_PROD_URL: 'not-a-url' });
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /not an http:\/\/ or https:\/\/ URL/);
});

check('--env never reaches `help` or `--version`', () => {
  const home = makeHome();
  // Unconfigured `prod` would be a usage error for any real command. Reading
  // the usage text must not require a working hub environment.
  const help = run(home, ['--env', 'prod', 'help']);
  assert.strictEqual(help.status, 0, help.out);
  assert.match(help.out, /squad-hub - see and control your Squad sessions/);
  const version = run(home, ['--env', 'prod', '--version']);
  assert.strictEqual(version.status, 0, version.out);
});

check('--env does NOT pin the server it resolved', () => {
  const home = makeHome();
  run(home, ['config', 'env', 'ppe', 'https://ppe.example.com']);
  run(home, ['--env', 'ppe', 'status']);
  const cfg = readConfig(home);
  assert.strictEqual(cfg.server, null,
    '--env is a per-invocation choice; pinning it would make the next --env be ignored');
});

// ===========================================================================
// --no-config-cache
// ===========================================================================

check('--no-config-cache is accepted on either side of the subcommand', () => {
  const home = makeHome();
  const before = run(home, ['--no-config-cache', 'config', 'show']);
  assert.strictEqual(before.status, 0, before.out);
  const after = run(home, ['config', 'show', '--no-config-cache']);
  assert.strictEqual(after.status, 0, after.out);
  assert.deepStrictEqual(JSON.parse(after.out), JSON.parse(before.out),
    'the flag changes when the file is read, never what it says');
});

check('--no-config-cache is never mistaken for a positional argument', () => {
  const home = makeHome();
  const r = run(home, ['config', '--no-config-cache', 'env', 'ppe', 'https://ppe.example.com']);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(readConfig(home).environments.ppe, 'https://ppe.example.com',
    'a global option between the command and its arguments must not shift them');
});

check('the config cache is invalidated by a write in the same process', () => {
  // `config server` reads (to merge) and then writes; `config show` in the same
  // process would serve a memo of the PRE-write file if the cache were blind.
  const home = makeHome();
  const cfg = require('../src/config');
  const prior = process.env.SQUAD_HUB_HOME;
  process.env.SQUAD_HUB_HOME = home;
  try {
    cfg.invalidate();
    assert.strictEqual(cfg.read().trackAll, false, 'precondition: factory default');
    cfg.update({ trackAll: true });
    assert.strictEqual(cfg.read().trackAll, true,
      'a read after a write in the same process must never serve the old value');
  } finally {
    if (prior === undefined) delete process.env.SQUAD_HUB_HOME;
    else process.env.SQUAD_HUB_HOME = prior;
    cfg.invalidate();
  }
});

check('the config cache notices a file changed by ANOTHER process', () => {
  // The daemon reads the config; the CLI writes it, from a different process.
  // A memo keyed only on "we have read it once" would keep serving settings the
  // user had already changed -- so the memo is keyed on the file itself.
  const home = makeHome();
  const cfg = require('../src/config');
  const prior = process.env.SQUAD_HUB_HOME;
  process.env.SQUAD_HUB_HOME = home;
  try {
    cfg.invalidate();
    assert.strictEqual(cfg.read().trackAll, false, 'precondition: factory default');

    // A genuinely separate process, exactly like the real CLI/daemon split.
    run(home, ['track-all', 'on']);

    assert.strictEqual(cfg.read().trackAll, true,
      'a cached read must not outlive the file it was read from');
  } finally {
    if (prior === undefined) delete process.env.SQUAD_HUB_HOME;
    else process.env.SQUAD_HUB_HOME = prior;
    cfg.invalidate();
  }
});

check('a caller cannot mutate the cache through what read() handed it', () => {
  const home = makeHome();
  const cfg = require('../src/config');
  const prior = process.env.SQUAD_HUB_HOME;
  process.env.SQUAD_HUB_HOME = home;
  try {
    cfg.invalidate();
    const a = cfg.read();
    a.trackAll = true;
    a.environments.ppe = 'https://injected.example.com';
    const b = cfg.read();
    assert.strictEqual(b.trackAll, false, 'a mutation by one caller leaked into the next');
    assert.strictEqual(b.environments.ppe, undefined,
      'the nested environments map must be copied too, not shared');
    assert.strictEqual(cfg.DEFAULTS.environments.ppe, undefined,
      'the frozen defaults must never be reachable for mutation');
  } finally {
    if (prior === undefined) delete process.env.SQUAD_HUB_HOME;
    else process.env.SQUAD_HUB_HOME = prior;
    cfg.invalidate();
  }
});

check('setCacheEnabled(false) makes every read hit the file', () => {
  const home = makeHome();
  const cfg = require('../src/config');
  const prior = process.env.SQUAD_HUB_HOME;
  process.env.SQUAD_HUB_HOME = home;
  try {
    cfg.setCacheEnabled(false);
    assert.strictEqual(cfg.read().trackAll, false);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ trackAll: true }));
    assert.strictEqual(cfg.read().trackAll, true,
      'with the cache off, the file is authoritative on every single read');
  } finally {
    cfg.setCacheEnabled(true);
    if (prior === undefined) delete process.env.SQUAD_HUB_HOME;
    else process.env.SQUAD_HUB_HOME = prior;
    cfg.invalidate();
  }
});

check('--no-config-cache reads a change the stamp cannot see', () => {
  /**
   * The one case the mtime-and-size stamp genuinely cannot detect, and
   * therefore the entire reason `--no-config-cache` exists: a file replaced by
   * one of the SAME length whose modification time is restored behind it.
   *
   * Contrived on purpose -- it is a deterministic stand-in for the real
   * hazard, which is a filesystem whose timestamp granularity is coarse enough
   * that a write lands inside the same tick as the read before it.
   *
   * Proven both ways. The cached half asserts the stale value IS served, so a
   * cache that never actually cached could not pass; the uncached half then
   * requires TWO reads, because merely turning the cache off drops whatever it
   * held -- a single read afterwards would hit the disk either way and prove
   * nothing about the flag.
   */
  const home = makeHome();
  const cfg = require('../src/config');
  const file = path.join(home, 'config.json');
  const prior = process.env.SQUAD_HUB_HOME;
  process.env.SQUAD_HUB_HOME = home;

  // Same byte length throughout, so only the value differs and the stamp's
  // size component cannot notice either.
  const body = (name) => JSON.stringify({ trackAll: false, deviceName: name });
  assert.strictEqual(body('aa').length, body('bb').length, 'the fixture must be length-stable');

  // A whole second: mtimeMs carries sub-millisecond precision that utimesSync
  // cannot round-trip, so "restoring" a raw stat would land microseconds off
  // and the stamp would spot the change after all -- testing the opposite of
  // what this is for.
  const pinned = Math.floor(Date.now() / 1000);
  const writeInvisibly = (name) => {
    fs.writeFileSync(file, body(name));
    fs.utimesSync(file, pinned, pinned);
  };

  try {
    cfg.setCacheEnabled(true);
    cfg.invalidate();
    writeInvisibly('aa');
    assert.strictEqual(cfg.read().deviceName, 'aa');

    writeInvisibly('bb');
    assert.strictEqual(cfg.read().deviceName, 'aa',
      'precondition: with the cache on, an invisible change IS served stale');

    cfg.setCacheEnabled(false);
    assert.strictEqual(cfg.read().deviceName, 'bb',
      'turning the cache off must drop whatever it was holding');

    writeInvisibly('cc');
    assert.strictEqual(cfg.read().deviceName, 'cc',
      '--no-config-cache must bypass the stamp on EVERY read, not just the first');
  } finally {
    cfg.setCacheEnabled(true);
    if (prior === undefined) delete process.env.SQUAD_HUB_HOME;
    else process.env.SQUAD_HUB_HOME = prior;
    cfg.invalidate();
  }
});

// ===========================================================================
// The surface itself
// ===========================================================================

check('the usage text names autostart and both global options', () => {
  const home = makeHome();
  const r = run(home, ['help']);
  assert.strictEqual(r.status, 0, r.out);
  for (const promise of ['autostart enable', 'autostart disable', 'autostart status',
    '--env prod|ppe', '--no-config-cache', 'config [show|edit']) {
    assert.ok(r.out.includes(promise), `usage never mentions ${promise}`);
  }
});

check('the usage text still names the older service spellings', () => {
  const home = makeHome();
  const r = run(home, ['help']);
  assert.match(r.out, /install-service/,
    'an alias nobody can discover is an alias people stop trusting');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
