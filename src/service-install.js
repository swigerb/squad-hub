'use strict';
/**
 * Optional login-startup for the daemon: `squad-hub install-service` /
 * `uninstall-service` / `service-status`.
 *
 * Deliberately thin. This does not turn the detached daemon into a real
 * service manager -- it registers ONE login task that runs `squad-hub start`
 * once, which is enough because `start` already brings the daemon up and
 * returns. Windows Task Scheduler, a systemd user unit, and a macOS
 * LaunchAgent are the three login hooks that need no admin/root to install
 * for the CURRENT user, which is the one constraint that shaped everything
 * else here.
 *
 * No dependency does the platform work. `schtasks`, `systemctl --user`, and
 * `launchctl` are already on their respective platforms.
 *
 * EVERYTHING PLATFORM-SPECIFIC IS INJECTABLE (`platform`/`home`/`nodeExe`/
 * `binJs` on `plan()`, and `run` -- the thing that actually executes a step --
 * on `install`/`uninstall`/`status`). Two reasons:
 *
 *   1. `plan()` used to read `process.platform` directly, so a test suite
 *      running on Windows could only ever construct and verify the Windows
 *      shape -- the systemd and launchd plans, and their path-quoting, went
 *      completely unexercised on a Windows CI runner.
 *   2. `child_process.spawnSync` used to be destructured at module load
 *      (`const { spawnSync } = require('child_process')`), so a test that
 *      monkey-patched `require('child_process').spawnSync` AFTER this module
 *      was first required was patching a reference this module never reads
 *      again -- the spy silently did nothing, which is how a real
 *      service-manager command ran during what looked like a mocked test.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NODE_EXE = process.execPath;
// Resolves through symlinks (Node's default, non-preserveSymlinks module
// resolution), so this is the real checkout path even when squad-hub was
// installed with `npm link` -- never the temporary symlink location.
const BIN_JS = path.join(__dirname, '..', 'bin', 'squad-hub.js');

const TASK_NAME = 'SquadHubStartup';
const SYSTEMD_UNIT = 'squad-hub.service';
const LAUNCHAGENT_LABEL = 'dev.squadhub.startup';

/**
 * The one command line every platform ultimately runs. Built as the literal
 * string each service manager wants -- Task Scheduler's `/tr` -- rather than
 * through a shell, so a space in either path (a OneDrive-synced checkout,
 * `Program Files`) cannot break the quoting.
 */
function windowsCommandLine(nodeExe, binJs) {
  // schtasks /tr wants ONE string for the whole command line. A path with
  // spaces needs its own quotes INSIDE the ones schtasks itself requires --
  // the classic Windows task-scheduler quoting, verified against a real
  // `Program Files` install.
  return `\"${nodeExe}\" \"${binJs}\" start`;
}

/**
 * Quote one ExecStart= argument the way systemd (>= 243) actually parses it:
 * unit-file assignments are split on whitespace using shell-like quoting, so
 * an unquoted path containing a space would be read as TWO arguments --
 * silently breaking the unit the moment `nodeExe` or `binJs` lives under a
 * directory with a space in it (`C:\Program Files\nodejs\node.exe` is a
 * realistic value on a Windows-hosted WSL/dev setup; `/home/A User/...` is
 * just as real on Linux). Wrapping every argument in double quotes -- and
 * escaping any literal backslash or double quote already inside it -- keeps
 * each argument as exactly one token, with no shell in the loop to
 * reinterpret it.
 */
function systemdQuoteArg(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Everything that would touch the machine, described but not yet done. One
 * function every command (install/uninstall/status, real or --dry-run) reads
 * from, so there is exactly one place that knows the platform-specific
 * shape.
 *
 * `platform`/`home`/`nodeExe`/`binJs` default to the REAL values but are all
 * overridable, so a test running on any one OS can construct and verify the
 * Windows, Linux, macOS, AND unsupported plans -- including a node/bin/home
 * path that contains a space -- without needing three machines.
 */
function plan({ platform = process.platform, home = os.homedir(), nodeExe = NODE_EXE, binJs = BIN_JS } = {}) {
  if (platform === 'win32') {
    return {
      platform,
      supported: true,
      kind: 'Windows Task Scheduler',
      install: { command: 'schtasks', args: ['/create', '/tn', TASK_NAME, '/tr', windowsCommandLine(nodeExe, binJs), '/sc', 'onlogon', '/rl', 'limited', '/f'] },
      uninstall: { command: 'schtasks', args: ['/delete', '/tn', TASK_NAME, '/f'] },
      status: { command: 'schtasks', args: ['/query', '/tn', TASK_NAME, '/fo', 'list'] },
    };
  }

  if (platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user');
    const file = path.join(dir, SYSTEMD_UNIT);
    const contents = [
      '[Unit]',
      'Description=Squad Hub device daemon startup',
      '',
      '[Service]',
      'Type=oneshot',
      `ExecStart=${systemdQuoteArg(nodeExe)} ${systemdQuoteArg(binJs)} start`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return {
      platform,
      supported: true,
      kind: 'systemd user unit',
      file, dir, contents,
      install: { command: 'systemctl', args: ['--user', 'enable', '--now', SYSTEMD_UNIT] },
      uninstall: { command: 'systemctl', args: ['--user', 'disable', '--now', SYSTEMD_UNIT] },
      status: { command: 'systemctl', args: ['--user', 'status', SYSTEMD_UNIT] },
      note: 'requires `loginctl enable-linger $USER` to start before a graphical login on some distros',
    };
  }

  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    const file = path.join(dir, `${LAUNCHAGENT_LABEL}.plist`);
    const contents = `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
      + `<plist version="1.0">\n<dict>\n`
      + `  <key>Label</key><string>${LAUNCHAGENT_LABEL}</string>\n`
      + `  <key>ProgramArguments</key>\n  <array>\n`
      + `    <string>${nodeExe}</string>\n    <string>${binJs}</string>\n    <string>start</string>\n`
      + `  </array>\n`
      + `  <key>RunAtLoad</key><true/>\n`
      + `</dict>\n</plist>\n`;
    return {
      platform,
      supported: true,
      kind: 'macOS LaunchAgent',
      file, dir, contents,
      // `load -w` / `unload -w` (rather than the newer bootstrap/bootout)
      // stay the choice here: bootstrap/bootout address a specific domain
      // target (`gui/<uid>`) that has to be looked up at runtime, while
      // `load -w`/`unload -w` on a LaunchAgent plist need nothing beyond the
      // file path and remain correct on every currently supported macOS
      // version. `install`/`uninstall` below tolerate the "already loaded" /
      // "not loaded" replies these give on a second run -- see
      // `isIdempotentMacResult`.
      install: { command: 'launchctl', args: ['load', '-w', file] },
      uninstall: { command: 'launchctl', args: ['unload', '-w', file] },
      status: { command: 'launchctl', args: ['list', LAUNCHAGENT_LABEL] },
    };
  }

  return { platform, supported: false, reason: `no login-startup mechanism is implemented for ${platform}` };
}

/**
 * `launchctl load -w` / `unload -w` exit nonzero when the LaunchAgent is
 * already (or no longer) loaded -- a real, expected state, not a failure,
 * and the SECOND `install-service`/`uninstall-service` run on a machine hits
 * it every time. Recognizing that specific, well-known reply as success is
 * what makes install/uninstall idempotent on macOS, the same way `/f` does
 * for Task Scheduler and `enable --now`/`disable --now` already are for
 * systemd. This cannot be verified against a real macOS box from this
 * (Windows) machine; the patterns below are a best-effort match against
 * `launchctl`'s documented/observed wording and are exercised here only
 * through an injected fake `run` result.  Any OTHER nonzero exit (a bad
 * plist, a permissions problem) still reports failure.
 */
function isIdempotentMacResult(result) {
  const text = `${result.stdout || ''} ${result.stderr || ''}`.toLowerCase();
  return /already loaded|service already loaded|no such process|not loaded|could not find specified service/.test(text);
}

function runStep(step) {
  const r = spawnSync(step.command, step.args, { encoding: 'utf8', windowsHide: true });
  return { command: step.command, args: step.args, status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), error: r.error ? r.error.message : null };
}

/**
 * `dryRun: true` never touches disk or spawns a service-manager command --
 * it returns exactly what WOULD happen, so a test can assert on it without
 * installing a real login task on the machine running the suite. That early
 * return is checked FIRST, before `run` is ever referenced, so a caller that
 * injects a poisoned `run` (one that throws if ever invoked, specifically to
 * prove this point in a test) never sees it called.
 *
 * `run` is the thing that actually executes one plan step -- defaulted to
 * the real `runStep` (a thin `spawnSync` wrapper), but overridable so a test
 * can exercise the REAL (non-dry-run) install/uninstall/status code path --
 * including which platform branch runs and the exact command it would issue
 * -- without ever invoking a real `schtasks`/`systemctl`/`launchctl`.
 */
function install({ dryRun = false, run = runStep, platform, home, nodeExe, binJs } = {}) {
  const p = plan({ platform, home, nodeExe, binJs });
  if (!p.supported) return { ok: false, supported: false, platform: p.platform, reason: p.reason };

  if (dryRun) return { ok: true, dryRun: true, ...p };

  if (p.file) {
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.file, p.contents);
  }
  const result = run(p.install);
  const ok = (result.status === 0 && !result.error) || (p.platform === 'darwin' && isIdempotentMacResult(result));
  return { ok, dryRun: false, ...p, result };
}

function uninstall({ dryRun = false, run = runStep, platform, home, nodeExe, binJs } = {}) {
  const p = plan({ platform, home, nodeExe, binJs });
  if (!p.supported) return { ok: false, supported: false, platform: p.platform, reason: p.reason };

  if (dryRun) return { ok: true, dryRun: true, ...p };

  // Idempotent: run the removal command even if it is already gone, and treat
  // "was not installed" as success rather than failure -- uninstalling twice
  // must not be an error. On macOS, `unload -w` on an agent that is not
  // currently loaded is exactly this case, folded into the same unconditional
  // `ok: true` rather than needing its own branch.
  const result = run(p.uninstall);
  if (p.file) { try { fs.unlinkSync(p.file); } catch { /* already gone */ } }
  return { ok: true, dryRun: false, ...p, result };
}

function status({ dryRun = false, run = runStep, platform, home, nodeExe, binJs } = {}) {
  const p = plan({ platform, home, nodeExe, binJs });
  if (!p.supported) return { ok: false, supported: false, installed: false, platform: p.platform, reason: p.reason };
  if (dryRun) return { ok: true, dryRun: true, ...p };

  const result = run(p.status);
  const fileExists = p.file ? fs.existsSync(p.file) : null;
  const installed = result.status === 0 || fileExists === true || (p.platform === 'darwin' && isIdempotentMacResult(result));
  return { ok: true, dryRun: false, installed, ...p, result };
}

module.exports = {
  plan, install, uninstall, status, runStep, isIdempotentMacResult, systemdQuoteArg,
  TASK_NAME, SYSTEMD_UNIT, LAUNCHAGENT_LABEL, NODE_EXE, BIN_JS,
};
