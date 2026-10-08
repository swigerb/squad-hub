// The "Start on ACA" dialog, split out of app.js's Wiring section by #200
// (part 4/4 of #165). Pure link-building is unchanged byte-for-byte from the
// original so the mutations in test/mutate.js that target it still match.

import { state } from './api.js';
import { $, toast } from './util.js';

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

export function openAca() {
  const cur = state.currentSession;
  $('acaErr').hidden = true;
  $('acaIssue').value = '';
  // Prefilled from the session when there is one, and editable either way: a
  // run does not have to be about the repository you happen to be looking at.
  $('acaRepo').value = (cur && acaSessionRepo(cur.session)) || '';
  $('acaPrompt').value = (cur && cur.session.prompt) || '';
  $('acaScrim').hidden = false;
  updateAcaPreview();
  ($('acaRepo').value ? $('acaPrompt') : $('acaRepo')).focus();
}

export function updateAcaPreview() {
  const repo = $('acaRepo').value;
  const prompt = $('acaPrompt').value;
  const link = acaNewIssueLink(repo, prompt);
  const title = acaTitle(prompt);
  // What will actually appear, shown before anything opens. The point of this
  // route over a launcher is that the request is READ, not approved blind.
  $('acaPreview').textContent = link
    ? `${acaRepoName(repo)} · new issue: “${title}”`
    : 'Enter a repository as owner/repo, and what it should do.';
  $('acaOpen').disabled = !link;

  // The job runs wherever Squad on ACA is installed -- which is a property of
  // the repository, not of this hub. Saying so where the repository is typed is
  // the only place it can stop somebody expecting their own subscription.
  const name = acaRepoName(repo);
  const cur = state.currentSession;
  const fromSession = cur && acaSessionRepo(cur.session) === name;
  $('acaRepoHint').textContent = !name ? ''
    : fromSession ? 'From this session\u2019s checkout.'
      : 'Runs in whichever Azure subscription this repository\u2019s workflow is set up for.';

  const cmd = acaComment(prompt);
  $('acaComment').textContent = cmd || '/squad-aca \u2026';
  $('acaCopy').disabled = !cmd;
  $('acaOpenIssue').disabled = !acaIssueLink(repo, $('acaIssue').value);
}

/** Wire the "Start on ACA" dialog's controls. Called once, from wire(). */
export function wireAca() {
  $('dtAca').onclick = openAca;
  $('acaCancel').onclick = () => { $('acaScrim').hidden = true; };
  $('acaScrim').onclick = (e) => { if (e.target === $('acaScrim')) $('acaScrim').hidden = true; };
  $('acaRepo').oninput = updateAcaPreview;
  $('acaIssue').oninput = updateAcaPreview;
  $('acaPrompt').oninput = updateAcaPreview;
  $('acaOpen').onclick = () => {
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
  $('acaCopy').onclick = async () => {
    const cmd = acaComment($('acaPrompt').value);
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      toast('Command copied — paste it as a comment on the issue');
    } catch { toast('Could not copy; select the command and copy it'); }
  };
  $('acaOpenIssue').onclick = () => {
    const url = acaIssueLink($('acaRepo').value, $('acaIssue').value);
    if (!url) {
      $('acaErr').textContent = 'Enter a repository and an issue number.';
      $('acaErr').hidden = false;
      return;
    }
    window.open(url, '_blank', 'noopener');
  };
}
