// The main Wiring entry point, split out of app.js by #200 (part 4/4 of
// #165). `wire()` attaches every control's event handler, delegating to the
// feature modules (aca.js, access.js, connect.js, filters.js, install.js)
// for the dialogs that moved there, and keeping the handlers that are
// general chrome -- the account menu, the Create/Tidy split buttons, the
// detail panel's composer -- here, next to the menu/popup machinery they
// share. Behavior is unchanged byte-for-byte from the original.

import { state, api } from './api.js';
import { $, esc, toast, undoToast } from './util.js';
import { enhanceAllSelects, closeAllSelectPills } from './dropdowns.js';
import {
  forgetWindowMs, forgetTargets, forgetSummary, forgetUndoLabel, newMenuState,
} from './cleanup.js';
import {
  spawnRequest, spawnError, controlsEnabled, composerReduce,
} from './composer.js';
import {
  notifyState, requestNotifyPermission, syncBell, maybePromptApproval,
} from './notifications.js';
import { render } from './devices.js';
import {
  openDetail, closeDetail, initDetailRouting, syncSession, renderControl, openSquadDoc, forgetStaleSession,
} from './detail.js';
import {
  setRailCollapsed, applyTheme, nextTheme, toggleFavorite, saveView, refresh,
} from './ws.js';
import { openAca, wireAca } from './aca.js';
import { retryAcaPending } from './aca-pending.js';
import { openPeople, wireAccess } from './access.js';
import { showInstallHelp, wireInstall, closeInstallCard } from './install.js';
import { openNew, openConnect, wireConnect } from './connect.js';
import { wireFilters } from './filters.js';
import { inboxEntries, inboxCount, renderInboxList } from './inbox.js';
import { wirePush, syncPushMenuItem } from './push.js';

/** A persistent warning the user cannot miss and can dismiss once read. */
export function showBanner(text) {
  const el = $('banner');
  if (!el) return;
  $('bannerText').textContent = text;
  el.hidden = false;
}

/**
 * The menu.
 *
 * Every entry does something. A control that opens nothing, or opens a panel of
 * greyed-out labels, is worse than no control -- it is the first thing a new
 * user clicks, and it teaches them the tool is unfinished.
 */
function toggleMenu(force) {
  const m = $('menu');
  const open = force === undefined ? m.hidden : force;
  m.hidden = !open;
  $('menuBtn').setAttribute('aria-expanded', String(open));
  if (!open) return;

  const d = state.overview.devices || [];
  const online = d.filter((x) => x.presence === 'online').length;
  $('menuMeta').innerHTML = `
    Signed in as <b>${esc((state.me && state.me.name) || 'unknown')}</b><br>
    ${online} of ${d.length} device${d.length === 1 ? '' : 's'} online<br>
    ${state.overview.counts.sessions || 0} sessions ·
    ${state.overview.counts.actionNeeded || 0} needing attention`;
}

/**
 * A small popup anchored to the control that opened it.
 *
 * Opening one closes the other. Two menus open at once is a state nobody
 * intends and every stray click produces.
 */
const POPUP_BUTTON = {
  newMenu: 'newMoreBtn', tidyMenu: 'tidyBtn', inboxMenu: 'bellBtn', dtMenu: 'dtMoreBtn',
};

function togglePopup(menuId, btnId, force) {
  const m = $(menuId);
  if (!m) return;
  const open = force === undefined ? m.hidden : force;
  if (open) {
    for (const other of Object.keys(POPUP_BUTTON)) {
      if (other !== menuId) togglePopup(other, POPUP_BUTTON[other], false);
    }
  }
  m.hidden = !open;
  const b = $(btnId);
  if (b) b.setAttribute('aria-expanded', String(open));
  if (open && menuId === 'newMenu') renderNewMenu();
  if (open && menuId === 'inboxMenu') renderInboxMenu();
}

/**
 * The bell inbox (#174).
 *
 * Rebuilt from `state.overview` on every call, same as the rest of the page --
 * there is no separate "inbox state" to drift out of sync with it. Called
 * once at load, again every time `devices.js`'s `render()` refreshes the page
 * from a new overview (so a card updates or disappears live while the
 * dropdown is sitting open), and once more when the bell opens it, in case a
 * push arrived while it was closed.
 */
export function renderInboxMenu() {
  const entries = inboxEntries(state.overview);
  const count = inboxCount(state.overview);
  $('inboxHead').textContent = count ? `Needs you · ${count}` : 'Needs you';
  $('inboxList').innerHTML = renderInboxList(entries);
  // Not awaited: the dropdown opens instantly either way, and this row can
  // only ever flip between On/Off a moment later once the service worker and
  // its subscription have actually been checked.
  syncPushMenuItem();
}

/** Answer a pending approval from inside the inbox, without opening the session. */
async function answerFromInbox(btn) {
  if (!btn || btn.disabled) return;
  const { device, sessionId, approval, answer } = btn.dataset;
  const row = btn.closest('.inbox-item-acts');
  const buttons = row ? [...row.querySelectorAll('[data-answer]')] : [btn];
  for (const b of buttons) b.disabled = true;
  try {
    await api(`/api/devices/${encodeURIComponent(device)}/approve`, {
      method: 'POST',
      body: { sessionId, approvalId: approval, optionId: answer },
    });
    // The next overview -- pushed immediately by the hub once the device
    // acts on it, same as everywhere else this api call is made -- drives
    // `renderInboxMenu()` again and drops the card. Nothing to do here but
    // wait for it, so a slow network does not leave stale buttons live.
  } catch (e) {
    toast(`Could not answer: ${e.message}`);
    for (const b of buttons) b.disabled = false;
  }
}

/**
 * The Create menu.
 *
 * "Cloud session" is offered when a cloud device is connected and REFUSED
 * WITH A REASON when it is not. Squad Hub cannot provision a cloud device --
 * it is an observer of devices that dial in, not a control plane with cloud
 * credentials -- so an always-live button would be an offer it could not keep.
 * Saying how to start one is the honest version of the same help.
 */
function renderNewMenu() {
  const s = newMenuState((state.overview && state.overview.devices) || []);
  // Selected by what they DO rather than by id: these are delegated to the
  // menu's own click handler, the same way the account menu works, so an id
  // here would be a control that looks individually wired and is not.
  const menu = $('newMenu');
  menu.querySelector('[data-new="local"]').disabled = !s.localEnabled;
  menu.querySelector('[data-new="cloud"]').disabled = !s.cloudEnabled;
  const note = $('newMenuNote');
  note.hidden = !s.note;
  if (s.note) note.textContent = s.note;
}

/**
 * Remove the record of sessions that have already ended.
 *
 * Sent to every reachable device, because the device is the source of truth
 * and a hub-side removal would be undone by the next heartbeat. The result is
 * assembled from what each device actually reported.
 *
 * The confirm dialog (for "all") still asks once, up front. What is new is
 * the few seconds AFTER that: nothing is sent to any device until the Undo
 * toast expires, so a mis-click on a button right beside the one you meant is
 * recoverable for as long as the toast is on screen.
 */
async function forgetEnded(scope) {
  const olderThanMs = forgetWindowMs(scope);
  if (olderThanMs === null) return;

  // Offline devices are swept too. Their ended sessions are removed by the hub
  // rather than by the device, because a device that never comes back cannot
  // be asked and cannot object -- and an ephemeral cloud job never comes back.
  const { reachable, skipped } = forgetTargets((state.overview && state.overview.devices) || []);
  const targets = [...reachable, ...skipped];
  if (!targets.length) {
    toast('No devices to remove sessions from');
    return;
  }
  if (scope === 'all' && !window.confirm(
    'Remove every ended session from the list?\n\n'
    + 'This clears the record of finished work. '
    + 'Sessions that are still running are not affected.')) return;

  undoToast(forgetUndoLabel(scope), async () => {
    let removed = 0;
    let failed = 0;
    for (const d of targets) {
      try {
        const r = await api(`/api/devices/${encodeURIComponent(d.deviceId)}/forget`, {
          method: 'POST',
          body: { olderThanMs },
        });
        removed += (r && r.count) || 0;
      } catch {
        // Counted, never swallowed: a device that refused must not be
        // indistinguishable from one that had nothing to remove.
        failed += 1;
      }
    }
    toast(forgetSummary({ removed, failed, skipped: 0 }));
    await refresh();
  }, () => toast('Removal canceled — nothing was removed'));
}

async function onMenu(action) {
  toggleMenu(false);
  if (action === 'refresh') {
    // A real round trip, not a cosmetic toast. The page also polls and holds a
    // live socket, so this earns its place mainly when that socket has dropped.
    //
    // The feedback has to appear WHERE THE DATA IS. This used to show only a
    // toast at the bottom of the page, so someone clicking a menu at the top
    // right saw nothing at all and reasonably concluded it had done nothing.
    const stamp = $('updated');
    stamp.hidden = false;
    stamp.textContent = 'refreshing…';
    try {
      await refresh();
    } catch (e) {
      stamp.textContent = `could not refresh: ${e.message}`;
      return;
    }
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    // A moving timestamp is evidence. "Refreshed" looks identical whether or
    // not anything happened.
    stamp.textContent = `updated ${hh}:${mm}:${ss}`;
    stamp.classList.remove('flash');
    void stamp.offsetWidth;          // restart the animation
    stamp.classList.add('flash');
    const connected = state.ws && state.ws.readyState === 1;
    toast(connected ? 'Refreshed — live updates are connected' : 'Refreshed — live updates are NOT connected');
    return;
  }
  if (action === 'connect') { openConnect(); return; }
  if (action === 'people') { openPeople(); return; }
  if (action === 'install') {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      state.installPrompt = null;
      return;
    }
    showInstallHelp();
    return;
  }
  if (action === 'signout') {
    // Clearing the token is the whole of signing out here: it is the only
    // credential the browser holds.
    localStorage.removeItem('squad-hub-token');
    if (state.ws) { try { state.ws.close(); } catch { /* closing */ } }
    location.replace(location.pathname);
  }
}

/**
 * Attach every control's event handler. Called once, from main(), after the
 * page has a token and is past the sign-in gate.
 */
export function wire() {
  enhanceAllSelects();
  wireFilters({ refresh, render, saveView });

  $('groups').onclick = (e) => {
    // The star sits inside the row, so it must claim the click before the row
    // does -- otherwise pinning a session also opens it.
    const star = e.target.closest('[data-star]');
    if (star) {
      toggleFavorite(star.dataset.star);
      return;
    }
    // A terminally-resolved "Queued on ACA" row's own "Check again" button
    // (aca-pending.js's acaPendingRowHtml) -- claimed before the row-open
    // check below for the same reason the star is, though a pending row is
    // never itself `[data-session]` so this is mostly belt-and-suspenders.
    // Never dispatches a new job -- see retryAcaPending's own doc comment.
    const retry = e.target.closest('[data-aca-retry]');
    if (retry) {
      retryAcaPending(retry.dataset.acaRetry).then(render);
      return;
    }
    const row = e.target.closest('[data-session]');
    if (row) openDetail(row.dataset.session);
  };

  // The Squad panel: members and document tabs both open a document. Delegated
  // from the panel, because its contents are re-rendered on every refresh.
  $('dtSquad').onclick = (e) => {
    const b = e.target.closest('[data-squaddoc]');
    if (b) openSquadDoc(b.dataset.squaddoc);
  };

  // The rail collapses, and remembers. On a narrow window it is the first
  // thing worth reclaiming, and re-collapsing it on every load would make that
  // a chore rather than a setting.
  $('railToggle').onclick = () => setRailCollapsed(!$('deviceRail').classList.contains('collapsed'));

  $('themeBtn').onclick = () => applyTheme(nextTheme(state.theme));

  $('newBtn').onclick = () => openNew();

  // The split half and the kebab. Both stopPropagation so the document-level
  // close handler below does not see the same click that opened them.
  $('newMoreBtn').onclick = (e) => { e.stopPropagation(); togglePopup('newMenu', 'newMoreBtn'); };
  $('tidyBtn').onclick = (e) => { e.stopPropagation(); togglePopup('tidyMenu', 'tidyBtn'); };
  $('newMenu').onclick = (e) => {
    const b = e.target.closest('[data-new]');
    if (!b || b.disabled) return;
    togglePopup('newMenu', 'newMoreBtn', false);
    // Starting a run on ACA needs no device at all: it opens GitHub, and the
    // workflow there starts the job. So it is offered whether or not anything
    // is attached.
    if (b.dataset.new === 'aca') { openAca(); return; }
    const s = newMenuState((state.overview && state.overview.devices) || []);
    openNew(b.dataset.new === 'cloud' ? s.cloudDeviceId : s.localDeviceId);
  };
  $('tidyMenu').onclick = (e) => {
    const b = e.target.closest('[data-forget]');
    if (!b) return;
    togglePopup('tidyMenu', 'tidyBtn', false);
    forgetEnded(b.dataset.forget);
  };
  $('apCancel').onclick = () => { $('approvalScrim').hidden = true; };
  initDetailRouting();
  $('dtMoreBtn').onclick = (e) => { e.stopPropagation(); togglePopup('dtMenu', 'dtMoreBtn'); };

  $('bellBtn').onclick = async (e) => {
    e.stopPropagation();
    // The click is what asks for permission. Requesting it on load would spend
    // the one prompt a browser ever shows before anyone had reason to say yes,
    // and a denial cannot be asked for again.
    const before = notifyState();
    const after = await requestNotifyPermission();
    if (after === 'granted' && before !== 'granted') {
      toast('Notifications on — you will be told when a session needs you');
    } else if (after === 'denied') {
      toast('Notifications are blocked for this site; allow them in your browser settings');
    } else if (after === 'unsupported') {
      toast('This browser cannot show notifications');
    }
    // The bell itself now opens the inbox rather than immediately re-raising
    // every dismissed card -- that behavior still exists, but as the
    // "Show approval prompts again" row inside it, so clicking the bell to
    // turn notifications on no longer ALSO drops a stack of modals on screen.
    togglePopup('inboxMenu', 'bellBtn');
  };
  syncBell();
  renderInboxMenu();

  $('inboxMenu').onclick = (e) => {
    const openBtn = e.target.closest('[data-inbox-open]');
    if (openBtn) {
      togglePopup('inboxMenu', 'bellBtn', false);
      openDetail(openBtn.dataset.inboxOpen);
      return;
    }
    const reprompt = e.target.closest('[data-inbox="reprompt"]');
    if (reprompt) {
      togglePopup('inboxMenu', 'bellBtn', false);
      // The pre-#174 behavior of the bell itself: bring back every approval
      // card that was dismissed without being answered.
      state.seenApprovals.clear();
      maybePromptApproval();
      return;
    }
    answerFromInbox(e.target.closest('[data-answer]'));
  };

  $('menuBtn').onclick = (e) => { e.stopPropagation(); toggleMenu(); };
  $('bannerClose').onclick = () => { $('banner').hidden = true; };  $('menu').onclick = (e) => {
    const b = e.target.closest('[data-menu]');
    if (b) onMenu(b.dataset.menu);
  };
  document.addEventListener('click', (e) => {
    if (!$('menu').hidden && !e.target.closest('#menu') && !e.target.closest('#menuBtn')) toggleMenu(false);
    if (!$('newMenu').hidden && !e.target.closest('#newSplit')) togglePopup('newMenu', 'newMoreBtn', false);
    if (!$('tidyMenu').hidden && !e.target.closest('#tidySplit')) togglePopup('tidyMenu', 'tidyBtn', false);
    if (!$('installCard').hidden && !e.target.closest('.install-wrap')) closeInstallCard();
    if (!$('inboxMenu').hidden && !e.target.closest('#inboxMenu') && !e.target.closest('#bellBtn')) togglePopup('inboxMenu', 'bellBtn', false);
    if (!$('dtMenu').hidden && !e.target.closest('#dtMoreBtn') && !e.target.closest('#dtMenu')) togglePopup('dtMenu', 'dtMoreBtn', false);
    if (!e.target.closest('.selectpill')) closeAllSelectPills(null);
    if ($('filterbarEnd').classList.contains('open') && !e.target.closest('#filterbarEnd') && !e.target.closest('#filterToggle')) {
      $('filterbarEnd').classList.remove('open');
      $('filterToggle').setAttribute('aria-expanded', 'false');
    }
  });

  wireInstall();
  wirePush();
  wireAccess();
  wireAca();
  wireConnect({ spawnRequest, spawnError });

  $('dtStop').onclick = async () => {
    if (!state.currentSession) return;
    const { device, session } = state.currentSession;
    try {
      await api(`/api/devices/${encodeURIComponent(device.deviceId)}/stop`, {
        method: 'POST', body: { sessionId: session.id },
      });
      closeDetail();
      refresh();
    } catch (e) { alert(`Could not stop: ${e.message}`); }
  };

  $('dtForget').onclick = () => forgetStaleSession();

  $('dtSend').onclick = async () => {
    if (!state.currentSession) return;
    if (!controlsEnabled(state.composer.control)) return;
    const text = $('dtInput').value.trim();
    if (!text) return;
    const { device, session } = state.currentSession;
    try {
      const r = await api(`/api/devices/${encodeURIComponent(device.deviceId)}/steer`, {
        method: 'POST', body: { sessionId: session.id, text },
      });
      // Cleared only once it LANDED. Clearing first meant a failed send threw
      // away what the person had written in order to report the failure.
      //
      // The response is READ, not discarded: a watched session answers
      // `{queued:true}` and an owned one `{sent:true}`, and those are not the
      // same promise to the person who just pressed send.
      state.composer = composerReduce(state.composer, { type: 'sent', queued: !!(r && r.queued) });
      $('dtInput').value = '';
      renderControl();
    } catch (e) {
      state.composer = composerReduce(state.composer, { type: 'send-failed', error: e.message });
      renderControl();
      alert(`Could not send: ${e.message}`);
    }
  };

  $('dtInput').oninput = (e) => {
    state.composer = composerReduce(state.composer, { type: 'type', text: e.target.value });
  };

  // Enter sends, Shift+Enter starts a new line. The box is a textarea so a
  // follow-up can be more than one line, and a multi-line box with no way to
  // send from the keyboard makes you reach for the mouse on every message.
  $('dtInput').onkeydown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    $('dtSend').click();
  };

  $('dtSync').onclick = () => { togglePopup('dtMenu', 'dtMoreBtn', false); syncSession(); };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    toggleMenu(false);
    togglePopup('newMenu', 'newMoreBtn', false);
    togglePopup('tidyMenu', 'tidyBtn', false);
    togglePopup('dtMenu', 'dtMoreBtn', false);
    $('filterbarEnd').classList.remove('open');
    $('filterToggle').setAttribute('aria-expanded', 'false');
    for (const id of ['approvalScrim', 'newScrim']) $(id).hidden = true;
    if (!$('detailScrim').hidden) closeDetail();
  });
}
