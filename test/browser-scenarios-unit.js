'use strict';
/**
 * The independently runnable scenarios of the browser suite
 * (test/helpers/browser-scenarios.js, `node test/browser-e2e-unit.js --scenario <id>`).
 *
 * The scenario registry is what lets the mutation harness replay one mutation
 * against ONE journey instead of the whole two-minute browser run, so it has to
 * be exactly as trustworthy as the index it replaces: every assertion belongs
 * to one scenario, every mutation title maps to one, and a selector that cannot
 * be honoured fails loudly instead of running nothing (or everything) and
 * reading as a pass.
 *
 * Nothing here needs a browser except the last check, which runs the cheapest
 * real scenario end to end when Playwright is installed.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const registry = require('./helpers/browser-scenarios');
const { declaredTitles } = require('./helpers/suite-index');
const { MUTATIONS } = require('./mutate');

const { SCENARIOS, scenarioForTest, scenarioForTestIn, scenarioById, titlesToRun, parseSelection } = registry;

const SUITE = path.join(__dirname, 'browser-e2e-unit.js');
const SUITE_SOURCE = fs.readFileSync(SUITE, 'utf8');
const DECLARED = declaredTitles(SUITE_SOURCE);

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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bscn-'));
/** The browser suite as a child, with a private hub home and no inherited selector. */
function runSuite(args, timeout = 120000) {
  return spawnSync(process.execPath, [SUITE, ...args], {
    encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, SQUAD_HUB_HOME: home },
  });
}
const resultLines = (out) => out.split('\n').filter((l) => l.startsWith('RESULT\t')).map((l) => l.split('\t'));

check('the browser suite declares every one of its checks under a single fixed title', () => {
  const calls = (SUITE_SOURCE.match(/^\s*await check\(/gm) || []).length;
  assert.ok(DECLARED.length > 0, 'no titles were read');
  assert.strictEqual(DECLARED.length, calls, 'a check is titled by something other than one string literal, so no scenario can own it');
  assert.strictEqual(new Set(DECLARED).size, DECLARED.length, 'two checks share a title');
});

check('every scenario has a stable kebab-case id, a summary, and owns at least one assertion', () => {
  assert.ok(Array.isArray(SCENARIOS) && SCENARIOS.length > 1);
  const ids = SCENARIOS.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'two scenarios share an id');
  for (const s of SCENARIOS) {
    assert.match(s.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${s.id}: not a kebab-case id`);
    assert.ok(typeof s.summary === 'string' && s.summary.length > 10, `${s.id}: no summary`);
    assert.ok(Array.isArray(s.titles) && s.titles.length > 0, `${s.id}: owns no assertion`);
    assert.ok(Array.isArray(s.alsoRuns), `${s.id}: alsoRuns is not a list`);
  }
});

check('the registry is frozen, so no caller can change which journey owns a title', () => {
  assert.ok(Object.isFrozen(SCENARIOS));
  for (const s of SCENARIOS) assert.ok(Object.isFrozen(s) && Object.isFrozen(s.titles) && Object.isFrozen(s.alsoRuns), s.id);
});

check('every assertion in the browser suite is owned by exactly one scenario, and no scenario owns one that does not exist', () => {
  const owned = SCENARIOS.flatMap((s) => s.titles);
  assert.strictEqual(new Set(owned).size, owned.length, 'a title is owned by two scenarios');
  assert.deepStrictEqual(owned.filter((t) => !DECLARED.includes(t)), [], 'a scenario names an assertion the suite does not declare');
  assert.deepStrictEqual(DECLARED.filter((t) => !owned.includes(t)), [], 'an assertion belongs to no scenario');
  assert.strictEqual(owned.length, DECLARED.length);
});

check('what a scenario also runs is real, not its own, and not repeated', () => {
  for (const s of SCENARIOS) {
    assert.deepStrictEqual(s.alsoRuns.filter((t) => !DECLARED.includes(t)), [], `${s.id}: alsoRuns names an assertion the suite does not declare`);
    assert.deepStrictEqual(s.alsoRuns.filter((t) => s.titles.includes(t)), [], `${s.id}: alsoRuns repeats an owned assertion`);
    assert.strictEqual(new Set(s.alsoRuns).size, s.alsoRuns.length, `${s.id}: alsoRuns repeats itself`);
  }
});

check('every mutation that names a browser assertion maps to exactly one scenario that owns it', () => {
  const browser = MUTATIONS.filter((m) => DECLARED.includes(m.mustFail));
  assert.ok(browser.length > 0, 'no mutation names a browser assertion, so this proves nothing');
  const unplaced = browser.filter((m) => {
    const s = scenarioForTest(m.mustFail);
    return !s || !s.titles.includes(m.mustFail);
  }).map((m) => `${m.name}: ${m.mustFail}`);
  assert.deepStrictEqual(unplaced, [], 'a mutation names an assertion no scenario owns');
  console.log(`         (${browser.length} mutations over ${new Set(browser.map((m) => scenarioForTest(m.mustFail).id)).size} scenarios)`);
});

check('scenarioForTest places a title, and refuses an unknown, empty, non-string or ambiguous one', () => {
  const first = SCENARIOS[0];
  assert.strictEqual(scenarioForTest(first.titles[0]), first);
  for (const bad of ['no such assertion anywhere', '', null, undefined, 7, {}, [first.titles[0]]]) {
    assert.strictEqual(scenarioForTest(bad), null, `placed ${JSON.stringify(bad)}`);
  }
  // The same title owned by two scenarios cannot be placed on either.
  const twice = [{ id: 'a', titles: ['t'], alsoRuns: [] }, { id: 'b', titles: ['t', 'u'], alsoRuns: [] }];
  assert.strictEqual(scenarioForTestIn(twice, 't'), null);
  assert.strictEqual(scenarioForTestIn(twice, 'u').id, 'b');
  // A title a scenario merely also runs is not owned by it.
  const only = [{ id: 'a', titles: ['t'], alsoRuns: ['u'] }];
  assert.strictEqual(scenarioForTestIn(only, 'u'), null);
  assert.strictEqual(scenarioForTest(`${first.titles[0]} `), null, 'a title is matched exactly, not loosely');
});

check('a scenario runs its own assertions first, then the ones it also needs, with none twice', () => {
  for (const s of SCENARIOS) {
    const run = titlesToRun(s);
    assert.deepStrictEqual(run.slice(0, s.titles.length), s.titles, s.id);
    assert.strictEqual(new Set(run).size, run.length, `${s.id}: an assertion would run twice`);
    assert.strictEqual(run.length, s.titles.length + s.alsoRuns.length, s.id);
  }
});

check('a scenario that ends on the main page\'s CSP check has signed that page in first', () => {
  const sign = DECLARED[0];
  assert.match(sign, /signs in/);
  const csp = DECLARED.find((t) => /^the whole suite ran under the enforced CSP/.test(t));
  assert.ok(csp, 'the CSP check was renamed');
  const judged = SCENARIOS.filter((s) => titlesToRun(s).includes(csp));
  assert.ok(judged.length > 1);
  for (const s of judged) {
    assert.ok(titlesToRun(s).includes(sign), `${s.id} judges the main page's CSP without ever signing it in`);
  }
});

check('the selector: no argument runs everything, a known id selects one scenario', () => {
  assert.deepStrictEqual(parseSelection([]), { scenario: null });
  assert.deepStrictEqual(parseSelection(undefined), { scenario: null });
  const s = SCENARIOS[3];
  assert.strictEqual(parseSelection(['--scenario', s.id]).scenario, s);
  assert.strictEqual(parseSelection([`--scenario=${s.id}`]).scenario, s);
  assert.deepStrictEqual(parseSelection(['--list-scenarios']), { list: true });
  assert.strictEqual(scenarioById(s.id), s);
});

check('the selector rejects a missing, empty, unknown, repeated or unrecognised one, never running zero or all', () => {
  const id = SCENARIOS[0].id;
  const bad = [
    ['--scenario'], ['--scenario', ''], ['--scenario='], ['--scenario', '--list-scenarios'],
    ['--scenario', 'no-such-scenario'], ['--scenario', id.toUpperCase()], ['--scenario', ` ${id}`],
    ['--scenario', id, '--scenario', id], ['--scenario', id, `--scenario=${SCENARIOS[1].id}`],
    ['--scenario', id, '--list-scenarios'], [id], ['--scenarios', id], ['--only', id], ['--scenario', id, 'extra'],
  ];
  for (const argv of bad) {
    const got = parseSelection(argv);
    assert.ok(got.error, `${JSON.stringify(argv)} was accepted as ${JSON.stringify(got)}`);
    assert.strictEqual(got.scenario, undefined, JSON.stringify(argv));
    assert.strictEqual(got.list, undefined, JSON.stringify(argv));
  }
  assert.strictEqual(scenarioById('no-such-scenario'), null);
  assert.strictEqual(scenarioById(undefined), null);
});

check('the suite process refuses a bad selector with a nonzero exit before it starts anything', () => {
  for (const args of [['--scenario'], ['--scenario', 'no-such-scenario'], ['--scenario', SCENARIOS[0].id, '--scenario', SCENARIOS[0].id],
    ['--scenario='], ['--bogus']]) {
    const r = runSuite(args, 30000);
    const out = `${r.stdout}${r.stderr}`;
    assert.strictEqual(r.status, 2, `${args.join(' ')} exited ${r.status}`);
    assert.match(out, /^ERROR: /m, `${args.join(' ')} gave no explicit error`);
    assert.deepStrictEqual(resultLines(out), [], `${args.join(' ')} still produced results`);
    assert.doesNotMatch(out, /browser end-to-end|\d+ passed/, `${args.join(' ')} began running the suite`);
  }
});

check('--list-scenarios prints the registry as JSON and runs nothing', () => {
  const r = runSuite(['--list-scenarios'], 30000);
  assert.strictEqual(r.status, 0, r.stderr);
  const listed = JSON.parse(r.stdout);
  assert.deepStrictEqual(listed.map((s) => s.id), SCENARIOS.map((s) => s.id));
  assert.deepStrictEqual(listed.map((s) => s.titles), SCENARIOS.map((s) => s.titles));
  assert.deepStrictEqual(resultLines(r.stdout), []);
});

check('requiring the metadata launches no browser, opens no port, mints no credential and runs no check', () => {
  const probe = `
    const seen = [];
    const hook = (obj, name, label) => { const real = obj[name]; obj[name] = function () { seen.push(label); return real.apply(this, arguments); }; };
    const cp = require('child_process'); ['spawn', 'spawnSync', 'exec', 'execSync', 'fork', 'execFile', 'execFileSync'].forEach((n) => hook(cp, n, 'child_process.' + n));
    const net = require('net'); hook(net.Server.prototype, 'listen', 'net.listen'); hook(net, 'connect', 'net.connect');
    const crypto = require('crypto'); ['generateKeyPairSync', 'randomBytes', 'createSign'].forEach((n) => hook(crypto, n, 'crypto.' + n));
    const fs = require('fs'); ['writeFileSync', 'mkdtempSync', 'mkdirSync', 'appendFileSync'].forEach((n) => hook(fs, n, 'fs.' + n));
    const before = new Set(Object.keys(require.cache));
    const mod = require(${JSON.stringify(path.join(__dirname, 'helpers', 'browser-scenarios.js'))});
    const loaded = Object.keys(require.cache).filter((k) => !before.has(k));
    process.stdout.write(JSON.stringify({ seen, loaded, scenarios: mod.SCENARIOS.length, argv: process.argv.length, handles: process._getActiveHandles().length }));
  `;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 30000, env: { ...process.env, SQUAD_HUB_HOME: home } });
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepStrictEqual(got.seen, [], 'importing did something with side effects');
  assert.strictEqual(got.loaded.length, 1, `importing loaded more than itself: ${got.loaded.join(', ')}`);
  assert.ok(!got.loaded.some((f) => /playwright|[\\/]src[\\/]/.test(f)));
  assert.ok(got.scenarios > 1);
});

let hasPlaywright = true;
try { require.resolve('playwright', { paths: [__dirname] }); } catch { hasPlaywright = false; }

if (!hasPlaywright) {
  console.log('  SKIP a selected scenario runs exactly its own assertions plus the ones it needs, in a real browser (playwright is not installed)');
  console.log('RESULT\tskip\ta selected scenario runs exactly its own assertions plus the ones it needs, in a real browser (playwright is not installed)');
} else {
  check('a selected scenario runs exactly its own assertions plus the ones it needs, in a real browser', () => {
    const s = scenarioById('sign-out');
    const r = runSuite(['--scenario', s.id]);
    const out = `${r.stdout}${r.stderr}`;
    const results = resultLines(out);
    assert.strictEqual(r.status, 0, out.slice(-600));
    const expected = titlesToRun(s).slice().sort((a, b) => DECLARED.indexOf(a) - DECLARED.indexOf(b));
    assert.deepStrictEqual(results.map((x) => x[2]), expected, 'the scenario did not run exactly its set, in file order');
    assert.ok(results.every((x) => x[1] === 'ok'), JSON.stringify(results.filter((x) => x[1] !== 'ok')));
    const unrelated = DECLARED.filter((t) => !expected.includes(t) && out.includes(t));
    assert.deepStrictEqual(unrelated, [], 'an unrelated journey ran');
    assert.match(out, new RegExp(`scenario ${s.id}: ${s.titles.length} owned and ${s.alsoRuns.length} prerequisite assertions`));
    assert.match(out, new RegExp(`\\n${expected.length} passed, 0 failed\\n`));
  });
}

try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* private temp dir */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
