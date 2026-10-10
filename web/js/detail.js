import { state, api } from './api.js';
import {
  esc, truncateWords, statusLabel, statusPillClass,
  isStaleSession, cleanupControls, $,
} from './util.js';
import { controlBanner, composerReduce } from './composer.js';
import { refresh, resolveDeepLink } from './ws.js';
import { toggleFavorite, promptRenameSession } from './prefs-sync.js';
import { sidebarEntries, sidebarRow, sessionKey } from './list.js';
import { displayTitle } from './sessionrow.js';
import { renderTranscript, transcriptSkeleton } from './transcript.js';
import { syncReviewDetail } from './review.js';
import { renderSquadPanel } from './squad-panel.js';
import { initDetailTabs, resetDetailTabs, syncDetailTabs } from './detail-tabs.js';
// Circular import, same pattern rowmenu.js/wiring.js already use: see
// detail-control.js's own top-of-file comment for why this is safe.
import {
  verifyControl, syncSession, detailSyncMenuItem, invalidateSelection, selectionStillActive,
} from './detail-control.js';
// Circular import, same pattern rowmenu.js/wiring.js already use:
// `closeRowMenu` is a hoisted `export function` declaration in wiring.js,
// never read at either module's top level, so by the time `openDetail`/
// `closeDetail` below actually call it, wiring.js's module body has long
// finished.
import { closeRowMenu } from './wiring.js';

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

/**
 * The header title: a custom name when one was set, else the prompt (falling
 * back to the id) -- the exact same rule `displayTitle` already applies to
 * the row and the sidebar (#181 part 2 closes this: the header used to
 * ignore a rename entirely). The raw prompt stays one hover away via
 * `title`, matching the row's own convention in sessionrow.js.
 */
function renderDetailTitle(found) {
  const raw = found.session.prompt || found.session.id || '';
  const shown = displayTitle(found.session, state.names);
  const el = $('dtTitle');
  el.textContent = truncateWords(shown, 80);
  if (shown !== raw) el.title = raw; else el.removeAttribute('title');
}

export async function openDetail(key, { nav = NAV.PUSH } = {}) {
  const found = findSession(key);
  if (!found) return false;
  // Close the shared `#rowMenu` first: it is keyed to whichever session it
  // was opened for, and a navigation here -- including the browser's own
  // Back/Forward (`nav: NAV.NONE`) -- never goes through the menu's own
  // close paths (a click outside it, Esc, another popup opening). Left
  // open, Sync session would retarget to whatever this call is about to
  // select instead of the session its menu was actually offered for (#243
  // Scout review of ab5ef90). Unconditional, so even reopening the SAME key
  // drops a menu opened before this navigation.
  closeRowMenu();
  // Invalidate BEFORE anything else awaits, including the transcript fetch
  // below -- not only once `verifyControl` itself starts. Scout's review of
  // 34256a0: a reply for the PREVIOUS selection (even this same session,
  // closed and reopened) can still be in flight while this function awaits
  // the transcript, before a new `verifyControl` call would otherwise bump
  // `controlToken`. Bumping the generation here, synchronously, closes that
  // gap regardless of how long the rest of this function takes. The
  // returned generation is captured below so the continuation AFTER the
  // transcript await can tell whether it is still the active selection.
  const generation = invalidateSelection();
  applyNav(nav, key);
  state.currentSession = found;
  renderDetailTitle(found);
  // The status pill (#169) shares its words and state mapping with the row's
  // `statusBadge` via `statusLabel`/`statusPillClass` (one source), so the
  // detail header and the row it was opened from can never read two
  // different things for the same session.
  $('dtMeta').textContent = [
    found.device.name,
    found.session.cwd || '',
  ].filter(Boolean).join(' · ');
  const pillCls = statusPillClass(found.session, found.device);
  $('dtStatusPill').className = `dt-pill ${pillCls}`;
  $('dtStatusPill').textContent = statusLabel(found.session, found.device);
  const pinned = state.favorites.has(sessionKey(found.session));
  const star = $('dtStar');
  star.dataset.star = sessionKey(found.session);
  star.classList.toggle('on', pinned);
  star.textContent = pinned ? '★' : '☆';
  star.title = pinned ? 'Unpin this session' : 'Pin this session';
  star.setAttribute('aria-label', pinned ? 'Unpin this session' : 'Pin this session');
  star.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  renderCleanup(found);
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
  syncReviewDetail(found.session);
  // Every open starts on Chat, with this session's own pending cards and Info.
  resetDetailTabs(found);
  $('dtTranscript').innerHTML = transcriptSkeleton();
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
    // The person may have closed this session, reopened it (even the
    // identical one), or opened something else entirely while this fetch
    // was in flight -- `openDetail` has no `await` between bumping the
    // generation above and this one, so any such navigation already ran
    // its own `invalidateSelection` and moved the generation past what
    // this call captured. Applying a transcript fetched for a context the
    // person already left behind would silently overwrite whatever the
    // CURRENT (correct) session's own transcript render just put on
    // screen with stale content for a different session.
    if (selectionStillActive(key, generation)) renderTranscript(r.transcript || []);
  } catch (e) {
    if (selectionStillActive(key, generation)) {
      $('dtTranscript').innerHTML = `<div class="t-entry t-kind">could not load the transcript: ${esc(e.message)}</div>`;
    }
  }

  // Deliberately AFTER the transcript: a session that cannot be controlled is
  // still worth reading, and blocking the transcript on a control check would
  // make an unreachable device hide the very history explaining why. Gated
  // the same way: a superseded selection already has its OWN `verifyControl`
  // call in flight (started by whichever open/reopen superseded this one),
  // so starting a second, redundant control-check here would only race it.
  if (selectionStillActive(key, generation)) verifyControl();
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
  // Same reasoning as `openDetail`'s call above: a stale shared menu must
  // not survive leaving the page it was opened on either.
  closeRowMenu();
  // Same reasoning as `openDetail`'s call: a verify/resync reply already in
  // flight for the session being closed must never be applied after this
  // point, even if nothing new ever reopens it.
  invalidateSelection();
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
    ? entries.map((e) => sidebarRow(e, selectedKey, state.names)).join('')
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
  renderDetailTitle(found);
  $('dtMeta').textContent = [
    found.device.name,
    found.session.cwd || '',
    statusLabel(found.session, found.device),
  ].filter(Boolean).join(' · ');
  $('dtStatusPill').className = `dt-pill ${statusPillClass(found.session, found.device)}`;
  $('dtStatusPill').textContent = statusLabel(found.session, found.device);
  const warnings = [
    ...(((found.session.applied || {}).warnings) || []),
    ...(((found.session.agentSelection || {}).warnings) || []),
  ].filter(Boolean);
  $('dtWarn').textContent = warnings.join(' · ');
  $('dtWarn').hidden = warnings.length === 0;
  syncReviewDetail(found.session);
  const pinned = state.favorites.has(key);
  const star = $('dtStar');
  star.classList.toggle('on', pinned);
  star.textContent = pinned ? '★' : '☆';
  renderCleanup(found);
  // The inline approval card, the Info tab and the Squad tab's empty state
  // follow the same live feed as the header above.
  syncDetailTabs(found);
}

/**
 * Wire the routing-related controls that live only on the detail page: the
 * two back links, the sidebar's filter box and selection clicks, and the
 * browser's own Back/Forward button. Called once, from `wire()` in wiring.js.
 */
export function initDetailRouting() {
  const back = (e) => { e.preventDefault(); closeDetail(); };
  $('dtBack').onclick = back;
  $('dtBackPhone').onclick = back;
  initDetailTabs();

  $('dtSidebarFilter').oninput = () => renderSidebar();
  $('dtRename').onclick = () => {
    const current = state.currentSession;
    if (!current) return;
    promptRenameSession(sessionKey(current.session), current.session);
  };

  $('detailSidebarList').onclick = (e) => {
    const row = e.target.closest('[data-session]');
    if (row) openDetail(row.dataset.session);
  };

  $('dtStar').onclick = () => toggleCurrentFavorite();

  window.addEventListener('popstate', () => {
    const wanted = urlSessionKey();
    if (!wanted) { closeDetail({ nav: NAV.NONE }); return; }
    const hit = resolveDeepLink(wanted, (state.overview && state.overview.groups) || []);
    if (hit.status === 'found') openDetail(hit.key, { nav: NAV.NONE });
    else closeDetail({ nav: NAV.NONE });
  });
}

/**
 * The Stop/Forget pair in the detail header, driven by device reachability
 * rather than by the (slower, async) control-check.
 *
 * `Stop` asks the device to end its own agent process. There is nowhere for
 * that command to arrive once the socket is gone -- the 409 "device is
 * offline" from #225's report -- so it is disabled up front, with the reason
 * written where the person who reaches for it will see it, rather than left
 * live to fail after a click.
 *
 * `Forget stale session` is the alternative offered in its place, and ONLY
 * when there is something here actually worth forgetting: the session has to
 * be both on a device the hub cannot reach AND still in a non-terminal status
 * (`isStaleSession`). A session that already finished has nothing stuck about
 * it, and the existing Tidy menu already clears those.
 */
function renderCleanup(found) {
  const c = cleanupControls(found.session, found.device);
  const stop = $('dtStop');
  if (stop) {
    stop.disabled = c.stopDisabled;
    stop.title = c.stopReason;
  }
  const forget = $('dtForget');
  if (forget) {
    forget.hidden = !c.forgetVisible;
    forget.disabled = false;
    forget.textContent = 'Forget stale session';
  }
}

/**
 * Clear one stuck session from an unreachable device.
 *
 * Calls the same offline `forget` path the bulk Tidy menu uses, narrowed to
 * this one session (`sessionId`) and forced (`force: true`) because the
 * session is, by definition of `isStaleSession`, still in a non-terminal
 * status -- the whole reason it is stuck. The hub only ever honors `force`
 * when the device has no live socket (see hub-service.js), so this can never
 * reach into a session a live device still owns; and because the device
 * remains the source of truth, a device that comes back online republishes
 * its real session list on its next heartbeat regardless of what the hub
 * forgot in the meantime (#225).
 */
export async function forgetStaleSession() {
  const current = state.currentSession;
  if (!current || !isStaleSession(current.session, current.device)) return;
  const btn = $('dtForget');
  if (btn) { btn.disabled = true; btn.textContent = 'Forgetting…'; }
  try {
    await api(`/api/devices/${encodeURIComponent(current.device.deviceId)}/forget`, {
      method: 'POST', body: { sessionId: current.session.id, force: true },
    });
    if (state.currentSession && sessionKey(state.currentSession.session) === sessionKey(current.session)) closeDetail({ nav: NAV.REPLACE });
    await refresh();
  } catch (e) {
    alert(`Could not forget: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Forget stale session'; }
  }
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
  // `Sync session` restarts the engine on the device's OWN machine, which is
  // exactly as unreachable as `Stop` when the device itself has no live
  // socket -- offering it here would be the same dead end with a different
  // label. `Forget stale session` (see renderCleanup) is the real next step
  // for an unreachable device; Sync stays for the case it was built for, a
  // reachable device whose session the hub has lost track of.
  $('dtInput').disabled = !b.enabled;
  $('dtSend').disabled = !b.enabled;
  $('dtInput').placeholder = b.enabled
    ? 'Send follow-up input to the running agent'
    : 'Controls are disabled until this session is verified';
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
