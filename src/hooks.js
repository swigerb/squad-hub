'use strict';

/**
 * The Copilot CLI hooks that let a real TUI session tell the hub about itself.
 *
 * WHY THIS EXISTS. The hub supervises a session by speaking ACP over the
 * agent's stdio, and the Copilot TUI wants that same stdio for its interface.
 * One process cannot serve both. Hooks are a different channel entirely --
 * Copilot runs a command of our choosing at points in the session's life -- so
 * a session can register itself without giving up its terminal.
 *
 * WHY INSTALLING IS A DELIBERATE ACT. A user-level hook file applies to EVERY
 * Copilot session on this machine, including ones that have nothing to do with
 * Squad. Installing it quietly on first run would mean a tool the user chose
 * for one project silently inserting itself into all of their work. So it is
 * installed only when asked for, removable in one command, and reported by
 * `squad-hub doctor`.
 *
 * WHY THE HOOK IS A THIN SHIM. Each entry runs `squad-hub hook <event>`, which
 * reads the payload on stdin and talks to the local daemon. Keeping the logic
 * in the CLI rather than in shell embedded in JSON means it can be tested, and
 * that a change ships with an upgrade instead of requiring every user to
 * rewrite a config file by hand.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');

/** Our file, named so it is obvious who owns it and safe to delete. */
const HOOK_FILE = 'squad-hub.json';

/**
 * Copilot's user-level hooks directory.
 *
 * `COPILOT_HOME` wins when set, which is what Copilot itself honours -- and it
 * is how this can be exercised in a test without touching the real one.
 */
function hooksDir(env = process.env) {
  const home = env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  return path.join(home, 'hooks');
}

function hookPath(env = process.env) {
  return path.join(hooksDir(env), HOOK_FILE);
}

/**
 * The events we ask Copilot to tell us about, and what each is for.
 *
 * `sessionStart` / `sessionEnd` are the registration pair: they are what makes
 * a terminal session visible at all. The rest describe what it is DOING, so the
 * hub shows a live session rather than a name and a start time.
 *
 * Keeping the list here means the installed file and the code that answers it
 * cannot drift apart, and `hooks status` can tell a stale file from a current
 * one by comparing against it.
 */
const EVENTS = [
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'postToolUse',
  'agentStop',
  'preToolUse',
];

/**
 * How long Copilot waits for each hook before giving up on it.
 *
 * Notifications get five seconds: they are fire-and-forget, hooks run
 * SYNCHRONOUSLY, and a wedged daemon should cost a noticeable pause rather than
 * a hang.
 *
 * `preToolUse` gets far longer, because a person may be reaching for their
 * phone. The number matters more than it looks: if COPILOT gives up first, the
 * hook produces no output, and no output falls through to the session's normal
 * permission handling -- which in a session started with --allow-all-tools
 * means the tool simply runs. So this must stay comfortably ABOVE the daemon's
 * own wait (SQUAD_HUB_HOOK_APPROVAL_TIMEOUT_MS, 120s by default), leaving the
 * daemon to answer "ask" first. 300s was measured as honoured.
 */
const TIMEOUTS = {
  preToolUse: 300,
  // Must exceed the hook shim's own IPC timeout for this event (8s, see
  // cli.js's `cmdHook`), which itself must exceed the daemon's bounded steer
  // hold (3s default, paid only on a watched session). 15s leaves comfortable
  // room above both without approaching preToolUse's budget.
  agentStop: 15,
  default: 5,
};

/**
 * Build the hook configuration.
 *
 * `timeoutSec` is deliberately short for these events. They are fire-and-forget
 * notifications, and Copilot runs hooks SYNCHRONOUSLY -- a slow one stalls the
 * session. Five seconds is far longer than a local socket write needs and short
 * enough that a wedged daemon costs a noticeable pause rather than a hang.
 *
 * @param {string} command  how to invoke this CLI (absolute, so PATH is not a
 *                          dependency of somebody else's session starting)
 */
function buildHookConfig(command) {
  const entry = (event) => ({
    type: 'command',
    // Both are given so the same file works whichever platform reads it.
    //
    // The PowerShell form needs the call operator. Without `&`, PowerShell
    // treats a quoted path as a STRING EXPRESSION and evaluates it to itself --
    // no error, no process, and a hook that appears to be installed and does
    // nothing at all. That failure is silent by construction, which is exactly
    // why it is worth a comment.
    bash: `${command} hook ${event}`,
    powershell: `& ${command} hook ${event}`,
    timeoutSec: TIMEOUTS[event] || TIMEOUTS.default,
  });

  const hooks = {};
  for (const e of EVENTS) hooks[e] = [entry(e)];
  return { version: 1, hooks };
}

/**
 * How to invoke this CLI from a hook.
 *
 * Absolute, via the running node and this package's own entry point, because a
 * hook runs in whatever environment the user's shell happens to have. Relying
 * on `squad-hub` being on PATH would make an unrelated Copilot session fail to
 * start on a machine where it is not.
 */
function selfCommand() {
  const bin = path.join(__dirname, '..', 'bin', 'squad-hub.js');
  return `"${process.execPath}" "${bin}"`;
}

/**
 * Is our hook installed, and is it the one this version would write?
 *
 * `current: false` matters as much as `installed: false`: a file left by an
 * older version can be missing events this build relies on, and reporting it as
 * simply "installed" would hide that.
 */
function status(env = process.env) {
  const file = hookPath(env);
  if (!fs.existsSync(file)) {
    return { installed: false, current: false, path: file, events: [] };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {
      installed: true, current: false, path: file, events: [], error: `unreadable: ${e.message}`,
    };
  }
  const events = Object.keys((parsed && parsed.hooks) || {});
  const missing = EVENTS.filter((e) => !events.includes(e));
  return {
    installed: true,
    current: missing.length === 0,
    path: file,
    events,
    missing,
  };
}

/**
 * Write the hook file.
 *
 * Refuses to overwrite a file we did not write, unless told to. Somebody may
 * legitimately keep their own hooks in that directory, and silently replacing
 * one would be indistinguishable from losing it.
 */
function install({ env = process.env, force = false, command = null } = {}) {
  const dir = hooksDir(env);
  const file = hookPath(env);

  if (fs.existsSync(file) && !force) {
    let mine = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      mine = !!(parsed && parsed.hooks);
    } catch { mine = false; }
    if (!mine) {
      return {
        ok: false,
        reason: `${file} already exists and is not readable as a hook file; move it aside, or pass --force`,
      };
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  const config = buildHookConfig(command || selfCommand());
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { ok: true, path: file, events: EVENTS };
}

/**
 * Remove the hook file.
 *
 * Removing something already absent is reported as `removed: false` rather than
 * as an error -- the caller asked for a state, and that state now holds.
 */
function remove(env = process.env) {
  const file = hookPath(env);
  if (!fs.existsSync(file)) return { ok: true, removed: false, path: file };
  fs.unlinkSync(file);
  return { ok: true, removed: true, path: file };
}

/**
 * Sessions this hub is actually supervising, recorded on disk.
 *
 * WHY THIS EXISTS. The hook file is user-level: it runs for EVERY Copilot
 * session on the machine, including ones that have nothing to do with Squad.
 * When the daemon cannot be reached, `preToolUse` has to answer something, and
 * answering "ask" for a session nobody was ever watching is the worst of both
 * worlds -- it adds a permission prompt to every tool call in every project,
 * forever, while supervising precisely nothing. It is MORE restrictive than not
 * installing the hooks at all, which is not a trade anybody agreed to.
 *
 * So the rule is: interpose only on sessions the hub is genuinely supervising.
 *
 *   supervised, daemon reachable    -> the hub decides
 *   supervised, daemon unreachable  -> "ask", because supervision was expected
 *                                      and is now gone; never "allow"
 *   not supervised                  -> say nothing, and let Copilot's own
 *                                      permission handling do its job
 *
 * The marker is written only when registration actually succeeded, so "was
 * this supervised" is answered by evidence rather than by assuming the daemon
 * that is currently unreachable was once up.
 */

/** Where the markers live -- squad-hub's own directory, not Copilot's. */
function supervisedDir() {
  return path.join(paths.home(), 'supervised');
}

function supervisedPath(sessionId) {
  // Session ids come from Copilot and are uuids, but this value reaches a file
  // path, so anything that is not plainly safe is refused rather than escaped.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(sessionId || ''))) return null;
  return path.join(supervisedDir(), String(sessionId));
}

/** Record that the hub accepted responsibility for this session. */
function markSupervised(sessionId) {
  const file = supervisedPath(sessionId);
  if (!file) return false;
  try {
    fs.mkdirSync(supervisedDir(), { recursive: true });
    fs.writeFileSync(file, new Date().toISOString(), 'utf8');
    return true;
  } catch {
    // Best effort. A marker that could not be written means the next tool call
    // falls through to Copilot's own handling, which is the safe direction:
    // it does not invent supervision that is not there.
    return false;
  }
}

function isSupervised(sessionId) {
  const file = supervisedPath(sessionId);
  if (!file) return false;
  try { return fs.existsSync(file); } catch { return false; }
}

function clearSupervised(sessionId) {
  const file = supervisedPath(sessionId);
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

module.exports = {
  HOOK_FILE,
  EVENTS,
  TIMEOUTS,
  hooksDir,
  hookPath,
  buildHookConfig,
  selfCommand,
  status,
  install,
  remove,
  supervisedDir,
  markSupervised,
  isSupervised,
  clearSupervised,
};
