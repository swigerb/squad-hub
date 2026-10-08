// The "Install as an app" flow, split out of app.js's Wiring section by
// #200 (part 4/4 of #165), then extended by #171 with the header install
// icon, the richer install card for platforms with no native
// beforeinstallprompt, and the 30-day "Not now" dismissal.

import { state } from './api.js';
import { $, esc, toast } from './util.js';

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
export function isInstalled(win = typeof window === 'undefined' ? null : window) {
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
export function installSteps() {
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

export function showInstallHelp() {
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

// ---------------------------------------------------------------------------
// Header install icon (E2.1) and install card (E2.3)
// ---------------------------------------------------------------------------

/**
 * Which install path this browser actually has, independent of whether this
 * particular visit has already seen `beforeinstallprompt` fire.
 *
 * `beforeinstallprompt` is Chromium-only and arrives on its own schedule
 * (engagement heuristics, not page load), so `hasDeferredPrompt` is the thing
 * that is actually true right now rather than a guess from the user agent.
 * Everywhere else, `installSteps()` already knows which platforms have a real
 * route to Add to Home Screen / install -- iOS, Firefox and Safari all do,
 * just not through an API a page can call -- so those get OUR card instead.
 * Anything left over (an unknown browser with neither) gets neither: an icon
 * that opens a card of guesses is worse than no icon.
 */
export function installAvailability({ hasDeferredPrompt, ua = (typeof navigator === 'undefined' ? '' : navigator.userAgent) || '' } = {}) {
  if (hasDeferredPrompt) return 'native';
  const ios = /iPhone|iPad|iPod/.test(ua)
    || (/Macintosh/.test(ua) && (typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0) > 1);
  const firefox = /Firefox|FxiOS/.test(ua);
  // "Safari" without also being Chrome/Edge/Opera/Android, which all include
  // "Safari" in their UA string for historical reasons.
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/.test(ua);
  if (ios || firefox || safari) return 'manual';
  return 'none';
}

/**
 * Should the header icon show, and if so in which mode?
 *
 * Three ways to end up hidden, each a real acceptance criterion: already
 * installed, no install path this browser offers, or dismissed via "Not now"
 * within the last 30 days. Any one of them is enough -- this is a gate, not a
 * vote.
 */
export function installButtonState({
  installed, availability, dismissedUntil = 0, now = Date.now(),
}) {
  if (installed) return 'hidden';
  if (availability === 'none') return 'hidden';
  if (dismissedUntil && now < dismissedUntil) return 'hidden';
  return availability;
}

const INSTALL_DISMISS_KEY = 'squad-hub-install-dismissed-until';
const INSTALL_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

/** A localStorage that cannot throw, so a browser that blocks storage never breaks the icon. */
function safeLocalStorage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function installDismissedUntil(storage = safeLocalStorage()) {
  if (!storage) return 0;
  try { return Number(storage.getItem(INSTALL_DISMISS_KEY)) || 0; } catch { return 0; }
}

/** "Not now": hide the icon for 30 days, not forever -- a person's needs change, and this is not a refusal. */
export function dismissInstallButton(storage = safeLocalStorage(), now = Date.now()) {
  if (!storage) return;
  try { storage.setItem(INSTALL_DISMISS_KEY, String(now + INSTALL_DISMISS_MS)); } catch { /* quota, private mode */ }
}

/**
 * The kebab's "Install as an app" row never disappears -- it just stops being
 * a button once there is nothing left for it to do, and says so.
 */
function syncInstallMenuItem(installed) {
  // No id on this button -- see the comment in index.html -- so it is found
  // the same way the `people` menu item is: by its `data-menu` attribute.
  const item = document.querySelector('[data-menu="install"]');
  if (!item) return;
  item.disabled = installed;
  // The checkmark is its own element, appended beside the unchanging label,
  // so toggling it can never clobber the label text itself.
  let mark = item.querySelector('.install-done');
  if (installed && !mark) {
    mark = document.createElement('span');
    mark.className = 'install-done';
    mark.textContent = 'Installed \u2713';
    item.appendChild(mark);
  } else if (!installed && mark) {
    mark.remove();
  }
}

/** Re-evaluate and apply install UI state. Called at startup and on every event that could change it. */
export function syncInstallUI() {
  const btn = $('installBtn');
  if (!btn) return;
  const installed = isInstalled();
  syncInstallMenuItem(installed);
  const availability = installAvailability({ hasDeferredPrompt: !!state.installPrompt });
  const mode = installButtonState({
    installed, availability, dismissedUntil: installDismissedUntil(),
  });
  btn.hidden = mode === 'hidden';
  btn.dataset.mode = mode === 'hidden' ? '' : mode;
  if (mode === 'hidden') closeInstallCard();
}

export function openInstallCard() {
  const card = $('installCard');
  if (!card) return;
  const pub = $('installCardPub');
  if (pub) pub.textContent = `Publisher: ${location.host}`;
  const stepsEl = $('installCardSteps');
  if (stepsEl) {
    // Only shown for the manual path: the native path hands the whole job to
    // the browser's own card, which needs no steps of ours underneath it.
    if (state.installPrompt) {
      stepsEl.innerHTML = '';
    } else {
      const { steps } = installSteps();
      stepsEl.innerHTML = steps.map((s) => `<li>${esc(s)}</li>`).join('');
    }
  }
  card.hidden = false;
  $('installBtn').setAttribute('aria-expanded', 'true');
}

export function closeInstallCard() {
  const card = $('installCard');
  if (!card) return;
  card.hidden = true;
  const btn = $('installBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/**
 * The header icon's click. Chromium hands straight to the browser's own
 * install card -- that is the richer, more trusted UI, and there is no reason
 * to interpose our own in front of it. Everywhere else opens ours, since
 * there is no native one to defer to.
 */
function onInstallBtn() {
  if (state.installPrompt) {
    state.installPrompt.prompt();
    state.installPrompt.userChoice
      .catch(() => { /* dismissed */ })
      .then(() => { state.installPrompt = null; syncInstallUI(); });
    return;
  }
  const card = $('installCard');
  if (card && !card.hidden) { closeInstallCard(); return; }
  openInstallCard();
}

/** Wire the install prompt, the header icon, the install card, and the menu item's installed state. */
export function wireInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    syncInstallUI();
  });
  // Fires once the browser has actually installed it -- including via its OWN
  // card, which this page is never told was even shown. Without this the
  // header icon would sit there offering to install something that, from the
  // OS's point of view, already is.
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    closeInstallCard();
    syncInstallUI();
  });

  $('installBtn').onclick = (e) => { e.stopPropagation(); onInstallBtn(); };
  $('installCardClose').onclick = () => closeInstallCard();
  $('installCardNotNow').onclick = () => {
    dismissInstallButton(safeLocalStorage());
    closeInstallCard();
    syncInstallUI();
  };
  $('installCardInstall').onclick = async () => {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      try { await state.installPrompt.userChoice; } catch { /* dismissed */ }
      state.installPrompt = null;
      closeInstallCard();
      syncInstallUI();
      return;
    }
    // No native prompt to hand off to (iOS, Firefox, Safari): the card's own
    // steps list is the actual instructions, so "Install" just keeps the card
    // open at the steps rather than pretending to do something it cannot.
    toast('Follow the steps below to install');
  };

  // The header install icon and the kebab's "Install as an app" row both
  // depend on install state, so both are synced from one place at startup.
  syncInstallUI();
}
