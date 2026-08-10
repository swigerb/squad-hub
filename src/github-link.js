'use strict';
/**
 * A link to a prefilled GitHub issue comment.
 *
 * This is what replaces the launcher. The
 * thing people want from a phone is to start a cloud run; the launcher answered
 * that by giving the hub a component that can start compute. This answers it by
 * giving the hub a URL.
 *
 * The hub gains no capability. It emits a link. A link cannot start a job --
 * the person's own GitHub session does, after they have read the instruction in
 * the actual comment box and pressed Comment. GitHub authenticates them, the
 * existing workflow runs with a federated short-lived credential, and the
 * comment is the audit record, attributed, with no work needed to make that
 * true.
 *
 * WHAT THIS MODULE IS CAREFUL ABOUT, and why each one is not paranoia:
 *
 *   - NO CREDENTIAL IN THE URL. A prefilled body is public the moment it is a
 *     link: it lands in history, in a referrer header, in a screenshot someone
 *     sends you.
 *   - THE REPOSITORY COMES FROM THE SESSION. Never from caller input. A
 *     function that will build a github.com link to any repository it is handed
 *     is an open redirect with extra steps.
 *   - THE HOST MUST REALLY BE GITHUB. `git.repository` falls back to a
 *     directory name for a local-only checkout, so "repository is set" does not
 *     mean "this is on GitHub".
 *   - THE BODY IS ENCODED. It is user text going into a query string. Without
 *     encoding, an instruction containing `&` silently becomes a second
 *     parameter and the rest of it disappears.
 *
 * Pure and dependency-free: given a session it returns a string or null, and
 * touches nothing.
 */

/**
 * A link that starts a Squad on ACA run.
 *
 * The hub gains no capability. It emits a URL. A URL cannot start a job -- the
 * person's own GitHub session does, after they have read what it says and
 * pressed the button. GitHub authenticates them, the existing workflow runs
 * with a federated short-lived credential, and the issue is the audit record.
 *
 * WHY A NEW ISSUE RATHER THAN A COMMENT. GitHub supports prefilling a NEW
 * issue from query parameters -- `title`, `body`, `labels` -- and supports
 * nothing of the kind for a comment on an existing issue. A URL like
 * `/issues/72#issuecomment-new?body=...` puts the parameter inside the
 * FRAGMENT, where it is never sent anywhere and never read: the page opens with
 * an empty comment box and the instruction silently gone.
 *
 * The workflow accepts both routes. `issue_comment` carries an explicit
 * `/squad-aca <prompt>`; `issues: labeled` carries no prompt and the job falls
 * back to "Work GitHub issue #N ... read the issue, implement it, and open a
 * pull request" -- which is exactly right when the issue body IS the
 * instruction. So the prefilled route is the labelled one.
 *
 * WHAT THIS MODULE IS CAREFUL ABOUT:
 *
 *   - NO CREDENTIAL IN THE URL. A prefilled body is public the moment it is a
 *     link: it lands in history, in a referrer header, in a screenshot.
 *   - THE HOST IS ALWAYS github.com. Never taken from input.
 *   - THE REPOSITORY IS VALIDATED against GitHub's own naming rules, because
 *     it is interpolated into a URL path.
 *   - EVERY PARAMETER IS ENCODED. Without it an instruction containing `&`
 *     silently becomes a second parameter and the rest disappears.
 *
 * Pure and dependency-free.
 */

/** Hosts a link may be built for. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

/** The label the dispatch workflow triggers on. */
const DEFAULT_LABEL = 'squad-aca';

/** GitHub's own naming rules, applied because these become path segments. */
function validName(s) {
  return /^[A-Za-z0-9._-]{1,100}$/.test(s) && !s.startsWith('.') && s !== '..';
}

/**
 * `owner/repo` for a session, or null when it is not on GitHub.
 *
 * A checkout with no remote gets its directory name as a "repository", which is
 * fine for a label and would be a lie in a link -- hence the host check.
 */
function githubRepo(session) {
  const git = (session && session.git) || {};
  if (!git.repository) return null;
  if (!git.host || !GITHUB_HOSTS.has(String(git.host).toLowerCase())) return null;
  return repoFromName(git.repository);
}

/** `owner/repo` from a string, validated. Null when it is not one. */
function repoFromName(name) {
  const parts = String(name == null ? '' : name).trim().replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!validName(owner) || !validName(repo)) return null;
  return `${owner}/${repo}`;
}

/** A title for the issue, derived from the instruction and kept short. */
function issueTitle(instruction) {
  const one = String(instruction == null ? '' : instruction).trim().replace(/\s*\r?\n\s*/g, ' ');
  if (!one) return null;
  return one.length <= 70 ? one : `${one.slice(0, 67).trimEnd()}…`;
}

/**
 * The URL that opens a NEW issue, prefilled and labelled so the workflow picks
 * it up the moment it is created.
 *
 * Returns null rather than a broken link whenever it cannot build a correct
 * one: a button that leads somewhere wrong is worse than no button, and this
 * one leads to a page that starts compute.
 *
 * @param {string} repo            `owner/repo`
 * @param {object} opts
 * @param {string} opts.instruction   what the run should do
 * @param {string} [opts.label]       trigger label; defaults to `squad-aca`
 * @param {number} [opts.maxLength]   cap on the encoded URL
 */
function newIssueLink(repo, { instruction, label = DEFAULT_LABEL, maxLength = 6000 } = {}) {
  const target = repoFromName(repo);
  if (!target) return null;

  const body = String(instruction == null ? '' : instruction).trim();
  if (!body) return null;
  const title = issueTitle(body);
  // An explicitly empty label is a mistake, not a request for the default: a
  // link without the trigger label opens an issue that nothing acts on.
  const tag = label === undefined ? DEFAULT_LABEL : String(label).trim();
  if (!tag || !/^[A-Za-z0-9._: -]{1,50}$/.test(tag)) return null;

  const url = `https://github.com/${target}/issues/new`
    + `?title=${encodeURIComponent(title)}`
    + `&body=${encodeURIComponent(body)}`
    + `&labels=${encodeURIComponent(tag)}`;

  // Refused rather than truncated: a truncated instruction is a different
  // instruction that still looks deliberate, on a page that starts compute.
  return url.length > maxLength ? null : url;
}

/** The same link, for the repository a session is checked out from. */
function sessionIssueLink(session, opts = {}) {
  const repo = githubRepo(session);
  return repo ? newIssueLink(repo, opts) : null;
}

/**
 * The comment a person types on an EXISTING issue.
 *
 * Offered as text to copy rather than as a prefilled link, because GitHub has
 * no way to prefill a comment and pretending otherwise produces an empty box.
 */
function acaComment(prompt) {
  const p = String(prompt == null ? '' : prompt).trim();
  if (!p) return null;
  // The workflow reads the command from the comment; a multi-line prompt is
  // folded so the command stays on one line.
  return `/squad-aca ${p.replace(/\s*\r?\n\s*/g, ' ')}`;
}

/** The URL of an existing issue, so the comment can be pasted there. */
function issueLink(repo, issue) {
  const target = repoFromName(repo);
  if (!target) return null;
  const n = Number(issue);
  if (!Number.isInteger(n) || n <= 0) return null;
  return `https://github.com/${target}/issues/${n}`;
}

module.exports = {
  newIssueLink,
  sessionIssueLink,
  issueLink,
  acaComment,
  githubRepo,
  repoFromName,
  issueTitle,
  GITHUB_HOSTS,
  DEFAULT_LABEL,
};
