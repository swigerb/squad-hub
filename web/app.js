/* Squad Hub web client.
 *
 * No framework and no build step. This is a control surface for a developer
 * tool -- it should be readable, forkable, and servable from the same process
 * as the API, without a toolchain standing between a contributor and a change.
 *
 * Live updates arrive over the same WebSocket the daemons use, on a watcher
 * connection. Control actions go over REST, because a command that must be
 * acknowledged deserves a status code.
 *
 * This file is just the imports and main(): everything that used to be the
 * Wiring section now lives under web/js/ (#200, part 4/4 of #165). Several
 * imports below are never called from this file directly -- they exist so
 * that test/helpers/web-source.js, which discovers modules by scanning this
 * file's own `import` statements, can find and concatenate every module for
 * the DOM-free unit tests that evaluate pure functions out of it.
 */

import { state, loadToken, api } from './js/api.js';
import {
  esc,
  num,
  truncateWords,
  statusLabel,
  asList,
  ANSWER_VERB,
  $,
  toast,
  setUndoDelayForTest,
} from './js/util.js';
import { TIME_WINDOWS, SORTS, GROUPINGS, skeletonRows } from './js/list.js';
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
import { render, skeletonDevices } from './js/devices.js';
import {
  openDetail, syncSession, renderControl, openSquadDoc,
} from './js/detail.js';
import { renderTranscript } from './js/transcript.js';
import { inboxEntries, inboxCount, renderInboxList } from './js/inbox.js';
import {
  connect, setAvatar, setConn, takeDeepLinkSession, takeShortcut, resolveDeepLink, showOffline,
  registerServiceWorker, refresh, loadView, saveView, toggleFavorite, syncControls,
  applyTheme, nextTheme, setRailCollapsed, loadPrefs, renameSession,
} from './js/ws.js';
import {
  acaRepoName, acaSessionRepo, acaTitle, acaNewIssueLink, acaComment, acaIssueLink, openAca,
} from './js/aca.js';
import { peopleVisible, peopleRows, peopleSummary, openPeople } from './js/access.js';
import { isInstalled, installSteps, showInstallHelp } from './js/install.js';
import { urlBase64ToUint8Array, pushSupported } from './js/push.js';
import { openNew, openConnect } from './js/connect.js';
import { wireFilters } from './js/filters.js';
import { wire, showBanner } from './js/wiring.js';
import { showSignIn } from './js/signin.js';
// Not called directly from this file -- see the header comment above for
// why app.js's own import list is also the module manifest
// test/helpers/web-source.js reads to concatenate every pure-logic file for
// the DOM-free unit tests (#170).
import { rowMenuItems, rowMenuHtml } from './js/rowmenu.js';
import { sessionRow, displayTitle } from './js/sessionrow.js';

'use strict';

/** Run whatever a manifest shortcut asked for. Unknown or absent ids do nothing -- NOT every load has one. */
function runShortcut(id) {
  if (id === 'new-session') { openNew(); return; }
  if (id === 'needs-you') { $('bellBtn').click(); return; }
  if (id === 'aca-job') { openAca(); return; }
}

(async function main() {
  // Test hook (documented, no secrets, no new capability): now that app.js is
  // an ES module, its top-level `const`/`function` bindings are module-scoped
  // rather than bare globals, so test/browser-e2e-unit.js's page.evaluate()
  // calls can no longer reach `state`, `setConn` or `renderTranscript` by
  // name. This exposes exactly those three bindings -- already reachable
  // through the UI -- for that test harness to read and call directly.
  //
  // `setUndoDelayForTest` shortens the Undo window below (real deployments
  // keep the full 5 seconds). It changes no behavior a person could not
  // already see -- the window is always "however long the toast says" -- it
  // only makes that window short enough for a test suite to wait out without
  // every click costing five real seconds.
  window.__squadHubTest = {
    state, setConn, renderTranscript, setUndoDelayForTest,
  };

  // Before the sign-in gate: the shell is public, and someone installing the
  // app or opening it on a train should get a readable page either way.
  registerServiceWorker();
  state.token = loadToken();
  if (!state.token) return showSignIn();
  loadView();
  wire();
  syncControls();
  // Rows and device cards the shape of what is about to arrive, rather than a
  // blank box or a lone "loading…" sentence -- replaced the instant the first
  // overview below actually resolves.
  $('groups').innerHTML = `<div class="card">${skeletonRows()}</div>`;
  $('deviceList').innerHTML = `<div class="card">${skeletonDevices()}</div>`;
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
  } catch (e) {    // A token that no longer works should return you to sign-in, not to a dead
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
  // Best-effort and never awaited for the page's first paint: pins and names
  // already on screen came from localStorage an instant ago, so a slow or
  // failed `/api/prefs` fetch delays nothing a person can see, it just
  // catches up (or retries) once it resolves (#170).
  loadPrefs();
  await refresh();

  // A Teams card links here to answer an approval. Opening the hub's default
  // view instead would make the card's one working affordance a dead end --
  // the card exists BECAUSE it cannot approve in place.
  //
  // Unlike the token above, the session key is NOT removed: the detail page
  // is a real, addressable URL now (#181), so a reload or a shared link
  // should reopen the same session rather than silently dropping back to the
  // list. `openDetail` normalizes it with `replaceState` once the key is
  // resolved, so this first open never adds a second history entry.
  const wanted = takeDeepLinkSession();
  if (wanted) {
    const hit = resolveDeepLink(wanted, state.overview.groups);
    if (hit.status === 'found') {
      openDetail(hit.key, { nav: 'replace' });
    } else {
      // A link that no longer resolves should not keep squatting on the
      // address bar -- it would reopen the toast below on every reload.
      history.replaceState({}, '', location.pathname);
      if (hit.status === 'ambiguous') toast(`More than one device has a session called "${wanted}" — open it from the list`);
      else toast(`That session is no longer here — it may have finished, or its device is offline`);
    }
  }

  // Launched from a manifest shortcut (long-press the pinned icon): New
  // session, Needs you, or Start ACA job. Each hands off to the SAME control
  // the shortcut is named after, rather than duplicating its behavior --
  // "Needs you" is exactly what the bell already does.
  runShortcut(takeShortcut());

  connect();
  setInterval(refresh, 15000);
  return undefined;
}());
