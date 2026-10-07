/* Squad Hub web client.
 *
 * No framework and no build step. This is a control surface for a developer
 * tool -- it should be readable, forkable, and servable from the same process
 * as the API, without a toolchain standing between a contributor and a change.
 *
 * Live updates arrive over the same WebSocket the daemons use, on a watcher
 * connection. Control actions go over REST, because a command that must be
 * acknowledged deserves a status code.
 */

import { state, loadToken, api } from './js/api.js';
import {
  esc,
  num,
  truncateWords,
  statusLabel,
  asList,
  ANSWER_VERB,
} from './js/util.js';
import { TIME_WINDOWS, SORTS, GROUPINGS } from './js/list.js';
import { approvalRows } from './js/approvals.js';
import { enhanceAllSelects, closeAllSelectPills } from './js/dropdowns.js';
import {
  forgetWindowMs, forgetTargets, forgetSummary, newMenuState, approvalOptions, alwaysAllowRule,
} from './js/cleanup.js';
import {
  spawnRequest, spawnError, controlsEnabled, canSync, controlBanner, composerReduce,
} from './js/composer.js';
import {
  notifyState, requestNotifyPermission, syncBell, maybePromptApproval,
} from './js/notifications.js';
import { render } from './js/devices.js';
import {
  openDetail, syncSession, renderControl, openSquadDoc, renderTranscript,
} from './js/detail.js';
import { inboxEntries, inboxCount, renderInboxList } from './js/inbox.js';
import {
  connect, setAvatar, setConn, takeDeepLinkSession, resolveDeepLink, showOffline,
  registerServiceWorker, refresh, loadView, saveView, toggleFavorite, syncControls,
  applyTheme, nextTheme, setRailCollapsed,
} from './js/ws.js';

'use strict';

export const $ = (id) => document.getElementById(id);
// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  enhanceAllSelects();
  $('q').oninput = (e) => { state.filters.q = e.target.value; refresh(); };
  $('statusFilter').onchange = (e) => { state.filters.status = e.target.value; refresh(); };
  $('deviceFilter').onchange = (e) => { state.filters.device = e.target.value; refresh(); };

  // These four are client-side: they reshape what is already loaded, so they
  // re-render immediately rather than waiting on a round trip.
  $('repoFilter').onchange = (e) => { state.filters.repo = e.target.value; saveView(); render(); };
  $('orgFilter').onchange = (e) => { state.filters.org = e.target.value; saveView(); render(); };
  $('windowFilter').onchange = (e) => { state.filters.window = e.target.value; saveView(); render(); };
  $('groupBy').onchange = (e) => { state.groupBy = e.target.value; saveView(); render(); };
  $('sortBy').onchange = (e) => { state.sortBy = e.target.value; saveView(); render(); };

  $('groups').onclick = (e) => {
    // The star sits inside the row, so it must claim the click before the row
    // does -- otherwise pinning a session also opens it.
    const star = e.target.closest('[data-star]');
    if (star) {
      toggleFavorite(star.dataset.star);
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

  $('deviceList').onclick = (e) => {
    const rm = e.target.closest('[data-remove-device]');
    if (rm) { removeDevice(rm.dataset.removeDevice); return; }
    const b = e.target.closest('[data-spawn]');
    if (b) openNew(b.dataset.spawn);
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
  $('cnCancel').onclick = () => { $('connectScrim').hidden = true; };
  $('cnCreate').onclick = () => createDeviceToken();
  // "…anywhere" only means something once a working directory is allowed at
  // all, so it follows the box above it rather than sitting there as a live
  // control that does nothing.
  const syncFilesAll = () => {
    const on = $('cnFiles').checked;
    $('cnFilesAll').disabled = !on;
    if (!on) $('cnFilesAll').checked = false;
  };
  $('cnFiles').onchange = syncFilesAll;
  syncFilesAll();
  $('cnCopy').onclick = async () => {
    toast(await copy($('cnCmd').textContent) ? 'Command copied' : 'Select and copy the command above');
  };
  $('nsCancel').onclick = () => { $('newScrim').hidden = true; };
  $('apCancel').onclick = () => { $('approvalScrim').hidden = true; };
  $('dtClose').onclick = () => { $('detailScrim').hidden = true; state.currentSession = null; };

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
    // every dismissed card -- that behaviour still exists, but as the
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
      // The pre-#174 behaviour of the bell itself: bring back every approval
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
    if (!$('inboxMenu').hidden && !e.target.closest('#inboxMenu') && !e.target.closest('#bellBtn')) togglePopup('inboxMenu', 'bellBtn', false);
    if (!e.target.closest('.selectpill')) closeAllSelectPills(null);
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;  });

  $('pplClose').onclick = () => { $('peopleScrim').hidden = true; };
  $('peopleScrim').onclick = (e) => { if (e.target === $('peopleScrim')) $('peopleScrim').hidden = true; };
  $('pplAdd').onclick = async () => {
    const login = $('pplLogin').value.trim();
    if (!login) { $('pplErr').textContent = 'Enter a username or email.'; $('pplErr').hidden = false; return; }
    $('pplAdd').disabled = true;
    try {
      state.people = await api('/api/access', { method: 'POST', body: { login, note: $('pplNote').value.trim() } });
      $('pplLogin').value = '';
      $('pplNote').value = '';
      $('pplErr').hidden = true;
      // Clear the filter, or someone adds a person and watches them not appear.
      $('pplSearch').value = '';
      renderPeople();
    } catch (e) {
      $('pplErr').textContent = e.message;
      $('pplErr').hidden = false;
    }
    $('pplAdd').disabled = false;
    $('pplLogin').focus();
  };
  $('pplLogin').onkeydown = (e) => { if (e.key === 'Enter') $('pplAdd').click(); };
  $('pplNote').onkeydown = (e) => { if (e.key === 'Enter') $('pplAdd').click(); };
  $('pplSearch').oninput = renderPeople;
  $('pplSource').onchange = renderPeople;

  $('dtAca').onclick = openAca;
  $('acaCancel').onclick = () => { $('acaScrim').hidden = true; };
  $('acaScrim').onclick = (e) => { if (e.target === $('acaScrim')) $('acaScrim').hidden = true; };
  $('acaRepo').oninput = updateAcaPreview;
  $('acaIssue').oninput = updateAcaPreview;
  $('acaPrompt').oninput = updateAcaPreview;
  $('acaOpen').onclick = () => {
    const url = acaNewIssueLink($('acaRepo').value, $('acaPrompt').value);
    if (!url) {
      $('acaErr').textContent = 'Enter a repository as owner/repo, and what it should do.';
      $('acaErr').hidden = false;
      return;
    }
    // `noopener` because the opened page must not get a handle back to this
    // one -- and this one holds the token.
    window.open(url, '_blank', 'noopener');
    $('acaScrim').hidden = true;
  };
  $('acaCopy').onclick = async () => {
    const cmd = acaComment($('acaPrompt').value);
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      toast('Command copied — paste it as a comment on the issue');
    } catch { toast('Could not copy; select the command and copy it'); }
  };
  $('acaOpenIssue').onclick = () => {
    const url = acaIssueLink($('acaRepo').value, $('acaIssue').value);
    if (!url) {
      $('acaErr').textContent = 'Enter a repository and an issue number.';
      $('acaErr').hidden = false;
      return;
    }
    window.open(url, '_blank', 'noopener');
  };

  // Offering to install an app that is already installed is noise, so the
  // menu item goes away once we are running from the home screen or the dock.
  if (isInstalled()) {
    const item = document.querySelector('[data-menu="install"]');
    if (item) item.hidden = true;
  }

  $('nsDevice').onchange = updateCwdHint;

  $('nsStart').onclick = async () => {
    const deviceId = $('nsDevice').value;
    // Whichever control is showing is the one the person used. Reading the
    // hidden one would silently discard their choice.
    const agentSel = $('nsAgentSelect');
    const agent = agentSel && !agentSel.hidden ? agentSel.value : $('nsAgent').value;
    const modelSel = $('nsModelSelect');
    const model = modelSel && !modelSel.hidden ? modelSel.value : $('nsModel').value;
    const body = spawnRequest({
      prompt: $('nsPrompt').value,
      cwd: $('nsCwd').value,
      agent,
      model,
      mode: $('nsMode') ? $('nsMode').value : '',
    });
    const problem = spawnError(body);
    if (problem) { showNewErr(problem); return; }
    $('nsStart').disabled = true;
    try {
      await api(`/api/devices/${encodeURIComponent(deviceId)}/spawn`, { method: 'POST', body });
      $('newScrim').hidden = true;
      $('nsPrompt').value = '';
      refresh();
    } catch (e) { showNewErr(e.message); }
    $('nsStart').disabled = false;
  };

  $('dtStop').onclick = async () => {
    if (!state.currentSession) return;
    const { device, session } = state.currentSession;
    try {
      await api(`/api/devices/${encodeURIComponent(device.deviceId)}/stop`, {
        method: 'POST', body: { sessionId: session.id },
      });
      $('detailScrim').hidden = true;
      refresh();
    } catch (e) { alert(`Could not stop: ${e.message}`); }
  };

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

  $('dtSync').onclick = () => syncSession();

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    toggleMenu(false);
    togglePopup('newMenu', 'newMoreBtn', false);
    togglePopup('tidyMenu', 'tidyBtn', false);
    for (const id of ['approvalScrim', 'newScrim', 'detailScrim']) $(id).hidden = true;
  });
}

function showNewErr(m) { $('nsErr').hidden = false; $('nsErr').textContent = m; }

/** A persistent warning the user cannot miss and can dismiss once read. */
function showBanner(text) {
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
const POPUP_BUTTON = { newMenu: 'newMoreBtn', tidyMenu: 'tidyBtn', inboxMenu: 'bellBtn' };

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
}

let toastTimer = null;
export function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard access needs a secure context and permission. Falling back to a
    // selectable prompt is better than a silent failure.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
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

export function openNew(deviceId) {
  const online = state.overview.devices.filter((d) => d.presence !== 'offline');

  // With no device online this dialog used to open with an EMPTY dropdown: you
  // could type a prompt, press Start, and get a failure. Offering an action
  // that cannot succeed teaches people the product is unreliable, so say what
  // is missing and how to fix it instead.
  if (!online.length) {
    openConnect();
    return;
  }

  $('nsDevice').innerHTML = online.map((d) => `<option value="${esc(d.deviceId)}">${esc(d.name)}</option>`).join('');
  if (deviceId) $('nsDevice').value = deviceId;
  $('nsErr').hidden = true;
  updateCwdHint();
  $('newScrim').hidden = false;
  $('nsPrompt').focus();
}

/**
 * Connect a device.
 *
 * This mints a DEVICE TOKEN rather than handing out the signed-in user's own
 * credential. An earlier build copied a command containing the user token,
 * which meant following the built-in instructions produced the insecure setup:
 * a credential on a server that could also read this page's data and start work
 * on every other device.
 */
export function openConnect() {
  $('cnErr').hidden = true;
  $('cnResult').hidden = true;
  $('cnCreate').disabled = false;
  $('cnCreate').textContent = 'Create token';
  $('connectScrim').hidden = false;
  $('cnLabel').focus();
}

/**
 * Remove a device: revoke the credential it is using, and cut it off.
 *
 * Confirmed first, and the confirmation says what is irreversible. Unlike
 * "forget", which only removes a record and lets a live device republish
 * itself, this destroys the credential -- the device cannot come back without
 * being given a new token by hand, on the machine.
 *
 * That is the point: it exists for the laptop you cannot reach, the colleague
 * who has left, the container that will not stop. But it is also why a
 * mis-click here costs a trip to the machine, so it asks.
 */
async function removeDevice(deviceId) {
  const d = (state.overview.devices || []).find((x) => x.deviceId === deviceId);
  const name = (d && d.name) || deviceId;
  if (!confirm(
    `Remove "${name}" from this hub?\n\n`
    + 'Its device token is revoked and the connection is dropped immediately.\n'
    + 'It cannot reconnect: someone has to run `squad-hub connect` on that '
    + 'machine with a new token.',
  )) return;

  try {
    const r = await api(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST' });
    // Reported from the ANSWER, never from the request. A device that could not
    // be revoked must not be announced as removed.
    toast(r && r.removed ? `Removed ${name}` : `${name} was disconnected, but its record is still here`);
  } catch (e) {
    toast(`Could not remove ${name}: ${e.message}`);
  }
  refresh();
}

async function createDeviceToken() {  const btn = $('cnCreate');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  $('cnErr').hidden = true;
  try {
    const r = await api('/api/device-tokens', {
      method: 'POST',
      body: {
        label: $('cnLabel').value.trim() || null,
        didPrefix: $('cnPrefix').value.trim() || null,
        ttlHours: Number($('cnTtl').value),
      },
    });
    /**
     * Build the command the person will actually paste.
     *
     * These are DEVICE settings rather than token claims, so the hub cannot
     * apply them itself -- the only place they can take effect is the command
     * run on the machine. Offering them here is the difference between "it
     * connected but cannot open a file, and nothing said it wouldn't" and a
     * device that works the way it was set up to.
     *
     * --allow-files-all implies --allow-files, so only one is ever emitted.
     */
    const flags = [];
    if ($('cnFilesAll').checked) flags.push('--allow-files-all');
    else if ($('cnFiles').checked) flags.push('--allow-files');
    if ($('cnTrackAll').checked) flags.push('--track-all');
    const cmd = `squad-hub connect --hub ${location.origin} --token ${r.token}${
      flags.length ? ` ${flags.join(' ')}` : ''}`;
    $('cnCmd').textContent = cmd;
    $('cnResult').hidden = false;
    btn.textContent = 'Create another';
    btn.disabled = false;
  } catch (e) {
    $('cnErr').textContent = e.message;
    $('cnErr').hidden = false;
    btn.disabled = false;
    btn.textContent = 'Create token';
  }
}

/**
 * File access is a per-device opt-in. Hiding the field on a device that has not
 * opted in is honest: offering a folder picker that the daemon will refuse
 * teaches the user nothing except that the product is unreliable.
 */
function updateCwdHint() {
  const d = state.overview.devices.find((x) => x.deviceId === $('nsDevice').value);
  const on = d && d.fileAccess && d.fileAccess !== 'off';
  $('nsCwdField').hidden = !on;
  if (on) {
    $('nsCwdHint').textContent = d.fileAccess === 'scoped'
      ? 'This device allows a working directory inside its configured root.'
      : 'This device allows any working directory.';
  }
  updateAgentChoices(d);
}

/**
 * Swap a free-text box for a picker when the device can say what it accepts.
 *
 * Shared by Agent and Model because the rule is the same for both: offer a
 * list where one exists, and a text box where it does not. A device that could
 * not tell reports null rather than an empty list, and rendering an empty
 * picker would be a claim it never made -- while also taking away the box
 * someone could have typed a name they know into.
 */
function choicesField(selId, boxId, list, blankLabel) {
  const sel = $(selId);
  const box = $(boxId);
  if (!sel || !box) return;
  if (!Array.isArray(list) || !list.length) {
    sel.hidden = true;
    box.hidden = false;
    return;
  }
  const prior = box.value;
  sel.innerHTML = `<option value="">${esc(blankLabel)}</option>${
    list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
  // Keep a choice already made, but only if this device really offers it.
  sel.value = list.includes(prior) ? prior : '';
  box.value = sel.value;
  sel.hidden = false;
  box.hidden = true;
}

function updateAgentChoices(device) {
  choicesField('nsAgentSelect', 'nsAgent', device && device.agents, 'whatever the project selects');
  choicesField('nsModelSelect', 'nsModel', device && device.models, "the agent's default");
}

/**
 * Links that start a Squad on ACA run.
 *
 * Squad Hub cannot start a cloud job and holds no credential that could. It
 * emits a URL; the person's own GitHub session does the rest.
 *
 * A NEW ISSUE, not a comment. GitHub prefills a new issue from `title`, `body`
 * and `labels`, and prefills nothing on an existing issue -- a `?body=` after a
 * `#fragment` is never read, so that route opens an empty box and loses the
 * instruction. The dispatch workflow triggers on the label and, with no
 * explicit command, tells the agent to read the issue: so the issue body IS the
 * instruction.
 *
 * This mirrors src/github-link.js. It is duplicated because `web/app.js` has no
 * build step, and routing it through the hub would put the hub in the path of
 * an action it deliberately has no part in. The refusals are the same, and both
 * are tested against the same cases.
 */
const ACA_LABEL = 'squad-aca';

function acaRepoName(name) {
  const parts = String(name == null ? '' : name).trim().replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) return null;
  const ok = (s) => /^[A-Za-z0-9._-]{1,100}$/.test(s) && !s.startsWith('.') && s !== '..';
  return ok(parts[0]) && ok(parts[1]) ? `${parts[0]}/${parts[1]}` : null;
}

/** The repository a session is checked out from, when it is on GitHub. */
function acaSessionRepo(session) {
  const git = (session && session.git) || {};
  const host = String(git.host || '').toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  return acaRepoName(git.repository);
}

function acaTitle(instruction) {
  const one = String(instruction == null ? '' : instruction).trim().replace(/\s*\r?\n\s*/g, ' ');
  if (!one) return null;
  return one.length <= 70 ? one : `${one.slice(0, 67).trimEnd()}\u2026`;
}

function acaNewIssueLink(repo, instruction) {
  const target = acaRepoName(repo);
  if (!target) return null;
  const body = String(instruction == null ? '' : instruction).trim();
  if (!body) return null;
  const url = `https://github.com/${target}/issues/new`
    + `?title=${encodeURIComponent(acaTitle(body))}`
    + `&body=${encodeURIComponent(body)}`
    + `&labels=${encodeURIComponent(ACA_LABEL)}`;
  // Refused rather than truncated: a truncated instruction is a different
  // instruction that still looks deliberate, on a page that starts compute.
  return url.length > 6000 ? null : url;
}

function acaComment(prompt) {
  const p = String(prompt == null ? '' : prompt).trim();
  if (!p) return null;
  return `/squad-aca ${p.replace(/\s*\r?\n\s*/g, ' ')}`;
}

function acaIssueLink(repo, issue) {
  const target = acaRepoName(repo);
  if (!target) return null;
  const n = Number(issue);
  return Number.isInteger(n) && n > 0 ? `https://github.com/${target}/issues/${n}` : null;
}

function openAca() {
  const cur = state.currentSession;
  $('acaErr').hidden = true;
  $('acaIssue').value = '';
  // Prefilled from the session when there is one, and editable either way: a
  // run does not have to be about the repository you happen to be looking at.
  $('acaRepo').value = (cur && acaSessionRepo(cur.session)) || '';
  $('acaPrompt').value = (cur && cur.session.prompt) || '';
  $('acaScrim').hidden = false;
  updateAcaPreview();
  ($('acaRepo').value ? $('acaPrompt') : $('acaRepo')).focus();
}

function updateAcaPreview() {
  const repo = $('acaRepo').value;
  const prompt = $('acaPrompt').value;
  const link = acaNewIssueLink(repo, prompt);
  const title = acaTitle(prompt);
  // What will actually appear, shown before anything opens. The point of this
  // route over a launcher is that the request is READ, not approved blind.
  $('acaPreview').textContent = link
    ? `${acaRepoName(repo)} · new issue: “${title}”`
    : 'Enter a repository as owner/repo, and what it should do.';
  $('acaOpen').disabled = !link;

  // The job runs wherever Squad on ACA is installed -- which is a property of
  // the repository, not of this hub. Saying so where the repository is typed is
  // the only place it can stop somebody expecting their own subscription.
  const name = acaRepoName(repo);
  const cur = state.currentSession;
  const fromSession = cur && acaSessionRepo(cur.session) === name;
  $('acaRepoHint').textContent = !name ? ''
    : fromSession ? 'From this session\u2019s checkout.'
      : 'Runs in whichever Azure subscription this repository\u2019s workflow is set up for.';

  const cmd = acaComment(prompt);
  $('acaComment').textContent = cmd || '/squad-aca \u2026';
  $('acaCopy').disabled = !cmd;
  $('acaOpenIssue').disabled = !acaIssueLink(repo, $('acaIssue').value);
}

/**
 * Who has access, for an owner.
 *
 * Every value rendered here is user-supplied -- a login somebody typed, a note
 * somebody wrote -- so all of it goes through `esc`, and the login travels back
 * to the API through `encodeURIComponent`. An access-control screen that could
 * be made to run someone else's markup would be a poor place to have that
 * particular bug.
 */
async function openPeople() {
  const box = $('peopleScrim');
  $('pplErr').hidden = true;
  $('pplLogin').value = '';
  $('pplNote').value = '';
  $('pplSearch').value = '';
  $('pplSource').value = '';
  state.people = null;
  box.hidden = false;
  await loadPeople();
  $('pplLogin').focus();
}

/**
 * Which rows to show, given the filter box and the source picker.
 *
 * Filtering is done here rather than by asking the hub again: the whole list is
 * already in hand, and a round trip per keystroke would make a fifty-person
 * list feel worse than a five-person one.
 */
function peopleVisible(users, query, source) {
  const q = String(query || '').trim().toLowerCase();
  return (users || []).filter((u) => {
    if (source && u.source !== source) return false;
    if (!q) return true;
    return `${u.login} ${u.note || ''} ${u.addedBy || ''}`.toLowerCase().includes(q);
  });
}

function peopleRows(data, query, source) {
  const all = (data && data.users) || [];
  const users = peopleVisible(all, query, source);
  if (!all.length) return '<p class="ppl-empty">Nobody else has access yet.</p>';
  if (!users.length) return '<p class="ppl-empty">Nobody matches that filter.</p>';
  return users.map((u) => {
    // A row that cannot be removed says WHY, in place, rather than offering an
    // action that fails. Being refused after clicking teaches nothing except
    // not to trust the buttons.
    const tag = u.source === 'owner' ? '<span class="ppl-tag owner">Owner</span>'
      : u.source === 'deployment' ? '<span class="ppl-tag">Deployment</span>'
        : '';
    const detail = u.source === 'added'
      ? [u.addedBy ? `added by ${u.addedBy}` : null, u.note].filter(Boolean).join(' · ')
      : u.source === 'owner' ? 'signs in as you, and shares your devices'
        : 'set in this hub\u2019s configuration';
    const action = u.removable
      ? `<button class="ghost danger sm" data-remove="${esc(u.login)}" data-source="${esc(u.source)}" aria-label="Remove ${esc(u.login)}">Remove</button>`
      : '';
    return `<div class="ppl-row" role="listitem">
      <div class="ppl-who">
        <div class="ppl-name"><span>${esc(u.login)}</span>${tag}</div>
        ${detail ? `<small>${esc(detail)}</small>` : ''}
      </div>
      ${action}
    </div>`;
  }).join('');
}

/** The one-line summary above the list, so a long list still says how long. */
function peopleSummary(data, shown) {
  const all = ((data && data.users) || []).length;
  const owners = ((data && data.users) || []).filter((u) => u.source === 'owner').length;
  const people = all - owners;
  const noun = people === 1 ? 'person' : 'people';
  const base = `${people} ${noun} with access, ${owners === 1 ? '1 owner' : `${owners} owners`}`;
  return shown === all ? base : `${base} · showing ${shown}`;
}

async function loadPeople() {
  const list = $('pplList');
  list.innerHTML = '<p class="ppl-empty">Loading…</p>';
  try {
    state.people = await api('/api/access');
  } catch (e) {
    list.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  renderPeople();
}

function renderPeople() {
  const data = state.people;
  if (!data) return;
  const list = $('pplList');
  const query = $('pplSearch').value;
  const source = $('pplSource').value;
  const shown = peopleVisible(data.users, query, source).length;

  const warn = data.ok === false
    ? `<p class="err">The access list could not be read (${esc(data.error || 'unknown')}), so it cannot be changed. The deployment's own list still applies.</p>`
    : !data.durable
      ? '<p class="ppl-warn">This hub cannot save its access list, so anyone added here is forgotten when it restarts.</p>'
      : '';
  list.innerHTML = warn + peopleRows(data, query, source);
  $('pplCount').textContent = peopleSummary(data, shown);

  list.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = async () => {
      const login = b.dataset.remove;
      // Revoking access is not undoable by accident, and the person on the
      // other end simply stops being able to sign in. Ask first, and say what
      // actually happens -- their own devices and sessions are theirs, not
      // yours, so "remove" is about this hub and not about their work.
      const extra = b.dataset.source === 'deployment'
        ? '\n\nThey are named in this hub\u2019s configuration, so the removal is recorded here and applied on top of it.'
        : '';
      if (!confirm(`Remove ${login}?\n\nThey will no longer be able to sign in to this hub.${extra}`)) return;
      b.disabled = true;
      try {
        state.people = await api(`/api/access/${encodeURIComponent(login)}`, { method: 'DELETE' });
        $('pplErr').hidden = true;
        renderPeople();
      } catch (e) {
        $('pplErr').textContent = e.message;
        $('pplErr').hidden = false;
        b.disabled = false;
      }
    };
  });
}

/**
 * Is this page already running as an installed app?
 *
 * Worth knowing because the menu should not offer to install something that
 * is already installed -- on iOS that offer is especially bad, since the only
 * thing behind it is a set of instructions the person has demonstrably already
 * followed.
 *
 * Two checks, because neither covers both worlds: `display-mode: standalone`
 * is the standard and is what Chromium reports, while iOS predates it and
 * exposes the non-standard `navigator.standalone` instead.
 */
function isInstalled(win = typeof window === 'undefined' ? null : window) {
  if (!win) return false;
  try {
    if (win.navigator && win.navigator.standalone === true) return true;
    if (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches) return true;
  } catch { /* matchMedia missing */ }
  return false;
}

/**
 * Where "Install as an app" leads when the browser will not do it for us.
 *
 * `beforeinstallprompt` exists only in Chromium on desktop and Android. **No
 * browser on iOS implements it** -- they all run WebKit, and adding a web app
 * to the Home Screen is a share-sheet action the page cannot trigger. So on an
 * iPhone this menu item can never open an installer, and saying "use your
 * browser's Install app option" is advice that names a button which is not
 * there.
 *
 * A refusal has to say what to do instead, on the device in front of the
 * person. That means naming the actual steps, and admitting the awkward part:
 * on iOS, Add to Home Screen belongs to Safari. Third-party browsers may offer
 * it in their own share menu and may not, so the reliable route is named
 * rather than guessed at.
 */
function installSteps() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua)
    // iPadOS 13+ reports itself as a Mac; a touch point tells them apart.
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  if (ios) {
    const safari = !/CriOS|EdgiOS|FxiOS|OPiOS/.test(ua);
    return {
      title: 'Add Squad Hub to your Home Screen',
      steps: safari
        ? ['Tap the Share button at the bottom of Safari.',
          'Scroll down and tap "Add to Home Screen".',
          'Tap Add.']
        : ['Tap this browser\u2019s Share button and look for "Add to Home Screen".',
          'If it is not there, open this page in Safari and use Share \u2192 Add to Home Screen.'],
      note: safari
        ? 'iOS has no install prompt a website can trigger, so this is the only route.'
        : 'On iOS, Home Screen web apps are a Safari feature. Other browsers may not offer it.',
    };
  }
  if (/Android/.test(ua)) {
    return {
      title: 'Add Squad Hub to your home screen',
      steps: ['Open the browser menu (\u22ee).', 'Tap "Install app" or "Add to Home screen".'],
      note: null,
    };
  }
  return {
    title: 'Install Squad Hub',
    steps: ['Look for the install icon in the address bar, or the browser menu \u2192 "Install Squad Hub".'],
    note: 'Firefox and Safari on the desktop do not install web apps; Chrome and Edge do.',
  };
}

function showInstallHelp() {
  const { title, steps, note } = installSteps();
  const box = $('installHelp');
  if (!box) { toast(steps[0]); return; }
  box.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ihTitle">
      <h2 id="ihTitle">${esc(title)}</h2>
      <ol class="ih-steps">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${note ? `<p class="sub">${esc(note)}</p>` : ''}
      <div class="modal-actions"><button class="primary" id="ihClose">Got it</button></div>
    </div>`;
  box.hidden = false;
  $('ihClose').onclick = () => { box.hidden = true; };
  box.onclick = (e) => { if (e.target === box) box.hidden = true; };
}

/**
 * The sign-in page.
 *
 * What was here before told people to "open the link printed by the server",
 * which is not a sign-in -- it is an instruction to go and find a URL somewhere
 * else. A hub you cannot log into from its own front page is a hub people paste
 * tokens around for.
 *
 * What is offered depends on what the hub actually supports, asked rather than
 * assumed: a button that leads nowhere is worse than no button.
 */
export async function showSignIn() {
  let methods = { mode: 'unknown', githubOAuth: false, acceptsToken: true };
  try { methods = await (await fetch('/api/auth-methods')).json(); } catch { /* offline */ }

  const oauth = methods.githubOAuth;
  document.body.innerHTML = `
    <div class="signin">
      <img src="/logo.jpg" alt="Squad Hub">
      <h1>Squad Hub</h1>
      <p class="signin-sub">See and control your Squad sessions.</p>

      ${oauth ? `
        <a class="signin-btn" href="/auth/github/login">
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
              0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01
              1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95
              0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27
              2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15
              0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0
              .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          Sign in with GitHub
        </a>
        <div class="signin-or">or</div>
      ` : ''}

      <form class="signin-form" id="tokenForm">
        <label for="tokenInput">${oauth ? 'Use a token instead' : 'Sign in with a token'}</label>
        <input id="tokenInput" type="password" placeholder="paste a token"
               autocomplete="off" spellcheck="false">
        <button class="primary" type="submit">Continue</button>
      </form>

      <p class="signin-hint">${signInHint(methods.mode)}</p>
      <p class="err" id="signinErr" hidden></p>
    </div>`;

  document.getElementById('tokenForm').onsubmit = async (e) => {
    e.preventDefault();
    const token = document.getElementById('tokenInput').value.trim();
    if (!token) return;
    // Check the token BEFORE storing it. Saving a bad one and then failing
    // every request leaves people staring at an empty hub with no explanation.
    try {
      const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(r.status === 403
          ? (body.error || 'That account is not permitted to use this hub.')
          : 'That token was not accepted.');
      }
      localStorage.setItem('squad-hub-token', token);
      location.replace('/');
    } catch (err) {
      const el = document.getElementById('signinErr');
      el.hidden = false;
      el.textContent = err.message;
    }
  };
}

function signInHint(mode) {
  if (mode === 'github') return 'Any GitHub token works — <code>gh auth token</code> prints one.';
  if (mode === 'entra') return 'Use a Microsoft Entra ID access token for this hub.';
  return 'Use the token printed by <code>squad-hub serve</code>.';
}

// ---------------------------------------------------------------------------
(async function main() {
  // Test hook (documented, no secrets, no new capability): now that app.js is
  // an ES module, its top-level `const`/`function` bindings are module-scoped
  // rather than bare globals, so test/browser-e2e-unit.js's page.evaluate()
  // calls can no longer reach `state`, `setConn` or `renderTranscript` by
  // name. This exposes exactly those three bindings -- already reachable
  // through the UI -- for that test harness to read and call directly.
  window.__squadHubTest = { state, setConn, renderTranscript };

  // Before the sign-in gate: the shell is public, and someone installing the
  // app or opening it on a train should get a readable page either way.
  registerServiceWorker();
  state.token = loadToken();
  if (!state.token) return showSignIn();
  loadView();
  wire();
  syncControls();
  try {
    state.me = await api('/api/me');
    $('who').textContent = state.me.name || 'signed in';
    // The button says whose account it is, for anything that cannot see the
    // avatar. Without this a screen reader announces "Account, button" and
    // leaves out the only fact that matters on a shared machine.
    $('menuBtn').setAttribute('aria-label', `Account: ${state.me.name || 'signed in'}`);
    $('menuBtn').title = state.me.name || 'Account';
    // The user's own avatar where the provider supplies one, an initial
    // otherwise. The image is set up to fall back on its own if it fails to
    // load, so a blocked or broken avatar shows the initial rather than a
    // broken-image icon.
    setAvatar(state.me.avatar, state.me.name);
    // Only an owner is offered the access screen. Cosmetic, not a control: the
    // route checks the principal on every call, so revealing this item in a
    // console would buy a menu entry that returns 403.
    const peopleItem = document.querySelector('[data-menu="people"]');
    if (peopleItem) peopleItem.hidden = !state.me.isOwner;
    // A hub split across instances loses devices intermittently. Say so where
    // the user will notice it, not only in a log.
    if (state.me.warning) showBanner(state.me.warning);
  } catch (e) {
    // A token that no longer works should return you to sign-in, not to a dead
    // end. Expired GitHub tokens are ordinary, not exceptional.
    if (e.status === 401 || e.status === 403) {
      localStorage.removeItem('squad-hub-token');
      return showSignIn();
    }
    // No status at all means the request never got an ANSWER -- the hub is
    // unreachable, rather than the credential being refused. Saying "could not
    // sign in" there is confidently wrong: the person is signed in, and the
    // fix is to wait or check the network, not to hunt for a credential.
    //
    // This is what the offline shell is FOR. Caching the files is the easy
    // half; without this the cached page loads only to accuse you of not being
    // signed in, which is worse than the browser's own error page.
    if (e.status === undefined) return showOffline();
    document.body.innerHTML = `<div class="empty"><h3>Could not sign in</h3><p>${esc(e.message)}</p></div>`;
    return undefined;
  }
  await refresh();

  // A Teams card links here to answer an approval. Opening the hub's default
  // view instead would make the card's one working affordance a dead end --
  // the card exists BECAUSE it cannot approve in place.
  const wanted = takeDeepLinkSession();
  if (wanted) {
    const hit = resolveDeepLink(wanted, state.overview.groups);
    if (hit.status === 'found') openDetail(hit.key);
    else if (hit.status === 'ambiguous') toast(`More than one device has a session called "${wanted}" — open it from the list`);
    else toast(`That session is no longer here — it may have finished, or its device is offline`);
  }

  connect();
  setInterval(refresh, 15000);
  return undefined;
}());
