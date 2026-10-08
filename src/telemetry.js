'use strict';
/**
 * Device telemetry: how busy this machine is.
 *
 * OFF BY DEFAULT, like every other thing this daemon could report about the
 * machine it runs on. A device roster that shows load is useful; a device
 * roster that starts reporting load without being asked is surveillance of
 * somebody's laptop. `squad-hub config enable-telemetry` turns it on.
 *
 * What is reported is deliberately narrow: two percentages and the machine's
 * total memory. No process list, no per-core detail, no hostname beyond the
 * device name that was already being sent, and nothing about what is running.
 *
 * CPU IS A DELTA, NOT AN INSTANT. `os.cpus()` reports cumulative time since
 * boot, so a single reading says what the machine has averaged since it
 * started -- which is almost never what anyone means by "CPU". Two readings a
 * heartbeat apart give the usage over that interval, which is what a meter
 * should show. The first sample therefore has no CPU figure at all, and says
 * so with null rather than inventing a zero.
 *
 * DISK (#173) HAS TWO GATES, NOT ONE. The caller (`daemon.js`) only calls
 * `diskSample` at all when `reportTelemetry` is on -- disk is a load meter
 * like CPU and RAM, and someone who has not opted into telemetry should not
 * start seeing storage figures either. On top of that, `diskSample` applies
 * its OWN narrower gate: a mount-point list says more about a machine's
 * directory layout than a CPU percentage ever could, so it follows file
 * access, the SAME confinement rule as every other filesystem affordance --
 * nothing when file access is off (even with telemetry on), one volume (the
 * workspace's own) when scoped, every usable volume only when file access is
 * deliberately unconfined. It is exported separately from `Telemetry#sample()`
 * rather than folded into it so that function's own contract -- "no process
 * list, no path, nothing about what is running" -- stays provably true; a
 * volume mount point is exactly the kind of fact that contract exists to
 * keep out.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Total and idle CPU time across all cores, in milliseconds. */
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus() || []) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

class Telemetry {
  constructor() {
    this._last = null;
  }

  /**
   * One reading.
   *
   * `cpu` is a fraction in [0, 1] over the interval since the previous call,
   * or null on the very first call and whenever no time has passed -- dividing
   * by a zero interval would produce Infinity or NaN and put it straight into
   * a meter.
   */
  sample() {
    const now = cpuTimes();
    const prev = this._last;
    this._last = now;

    let cpu = null;
    if (prev) {
      const totalDelta = now.total - prev.total;
      const idleDelta = now.idle - prev.idle;
      if (totalDelta > 0) {
        cpu = clamp01(1 - (idleDelta / totalDelta));
      }
    }

    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memUsed = Math.max(0, memTotal - memFree);

    return {
      cpu,
      mem: memTotal > 0 ? clamp01(memUsed / memTotal) : null,
      memUsedBytes: memUsed,
      memTotalBytes: memTotal,
      cores: (os.cpus() || []).length,
      at: Date.now(),
    };
  }
}

/**
 * Keep a fraction inside [0, 1].
 *
 * Not paranoia: cumulative CPU counters can go backwards across a suspend or a
 * clock adjustment, and a meter rendered from -0.3 or 1.4 draws outside its
 * own bar.
 */
function clamp01(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// Disk (#173): per-volume free/total, gated on file access rather than on
// telemetry alone -- see the module doc comment above for why.
// ---------------------------------------------------------------------------

/**
 * Node 18.15+ ships `fs.statfs`/`fs.statfsSync`. Feature-detected so an older
 * runtime gets back "no disk information" rather than a thrown exception on
 * every snapshot.
 */
function hasStatfs(fsMod = fs) {
  return typeof fsMod.statfsSync === 'function';
}

/**
 * One volume's usage, or `null` on anything `statfsSync` refuses -- a mount
 * a non-root user cannot stat, a drive letter with no media in it, a volume
 * that disappeared between being listed and being asked about.
 */
function statfsSafe(mountPath, fsMod = fs) {
  try {
    const st = fsMod.statfsSync(mountPath);
    const bsize = st.bsize || 0;
    const totalBytes = st.blocks * bsize;
    if (!(totalBytes > 0)) return null;
    const freeBytes = Math.max(0, Math.min(st.bavail * bsize, totalBytes));
    return { totalBytes, freeBytes };
  } catch {
    return null;
  }
}

/** A-Z, each tried as a drive root. Absent drive letters simply fail to stat. */
function listWindowsVolumes({ fsMod = fs } = {}) {
  const out = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const usage = statfsSafe(`${letter}:\\`, fsMod);
    if (!usage) continue;
    out.push({ label: `${letter}:`, mountPoint: `${letter}:\\`, ...usage });
  }
  return out;
}

/**
 * Filesystem types that are not storage at all -- a process table, a kernel
 * interface, a stacked view of another mount already listed once -- and so
 * would otherwise show up as phantom "volumes" with no disk behind them.
 */
const LINUX_PSEUDO_FS = new Set([
  'proc', 'sysfs', 'tmpfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2',
  'overlay', 'overlayfs', 'squashfs', 'autofs', 'mqueue', 'debugfs', 'tracefs',
  'securityfs', 'pstore', 'bpf', 'configfs', 'fusectl', 'hugetlbfs',
  'binfmt_misc', 'rpc_pipefs', 'nsfs', 'ramfs', 'efivarfs', 'fuse.portal',
]);

/** `/proc/mounts` escapes spaces (and a few other characters) as `\NNN` octal. */
function unescapeMountField(s) {
  return String(s || '').replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/** `device mountPoint fsType options dump pass`, one per line. */
function parseLinuxMounts(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    out.push({
      mountPoint: unescapeMountField(fields[1]),
      fsType: fields[2],
      options: fields[3].split(','),
    });
  }
  return out;
}

/**
 * Linux: every real mount, minus the two kinds that do not belong on a disk
 * meter -- a pseudo filesystem (see `LINUX_PSEUDO_FS`) and a read-only mount,
 * which can be stat'd and even be a real disk, but which nothing here could
 * ever free up space on.
 */
function listLinuxVolumes({ fsMod = fs, readMounts } = {}) {
  let raw;
  try {
    raw = readMounts ? readMounts() : fsMod.readFileSync('/proc/mounts', 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const m of parseLinuxMounts(raw)) {
    if (LINUX_PSEUDO_FS.has(m.fsType)) continue;
    if (m.options.includes('ro')) continue;
    const usage = statfsSafe(m.mountPoint, fsMod);
    if (!usage) continue;
    out.push({ label: m.mountPoint, mountPoint: m.mountPoint, ...usage });
  }
  return out;
}

/**
 * macOS: every entry under `/Volumes` -- which, on a modern mac, includes the
 * boot volume itself via its own named symlink. A machine old or configured
 * oddly enough that nothing appears there still gets its root volume, labeled
 * generically, rather than reporting no storage at all.
 */
function listMacVolumes({ fsMod = fs, readdir } = {}) {
  let entries = [];
  try {
    entries = readdir ? readdir() : fsMod.readdirSync('/Volumes');
  } catch {
    entries = [];
  }
  const out = [];
  for (const name of entries) {
    const mountPoint = path.posix.join('/Volumes', name);
    const usage = statfsSafe(mountPoint, fsMod);
    if (!usage) continue;
    out.push({ label: name, mountPoint, ...usage });
  }
  if (!out.length) {
    const usage = statfsSafe('/', fsMod);
    if (usage) out.push({ label: 'Macintosh HD', mountPoint: '/', ...usage });
  }
  return out;
}

/** Every volume this platform knows how to enumerate, or `[]` without `statfs`. */
function listVolumes(opts = {}) {
  const fsMod = opts.fsMod || fs;
  if (!hasStatfs(fsMod)) return [];
  const platform = opts.platform || process.platform;
  if (platform === 'win32') return listWindowsVolumes({ fsMod });
  if (platform === 'darwin') return listMacVolumes({ fsMod, readdir: opts.readdir });
  return listLinuxVolumes({ fsMod, readMounts: opts.readMounts });
}

/**
 * Which listed volume a path actually lives on.
 *
 * Windows decides it outright from the drive letter; Linux and macOS take
 * the longest matching mount-point prefix, because `/` and `/home` can both
 * claim `/home/you/project` and the more specific one is the real answer.
 */
function volumeContaining(volumes, targetPath, platform = process.platform) {
  if (!targetPath || !volumes.length) return null;
  if (platform === 'win32') {
    const letter = `${String(targetPath)[0] || ''}`.toUpperCase();
    if (!letter) return null;
    return volumes.find((v) => v.label.toUpperCase() === `${letter}:`) || null;
  }
  let best = null;
  const target = String(targetPath);
  for (const v of volumes) {
    const mp = v.mountPoint === '/' ? '/' : v.mountPoint.replace(/\/+$/, '');
    const matches = target === mp || target.startsWith(`${mp === '/' ? '' : mp}/`);
    if (matches && (!best || mp.length > best._mp.length)) best = { ...v, _mp: mp };
  }
  if (!best) return null;
  delete best._mp;
  return best;
}

/**
 * Disk usage for whatever volumes this daemon is allowed to admit exist.
 *
 * `cfg` is the same shape `src/config.js` reads and writes: `allowFiles`,
 * `allowFilesAll` and `filesRoot` decide the scope exactly as they do for
 * every other filesystem affordance.
 *
 *   - File access off           -> `null` (no storage reported at all)
 *   - Scoped (`filesRoot` set)  -> the ONE volume containing that root,
 *                                  marked `workspace: true`
 *   - Unscoped (`allowFilesAll`)-> every usable volume this platform has
 *
 * `opts` exists purely so tests can inject a platform, a fake `fs`, and a
 * fake `/proc/mounts` without needing a real Windows, Linux or macOS box.
 */
function diskSample(cfg = {}, opts = {}) {
  if (!cfg || !cfg.allowFiles) return null;
  const volumes = listVolumes(opts);
  if (!volumes.length) return [];
  if (!cfg.allowFilesAll) {
    const root = cfg.filesRoot || opts.cwd || process.cwd();
    const platform = opts.platform || process.platform;
    const match = volumeContaining(volumes, root, platform) || volumes[0];
    return [{ ...match, workspace: true }];
  }
  return volumes;
}

module.exports = {
  Telemetry,
  clamp01,
  cpuTimes,
  hasStatfs,
  statfsSafe,
  listWindowsVolumes,
  listLinuxVolumes,
  listMacVolumes,
  listVolumes,
  parseLinuxMounts,
  volumeContaining,
  diskSample,
};
