'use strict';
/**
 * Persisted daemon configuration.
 *
 * File access is OFF by default and the confinement root NEVER leaves the
 * device -- the heartbeat reports whether file access is on and whether it is
 * scoped, never the path itself. A control plane that learns your directory
 * layout by default is a control plane that leaks it.
 */

const fs = require('fs');
const paths = require('./paths');

const DEFAULTS = Object.freeze({
  deviceName: null,          // null -> hostname at runtime
  deviceId: null,            // stable id so a restart re-attaches, not re-registers
  server: null,              // hub service URL, null -> local only
  token: null,               // hub bearer token
  trackAll: false,           // report every session, not just squad-hub ones
  allowFiles: false,         // expose any filesystem affordance at all
  allowFilesAll: false,      // lift confinement to the whole filesystem
  filesRoot: null,           // confinement root; LOCAL ONLY, never transmitted
  autoShutdown: false,       // exit after the last session ends
  autoShutdownGraceSeconds: 300,
  heartbeatSeconds: 15,
  staleAfterMissedBeats: 2,  // online -> stale
  offlineAfterMissedBeats: 4, // stale -> offline
  environments: Object.freeze({}), // named hub URLs for --env; NOT a pinned server
  reportTelemetry: false,    // CPU/RAM load; off by default, like file access
  deviceKind: 'local',       // 'local' or 'cloud'; decides roster placement
});

/**
 * A validated memo for `read()`.
 *
 * The daemon reads the config on every heartbeat and on every session start,
 * so the uncached path re-parses the same JSON from disk many times over the
 * life of a long-running process.
 *
 * The memo is keyed on the file's mtime and size, NOT merely on "we have read
 * it once". A blind process-lifetime cache would be wrong here: the CLI writes
 * the config from a DIFFERENT process to the daemon that reads it, so a daemon
 * holding a blind cache would keep serving settings the user had already
 * changed. Re-stat'ing costs a syscall and skips the read+parse, which is the
 * part worth avoiding.
 *
 * `--no-config-cache` bypasses even the stat, for a caller that wants the file
 * to be authoritative on every single read.
 */
let cache = null;      // { key, value }
let cacheEnabled = true;

function setCacheEnabled(on) {
  cacheEnabled = !!on;
  if (!cacheEnabled) cache = null;
  return cacheEnabled;
}

function invalidate() { cache = null; }

/**
 * An identity for the config file's current contents. `absent` is a real
 * state, not an error -- a machine that has never been configured reads the
 * defaults, and that answer is just as cacheable as any other.
 */
function stamp() {
  try {
    const st = fs.statSync(paths.config());
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}

function readFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.config(), 'utf8'));
    return { ...DEFAULTS, ...raw, environments: { ...DEFAULTS.environments, ...(raw.environments || {}) } };
  } catch {
    return { ...DEFAULTS, environments: { ...DEFAULTS.environments } };
  }
}

function read() {
  if (!cacheEnabled) return applyOverrides(readFromDisk());
  const key = stamp();
  if (!cache || cache.key !== key) cache = { key, value: readFromDisk() };
  // Hand out a copy: a caller that mutates what it was given must never be
  // able to edit the memo -- or every later reader inherits that mutation
  // without anything having been written to disk.
  return applyOverrides({ ...cache.value, environments: { ...cache.value.environments } });
}

/**
 * Settings this PROCESS runs with, which are never written to disk.
 *
 * A container configures itself from its environment on every start, so it has
 * nothing to persist -- and persisting anyway is how a diagnostic command
 * became a permanent change. `squad-hub oneshot` on a laptop used to rewrite
 * the real ~/.squad-hub: the device was renamed to `cloud (...)`, reclassified
 * as a cloud device, and -- the part that matters -- silently switched to
 * `allowFilesAll`, granting whole-filesystem access nobody had asked for. It
 * then outlived the command, because every later `squad-hub start` read it back.
 *
 * An override applies to the running process and disappears with it.
 */
let overrides = null;

function setOverrides(patch) {
  overrides = patch ? { ...patch } : null;
  return read();
}

function applyOverrides(cfg) {
  return overrides ? { ...cfg, ...overrides } : cfg;
}

function write(cfg) {
  paths.ensureHome();
  const merged = { ...DEFAULTS, ...cfg, environments: { ...DEFAULTS.environments, ...(cfg.environments || {}) } };
  fs.writeFileSync(paths.config(), JSON.stringify(merged, null, 2));
  // The file just moved underneath us; re-stamp rather than assume, so the very
  // next read cannot be served a memo keyed on the PREVIOUS file.
  cache = cacheEnabled ? { key: stamp(), value: merged } : null;
  return merged;
}

function update(patch) {
  return write({ ...read(), ...patch });
}

/**
 * Factory defaults. Keeps the device name, drops everything else -- including
 * file access, which resets to off unless the caller re-enables it in the same
 * breath.
 */
function reset(opts = {}) {
  const current = read();
  // Identity survives a reset; everything else returns to factory. Regenerating
  // the device id would make one machine appear as two.
  const next = { ...DEFAULTS, deviceName: current.deviceName, deviceId: current.deviceId };
  if (opts.allowFilesAll) {
    next.allowFiles = true;
    next.allowFilesAll = true;
    next.filesRoot = null;
  } else if (opts.allowFiles) {
    next.allowFiles = true;
    next.allowFilesAll = false;
    next.filesRoot = opts.filesRoot || process.cwd();
  }
  return write(next);
}

/**
 * The subset of config that is safe to send to a hub service.
 * Note what is absent: filesRoot. Deliberately.
 */
function publicView(cfg = read()) {
  return {
    trackAll: cfg.trackAll,
    fileAccess: cfg.allowFiles ? (cfg.allowFilesAll ? 'all' : 'scoped') : 'off',
    telemetry: !!cfg.reportTelemetry,
  };
}

/** The environment names `--env` accepts. */
const ENVIRONMENTS = Object.freeze(['prod', 'ppe']);

/**
 * The variable that overrides each environment.
 *
 * Spelled out rather than built from the name at runtime: a computed
 * `process.env[...]` is invisible to anything that greps the source, including
 * the docs test that proves every variable the code reads is documented.
 */
const ENVIRONMENT_VARS = Object.freeze({
  prod: 'SQUAD_HUB_PROD_URL',
  ppe: 'SQUAD_HUB_PPE_URL',
});

function environmentOverride(name) {
  if (name === 'prod') return process.env.SQUAD_HUB_PROD_URL || null;
  if (name === 'ppe') return process.env.SQUAD_HUB_PPE_URL || null;
  return null;
}

/**
 * Resolve a named environment to a hub URL.
 *
 * Squad Hub is self-hosted, so there is no vendor "prod" to hardcode -- and
 * baking one in would be both wrong and a private hostname in a public repo.
 * A name resolves through the environment first (so CI can point a run at a
 * hub without writing to the user's config) and then the persisted map.
 *
 * Returns null when the name is not configured. Callers treat that as a usage
 * error rather than silently falling back to local-only: someone who typed
 * `--env ppe` wants ppe, and quietly ignoring it is how work lands in prod.
 */
function resolveEnvironment(name, cfg = read()) {
  if (!ENVIRONMENTS.includes(name)) return null;
  const fromEnv = environmentOverride(name);
  if (fromEnv) return fromEnv;
  const envs = cfg.environments || {};
  return envs[name] || null;
}

module.exports = {
  DEFAULTS,
  ENVIRONMENTS,
  ENVIRONMENT_VARS,
  read,
  write,
  update,
  setOverrides,
  reset,
  publicView,
  resolveEnvironment,
  environmentOverride,
  setCacheEnabled,
  invalidate,
};
