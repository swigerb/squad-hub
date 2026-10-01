'use strict';
/**
 * Local Squad CLI health probe.
 *
 * The executable named `squad` is resolved from PATH and is therefore
 * trusted-as-installed. squad-hub cannot prove that binary is authentic; its
 * job here is to avoid making PATH execution worse: no shell, argv arrays only,
 * bounded output, bounded time, and no raw diagnostics sent to the hub.
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const { isSquadProject } = require('./agent-select');

const SCHEMA = 'squad-health/v1';
const MIN_VERSION = '0.13.0';
const CHECK_IDS = Object.freeze(['team', 'registry-charters', 'routing', 'state-backend', 'env-vars']);
const CHECK_STATUSES = new Set(['pass', 'fail', 'skip']);
const TOP_STATUSES = new Set(['pass', 'fail']);
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_TTL_MS = 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_CACHE_ENTRIES = 128;

const cache = new Map();
const children = new Set();

function findOnPath(name) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const rawExts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  const exts = rawExts.includes('') ? rawExts : [...rawExts, ''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
    }
  }
  return null;
}

function trustedSystem32Exe(name) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
}

function unsafeCmdShimInvocationReason(command, args) {
  const script = String(command || '');
  if (/[\0\r\n]/.test(script)) return 'refusing unsafe Windows command shim path containing a control character';
  if (/["%|<>]/.test(script)) return 'refusing unsafe Windows command shim path containing cmd syntax';
  for (const arg of args) {
    const value = String(arg);
    if (/[\0\r\n]/.test(value)) return 'refusing unsafe Windows command shim argument containing a control character';
    if (/%/.test(value)) return 'refusing unsafe Windows command shim argument containing percent expansion syntax';
    if (/\\+"/.test(value)) return 'refusing unsafe Windows command shim argument containing a backslash before a quote';
  }
  return null;
}

function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function cmdShimCommandLine(command, args) {
  return `"${[quoteForCmd(command), ...args.map(quoteForCmd)].join(' ')}"`;
}

function spawnTarget(command, args) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    const unsafeReason = unsafeCmdShimInvocationReason(command, args);
    if (unsafeReason) return { error: new Error(unsafeReason) };
    return {
      command: trustedSystem32Exe('cmd.exe'),
      args: ['/d', '/v:off', '/s', '/c', cmdShimCommandLine(command, args)],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args };
}

function normalizeCwd(cwd) {
  return path.resolve(cwd || process.cwd());
}

function versionParts(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionAtLeast(found, needed = MIN_VERSION) {
  const a = versionParts(found);
  const b = versionParts(needed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

function reducedEnv(base = process.env) {
  const keep = [
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'APPDATA', 'LOCALAPPDATA',
    'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME',
  ];
  const env = {};
  for (const k of keep) if (base[k]) env[k] = base[k];
  for (const [k, v] of Object.entries(base)) {
    if (!/^SQUAD_/i.test(k)) continue;
    if (/(TOKEN|SECRET|PASSWORD|PASS|PWD|KEY)/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const taskkill = trustedSystem32Exe('taskkill.exe');
      childProcess.spawnSync(taskkill, ['/pid', String(pid), '/T', '/F'], {
        cwd: path.dirname(taskkill),
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch { /* best effort */ }
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }, 250).unref?.();
}

function spawnBounded(command, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overCap = false;
    let timedOut = false;
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) children.delete(child);
      resolve({ stdout, stderr, overCap, timedOut, ...result });
    };

    const onData = (which, d) => {
      const bytes = Buffer.byteLength(d);
      if (which === 'stdout') stdoutBytes += bytes;
      else stderrBytes += bytes;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        overCap = true;
        if (child) killProcessTree(child.pid);
        finish({ error: null, code: null, signal: null });
        return;
      }
      if (which === 'stdout') stdout += d.toString('utf8');
      else stderr += d.toString('utf8');
    };

    try {
      const target = spawnTarget(command, args);
      if (target.error) throw target.error;
      child = childProcess.spawn(target.command, target.args, {
        cwd: opts.cwd,
        env: opts.env || reducedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: target.windowsVerbatimArguments === true,
      });
    } catch (e) {
      finish({ error: e, code: null, signal: null });
      return;
    }
    children.add(child);
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => onData('stdout', d));
    child.stderr.on('data', (d) => onData('stderr', d));
    child.on('error', (e) => finish({ error: e, code: null, signal: null }));
    child.on('close', (code, signal) => finish({ error: null, code, signal }));
  });
}

function parseHealthPayload(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout || '').trim()); } catch {
    return { ok: false, reason: 'produced unparsable output' };
  }
  if (!parsed || parsed.schema !== SCHEMA || !TOP_STATUSES.has(parsed.status) || !Array.isArray(parsed.checks)) {
    return { ok: false, reason: 'produced JSON but not the squad-health/v1 schema' };
  }
  const seen = new Set();
  for (const c of parsed.checks) {
    if (!c || !CHECK_IDS.includes(c.id) || !CHECK_STATUSES.has(c.status) || typeof c.message !== 'string') {
      return { ok: false, reason: 'produced JSON but not the squad-health/v1 schema' };
    }
    if (seen.has(c.id)) return { ok: false, reason: 'produced JSON but not the squad-health/v1 schema' };
    seen.add(c.id);
    if (c.diagnostics !== undefined && (!Array.isArray(c.diagnostics) || c.diagnostics.some((d) => typeof d !== 'string'))) {
      return { ok: false, reason: 'produced JSON but not the squad-health/v1 schema' };
    }
  }
  if (CHECK_IDS.some((id) => !seen.has(id))) return { ok: false, reason: 'produced JSON but not the squad-health/v1 schema' };
  return { ok: true, report: parsed };
}

function commandParts(opts = {}) {
  return {
    command: opts.squadCommand || 'squad',
    prefix: Array.isArray(opts.squadArgsPrefix) ? opts.squadArgsPrefix : [],
  };
}

function cacheOptions(opts = {}) {
  const n = Number(opts.maxCacheEntries);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CACHE_ENTRIES;
}

function pruneCache(now, ttlMs, maxEntries) {
  for (const [key, entry] of cache) {
    if (entry && entry.result && !entry.inFlight && now - entry.at >= ttlMs) cache.delete(key);
  }
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function setCacheEntry(key, entry, opts = {}) {
  cache.set(key, entry);
  pruneCache(Date.now(), opts.ttlMs || DEFAULT_TTL_MS, cacheOptions(opts));
}

async function runSquadHealth(cwd, opts = {}) {
  const projectDir = normalizeCwd(cwd);
  if (!isSquadProject(projectDir)) {
    return { available: false, reason: 'not a Squad project' };
  }

  const parts = commandParts(opts);
  const found = opts.squadCommand ? parts.command : findOnPath('squad');
  if (!found) return { available: false, reason: '`squad` not found on PATH' };
  const command = opts.squadCommand ? parts.command : found;

  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  const env = opts.env || reducedEnv();

  const version = await spawnBounded(command, [...parts.prefix, '--version'], {
    cwd: projectDir, timeoutMs, maxOutputBytes, env,
  });
  if (version.timedOut) return { available: false, reason: 'timed out while running `squad --version`' };
  if (version.overCap) return { available: false, reason: '`squad --version` produced too much output' };
  if (version.error || version.code !== 0) {
    return { available: false, reason: `crashed while running \`squad --version\`${version.error ? `: ${version.error.message}` : ''}` };
  }
  const foundVersion = String(version.stdout || '').trim();
  if (!versionAtLeast(foundVersion, MIN_VERSION)) {
    return { available: false, reason: `squad ${foundVersion || '(unknown version)'} is too old; need >= 0.13` };
  }

  const health = await spawnBounded(command, [...parts.prefix, 'health', '--json'], {
    cwd: projectDir, timeoutMs, maxOutputBytes, env,
  });
  if (health.timedOut) return { available: false, reason: 'timed out while running `squad health --json`' };
  if (health.overCap) return { available: false, reason: '`squad health --json` produced too much output' };

  const parsed = parseHealthPayload(health.stdout);
  if (parsed.ok) return { available: true, version: foundVersion, report: parsed.report, exitCode: health.code };

  if (health.error || (health.code !== 0 && !String(health.stdout || '').trim())) {
    return { available: false, reason: `crashed while running \`squad health --json\`${health.error ? `: ${health.error.message}` : ''}` };
  }
  return { available: false, reason: parsed.reason };
}

function summaryFromResult(result) {
  if (!result) return { status: 'unknown' };
  if (!result.available) return { status: 'unavailable' };
  return {
    status: result.report.status,
    checks: result.report.checks.map((c) => ({ id: c.id, status: c.status })),
  };
}

function getCachedSquadHealth(cwd, opts = {}) {
  const key = normalizeCwd(cwd);
  const now = opts.now || Date.now();
  const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
  const maxEntries = cacheOptions(opts);
  pruneCache(now, ttlMs, maxEntries);
  let entry = cache.get(key);
  if (entry && entry.result && now - entry.at < ttlMs) {
    cache.delete(key);
    cache.set(key, entry);
    return summaryFromResult(entry.result);
  }
  if (entry && entry.result && !entry.inFlight) {
    entry.inFlight = runSquadHealth(key, opts).then((result) => {
      setCacheEntry(key, { result, at: Date.now(), inFlight: null }, opts);
      return result;
    }).catch(() => {
      setCacheEntry(key, { result: { available: false, reason: 'crashed' }, at: Date.now(), inFlight: null }, opts);
    });
    return summaryFromResult(entry.result);
  }
  if (!entry || !entry.inFlight) {
    const inFlight = runSquadHealth(key, opts).then((result) => {
      setCacheEntry(key, { result, at: Date.now(), inFlight: null }, opts);
      return result;
    }).catch(() => {
      setCacheEntry(key, { result: { available: false, reason: 'crashed' }, at: Date.now(), inFlight: null }, opts);
    });
    setCacheEntry(key, { result: entry && entry.result, at: entry ? entry.at : 0, inFlight }, opts);
  }
  return entry && entry.result ? summaryFromResult(entry.result) : { status: 'unknown' };
}

function clearSquadHealthCache() {
  cache.clear();
}

function killAllSquadHealthProbes() {
  for (const child of [...children]) killProcessTree(child.pid);
}

function squadHealthCacheSize() {
  return cache.size;
}

module.exports = {
  SCHEMA,
  MIN_VERSION,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_CACHE_ENTRIES,
  runSquadHealth,
  getCachedSquadHealth,
  clearSquadHealthCache,
  killAllSquadHealthProbes,
  versionAtLeast,
  parseHealthPayload,
  squadHealthCacheSize,
  findOnPath,
};
