import { state, api } from './api.js';
import {
  esc, num, truncateWords, statusLabel, statusPillClass,
} from './util.js';
import { controlBanner, composerReduce } from './composer.js';
import { refresh, resolveDeepLink, toggleFavorite } from './ws.js';
import { sidebarEntries, sidebarRow, sessionKey } from './list.js';
// Circular by necessity: the detail panel still delegates to the DOM helper
// that stays in app.js for part 4 of #165. Both modules only reach into
// the other from inside a function body, never at module-evaluation time,
// so the cycle resolves the same way it would for any two ES modules that
// call back into each other.
import { $ } from '../app.js';

// ---------------------------------------------------------------------------
// Session detail: a full page at /?session=<key>, not a modal (#181)
//
// Three ways in, one history model:
//   - a row or a sidebar entry is clicked                 -> pushState
//   - a deep link is opened or the page loads with one    -> replaceState
//   - the browser's Back/Forward button fires `popstate`  -> no history write
// `NAV` names the three so a caller cannot forget which one its situation
// calls for; "I navigated, so update the URL" is the bug this exists to rule
// out, because `popstate` already IS the URL changing and doing it again
// would push the same entry twice.
// ---------------------------------------------------------------------------
const NAV = { PUSH: 'push', REPLACE: 'replace', NONE: 'none' };

function findSession(key) {
  for (const g of state.overview.groups) {
    for (const s of g.sessions) if (s.key === key) return { device: g.device, session: s };
  }
  return null;
}

function applyNav(nav, key) {
  if (nav === NAV.NONE) return;
  const url = key ? `/?session=${encodeURIComponent(key)}` : '/';
  const entry = { squadHubSession: key || null };
  if (nav === NAV.REPLACE) history.replaceState(entry, '', url);
  else history.pushState(entry, '', url);
}

function showDetailPage() {
  const list = $('listPage');
  if (list) list.hidden = true;
  $('detailScrim').hidden = false;
}

function hideDetailPage() {
  $('detailScrim').hidden = true;
  const list = $('listPage');
  if (list) list.hidden = false;
}

/** The session named in the address bar right now, without consuming it. */
export function urlSessionKey() {
  return new URLSearchParams(location.search).get('session');
}

export async function openDetail(key, { nav = NAV.PUSH } = {}) {
  const found = findSession(key);
  if (!found) return false;
  applyNav(nav, key);
  state.currentSession = found;
  // Cut at a word boundary. `slice(0, 80)` alone ended titles mid-word --
  // "...as the Squad team, using y" -- which reads as a rendering fault rather
  // than as a long prompt.
  $('dtTitle').textContent = truncateWords(found.session.prompt || found.session.id, 80);
  // The status is shown as its LABEL, never as its internal name. A raw `idle`
  // or `waiting_approval` in the meta line is the same leak the badge already
  // guards against.
  $('dtMeta').textContent = [
    found.device.name,
    found.session.cwd || '',
    statusLabel(found.session),
  ].filter(Boolean).join(' · ');
  const pillCls = statusPillClass(found.session);
  $('dtStatusPill').className = `dt-pill ${pillCls}`;
  $('dtStatusPill').textContent = statusLabel(found.session);
  const pinned = state.favorites.has(sessionKey(found.session));
  const star = $('dtStar');
  star.dataset.star = sessionKey(found.session);
  star.classList.toggle('on', pinned);
  star.textContent = pinned ? '★' : '☆';
  star.title = pinned ? 'Unpin this session' : 'Pin this session';
  star.setAttribute('aria-label', pinned ? 'Unpin this session' : 'Pin this session');
  star.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  // Prefilled from the session when it is on GitHub. Shown either way now that
  // the dialog takes a repository: a run does not have to be about the
  // repository you happen to be looking at.
  $('dtAca').hidden = false;

  /**
   * Say WHY the agent or model is not the one that was asked for.
   *
   * The row already reports the disagreement -- "running default agent, not
   * Squad" -- and the session records the reason, but nothing ever displayed
   * it. So the one question that reading it provokes ("why?") had no answer
   * anywhere in the product, and the honest report read as an odd glitch.
   */
  const warnings = [
    ...(((found.session.applied || {}).warnings) || []),
    ...(((found.session.agentSelection || {}).warnings) || []),
  ].filter(Boolean);
  $('dtWarn').textContent = warnings.join(' · ');
  $('dtWarn').hidden = warnings.length === 0;
  renderSquadPanel(found.session.squad);
  $('dtTranscript').innerHTML = '<div class="t-entry t-kind">loading…</div>';
  showDetailPage();
  renderSidebar();

  // The composer starts DISABLED and stays that way until the device itself
  // says it can take input. The draft is restored rather than reset -- someone
  // may have typed it, failed to send, and come back.
  state.composer = composerReduce(state.composer, { type: 'verify-start' });
  $('dtInput').value = state.composer.draft || '';
  renderControl();

  try {
    const r = await api(`/api/devices/${encodeURIComponent(found.device.deviceId)}/transcript`, {
      method: 'POST', body: { sessionId: found.session.id, limit: 200 },
    });
    renderTranscript(r.transcript || []);
  } catch (e) {
    $('dtTranscript').innerHTML = `<div class="t-entry t-kind">could not load the transcript: ${esc(e.message)}</div>`;
  }

  // Deliberately AFTER the transcript: a session that cannot be controlled is
  // still worth reading, and blocking the transcript on a control check would
  // make an unreachable device hide the very history explaining why.
  verifyControl();
  return true;
}

/**
 * Leave the detail page and show the list again.
 *
 * `nav` follows the same rule as `openDetail`: a person clicking the back
 * link pushes (or rather, writes) a `/` entry so Forward can return them; a
 * `popstate` handler passes `NAV.NONE` because the browser already wrote the
 * entry that got it here.
 */
export function closeDetail({ nav = NAV.PUSH } = {}) {
  state.currentSession = null;
  applyNav(nav, null);
  hideDetailPage();
}

/**
 * Pin or unpin the session currently open, from the header star.
 *
 * Delegates to the same `toggleFavorite` the row's own star uses, so the two
 * can never disagree about which sessions are pinned -- it is the one list,
 * read from the one place it is stored.
 */
export function toggleCurrentFavorite() {
  const current = state.currentSession;
  if (!current) return;
  toggleFavorite(sessionKey(current.session));
  const pinned = state.favorites.has(sessionKey(current.session));
  const star = $('dtStar');
  star.classList.toggle('on', pinned);
  star.textContent = pinned ? '★' : '☆';
  star.title = pinned ? 'Unpin this session' : 'Pin this session';
  star.setAttribute('aria-label', pinned ? 'Unpin this session' : 'Pin this session');
  star.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  renderSidebar();
}

/**
 * The sidebar list: every session the current filter box matches, with the
 * open one highlighted. Re-run on every refresh so a session that starts,
 * finishes or gets pinned while this page is open is reflected without
 * leaving it -- the whole point of a sidebar is to not have to.
 */
export function renderSidebar() {
  const list = $('detailSidebarList');
  if (!list) return;
  const filterBox = $('dtSidebarFilter');
  const filterText = filterBox ? filterBox.value : '';
  const selectedKey = state.currentSession ? sessionKey(state.currentSession.session) : null;
  const entries = sidebarEntries((state.overview && state.overview.groups) || [], filterText);
  list.innerHTML = entries.length
    ? entries.map((e) => sidebarRow(e, selectedKey)).join('')
    : '<div class="dt-side-empty">No sessions match this filter</div>';
}

/**
 * Keep the open detail header in step with the live feed, without replaying
 * the whole `openDetail` flow.
 *
 * `render()` in devices.js runs on every refresh and every WebSocket push --
 * every few seconds while the detail page is open, and far more often than
 * anything in the header actually changes. Re-fetching the transcript and
 * resetting the composer's draft that often would make the page unusable the
 * moment someone started typing a follow-up. This updates only the fields
 * that come from the session record itself (title, status, warnings, pin)
 * and the sidebar; the transcript keeps streaming through its own update
 * path, and the composer is left alone entirely.
 */
export function syncDetailHeader() {
  renderSidebar();
  if (!state.currentSession) return;
  const key = sessionKey(state.currentSession.session);
  const found = findSession(key);
  if (!found) return;
  state.currentSession = found;
  $('dtTitle').textContent = truncateWords(found.session.prompt || found.session.id, 80);
  $('dtMeta').textContent = [
    found.device.name,
    found.session.cwd || '',
    statusLabel(found.session),
  ].filter(Boolean).join(' · ');
  $('dtStatusPill').className = `dt-pill ${statusPillClass(found.session)}`;
  $('dtStatusPill').textContent = statusLabel(found.session);
  const warnings = [
    ...(((found.session.applied || {}).warnings) || []),
    ...(((found.session.agentSelection || {}).warnings) || []),
  ].filter(Boolean);
  $('dtWarn').textContent = warnings.join(' · ');
  $('dtWarn').hidden = warnings.length === 0;
  const pinned = state.favorites.has(key);
  const star = $('dtStar');
  star.classList.toggle('on', pinned);
  star.textContent = pinned ? '★' : '☆';
}

/**
 * Wire the routing-related controls that live only on the detail page: the
 * two back links, the sidebar's filter box and selection clicks, and the
 * browser's own Back/Forward button. Called once, from `wire()` in app.js.
 */
export function initDetailRouting() {
  const back = (e) => { e.preventDefault(); closeDetail(); };
  const dtBack = $('dtBack');
  if (dtBack) dtBack.onclick = back;
  const dtBackPhone = $('dtBackPhone');
  if (dtBackPhone) dtBackPhone.onclick = back;

  const filterBox = $('dtSidebarFilter');
  if (filterBox) filterBox.oninput = () => renderSidebar();

  const list = $('detailSidebarList');
  if (list) {
    list.onclick = (e) => {
      const row = e.target.closest('[data-session]');
      if (row) openDetail(row.dataset.session);
    };
  }

  const star = $('dtStar');
  if (star) star.onclick = () => toggleCurrentFavorite();

  window.addEventListener('popstate', () => {
    const wanted = urlSessionKey();
    if (!wanted) { closeDetail({ nav: NAV.NONE }); return; }
    const hit = resolveDeepLink(wanted, (state.overview && state.overview.groups) || []);
    if (hit.status === 'found') openDetail(hit.key, { nav: NAV.NONE });
    else closeDetail({ nav: NAV.NONE });
  });
}


/** How long to wait for the device to answer before saying so. */
const CONTROL_TIMEOUT_MS = 8000;

/**
 * Ask the device whether it can take a control command for this session.
 *
 * The answer comes from the machine running the agent, not from the hub. The
 * hub is a cache: it knowing about a session proves only that a heartbeat once
 * mentioned it.
 */
async function verifyControl() {
  const current = state.currentSession;
  if (!current) return;
  state.composer = composerReduce(state.composer, { type: 'verify-start' });
  renderControl();

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), CONTROL_TIMEOUT_MS));
  const ask = api(`/api/devices/${encodeURIComponent(current.device.deviceId)}/control-check`, {
    method: 'POST', body: { sessionId: current.session.id },
  }).catch((e) => ({ error: e.message }));

  const outcome = await Promise.race([ask, timeout]);

  // The detail panel may have been closed, or moved to another session, while
  // this was in flight. Applying a stale answer would enable the composer for
  // a session nobody verified.
  if (state.currentSession !== current) return;

  state.composer = composerReduce(state.composer, { type: 'verify-result', outcome });
  renderControl();
}

/**
 * `Sync session` -- restart the engine, keeping the session id, then re-check.
 *
 * Re-verifying alone would be a button that asks the same question twice and
 * expects a different answer. When the device has said the agent process is
 * gone, nothing changes until something restarts it.
 *
 * The id survives on purpose: it is what the row, the Teams card and anyone's
 * terminal history all refer to. A "sync" that produced a new session would
 * quietly orphan every one of those references.
 */
export async function syncSession() {
  const current = state.currentSession;
  if (!current) return;
  const btn = $('dtSync');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    await api(`/api/devices/${encodeURIComponent(current.device.deviceId)}/resync`, {
      method: 'POST', body: { sessionId: current.session.id },
    });
    await refresh();
  } catch (e) {
    state.composer = composerReduce(state.composer, { type: 'verify-result', outcome: { error: e.message } });
    renderControl();
    return;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sync session'; }
  }
  // Only now is the question worth asking again.
  await verifyControl();
}

export function renderControl() {
  const b = controlBanner(state.composer.control, state.composer.reason);
  const banner = $('dtControl');
  if (banner) banner.dataset.state = b.state;
  $('dtControlLabel').textContent = b.label;
  // The banner's own reason takes precedence -- a control problem is more
  // urgent than the fate of the last message. Otherwise, say what happened to
  // that message, because "queued" and "delivered" are different promises and
  // the person who pressed send is entitled to know which one they got.
  $('dtControlWhy').textContent = b.reason || state.composer.outcomeNote || '';
  $('dtSync').hidden = !b.canSync;
  $('dtInput').disabled = !b.enabled;
  $('dtSend').disabled = !b.enabled;
  $('dtInput').placeholder = b.enabled
    ? 'Send follow-up input to the running agent'
    : 'Controls are disabled until this session is verified';
}

/**
 * The Squad panel: team, models, and recent decisions beside the transcript.
 *
 * Decisions are the artifact people actually go looking for after the fact --
 * "why did it do that" is answered in decisions.md, not in a tool log.
 */
function renderSquadPanel(sq) {
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

/**
 * Show one Squad document.
 *
 * ESCAPED TEXT, NOT RENDERED MARKDOWN. These files are written by agents as
 * well as by people, so turning them into HTML would let a careless or
 * compromised agent put markup in a charter and have the hub execute it in the
 * reader's browser, holding the reader's hub credential. Headings and list
 * markers are styled by decorating the LINE; nothing in the file ever becomes
 * markup.
 */
export async function openSquadDoc(doc) {
  const box = $('dtSquadDoc');
  if (!box || !state.currentSession) return;
  const { device, session } = state.currentSession;

  for (const b of document.querySelectorAll('[data-squaddoc]')) {
    b.classList.toggle('on', b.dataset.squaddoc === doc);
  }
  box.hidden = false;
  box.innerHTML = '<div class="sq-dim">loading…</div>';

  let r;
  try {
    r = await api(`/api/devices/${encodeURIComponent(device.deviceId)}/squad-doc`, {
      method: 'POST', body: { sessionId: session.id, doc },
    });
  } catch (e) {
    box.innerHTML = `<div class="sq-dim">${esc(e.message)}</div>`;
    return;
  }

  // Split on CRLF as well as LF. These files are written on whatever machine
  // the Squad runs on, and a stray \r left on the end of every line renders as
  // an extra blank line inside <pre> -- which is why a charter appeared to be
  // double-spaced.
  const lines = String(r.text || '').split(/\r?\n/);
  box.innerHTML = `
    <div class="sq-docmeta">
      <b>${esc(doc)}</b>
      <span class="sq-dim">${Number(r.bytes || 0).toLocaleString()} bytes${
  r.truncated ? ' · showing the first 256 KB' : ''}</span>
    </div>
    <pre class="sq-doctext">${lines.map((l) => {
    const t = l.trimStart();
    const cls = t.startsWith('#') ? 'md-h' : (/^[-*+]\s|^\d+\.\s/.test(t) ? 'md-li' : (t.startsWith('>') ? 'md-q' : ''));
    return `<span class="${cls}">${esc(l)}</span>`;
  }).join('\n')}</pre>`;
}

/**
 * Pull readable text out of an ACP update, whatever shape it arrived in.
 *
 * `content` is a string on some updates, an object with `.text` on others, and
 * an array of content blocks on tool results. The old reader tried
 * `u.content.text || u.content`, so an ARRAY fell through to the second branch
 * and was printed as raw JSON -- which is why a tool result showed up as
 * `[{"type":"content","content":{"type":"text","text":"Query returned 0 rows."}}]`
 * instead of "Query returned 0 rows."
 */
function updateText(u) {
  const fromBlock = (b) => {
    if (typeof b === 'string') return b;
    if (!b || typeof b !== 'object') return '';
    if (typeof b.text === 'string') return b.text;
    if (b.content) return fromBlock(b.content);
    return '';
  };
  if (Array.isArray(u.content)) return u.content.map(fromBlock).filter(Boolean).join('\n');
  const direct = fromBlock(u.content);
  if (direct) return direct;
  return typeof u.text === 'string' ? u.text : '';
}

/**
 * Updates that are protocol bookkeeping, not conversation.
 *
 * `usage_update` fires on every token, and `available_commands_update` and
 * `config_option_update` fire whenever the agent reconfigures itself. None of
 * them carry anything a person reads, and rendering them put a row of grey
 * noise between every useful line.
 */
const TRANSCRIPT_NOISE = new Set([
  'usage_update', 'available_commands_update', 'config_option_update',
  'current_mode_update', 'plan', 'agent_thought_chunk',
]);

/**
 * Group a raw update stream into blocks a person can read.
 *
 * THE STREAM IS TOKENS, NOT LINES. `agent_message_chunk` arrives many times per
 * sentence, and the old renderer gave each one its own row -- which is why a
 * finished answer displayed one word per line down the page. Consecutive
 * chunks from the same speaker belong to one block.
 *
 * Tool results are kept but capped: the point is to see THAT a tool ran and
 * roughly what came back, not to scroll a 96MB directory listing.
 */
const TOOL_RESULT_CAP = 600;

function transcriptBlocks(entries) {
  const blocks = [];
  const push = (kind, text) => {
    const last = blocks[blocks.length - 1];
    // Only prose is joined. Two tool results in a row are two results.
    if (last && last.kind === kind && (kind === 'agent' || kind === 'you')) last.text += text;
    else blocks.push({ kind, text });
  };

  for (const e of entries || []) {
    const u = (e && e.update) || e || {};
    const kind = u.sessionUpdate;
    if (TRANSCRIPT_NOISE.has(kind)) continue;

    if (kind === 'tool_call') {
      const title = u.title || u.kind || 'running a tool';
      blocks.push({ kind: 'tool', text: title });
      continue;
    }
    if (kind === 'tool_call_update') {
      const out = updateText(u).trim();
      if (out) blocks.push({ kind: 'result', text: out });
      continue;
    }
    if (kind === 'error') {
      blocks.push({ kind: 'error', text: updateText(u) || 'unknown error' });
      continue;
    }

    const text = updateText(u);
    if (!text) continue;
    if (kind === 'user_message' || kind === 'user_message_chunk') push('you', text);
    else push('agent', text);
  }
  return blocks;
}

/**
 * How a tool result is shown.
 *
 * Long output is clipped for reading, but the WHOLE text is kept and rendered
 * behind a disclosure. The previous label said "output truncated (N
 * characters)" and offered nothing -- which read as "the rest is gone" when in
 * fact the rest had been sent, received, and thrown away at the last step.
 */
function resultView(text, cap = TOOL_RESULT_CAP) {
  const full = String(text == null ? '' : text);
  if (full.length <= cap) return { full, shown: full, clipped: false };
  return { full, shown: `${full.slice(0, cap)}…`, clipped: true };
}

export function renderTranscript(entries) {
  const blocks = transcriptBlocks(entries);
  if (!blocks.length) {
    $('dtTranscript').innerHTML = '<div class="t-entry t-kind">nothing yet</div>';
    return;
  }
  $('dtTranscript').innerHTML = blocks.map((b) => {
    if (b.kind === 'tool') {
      return `<div class="t-entry t-toolrow"><span class="t-tool">tool</span> <span class="t-text">${esc(b.text)}</span></div>`;
    }
    if (b.kind === 'result') {
      const v = resultView(b.text);
      if (!v.clipped) return `<div class="t-entry t-result"><pre>${esc(v.full)}</pre></div>`;
      return `<div class="t-entry t-result"><pre class="t-clipped">${esc(v.shown)}</pre>`
        + `<details><summary class="t-more">`
        + `show all ${v.full.length.toLocaleString()} characters</summary>`
        + `<pre>${esc(v.full)}</pre></details></div>`;
    }
    if (b.kind === 'error') {
      return `<div class="t-entry t-err"><span class="t-tool">error</span> <span class="t-text">${esc(b.text)}</span></div>`;
    }
    const who = b.kind === 'you' ? 'you' : 'agent';
    return `<div class="t-entry t-msg t-${who}"><span class="t-who">${who}</span><div class="t-body">${esc(b.text.trim())}</div></div>`;
  }).join('');
  const el = $('dtTranscript');
  el.scrollTop = el.scrollHeight;
}

