#!/usr/bin/env node
'use strict';
/**
 * `scripts/retro-enforcement.js` -- the ground truth issue #99 says the
 * "Retrospective with Enforcement" ceremony never had.
 *
 * The old condition ("No retrospective log in .squad/log/ within the last 7
 * days") could not be evaluated: the directory did not exist, no retrospective
 * log existed anywhere, and the skill named to check it was never present.
 * That made the trigger vacuously true forever -- indistinguishable from a
 * trigger that never fires at all. These tests are about making sure the
 * REPLACEMENT actually has ground truth in all four states that matter:
 * directory absent, directory empty, directory with only non-retro logs, and
 * directory with a real retrospective log at various ages around the 7-day
 * boundary.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'retro-enforcement.js');
const {
  parseLogFilename, listRetroLogs, mostRecentRetroLog, isRetroOverdue, SEVEN_DAYS_MS,
} = require(SCRIPT);

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

/** A scratch .squad/log directory, populated with the given filenames. */
function logDirWith(filenames = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqretro-'));
  for (const f of filenames) fs.writeFileSync(path.join(dir, f), '# log entry\n');
  return dir;
}

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0); // 2026-08-10T12:00:00Z
const iso = (offsetMs) => new Date(NOW - offsetMs).toISOString().replace(/:/g, '-');
const retroLog = (offsetMs, topic = 'retrospective-with-enforcement') => `${iso(offsetMs)}-${topic}.md`;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

console.log('retro-enforcement: ground truth for the overdue trigger');
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// The states issue #99 says had none: absent, empty, populated with the
// wrong thing.
// ---------------------------------------------------------------------------

check('a .squad/log/ that does not exist at all is OVERDUE', () => {
  const missing = path.join(os.tmpdir(), 'sqretro-does-not-exist-' + Date.now());
  assert.strictEqual(fs.existsSync(missing), false, 'the fixture accidentally exists');
  assert.strictEqual(isRetroOverdue(missing, NOW), true);
  assert.strictEqual(mostRecentRetroLog(missing), null);
});

check('a .squad/log/ that exists but is empty is OVERDUE', () => {
  const dir = logDirWith([]);
  assert.strictEqual(isRetroOverdue(dir, NOW), true);
});

check('a log directory holding only NON-retro logs is still OVERDUE', () => {
  // A session log about API work must not silently satisfy a ceremony about
  // retrospectives.
  const dir = logDirWith([
    `${iso(HOUR)}-api-work.md`,
    `${iso(2 * HOUR)}-daemon-fixes.md`,
  ]);
  assert.strictEqual(isRetroOverdue(dir, NOW), true);
  assert.strictEqual(listRetroLogs(dir).length, 0, 'a non-retro log was counted as a retrospective');
});

// ---------------------------------------------------------------------------
// The 7-day boundary -- EXACT, per the design decision. Right at 7 days is
// still "within the last 7 days"; a millisecond past it is not.
// ---------------------------------------------------------------------------

check('a retrospective logged 1 hour ago is NOT overdue', () => {
  const dir = logDirWith([retroLog(HOUR)]);
  assert.strictEqual(isRetroOverdue(dir, NOW), false);
});

check('a retrospective logged EXACTLY 7 days ago is NOT overdue (inclusive boundary)', () => {
  const dir = logDirWith([retroLog(SEVEN_DAYS_MS)]);
  assert.strictEqual(isRetroOverdue(dir, NOW), false,
    'exactly 7 days must still count as "within the last 7 days"');
});

check('a retrospective logged 7 days and 1ms ago IS overdue', () => {
  const dir = logDirWith([retroLog(SEVEN_DAYS_MS + 1)]);
  assert.strictEqual(isRetroOverdue(dir, NOW), true);
});

check('a retrospective logged 8 days ago IS overdue', () => {
  const dir = logDirWith([retroLog(8 * DAY)]);
  assert.strictEqual(isRetroOverdue(dir, NOW), true);
});

// ---------------------------------------------------------------------------
// Only the MOST RECENT retrospective log decides the answer.
// ---------------------------------------------------------------------------

check('an old retrospective plus a fresh one is NOT overdue -- the newest wins', () => {
  const dir = logDirWith([retroLog(30 * DAY), retroLog(HOUR)]);
  assert.strictEqual(isRetroOverdue(dir, NOW), false);
});

check('a fresh non-retro log cannot rescue a stale retrospective', () => {
  const dir = logDirWith([retroLog(30 * DAY), `${iso(HOUR)}-unrelated-session.md`]);
  assert.strictEqual(isRetroOverdue(dir, NOW), true,
    'a recent SESSION log satisfied the retrospective condition');
});

check('mostRecentRetroLog reports the newest one by filename timestamp', () => {
  const dir = logDirWith([retroLog(30 * DAY), retroLog(HOUR), retroLog(2 * DAY)]);
  const latest = mostRecentRetroLog(dir);
  assert.strictEqual(latest.filename, retroLog(HOUR));
});

// ---------------------------------------------------------------------------
// Filename parsing -- the scribe's convention, and what does not match it.
// ---------------------------------------------------------------------------

check('a well-formed scribe filename parses to the right instant', () => {
  const parsed = parseLogFilename('2026-06-02T21-15-30Z-retrospective.md');
  assert.ok(parsed, 'a valid filename failed to parse');
  assert.strictEqual(parsed.timestampMs, Date.parse('2026-06-02T21:15:30Z'));
  assert.strictEqual(parsed.topic, 'retrospective');
});

check('a filename with no time component does not parse', () => {
  assert.strictEqual(parseLogFilename('2026-06-02-retrospective.md'), null);
});

check('a non-.md file does not parse', () => {
  assert.strictEqual(parseLogFilename('2026-06-02T21-15-30Z-retrospective.txt'), null);
});

check('the topic match for "retro" is case-insensitive', () => {
  const dir = logDirWith([`${iso(HOUR)}-RETROSPECTIVE-Q3.md`]);
  assert.strictEqual(isRetroOverdue(dir, NOW), false);
});

check('"retro" must appear in the topic, not merely be a coincidental substring elsewhere', () => {
  // Sanity: a topic that genuinely has nothing to do with retrospectives.
  const dir = logDirWith([`${iso(HOUR)}-daemon-fixes.md`]);
  assert.strictEqual(listRetroLogs(dir).length, 0);
});

// ---------------------------------------------------------------------------
// The CLI itself -- what round-start actually runs.
// ---------------------------------------------------------------------------

check('the CLI exits 1 and prints OVERDUE against an empty log directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqretro-root-'));
  fs.mkdirSync(path.join(root, '.squad', 'log'), { recursive: true });
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /OVERDUE/);
});

check('the CLI exits 0 and prints "not overdue" with a fresh retrospective log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqretro-root-'));
  const dir = path.join(root, '.squad', 'log');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, retroLog(HOUR)), '# retro\n');
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--now', new Date(NOW).toISOString()], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /not overdue/);
});

check('the CLI reports OVERDUE when .squad/log/ does not exist at all on a fresh root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqretro-root-'));
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /no retrospective log found/);
});

// ---------------------------------------------------------------------------
// The repository's OWN foundation for this check (issue #99's other half):
// .squad/log/ must exist and be tracked, and ceremonies.md must name the
// real, runnable check rather than an absent skill.
// ---------------------------------------------------------------------------

check('.squad/log/ exists on disk in this worktree', () => {
  assert.ok(fs.existsSync(path.join(ROOT, '.squad', 'log')), '.squad/log/ is missing');
});

check('.squad/log/.gitkeep is tracked by git (not merely present on disk)', () => {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', '.squad/log/.gitkeep'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `.gitkeep is not tracked: ${r.stdout}${r.stderr}`);
});

check('.gitignore ignores real log files but explicitly keeps .gitkeep', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /^\.squad\/log\/\*$/m, '.gitignore no longer ignores log FILES under .squad/log/');
  assert.match(gi, /^!\.squad\/log\/\.gitkeep$/m, '.gitignore no longer negates .gitkeep');
});

check('git itself ignores a real log file but not .gitkeep', () => {
  const ignoredLog = spawnSync('git', ['check-ignore', '.squad/log/some-session.md'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(ignoredLog.status, 0, 'a real log file under .squad/log/ is no longer ignored');
  const keptGitkeep = spawnSync('git', ['check-ignore', '.squad/log/.gitkeep'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(keptGitkeep.status, 1, '.gitkeep is being ignored, so it could never be committed');
});

check('ceremonies.md points at the real script, not the absent skill issue #99 found', () => {
  const ceremonies = fs.readFileSync(path.join(ROOT, '.squad', 'ceremonies.md'), 'utf8');
  assert.match(ceremonies, /node scripts\/retro-enforcement\.js/,
    'ceremonies.md no longer names a command that can actually be run');
  assert.ok(!/Test-RetroOverdue/.test(ceremonies) && !/\*\*Enforcement skill\*\*/.test(ceremonies),
    'ceremonies.md still references the nonexistent retro-enforcement skill/Test-RetroOverdue');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
