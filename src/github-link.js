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

/** Hosts a comment link may be built for. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

/**
 * `owner/repo`, or null when the session is not on GitHub.
 *
 * Both halves are validated against GitHub's own naming rules rather than
 * merely being non-empty, because everything after this point interpolates
 * them into a URL path.
 */
function githubRepo(session) {
  const git = (session && session.git) || {};
  if (!git.repository) return null;
  // A checkout with no remote gets its directory name as a "repository", which
  // is fine for a label and would be a lie in a link.
  if (!git.host || !GITHUB_HOSTS.has(String(git.host).toLowerCase())) return null;
  const parts = String(git.repository).split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  // GitHub allows letters, digits, hyphens, underscores and dots; an owner may
  // not contain a dot but accepting one costs nothing and rejecting a valid
  // name would hide the button from somebody with no way to find out why.
  const ok = (s) => /^[A-Za-z0-9._-]{1,100}$/.test(s) && !s.startsWith('.') && s !== '..';
  if (!ok(owner) || !ok(repo)) return null;
  return `${owner}/${repo}`;
}

/**
 * The URL that opens an issue's comment box with `instruction` already in it.
 *
 * Returns null rather than a broken link whenever it cannot build a correct
 * one: a button that leads somewhere wrong is worse than no button.
 *
 * @param {object} session       a session as the hub holds it, with `git`
 * @param {object} opts
 * @param {number|string} opts.issue        the issue number
 * @param {string} opts.instruction         the comment text, verbatim
 * @param {number} [opts.maxLength]         cap on the encoded URL
 */
function issueCommentLink(session, { issue, instruction, maxLength = 6000 } = {}) {
  const repo = githubRepo(session);
  if (!repo) return null;

  // An issue number, not "anything that stringifies". `#12` and `12abc` are
  // both somebody's mistake, and guessing which is not this function's job.
  const n = Number(issue);
  if (!Number.isInteger(n) || n <= 0) return null;

  const body = String(instruction == null ? '' : instruction);
  if (!body.trim()) return null;

  const url = `https://github.com/${repo}/issues/${n}#issuecomment-new?body=${encodeURIComponent(body)}`;

  /**
   * A cap, because a URL that is too long is not rejected -- it is TRUNCATED,
   * by a browser or by a proxy, and a truncated instruction is a different
   * instruction that still looks deliberate. Refusing is the safe half of that
   * choice.
   */
  if (url.length > maxLength) return null;
  return url;
}

/**
 * The instruction the ACA workflow understands.
 *
 * Built here rather than at the call site so the command word exists in one
 * place. It is `/squad-aca <prompt>`; the workflow reads the rest of the line
 * as the prompt.
 */
function acaInstruction(prompt) {
  const p = String(prompt == null ? '' : prompt).trim();
  if (!p) return null;
  // Newlines are the one thing that changes the shape of the command: the
  // workflow reads the first line. Folded rather than dropped, so nothing the
  // person wrote silently disappears.
  return `/squad-aca ${p.replace(/\s*\r?\n\s*/g, ' ')}`;
}

module.exports = {
  issueCommentLink, acaInstruction, githubRepo, GITHUB_HOSTS,
};
