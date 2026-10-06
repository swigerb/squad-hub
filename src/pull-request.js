'use strict';
/**
 * Optional pull-request reference a device may attach to one of its sessions:
 * `{ url, number, title }`, naming the PR a session's work produced or is
 * aimed at.
 *
 * Validated with the same posture as `src/device-meta.js` and for the same
 * reason -- a device is a machine the hub does not control, so whatever it
 * reports is INPUT, not an invariant. Unlike device metadata (a bag of
 * independent optional fields, each dropped on its own), a pull request is one
 * fact with three parts that only mean something together: a `title` without
 * a matching `url`, or a `number` that does not belong to `url`, is not a
 * partially-valid pull request, it is a wrong one. So validation here is all
 * three fields or nothing, never a partial survivor.
 */

/** Only a real GitHub pull request URL is accepted -- `https://github.com/
 * {owner}/{repo}/pull/{number}`, nothing else. Rejecting this outright (not
 * sanitizing it) means a caller finds out its pull request did not take
 * rather than silently getting a mangled or unrelated link back. */
const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/;

/** Generous for `owner/repo/pull/number`; nowhere close to what a legitimate
 * GitHub URL needs, but far short of letting a caller smuggle kilobytes of
 * garbage into something every watcher of a subject reads back. */
const MAX_URL_LEN = 300;

/** A headline, not an essay. */
const MAX_TITLE_LEN = 200;

/** Control characters (including ESC, the first byte of a terminal escape
 * sequence) and the two characters that turn a plain label into markup. */
const INJECTION_RE = /[\x00-\x1f\x7f<>]/;

/**
 * Validate an already-parsed `pullRequest` object. Returns a new object
 * containing exactly `{ url, number, title }` (`title` is `null` when the
 * device did not send one) if every part checks out, or `null` if any part
 * does not -- wrong type, oversize, a non-GitHub-pull-request URL, a `number`
 * that is not a positive integer or not the number in `url`, or an
 * injection-shaped string.
 */
function sanitizePullRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const { url, number, title } = input;

  if (typeof url !== 'string' || !url.length || url.length > MAX_URL_LEN) return null;
  if (INJECTION_RE.test(url) || !PR_URL_RE.test(url)) return null;

  if (!Number.isInteger(number) || number <= 0) return null;
  // `number` must be the pull request `url` names, not some other one.
  if (String(number) !== url.slice(url.lastIndexOf('/') + 1)) return null;

  let safeTitle = null;
  if (title !== undefined && title !== null) {
    if (typeof title !== 'string' || !title.length || title.length > MAX_TITLE_LEN) return null;
    if (INJECTION_RE.test(title)) return null;
    safeTitle = title;
  }

  return { url, number, title: safeTitle };
}

module.exports = {
  PR_URL_RE,
  MAX_URL_LEN,
  MAX_TITLE_LEN,
  sanitizePullRequest,
};
