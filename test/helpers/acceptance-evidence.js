'use strict';
/**
 * Evidence for the acceptance runner (test/acceptance.js): what a run ran
 * against, and the proof that it did.
 *
 * Nothing here trusts a flag. A baseline "passed" only because its LOG, hashed
 * now, is the log that was hashed then, and because judging that log again with
 * the verdict rules gives the same answer. A tree is "the same" only because
 * every tracked and every unignored untracked file hashes the same -- by
 * content, not by commit id, because a dirty working tree is exactly what a
 * candidate is. Runtime identity (node, platform, Playwright and its browser)
 * is hashed the same way, so a proof made on one toolchain cannot be spent on
 * another.
 *
 * Every function is pure or takes the path it reads, so the tests can corrupt a
 * log, a proof or a file and watch the check refuse.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { judgeBaseline } = require('./verdict');

const SCHEMA = 1;
const SCOPES = Object.freeze(['candidate', 'exhaustive']);
// What each scope may be called in a report. A candidate pass is a pass of the
// SELECTED mutations only, and its label says so.
const SCOPE_LABEL = Object.freeze({ candidate: 'candidate-selected', exhaustive: 'exhaustive' });

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** JSON with every object's keys sorted, so equal values always hash equal. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const digestOf = (value) => sha256(canonicalJson(value));
const byOrdinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${root}: ${r.error ? r.error.message : String(r.stderr || '').trim()}`);
  }
  return r.stdout;
}

const zlist = (buf) => buf.toString('utf8').split('\0').filter(Boolean);

/**
 * The content manifest of a working tree: every tracked file and every
 * untracked file git does not ignore, hashed. A tracked file that is missing
 * from disk is listed with a null hash, because a deletion is a change.
 */
function sourceManifest(root) {
  const paths = [...new Set([
    ...zlist(git(root, ['ls-files', '-z'])),
    ...zlist(git(root, ['ls-files', '-z', '--others', '--exclude-standard'])),
  ])].sort(byOrdinal);
  const files = paths.map((p) => {
    const abs = path.join(root, p);
    let data = null;
    try { if (fs.statSync(abs).isFile()) data = fs.readFileSync(abs); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return { path: p, sha256: data ? sha256(data) : null, bytes: data ? data.length : 0 };
  });
  const head = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  return { schemaVersion: SCHEMA, head, files, digest: digestOf(files) };
}

/** `{ equal, added, removed, changed }` between two manifests (paths, at most 25 each). */
function compareManifests(expected, actual) {
  const a = new Map(expected.files.map((f) => [f.path, f.sha256]));
  const b = new Map(actual.files.map((f) => [f.path, f.sha256]));
  const removed = [...a.keys()].filter((p) => !b.has(p));
  const added = [...b.keys()].filter((p) => !a.has(p));
  const changed = [...a.keys()].filter((p) => b.has(p) && a.get(p) !== b.get(p));
  return {
    equal: !removed.length && !added.length && !changed.length,
    added: added.slice(0, 25), removed: removed.slice(0, 25), changed: changed.slice(0, 25),
    count: added.length + removed.length + changed.length,
  };
}

const describeDrift = (d) => [
  d.changed.length ? `changed: ${d.changed.join(', ')}` : '',
  d.added.length ? `added: ${d.added.join(', ')}` : '',
  d.removed.length ? `removed: ${d.removed.join(', ')}` : '',
].filter(Boolean).join('; ');

/**
 * What the toolchain is: the node, the platform, and the Playwright package and
 * browser the browser suites need (found the way the tree itself would find
 * them, then handed to every copy through NODE_PATH, because a copy outside the
 * source's directory chain would otherwise lose them silently and the browser
 * suite would SKIP). `playwright` is null when it is genuinely absent.
 */
function runtimeIdentity(root, env = process.env) {
  let playwright = null;
  try {
    const pkgPath = require.resolve('playwright/package.json', { paths: [root] });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let browser = null;
    try {
      const exe = require(require.resolve('playwright', { paths: [root] })).chromium.executablePath();
      let bytes = null;
      try { bytes = fs.statSync(exe).size; } catch { /* not installed */ }
      browser = { executable: exe, bytes };
    } catch { /* no browser registered */ }
    playwright = {
      version: pkg.version,
      modulesDir: path.dirname(path.dirname(pkgPath)),
      browser,
    };
  } catch { /* optional dependency */ }
  const identity = {
    schemaVersion: SCHEMA,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    playwright,
    env: {
      PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH || null,
      NODE_OPTIONS: env.NODE_OPTIONS || null,
    },
  };
  return { ...identity, digest: digestOf(identity) };
}

/** True when `child` is `parent` or inside it, comparing real paths where they exist. */
function isInside(parent, child) {
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

/** A proof is a document plus the digest of everything else in it. */
function sealed(doc) {
  const { proofDigest, reportDigest, ...rest } = doc;
  return { ...rest, [doc.kind === 'report' ? 'reportDigest' : 'proofDigest']: digestOf(rest) };
}

/**
 * The proof that one full, unmutated regression passed against one manifest and
 * one runtime. It carries the log's digest and the raw outcome of the process,
 * not a verdict to be believed: validateBaselineProof reads both again.
 */
function baselineProof({ label, manifest, runtime, run, verdict, logRelative, command }) {
  return sealed({
    schemaVersion: SCHEMA,
    kind: 'baseline',
    label,
    manifestDigest: manifest.digest,
    fileCount: manifest.files.length,
    head: manifest.head,
    runtimeDigest: runtime.digest,
    command,
    process: {
      code: run.code, rawCode: run.rawCode, signal: run.signal || null, timedOut: !!run.timedOut,
      cancelled: !!run.cancelled, error: run.error ? String(run.error.code || run.error.message) : null,
    },
    log: { path: logRelative, bytes: run.log.bytes, sha256: run.log.sha256 },
    verdict: { ok: verdict.ok, passed: verdict.passed, failed: verdict.failed, skipped: verdict.skipped },
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: new Date(run.finishedAt).toISOString(),
    durationMs: run.durationMs,
  });
}

/**
 * `{ ok, reason, proof }`: is this file a baseline proof for THIS manifest and
 * THIS runtime, whose log is intact and still judges as a clean, nonempty,
 * unskipped pass?
 */
function validateBaselineProof(file, { manifestDigest, runtimeDigest, baseDir }) {
  const bad = (reason) => ({ ok: false, reason: `baseline proof ${path.basename(file)} is not usable: ${reason}` });
  let proof;
  try { proof = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return bad(`unreadable or corrupt (${e.code || e.message})`); }
  if (!proof || proof.kind !== 'baseline' || proof.schemaVersion !== SCHEMA) return bad('it is not a schema 1 baseline proof');
  const { proofDigest, ...rest } = proof;
  if (proofDigest !== digestOf(rest)) return bad('its digest does not match its content (edited or corrupt)');
  if (proof.manifestDigest !== manifestDigest) return bad('it was made for different source: the tree drifted or the proof is stale');
  if (proof.runtimeDigest !== runtimeDigest) return bad('it was made for a different runtime or dependency set');
  if (!proof.log || typeof proof.log.path !== 'string') return bad('it names no log');
  const logFile = path.resolve(baseDir, proof.log.path);
  if (!isInside(baseDir, logFile)) return bad('its log path leaves the artifact directory');
  let buf;
  try { buf = fs.readFileSync(logFile); } catch (e) { return bad(`its log is missing (${e.code})`); }
  if (sha256(buf) !== proof.log.sha256 || buf.length !== proof.log.bytes) return bad('its log no longer matches the recorded digest');
  const p = proof.process || {};
  const judged = judgeBaseline({
    code: p.code, signal: p.signal, timedOut: p.timedOut, error: p.error ? { message: p.error } : null,
    out: buf.toString('utf8'),
  });
  if (p.cancelled) return bad('the run was cancelled');
  if (!judged.ok) return bad(`its log does not read as a clean baseline: ${judged.reason}`);
  const v = proof.verdict || {};
  if (v.ok !== true || v.passed !== judged.passed || v.failed !== judged.failed || v.skipped !== judged.skipped) {
    return bad('its recorded counts contradict its own log');
  }
  return { ok: true, reason: '', proof, judged };
}

// ---------------------------------------------------------------------------
// Events and reports
// ---------------------------------------------------------------------------

/** An append-only JSONL log of step events. Each line is flushed as it is written. */
function createEventLog(file, now = Date.now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let seq = 0;
  return {
    file,
    emit(event) {
      seq += 1;
      fs.appendFileSync(file, `${JSON.stringify({ seq, ts: new Date(now()).toISOString(), ...event })}\n`);
    },
    count: () => seq,
  };
}

function sealReport(report) { return sealed({ ...report, kind: 'report' }); }

/**
 * `{ ok, reason, report }` for a finished report that someone is about to rely
 * on. The caller NAMES the scope it expects; a report of another scope, of an
 * unknown scope, or one that was edited, interrupted or never accepted is
 * refused, so "candidate-selected passed" can never satisfy an exhaustive gate.
 */
function verifyReport(file, { expectedScope, manifestDigest } = {}) {
  const bad = (reason) => ({ ok: false, reason: `report ${path.basename(file)} is not acceptable: ${reason}` });
  if (!SCOPES.includes(expectedScope)) return bad(`the expected scope ${JSON.stringify(expectedScope)} is not one of ${SCOPES.join(', ')}`);
  let report;
  try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return bad(`unreadable or corrupt (${e.code || e.message})`); }
  if (!report || report.kind !== 'report' || report.schemaVersion !== SCHEMA) return bad('it is not a schema 1 acceptance report');
  const { reportDigest, ...rest } = report;
  if (reportDigest !== digestOf(rest)) return bad('its digest does not match its content (edited or corrupt)');
  if (!SCOPES.includes(report.scope)) return bad(`it names an unknown scope ${JSON.stringify(report.scope)}`);
  if (report.scope !== expectedScope) return bad(`it is a ${SCOPE_LABEL[report.scope]} report, not a ${SCOPE_LABEL[expectedScope]} one`);
  if (report.scopeLabel !== SCOPE_LABEL[report.scope]) return bad('its scope label contradicts its scope');
  if (manifestDigest && report.manifestDigest !== manifestDigest) return bad('it was made for different source');
  if (report.status !== 'accepted' || report.accepted !== true) return bad(`its status is ${report.status}, not accepted`);
  if (report.incomplete) return bad('it is marked incomplete');
  const outcomes = Array.isArray(report.outcomes) ? report.outcomes : [];
  if (!outcomes.length && !(report.controlsOnly === true)) return bad('it holds no mutation outcomes');
  if (outcomes.length !== report.selectedCount) return bad(`${outcomes.length} outcomes for ${report.selectedCount} selected mutations`);
  const notCaught = outcomes.filter((o) => o.verdict !== 'caught');
  if (notCaught.length) return bad(`${notCaught.length} outcome(s) are not caught, e.g. ${notCaught[0].name}: ${notCaught[0].verdict}`);
  if (new Set(outcomes.map((o) => o.id)).size !== outcomes.length) return bad('it repeats a mutation id');
  if (report.scope === 'exhaustive' && report.deferredCount) return bad('an exhaustive report may not defer mutations');
  const badControls = (report.controls || []).filter((c) => !c.ok);
  if (badControls.length) return bad(`${badControls.length} control(s) were not clean`);
  const proofs = Array.isArray(report.proofs) ? report.proofs : [];
  if (proofs.length < 2) return bad('it names fewer than two baseline proofs (before and after)');
  const baseDir = path.dirname(file);
  for (const p of proofs) {
    const v = validateBaselineProof(path.resolve(baseDir, String(p.file)), {
      manifestDigest: report.manifestDigest, runtimeDigest: report.runtimeDigest, baseDir,
    });
    if (!v.ok) return bad(v.reason);
  }
  return { ok: true, reason: '', report };
}

// ---------------------------------------------------------------------------
// Timing history
// ---------------------------------------------------------------------------

/**
 * `{ groups, warning }` from a timings file. The history only ever informs the
 * ORDER and the ESTIMATES: a missing or corrupt one is a warning, never a
 * reason to skip, add or fail any mutation.
 */
function readHistory(file) {
  if (!file) return { groups: {}, warning: null };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { groups: {}, warning: e.code === 'ENOENT' ? `no timing history at ${file}; estimates start cold` : `timing history ${file} is unreadable (${e.code || e.message}); ignored` };
  }
  const groups = {};
  if (doc && doc.groups && typeof doc.groups === 'object') {
    for (const [k, v] of Object.entries(doc.groups)) {
      if (v && Number.isFinite(v.controlMs) && Number.isFinite(v.mutationMs) && v.controlMs >= 0 && v.mutationMs >= 0) {
        groups[k] = { controlMs: v.controlMs, mutationMs: v.mutationMs, samples: Number(v.samples) || 0 };
      }
    }
  }
  return { groups, warning: null };
}

module.exports = {
  SCHEMA, SCOPES, SCOPE_LABEL, sha256, canonicalJson, digestOf,
  sourceManifest, compareManifests, describeDrift, runtimeIdentity, isInside,
  baselineProof, validateBaselineProof, createEventLog, sealReport, verifyReport, readHistory,
};
