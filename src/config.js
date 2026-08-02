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
});

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.config(), 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(cfg) {
  paths.ensureHome();
  const merged = { ...DEFAULTS, ...cfg };
  fs.writeFileSync(paths.config(), JSON.stringify(merged, null, 2));
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
  };
}

module.exports = { DEFAULTS, read, write, update, reset, publicView };
