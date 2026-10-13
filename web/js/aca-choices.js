// The New ACA job dialog's known-value pickers (#257), split out of aca.js for
// the per-module size budget.
//
// Every field here whose valid values the TARGET knows is a picker over what
// the hub reports for the chosen repository, never a free-text box and never a
// list this app made up: the repository (the ones the GitHub App can see and
// the signed-in GitHub account may use), its branches, its open issues, and the
// models and reviewers its own Squad configuration names. The person's choice
// is what gets sent; typed search text is only ever a search.
//
// A change of repository throws away everything that belonged to the old one and
// invalidates any reply still in flight for it (`acaPick.choiceGen`, plus each
// picker's own generation in combobox.js), so a slow answer for the previous
// repository can never fill the current one.
//
// Circular with aca.js, the same way aca-created-issue.js is: neither touches
// the other at module-evaluation time.

import { state, api } from './api.js';
import { $ } from './util.js';
import { createCombobox } from './combobox.js';
import { acaRepoName, acaOptionsNote, acaRepoDeclaredInputs } from './aca.js';

const ACA_REPO_PAGE = 50;
const acaPick = {
  boxes: null, reposPromise: null, repo: null, free: false, choiceGen: 0, choiceCtrl: null,
};
// The repository list answered for THIS open of the dialog, or `null` until it
// has. Kept apart from `state.acaRepos` so a capability read from an earlier
// open, or from a refresh that failed, is never mistaken for what the target
// workflow declares now.
let acaCapabilityRepos = null;

/** `GET /api/aca/repos`, shared by the dialog's own open and the picker so one open asks once. */
export function acaLoadRepos() {
  if (!acaPick.reposPromise) {
    const p = api('/api/aca/repos').then((r) => r.repos || []);
    acaPick.reposPromise = p;
    p.catch(() => { if (acaPick.reposPromise === p) acaPick.reposPromise = null; });
  }
  return acaPick.reposPromise;
}

async function acaRepoItems(q, page) {
  const repos = await acaLoadRepos();
  const needle = q.toLowerCase();
  const hits = repos.filter((r) => String(r.fullName).toLowerCase().includes(needle));
  const from = (page - 1) * ACA_REPO_PAGE;
  return {
    items: hits.slice(from, from + ACA_REPO_PAGE).map((r) => ({
      value: r.fullName, label: r.fullName, hint: r.hasDispatchWorkflow ? '' : 'squad-dispatch.yml not found',
    })),
    nextPage: from + ACA_REPO_PAGE < hits.length ? page + 1 : null,
  };
}

async function acaServerItems(kind, q, page, signal, toItem) {
  const repo = acaPick.repo;
  if (!repo) throw new Error('choose a repository first');
  const r = await api(`/api/aca/${kind}?repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(q)}&page=${page}`, { signal });
  return { items: (r[kind] || []).map(toItem), nextPage: r.nextPage || null };
}

function acaBoxes() {
  if (acaPick.boxes) return acaPick.boxes;
  const make = (id, listbox, status, extra) => createCombobox({
    input: $(id), list: $(listbox), status: $(status), ...extra,
  });
  acaPick.boxes = {
    repo: make('acaRepo', 'acaRepoListbox', 'acaRepoStatus', {
      noun: 'repositories',
      load: acaRepoItems,
      matches: (it, q) => it.value.toLowerCase() === q.toLowerCase(),
      onChange: acaOnRepoChosen,
      onInput: () => acaUpdateRepoHint(),
    }),
    branch: make('acaBranch', 'acaBranchListbox', 'acaBranchStatus', {
      noun: 'branches',
      load: (q, page, signal) => acaServerItems('branches', q, page, signal, (b) => ({ value: b.name, label: b.name })),
      matches: (it, q) => it.value === q,
    }),
    issue: make('acaIssueNumber', 'acaIssueListbox', 'acaIssueStatus', {
      noun: 'open issues',
      load: (q, page, signal) => acaServerItems('issues', q, page, signal, (i) => ({ value: i.number, label: `#${i.number} ${i.title}` })),
      matches: (it, q) => String(it.value) === q.replace(/^#/, ''),
    }),
  };
  $('acaChoicesRetry').onclick = () => acaLoadChoices();
  return acaPick.boxes;
}

/** The checkmark line under Repository, and the options note that depends on the repository's workflow. */
function acaUpdateRepoHint() {
  const name = acaRepoName(acaBoxes().repo.typed());
  const hintEl = $('acaRepoHint');
  $('acaOptionsHint').textContent = acaOptionsNote(acaRepoDeclaredInputs(acaCapabilityRepos, name));
  if (!name) { hintEl.textContent = ''; hintEl.style.color = ''; return; }
  const match = (state.acaRepos || []).find((r) => r.fullName.toLowerCase() === name.toLowerCase());
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

// -- model and reviewer: a closed list the repository reported -------------------

const ACA_CHOICE_FIELDS = {
  model: { select: 'acaModel', note: 'acaModelNote', noun: 'model' },
  reviewer: { select: 'acaReviewer', note: 'acaReviewerNote', noun: 'reviewer' },
};

/** Shows `spec` (a `{state, choices, default, reason}` from `/api/aca/choices`, or `null`) in one select. */
function acaShowChoice(kind, spec, message) {
  const f = ACA_CHOICE_FIELDS[kind];
  const sel = $(f.select);
  const options = [new Option('Squad default', '')];
  const ok = !!spec && spec.state === 'ok';
  if (ok) {
    for (const c of spec.choices) options.push(new Option(c.hint ? `${c.id} (${c.hint})` : c.id, c.id));
  }
  sel.replaceChildren(...options);
  sel.value = '';
  sel.disabled = !ok;
  let text = message || '';
  if (!message && spec) {
    const why = spec.reason ? ` ${spec.reason}` : '';
    if (ok) {
      const defaulted = spec.default ? ` Its default is ${spec.default}.` : '';
      text = kind === 'model'
        ? `Models this repository's Squad configuration names.${defaulted} Not a check of what the job can run: it confirms the model when it starts.${why}`
        : `Active members of this repository's Squad roster.${why}`;
    } else if (spec.state === 'unavailable') text = `Could not list ${f.noun}s: ${spec.reason}.`;
    else text = `Only the Squad default is available: ${spec.reason}.`;
  }
  $(f.note).textContent = text;
}

function acaShowChoices(spec, message) {
  acaShowChoice('model', spec && spec.model, message);
  acaShowChoice('reviewer', spec && spec.reviewer, message);
  const bad = !!spec && [spec.model, spec.reviewer].some((s) => s && s.state === 'unavailable');
  $('acaChoicesRetry').hidden = !(bad || (message && message.startsWith('Could not')));
}

async function acaLoadChoices() {
  const repo = acaPick.repo;
  if (!repo) return;
  acaPick.choiceGen += 1;
  const gen = acaPick.choiceGen;
  if (acaPick.choiceCtrl) acaPick.choiceCtrl.abort();
  const ctrl = new AbortController();
  acaPick.choiceCtrl = ctrl;
  acaShowChoices(null, 'Loading this repository\u2019s choices\u2026');
  try {
    const r = await api(`/api/aca/choices?repo=${encodeURIComponent(repo)}`, { signal: ctrl.signal });
    if (gen !== acaPick.choiceGen) return;
    $('acaBranch').placeholder = r.defaultBranch ? `(repository default: ${r.defaultBranch})` : '(repository default)';
    acaShowChoices(r);
  } catch (e) {
    if (gen !== acaPick.choiceGen || (e && e.name === 'AbortError')) return;
    acaShowChoices(null, `Could not load this repository's choices: ${e.message}.`);
    if (e.status === 403) $('acaChoicesRetry').hidden = true;
  }
}

// -- repository changes ----------------------------------------------------------

function acaBlockRepoFields(reason) {
  if (acaPick.free) return;
  const b = acaBoxes();
  b.branch.setBlocked(reason);
  b.issue.setBlocked(reason);
}

/** The chosen repository changed (or was cleared by editing it): nothing chosen for the old one survives. */
function acaOnRepoChosen(item) {
  const b = acaBoxes();
  acaPick.repo = item ? item.value : null;
  acaPick.choiceGen += 1;
  if (acaPick.choiceCtrl) acaPick.choiceCtrl.abort();
  b.branch.clear();
  b.issue.clear();
  $('acaBranch').placeholder = '(repository default)';
  acaUpdateRepoHint();
  if (!item) {
    acaBlockRepoFields('Choose a repository first.');
    acaShowChoices(null, 'Choose a repository to see its choices.');
    $('acaChoicesRetry').hidden = true;
    return;
  }
  acaBlockRepoFields(null);
  acaLoadChoices();
}

/** Opening the dialog: every picker starts empty, and `repoText` is only a prefill to be resolved once the list loads. */
export function acaChoicesOpen(repoText) {
  const b = acaBoxes();
  acaPick.reposPromise = null;
  acaCapabilityRepos = null;
  acaPick.free = false;
  b.repo.setFree(false);
  b.issue.setFree(false);
  b.repo.clear();
  b.repo.setText(repoText || '');
  acaOnRepoChosen(null);
}

/** A hub with no GitHub App has nothing to search: the repository and issue stay plain text for the link fallback. */
export function acaChoicesFree(on) {
  const b = acaBoxes();
  acaPick.free = on;
  b.repo.setFree(on);
  b.issue.setFree(on);
  if (on) { b.issue.setBlocked(null); b.branch.setBlocked(null); } else if (!acaPick.repo) acaBlockRepoFields('Choose a repository first.');
}

/** The repository list answered for this open: remember it, and resolve a prefilled repository against it. */
export function acaReposLoaded(repos) {
  acaCapabilityRepos = repos;
  acaUpdateRepoHint();
  acaBoxes().repo.resolve();
}

// -- reading the dialog ----------------------------------------------------------

/** What the person CHOSE for the pickers, plus the typed text that names nothing (`unresolved`). */
export function acaChoiceValues() {
  const b = acaBoxes();
  const existing = $('acaIssueModeExisting').checked;
  const unresolved = [];
  if (b.repo.unresolved()) unresolved.push('the repository');
  if (b.branch.unresolved()) unresolved.push('the base branch');
  if (existing && b.issue.unresolved()) unresolved.push('the issue');
  const issue = b.issue.value();
  return {
    repo: b.repo.value() || '',
    baseBranch: b.branch.value() || '',
    issueNumber: issue == null ? '' : issue,
    model: $('acaModel').value,
    reviewer: $('acaReviewer').value,
    declaredInputs: acaRepoDeclaredInputs(acaCapabilityRepos, acaPick.repo),
    unresolved,
  };
}

/** The issue a fallback link should open: the chosen one, or what was typed when nothing is chosen. */
export function acaIssueForLink() {
  const b = acaBoxes().issue;
  return b.item() ? b.value() : b.typed().replace(/^#/, '');
}

/** Typed text still waiting to be matched to a list entry (a value typed in full, with no pause for the search). */
export function acaChoicesPending() {
  const b = acaBoxes();
  return b.repo.unresolved() || b.branch.unresolved() || (!!$('acaIssueModeExisting').checked && b.issue.unresolved());
}

export async function acaResolveChoices() {
  const b = acaBoxes();
  await Promise.all([b.repo.resolve(), b.branch.resolve(), $('acaIssueModeExisting').checked ? b.issue.resolve() : null]);
}

/** Selects an issue the hub itself reports was created for this job, so a retry reuses it. */
export function acaChooseIssue(number) {
  acaBoxes().issue.choose({ value: number, label: `#${number}` }, true);
}

/**
 * A dispatch the hub refused naming a field (`422 {field}`): the choice that
 * field held is no longer valid, so it is cleared and the list it came from is
 * reloaded. Returns the id of the field to focus, or `null` for any other error.
 */
export function acaChoiceRefused(e) {
  const field = e && e.status === 422 && e.body && e.body.field;
  const ids = {
    baseBranch: 'acaBranch', issue: 'acaIssueNumber', model: 'acaModel', reviewer: 'acaReviewer',
  };
  if (!ids[field]) return null;
  if (field === 'baseBranch') acaBoxes().branch.clear();
  else if (field === 'issue') acaBoxes().issue.clear();
  else acaLoadChoices();
  return ids[field];
}
