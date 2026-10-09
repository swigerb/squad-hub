// The "Start on ACA" dialog, split out of app.js's Wiring section by #200
// (part 4/4 of #165). Pure link-building is unchanged byte-for-byte from the
// original so the mutations in test/mutate.js that target it still match.

import { state, api } from './api.js';
import { $, esc, toast, copyToClipboard } from './util.js';
// Circular by necessity, the same way devices.js's own import of wiring.js is
// (see the comment there), and the same way aca-pending.js's own import of
// this file is: `submitAcaDispatch`/`wireAca` below need `trackAcaDispatch`/
// `startAcaPolling` from the pending-row module, which in turn needs this
// file's `acaRepoName`/`acaStepsForStatus`. Neither module touches the other
// at module-evaluation time, only from inside functions that run later, so
// the cycle resolves the same way any other two ES modules that call back
// into each other do.
import { render } from './devices.js';
import { trackAcaDispatch, startAcaPolling } from './aca-pending.js';

/**
 * Links that start a Squad on ACA run.
 *
 * Squad Hub cannot start a cloud job and holds no credential that could. It
 * emits a URL; the person's own GitHub session does the rest.
 *
 * A NEW ISSUE, not a comment. GitHub prefills a new issue from `title`, `body`
 * and `labels`, and prefills nothing on an existing issue -- a `?body=` after a
 * `#fragment` is never read, so that route opens an empty box and loses the
 * instruction. The dispatch workflow triggers on the label and, with no
 * explicit command, tells the agent to read the issue: so the issue body IS the
 * instruction.
 *
 * This mirrors src/github-link.js. It is duplicated because `web/app.js` has no
 * build step, and routing it through the hub would put the hub in the path of
 * an action it deliberately has no part in. The refusals are the same, and both
 * are tested against the same cases.
 */
const ACA_LABEL = 'squad-aca';

export function acaRepoName(name) {
  const parts = String(name == null ? '' : name).trim().replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) return null;
  const ok = (s) => /^[A-Za-z0-9._-]{1,100}$/.test(s) && !s.startsWith('.') && s !== '..';
  return ok(parts[0]) && ok(parts[1]) ? `${parts[0]}/${parts[1]}` : null;
}

/** The repository a session is checked out from, when it is on GitHub. */
export function acaSessionRepo(session) {
  const git = (session && session.git) || {};
  const host = String(git.host || '').toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  return acaRepoName(git.repository);
}

export function acaTitle(instruction) {
  const one = String(instruction == null ? '' : instruction).trim().replace(/\s*\r?\n\s*/g, ' ');
  if (!one) return null;
  return one.length <= 70 ? one : `${one.slice(0, 67).trimEnd()}\u2026`;
}

export function acaNewIssueLink(repo, instruction) {
  const target = acaRepoName(repo);
  if (!target) return null;
  const body = String(instruction == null ? '' : instruction).trim();
  if (!body) return null;
  const url = `https://github.com/${target}/issues/new`
    + `?title=${encodeURIComponent(acaTitle(body))}`
    + `&body=${encodeURIComponent(body)}`
    + `&labels=${encodeURIComponent(ACA_LABEL)}`;
  // Refused rather than truncated: a truncated instruction is a different
  // instruction that still looks deliberate, on a page that starts compute.
  return url.length > 6000 ? null : url;
}

export function acaComment(prompt) {
  const p = String(prompt == null ? '' : prompt).trim();
  if (!p) return null;
  return `/squad-aca ${p.replace(/\s*\r?\n\s*/g, ' ')}`;
}

export function acaIssueLink(repo, issue) {
  const target = acaRepoName(repo);
  if (!target) return null;
  const n = Number(issue);
  return Number.isInteger(n) && n > 0 ? `https://github.com/${target}/issues/${n}` : null;
}

// ---------------------------------------------------------------------------
// The New ACA job dialog (#178): dispatches directly through
// `POST /api/aca/dispatch` (#177/#213) on a hub with the GitHub App
// configured, and falls back to the two links above (unchanged) when it is
// not -- `GET /api/aca/repos` answering 501 is the normal state until a real
// App is configured, not an error to report loudly (see `acaSetMode`).
// ---------------------------------------------------------------------------

/** `GET /api/aca/repos` / `GET /api/aca/dispatches` are rate-limited to 30/min
 * (#213) and a 429 names how long to wait. Shown verbatim -- the server
 * already composed a human sentence, and a caller re-wording it risks saying
 * something that disagrees with the real retry window. */
function isRateLimited(e) { return e && e.status === 429; }

/** Every field the dialog collects, read straight from the DOM. Kept as one
 * function so `acaBuildDispatchBody` -- the part worth proving in Node --
 * never touches `document` itself. */
function acaFormValues() {
  return {
    repo: $('acaRepo').value,
    baseBranch: $('acaBranch').value,
    issueMode: $('acaIssueModeExisting').checked ? 'existing' : 'new',
    issueNumber: $('acaIssueNumber').value,
    newIssueTitle: $('acaNewIssueTitle').value,
    model: $('acaModel').value,
    reviewer: $('acaReviewer').value,
    publishPr: $('acaPublishPr').checked,
    watchOnly: $('acaWatchOnly').checked,
    prompt: $('acaPrompt').value,
  };
}

/**
 * Validate and shape one `POST /api/aca/dispatch` body from the dialog's
 * fields -- `{ok:true, value}` or `{ok:false, reason}`, the same shape
 * `src/aca-dispatch.js`'s `sanitizeDispatchRequest` returns server-side.
 *
 * This is deliberately a LIGHTER check than the server's: it exists so an
 * empty required field is caught before a network round trip, not so the
 * server's own validation never has to run. The server remains the one place
 * that can refuse a request -- this only saves the obviously-incomplete ones
 * a trip.
 */
export function acaBuildDispatchBody(form = {}) {
  const repo = acaRepoName(form.repo);
  if (!repo) return { ok: false, reason: 'Enter a repository as owner/repo.' };

  const prompt = String(form.prompt == null ? '' : form.prompt).trim();
  if (!prompt) return { ok: false, reason: 'Instructions are required.' };

  const baseBranch = String(form.baseBranch == null ? '' : form.baseBranch).trim();
  const model = String(form.model == null ? '' : form.model).trim();
  const reviewer = String(form.reviewer == null ? '' : form.reviewer).trim();

  const body = {
    repo,
    baseBranch: baseBranch || null,
    prompt,
    model: model || null,
    reviewer: reviewer || null,
    publishPr: form.publishPr !== false,
    watchOnly: !!form.watchOnly,
    issue: null,
    newIssue: null,
  };

  if (form.issueMode === 'existing') {
    const n = Number(form.issueNumber);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, reason: 'Enter the existing issue number.' };
    }
    body.issue = n;
  } else {
    // Defaults to the first line of the instructions, same rule the old
    // fallback issue link already used (`acaTitle`) -- one definition of
    // "what is this called" rather than a second guess invented here.
    const title = String(form.newIssueTitle == null ? '' : form.newIssueTitle).trim() || acaTitle(prompt);
    if (!title) return { ok: false, reason: 'Instructions are required.' };
    body.newIssue = { title };
  }

  return { ok: true, value: body };
}

/** The four steps a dispatch moves through, in order -- see the row this
 * renders into, and the acceptance criteria on issue #178. The hub can only
 * ever observe the first three through GitHub Actions' own run status
 * (`pending` -> `queued` -> `in_progress`); "Attached" is never read off a
 * run at all, it is reported once `acaPendingAttached` finds the session. */
export const ACA_DISPATCH_STEPS = ['Dispatched', 'Lease claimed', 'Starting job', 'Attached'];

/**
 * What to show for one pending dispatch: the status pill, the step row, and
 * a failure reason when there is one. Pure -- given a `status` (as returned
 * by `GET /api/aca/dispatches`, or `null` before the first poll resolves one),
 * whether a real session has already attached, and whether a
 * completed-successfully-but-unattached wait has run past its bound (see
 * `ACA_COMPLETED_WAIT_MS` in aca-pending.js) -- with no DOM and no
 * `Date.now()` here -- so the step mapping below can be proven in Node and a
 * mutation in it actually has somewhere to bite.
 *
 * ONLY TWO THINGS ARE EVER MARKED `done`: "Dispatched" (the `POST` itself
 * already succeeded, or this view would never be reached) and, once
 * `attached` is true, every step including "Attached" (a real session was
 * actually found, see `acaPendingMatch`). GitHub Actions' own `queued` /
 * `in_progress` states are evidence that A RUN EXISTS AND IS PROGRESSING --
 * they are not evidence that this hub's dispatch lease was claimed, or that
 * the ACA job itself has started: a runner can sit `queued` for reasons that
 * have nothing to do with a lease, and a `squad-dispatch.yml` run can go
 * `in_progress` and finish `completed`/`success` while SKIPPING the ACA job
 * entirely because the lease was already held elsewhere (see docs/aca.md).
 * A prior version of this function marked "Lease claimed" done the instant
 * GitHub reported `queued`, and "Starting job" done at `in_progress` --
 * asserting facts about ACA (not Actions) that Actions' own state can never
 * prove. Issue #178's release-gate review caught this. So `queued` and
 * `in_progress` only ever move which step is shown as `current` ("probably
 * in flight"); neither ever marks a prior step `done`.
 *
 * The returned shape also carries `resolved`: true for exactly the two
 * TERMINAL outcomes this function can report -- "Dispatch failed" (an
 * errored dispatch, or a completed run whose conclusion was not `success`)
 * and "Unknown outcome" (a completed-success run whose attach wait expired)
 * -- false for every other branch, including `attached`. This is the ONE
 * place that decides "is this pending dispatch done changing", so
 * `acaPendingRowHtml`'s rendering and `syncAcaPending`'s poll-exclusion
 * (aca-pending.js) both read it from here rather than each re-deriving their
 * own copy of the same three conditions -- the exact divergence a second,
 * hand-maintained copy would eventually drift from this one.
 */
export function acaStepsForStatus(status, attached = false, completedWaitExpired = false) {
  const stepsThrough = (doneCount, currentIndex) => ACA_DISPATCH_STEPS.map((label, i) => ({
    label, done: i < doneCount, current: i === currentIndex,
  }));

  if (attached) {
    return {
      pillLabel: 'Queued on ACA', pillClass: 'q', failed: false, failureReason: null, resolved: false, steps: stepsThrough(4, -1),
    };
  }

  const st = status && status.state;

  if (st === 'error') {
    return {
      pillLabel: 'Dispatch failed', pillClass: 'failed', failed: true, resolved: true,
      failureReason: (status && status.reason) || 'the dispatch failed', steps: stepsThrough(1, -1),
    };
  }

  if (st === 'completed') {
    const ok = (status && status.conclusion) === 'success';
    if (ok && completedWaitExpired) {
      // The one terminal state this hub genuinely cannot resolve on its
      // own: the Actions run finished reporting success, but no `aca-`
      // device ever registered with a matching repository/issue within the
      // bound wait. That could mean the ACA job itself failed after the
      // workflow's own steps succeeded, a slow or never-started device, or
      // a squad-on-aca worker too old to report the `issue` metadata this
      // hub now requires to prove an attach (see acaPendingMatch). Shown as
      // an honest "do not know", never silently left reading "Queued on
      // ACA" forever, and never asserted as a failure this hub has no
      // evidence for. Terminal: there is nothing further this hub can learn
      // by asking GitHub again, so `resolved` is true and `syncAcaPending`
      // stops polling for it -- a person can still force one re-check (see
      // the retry affordance in aca-pending.js).
      return {
        pillLabel: 'Unknown outcome', pillClass: 'stale', failed: false, resolved: true,
        failureReason: 'the Actions run finished successfully, but no ACA session attached in time -- check the run directly',
        steps: stepsThrough(1, -1),
      };
    }
    return {
      pillLabel: ok ? 'Queued on ACA' : 'Dispatch failed',
      pillClass: ok ? 'q' : 'failed',
      failed: !ok,
      // Terminal the instant the run's own conclusion was not `success` --
      // there is no wait to bound here, GitHub has already given its final
      // word. Still within the bounded wait when `ok` is true, so not
      // resolved yet -- the branch above handles it once the wait expires.
      resolved: !ok,
      failureReason: ok ? null : `the Actions run finished (${(status && status.conclusion) || 'no conclusion'}) without the job attaching`,
      // Still only "Dispatched" done -- a successful Actions conclusion is
      // not proof the ACA job itself ran, only that the workflow's own
      // steps did. "Starting job" is shown as the current best guess while
      // the wait above has not yet expired.
      steps: stepsThrough(1, ok ? 2 : -1),
    };
  }

  if (st === 'in_progress') {
    // The Actions run is executing -- real evidence that SOMETHING is
    // happening, never evidence that the lease was claimed or the ACA job
    // itself has started (see the function doc above). Shown as "Starting
    // job" in flight; nothing before it is marked done.
    return {
      pillLabel: 'Queued on ACA', pillClass: 'q', failed: false, failureReason: null, resolved: false, steps: stepsThrough(1, 2),
    };
  }

  if (st === 'queued') {
    // A run exists and is bound to this dispatch -- GitHub Actions has
    // accepted it but not yet started executing it. This is NOT evidence the
    // lease was claimed (that happens inside the job, which has not run
    // yet); shown as "Lease claimed" merely in flight.
    return {
      pillLabel: 'Queued on ACA', pillClass: 'q', failed: false, failureReason: null, resolved: false, steps: stepsThrough(1, 1),
    };
  }

  // `pending` (no Actions run matched yet), or no status has resolved at all
  // -- the first poll has not returned, or this dispatch was just made. The
  // POST itself already succeeded, so "Dispatched" is done; what is left is
  // the lease being claimed by whichever run this becomes.
  return {
    pillLabel: 'Queued on ACA', pillClass: 'q', failed: false, failureReason: null, resolved: false, steps: stepsThrough(1, 1),
  };
}


/** Toggle between the live dispatch form and the "no GitHub App here" note
 * (#178's 501 fallback). The two fallback links stay available either way --
 * they are the ONLY path in the 501 case, and still useful in the enabled
 * case for someone who would rather review on GitHub first. */
function acaSetMode(mode, reason) {
  $('acaForm').hidden = mode !== 'enabled';
  $('acaStart').hidden = mode !== 'enabled';
  $('acaDisabledNote').hidden = mode !== 'disabled';
  if (mode === 'disabled') {
    $('acaDisabledNote').textContent = reason
      || 'This hub has no GitHub App configured, so it cannot start a cloud job directly. Use one of the links below instead.';
  }
}

function fillAcaRepoList(repos) {
  const list = $('acaRepoList');
  list.innerHTML = (repos || []).map((r) => `<option value="${esc(r.fullName)}"></option>`).join('');
}

/** The ✓/✗ line under Repository: whether the GitHub App can see this exact
 * repository, and whether it has `squad-dispatch.yml` -- the two facts that
 * decide whether Start job can possibly work, surfaced before the click
 * rather than only after it fails. */
function updateAcaRepoHint(repos) {
  const name = acaRepoName($('acaRepo').value);
  const hintEl = $('acaRepoHint');
  if (!name) { hintEl.textContent = ''; hintEl.style.color = ''; return; }
  const match = (repos || []).find((r) => r.fullName.toLowerCase() === name.toLowerCase());
  if (!match) {
    hintEl.textContent = '\u2717 Not seen by the Squad Hub GitHub App on this account.';
    hintEl.style.color = 'var(--warn)';
  } else if (match.hasDispatchWorkflow) {
    hintEl.textContent = '\u2713 Squad on ACA installed \u00b7 squad-dispatch.yml found';
    hintEl.style.color = 'var(--ok)';
  } else {
    hintEl.textContent = '\u2717 Squad on ACA installed, but squad-dispatch.yml was not found.';
    hintEl.style.color = 'var(--warn)';
  }
}

function setAcaIssueMode(mode) {
  $('acaNewIssueFields').hidden = mode !== 'new';
  $('acaExistingIssueFields').hidden = mode !== 'existing';
}

/**
 * The visible, selectable `/squad-aca <prompt>` command preview restored by
 * #178's release-gate review: the pre-#178 dialog this one replaced showed
 * the exact command about to be copied, in a `<pre>` a person could select
 * by hand if `acaCopyLink`'s clipboard write failed or was never permitted
 * (the same `.cncmd` pattern `connect.js`'s Connect-a-device dialog already
 * uses for the same reason -- see `acaCmdPreview` in index.html). The
 * redesigned dialog this file originally shipped copied the command on
 * click with NOTHING shown beforehand -- a silent action with no way to
 * recover from a denied clipboard permission short of guessing the syntax
 * from memory. Kept live via an `oninput` on `acaPrompt` (wireAca below),
 * independent of `acaRepo`'s own hint `oninput`.
 */
function updateAcaCmdPreview() {
  const cmd = acaComment($('acaPrompt').value);
  $('acaCmdPreview').textContent = cmd || '/squad-aca \u2026';
}

/**
 * `sessionOverride`, when given, is a `{device, session}` pair to prefill
 * from instead of `state.currentSession` (#170's row-menu "Run on ACA…",
 * which can be opened for a row that is not the one currently open in detail).
 */
export function openAca(sessionOverride) {
  const cur = sessionOverride || state.currentSession;
  $('acaErr').hidden = true;
  $('acaRepo').value = (cur && acaSessionRepo(cur.session)) || '';
  $('acaBranch').value = '';
  $('acaIssueModeNew').checked = true;
  setAcaIssueMode('new');
  $('acaNewIssueTitle').value = '';
  $('acaIssueNumber').value = '';
  $('acaModel').value = '';
  $('acaReviewer').value = '';
  $('acaPublishPr').checked = true;
  $('acaWatchOnly').checked = false;
  $('acaPrompt').value = (cur && cur.session.prompt) || '';
  $('acaRepoHint').textContent = '';
  $('acaScrim').hidden = false;
  updateAcaCmdPreview();
  // Enabled until proven otherwise, the same posture the rest of the hub
  // takes before its first `/api/me` answers: a form that defaults to the
  // disabled note would flash it on every single open, including the
  // overwhelming majority where the App really is configured.
  acaSetMode('enabled');
  $('acaStart').disabled = false;
  $('acaStart').textContent = 'Start job';

  // Triggered by opening the dialog -- a deliberate action, never a page
  // load -- so a 501 here is the documented, expected shape of "no GitHub
  // App on this hub" rather than the silent-console-error failure mode #233
  // broke CI with. `api()` never throws for a well-formed non-2xx JSON
  // response; the `catch` below is what a genuine network failure needs.
  (async () => {
    try {
      const r = await api('/api/aca/repos');
      state.acaRepos = r.repos || [];
      fillAcaRepoList(state.acaRepos);
      updateAcaRepoHint(state.acaRepos);
    } catch (e) {
      if (e.status === 501) { acaSetMode('disabled', e.message); return; }
      if (isRateLimited(e)) {
        acaSetMode('disabled', `${e.message} Use one of the links below for now.`);
        return;
      }
      // Any other failure (offline, 5xx): the form stays up -- the repository
      // list is a convenience, not a precondition, and `acaRepo` is still a
      // plain typeable field. Only the picker's own hint is affected.
      $('acaRepoHint').textContent = `Could not load the repository list: ${e.message}`;
    }
  })();

  ($('acaRepo').value ? $('acaPrompt') : $('acaRepo')).focus();
}

async function submitAcaDispatch() {
  const built = acaBuildDispatchBody(acaFormValues());
  if (!built.ok) {
    $('acaErr').textContent = built.reason;
    $('acaErr').hidden = false;
    return;
  }
  $('acaErr').hidden = true;
  $('acaStart').disabled = true;
  $('acaStart').textContent = 'Starting\u2026';
  try {
    const r = await api('/api/aca/dispatch', { method: 'POST', body: built.value });
    trackAcaDispatch({
      repo: built.value.repo, issue: r.issue && r.issue.number, runUrl: r.runUrl, trackerId: r.trackerId,
    });
    $('acaScrim').hidden = true;
    toast(`Dispatched: #${r.issue && r.issue.number} is queued on ACA. It appears under Cloud until its job attaches.`);
    render();
  } catch (e) {
    $('acaErr').textContent = isRateLimited(e) ? e.message : `Could not start the job: ${e.message}`;
    $('acaErr').hidden = false;
  } finally {
    $('acaStart').disabled = false;
    $('acaStart').textContent = 'Start job';
  }
}

/** Wire the New ACA job dialog's controls. Called once, from wire(). */
export function wireAca() {
  startAcaPolling();
  // Wrapped, not passed directly: `onclick` hands a handler its `MouseEvent`,
  // which `openAca`'s optional `sessionOverride` parameter (#170) would
  // otherwise mistake for one.
  $('dtAca').onclick = () => openAca();
  $('acaCancel').onclick = () => { $('acaScrim').hidden = true; };
  $('acaScrim').onclick = (e) => { if (e.target === $('acaScrim')) $('acaScrim').hidden = true; };
  $('acaIssueModeNew').onchange = () => setAcaIssueMode('new');
  $('acaIssueModeExisting').onchange = () => setAcaIssueMode('existing');
  $('acaRepo').oninput = () => updateAcaRepoHint(state.acaRepos);
  $('acaPrompt').oninput = updateAcaCmdPreview;
  $('acaStart').onclick = submitAcaDispatch;

  // The two fallback links (#178): kept exactly as capable as the dialog
  // they replaced, and the ONLY path when `acaSetMode('disabled')` hides the
  // form above. Built from the same `acaRepo`/`acaPrompt` fields as the full
  // form, so switching to the fallback never means re-typing anything.
  $('acaReviewLink').onclick = (e) => {
    e.preventDefault();
    // Existing-issue mode opens THAT issue (so the `/squad-aca` command
    // below can be pasted as a comment on it); new-issue mode opens a
    // prefilled new issue, same as always. Restored by #178's release-gate
    // review: the redesigned dialog dropped the existing-issue radio's
    // effect on this link entirely, always opening a new issue even when
    // "Existing issue" was selected and a number was typed in.
    const existing = $('acaIssueModeExisting').checked;
    const url = existing
      ? acaIssueLink($('acaRepo').value, $('acaIssueNumber').value)
      : acaNewIssueLink($('acaRepo').value, $('acaPrompt').value);
    if (!url) {
      $('acaErr').textContent = existing
        ? 'Enter a repository as owner/repo, and the existing issue number.'
        : 'Enter a repository as owner/repo, and what it should do.';
      $('acaErr').hidden = false;
      return;
    }
    // `noopener` because the opened page must not get a handle back to this
    // one -- and this one holds the token.
    window.open(url, '_blank', 'noopener');
    $('acaScrim').hidden = true;
  };
  $('acaCopyLink').onclick = async (e) => {
    e.preventDefault();
    const cmd = acaComment($('acaPrompt').value);
    if (!cmd) {
      $('acaErr').textContent = 'Enter what it should do, so there is something to copy.';
      $('acaErr').hidden = false;
      return;
    }
    // The existing boolean-returning helper (util.js), shared with
    // connect.js's Connect-a-device dialog -- restored here rather than the
    // bare `navigator.clipboard.writeText` this dialog's redesign used
    // directly, which left a denied/never-granted clipboard permission
    // looking identical to a successful copy (no visible command, no
    // distinct failure toast wording). `copyToClipboard`'s own textarea
    // fallback plus the honest success/failure toast below is the same
    // recovery path `acaCmdPreview`'s visible text offers by hand.
    toast(await copyToClipboard(cmd) ? 'Command copied' : 'Select and copy the command above');
  };
}
