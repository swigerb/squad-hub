#!/usr/bin/env node
'use strict';
/**
 * `.github/workflows/retro-action-on-red-tests.yml` -- issue #100's durable
 * record, checked as TEXT.
 *
 * The workflow cannot run inside this suite -- it needs a real GitHub Actions
 * event and the `actions/github-script` runtime -- so this follows the same
 * technique `test/deploy-guard-unit.js` already uses for a PowerShell deploy
 * script: read the file as text and assert the guards that matter are
 * actually present, in the right order, rather than trusting that a workflow
 * which LOOKS right behaves right.
 *
 * What actually gets checked, and why each one is a real incident risk and
 * not a hypothetical:
 *   - `cancelled` must be excluded -- issue #100 names three cancelled runs
 *     in the review window that must NOT have produced issues.
 *   - only `push` events count -- a PR's own checks already show a reviewer
 *     the failure; duplicating it as an issue is noise.
 *   - only `main`/`dev` count -- a red run on a feature branch is the
 *     author's own problem, not a team-wide signal.
 *   - the job-level `if` is not the only gate -- `workflow_dispatch` skips it
 *     entirely, so the script step must re-check the REAL run data itself.
 *   - the issue carries the run URL, the branch, and the failing job names,
 *     because "there was a failure" with no way to find it is not a record.
 *   - dedupe is by run id via a marker, not by title text that could collide.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'retro-action-on-red-tests.yml');
const src = fs.readFileSync(WORKFLOW, 'utf8');

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

console.log('retro-action-on-red-tests.yml: a red Tests run leaves a trace');
console.log('='.repeat(60));

check('the workflow reacts to the Tests workflow completing', () => {
  assert.match(src, /workflow_run:\s*\n\s*workflows:\s*\["Tests"\]/,
    'this no longer watches the Tests workflow');
  assert.match(src, /types:\s*\[completed\]/);
});

check('a manual workflow_dispatch with a run_id exists, for proving this after it reaches the default branch', () => {
  assert.match(src, /workflow_dispatch:/);
  assert.match(src, /run_id:/);
});

check('the job-level condition requires conclusion == failure, never cancelled or success', () => {
  const ifBlock = src.slice(src.indexOf('if: >-'), src.indexOf('steps:'));
  assert.match(ifBlock, /workflow_run\.conclusion == 'failure'/);
  assert.ok(!/cancelled/i.test(ifBlock), 'the job condition mentions cancelled at all -- it should simply not match it');
});

check('the job-level condition requires a push event', () => {
  const ifBlock = src.slice(src.indexOf('if: >-'), src.indexOf('steps:'));
  assert.match(ifBlock, /workflow_run\.event == 'push'/,
    'a pull_request-triggered Tests run could pass this condition');
});

check('the job-level condition is restricted to main or dev', () => {
  const ifBlock = src.slice(src.indexOf('if: >-'), src.indexOf('steps:'));
  assert.match(ifBlock, /head_branch == 'main'/);
  assert.match(ifBlock, /head_branch == 'dev'/);
});

check('workflow_dispatch bypasses the job-level if, so the script step re-verifies the REAL run', () => {
  const ifBlock = src.slice(src.indexOf('if: >-'), src.indexOf('steps:'));
  assert.match(ifBlock, /github\.event_name == 'workflow_dispatch'/,
    'workflow_dispatch cannot reach the script step at all, defeating its own purpose');

  const script = src.slice(src.indexOf('script: |'));
  assert.match(script, /getWorkflowRun\(/, 'the script never asks GitHub what the run actually concluded');
  assert.match(script, /run\.conclusion !== 'failure'/,
    'a dispatched run_id that did not actually fail could still open an issue');
  assert.match(script, /run\.event !== 'push'/);
  assert.match(script, /\['main', 'dev'\]\.includes\(run\.head_branch\)/);
});

check('the run is deduped by a marker read back from existing issues, not by title text', () => {
  const script = src.slice(src.indexOf('script: |'));
  assert.match(script, /markerFor\(runId\)/);
  assert.match(script, /hasTestsFailureMarker\(i\.body\)/);
  assert.match(script, /already has a retro-action issue/);
});

check('failing jobs are looked up and included in the issue body', () => {
  const script = src.slice(src.indexOf('script: |'));
  assert.match(script, /listJobsForWorkflowRun\(/);
  assert.match(script, /conclusion === 'failure'/);
  assert.match(script, /Failing job\(s\):/);
});

check('the issue body carries the run URL and the branch', () => {
  const script = src.slice(src.indexOf('script: |'));
  assert.match(script, /run\.html_url/);
  assert.match(script, /run\.head_branch/);
});

check('the issue is labeled retro-action', () => {
  const script = src.slice(src.indexOf('script: |'));
  assert.match(script, /labels:\s*\['retro-action'\]/);
});

check('the issue body points at logging the retrospective before closing it', () => {
  const script = src.slice(src.indexOf('script: |'));
  assert.match(script, /retrospective/i);
  assert.match(script, /retro-action-closure\.js/);
});

check('the closure decision is imported from the shared module, not re-implemented inline', () => {
  // A second, ad-hoc implementation of "which marker means which run" is
  // exactly the kind of duplication that drifts from the tested one.
  assert.match(src, /require\(\s*\n?\s*path\.join\(process\.env\.GITHUB_WORKSPACE, 'scripts', 'retro-action-closure\.js'\)\)/);
});

check('the workflow grants only the permissions it needs', () => {
  assert.match(src, /permissions:/);
  assert.match(src, /issues:\s*write/);
  assert.match(src, /actions:\s*read/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
