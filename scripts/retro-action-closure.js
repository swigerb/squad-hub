'use strict';
/**
 * Which `retro-action` issues opened for a red `Tests` run are ready to close.
 *
 * `.github/workflows/retro-action-on-red-tests.yml` opens an issue for every
 * red `Tests` run on `main`/`dev` and stamps its body with a marker this
 * module recognises. Issue #100's Definition of done requires that closure --
 * "closed when the follow-up retrospective is logged" -- be a real,
 * observable step rather than a promise in prose, so the DECISION of which
 * issues qualify lives here as pure logic: no network call, no `gh`, so it can
 * be proven correct with plain fixtures.
 *
 * The rule: an issue closes once a retrospective has actually been logged
 * (`scripts/retro-enforcement.js` reports "not overdue") AND the issue itself
 * is the kind this closure applies to (open, labeled `retro-action`, carrying
 * the marker this workflow writes). A `retro-action` issue from something
 * OTHER than a red Tests run -- one filed by hand, say -- has no marker and is
 * deliberately left alone; this mechanism only ever closes what it opened.
 *
 * Zero dependencies: only Node's own `child_process` (CLI mode only).
 */

const MARKER_PREFIX = 'retro-action:tests-failure run=';

function markerFor(runId) {
  return `${MARKER_PREFIX}${runId}`;
}

function hasTestsFailureMarker(body) {
  return typeof body === 'string' && body.includes(MARKER_PREFIX);
}

/**
 * issues: [{ number, state, body, labels: [string | {name}] }]
 * retroOverdue: the current verdict from scripts/retro-enforcement.js
 *
 * Returns the subset of `issues` ready to close.
 */
function issuesToClose(issues, { retroOverdue }) {
  if (retroOverdue) return []; // no fresh retrospective logged yet -- nothing closes
  return (issues || []).filter((issue) => {
    if (issue.state && issue.state !== 'open') return false;
    const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
    if (!labels.includes('retro-action')) return false;
    return hasTestsFailureMarker(issue.body);
  });
}

module.exports = { MARKER_PREFIX, markerFor, hasTestsFailureMarker, issuesToClose };

if (require.main === module) {
  // A tiny CLI wrapper around the pure logic above, meant to run as an agenda
  // step of the "Retrospective" ceremony once a retrospective log has just
  // been written: `node scripts/retro-action-closure.js`.
  const { spawnSync } = require('child_process');
  const path = require('path');
  const { isRetroOverdue } = require(path.join(__dirname, 'retro-enforcement.js'));

  const root = process.cwd();
  const logDir = path.join(root, '.squad', 'log');
  const retroOverdue = isRetroOverdue(logDir);

  const list = spawnSync('gh', ['issue', 'list', '--label', 'retro-action', '--state', 'open',
    '--json', 'number,state,body,labels', '--limit', '100'], { encoding: 'utf8' });
  if (list.status !== 0) {
    console.error(`gh issue list failed: ${list.stderr || list.stdout}`);
    process.exit(list.status || 1);
  }

  let issues;
  try { issues = JSON.parse(list.stdout); } catch (e) {
    console.error(`could not parse gh output as JSON: ${e.message}`);
    process.exit(1);
  }

  const toClose = issuesToClose(issues, { retroOverdue });
  if (retroOverdue) {
    console.log('a retrospective has not been logged in the last 7 days -- nothing to close');
    process.exit(0);
  }
  if (!toClose.length) {
    console.log('no open retro-action issue from a red Tests run is waiting on this retrospective');
    process.exit(0);
  }

  for (const issue of toClose) {
    const close = spawnSync('gh', ['issue', 'close', String(issue.number),
      '--comment', 'Closed: the retrospective for this failure has been logged.'], { encoding: 'utf8' });
    if (close.status !== 0) {
      console.error(`could not close #${issue.number}: ${close.stderr || close.stdout}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`closed #${issue.number}`);
  }
}
