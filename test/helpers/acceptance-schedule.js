'use strict';
/**
 * Grouping, scheduling and progress for the acceptance runner.
 *
 * A mutation is judged against ONE standalone suite (or one browser scenario).
 * That suite needs a clean run before its mutants and another after, so the
 * unit of scheduling is a GROUP of mutations that share a suite, cut into
 * contiguous chunks only when a chunk's controls are cheaper than the
 * parallelism they buy.
 *
 * Scheduling is deterministic and lossless: the same selection and the same
 * timing history always give the same job order (longest first, ties broken by
 * key), every selected mutation lands in exactly one chunk, and workers just
 * take the next job. The history only moves ESTIMATES and ORDER. A group it has
 * never seen is still run; it is simply ordered by a pessimistic prior and left
 * out of the ETA rather than being given an invented rate.
 */

const BROWSER_SUITE = 'browser-e2e-unit.js';
const FULL_SUITE = 'run-tests.js';

// Used to ORDER jobs that have no history. Never shown as an estimate.
const ORDER_PRIOR = Object.freeze({
  suite: { controlMs: 10000, mutationMs: 3000 },
  scenario: { controlMs: 60000, mutationMs: 20000 },
  full: { controlMs: 500000, mutationMs: 500000 },
});

/**
 * Where a selected mutation runs: `{ key, kind, suite, scenario, args }`.
 *
 * `kind` is `suite` (a standalone child suite), `scenario` (one browser
 * scenario, whole fixture and journey) or `full` (no standalone owner, so the
 * entire regression; its cost is reported, never hidden). A browser title with
 * no scenario falls back to the whole browser suite, kind `suite`.
 */
function placeEntry(entry, scenarioFor) {
  const suite = entry.suite || null;
  if (!suite || suite === FULL_SUITE) return { key: FULL_SUITE, kind: 'full', suite: FULL_SUITE, scenario: null, args: [`test/${FULL_SUITE}`] };
  if (suite === BROWSER_SUITE && typeof scenarioFor === 'function') {
    let found = null;
    try { found = scenarioFor(entry.mutation.mustFail); } catch { found = null; }
    const id = found && (typeof found === 'string' ? found : found.id);
    if (typeof id === 'string' && id) {
      return { key: `${suite}#${id}`, kind: 'scenario', suite, scenario: id, args: [`test/${suite}`, '--scenario', id] };
    }
  }
  return { key: suite, kind: 'suite', suite, scenario: null, args: [`test/${suite}`] };
}

/** Group the selected entries by where they run, each group in catalogue order. */
function buildGroups(selected, scenarioFor) {
  const groups = new Map();
  for (const entry of selected) {
    const place = placeEntry(entry, scenarioFor);
    if (!groups.has(place.key)) groups.set(place.key, { ...place, entries: [] });
    groups.get(place.key).entries.push(entry);
  }
  for (const g of groups.values()) g.entries.sort((a, b) => a.index - b.index);
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** `{ controlMs, mutationMs, known }` for a group: its history when there is one, else the ordering prior. */
function costOf(group, history) {
  const h = history && history[group.key];
  if (h) return { controlMs: h.controlMs, mutationMs: h.mutationMs, known: true };
  return { ...ORDER_PRIOR[group.kind], known: false };
}

/**
 * Cut groups into jobs. A full-suite group is never cut (its controls are the
 * baselines, and there is nothing to amortise). With one worker nothing is cut.
 * Otherwise a chunk holds as many mutations as fit the target cost, or
 * `maxChunk` when the cost is unknown, so a 300-mutation suite does not pin one
 * worker while the others idle. Every chunk pays its own pair of controls.
 */
function buildJobs(groups, { jobs = 1, history = {}, maxChunk = 40, targetMs = null } = {}) {
  const out = [];
  const all = groups.map((g) => ({ g, cost: costOf(g, history) }));
  const total = all.reduce((s, { g, cost }) => s + (cost.controlMs * (g.kind === 'full' ? 0 : 2)) + cost.mutationMs * g.entries.length, 0);
  const target = targetMs || (jobs > 1 ? Math.max(30000, total / (jobs * 3)) : Infinity);
  for (const { g, cost } of all) {
    let size = g.entries.length;
    if (g.kind !== 'full' && jobs > 1) {
      const byCost = cost.known && cost.mutationMs > 0
        ? Math.max(1, Math.floor((target - 2 * cost.controlMs) / cost.mutationMs))
        : maxChunk;
      size = Math.max(1, Math.min(maxChunk, byCost));
    }
    const n = Math.max(1, Math.ceil(g.entries.length / size));
    const even = Math.ceil(g.entries.length / n);
    for (let c = 0; c < n; c += 1) {
      const entries = g.entries.slice(c * even, (c + 1) * even);
      if (!entries.length) continue;
      out.push({
        id: n === 1 ? g.key : `${g.key}~${c + 1}of${n}`,
        key: g.key, kind: g.kind, suite: g.suite, scenario: g.scenario, args: g.args, entries,
        controlsFromBaseline: g.kind === 'full',
        estimateMs: (g.kind === 'full' ? 0 : 2 * cost.controlMs) + cost.mutationMs * entries.length,
        estimateKnown: cost.known,
      });
    }
  }
  return orderJobs(out);
}

/** Longest estimated job first; ties by id, so the order never depends on input order. */
function orderJobs(jobs) {
  return [...jobs].sort((a, b) => b.estimateMs - a.estimateMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Run `worker(job, slot)` over `jobs` with at most `n` in flight, taking jobs
 * in the given order. Resolves when every job's promise has settled; a worker
 * that throws is recorded as that job's failure instead of ending the run.
 * `shouldStop()` stops NEW jobs from starting.
 */
async function runPool(jobs, n, worker, shouldStop = () => false) {
  const queue = [...jobs];
  const results = [];
  const lanes = Array.from({ length: Math.max(1, Math.min(n, queue.length || 1)) }, async (_, slot) => {
    while (queue.length && !shouldStop()) {
      const job = queue.shift();
      try { results.push({ job, value: await worker(job, slot) }); } catch (error) { results.push({ job, error }); }
    }
  });
  await Promise.all(lanes);
  return results;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const MIN_SAMPLES = 3;

// run-tests.js brackets every child suite it launches with exactly these lines.
const CHILD_START = /^\[child-suite\] start (.+?)\s*$/;
const CHILD_END = /^\[child-suite\] end (.+?) \((\d+(?:\.\d+)?)s\)\s*$/;

/**
 * What a run-tests.js log says about its child suites: `finished` (label and
 * measured seconds), `running` (started, no end yet, in start order) and
 * `problems` (an end with no start, a second start, a repeated end). It only
 * describes progress and timing; it never decides a verdict.
 */
function parseChildMarkers(text) {
  const open = new Map();
  const finished = [];
  const problems = [];
  const seen = new Set();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m = CHILD_START.exec(line);
    if (m) {
      if (open.has(m[1]) || seen.has(m[1])) problems.push(`child suite "${m[1]}" started twice`);
      else open.set(m[1], true);
      seen.add(m[1]);
      continue;
    }
    m = CHILD_END.exec(line);
    if (m) {
      if (!open.has(m[1])) problems.push(`child suite "${m[1]}" ended without an open start`);
      else { open.delete(m[1]); finished.push({ label: m[1], seconds: Number(m[2]) }); }
    }
  }
  return { finished, running: [...open.keys()], problems };
}
/** Whole-run progress, measured from the steps that actually finished. */
function createProgress({ jobs, totalMutations, history = {}, now = Date.now, workers = 1 }) {
  const stats = new Map(); // key -> { mutationMs: [], controlMs: [] }
  const active = new Map(); // token -> { worker, label, startedAt }
  let completed = 0;
  let nextToken = 0;
  const pending = new Map(jobs.map((j) => [j.id, { key: j.key, mutations: j.entries.length, controls: j.controlsFromBaseline ? 0 : 2, started: false }]));
  const bucket = (key) => { if (!stats.has(key)) stats.set(key, { mutationMs: [], controlMs: [] }); return stats.get(key); };
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

  return {
    begin(worker, label) { nextToken += 1; active.set(nextToken, { worker, label, startedAt: now(), detail: '' }); return nextToken; },
    annotate(token, detail) { const a = active.get(token); if (a) a.detail = detail; },
    end(token) { active.delete(token); },
    startJob(jobId) { const p = pending.get(jobId); if (p) p.started = true; },
    mutationDone(jobId, key, ms) {
      completed += 1; bucket(key).mutationMs.push(ms);
      const p = pending.get(jobId); if (p) p.mutations -= 1;
    },
    mutationAbandoned(jobId, count = 1) { const p = pending.get(jobId); if (p) p.mutations = Math.max(0, p.mutations - count); },
    controlDone(jobId, key, ms) {
      bucket(key).controlMs.push(ms);
      const p = pending.get(jobId); if (p) p.controls = Math.max(0, p.controls - 1);
    },
    jobDone(jobId) { pending.delete(jobId); },
    completed: () => completed,
    measured: () => stats,

    /** `{ state, etaMs, basis }`. `state` is `warming-up`, `unknown` or `estimate`; never a guess presented as a number. */
    eta() {
      const all = [...stats.values()];
      const measuredMutations = all.flatMap((s) => s.mutationMs);
      const measuredControls = all.flatMap((s) => s.controlMs);
      let remaining = 0;
      let unpriced = 0;
      const live = measuredMutations.length >= MIN_SAMPLES;
      for (const p of pending.values()) {
        const s = stats.get(p.key);
        const h = history[p.key];
        const mutMs = live && s && s.mutationMs.length ? mean(s.mutationMs)
          : h ? h.mutationMs
            : live ? mean(measuredMutations) : null;
        const ctlMs = s && s.controlMs.length ? mean(s.controlMs)
          : h ? h.controlMs
            : measuredControls.length >= 1 ? mean(measuredControls) : null;
        if (p.mutations > 0) { if (mutMs === null) unpriced += p.mutations; else remaining += mutMs * p.mutations; }
        if (p.controls > 0) { if (ctlMs === null) unpriced += p.controls; else remaining += ctlMs * p.controls; }
      }
      const left = [...pending.values()].filter((p) => p.mutations > 0 || p.controls > 0).length;
      if (!left) return { state: 'estimate', etaMs: 0, basis: 'nothing left to run' };
      if (unpriced > 0) {
        return measuredMutations.length < MIN_SAMPLES
          ? { state: 'warming-up', etaMs: null, basis: `${measuredMutations.length}/${MIN_SAMPLES} measured mutation steps, and no history for ${unpriced} remaining step(s)` }
          : { state: 'unknown', etaMs: null, basis: `${unpriced} remaining step(s) have no measurement or history` };
      }
      const lanes = Math.max(1, Math.min(workers, left));
      const basis = `measured ${measuredMutations.length} mutation and ${measuredControls.length} control step(s)${Object.keys(history).length ? ' plus history' : ''}, over ${lanes} worker(s)`;
      return { state: 'estimate', etaMs: Math.round(remaining / lanes), basis };
    },

    snapshot() {
      const t = now();
      return {
        completed, total: totalMutations,
        active: [...active.values()].map((a) => ({ worker: a.worker, label: a.label, detail: a.detail, elapsedMs: t - a.startedAt })),
        eta: this.eta(),
      };
    },
  };
}

const fmtMs = (ms) => {
  if (ms === null || ms === undefined) return 'n/a';
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
    : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

/** One heartbeat line: what is running, how far along, and an honest ETA. */
function heartbeatLine(snap) {
  const run = snap.active.length
    ? snap.active.map((a) => `w${a.worker} ${a.label} ${fmtMs(a.elapsedMs)}${a.detail ? ` [${a.detail}]` : ''}`).join('; ')
    : 'idle';
  const eta = snap.eta.state === 'estimate' ? `ETA ~${fmtMs(snap.eta.etaMs)} (${snap.eta.basis})` : `ETA ${snap.eta.state}: ${snap.eta.basis}`;
  return `heartbeat ${snap.completed}/${snap.total} mutations done; active: ${run}; ${eta}`;
}

/** The timings a later run can use: per group, the mean control and mutation cost measured now. */
function timingsFromRun(measured) {
  const groups = {};
  for (const [key, s] of measured) {
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    if (s.mutationMs.length && s.controlMs.length) {
      groups[key] = { controlMs: Math.round(mean(s.controlMs)), mutationMs: Math.round(mean(s.mutationMs)), samples: s.mutationMs.length };
    }
  }
  return groups;
}

module.exports = {
  BROWSER_SUITE, FULL_SUITE, MIN_SAMPLES, placeEntry, buildGroups, costOf, buildJobs, orderJobs,
  runPool, createProgress, heartbeatLine, fmtMs, timingsFromRun, parseChildMarkers,
};
