// The "Start on ACA" dialog, split out of app.js's Wiring section by #200
// (part 4/4 of #165). Pure link-building is unchanged byte-for-byte from the
// original so the mutations in test/mutate.js that target it still match.

import { state, api } from './api.js';
import { $, esc, toast } from './util.js';
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
 * by `GET /api/aca/dispatches`, or `null` before the first poll resolves one)
 * and whether a real session has already attached, with no DOM and no
 * `Date.now()` -- so the step mapping below can be proven in Node and a
 * mutation in it actually has somewhere to bite.
 */
export function acaStepsForStatus(status, attached = false) {
  const stepsThrough = (doneCount, currentIndex) => ACA_DISPATCH_STEPS.map((label, i) => ({
    label, done: i < doneCount, current: i === currentIndex,
  }));

  if (attached) {
    return {
      pillLabel: 'Queued on ACA', pillClass: 'q', failed: false, failureReason: null, steps: stepsThrough(4, -1),
    };
  }

  const st = status && status.state;

  if (st === 'error') {
    return {
      pillLabel: 'Dispatch failed', pillClass: 'failed', failed: true,
      failureReason: (status && status.reason) || 'the dispatch failed', steps: stepsThrough(1, -1),
    };
  }

  if (st === 'completed') {
    const ok = (status && status.conclusion) === 'success';
    return {
      pillLabel: ok ? 'Queued on ACA' : 'Dispatch failed',
      pillClass: ok ? 'q' : 'failed',
      failed: !ok,
      failureReason: ok ? null : `the Actions run finished (${(status && status.conclusion) || 'no conclusion'}) without the job attaching`,
      steps: stepsThrough(ok ? 3 : 1, ok ? 3 : -1),
    };
  }

  if (st === 'in_progress') {
    // The Actions run is executing, which is the ACA job starting up -- by
    // the time it reports in_progress "Starting job" is done; what is left
    // is only the attach this hub has not seen yet.
    return {
      pillLabel: 'Queued on ACA', pillClass: 'q', failed: false, failureReason: null, steps: stepsThrough(3, 3),
    };
  }

  if (st === 'queued') {
    // A run exists and is bound to this dispatch (the lease is claimed);
    // GitHub Actions just has not started it yet.
    return {
      pillLabel: 'Queued on ACA', pillClass: 'q', failed: false, failureReason: null, steps: stepsThrough(2, 2),
    };
  }

  // `pending` (no Actions run matched yet), or no status has resolved at all
  // -- the first poll has not returned, or this dispatch was just made. The
  // POST itself already succeeded, so "Dispatched" is done; what is left is
  // the lease being claimed by whichever run this becomes.
  return {
    pillLabel: 'Queued on ACA', pillClass: 'q', failed: false, failureReason: null, steps: stepsThrough(1, 1),
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

export function openAca() {
  const cur = state.currentSession;
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
    trackAcaDispatch({ repo: built.value.repo, issue: r.issue && r.issue.number, runUrl: r.runUrl });
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
  $('dtAca').onclick = openAca;
  $('acaCancel').onclick = () => { $('acaScrim').hidden = true; };
  $('acaScrim').onclick = (e) => { if (e.target === $('acaScrim')) $('acaScrim').hidden = true; };
  $('acaIssueModeNew').onchange = () => setAcaIssueMode('new');
  $('acaIssueModeExisting').onchange = () => setAcaIssueMode('existing');
  $('acaRepo').oninput = () => updateAcaRepoHint(state.acaRepos);
  $('acaStart').onclick = submitAcaDispatch;

  // The two fallback links (#178): kept exactly as capable as the dialog
  // they replaced, and the ONLY path when `acaSetMode('disabled')` hides the
  // form above. Built from the same `acaRepo`/`acaPrompt` fields as the full
  // form, so switching to the fallback never means re-typing anything.
  $('acaReviewLink').onclick = (e) => {
    e.preventDefault();
    const url = acaNewIssueLink($('acaRepo').value, $('acaPrompt').value);
    if (!url) {
      $('acaErr').textContent = 'Enter a repository as owner/repo, and what it should do.';
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
    try {
      await navigator.clipboard.writeText(cmd);
      toast('Command copied — paste it as a comment on the issue');
    } catch { toast('Could not copy; select the command and copy it'); }
  };
}
