'use strict';
/**
 * Which Copilot custom agent (and optional model) a session should run.
 *
 * A Squad project should not need a flag to get the Squad agent -- that is the
 * whole point of the front door in `squad-hub squad`. So detection happens
 * once, per session, from the working directory the session will actually run
 * in, and the result travels with the session rather than being decided once
 * for the whole daemon.
 *
 * PRECEDENCE, most specific first:
 *   1. an explicit --agent (and --model) flag
 *   2. `.squad-hub.json` in the project (agent/model only -- never credentials)
 *   3. Squad auto-detect: `.squad/` or `.github/agents/squad.agent.md`
 *   4. Copilot's own default agent
 *
 * `.squad-hub.json` deliberately cannot carry a hub URL or a token. Per-user
 * credentials belong in `~/.squad-hub/config.json`; a file that ships inside a
 * repository must not be able to point a session at somebody else's hub.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_AGENT = 'default';

/**
 * Agent/model names that survive selection, whether they came from a
 * project's `.squad-hub.json` or an explicit `--agent`/`--model` flag. Both
 * ultimately become `spawn()` argv (see `buildAgentArgs`) AND get rendered as
 * plain text in the web hub (see `web/app.js`'s `sessionRow`) -- the latter is
 * why this exists at all: a project config committed to a repository is
 * attacker-influenceable (anyone who can open a pull request can edit it),
 * and its `agent`/`model` fields must never be trusted as free-form content
 * just because `buildAgentArgs` itself is already argv-safe.
 *
 * Deliberately permissive enough for every real agent/model id in the wild
 * (custom agent names, `claude-sonnet-5`, `gpt-4o`, `claude-opus-4.8`, ...)
 * while rejecting the shapes that make an HTML/script payload possible:
 * angle brackets, quotes, spaces, and anything else outside a plain
 * identifier charset. Length-capped so nothing absurd rides along either.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function isValidName(s) {
  return typeof s === 'string' && NAME_RE.test(s);
}

/**
 * A short, terminal-safe rendering of a REJECTED value for a warning
 * message: control characters stripped (one could otherwise rewrite the
 * terminal line it is printed on) and length-capped (so one hostile value
 * cannot flood the console). This is plain-text CLI/log output, not HTML --
 * unlike the web hub, there is no `esc()` step here, so this stays a
 * preview, never a place any of this is re-interpreted as markup.
 */
function safePreview(s, max = 60) {
  const cleaned = String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}\u2026` : cleaned;
}

/**
 * Walk from `startDir` upward through each ancestor directory, stopping at
 * the first one `hasMarker` reports true for. A `.git` entry (a directory
 * for a normal clone, or a file for a worktree/submodule) marks the nearest
 * repository boundary: that directory is still checked itself, but its
 * parent never is. Without that boundary, a Squad marker or a
 * `.squad-hub.json` sitting in some unrelated ancestor folder -- e.g. a
 * parent directory that happens to hold many other checkouts -- would be
 * silently picked up just because nobody asked "is this even the same
 * repository".
 *
 * The user's home directory is a second, harder boundary: it is where every
 * unrelated project on the machine lives side by side, so reaching it as an
 * ANCESTOR (not the literal starting directory) stops the walk without ever
 * inspecting it. This is not a hypothetical: a scratch directory nested a
 * few levels under a real home directory that happens to carry its own,
 * unrelated Squad-framework configuration (e.g. `~/.squad/`, `~/.github/`)
 * would otherwise be falsely detected as belonging to that unrelated
 * project. If the caller's `startDir` genuinely IS the home directory, it is
 * still checked directly (matching plain single-directory behaviour), but
 * the walk never continues past it either way.
 *
 * If neither boundary is ever reached (e.g. `startDir` is not under the
 * home directory at all, and no `.git` is found), the walk continues all
 * the way to the filesystem root as a last resort, so a marker a few plain
 * directories up (no repo, no relevant home tree) still works the way it
 * always has.
 *
 * Returns the matching directory, or null if nothing matched before a
 * boundary (or the filesystem root) was reached.
 */
function walkUpForMarker(startDir, hasMarker) {
  if (!startDir) return null;
  let dir;
  try { dir = path.resolve(startDir); } catch { return null; }
  let home = null;
  try { home = path.resolve(os.homedir()); } catch { /* no home directory available in this environment */ }
  const sameDir = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

  let atStart = true;
  for (;;) {
    const isHome = home !== null && sameDir(dir, home);
    if (isHome && !atStart) return null; // never climb past the home directory to inherit a marker from it
    if (hasMarker(dir)) return dir;
    if (isHome) return null; // checked the home directory itself (only possible when atStart); never go further
    let isRepoBoundary = false;
    try { isRepoBoundary = fs.existsSync(path.join(dir, '.git')); } catch { /* treat as not a boundary */ }
    if (isRepoBoundary) return null; // repo root checked and had no marker; never leak into its parent
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root reached
    dir = parent;
    atStart = false;
  }
}

function hasSquadMarker(dir) {
  try { if (fs.statSync(path.join(dir, '.squad')).isDirectory()) return true; } catch { /* not present */ }
  try { if (fs.statSync(path.join(dir, '.github', 'agents', 'squad.agent.md')).isFile()) return true; } catch { /* not present */ }
  return false;
}

/**
 * Is this working directory (or the nearest ancestor up to the repository
 * or filesystem boundary) a Squad project? A session started from
 * `src/deeper` inside a Squad repo must still auto-detect Squad -- nobody
 * runs `squad-hub squad` from the exact repo root every time.
 */
function isSquadProject(cwd) {
  if (!cwd) return false;
  return walkUpForMarker(cwd, hasSquadMarker) !== null;
}

function hasProjectConfigFile(dir) {
  try { return fs.statSync(path.join(dir, '.squad-hub.json')).isFile(); } catch { return false; }
}

/**
 * `.squad-hub.json` project config. Only `agent` and `model` are recognised --
 * anything else is ignored rather than trusted, since this file ships with the
 * repository and a stranger's pull request can edit it.
 *
 * Resolved the same way Squad auto-detection is: the nearest ancestor of
 * `cwd` (up to the repository or filesystem boundary) that actually has the
 * file, so a session started from a subdirectory still picks up the
 * project's config rather than silently ignoring it.
 *
 * Never throws: a malformed file degrades to "no project config", with the
 * problem reported as a warning rather than taking the session down.
 */
function readProjectConfig(cwd) {
  if (!cwd) return { agent: null, model: null, warnings: [] };
  const root = walkUpForMarker(cwd, hasProjectConfigFile);
  if (!root) return { agent: null, model: null, warnings: [] };
  const file = path.join(root, '.squad-hub.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { agent: null, model: null, warnings: [] }; }

  const warnings = [];
  let json;
  try { json = JSON.parse(raw); } catch (e) {
    return { agent: null, model: null, warnings: [`.squad-hub.json is not valid JSON: ${e.message}`] };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { agent: null, model: null, warnings: ['.squad-hub.json must be a JSON object'] };
  }

  let agent = null;
  let model = null;
  if (json.agent !== undefined) {
    if (typeof json.agent !== 'string' || !json.agent.trim()) {
      warnings.push('.squad-hub.json: "agent" must be a non-empty string; ignored');
    } else if (!isValidName(json.agent.trim())) {
      warnings.push(`.squad-hub.json: "agent" ("${safePreview(json.agent.trim())}") is not a valid name (letters, digits, '.', '_', '-' only, starting with a letter or digit, up to 64 characters); ignored, falling back to the next source`);
    } else {
      agent = json.agent.trim();
    }
  }
  if (json.model !== undefined) {
    if (typeof json.model !== 'string' || !json.model.trim()) {
      warnings.push('.squad-hub.json: "model" must be a non-empty string; ignored');
    } else if (!isValidName(json.model.trim())) {
      warnings.push(`.squad-hub.json: "model" ("${safePreview(json.model.trim())}") is not a valid name (letters, digits, '.', '_', '-' only, starting with a letter or digit, up to 64 characters); ignored, falling back to the next source`);
    } else {
      model = json.model.trim();
    }
  }
  // Credentials do not belong here. Flagged, not silently dropped, so a
  // misplaced field is visible rather than mysteriously ignored.
  for (const key of ['hub', 'server', 'token', 'hubUrl', 'hubToken']) {
    if (json[key] !== undefined) warnings.push(`.squad-hub.json: "${key}" is ignored -- credentials and hub URLs are per-user, not per-project (see squad-hub connect)`);
  }

  return { agent, model, warnings };
}

/**
 * The modes a session can run in.
 *
 * An allow-list rather than a name pattern, because unlike an agent or a model
 * this is a CLOSED set: the agent advertises exactly these three and anything
 * else is a mistake, not an unknown-but-plausible value. Validating it as a
 * name would let `--mode anything` through to be silently ignored later.
 */
const MODES = ['agent', 'plan', 'autopilot'];

/**
 * Decide agent + model + mode for a session, and say WHY -- 'explicit' |
 * 'project' | 'auto' | 'default' -- so a status line or `squad-hub doctor` can
 * show the reason, not just the result.
 */
function selectAgent({
  cwd, explicitAgent, explicitModel, explicitMode,
} = {}) {
  const squad = isSquadProject(cwd);
  const proj = readProjectConfig(cwd);
  const warnings = [...proj.warnings];

  // Explicit CLI flags are still attacker-influenceable wherever a caller
  // constructs argv from external input (e.g. a hub relaying a start
  // request) rather than a human typing it directly -- validated the same
  // way as project config, with the same warn-and-fall-back-a-rung
  // behaviour rather than a hard error.
  let agent = explicitAgent || null;
  if (agent && !isValidName(agent)) {
    warnings.push(`--agent "${safePreview(agent)}" is not a valid name (letters, digits, '.', '_', '-' only, starting with a letter or digit, up to 64 characters); ignored, falling back to the next source`);
    agent = null;
  }
  let model = explicitModel || null;
  if (model && !isValidName(model)) {
    warnings.push(`--model "${safePreview(model)}" is not a valid name (letters, digits, '.', '_', '-' only, starting with a letter or digit, up to 64 characters); ignored, falling back to the next source`);
    model = null;
  }
  // The mode never comes from project config. It decides how much a person is
  // asked before a tool runs, and that is a choice for whoever is running the
  // session -- not something a checked-out repository gets to set for them.
  let mode = explicitMode ? String(explicitMode).toLowerCase() : null;
  if (mode && !MODES.includes(mode)) {
    warnings.push(`--mode "${safePreview(explicitMode)}" is not a mode (${MODES.join(', ')}); ignored, running the agent's default`);
    mode = null;
  }

  if (agent) {
    return {
      agent, model: model || proj.model || null, mode, source: 'explicit', isSquad: squad, warnings,
    };
  }
  if (proj.agent) {
    return {
      agent: proj.agent, model: model || proj.model || null, mode, source: 'project', isSquad: squad, warnings,
    };
  }
  if (squad) {
    return {
      agent: 'squad', model: model || proj.model || null, mode, source: 'auto', isSquad: true, warnings,
    };
  }
  return {
    agent: DEFAULT_AGENT, model: model || proj.model || null, mode, source: 'default', isSquad: false, warnings,
  };
}

/**
 * Turn a selection into the extra argv Copilot CLI needs, appended to
 * whatever base args the daemon already spawns with (normally `--acp`).
 *
 * Built as an ARRAY, never a shell string -- `--agent` and `--model` values
 * pass straight through to `spawn()`'s argv, with no shell to reinterpret a
 * quote or a space.
 */
function buildAgentArgs(baseArgs, selection) {
  const args = [...baseArgs];
  if (selection && selection.agent && selection.agent !== DEFAULT_AGENT) {
    args.push('--agent', selection.agent);
  }
  if (selection && selection.model) {
    args.push('--model', selection.model);
  }
  return args;
}

module.exports = {
  DEFAULT_AGENT, MODES, isSquadProject, readProjectConfig, selectAgent, buildAgentArgs, walkUpForMarker,
};
