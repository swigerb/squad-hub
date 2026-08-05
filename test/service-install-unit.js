'use strict';
/**
 * `squad-hub install-service` / `uninstall-service` / `service-status` (E5).
 *
 * The one rule that overrides everything else here: THE TEST SUITE MUST NEVER
 * ACTUALLY REGISTER A LOGIN TASK ON THE MACHINE IT RUNS ON. Every assertion in
 * this file therefore either calls the module with `dryRun: true` (which
 * src/service-install.js guarantees never spawns schtasks/systemctl/launchctl
 * or touches disk) or calls the real CLI with `--dry-run` and inspects the
 * printed plan -- never a bare `install-service` / real `svc.install()`.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'squad-hub.js');

const svc = require('../src/service-install');

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

function cli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, ...extraEnv }, encoding: 'utf8', cwd: ROOT, timeout: 15000,
  });
}

// A spy that fails the test loudly if the real service-manager binary is ever
// actually invoked. child_process.spawnSync is monkey-patched only for the
// duration of a check that must prove "no real command ran".
function withSpawnSpy(fn) {
  const cp = require('child_process');
  const real = cp.spawnSync;
  const calls = [];
  cp.spawnSync = (...a) => { calls.push(a); return real(...a); };
  try { fn(calls); } finally { cp.spawnSync = real; }
}

// ---------------------------------------------------------------------------
// plan() is pure: same shape every time, no side effects, matches the real
// platform this suite happens to be running on (win32 in the live environment).
// ---------------------------------------------------------------------------

check('plan() reports the current platform as supported (win32 has Task Scheduler)', () => {
  const p = svc.plan();
  if (process.platform === 'win32') {
    assert.strictEqual(p.supported, true);
    assert.strictEqual(p.kind, 'Windows Task Scheduler');
    assert.strictEqual(p.install.command, 'schtasks');
    assert.ok(p.install.args.includes('/create'));
    assert.ok(p.install.args.includes(svc.TASK_NAME));
    assert.ok(p.install.args.includes('/f'), 'schtasks create must be idempotent (/f = force overwrite)');
  } else {
    assert.ok(typeof p.supported === 'boolean');
  }
});

check('plan() is pure -- calling it twice never touches disk or changes state', () => {
  const a = JSON.stringify(svc.plan());
  const b = JSON.stringify(svc.plan());
  assert.strictEqual(a, b);
});

check('the generated command line quotes node and the script path individually (spaces-in-path safe)', () => {
  const p = svc.plan();
  if (p.platform === 'win32') {
    assert.match(p.install.args.join(' '), /"[^"]*node\.exe"?\s+"[^"]*squad-hub\.js"\s+start|node.*squad-hub\.js.*start/i, 'no clean single-string command line for schtasks /tr');
    // The literal /tr value itself must carry two independently quoted paths.
    const tr = p.install.args[p.install.args.indexOf('/tr') + 1];
    const quoteCount = (tr.match(/"/g) || []).length;
    assert.ok(quoteCount >= 4, `expected at least two quoted paths (4 quote chars), got: ${tr}`);
  }
});

check('NODE_EXE and BIN_JS resolve to real, existing paths (works whether or not npm link was used)', () => {
  const fs = require('fs');
  assert.ok(fs.existsSync(svc.NODE_EXE), `node executable path does not exist: ${svc.NODE_EXE}`);
  assert.ok(fs.existsSync(svc.BIN_JS), `bin/squad-hub.js path does not exist: ${svc.BIN_JS}`);
  assert.strictEqual(path.basename(svc.BIN_JS), 'squad-hub.js');
});

// ---------------------------------------------------------------------------
// dryRun: true must NEVER spawn a real service-manager process.
// ---------------------------------------------------------------------------

check('install({dryRun:true}) never calls spawnSync at all', () => {
  withSpawnSpy((calls) => {
    const r = svc.install({ dryRun: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(calls.length, 0, `spawnSync was called ${calls.length} time(s) during a dry run`);
  });
});

check('uninstall({dryRun:true}) never calls spawnSync at all', () => {
  withSpawnSpy((calls) => {
    const r = svc.uninstall({ dryRun: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(calls.length, 0, `spawnSync was called ${calls.length} time(s) during a dry run`);
  });
});

check('status({dryRun:true}) never calls spawnSync at all', () => {
  withSpawnSpy((calls) => {
    const r = svc.status({ dryRun: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(calls.length, 0, `spawnSync was called ${calls.length} time(s) during a dry run`);
  });
});

check('dryRun install() reports the exact plan shape a real install would use', () => {
  const r = svc.install({ dryRun: true });
  const p = svc.plan();
  assert.strictEqual(r.kind, p.kind);
  assert.deepStrictEqual(r.install, p.install);
  assert.strictEqual(r.result, undefined, 'a dry run must not report a fabricated exec result');
});

check('dryRun is idempotent -- calling install twice in a row reports the same plan both times', () => {
  const r1 = svc.install({ dryRun: true });
  const r2 = svc.install({ dryRun: true });
  assert.deepStrictEqual(r1, r2);
});

check('an unsupported platform is reported cleanly, not silently treated as supported', () => {
  // service-install.js's plan() reads process.platform directly, so this
  // exercises the message shape by asserting the current real platform is
  // one of the three EXPLICITLY implemented ones or else falls into the
  // "not supported" branch -- either way, `supported` is always a real
  // boolean and never left undefined/truthy-by-accident.
  const p = svc.plan();
  assert.ok(p.supported === true || p.supported === false);
  if (!p.supported) assert.match(p.reason, /no login-startup mechanism is implemented/);
});

// ---------------------------------------------------------------------------
// B2 -- dependency injection: dry-run must be structurally incapable of ever
// invoking a runner, even a runner that DOES get passed in. A test that only
// ever calls dryRun:true with the DEFAULT runner (as every test above did,
// before this file was revised) is not proof of anything -- it never gave the
// dry-run branch a chance to fail. A poisoned `run` closes that gap: if the
// early return in install/uninstall/status were ever bypassed, removed, or
// misordered, this throws immediately and the check fails LOUDLY, in-process,
// with no chance a real schtasks/systemctl/launchctl call slips through.
// ---------------------------------------------------------------------------

function poisonRunner(label) {
  return () => { throw new Error(`${label}: a real service-manager command was invoked during a dry run`); };
}

check('install({dryRun:true}) never invokes an injected runner, even if the early return were removed', () => {
  assert.doesNotThrow(() => {
    const r = svc.install({ dryRun: true, run: poisonRunner('install') });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dryRun, true);
  });
});

check('uninstall({dryRun:true}) never invokes an injected runner', () => {
  assert.doesNotThrow(() => {
    svc.uninstall({ dryRun: true, run: poisonRunner('uninstall') });
  });
});

check('status({dryRun:true}) never invokes an injected runner', () => {
  assert.doesNotThrow(() => {
    svc.status({ dryRun: true, run: poisonRunner('status') });
  });
});

// ---------------------------------------------------------------------------
// B3 -- plan() (and install/uninstall/status) accept platform/home/nodeExe/
// binJs overrides, so the Windows machine running this suite can construct
// AND exercise the Linux, macOS, and unsupported shapes end to end -- with an
// injected `run` so nothing real is ever spawned, and an injected `home`
// pointed at a throwaway temp directory so nothing real is ever written to
// this machine's actual home directory either.
// ---------------------------------------------------------------------------

check('plan({platform:"linux"}) builds a systemd user unit plan regardless of host OS', () => {
  const p = svc.plan({ platform: 'linux', home: '/home/A User', nodeExe: '/usr/bin/node', binJs: '/opt/squad hub/bin/squad-hub.js' });
  assert.strictEqual(p.supported, true);
  assert.strictEqual(p.kind, 'systemd user unit');
  assert.strictEqual(p.install.command, 'systemctl');
  assert.ok(p.file.includes('systemd'));
  assert.ok(p.contents.includes('ExecStart='));
});

check('plan({platform:"darwin"}) builds a macOS LaunchAgent plan regardless of host OS', () => {
  const p = svc.plan({ platform: 'darwin', home: 'C:\\Users\\Test User', nodeExe: 'C:\\Program Files\\nodejs\\node.exe', binJs: 'C:\\Program Files\\squad-hub\\bin\\squad-hub.js' });
  assert.strictEqual(p.supported, true);
  assert.strictEqual(p.kind, 'macOS LaunchAgent');
  assert.strictEqual(p.install.command, 'launchctl');
  assert.deepStrictEqual(p.install.args.slice(0, 2), ['load', '-w']);
  assert.ok(p.file.endsWith('.plist'));
  assert.ok(p.contents.includes('C:\\Program Files\\nodejs\\node.exe'));
});

check('plan({platform:"aix"}) (or any unimplemented platform) reports supported:false with a reason', () => {
  const p = svc.plan({ platform: 'aix' });
  assert.strictEqual(p.supported, false);
  assert.match(p.reason, /no login-startup mechanism is implemented for aix/);
});

check('install()/uninstall()/status() on an unsupported platform all set supported:false explicitly (not just ok:false)', () => {
  const install = svc.install({ platform: 'aix' });
  const uninstall = svc.uninstall({ platform: 'aix' });
  const status = svc.status({ platform: 'aix' });
  assert.strictEqual(install.supported, false, 'install() must set supported:false, not leave it undefined');
  assert.strictEqual(uninstall.supported, false, 'uninstall() must set supported:false, not leave it undefined');
  assert.strictEqual(status.supported, false, 'status() must set supported:false, not leave it undefined');
  assert.strictEqual(install.ok, false);
  assert.strictEqual(uninstall.ok, false);
  assert.strictEqual(status.ok, false);
});

check('the systemd ExecStart= line quotes node/bin paths independently -- a space in either does not split into extra tokens', () => {
  const p = svc.plan({ platform: 'linux', home: '/home/A User', nodeExe: '/usr/local/A Path/bin/node', binJs: '/opt/A Path/squad-hub.js' });
  const execLine = p.contents.split('\n').find((l) => l.startsWith('ExecStart='));
  assert.ok(execLine, 'no ExecStart= line found');
  const value = execLine.slice('ExecStart='.length);
  // systemd (>=243) splits ExecStart= the way a shell would: quoted segments
  // are one token no matter what whitespace is inside them. Reproduce that
  // exact tokenizing rule here (not just "must contain quotes") so the test
  // fails if the quoting is merely present but wrong (e.g. one shared pair of
  // quotes around both paths, which would still look "quoted" but tokenize
  // to the wrong thing).
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(value))) tokens.push(m[1].replace(/\\(.)/g, '$1'));
  assert.deepStrictEqual(tokens, ['/usr/local/A Path/bin/node', '/opt/A Path/squad-hub.js']);
});

check('systemdQuoteArg escapes embedded backslashes and double quotes', () => {
  const quoted = svc.systemdQuoteArg('C:\\weird "path"\\node.exe');
  assert.strictEqual(quoted, '"C:\\\\weird \\"path\\"\\\\node.exe"');
});

check('macOS install() tolerates launchctl reporting "already loaded" on a second run (idempotent, not a failure)', () => {
  const alreadyLoadedRun = () => ({ command: 'launchctl', args: ['load', '-w', 'x'], status: 1, stdout: '', stderr: 'launchctl: Operation already in progress / service already loaded', error: null });
  const home = require('fs').mkdtempSync(path.join(os.tmpdir(), 'sqsvc-mac-'));
  try {
    const r = svc.install({ platform: 'darwin', home, run: alreadyLoadedRun });
    assert.strictEqual(r.ok, true, 'a launchctl "already loaded" nonzero exit must still be reported as ok:true (idempotent)');
    assert.strictEqual(r.result.status, 1);
  } finally {
    require('fs').rmSync(home, { recursive: true, force: true });
  }
});

check('macOS install() still reports failure for a genuinely different nonzero launchctl exit', () => {
  const realFailureRun = () => ({ command: 'launchctl', args: ['load', '-w', 'x'], status: 1, stdout: '', stderr: 'launchctl: Permission denied', error: null });
  const home = require('fs').mkdtempSync(path.join(os.tmpdir(), 'sqsvc-mac2-'));
  try {
    const r = svc.install({ platform: 'darwin', home, run: realFailureRun });
    assert.strictEqual(r.ok, false, 'a genuine launchctl failure must not be swallowed by the idempotency tolerance');
  } finally {
    require('fs').rmSync(home, { recursive: true, force: true });
  }
});

check('macOS uninstall() tolerates launchctl reporting "not loaded"', () => {
  const notLoadedRun = () => ({ command: 'launchctl', args: ['unload', '-w', 'x'], status: 1, stdout: '', stderr: 'launchctl: Could not find specified service', error: null });
  const home = require('fs').mkdtempSync(path.join(os.tmpdir(), 'sqsvc-mac3-'));
  try {
    const r = svc.uninstall({ platform: 'darwin', home, run: notLoadedRun });
    assert.strictEqual(r.ok, true);
  } finally {
    require('fs').rmSync(home, { recursive: true, force: true });
  }
});

check('install() with an injected run + temp home actually exercises the real (non-dry-run) Linux code path safely', () => {
  const home = require('fs').mkdtempSync(path.join(os.tmpdir(), 'sqsvc-linux-'));
  try {
    const calls = [];
    const fakeRun = (step) => { calls.push(step); return { status: 0, stdout: '', stderr: '', error: null }; };
    const r = svc.install({ platform: 'linux', home, run: fakeRun });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].command, 'systemctl');
    assert.ok(require('fs').existsSync(r.file), 'install() must actually write the unit file when not a dry run');
  } finally {
    require('fs').rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The real CLI surface, always with --dry-run so the suite can run unattended.
// ---------------------------------------------------------------------------

{
  const home = require('fs').mkdtempSync(path.join(os.tmpdir(), 'sqsvc-'));
  try {
    check('`squad-hub install-service --dry-run` exits 0 and shows the command it WOULD run, without running it', () => {
      withSpawnSpy((calls) => {
        const r = cli(['install-service', '--dry-run'], { SQUAD_HUB_HOME: home });
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /dry.run/i);
        // The spy is on THIS process; the CLI ran in a real child process, so
        // it cannot be observed here directly -- what we CAN assert is that
        // nothing in this process's own child_process usage was triggered by
        // simply making the assertion (a smoke check the spy plumbing works).
        assert.strictEqual(calls.length, 0);
      });
    });

    check('`squad-hub install-service --dry-run --json` prints machine-readable JSON matching plan()', () => {
      const r = cli(['install-service', '--dry-run', '--json'], { SQUAD_HUB_HOME: home });
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.strictEqual(parsed.dryRun, true);
      assert.strictEqual(parsed.ok, true);
      const p = svc.plan();
      assert.deepStrictEqual(parsed.install, p.install);
    });

    check('`squad-hub uninstall-service --dry-run --json` also reports the real uninstall plan', () => {
      const r = cli(['uninstall-service', '--dry-run', '--json'], { SQUAD_HUB_HOME: home });
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      const parsed = JSON.parse(r.stdout);
      const p = svc.plan();
      assert.deepStrictEqual(parsed.uninstall, p.uninstall);
    });

    check('`squad-hub service-status --dry-run --json` reports the status-check plan, not a fabricated "installed" claim', () => {
      const r = cli(['service-status', '--dry-run', '--json'], { SQUAD_HUB_HOME: home });
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.strictEqual(parsed.dryRun, true);
      assert.ok(!('installed' in parsed), 'a dry run must not claim to know whether it is installed -- that requires actually asking the OS');
    });

    check('running install-service --dry-run twice in a row is idempotent (same JSON both times)', () => {
      const r1 = cli(['install-service', '--dry-run', '--json'], { SQUAD_HUB_HOME: home });
      const r2 = cli(['install-service', '--dry-run', '--json'], { SQUAD_HUB_HOME: home });
      assert.strictEqual(r1.stdout, r2.stdout);
    });
  } finally {
    require('fs').rmSync(home, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
