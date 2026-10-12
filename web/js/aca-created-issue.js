// What the New ACA job dialog does when a dispatch fails AFTER the hub created
// the issue for it (#253, F4), split out of aca.js for the per-module size
// budget (see test/package-unit.js's "no web/js file is anywhere near the old
// single-file size").
//
// Circular with aca.js by necessity, the same way aca-pending.js is: it reads
// the dialog's own form helpers, and aca.js's `submitAcaDispatch` calls in here.
// Neither module touches the other at module-evaluation time, only from inside
// functions that run later.

import { $, esc, toast } from './util.js';
import {
  acaRepoName, acaIssueLink, acaFormValues, acaDialogIsCurrent, setAcaIssueMode,
} from './aca.js';

/**
 * The issue a FAILED dispatch had already created, or `null`. `POST
 * /api/aca/dispatch` answers a failure that happened after it created an issue
 * for `newIssue` with that issue's `{number, url}` in the error body (see
 * `GitHubApp.dispatch`). Only the number is trusted, and only when the request
 * that failed asked for a NEW issue and the number is a positive integer: an
 * Existing-issue request created nothing, so it never claims otherwise, and
 * anything unrecognised is the ordinary failure. The link is rebuilt from the
 * submitted repository and that number, never taken from the response.
 */
export function acaCreatedIssueOf(e, submitted) {
  if (!submitted || submitted.issue != null || !submitted.newIssue) return null;
  const meta = e && e.body && e.body.issue;
  const number = meta && meta.number;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;
  const link = acaIssueLink(submitted.repo, number);
  return link ? { repo: submitted.repo, number, link } : null;
}

function acaCreatedIssueNote(created, retry) {
  const ref = `${created.repo}#${created.number}`;
  return `Issue ${ref} was already created, but its workflow dispatch failed or was not confirmed, `
    + `so no job is known to have started. ${retry}`;
}

function showAcaCreatedIssueError(e, created, retry) {
  const ref = `${created.repo}#${created.number}`;
  $('acaErr').innerHTML = `${esc(`Could not start the job: ${e.message}`)}<br>${esc(acaCreatedIssueNote(created, retry))} `
    + `<a href="${esc(created.link)}" target="_blank" rel="noopener noreferrer">${esc(ref)}</a>`;
  $('acaErr').hidden = false;
}

/**
 * A dispatch failed after creating `created` for a New-issue request. Retrying
 * as a new issue would create a second one, so the form moves to that issue --
 * but only while it still is the form that was submitted: this dialog open,
 * same repository, still New-issue mode. Anything else (closed or reopened
 * dialog, another repository, a mode the person already changed) is reported
 * without touching the form, so the number is never bound to a different
 * repository or over what the person typed.
 */
export function reportAcaCreatedIssueFailure(e, created, generation) {
  if (!acaDialogIsCurrent(generation)) {
    toast(`Could not start the previous job: ${e.message} `
      + acaCreatedIssueNote(created, 'Retry on that issue, not as a new one.'));
    return;
  }
  const form = acaFormValues();
  const untouched = acaRepoName(form.repo) === created.repo && form.issueMode === 'new';
  if (untouched) {
    $('acaIssueModeExisting').checked = true;
    setAcaIssueMode('existing');
    $('acaIssueNumber').value = String(created.number);
  }
  showAcaCreatedIssueError(e, created, untouched
    ? `Existing issue #${created.number} is selected, so Start job retries on it without creating another.`
    : `The form changed while this ran, so it was left as you set it. To retry on it, use Existing issue ${created.number} with ${created.repo}.`);
}