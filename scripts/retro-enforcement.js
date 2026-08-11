#!/usr/bin/env node
'use strict';
/**
 * Whether the "Retrospective with Enforcement" ceremony is overdue.
 *
 * `.squad/ceremonies.md` defines the trigger as:
 *
 *   No *retrospective* log in .squad/log/ within the last 7 days
 *
 * That condition had no ground truth: `.squad/log/` did not exist, no
 * retrospective log existed anywhere, and the "enforcement skill" it named
 * (`retro-enforcement`, `Test-RetroOverdue`) was never present in the
 * workspace. A trigger nobody can evaluate is vacuously true forever, which is
 * indistinguishable from never firing at all (issue #99).
 *
 * This is the ground truth, checked directly against the filesystem:
 *
 *   - No `.squad/log/` directory at all           -> OVERDUE
 *   - The directory exists but holds no retro log  -> OVERDUE
 *   - The newest retrospective log is >7 days old  -> OVERDUE
 *   - The newest retrospective log is <=7 days old -> not overdue
 *
 * The 7-day boundary is inclusive: a log logged EXACTLY 7 days ago still
 * counts as "within the last 7 days".
 *
 * The scribe's charter (`.squad/agents/scribe/charter.md`) names the log
 * filename convention directly: `log/{timestamp}-{topic}.md`, with `:`
 * replaced by `-` in the timestamp so the name is valid on every platform,
 * e.g. `2026-06-02T21-15-30Z-retrospective-with-enforcement.md`. The
 * TIMESTAMP IN THE FILENAME is what is trusted here, not the file's mtime --
 * mtime is rewritten by a checkout, a clone, or a CI runner restoring a cache,
 * none of which means a retrospective happened just now. The filename is the
 * one thing the scribe actually wrote at retrospective time.
 *
 * A log only counts as a RETROSPECTIVE log if its topic mentions "retro"
 * (case-insensitive) -- an ordinary session log ("2026-06-02T10-00-00Z-api.md")
 * must not silently satisfy a ceremony about retrospectives.
 *
 * Zero dependencies: only Node's own `fs` and `path`.
 *
 * Usage (round-start, from ceremonies.md's "Coordinator integration"):
 *   node scripts/retro-enforcement.js
 *     -> prints OVERDUE or "not overdue" and the last retrospective found,
 *        exits 1 when overdue, 0 otherwise.
 *
 *   node scripts/retro-enforcement.js --root <dir>   look under <dir>/.squad/log
 *   node scripts/retro-enforcement.js --now <ISO>    evaluate as of <ISO> (testing)
 */

const fs = require('fs');
const path = require('path');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// log/{timestamp}-{topic}.md, timestamp = an ISO instant with ':' -> '-'.
// Captured separately so the date portion's hyphens are never mistaken for
// the time portion's (which is what gets converted back to colons).
const LOG_FILENAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?Z-(.+)\.md$/;

function isRetroTopic(topic) {
  return /retro/i.test(topic);
}

/** Parse a log filename into { topic, timestampMs }, or null if it does not match the convention. */
function parseLogFilename(filename) {
  const m = LOG_FILENAME.exec(filename);
  if (!m) return null;
  const [, date, hh, mm, ss, frac, topic] = m;
  const iso = `${date}T${hh}:${mm}:${ss}${frac || ''}Z`;
  const timestampMs = Date.parse(iso);
  if (Number.isNaN(timestampMs)) return null;
  return { filename, topic, timestampMs };
}

/** Every retrospective log under logDir, oldest first. Missing/empty dir -> []. */
function listRetroLogs(logDir) {
  let entries;
  try { entries = fs.readdirSync(logDir); } catch { return []; }
  return entries
    .map(parseLogFilename)
    .filter((e) => e && isRetroTopic(e.topic))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

/** The most recent retrospective log under logDir, or null if there is none. */
function mostRecentRetroLog(logDir) {
  const logs = listRetroLogs(logDir);
  return logs.length ? logs[logs.length - 1] : null;
}

/**
 * Overdue when there is no retrospective log, or the newest one is more than
 * 7 days older than `now`. Absent/empty log directory counts as overdue --
 * that is the fix for issue #99: the old condition could never be FALSE
 * before a retrospective had ever happened, and never TRUE after one had.
 */
function isRetroOverdue(logDir, now = Date.now()) {
  const latest = mostRecentRetroLog(logDir);
  if (!latest) return true;
  return now - latest.timestampMs > SEVEN_DAYS_MS;
}

module.exports = {
  SEVEN_DAYS_MS, parseLogFilename, listRetroLogs, mostRecentRetroLog, isRetroOverdue,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

  const root = flag('--root') || process.cwd();
  const nowArg = flag('--now');
  const now = nowArg ? Date.parse(nowArg) : Date.now();
  if (Number.isNaN(now)) {
    console.error(`--now was not a parseable date: ${nowArg}`);
    process.exit(2);
  }

  const logDir = path.join(root, '.squad', 'log');
  const latest = mostRecentRetroLog(logDir);
  const overdue = isRetroOverdue(logDir, now);

  if (latest) {
    console.log(`last retrospective log: ${latest.filename} (${new Date(latest.timestampMs).toISOString()})`);
  } else {
    console.log('no retrospective log found');
  }
  console.log(overdue ? 'OVERDUE' : 'not overdue');
  process.exit(overdue ? 1 : 0);
}
