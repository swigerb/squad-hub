import { state, api } from './api.js';
import { esc, num, $ } from './util.js';

// The Squad panel and its document bar, moved out of detail.js unchanged so
// the detail page could gain tabs (#182) without that module outgrowing its
// size budget. Rendering and behavior are exactly what they were.
/**
 * The Squad panel: team, models, and recent decisions beside the transcript.
 *
 * Decisions are the artifact people actually go looking for after the fact --
 * "why did it do that" is answered in decisions.md, not in a tool log.
 */
export function renderSquadPanel(sq) {
  const el = $('dtSquad');
  if (!sq) { el.hidden = true; return; }
  el.hidden = false;

  const models = sq.models || {};
  const modelLine = models.uniform
    ? `all on <b>${esc((models.distinctModels || [])[0] || models.defaultModel || 'default')}</b>`
    : `<span class="sq-warn">mixed: ${esc((models.distinctModels || []).join(', '))}</span>`;
  const policyBits = [];
  if (models.costPolicy && models.costPolicy.maxCategory) {
    policyBits.push(`cost ceiling: ${esc(models.costPolicy.maxCategory)}`);
  }
  if (models.economyMode) policyBits.push('economy mode');
  const modelSummary = [modelLine, ...policyBits.map((p) => `<span class="sq-dim">${p}</span>`)].join(' &middot; ');

  // Same rule as the row badge: a count is shown only when there is a count,
  // and the lists are defended because a partial payload must degrade rather
  // than throw halfway through building the panel.
  const counts = Number.isFinite(sq.activeMembers) && Number.isFinite(sq.memberCount)
    ? `${num(sq.activeMembers)}/${num(sq.memberCount)} members &middot; ` : '';
  const members = Array.isArray(sq.members) ? sq.members : [];
  const decisions = Array.isArray(sq.decisions) ? sq.decisions : [];

  el.innerHTML = `
    <div class="sq-head">
      <b>${esc(sq.project)}</b>
      <span class="sq-dim">${counts}${modelSummary}</span>
    </div>
    ${sq.memberSource ? `<div class="sq-sub">Roster source: ${esc(sq.memberSource)}</div>` : ''}
    <div class="sq-health" id="dtSquadHealth" hidden></div>
    <div class="sq-members">
      ${members.map((m) => `
        <button type="button" class="sq-member ${sq.activeMember && sq.activeMember.name === m.name ? 'now' : ''} ${m.active ? '' : 'off'}"
                data-squaddoc="charter:${esc(m.name)}" title="Read ${esc(m.name)}'s charter">
          ${esc(m.name)}${m.role && m.role !== m.name ? `<i>${esc(m.role)}</i>` : ''}
        </button>`).join('')}
    </div>
    <div class="sq-docbar" id="dtSquadDocs"></div>
    <div class="sq-doc" id="dtSquadDoc" hidden></div>
    ${decisions.length ? `
      <div class="sq-sub">Recent decisions (${num(sq.decisionCount)})</div>
      <ol class="sq-decisions">
        ${sq.decisions.slice(0, 5).map((d) => `
          <li class="${d.superseded ? 'old' : ''}">
            ${d.date ? `<span class="sq-date">${esc(d.date)}</span>` : ''}
            <span class="sq-title">${esc(d.title)}</span>
            ${d.summary ? `<div class="sq-why">${esc(d.summary.slice(0, 180))}${d.summary.length > 180 ? '…' : ''}</div>` : ''}
          </li>`).join('')}
      </ol>` : '<div class="sq-sub">No decisions recorded yet</div>'}`;

  renderSquadDocBar();
}

/**
 * The documents this workspace actually has.
 *
 * Asked for once, when the session is opened. Offering a document that is not
 * there is a link to a dead end; hiding one that is, is worse -- and only the
 * device can answer, so it is asked rather than guessed.
 *
 * Member charters are reached by clicking the member, so the bar carries the
 * whole-team documents and nothing else.
 */
const TEAM_DOC_LABEL = { team: 'Team', decisions: 'Decisions', routing: 'Routing', config: 'Models' };

async function renderSquadDocBar() {
  const bar = $('dtSquadDocs');
  if (!bar || !state.currentSession) return;
  const { device, session } = state.currentSession;
  bar.innerHTML = '';
  let docs = [];
  try {
    const r = await api(`/api/devices/${encodeURIComponent(device.deviceId)}/squad-docs`, {
      method: 'POST', body: { sessionId: session.id },
    });
    docs = (r && r.docs) || [];
  } catch {
    // The device holds these files, so it is the only thing that can list
    // them. Saying so beats an empty bar that looks like an empty team.
    bar.innerHTML = '<span class="sq-dim">the device is offline; these files live on it</span>';
    return;
  }
  const teamDocs = docs.filter((d) => Object.prototype.hasOwnProperty.call(TEAM_DOC_LABEL, d));
  /**
   * A member with no charter is not offered as one.
   *
   * The coordinator usually has no `charter.md`, so every panel had at least
   * one button that looked live and answered "no charter:Squad in this
   * workspace". Offering a link to a dead end is the thing the document list
   * exists to prevent -- it applies to members as much as to tabs.
   */
  const haveCharter = new Set(docs.filter((d) => d.startsWith('charter:')));
  for (const b of document.querySelectorAll('#dtSquad .sq-member[data-squaddoc]')) {
    const ok = haveCharter.has(b.dataset.squaddoc);
    b.classList.toggle('nodoc', !ok);
    b.disabled = !ok;
    if (!ok) b.title = 'no charter recorded for this member';
  }
  if (!teamDocs.length) return;
  bar.innerHTML = teamDocs
    .map((d) => `<button type="button" class="sq-doctab" data-squaddoc="${esc(d)}">${esc(TEAM_DOC_LABEL[d])}</button>`)
    .join('');
}
