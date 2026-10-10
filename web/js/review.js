import { $, esc, pullRequestOf, isReadyForReview } from './util.js';

// ---------------------------------------------------------------------------
// Ready for review and Squad health (#179): the markup for the Open PR link and
// the health badge, shared by the session row (sessionrow.js) and the session
// detail page (detail.js). Pure string builders plus one DOM sync; everything
// device-supplied is validated here and escaped before it is markup.
//
// The per-check health list lives in the detail page's Squad panel for now
// (`#dtSquadHealth`) and is built on its own, so it can move into the Info tab
// (#182) without touching the row.
// ---------------------------------------------------------------------------

/**
 * The "Open PR ↗" link for a session that is ready for review, or ''.
 *
 * `href` is only ever a github.com pull request URL (`pullRequestOf`
 * re-validates it), and it opens in a new tab without handing the page to the
 * destination. `data-pr-link` is how the list claims the click, so following
 * the link does not also open the session.
 */
export function prLinkHtml(s) {
  const pr = isReadyForReview(s) ? pullRequestOf(s) : null;
  if (!pr) return '';
  const tip = pr.title ? `#${pr.number} — ${pr.title}` : `Pull request #${pr.number}`;
  return `<a class="pr-link" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer" data-pr-link
     title="${esc(tip)}" aria-label="Open PR #${pr.number} (opens in a new tab)">Open PR ↗</a>`;
}

const HEALTH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HEALTH_MAX_CHECKS = 50;
// When one id is reported twice, the worse status wins.
const HEALTH_RANK = new Map([['pass', 0], ['skip', 1], ['fail', 2]]);
const HEALTH_MARK = { pass: '✓', skip: '–', fail: '✕' };

/**
 * `session.squad.health` as something safe to draw, or null when there is
 * nothing to say. The device reports `{status:'unknown'}`,
 * `{status:'unavailable'}` or `{status:'pass'|'fail', checks:[{id, status}]}`,
 * and a hub relaying it may hand over anything, so only the two verdicts are
 * drawn at all. An entry that is not an object, has an id that is not a plain
 * check id, or has a status other than pass/fail/skip is ignored rather than
 * guessed at.
 *
 * The count is of DISTINCT failing ids, and a `fail` verdict that names no
 * failing check keeps `failing` empty: the badge then says "failing" without
 * a number, because inventing one would be worse than omitting it.
 */
export function squadHealthView(health) {
  if (!health || typeof health !== 'object' || (health.status !== 'pass' && health.status !== 'fail')) return null;
  const worst = new Map();
  const reported = Array.isArray(health.checks) ? health.checks.slice(0, HEALTH_MAX_CHECKS) : [];
  for (const c of reported) {
    if (!c || typeof c.id !== 'string' || !HEALTH_ID_RE.test(c.id) || !HEALTH_RANK.has(c.status)) continue;
    const seen = worst.get(c.id);
    if (seen === undefined || HEALTH_RANK.get(c.status) > HEALTH_RANK.get(seen)) worst.set(c.id, c.status);
  }
  const checks = [...worst].map(([id, status]) => ({ id, status }));
  const failing = checks.filter((c) => c.status === 'fail').map((c) => c.id);
  return { healthy: health.status === 'pass' && !failing.length, checks, failing };
}

function healthBadge(v) {
  const n = v.failing.length;
  const label = v.healthy ? 'healthy' : (n ? `health: ${n} failing` : 'health: failing');
  let tip = 'Squad health: failing — the device did not name a check';
  if (v.healthy) tip = 'Squad health: healthy — no failing checks';
  else if (n) tip = `Squad health: failing checks — ${v.failing.join(', ')}`;
  return `<span class="health ${v.healthy ? 'healthy' : 'failing'}" title="${esc(tip)}"><span aria-hidden="true">●</span> ${label}</span>`;
}

/** The row's "● healthy" / "● health: N failing" badge, or '' when health is not a verdict. */
export function healthBadgeHtml(health) {
  const v = squadHealthView(health);
  return v ? healthBadge(v) : '';
}

/** The detail page's Squad health block: the badge, then one line per check. */
export function healthChecksHtml(health) {
  const v = squadHealthView(health);
  if (!v) return '';
  const items = v.checks.map((c) => `<li class="${c.status}"><b>${esc(c.id)}</b> <span><span aria-hidden="true">${HEALTH_MARK[c.status]}</span> ${c.status}</span></li>`);
  return `<div class="sq-hline"><span class="sq-hlabel">Squad health</span> ${healthBadge(v)}</div>${items.length ? `<ul class="sq-checks">${items.join('')}</ul>` : ''}`;
}

/**
 * Bring the detail page's pull request link and health block up to date.
 *
 * Called on open AND on every refresh, which is every few seconds while the
 * page is open -- so an element is only rewritten when what it would say has
 * changed. Rewriting an unchanged link on each push would drop keyboard focus
 * and a hover out from under whoever is using it.
 */
export function syncReviewDetail(s) {
  const fill = (el, html) => {
    if (!el) return;
    if (el.dataset.sig !== html) { el.dataset.sig = html; el.innerHTML = html; }
    el.hidden = !html;
  };
  fill($('dtLinks'), prLinkHtml(s));
  fill($('dtSquadHealth'), healthChecksHtml(s.squad && s.squad.health));
}
