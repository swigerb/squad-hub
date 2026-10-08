// The "Install as an app" flow, split out of app.js's Wiring section by
// #200 (part 4/4 of #165). Behavior is unchanged byte-for-byte from the
// original.

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

/** Wire the install prompt and hide the menu item once installed. */
export function wireInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
  });

  // Offering to install an app that is already installed is noise, so the
  // menu item goes away once we are running from the home screen or the dock.
  if (isInstalled()) {
    const item = document.querySelector('[data-menu="install"]');
    if (item) item.hidden = true;
  }
}
