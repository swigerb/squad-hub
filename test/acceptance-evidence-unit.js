'use strict';
/**
 * The evidence the acceptance runner trusts (test/helpers/acceptance-evidence.js):
 * how source and runtime are identified, what makes a baseline proof usable, and
 * what a finished report must hold before anyone may rely on it.
 *
 * The proofs here are built from real log files, so "the log was edited", "the
 * status contradicts the log" and "the proof is for other source" are exercised
 * as the runner would meet them, not as flags on a stub.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ev = require('./helpers/acceptance-evidence');

let pass = 0; let fail = 0;
function check(name, fn) {
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-ev-'));
let serial = 0;
const fresh = (label) => { const d = path.join(TMP, `${label}-${(serial += 1)}`); fs.mkdirSync(d, { recursive: true }); return d; };
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Test Author', '-c', 'user.email=author@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

function repo() {
  const root = fresh('repo');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'subject');
  return root;
}

const GREEN = 'ok one\n  ok two\n3 passed, 0 failed  (1s)\n';
const RUNTIME = { digest: 'r'.repeat(64) };

/** A proof built from a log of the given text and the given raw process outcome. */
function makeProof({ dir = fresh('art'), out = GREEN, code = 0, signal = null, timedOut = false, cancelled = false, error = null, manifest, runtime = RUNTIME, verdict, logName = 'logs/baseline.log', label = 'initial', mangle } = {}) {
  const logAbs = path.resolve(dir, logName);
  fs.mkdirSync(path.dirname(logAbs), { recursive: true });
  fs.writeFileSync(logAbs, out);
  const buf = fs.readFileSync(logAbs);
  const run = {
    code, rawCode: code, signal, timedOut, cancelled, error, startedAt: 1000, finishedAt: 2000, durationMs: 1000,
    log: { path: logAbs, bytes: buf.length, sha256: ev.sha256(buf) },
  };
  const { judgeBaseline } = require('./helpers/verdict');
  const judged = verdict || judgeBaseline({ ...run, out, error: error ? new Error(error) : null });
  const proof = ev.baselineProof({ label, manifest: manifest || { digest: 'm'.repeat(64), files: [], head: 'h' }, runtime, run, verdict: judged, logRelative: logName, command: 'node test/run-tests.js' });
  const file = path.join(dir, `${label}-proof.json`);
  fs.writeFileSync(file, JSON.stringify(mangle ? mangle(proof) : proof, null, 2));
  return { dir, file, logAbs };
}
const validate = (p, over = {}) => ev.validateBaselineProof(p.file, { manifestDigest: 'm'.repeat(64), runtimeDigest: RUNTIME.digest, baseDir: p.dir, ...over });

check('canonical JSON and digests do not depend on key order, and any change moves the digest', () => {
  assert.strictEqual(ev.digestOf({ b: 1, a: [{ d: 1, c: 2 }] }), ev.digestOf({ a: [{ c: 2, d: 1 }], b: 1 }));
  assert.notStrictEqual(ev.digestOf({ a: 1 }), ev.digestOf({ a: 2 }));
  assert.strictEqual(ev.canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.strictEqual(ev.sha256('x').length, 64);
});

check('the source manifest is content-based: tracked, dirty and untracked files count, ignored files do not, mtimes do not', () => {
  const root = repo();
  const base = ev.sourceManifest(root);
  assert.deepStrictEqual(base.files.map((f) => f.path), ['.gitignore', 'src/a.js', 'src/b.js']);
  assert.ok(/^[0-9a-f]{40}$/.test(base.head));
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'x');
  assert.strictEqual(ev.sourceManifest(root).digest, base.digest, 'an ignored file is not source');
  const past = new Date(2001, 0, 1);
  fs.utimesSync(path.join(root, 'src', 'a.js'), past, past);
  assert.strictEqual(ev.sourceManifest(root).digest, base.digest, 'touching a file is not changing it');
  fs.writeFileSync(path.join(root, 'src', 'new.js'), 'x');
  const added = ev.sourceManifest(root);
  assert.notStrictEqual(added.digest, base.digest);
  assert.deepStrictEqual(ev.compareManifests(base, added), { equal: false, added: ['src/new.js'], removed: [], changed: [], count: 1 });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 9;\n');
  fs.rmSync(path.join(root, 'src', 'b.js'));
  const drift = ev.compareManifests(base, ev.sourceManifest(root));
  assert.deepStrictEqual([drift.changed, drift.added, drift.removed], [['src/a.js', 'src/b.js'], ['src/new.js'], []]);
  assert.ok(ev.sourceManifest(root).files.find((f) => f.path === 'src/b.js').sha256 === null, 'a deletion is recorded');
  assert.deepStrictEqual(ev.compareManifests(base, base), { equal: true, added: [], removed: [], changed: [], count: 0 });
  assert.match(ev.describeDrift(drift), /changed: src\/a\.js, src\/b\.js; added: src\/new\.js/);
});

check('the manifest fails loudly on a directory that is not a repository instead of describing nothing', () => {
  assert.throws(() => ev.sourceManifest(fresh('plain')), /git .* failed/);
});

check('containment compares whole path segments: a sibling that shares a prefix is outside', () => {
  const a = fresh('a'); const ab = `${a}b`; fs.mkdirSync(ab);
  assert.strictEqual(ev.isInside(a, a), true);
  assert.strictEqual(ev.isInside(a, path.join(a, 'x', 'y')), true);
  assert.strictEqual(ev.isInside(a, ab), false);
  assert.strictEqual(ev.isInside(path.join(a, 'x'), a), false);
  assert.strictEqual(ev.isInside(a, path.join(a, '..', path.basename(ab))), false);
});

check('the runtime identity is stable, names the toolchain, and changes with the browser environment', () => {
  const root = repo();
  const a = ev.runtimeIdentity(root, {});
  assert.strictEqual(a.digest, ev.runtimeIdentity(root, {}).digest);
  assert.strictEqual(a.node, process.version);
  assert.strictEqual(a.platform, process.platform);
  assert.notStrictEqual(ev.runtimeIdentity(root, { PLAYWRIGHT_BROWSERS_PATH: 'x' }).digest, a.digest);
  assert.notStrictEqual(ev.runtimeIdentity(root, { NODE_OPTIONS: '--no-warnings' }).digest, a.digest);
  assert.ok(a.playwright === null || (typeof a.playwright.version === 'string' && fs.existsSync(a.playwright.modulesDir)));
});

check('a green, finished, nonempty, unskipped baseline with an intact log is a usable proof', () => {
  const p = makeProof();
  const v = validate(p);
  assert.strictEqual(v.ok, true, v.reason);
  assert.deepStrictEqual([v.judged.passed, v.judged.failed, v.judged.skipped], [3, 0, 0]);
  assert.strictEqual(v.proof.log.sha256, ev.sha256(fs.readFileSync(p.logAbs)));
});

check('a proof is not usable for other source, another runtime, or after it was edited', () => {
  const p = makeProof();
  assert.match(validate(p, { manifestDigest: 'x'.repeat(64) }).reason, /different source: the tree drifted or the proof is stale/);
  assert.match(validate(p, { runtimeDigest: 'x'.repeat(64) }).reason, /different runtime or dependency set/);
  const edited = JSON.parse(fs.readFileSync(p.file, 'utf8'));
  edited.verdict.passed = 4000;
  fs.writeFileSync(p.file, JSON.stringify(edited));
  assert.match(validate(p).reason, /digest does not match its content/);
  fs.writeFileSync(p.file, '{ truncated');
  assert.match(validate(p).reason, /unreadable or corrupt/);
  assert.match(validate({ ...p, file: path.join(p.dir, 'absent.json') }).reason, /unreadable or corrupt/);
  fs.writeFileSync(p.file, JSON.stringify({ kind: 'report', schemaVersion: 1 }));
  assert.match(validate(p).reason, /not a schema 1 baseline proof/);
});

check('the log is evidence: one changed byte, a truncation or a missing file voids the proof', () => {
  for (const [label, damage, re] of [
    ['same length, different bytes', (f) => fs.writeFileSync(f, GREEN.replace('3 passed', '9 passed')), /no longer matches the recorded digest/],
    ['truncated', (f) => fs.writeFileSync(f, GREEN.slice(0, 10)), /no longer matches the recorded digest/],
    ['appended', (f) => fs.appendFileSync(f, '\n'), /no longer matches the recorded digest/],
    ['missing', (f) => fs.rmSync(f), /its log is missing/],
  ]) {
    const p = makeProof();
    damage(p.logAbs);
    assert.match(validate(p).reason, re, label);
  }
});

check('a log path that leaves the artifact directory is refused even when the proof is validly sealed', () => {
  const dir = fresh('art');
  const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.log`);
  const p = makeProof({ dir, logName: path.relative(dir, outside).split(path.sep).join('/') });
  try { assert.match(validate(p).reason, /leaves the artifact directory/); } finally { fs.rmSync(outside, { force: true }); }
});

check('a baseline is judged from the raw process outcome and the log, never from a pass flag or a status integer alone', () => {
  const cases = [
    ['a timeout that still reports status 0', { timedOut: true }, /timed out/],
    ['a signal with status 0', { signal: 'SIGKILL' }, /killed by SIGKILL/],
    ['a spawn error', { error: 'EPERM', code: null }, /did not finish/],
    ['no status at all', { code: null }, /did not finish/],
    ['a nonzero exit', { code: 1 }, /exited 1/],
    ['a cancelled run', { cancelled: true }, /cancelled/],
    ['zero tests', { out: '0 passed, 0 failed  (0s)\n' }, /ran no tests/],
    ['a skip', { out: '5 passed, 0 failed, 1 SKIPPED  (1s)\n' }, /SKIPPED/],
    ['a failure', { out: '5 passed, 1 failed  (1s)\n', code: 0 }, /1 test failed/],
    ['no summary (an interrupted log)', { out: 'ok one\nok two\n' }, /no "N passed, M failed" summary/],
  ];
  for (const [label, over, re] of cases) {
    const p = makeProof(over);
    const v = validate(p);
    assert.strictEqual(v.ok, false, label);
    assert.match(v.reason, re, label);
  }
});

check('a sealed proof whose recorded verdict contradicts its own log is refused', () => {
  const p = makeProof({ verdict: { ok: true, passed: 99, failed: 0, skipped: 0 } });
  assert.match(validate(p).reason, /recorded counts contradict its own log/);
  const q = makeProof({ verdict: { ok: false, passed: 3, failed: 0, skipped: 0 } });
  assert.match(validate(q).reason, /recorded counts contradict/);
});

check('the event log is append-only JSONL with a sequence and a timestamp per line', () => {
  const file = path.join(fresh('ev'), 'events.jsonl');
  let t = 0;
  const log = ev.createEventLog(file, () => (t += 1000));
  log.emit({ event: 'step-start', step: 1 });
  log.emit({ event: 'step-finish', step: 1, durationMs: 5 });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => [l.seq, l.event]), [[1, 'step-start'], [2, 'step-finish']]);
  assert.strictEqual(lines[1].ts, new Date(2000).toISOString());
  assert.strictEqual(log.count(), 2);
});

// --- Reports ---------------------------------------------------------------

function reportFixture(over = {}, { proofs = 2, manifestDigest = 'm'.repeat(64), proofDigest = manifestDigest } = {}) {
  const dir = fresh('report');
  const refs = [];
  for (const label of ['initial', 'final'].slice(0, proofs)) {
    makeProof({ dir, label, logName: `logs/${label}.log`, manifest: { digest: proofDigest, files: [], head: 'h' } });
    refs.push({ label, file: `${label}-proof.json` });
  }
  const outcomes = [1, 2].map((i) => ({ id: `id${i}`, index: i, name: `m${i}`, verdict: 'caught' }));
  const report = ev.sealReport({
    schemaVersion: 1, scope: 'candidate', scopeLabel: 'candidate-selected', manifestDigest, runtimeDigest: RUNTIME.digest,
    status: 'accepted', accepted: true, incomplete: false, selectedCount: 2, deferredCount: 3, outcomes,
    controls: [{ ok: true }], proofs: refs, ...over,
  });
  const file = path.join(dir, 'report.json');
  fs.writeFileSync(file, JSON.stringify(report));
  return { dir, file, report };
}
const verify = (f, scope = 'candidate', digest = 'm'.repeat(64)) => ev.verifyReport(f.file, { expectedScope: scope, manifestDigest: digest });

check('an intact accepted report for the expected scope and the same source is verified', () => {
  const f = reportFixture();
  const v = verify(f);
  assert.strictEqual(v.ok, true, v.reason);
  assert.strictEqual(v.report.scopeLabel, 'candidate-selected');
});

check('a report is refused for another scope, an unknown scope, other source, or any edit after sealing', () => {
  const f = reportFixture();
  assert.match(verify(f, 'exhaustive').reason, /candidate-selected report, not a exhaustive one/);
  assert.match(verify(f, 'everything').reason, /not one of candidate, exhaustive/);
  assert.match(ev.verifyReport(f.file, { expectedScope: undefined }).reason, /not one of candidate, exhaustive/);
  assert.match(verify(f, 'candidate', 'z'.repeat(64)).reason, /made for different source/);
  const doc = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  doc.selectedCount = 1;
  fs.writeFileSync(f.file, JSON.stringify(doc));
  assert.match(verify(f).reason, /digest does not match its content/);
  fs.writeFileSync(f.file, 'not json');
  assert.match(verify(f).reason, /unreadable or corrupt/);
  const unknown = reportFixture({ scope: 'everything', scopeLabel: 'everything' });
  assert.match(verify(unknown).reason, /unknown scope "everything"/);
  const lying = reportFixture({ scopeLabel: 'exhaustive' });
  assert.match(verify(lying).reason, /scope label contradicts its scope/);
});

check('an exhaustive report cannot be a candidate result in disguise', () => {
  const ex = reportFixture({ scope: 'exhaustive', scopeLabel: 'exhaustive', deferredCount: 0 });
  assert.strictEqual(verify(ex, 'exhaustive').ok, true);
  assert.match(verify(ex, 'candidate').reason, /exhaustive report, not a candidate-selected one/);
  const deferring = reportFixture({ scope: 'exhaustive', scopeLabel: 'exhaustive', deferredCount: 1 });
  assert.match(verify(deferring, 'exhaustive').reason, /may not defer mutations/);
});

check('a report that is not accepted, is incomplete, or has an uncaught, missing or repeated outcome is refused', () => {
  const bad = (over, re) => assert.match(verify(reportFixture(over)).reason, re);
  bad({ status: 'rejected', accepted: false }, /status is rejected, not accepted/);
  bad({ status: 'incomplete', accepted: false, incomplete: true }, /status is incomplete/);
  bad({ incomplete: true }, /marked incomplete/);
  bad({ outcomes: [{ id: 'a', verdict: 'caught' }, { id: 'b', name: 'm2', verdict: 'escaped' }] }, /1 outcome\(s\) are not caught, e\.g\. m2: escaped/);
  bad({ outcomes: [{ id: 'a', verdict: 'caught' }, { id: 'b', verdict: 'error' }] }, /not caught/);
  bad({ selectedCount: 3 }, /2 outcomes for 3 selected mutations/);
  bad({ outcomes: [], selectedCount: 0 }, /holds no mutation outcomes/);
  bad({ outcomes: [{ id: 'a', verdict: 'caught' }, { id: 'a', verdict: 'caught' }] }, /repeats a mutation id/);
  bad({ controls: [{ ok: true }, { ok: false }] }, /1 control\(s\) were not clean/);
  assert.strictEqual(verify(reportFixture({ outcomes: [], selectedCount: 0, controlsOnly: true })).ok, true, 'a controls-only run is a stated case');
});

check('a report must carry both baselines and each must still validate against its source', () => {
  assert.match(verify(reportFixture({}, { proofs: 1 })).reason, /fewer than two baseline proofs/);
  const stale = reportFixture({}, { manifestDigest: 'q'.repeat(64), proofDigest: 'm'.repeat(64) });
  assert.match(verify(stale, 'candidate', 'q'.repeat(64)).reason, /initial-proof\.json is not usable: it was made for different source/);
  const f = reportFixture();
  fs.appendFileSync(path.join(f.dir, 'logs', 'final.log'), 'tampered\n');
  assert.match(verify(f).reason, /final-proof\.json is not usable: its log no longer matches/);
  const g = reportFixture();
  fs.rmSync(path.join(g.dir, 'initial-proof.json'));
  assert.match(verify(g).reason, /initial-proof\.json is not usable: unreadable or corrupt/);
});

check('timing history only orders and estimates: missing, corrupt and malformed history is a warning, never an error', () => {
  const dir = fresh('hist');
  assert.deepStrictEqual(ev.readHistory(null), { groups: {}, warning: null });
  assert.match(ev.readHistory(path.join(dir, 'none.json')).warning, /no timing history/);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ nope');
  assert.match(ev.readHistory(path.join(dir, 'bad.json')).warning, /unreadable/);
  fs.writeFileSync(path.join(dir, 'h.json'), JSON.stringify({ groups: { ok: { controlMs: 1, mutationMs: 2, samples: 3 }, neg: { controlMs: -1, mutationMs: 2 }, str: { controlMs: '1', mutationMs: 2 }, nul: null } }));
  const h = ev.readHistory(path.join(dir, 'h.json'));
  assert.deepStrictEqual(h.groups, { ok: { controlMs: 1, mutationMs: 2, samples: 3 } });
  assert.strictEqual(h.warning, null);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
