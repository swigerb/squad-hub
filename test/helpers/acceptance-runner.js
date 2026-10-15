'use strict';
/**
 * The acceptance runner: one coordinated run that proves a set of mutations is
 * caught, without paying for a full regression per shard.
 *
 *   1. PLAN     policy picks the mutations (candidate) or all of them
 *               (exhaustive); the runner checks it accounted for every one.
 *   2. IDENTITY the source is hashed by content and the runtime is identified.
 *   3. BASELINE one full, nonempty, unskipped regression in a private copy. Its
 *               log digest and raw process outcome become a proof file.
 *   4. WORKERS  jobs (one suite or browser scenario each, longest first) run in
 *               private copies, each with its own TEMP and SQUAD_HUB_HOME. A
 *               job is a clean control, its mutants (each applied, run with
 *               MUTANT=1, restored byte for byte), and a clean control again.
 *               The proof is re-read before every job.
 *   5. FINAL    one more full regression, so the restored tree is shown clean.
 *   6. REPORT   every outcome, control and proof, sealed with a digest.
 *
 * The caller's tree is only ever READ. A run that is cancelled, drifts, times
 * out, or leaves a mutation unaccounted for is reported INCOMPLETE or REJECTED
 * with the reason; nothing falls back to a success-shaped answer. Scope is part
 * of the verdict: a candidate run says "candidate-selected" and lists what it
 * deferred, so it can never be read as an exhaustive pass.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { runProcess, killOwned } = require('./acceptance-process');
const ev = require('./acceptance-evidence');
const sched = require('./acceptance-schedule');
const { judgeBaseline, judgeControl, classifyRun, summarise, failedNames } = require('./verdict');

const TIMEOUTS = Object.freeze({ baselineMs: 900000, suiteMs: 300000, fullMs: 600000 });
const nl = (s) => s.replace(/\r\n/g, '\n');
const safe = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 80);

class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}

const defaultJobs = () => Math.max(1, Math.min(4, Math.floor((os.cpus().length || 2) / 2)));

function normaliseOptions(opts) {
  const root = path.resolve(opts.root || path.join(__dirname, '..', '..'));
  if (!ev.SCOPES.includes(opts.scope)) {
    throw new UsageError(`--scope must be one of ${ev.SCOPES.join(', ')}, not ${JSON.stringify(opts.scope)}`);
  }
  if (opts.scope === 'candidate' && (typeof opts.baseRef !== 'string' || !opts.baseRef || opts.baseRef.startsWith('-'))) {
    throw new UsageError('--scope candidate needs --base <explicit Git ref> to say what the candidate is measured against');
  }
  if (typeof opts.artifacts !== 'string' || !opts.artifacts) throw new UsageError('--artifacts <directory outside the source tree> is required');
  const artifacts = path.resolve(opts.artifacts);
  if (ev.isInside(root, artifacts) || ev.isInside(artifacts, root)) {
    throw new UsageError(`--artifacts ${artifacts} must be a directory outside the source tree ${root}, and must not contain it`);
  }
  let leftovers = [];
  try { leftovers = fs.readdirSync(artifacts).filter((n) => n !== 'plan.json'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (leftovers.length) {
    throw new UsageError(`--artifacts ${artifacts} must be a new or empty directory so no old log or proof can be mistaken for this run's (found ${leftovers.slice(0, 3).join(', ')})`);
  }
  const jobs = opts.jobs === undefined ? defaultJobs() : opts.jobs;
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) throw new UsageError(`--jobs must be an integer from 1 to 64, not ${JSON.stringify(opts.jobs)}`);
  return {
    root, scope: opts.scope, baseRef: opts.baseRef || null, artifacts, jobs,
    planOnly: !!opts.planOnly,
    mutations: opts.mutations, suiteFor: opts.suiteFor, scenarioFor: opts.scenarioFor, policy: opts.policy,
    exec: opts.exec || runProcess,
    now: opts.now || Date.now,
    log: opts.log || ((...a) => console.log(...a)),
    historyFile: opts.historyFile || null,
    reuseBaseline: opts.reuseBaseline || null,
    timeouts: { ...TIMEOUTS, ...(opts.timeouts || {}) },
    heartbeatMs: opts.heartbeatMs === undefined ? 30000 : opts.heartbeatMs,
    finalBaseline: opts.finalBaseline !== false,
    signal: opts.signal || null,
    copyTree: opts.copyTree || createWorkerCopy,
    maxChunk: opts.maxChunk || 40,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function loadCollaborators(o) {
  const warnings = [];
  let mutations = o.mutations;
  let suiteFor = o.suiteFor;
  if (!mutations || !suiteFor) {
    const m = require('../mutate');
    mutations = mutations || m.MUTATIONS;
    suiteFor = suiteFor || m.suiteFor;
  }
  let policy = o.policy;
  if (!policy) {
    try { policy = require('./acceptance-policy'); } catch (e) {
      throw new Error(`test/helpers/acceptance-policy.js is not available (${e.code || e.message}): the runner cannot choose or account for mutations without it`);
    }
  }
  if (typeof policy.planAcceptance !== 'function' || typeof policy.mutationId !== 'function') {
    throw new Error('acceptance-policy.js must export planAcceptance and mutationId');
  }
  let scenarioFor = o.scenarioFor;
  if (scenarioFor === undefined) {
    try { scenarioFor = require('./browser-scenarios').scenarioForTest; } catch {
      scenarioFor = null;
      warnings.push('test/helpers/browser-scenarios.js is not available: every browser mutation runs the WHOLE browser suite');
    }
  }
  return { mutations, suiteFor, policy, scenarioFor, warnings };
}

/**
 * Ask policy for the selection, then refuse it unless it is whole: well-formed,
 * not blocked, every entry's id and index true to the catalogue, nothing
 * selected twice or also deferred, and (exhaustive) exactly the runnable set.
 * Returns `{ plan, blocked: [reasons] }`.
 */
function checkedPlan(o, c) {
  const plan = c.policy.planAcceptance({ root: o.root, baseRef: o.baseRef, mutations: c.mutations, suiteFor: c.suiteFor, scope: o.scope });
  const blocked = [];
  if (!plan || plan.schemaVersion !== 1) return { plan, blocked: ['policy returned no schema 1 plan'] };
  if (plan.scope !== o.scope) blocked.push(`policy planned scope ${JSON.stringify(plan.scope)}, not the requested ${o.scope}`);
  for (const k of ['selected', 'deferred', 'excluded', 'warnings', 'blockedReasons']) {
    if (!Array.isArray(plan[k])) blocked.push(`policy plan.${k} is not a list`);
  }
  if (blocked.length) return { plan, blocked };
  for (const r of plan.blockedReasons) blocked.push(`policy blocked the plan: ${typeof r === 'string' ? r : JSON.stringify(r)}`);
  const seen = new Set();
  for (const e of plan.selected) {
    const real = c.mutations[e.index];
    if (!real || real !== e.mutation) { blocked.push(`selected entry ${e.index} is not catalogue entry ${e.index}`); continue; }
    if (e.id !== c.policy.mutationId(e.mutation)) { blocked.push(`selected entry ${e.index} carries a stale id`); continue; }
    if (real.skip) blocked.push(`selected entry ${e.index} (${real.name}) is excluded by the catalogue`);
    if (seen.has(e.id)) blocked.push(`mutation ${e.id} is selected twice`);
    seen.add(e.id);
  }
  const idOf = (x) => (x && (x.id || (x.mutation && c.policy.mutationId(x.mutation)))) || null;
  for (const d of [...plan.deferred, ...plan.excluded]) { const id = idOf(d); if (id && seen.has(id)) blocked.push(`mutation ${id} is both selected and deferred or excluded`); }
  const runnable = c.mutations.filter((m) => !m.skip).length;
  if (o.scope === 'exhaustive') {
    if (plan.deferred.length) blocked.push(`an exhaustive plan may not defer mutations, but ${plan.deferred.length} were`);
    if (plan.selected.length !== runnable) blocked.push(`an exhaustive plan must select all ${runnable} runnable mutations, not ${plan.selected.length}`);
  }
  const accounted = plan.selected.length + plan.deferred.length + plan.excluded.length;
  if (accounted !== c.mutations.length) {
    blocked.push(`the plan accounts for ${accounted} of ${c.mutations.length} catalogue mutations (selected ${plan.selected.length}, deferred ${plan.deferred.length}, excluded ${plan.excluded.length})`);
  }
  const required = requiredSuitesOf(plan);
  if (!plan.selected.length && !required.length) blocked.push('the plan selects no mutations and requires no suite: an empty selection proves nothing');
  return { plan, blocked };
}

const requiredSuitesOf = (plan) => [...new Set((plan.requiredSuites || [])
  .map((s) => (typeof s === 'string' ? s : s && s.suite)).filter(Boolean))].sort();

function buildWork(o, c, plan, history) {
  const groups = sched.buildGroups(plan.selected, c.scenarioFor);
  const jobs = sched.buildJobs(groups, { jobs: o.jobs, history, maxChunk: o.maxChunk });
  // A suite the plan REQUIRES gets a clean control even if no mutant names it.
  const have = new Set(jobs.filter((j) => j.kind === 'suite').map((j) => j.suite));
  for (const suite of requiredSuitesOf(plan)) {
    if (suite === sched.FULL_SUITE || have.has(suite)) continue;
    jobs.push({
      id: `required:${suite}`, key: suite, kind: 'suite', suite, scenario: null, args: [`test/${suite}`], entries: [],
      controlsOnly: true, controlsFromBaseline: false, estimateMs: sched.costOf({ key: suite, kind: 'suite' }, history).controlMs,
      estimateKnown: !!history[suite],
    });
  }
  return { groups, jobs: sched.orderJobs(jobs) };
}

function planSummary(o, c, plan, work, manifest, runtime, history) {
  const fallback = work.groups.filter((g) => g.kind === 'full');
  const browserWhole = work.groups.filter((g) => g.kind === 'suite' && g.suite === sched.BROWSER_SUITE);
  const warnings = [...c.warnings, ...plan.warnings.map(String)];
  if (history.warning) warnings.push(history.warning);
  for (const g of fallback) warnings.push(`${g.entries.length} mutation(s) have no standalone suite and each runs the FULL regression`);
  for (const g of browserWhole) warnings.push(`${g.entries.length} browser mutation(s) have no scenario and run the WHOLE browser suite`);
  const known = work.jobs.filter((j) => j.estimateKnown);
  return {
    schemaVersion: 1,
    scope: o.scope, scopeLabel: ev.SCOPE_LABEL[o.scope], baseRef: o.baseRef,
    head: manifest.head, manifestDigest: manifest.digest, fileCount: manifest.files.length, runtimeDigest: runtime.digest,
    changedFiles: plan.changedFiles || [],
    catalogue: c.mutations.length,
    selectedCount: plan.selected.length, deferredCount: plan.deferred.length, excludedCount: plan.excluded.length,
    requiredSuites: requiredSuitesOf(plan),
    groups: work.groups.map((g) => ({ key: g.key, kind: g.kind, mutations: g.entries.length })),
    jobs: work.jobs.map((j) => ({ id: j.id, kind: j.kind, mutations: j.entries.length, estimateMs: j.estimateKnown ? j.estimateMs : null })),
    estimatedMs: known.length === work.jobs.length ? work.jobs.reduce((s, j) => s + j.estimateMs, 0) : null,
    estimateBasis: known.length === work.jobs.length ? 'measured history' : `unavailable: ${work.jobs.length - known.length} of ${work.jobs.length} job(s) have no history`,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Copies and environments
// ---------------------------------------------------------------------------

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.error ? r.error.message : String(r.stderr).trim()}`);
  return r.stdout;
}

/**
 * A private copy of the tree at `dest`: a clone of HEAD (so git-dependent tests
 * see a repository) with the caller's working files laid over it, including
 * uncommitted edits and untracked files, and anything the working tree deleted
 * removed. The copy is accepted only when its CONTENT manifest equals the
 * caller's. The caller's tree is only read.
 */
function createWorkerCopy(root, dest, manifest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  sh('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-hardlinks', root, dest]);
  try { sh('git', ['remote', 'remove', 'origin'], dest); } catch { /* a clone always has one; tolerate its absence */ }
  const want = new Map(manifest.files.map((f) => [f.path, f]));
  for (const p of sh('git', ['ls-files', '-z'], dest).split('\0').filter(Boolean)) {
    if (!want.has(p)) fs.rmSync(path.join(dest, p), { force: true });
  }
  for (const f of manifest.files) {
    const to = path.join(dest, f.path);
    if (f.sha256 === null) { fs.rmSync(to, { force: true }); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, f.path), to);
  }
  const got = ev.sourceManifest(dest);
  const drift = ev.compareManifests(manifest, got);
  if (!drift.equal) throw new Error(`the copy at ${dest} does not match the source: ${ev.describeDrift(drift)}`);
  return got;
}

/** The environment a copy runs in: private TEMP, TMP and SQUAD_HUB_HOME; no MUTANT; Playwright found as the source finds it. */
function workerEnv(base, envDir, runtime) {
  const tmp = path.join(envDir, 'tmp');
  const home = path.join(envDir, 'home');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const env = { ...base };
  delete env.MUTANT;
  Object.assign(env, { TEMP: tmp, TMP: tmp, TMPDIR: tmp, SQUAD_HUB_HOME: home, GIT_OPTIONAL_LOCKS: '0' });
  if (runtime.playwright && runtime.playwright.modulesDir) {
    env.NODE_PATH = [runtime.playwright.modulesDir, env.NODE_PATH].filter(Boolean).join(path.delimiter);
  }
  return env;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function runAcceptance(opts) {
  const o = normaliseOptions(opts);
  const c = loadCollaborators(o);
  const history = ev.readHistory(o.historyFile);
  fs.mkdirSync(o.artifacts, { recursive: true });
  const startedAt = o.now();
  const log = o.log;

  const { plan, blocked } = checkedPlan(o, c);
  const manifest = ev.sourceManifest(o.root);
  const runtime = ev.runtimeIdentity(o.root);
  const work = blocked.length ? { groups: [], jobs: [] } : buildWork(o, c, plan, history.groups);
  const summary = blocked.length ? null : planSummary(o, c, plan, work, manifest, runtime, history);

  const base = {
    schemaVersion: 1, scope: o.scope, scopeLabel: ev.SCOPE_LABEL[o.scope], baseRef: o.baseRef,
    head: manifest.head, manifestDigest: manifest.digest, runtimeDigest: runtime.digest,
    selectedCount: plan && Array.isArray(plan.selected) ? plan.selected.length : 0,
    deferredCount: plan && Array.isArray(plan.deferred) ? plan.deferred.length : 0,
    excludedCount: plan && Array.isArray(plan.excluded) ? plan.excluded.length : 0,
    changedFiles: (plan && plan.changedFiles) || [],
    requiredSuites: plan && Array.isArray(plan.requiredSuites) ? requiredSuitesOf(plan) : [],
    warnings: summary ? summary.warnings : [...c.warnings],
    events: null,
    startedAt: new Date(startedAt).toISOString(),
  };

  const finish = (status, extra, failures) => {
    const report = ev.sealReport({
      ...base, status, accepted: status === 'accepted', incomplete: status === 'incomplete',
      failures: failures || [], finishedAt: new Date(o.now()).toISOString(), durationMs: o.now() - startedAt, ...extra,
    });
    const file = path.join(o.artifacts, status === 'plan' ? 'plan.json' : 'report.json');
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    return { status, exitCode: status === 'accepted' || status === 'plan' ? 0 : status === 'incomplete' ? 130 : 1, report, reportFile: file };
  };

  log(`acceptance ${base.scopeLabel.toUpperCase()}${o.baseRef ? ` against ${o.baseRef}` : ''} @ ${manifest.head.slice(0, 12)}, ${manifest.files.length} files, jobs=${o.jobs}`);

  if (blocked.length) {
    log('\nBLOCKED: the selection cannot be trusted:');
    for (const b of blocked) log(`  - ${b}`);
    return finish('blocked', { outcomes: [], controls: [], proofs: [] }, blocked);
  }

  log(`selected ${summary.selectedCount} mutation(s), deferred ${summary.deferredCount} (NOT proven by this run), excluded ${summary.excludedCount}; ${work.jobs.length} job(s)`);
  if (summary.requiredSuites.length) log(`required suites: ${summary.requiredSuites.join(', ')}`);
  for (const w of summary.warnings) log(`  warning: ${w}`);

  if (o.planOnly) {
    log(`estimate: ${summary.estimatedMs === null ? summary.estimateBasis : sched.fmtMs(summary.estimatedMs)}`);
    for (const j of summary.jobs) log(`  ${j.id}  ${j.mutations} mutation(s)  ${j.estimateMs === null ? 'cost unknown' : sched.fmtMs(j.estimateMs)}`);
    log('\nPLAN ONLY: nothing was run and no source was touched. This is not acceptance.');
    return finish('plan', { plan: summary }, []);
  }

  return execute({ o, c, plan, work, summary, history, manifest, runtime, base, startedAt, finish });
}

async function execute(env) {
  const { o, c, plan, work, summary, history, manifest, runtime, finish } = env;
  const events = ev.createEventLog(path.join(o.artifacts, 'events.jsonl'), o.now);
  events.emit({ event: 'run-start', scope: o.scope, baseRef: o.baseRef, head: manifest.head, manifestDigest: manifest.digest, selected: plan.selected.length, jobs: work.jobs.length, workers: o.jobs });
  const log = o.log;
  const failures = [];
  const controls = [];
  const proofs = [];
  const outcomes = new Map(); // mutation id -> outcome
  let cancelled = false;
  let stepCounter = 0;
  const onAbort = () => { cancelled = true; events.emit({ event: 'cancel' }); killOwned(); };
  if (o.signal) { if (o.signal.aborted) cancelled = true; else o.signal.addEventListener('abort', onAbort, { once: true }); }

  const progress = sched.createProgress({
    jobs: work.jobs, totalMutations: plan.selected.length, history: history.groups, now: o.now, workers: o.jobs,
  });
  const beat = o.heartbeatMs > 0 ? setInterval(() => {
    const snap = progress.snapshot();
    log(sched.heartbeatLine(snap));
    events.emit({ event: 'heartbeat', completed: snap.completed, total: snap.total, active: snap.active, eta: snap.eta });
  }, o.heartbeatMs) : null;
  if (beat && beat.unref) beat.unref();

  const finishWith = (status, extra) => {
    if (beat) clearInterval(beat);
    if (o.signal) o.signal.removeEventListener('abort', onAbort);
    return finish(status, extra, failures);
  };

  const dirs = { baseline: path.join(o.artifacts, 'work', 'baseline') };
  const recheckCaller = () => {
    const now = ev.sourceManifest(o.root);
    const d = ev.compareManifests(manifest, now);
    return d.equal ? null : `the source tree changed during the run: ${ev.describeDrift(d)}`;
  };

  // A live mutation left from an earlier run would be baked into every copy.
  const live = [...new Set(c.mutations.map((m) => m.file))].filter((f) => {
    try { return fs.readFileSync(path.join(o.root, f), 'utf8').includes('MUTATION'); } catch { return false; }
  });
  if (live.length) {
    failures.push(`live mutation text is present in the source tree: ${live.join(', ')}`);
    return finishWith('rejected', { outcomes: [], controls, proofs });
  }

  // --- Step runner ---------------------------------------------------------
  const runStep = async ({ jobId, worker, kind, args, cwd, env: senv, timeoutMs, name, mutationId, suite, scenario, label }) => {
    stepCounter += 1;
    const n = stepCounter;
    const logRel = path.join('logs', safe(jobId), `${String(n).padStart(5, '0')}-${kind}.log`);
    const token = progress.begin(worker, label || `${kind} ${suite || ''}`.trim());
    events.emit({ event: 'step-start', step: n, kind, jobId, worker, suite, scenario, mutationId, name, log: logRel });
    // A full regression announces each child suite; read the live log so the
    // heartbeat can say which one is running. Progress only, never a verdict.
    const full = args.includes('test/run-tests.js');
    const watch = full ? setInterval(() => annotateFromLog(token, path.join(o.artifacts, logRel)), Math.min(o.heartbeatMs > 0 ? o.heartbeatMs : 5000, 5000)) : null;
    if (watch && watch.unref) watch.unref();
    let run;
    try {
      run = await o.exec({ command: process.execPath, args, cwd, env: senv, timeoutMs, logPath: path.join(o.artifacts, logRel) });
    } finally {
      if (watch) clearInterval(watch);
      progress.end(token);
    }
    const children = full ? childSummary(run) : null;
    return { run, logRel, n, children };
  };
  const annotateFromLog = (token, file) => {
    try {
      const size = fs.statSync(file).size;
      const len = Math.min(size, 262144);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(len);
      try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
      const m = sched.parseChildMarkers(buf.toString('utf8'));
      progress.annotate(token, m.running.length ? `child suite: ${m.running.slice(-2).join(', ')}` : m.finished.length ? `${m.finished.length}+ child suites finished` : '');
    } catch { /* a log not yet written has nothing to say */ }
  };
  const childSummary = (run) => {
    try {
      const m = sched.parseChildMarkers(fs.readFileSync(run.log.path, 'utf8'));
      return { finished: m.finished.length, unfinished: m.running, problems: m.problems, seconds: Object.fromEntries(m.finished.map((c) => [c.label, c.seconds])) };
    } catch { return null; }
  };
  const stepDone = (s, extra) => events.emit({
    event: 'step-finish', step: s.n, durationMs: s.run.durationMs, ...(s.children ? { childSuites: { finished: s.children.finished, unfinished: s.children.unfinished, problems: s.children.problems } } : {}),
    exit: { code: s.run.code, rawCode: s.run.rawCode, signal: s.run.signal || null, timedOut: !!s.run.timedOut, cancelled: !!s.run.cancelled },
    log: s.logRel, ...extra,
  });

  // --- Baseline ------------------------------------------------------------
  let baselineChildSeconds = null;
  const baselineStep = async (label, dir, copyManifest) => {
    const senv = workerEnv(process.env, path.join(o.artifacts, 'work', `${label}-env`), runtime);
    const s = await runStep({ jobId: `baseline-${label}`, worker: 0, kind: 'baseline', args: ['test/run-tests.js'], cwd: dir, env: senv, timeoutMs: o.timeouts.baselineMs, label: `${label} baseline (full regression)` });
    const verdict = judgeBaseline(s.run);
    if (label === 'initial' && s.children) baselineChildSeconds = s.children.seconds;
    const proof = ev.baselineProof({
      label, manifest: copyManifest, runtime, run: s.run, verdict, logRelative: s.logRel.split(path.sep).join('/'), command: 'node test/run-tests.js',
    });
    const proofRel = `baseline/${label}-proof.json`;
    fs.mkdirSync(path.join(o.artifacts, 'baseline'), { recursive: true });
    fs.writeFileSync(path.join(o.artifacts, proofRel), `${JSON.stringify(proof, null, 2)}\n`);
    stepDone(s, { outcome: verdict.ok ? 'clean' : 'red', reason: verdict.reason });
    controls.push({ jobId: `baseline-${label}`, phase: label, ok: verdict.ok, reason: verdict.reason, durationMs: s.run.durationMs, log: s.logRel, counts: { passed: verdict.passed, failed: verdict.failed, skipped: verdict.skipped } });
    proofs.push({ label, file: proofRel });
    return { verdict, run: s.run, proofRel };
  };

  const proofFile = (label) => path.join(o.artifacts, 'baseline', `${label}-proof.json`);
  const proofOk = (label) => ev.validateBaselineProof(proofFile(label), { manifestDigest: manifest.digest, runtimeDigest: runtime.digest, baseDir: o.artifacts });

  let baselineCopyManifest;
  try {
    baselineCopyManifest = o.copyTree(o.root, dirs.baseline, manifest);
  } catch (e) {
    failures.push(`could not make the baseline copy: ${e.message}`);
    return finishWith('rejected', { outcomes: [], controls, proofs });
  }

  if (o.reuseBaseline) {
    const src = path.resolve(o.reuseBaseline.proof);
    const baseDir = path.resolve(o.reuseBaseline.baseDir || path.dirname(path.dirname(src)));
    const v = ev.validateBaselineProof(src, { manifestDigest: manifest.digest, runtimeDigest: runtime.digest, baseDir });
    if (!v.ok) { failures.push(`reused ${v.reason}`); return finishWith('rejected', { outcomes: [], controls, proofs }); }
    const logAbs = path.resolve(baseDir, v.proof.log.path);
    fs.mkdirSync(path.dirname(path.join(o.artifacts, v.proof.log.path)), { recursive: true });
    fs.copyFileSync(logAbs, path.join(o.artifacts, v.proof.log.path));
    fs.mkdirSync(path.join(o.artifacts, 'baseline'), { recursive: true });
    fs.copyFileSync(src, proofFile('initial'));
    proofs.push({ label: 'initial', file: 'baseline/initial-proof.json', reused: true });
    controls.push({ jobId: 'baseline-initial', phase: 'initial', ok: true, reason: '', reused: true, counts: { passed: v.judged.passed, failed: 0, skipped: 0 } });
    log('baseline: REUSED after re-validating its manifest, runtime and log digest');
  } else {
    log('baseline: running the full regression once for this whole run ...');
    const b = await baselineStep('initial', dirs.baseline, baselineCopyManifest);
    if (cancelled) { failures.push('the run was cancelled during the baseline'); return finishWith('incomplete', { outcomes: [], controls, proofs }); }
    if (!b.verdict.ok) {
      failures.push(`the baseline is red: ${b.verdict.reason}`);
      return finishWith('rejected', { outcomes: [], controls, proofs });
    }
    const drift = ev.compareManifests(manifest, ev.sourceManifest(dirs.baseline));
    if (!drift.equal) { failures.push(`the baseline changed its own source copy: ${ev.describeDrift(drift)}`); return finishWith('rejected', { outcomes: [], controls, proofs }); }
    const callerDrift = recheckCaller();
    if (callerDrift) { failures.push(callerDrift); return finishWith('rejected', { outcomes: [], controls, proofs }); }
    const v = proofOk('initial');
    if (!v.ok) { failures.push(v.reason); return finishWith('rejected', { outcomes: [], controls, proofs }); }
    log(`baseline: green, ${b.verdict.passed} passed, 0 failed, 0 skipped (${sched.fmtMs(b.run.durationMs)})`);
  }

  // --- Workers -------------------------------------------------------------
  const workers = new Map(); // slot -> { dir, env }
  const workerFor = (slot) => {
    if (workers.has(slot)) return workers.get(slot);
    const dir = path.join(o.artifacts, 'work', `w${slot + 1}`);
    o.copyTree(o.root, dir, manifest);
    const w = { dir, env: workerEnv(process.env, path.join(o.artifacts, 'work', `w${slot + 1}-env`), runtime) };
    workers.set(slot, w);
    events.emit({ event: 'worker-copy', worker: slot + 1, dir });
    return w;
  };

  const record = (job, entry, verdict, reason, extra = {}) => {
    const out = {
      id: entry.id, index: entry.index, name: entry.mutation.name, file: entry.mutation.file, mustFail: entry.mutation.mustFail,
      suite: job.suite, group: job.key, job: job.id, verdict, reason, ...extra,
    };
    outcomes.set(entry.id, out);
    return out;
  };
  const jobFailsAll = (job, reason) => { for (const e of job.entries) if (!outcomes.has(e.id)) record(job, e, 'error', reason, { notRun: true }); };

  const control = async (job, slot, w, phase) => {
    const s = await runStep({ jobId: job.id, worker: slot + 1, kind: `control-${phase}`, args: job.args, cwd: w.dir, env: w.env, timeoutMs: job.kind === 'full' ? o.timeouts.fullMs : o.timeouts.suiteMs, suite: job.suite, scenario: job.scenario, label: `${job.id} ${phase}-control` });
    const v = judgeControl(s.run);
    stepDone(s, { outcome: v.ok ? 'clean' : 'red', reason: v.reason });
    progress.controlDone(job.id, job.key, s.run.durationMs);
    const rec = { jobId: job.id, phase, ok: v.ok, reason: v.reason, durationMs: s.run.durationMs, log: s.logRel, counts: { passed: v.passed, failed: v.failed, skipped: v.skipped }, required: !!job.controlsOnly };
    controls.push(rec);
    if (!v.ok) log(`  CONTROL RED  ${job.id} ${phase}: ${v.reason}  [${s.logRel}]`);
    return { rec, cancelled: !!s.run.cancelled };
  };

  const runJob = async (job, slot) => {
    if (cancelled) return;
    let w;
    try { w = workerFor(slot); } catch (e) { workers.delete(slot); jobFailsAll(job, `no private copy: ${e.message}`); failures.push(`worker ${slot + 1} copy failed: ${e.message}`); return; }
    const bp = proofOk('initial');
    if (!bp.ok) { jobFailsAll(job, `baseline proof no longer valid: ${bp.reason}`); failures.push(bp.reason); return; }
    progress.startJob(job.id);
    events.emit({ event: 'job-start', job: job.id, worker: slot + 1, mutations: job.entries.length, estimateMs: job.estimateKnown ? job.estimateMs : null });

    let pre = null;
    if (!job.controlsFromBaseline) {
      pre = await control(job, slot, w, 'pre');
      if (!pre.rec.ok) { jobFailsAll(job, `the clean control before this group is not green (${pre.rec.reason}), so no mutant here has a verdict`); progress.mutationAbandoned(job.id, job.entries.length); progress.jobDone(job.id); return; }
    }
    let poisoned = false;
    for (const entry of job.entries) {
      if (cancelled) break;
      if (poisoned) { record(job, entry, 'error', 'not run: an earlier restore in this copy failed', { notRun: true }); progress.mutationAbandoned(job.id); continue; }
      const m = entry.mutation;
      const file = path.join(w.dir, m.file);
      if (!ev.isInside(w.dir, file)) { record(job, entry, 'error', `mutation file ${m.file} leaves the copy`); progress.mutationAbandoned(job.id); continue; }
      let original;
      try { original = fs.readFileSync(file); } catch (e) { record(job, entry, 'error', `cannot read ${m.file}: ${e.code}`); progress.mutationAbandoned(job.id); continue; }
      const text = nl(original.toString('utf8'));
      const find = nl(m.find);
      if (!text.includes(find)) {
        record(job, entry, 'anchor', 'anchor not found; the mutation never ran');
        events.emit({ event: 'step-finish', kind: 'mutation', job: job.id, mutationId: entry.id, outcome: 'anchor' });
        log(`  ANCHOR   ${m.name}`);
        progress.mutationAbandoned(job.id);
        continue;
      }
      let s;
      try {
        fs.writeFileSync(file, text.replace(find, () => nl(m.replace)));
        s = await runStep({ jobId: job.id, worker: slot + 1, kind: 'mutation', args: job.args, cwd: w.dir, env: { ...w.env, MUTANT: '1' }, timeoutMs: job.kind === 'full' ? o.timeouts.fullMs : o.timeouts.suiteMs, suite: job.suite, scenario: job.scenario, name: m.name, mutationId: entry.id, label: `${job.id}: ${m.name}` });
      } finally {
        try { fs.writeFileSync(file, original); } catch { /* verified below */ }
      }
      let restored = false;
      try { restored = fs.readFileSync(file).equals(original); } catch { restored = false; }
      const v = s.run.cancelled ? { verdict: 'error', reason: 'cancelled while this mutant was running' } : classifyRun(s.run, m.mustFail);
      const named = failedNames(s.run.out).slice(0, 5);
      record(job, entry, restored ? v.verdict : 'error', restored ? v.reason : `the mutated file was not restored byte for byte (${m.file}); verdict ${v.verdict} discarded`, {
        durationMs: s.run.durationMs, log: s.logRel, exit: { code: s.run.code, rawCode: s.run.rawCode, signal: s.run.signal || null, timedOut: !!s.run.timedOut }, failed: named,
      });
      stepDone(s, { outcome: outcomes.get(entry.id).verdict, reason: outcomes.get(entry.id).reason, mutationId: entry.id });
      progress.mutationDone(job.id, job.key, s.run.durationMs);
      const snap = outcomes.get(entry.id);
      log(`  ${snap.verdict === 'caught' ? 'caught  ' : snap.verdict.toUpperCase().padEnd(8)} ${m.name}  [${job.id} ${sched.fmtMs(s.run.durationMs)}] ${progress.completed()}/${plan.selected.length}${snap.verdict === 'caught' ? '' : `\n           ${snap.reason}  [${s.logRel}]`}`);
      if (!restored) { poisoned = true; workers.delete(slot); failures.push(`restore of ${m.file} failed in worker ${slot + 1}`); }
    }

    let postOk = true;
    if (!job.controlsFromBaseline && !job.controlsOnly && !cancelled) {
      const post = await control(job, slot, w, 'post');
      postOk = post.rec.ok;
      if (!postOk) {
        for (const e of job.entries) {
          const o2 = outcomes.get(e.id);
          if (o2 && o2.verdict !== 'error') outcomes.set(e.id, { ...o2, observed: o2.verdict, verdict: 'error', reason: `the clean control after this group is not green (${post.rec.reason}), so its verdicts cannot be trusted` });
        }
      }
    }
    if (workers.has(slot) && !poisoned) {
      const d = ev.compareManifests(manifest, ev.sourceManifest(w.dir));
      if (!d.equal) {
        failures.push(`worker ${slot + 1} drifted after ${job.id}: ${ev.describeDrift(d)}`);
        for (const e of job.entries) {
          const o2 = outcomes.get(e.id);
          if (o2) outcomes.set(e.id, { ...o2, observed: o2.verdict, verdict: 'error', reason: `the worker copy no longer matches the source (${ev.describeDrift(d)})` });
        }
        workers.delete(slot);
      }
    }
    progress.jobDone(job.id);
    events.emit({ event: 'job-finish', job: job.id, worker: slot + 1 });
  };

  log(`running ${work.jobs.length} job(s) on ${o.jobs} worker(s), longest first`);
  const pooled = await sched.runPool(work.jobs, o.jobs, runJob, () => cancelled);
  for (const r of pooled) {
    if (r.error) { failures.push(`job ${r.job.id} crashed: ${r.error.message}`); jobFailsAll(r.job, `the job crashed: ${r.error.message}`); }
  }
  if (beat) clearInterval(beat);

  // Account for every selected mutation: one that has no outcome is an ERROR, never silently absent.
  for (const e of plan.selected) {
    if (!outcomes.has(e.id)) {
      const job = work.jobs.find((j) => j.entries.includes(e)) || { suite: e.suite, key: '', id: '' };
      record(job, e, 'error', cancelled ? 'not run: the run was cancelled' : 'never produced an outcome', { notRun: true });
    }
  }
  const ordered = [...outcomes.values()].sort((a, b) => a.index - b.index);

  // --- Final baseline ------------------------------------------------------
  let finalVerdict = { ok: false, reason: 'the final baseline was not run' };
  let timeline = {};
  if (!cancelled && o.finalBaseline) {
    const callerDrift = recheckCaller();
    const copyDrift = ev.compareManifests(manifest, ev.sourceManifest(dirs.baseline));
    if (callerDrift) failures.push(callerDrift);
    if (!copyDrift.equal) failures.push(`the baseline copy drifted before the final baseline: ${ev.describeDrift(copyDrift)}`);
    if (!callerDrift && copyDrift.equal) {
      log('final baseline: one clean full regression of the restored tree ...');
      fs.rmSync(path.join(o.artifacts, 'work', 'final-env'), { recursive: true, force: true });
      const f = await baselineStep('final', dirs.baseline, baselineCopyManifest);
      finalVerdict = f.verdict;
      timeline = { finalBaselineMs: f.run.durationMs };
      const after = ev.compareManifests(manifest, ev.sourceManifest(dirs.baseline));
      if (!after.equal) { finalVerdict = { ok: false, reason: `the final baseline changed its source copy: ${ev.describeDrift(after)}` }; failures.push(finalVerdict.reason); }
      const fv = proofOk('final');
      if (finalVerdict.ok && !fv.ok) { finalVerdict = { ok: false, reason: fv.reason }; failures.push(fv.reason); }
      if (finalVerdict.ok) log(`final baseline: green, ${finalVerdict.passed} passed (${sched.fmtMs(f.run.durationMs)})`);
      else failures.push(`the final baseline is red: ${finalVerdict.reason}`);
    }
  } else if (cancelled) {
    failures.push('the run was cancelled: the evidence is incomplete and is never accepted');
  }
  const lastDrift = recheckCaller();
  if (lastDrift) failures.push(lastDrift);

  const outcomeList = ordered.map((x) => x);
  const tally = {};
  for (const x of outcomeList) tally[x.verdict] = (tally[x.verdict] || 0) + 1;
  const sum = summarise(outcomeList, finalVerdict, plan.selected.length);
  const controlsOnly = !plan.selected.length;
  const selectionOk = controlsOnly ? finalVerdict.ok : sum.accepted;
  const badControls = controls.filter((x) => !x.ok);
  const accepted = !cancelled && selectionOk && !badControls.length && !failures.length && !!o.finalBaseline;
  if (!selectionOk && !cancelled && !controlsOnly) failures.push(`${plan.selected.length - sum.caught} of ${plan.selected.length} selected mutations were not caught by their named test`);
  if (!o.finalBaseline) failures.push('the final baseline was disabled, so the restored tree was never shown clean');
  if (badControls.length) failures.push(`${badControls.length} control run(s) were not clean`);

  // History for the next run: measured costs only.
  try {
    const timings = sched.timingsFromRun(progress.measured());
    if (Object.keys(timings).length || baselineChildSeconds) {
      const doc = { schemaVersion: 1, groups: timings, ...(baselineChildSeconds ? { baselineChildSuiteSeconds: baselineChildSeconds } : {}) };
      fs.writeFileSync(path.join(o.artifacts, 'timings.json'), `${JSON.stringify(doc, null, 2)}\n`);
    }
  } catch { /* the history is an aid, never evidence */ }

  log(`\n${'='.repeat(60)}`);
  log(`${sum.caught}/${plan.selected.length} selected mutations caught  (${summary.scopeLabel}; ${summary.deferredCount} deferred and NOT proven)`);
  const bad = outcomeList.filter((x) => x.verdict !== 'caught');
  if (bad.length) {
    log(`\nNOT CAUGHT (${bad.length}):`);
    for (const x of bad) log(` - [${x.verdict}] ${x.name}\n   ${x.reason}${x.log ? `  [${x.log}]` : ''}`);
  }
  const status = cancelled ? 'incomplete' : accepted ? 'accepted' : 'rejected';
  log(`\n${accepted ? `ACCEPTED (${summary.scopeLabel}${o.scope === 'candidate' ? ': the selected mutations only' : ''}).` : cancelled ? 'INCOMPLETE: cancelled; nothing is accepted.' : `NOT ACCEPTED: ${failures.join('; ')}.`}`);
  return finishWith(status, {
    events: 'events.jsonl', outcomes: outcomeList, tally, controls, proofs, controlsOnly,
    selectedCount: plan.selected.length, plan: summary, timings: timeline, workers: o.jobs,
  });
}

module.exports = { runAcceptance, normaliseOptions, checkedPlan, buildWork, createWorkerCopy, workerEnv, UsageError, TIMEOUTS, defaultJobs };
