import {
  esc, num, timeCell, activityLine, lastApprovalOutcome, ANSWER_VERB, agentLabel, statusBadge,
} from './util.js';
import { needsAttention, sessionKey } from './list.js';

// ---------------------------------------------------------------------------
// The session row (#169/#170): split out of list.js to stay under the
// per-file size budget (test/package-unit.js) -- everything here is still
// pure, DOM-free markup building, same as list.js's other exports.
// ---------------------------------------------------------------------------

/**
 * What a session is CALLED on screen (#170): a custom name, when one was
 * set, else the prompt (falling back to the id) -- the same rule
 * `sessionName` already uses for sorting. `names` is keyed by `sessionKey`,
 * so a rename survives a refresh for the same reason a pin does.
 */
export function displayTitle(s, names = {}) {
  const custom = names && names[sessionKey(s)];
  return (typeof custom === 'string' && custom.trim()) || s.prompt || s.id || '';
}

export function sessionRow(s, deviceName, opts = {}) {
  const device = opts.device;
  const pending = needsAttention(s, device);
  const pinned = !!opts.pinned;
  // A rename (#170) replaces the title; the prompt stays one hover away via
  // `title` below (the mockup's "visible as a subtitle or tooltip").
  const renamed = displayTitle(s, opts.names) !== (s.prompt || s.id || '');
  const title = displayTitle(s, opts.names).slice(0, 70);
  const sq = s.squad;
  const sel = s.agentSelection;
  const git = s.git;
  const outcome = lastApprovalOutcome(s);
  const agentInfo = agentLabel(s);
  // `sel` (session.agentSelection), `git` (repository/branch read from the
  // session's own checkout) and `deviceName`/`sq.project`/`s.cwd` all
  // ultimately trace back to attacker-influenceable input: a project's own
  // `.squad-hub.json` (agent/model), a `.git/config` remote or branch name, a
  // device's self-reported name, or a relayed hub's session/device records.
  // None of it is trusted HTML, so every field landing in this string gets
  // `esc()`'d -- a stored payload (e.g. an `agent` of `<img src=x onerror=...>`,
  // or a branch literally named `<img src=x onerror=...>`, which git permits)
  // must render as inert text, never live markup, however it got here.
  const deviceText = esc(deviceName);
  const repoRaw = git && git.repository ? git.repository : (sq ? sq.project : s.cwd);
  const repoText = esc(repoRaw);
  // Device, repository and branch each carry a `title` with their own full
  // value. The meta line as a whole is clipped with an ellipsis by CSS once
  // it runs out of room, and a clipped field with nothing to hover is a fact
  // the row knows and simply does not tell you -- the title is what makes
  // the full value one hover away instead of a trip to the detail panel.
  const meta = [
    deviceText ? `<span class="meta-field" title="${deviceText}">${deviceText}</span>` : '',
    repoText ? `<span class="meta-field" title="${repoText}">${repoText}</span>` : '',
    git && git.branch ? `<span class="branch" title="${esc(git.branch)}">${esc(git.branch)}</span>` : '',
    sel ? `<span class="${agentInfo.mismatch ? 'agent-mismatch' : ''}">${esc(agentInfo.text)}</span>` : esc(s.agent || 'Copilot CLI'),
    s.startedAt ? timeCell(s.startedAt) : '',
    s.toolCallCount ? `${num(s.toolCallCount)} tools` : '',
  ].filter(Boolean).join(' &middot; ');

  // A Squad session is a team working under a charter, not a lone agent. The
  // badge says which, because "6 members, engineer active" is the difference
  // between a session list and a Squad session list.
  //
  // Every part is rendered ONLY when the number behind it is really there. A
  // device on an older version, or any partial payload, otherwise puts the
  // literal text "undefined/undefined members" in front of a user -- which
  // reads as a broken product rather than as missing data.
  const hasCounts = Number.isFinite(sq && sq.activeMembers) && Number.isFinite(sq && sq.memberCount);
  // `activeMember` is now `null` (no idea), `{name: null, coordinator: true}`
  // (the coordinator itself is acting) or `{name: '<member>', ...}` (a named
  // member is acting) -- three different facts, and only the named-member
  // case is worth a slot in the row. The pill already says "squad"; repeating
  // the coordinator's own name there would put SQUAD next to Squad and tell
  // the reader nothing twice, and inventing a name for "unknown" would be
  // worse than showing nothing. `inferred` (a mention, not a delegation) gets
  // a title rather than its own badge, since it is the same fact shown with
  // less confidence, not a different fact.
  const am = sq && sq.activeMember;
  const activeName = am && am.name ? am.name : '';
  const squadBits = sq ? `      <div class="squadline">
        <span class="sq-pill" title="Squad workspace">squad</span>
        ${activeName ? `<span class="sq-role"${am.inferred ? ' title="inferred, not asserted"' : ''}>${esc(activeName)}</span>` : ''}
        ${hasCounts ? `<span class="sq-dim">${num(sq.activeMembers)}/${num(sq.memberCount)} members</span>` : ''}
        ${sq.decisionCount ? `<span class="sq-dim">${num(sq.decisionCount)} decisions</span>` : ''}
        ${sq.models && !sq.models.uniform ? '<span class="sq-warn" title="Members are not all on the same model">mixed models</span>' : ''}
      </div>` : '';

  // The pill is emitted before `.row-main` -- grid-column in devices.css
  // still draws it third -- so it, not `.row-main`'s own unrelated
  // `.expiredline` status, is the first `.status` in source order (#169).
  return `
    <div class="row ${pending ? 'attention' : ''}" data-session="${esc(s.key)}">
      <button class="star ${pinned ? 'on' : ''}" data-star="${esc(sessionKey(s))}"
              title="${pinned ? 'Unpin this session' : 'Pin this session'}"
              aria-label="${pinned ? 'Unpin' : 'Pin'}" aria-pressed="${pinned ? 'true' : 'false'}">${pinned ? '★' : '☆'}</button>
      ${statusBadge(s, device)}
      <div class="row-main">
        <div class="row-title">
          <b${renamed ? ` title="${esc(s.prompt || s.id || '')}"` : ''}>${esc(title)}</b>
          <span class="activity">${esc(activityLine(s, device))}</span>
        </div>
        <div class="row-meta">${meta}</div>
        ${outcome ? (outcome.kind === 'expired'
    ? `<div class="expiredline"><span class="status expired">Expired</span><span class="sq-dim">${esc(outcome.title)} — ${outcome.reason === 'device disconnected' ? 'the device disconnected before anyone answered' : 'nobody answered in time'}</span></div>`
    : `<div class="expiredline"><span class="status answered">${esc(ANSWER_VERB[outcome.optionId] || 'Answered')}</span><span class="sq-dim">${esc(outcome.title)} — by ${esc(outcome.answeredBy)}</span></div>`) : ''}
        ${squadBits}
      </div>
      <button class="more" data-more="${esc(sessionKey(s))}"
              aria-haspopup="true" aria-expanded="false" aria-label="More actions" title="More actions">⋯</button>
    </div>`;
}
