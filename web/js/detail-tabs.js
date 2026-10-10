import { state } from './api.js';
import { $, asList } from './util.js';
import { renderInlineApprovals, initInlineApprovals } from './approval-card.js';
import { renderInfoPane, resetInfoPane } from './session-info.js';

// ---------------------------------------------------------------------------
// Detail tabs (#182): Chat | Squad | Info, and a Files tab that is a spike.
// The Files tab in the markup is disabled, with no pane and no code behind it:
// it only says a later release may add it when the device allows file access.
//
// Switching tabs only shows and hides panes that already exist. It never
// fetches, never rebuilds the transcript and never touches the composer, which
// sits below all of the panes -- so a half-typed message survives a trip to
// Info and back, and nothing here can race the transcript fetch or the control
// check that `openDetail` starts.
// ---------------------------------------------------------------------------

export const DETAIL_TABS = ['chat', 'squad', 'info'];

let activeDetailTab = 'chat';

export function currentDetailTab() {
  return activeDetailTab;
}

/**
 * Which tab an arrow, Home or End key moves to, wrapping at the ends. Anything
 * else leaves the selection alone. The Files tab is never reachable: it is not
 * in `DETAIL_TABS`.
 */
export function nextDetailTab(current, key) {
  const i = DETAIL_TABS.indexOf(current);
  const at = i < 0 ? 0 : i;
  const last = DETAIL_TABS.length - 1;
  if (key === 'ArrowRight') return DETAIL_TABS[at === last ? 0 : at + 1];
  if (key === 'ArrowLeft') return DETAIL_TABS[at === 0 ? last : at - 1];
  if (key === 'Home') return DETAIL_TABS[0];
  if (key === 'End') return DETAIL_TABS[last];
  return DETAIL_TABS[at];
}

/** Show one tab's pane and hide the others. Returns false for a tab that cannot be selected. */
export function selectDetailTab(id, { focus = false } = {}) {
  if (!DETAIL_TABS.includes(id)) return false;
  activeDetailTab = id;
  for (const t of DETAIL_TABS) {
    const tab = $(`dtTab-${t}`);
    const on = t === id;
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    $(`dtPane-${t}`).hidden = !on;
  }
  if (focus) $(`dtTab-${id}`).focus();
  if (id === 'info' && state.currentSession) renderInfoPane(state.currentSession);
  // The transcript follows the newest message while another tab is showing
  // (setting a scroll position on a hidden element does nothing), so catch up.
  if (id === 'chat') {
    const tr = $('dtTranscript');
    tr.scrollTop = tr.scrollHeight;
  }
  return true;
}

/** A fresh session always opens on Chat, with no card or Info left over from the last one. */
export function resetDetailTabs(found) {
  $('dtApprovals').textContent = '';
  delete $('dtApprovals').dataset.session;
  resetInfoPane();
  selectDetailTab('chat');
  syncDetailTabs(found);
}

/** Called on every live refresh: only what changed is touched. */
export function syncDetailTabs(found) {
  // Empty note when the Squad panel itself is hidden (the device reported no Squad workspace).
  $('dtSquadNone').hidden = !$('dtSquad').hidden;
  renderInlineApprovals(found);
  const waiting = asList(found.session.pendingApprovals).length > 0;
  $('dtTabChatDot').hidden = !waiting;
  $('dtTab-chat').setAttribute('aria-label', waiting ? 'Chat, a permission request is waiting' : 'Chat');
  if (activeDetailTab === 'info') renderInfoPane(found);
}

export function initDetailTabs() {
  // One handler per live tab, so the markup-to-handler check in e2e-unit.js sees each. The
  // Files tab is disabled in the markup and has nothing behind it.
  $('dtTab-chat').onclick = () => selectDetailTab('chat');
  $('dtTab-squad').onclick = () => selectDetailTab('squad');
  $('dtTab-info').onclick = () => selectDetailTab('info');
  $('dtTabs').onkeydown = (ev) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    ev.preventDefault();
    selectDetailTab(nextDetailTab(activeDetailTab, ev.key), { focus: true });
  };
  initInlineApprovals();
}
