import {
  $, esc, num, asList, ago, exact, ANSWER_VERB,
} from './util.js';
import {
  deviceDisplayName, deviceExecutionId, platformLabel, presenceLabel,
} from './devices.js';
import { acaIssueLink } from './aca.js';

// ---------------------------------------------------------------------------
// The Info tab (#182)
//
// Everything here is read from the session and device records the page already
// holds. There is no request of its own, and nothing is shown that the device
// did not report: a field that is missing says "not reported" rather than a
// guess, because a plausible invention is worse than an honest gap.
// ---------------------------------------------------------------------------

/** What each Squad health check is called, keyed by the id the device sends. */
export const SQUAD_CHECK_LABEL = {
  team: 'Team',
  'registry-charters': 'Charters',
  routing: 'Routing',
  'state-backend': 'State backend',
  'env-vars': 'Environment',
};

const dim = (text) => `<span class="dt-dim">${esc(text)}</span>`;
const orGap = (text) => (text ? esc(text) : dim('not reported'));

/** An http(s) address safe to put in an href, or null. Anything else is not a link. */
export function safeHttpUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch { return null; }
}

/** A moment written both ways: the exact time, then how long ago. */
function momentHtml(ms) {
  return Number.isFinite(ms) && ms > 0 ? `${esc(exact(ms))} ${dim(`(${ago(ms)})`)}` : dim('not reported');
}

/**
 * Agent, model or mode: what the device APPLIED when it said so, otherwise what
 * was asked for -- labeled as only a request, since the two can disagree.
 */
function infoChoice(session, field) {
  const got = session.applied && session.applied[field];
  if (got) return esc(got);
  const want = session.agentSelection && session.agentSelection[field];
  if (want) return `${esc(want)} ${dim('(requested; the device has not confirmed it)')}`;
  return field === 'agent' && session.agent ? esc(session.agent) : dim('not reported');
}

/**
 * Squad health for the Info tab: the device's overall verdict, then each check
 * on its own. The hub only relays what the device's Squad CLI reported, so
 * "unavailable" and "unknown" are shown as exactly that, never as passing.
 */
export function infoHealthView(session) {
  const squad = session && session.squad;
  if (!squad) return { state: 'none', text: 'No Squad workspace reported', checks: [] };
  const health = squad.health;
  if (!health || typeof health !== 'object') {
    return { state: 'unreported', text: 'Not reported by this device', checks: [] };
  }
  const checks = asList(health.checks).filter((c) => c && c.id).map((c) => ({
    id: String(c.id),
    label: SQUAD_CHECK_LABEL[c.id] || String(c.id),
    status: String(c.status || 'unknown'),
  }));
  const skipped = checks.filter((c) => c.status === 'skip').length;
  const verdict = checks.some((c) => c.status === 'fail') ? 'fail' : String(health.status || 'unreported');
  const overall = {
    pass: `No failures reported${skipped ? `; ${skipped} skipped` : ''}`,
    fail: 'A check failed',
    unavailable: 'Unavailable on this device',
    unknown: 'Not checked yet',
  }[verdict] || 'Not reported by this device';
  return { state: verdict, text: overall, checks };
}

const HEALTH_TONE = { pass: 'review', fail: 'failed', skip: 'stale' };
const pillHtml = (tone, text, title = '') => `<span class="dt-pill ${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

function squadHealthHtml(session) {
  const v = infoHealthView(session);
  if (v.state === 'none' || v.state === 'unreported') return dim(v.text);
  const tone = HEALTH_TONE[v.state] || 'stale';
  const checks = v.checks.map((c) => pillHtml(HEALTH_TONE[c.status] || 'stale', `${c.label} · ${c.status}`, c.id));
  return `<div class="dt-pills">${[pillHtml(tone, v.text), ...checks].join('')}</div>`;
}

/**
 * Links the device actually reported -- nothing is built from a pattern. An
 * issue link needs the repository and number the ACA job itself sent; the
 * pull request and Aspire dashboard come from the session record. No lease is
 * reported by any device today, so none is shown.
 */
export function infoLinks(found) {
  const { device, session } = found;
  const meta = (device && device.meta) || {};
  const links = [];
  const issue = acaIssueLink(meta.repo, meta.issue);
  if (issue) links.push({ label: `Issue #${meta.issue}`, href: issue });
  const pr = session.pullRequest && safeHttpUrl(session.pullRequest.url);
  if (pr) links.push({ label: session.pullRequest.number ? `Pull request #${session.pullRequest.number}` : 'Pull request', href: pr });
  const aspire = safeHttpUrl(session.aspireUrl);
  if (aspire) links.push({ label: 'Aspire dashboard', href: aspire });
  return links;
}

function linksHtml(links) {
  return links.map((l) => `<a class="dt-link" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join(' &middot; ');
}

/** The Info tab's detail rows, each `{ key, label, html }` with `html` already escaped. */
export function sessionInfoRows(found) {
  const { device, session: s } = found;
  const git = s.git || {};
  const deviceParts = device ? [
    esc(deviceDisplayName(device)),
    device.platform ? esc(platformLabel(device.platform)) : '',
    esc(presenceLabel(device)),
    deviceExecutionId(device) ? `run ${esc(deviceExecutionId(device))}` : '',
  ].filter(Boolean) : [];
  const repo = git.repository ? `${esc(git.repository)}${git.host ? ` ${dim(`(${git.host})`)}` : ''}` : dim('not reported');
  const rows = [
    { key: 'device', label: 'Device', html: deviceParts.length ? deviceParts.join(' &middot; ') : dim('not reported') },
    { key: 'cwd', label: 'Working directory', html: s.cwd ? `<code>${esc(s.cwd)}</code>` : dim('not reported') },
    { key: 'repository', label: 'Repository', html: repo },
    { key: 'branch', label: 'Branch', html: orGap(git.branch) },
    { key: 'agent', label: 'Agent', html: infoChoice(s, 'agent') },
    { key: 'model', label: 'Model', html: infoChoice(s, 'model') },
    { key: 'mode', label: 'Mode', html: infoChoice(s, 'mode') },
    { key: 'started', label: 'Started', html: momentHtml(s.startedAt) },
    { key: 'lastActivity', label: 'Last activity', html: momentHtml(s.lastActivityAt) },
    {
      key: 'toolCalls',
      label: 'Tool calls',
      html: s.toolCallCount === undefined || s.toolCallCount === null ? dim('not reported') : String(num(s.toolCallCount)),
    },
    { key: 'squadHealth', label: 'Squad health', html: squadHealthHtml(s) },
  ];
  const links = infoLinks(found);
  const isAca = !!device && device.kind === 'aca';
  if (isAca || links.length) {
    rows.push({
      key: 'links',
      label: isAca ? 'ACA' : 'Links',
      html: links.length ? linksHtml(links) : dim('no issue, pull request or dashboard link reported'),
    });
  }
  return rows;
}

/**
 * Every permission request that is no longer waiting, newest first: who
 * answered it, what it was for, when, and from where. An expired request has
 * no answerer -- the history says "not answered" rather than inventing one.
 */
export function approvalHistory(session, device) {
  const where = (device && device.name) || 'the device';
  const answered = asList(session && session.answeredApprovals).map((a) => ({
    approvalId: a.approvalId,
    kind: 'answered',
    outcome: a.optionId,
    label: ANSWER_VERB[a.optionId] || 'Answered',
    tone: a.optionId === 'reject_once' ? 'failed' : 'review',
    what: a.title || 'a tool call',
    who: a.answeredBy || 'someone',
    from: a.answeredVia === 'terminal' ? `at the terminal on ${where}` : 'from the hub',
    at: a.answeredAt || 0,
  }));
  const expired = asList(session && session.expiredApprovals).map((a) => ({
    approvalId: a.approvalId,
    kind: 'expired',
    outcome: 'expired',
    label: 'Expired',
    tone: 'stale',
    what: a.title || 'a tool call',
    who: null,
    from: `on ${where}${a.reason ? ` (${a.reason})` : ''}`,
    at: a.expiredAt || 0,
  }));
  return [...answered, ...expired].sort((a, b) => b.at - a.at);
}

export function approvalHistoryHtml(history) {
  if (!history.length) {
    return '<li class="dt-empty">No permission request has been answered or has expired in this session.</li>';
  }
  return history.map((h) => `
    <li class="dt-hist-row" data-outcome="${esc(h.outcome)}" data-approval="${esc(h.approvalId)}">
      ${pillHtml(h.tone, h.label)}
      <span class="dt-chip" title="${esc(h.what)}">${esc(h.what)}</span>
      <span class="dt-hist-who">${h.who ? `by ${esc(h.who)}` : 'not answered'} &middot; ${esc(h.from)}</span>
      <span class="dt-hist-when" title="${esc(exact(h.at))}">${esc(ago(h.at))}</span>
    </li>`).join('');
}

// What was last written, so the live feed does not rebuild (and so flicker,
// and drop a text selection from) an Info tab whose content has not changed.
let infoRowsShown = null;
let infoHistoryShown = null;

/** Paint the Info tab for the open session; a no-op for whatever has not changed. */
export function renderInfoPane(found) {
  const rowsEl = $('dtInfoRows');
  const histEl = $('dtInfoHistory');
  if (!rowsEl || !histEl || !found) return;
  const rows = sessionInfoRows(found)
    .map((r) => `<tr data-info="${esc(r.key)}"><th scope="row">${esc(r.label)}</th><td>${r.html}</td></tr>`).join('');
  const history = approvalHistoryHtml(approvalHistory(found.session, found.device));
  if (rows !== infoRowsShown) { rowsEl.innerHTML = rows; infoRowsShown = rows; }
  if (history !== infoHistoryShown) { histEl.innerHTML = history; infoHistoryShown = history; }
}

/** Forget what was painted, so the next render writes even identical content. */
export function resetInfoPane() {
  infoRowsShown = null;
  infoHistoryShown = null;
}
