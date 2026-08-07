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
 */

const os = require('os');

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

module.exports = { Telemetry, clamp01, cpuTimes };
