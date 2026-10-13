'use strict';

// `GET /api/aca/choices`, `/api/aca/branches` and `/api/aca/issues` (#257): the
// target-authoritative values the New ACA job dialog's pickers offer.
//
// Split out of hub-service.js for its size, and kept to ONE gate so no route
// here can skip a step another has. The order is the contract (docs/api.md):
//
//   1. the request is well-formed (400, spends nothing);
//   2. the read rate budget is spent (429), the same budget `GET /api/aca/repos`
//      and `/api/aca/dispatches` draw on;
//   3. the App is installed on the repository (403, the common message);
//   4. the signed-in GitHub account may use it (`GitHubApp` re-asks GitHub on
//      EVERY call, 403 with the same message, 502 when it cannot say);
//   5. only then does any repository data get read or returned.
//
// The caller (hub-service.js) has already answered 501 for a hub with no App
// and 403 for a session with no verified GitHub identity before calling in.

const { validRepo } = require('../aca-dispatch');
const { repoNotAvailableMessage } = require('./github-app');
const { parseSearchText, parsePage } = require('./aca-choices');

const ROUTES = {
  '/api/aca/choices': 'choices',
  '/api/aca/branches': 'branches',
  '/api/aca/issues': 'issues',
};

/** The kind of choice route `path` is, or `null`. */
function acaChoiceRoute(path) {
  return Object.prototype.hasOwnProperty.call(ROUTES, path) ? ROUTES[path] : null;
}

/** `{ok:true, repo, owner, name, q, page}` from the query string, or `{ok:false, reason}`. */
function parseChoiceQuery(kind, params) {
  const repo = params.get('repo');
  if (typeof repo !== 'string' || !validRepo(repo)) return { ok: false, reason: 'repo must be owner/repo' };
  const out = {
    ok: true, repo, owner: repo.split('/')[0], name: repo.split('/')[1], q: '', page: 1,
  };
  if (kind === 'choices') return out;
  const q = parseSearchText(params.get('q'));
  if (!q.ok) return { ok: false, reason: q.reason };
  const page = parsePage(params.get('page'));
  if (!page.ok) return { ok: false, reason: page.reason };
  out.q = q.value;
  out.page = page.value;
  return out;
}

/**
 * Serves one choice route. `ctx`: `{kind, params, githubApp, actor, limiter,
 * limitKey, send}`. Always answers through `send`.
 */
async function serveAcaChoiceRoute(ctx) {
  const {
    kind, params, githubApp, actor, limiter, limitKey, send,
  } = ctx;
  const parsed = parseChoiceQuery(kind, params);
  if (!parsed.ok) return send(400, { error: parsed.reason });

  const limited = limiter.check(limitKey);
  if (!limited.allowed) {
    return send(429, {
      error: `too many requests; try again in ${Math.ceil(limited.retryAfterMs / 1000)}s`,
      retryAfterMs: limited.retryAfterMs,
    });
  }

  try {
    const installation = await githubApp.findInstallation(parsed.owner, parsed.name);
    if (!installation) return send(403, { error: repoNotAvailableMessage(parsed.repo) });
    const target = { owner: parsed.owner, repo: parsed.name, installationId: installation.installationId };
    if (kind === 'choices') return send(200, await githubApp.listDispatchChoices(target, actor));
    const query = { q: parsed.q, page: parsed.page };
    if (kind === 'branches') {
      const r = await githubApp.listBranchChoices(target, actor, query);
      return send(200, { repo: parsed.repo, query: parsed.q, page: parsed.page, ...r });
    }
    const r = await githubApp.listIssueChoices(target, actor, query);
    return send(200, { repo: parsed.repo, query: parsed.q, page: parsed.page, ...r });
  } catch (e) {
    return send(e.status || 502, { error: e.message });
  }
}

module.exports = { acaChoiceRoute, parseChoiceQuery, serveAcaChoiceRoute };
