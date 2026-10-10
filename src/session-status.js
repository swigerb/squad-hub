'use strict';
/**
 * What "ended" means for a session, and the one derived status built on it.
 *
 * `TERMINAL_STATUSES` is the set a session never comes back from. The hub's
 * store ages out, forgets and stamps `endedAt` by it, and the web app mirrors
 * it next to `NON_TERMINAL_STATUSES` in `web/js/util.js` -- a unit test keeps
 * the two copies, and every status the agent can report, in step.
 *
 * "Ready for review" (#179) is NOT a status a device ever reports. It is
 * derived: the session has ENDED, it reports a valid pull request, and nobody
 * is blocked on it. Each of the three parts matters:
 *   - ended: a pull request can be attached to a session that is still working
 *     or idle (awaiting a reply), and that is not ready for anyone yet;
 *   - a valid pull request: the same all-or-nothing `sanitizePullRequest` the
 *     store applies on the way in, so a stored record that somehow carries a
 *     malformed one is not ready either;
 *   - no pending approval: someone is being asked for something, which
 *     outranks any other reading of the row.
 */

const { sanitizePullRequest } = require('./pull-request');

const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped', 'disconnected']);

/** The Status filter value that selects `isReadyForReview` sessions. */
const REVIEW_FILTER = 'review';

function isReadyForReview(session) {
  if (!session || !TERMINAL_STATUSES.has(session.status)) return false;
  if (Array.isArray(session.pendingApprovals) && session.pendingApprovals.length) return false;
  return sanitizePullRequest(session.pullRequest) !== null;
}

/**
 * One session against one `status` filter value: the derived "review" filter,
 * or plain equality with the status the device reported. No filter matches
 * everything.
 */
function matchesStatusFilter(session, status) {
  if (!status) return true;
  if (status === REVIEW_FILTER) return isReadyForReview(session);
  return session.status === status;
}

module.exports = { TERMINAL_STATUSES, REVIEW_FILTER, isReadyForReview, matchesStatusFilter };
