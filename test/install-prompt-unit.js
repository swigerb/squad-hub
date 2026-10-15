'use strict';
/**
 * "Install as an app" on a device that has no installer.
 *
 * The menu item used to end in a toast reading: use your browser's "Install
 * app" or "Add to Home Screen" option. On an iPhone that names a button which
 * does not exist. `beforeinstallprompt` is a Chromium API; every browser on
 * iOS is WebKit underneath and none of them fire it, so the page can never
 * open an installer there -- Add to Home Screen is a share-sheet action the
 * user has to take, and in Safari specifically.
 *
 * So `installSteps()` has to be right about the platform in front of the
 * person, and being wrong is SILENT: it renders confident, useless advice.
 * These assertions pin the three cases apart.
 *
 * Extraction follows web-xss-unit.js: `web/app.js` has no build step and no
 * exports, so its DOM-free prefix is evaluated directly, here with a fake
 * `navigator` injected as a parameter. `installSteps` reading `navigator` at
 * CALL time rather than load time is what makes that possible.
 */

const assert = require('assert');
const { readWebSource } = require('./helpers/web-source');

let pass = 0; let fail = 0;
function check(name, fn) {
  try {
    fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

const src = readWebSource();

// `navigator` is a parameter, so it shadows the (absent) global for the whole
// prefix -- no globals are mutated and nothing leaks between cases.
function stepsFor(ua, maxTouchPoints = 0) {
  return load({ userAgent: ua, maxTouchPoints }).installSteps();
}

function load(navigator, { document, window } = {}) {
  const mod = { exports: {} };
  const fn = new Function(
    'module', 'navigator', 'document', 'window',
    `${src}\nmodule.exports = {
      installSteps, isInstalled, checkInstalledRelated, refreshInstalledRelated,
      syncInstallUI, showInstallHelp, state,
    };`,
  );
  fn(mod, navigator, document, window);
  return mod.exports;
}

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneEdge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 EdgiOS/126.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
  ipadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OPR/112.0',
};

const joined = (r) => `${r.title}\n${r.steps.join('\n')}\n${r.note || ''}`;

check('every platform gets a title and at least one concrete step', () => {
  for (const [name, ua] of Object.entries(UA)) {
    const r = stepsFor(ua, name === 'ipadOS' ? 5 : 0);
    assert.ok(r.title, `${name}: no title`);
    assert.ok(Array.isArray(r.steps) && r.steps.length >= 1, `${name}: no steps`);
    for (const s of r.steps) assert.ok(s && s.trim(), `${name}: empty step`);
  }
});

check('iPhone Safari is told to use Share -> Add to Home Screen', () => {
  const r = stepsFor(UA.iphoneSafari);
  assert.match(joined(r), /Add to Home Screen/i);
  assert.match(joined(r), /Share/i);
});

check('iPhone Safari is NOT told to look for an "Install app" button that iOS does not have', () => {
  // This is the exact wording the old toast used, and the reason for this file.
  assert.doesNotMatch(joined(stepsFor(UA.iphoneSafari)), /Install app/i);
});

check('a non-Safari iOS browser is told the truth: this is a Safari feature', () => {
  for (const ua of [UA.iphoneEdge, UA.iphoneChrome]) {
    const text = joined(stepsFor(ua));
    assert.match(text, /Safari/, 'does not mention Safari, where Add to Home Screen actually lives');
    assert.match(text, /Add to Home Screen/i);
  }
});

check('iPadOS is recognised as iOS even though it claims to be a Mac', () => {
  // Safari on iPad reports a Macintosh UA; touch points are what tell it from
  // a laptop. Getting this wrong sends an iPad user hunting the address bar
  // for an install icon that is not there.
  const ipad = stepsFor(UA.ipadOS, 5);
  assert.match(joined(ipad), /Add to Home Screen/i);
  const laptop = stepsFor(UA.mac, 0);
  assert.doesNotMatch(joined(laptop), /Add to Home Screen/i);
});

check('Android is pointed at its own menu, not at Safari', () => {
  const text = joined(stepsFor(UA.android));
  assert.match(text, /menu/i);
  assert.doesNotMatch(text, /Safari/);
});

check('desktop is pointed at the address bar, and told which browsers refuse', () => {
  const r = stepsFor(UA.firefox);
  assert.match(joined(r), /address bar|menu/i);
  assert.ok(r.note && /Safari|Firefox/.test(r.note), 'desktop advice does not say which browsers cannot install');
});

check('a missing or empty user agent still produces usable advice', () => {
  for (const ua of ['', undefined]) {
    const r = stepsFor(ua);
    assert.ok(r.steps.length >= 1, 'no steps for an unknown platform');
  }
});

// ---------------------------------------------------------------------------
// Already installed -- do not offer to install it again
// ---------------------------------------------------------------------------

/**
 * Two different mechanisms, because neither browser world implements the
 * other's. Chromium reports the standard `display-mode: standalone` media
 * query; iOS predates it and only sets `navigator.standalone`. Checking one
 * alone leaves half the installed users still being offered an installer.
 */
const { isInstalled } = load({ userAgent: '' });

function win({ standalone, displayMode } = {}) {
  return {
    navigator: { standalone },
    matchMedia: (q) => ({ matches: displayMode === true && q.includes('standalone') }),
  };
}

check('a browser tab is not mistaken for an installed app', () => {
  assert.strictEqual(isInstalled(win()), false);
  assert.strictEqual(isInstalled(win({ standalone: false, displayMode: false })), false);
});

check('an iOS home screen app is detected via navigator.standalone', () => {
  assert.strictEqual(isInstalled(win({ standalone: true })), true);
});

check('an installed Chromium app is detected via display-mode: standalone', () => {
  assert.strictEqual(isInstalled(win({ displayMode: true })), true);
});

check('a browser without matchMedia does not throw, it just says "not installed"', () => {
  // Nothing here should be able to break the menu on an old or odd browser.
  assert.strictEqual(isInstalled({ navigator: {} }), false);
  assert.strictEqual(isInstalled({}), false);
  assert.strictEqual(isInstalled(null), false);
});

// ---------------------------------------------------------------------------
// Edge and Chrome on the desktop (#267): an installed app is not offered again
// ---------------------------------------------------------------------------

/**
 * Both browsers stop firing `beforeinstallprompt` once the app is installed,
 * so the old "look for the install icon in the address bar" advice was wrong
 * exactly when someone asked for it. The dialog now says where the installed
 * app lives. A page cannot navigate to edge:// or chrome:// URLs, so the apps
 * page is offered as copyable text (`copy`) instead.
 */
const winStepsFor = (ua, installed) => load({ userAgent: ua, maxTouchPoints: 0 }).installSteps({ installed });

check('Edge, installed: says so, and points at edge://apps, Open in app and the Start menu', () => {
  const r = winStepsFor(UA.edge, true);
  assert.strictEqual(r.title, 'Squad Hub is installed');
  assert.strictEqual(r.copy, 'edge://apps');
  assert.deepStrictEqual(r.steps, [
    'Open edge://apps in the address bar and choose Squad Hub.',
    'Or select Open in app in the address bar.',
    'Or open Squad Hub from the Start menu.',
  ]);
  assert.ok(!r.intro, 'a confirmed install has nothing to hedge about');
  assert.doesNotMatch(joined(r), /chrome:\/\//);
});

check('Edge, not confirmed and no native prompt: says Edge is not offering to install, and still has the install route', () => {
  const r = winStepsFor(UA.edge, false);
  assert.match(r.intro, /Edge is not offering to install Squad Hub right now, which usually means it is already installed/);
  assert.strictEqual(r.copy, 'edge://apps');
  assert.match(r.steps[0], /edge:\/\/apps/);
  const last = r.steps[r.steps.length - 1];
  assert.match(last, /menu/);
  assert.match(last, /Apps/);
  assert.match(last, /Install Squad Hub/);
});

check('Chrome, installed: points at chrome://apps, never edge://', () => {
  const r = winStepsFor(UA.windows, true);
  assert.strictEqual(r.title, 'Squad Hub is installed');
  assert.strictEqual(r.copy, 'chrome://apps');
  assert.match(r.steps[0], /chrome:\/\/apps/);
  assert.match(joined(r), /Open in app/);
  assert.doesNotMatch(joined(r), /edge:\/\//);
});

check('Chrome, not confirmed: hedges, names chrome://apps, and keeps a generic install route', () => {
  const r = winStepsFor(UA.windows, false);
  assert.match(r.intro, /Chrome is not offering to install Squad Hub right now/);
  assert.strictEqual(r.copy, 'chrome://apps');
  assert.match(r.steps[r.steps.length - 1], /install icon in the address bar/);
  assert.doesNotMatch(joined(r), /edge:\/\//);
});

check('Edge on a Mac names the Applications folder instead of a Start menu it does not have', () => {
  const ua = UA.edge.replace('Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 10_15_7');
  assert.doesNotMatch(joined(winStepsFor(ua, true)), /Start menu/);
});

check('browsers that are not Edge or Chrome keep the text they always had, installed or not', () => {
  const generic = 'Look for the install icon in the address bar, or the browser menu \u2192 "Install Squad Hub".';
  for (const [name, ua] of [['firefox', UA.firefox], ['macSafari', UA.macSafari], ['opera', UA.opera]]) {
    for (const installed of [true, false]) {
      const r = winStepsFor(ua, installed);
      assert.strictEqual(r.title, 'Install Squad Hub', name);
      assert.deepStrictEqual(r.steps, [generic], name);
      assert.ok(!r.copy && !r.intro, `${name} got Chromium-only content`);
    }
  }
  const plain = load({ userAgent: UA.windows }).installSteps({ installed: true });
  assert.strictEqual(plain.title, 'Squad Hub is installed', 'a plain Chrome UA is Chrome');
  // Brave reports a Chrome UA, but its apps page is not chrome://apps.
  const brave = load({ userAgent: UA.windows, brave: { isBrave() {} } }).installSteps({ installed: true });
  assert.strictEqual(brave.title, 'Install Squad Hub');
});

check('iOS and Android text is exactly what it was, installed or not', () => {
  for (const installed of [true, false]) {
    assert.deepStrictEqual(winStepsFor(UA.android, installed), {
      title: 'Add Squad Hub to your home screen',
      steps: ['Open the browser menu (\u22ee).', 'Tap "Install app" or "Add to Home screen".'],
      note: null,
    });
    assert.deepStrictEqual(winStepsFor(UA.iphoneSafari, installed).steps, [
      'Tap the Share button at the bottom of Safari.',
      'Scroll down and tap "Add to Home Screen".',
      'Tap Add.',
    ]);
    assert.strictEqual(winStepsFor(UA.iphoneSafari, installed).title, 'Add Squad Hub to your Home Screen');
    assert.match(winStepsFor(UA.iphoneEdge, installed).steps[1], /open this page in Safari/);
  }
});

check('installSteps() with no argument follows state.installedRelated', () => {
  const m = load({ userAgent: UA.edge, maxTouchPoints: 0 });
  assert.strictEqual(m.installSteps().title, 'Is Squad Hub already installed?');
  m.state.installedRelated = true;
  assert.strictEqual(m.installSteps().title, 'Squad Hub is installed');
});

// ---------------------------------------------------------------------------
// Header install button: availability, visibility, and 30-day dismissal
// ---------------------------------------------------------------------------

/**
 * `installAvailability` and `installButtonState` are read with a fake
 * `navigator` the same way `installSteps` is above -- see the file banner.
 */
function helpers(ua = '', maxTouchPoints = 0) {
  const mod = { exports: {} };
  const fn = new Function(
    'module', 'navigator',
    `${src}\nmodule.exports = {
      installAvailability, installButtonState, installDismissedUntil, dismissInstallButton,
    };`,
  );
  fn(mod, { userAgent: ua, maxTouchPoints });
  return mod.exports;
}

check('a Chromium browser that fired beforeinstallprompt gets the native path', () => {
  const { installAvailability } = helpers(UA.windows);
  assert.strictEqual(installAvailability({ hasDeferredPrompt: true, ua: UA.windows }), 'native');
});

check('iOS, Firefox and desktop Safari get the manual card, never "native"', () => {
  assert.strictEqual(
    helpers(UA.iphoneSafari).installAvailability({ hasDeferredPrompt: false, ua: UA.iphoneSafari }),
    'manual',
  );
  assert.strictEqual(
    helpers(UA.ipadOS, 5).installAvailability({ hasDeferredPrompt: false, ua: UA.ipadOS }),
    'manual',
    'iPadOS claims to be a Mac, and is only told apart by its touch points',
  );
  const firefoxUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
  assert.strictEqual(helpers(firefoxUA).installAvailability({ hasDeferredPrompt: false, ua: firefoxUA }), 'manual');
  const safariUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  assert.strictEqual(helpers(safariUA).installAvailability({ hasDeferredPrompt: false, ua: safariUA }), 'manual');
});

check('Chrome and Edge without a captured prompt yet are "none", not "manual"', () => {
  // Both UAs contain the literal substring "Safari" for legacy reasons; the
  // manual card must not be offered to a browser that actually has a native
  // installer, just because `beforeinstallprompt` has not fired YET.
  const { installAvailability } = helpers();
  assert.strictEqual(installAvailability({ hasDeferredPrompt: false, ua: UA.windows }), 'none');
  const edgeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0';
  assert.strictEqual(installAvailability({ hasDeferredPrompt: false, ua: edgeUA }), 'none');
});

check('already installed hides the button regardless of availability', () => {
  const { installButtonState } = helpers();
  assert.strictEqual(installButtonState({ installed: true, availability: 'native' }), 'hidden');
  assert.strictEqual(installButtonState({ installed: true, availability: 'manual' }), 'hidden');
});

check('no install path on this browser hides the button', () => {
  const { installButtonState } = helpers();
  assert.strictEqual(installButtonState({ installed: false, availability: 'none' }), 'hidden');
});

check('"Not now" hides the button until the 30-day dismissal expires, then it returns', () => {
  const { installButtonState } = helpers();
  const now = Date.UTC(2026, 0, 1);
  const dismissedUntil = now + 10 * 24 * 60 * 60 * 1000;
  assert.strictEqual(installButtonState({
    installed: false, availability: 'manual', dismissedUntil, now,
  }), 'hidden', 'still within the 30 days');
  assert.strictEqual(installButtonState({
    installed: false, availability: 'manual', dismissedUntil, now: dismissedUntil + 1,
  }), 'manual', 'dismissal window has passed');
});

check('with nothing hiding it, the button shows in whichever mode is available', () => {
  const { installButtonState } = helpers();
  assert.strictEqual(installButtonState({ installed: false, availability: 'native' }), 'native');
  assert.strictEqual(installButtonState({ installed: false, availability: 'manual' }), 'manual');
});

/** A fake localStorage: object-backed, and able to simulate a browser that blocks storage entirely. */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

check('dismissing writes a 30-day expiry that installDismissedUntil reads back', () => {
  const { installDismissedUntil, dismissInstallButton } = helpers();
  const storage = fakeStorage();
  const now = Date.UTC(2026, 0, 1);
  dismissInstallButton(storage, now);
  const until = installDismissedUntil(storage);
  assert.strictEqual(until, now + 30 * 24 * 60 * 60 * 1000);
});

check('no prior dismissal reads back as 0, not NaN or a thrown error', () => {
  const { installDismissedUntil } = helpers();
  assert.strictEqual(installDismissedUntil(fakeStorage()), 0);
  assert.strictEqual(installDismissedUntil(null), 0);
});

check('a storage that throws (private mode, quota) cannot crash dismissal', () => {
  const { installDismissedUntil, dismissInstallButton } = helpers();
  const angry = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.strictEqual(installDismissedUntil(angry), 0);
  dismissInstallButton(angry, Date.now()); // must not throw
});

// ---------------------------------------------------------------------------
// navigator.getInstalledRelatedApps(): installed, seen from a browser tab
// ---------------------------------------------------------------------------

const related = load({ userAgent: UA.edge });

async function checkAsync(name, fn) {
  try {
    await fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

/** A fake DOM with just the nodes install.js touches. */
function fakeDom({ standalone = false } = {}) {
  const els = {
    installBtn: { hidden: true, dataset: {}, setAttribute() {} },
    installCard: { hidden: true },
    installHelp: { hidden: true, innerHTML: '' },
    toast: { hidden: true },
    ihClose: {},
    ihCopy: {},
  };
  const item = {
    disabled: false,
    mark: null,
    querySelector(sel) { return sel === '.install-done' ? this.mark : null; },
    appendChild(n) { this.mark = n; },
  };
  const document = {
    getElementById: (id) => els[id] || null,
    querySelector: (sel) => (sel === '[data-menu="install"]' ? item : null),
    createElement: () => ({ remove() { item.mark = null; } }),
  };
  const window = {
    navigator: { standalone: standalone || undefined },
    matchMedia: () => ({ matches: false }),
  };
  return { els, item, document, window };
}

(async () => {
  await checkAsync('getInstalledRelatedApps missing: "not installed", no throw', async () => {
    assert.strictEqual(await related.checkInstalledRelated({}), false);
    assert.strictEqual(await related.checkInstalledRelated(null), false);
  });

  await checkAsync('getInstalledRelatedApps throwing or rejecting: "not installed", no throw', async () => {
    assert.strictEqual(await related.checkInstalledRelated({
      getInstalledRelatedApps() { throw new Error('SecurityError'); },
    }), false);
    assert.strictEqual(await related.checkInstalledRelated({
      getInstalledRelatedApps: () => Promise.reject(new Error('NotAllowedError')),
    }), false);
  });

  await checkAsync('getInstalledRelatedApps returning [] (or junk): "not installed"', async () => {
    for (const value of [[], undefined, null, 'webapp']) {
      assert.strictEqual(await related.checkInstalledRelated({
        getInstalledRelatedApps: async () => value,
      }), false, String(value));
    }
  });

  await checkAsync('getInstalledRelatedApps returning a match: installed', async () => {
    assert.strictEqual(await related.checkInstalledRelated({
      getInstalledRelatedApps: async () => [{ platform: 'webapp', url: 'https://hub.example/app.webmanifest' }],
    }), true);
  });

  await checkAsync('refreshInstalledRelated caches the answer in state.installedRelated and re-syncs the UI', async () => {
    const dom = fakeDom();
    const m = load({ userAgent: UA.edge }, dom);
    assert.strictEqual(m.state.installedRelated, undefined);
    await m.refreshInstalledRelated({ getInstalledRelatedApps: async () => [{ platform: 'webapp' }] });
    assert.strictEqual(m.state.installedRelated, true);
    assert.ok(dom.item.mark, 'the menu item was not re-synced');
    // Uninstalled later: the next check clears it again.
    await m.refreshInstalledRelated({ getInstalledRelatedApps: async () => [] });
    assert.strictEqual(m.state.installedRelated, false);
    assert.strictEqual(dom.item.mark, null);
  });

  // The menu item. In a TAB a disabled item could never open the help dialog
  // that says how to open the installed app, so it stays enabled there; only
  // the standalone window (where there is nothing to explain) disables it.
  await checkAsync('in a TAB with the app installed: item stays ENABLED and labelled Installed, header icon stays hidden', async () => {
    const dom = fakeDom();
    const m = load({ userAgent: UA.edge }, dom);
    m.state.installedRelated = true;
    m.syncInstallUI();
    assert.strictEqual(dom.item.disabled, false, 'a disabled item in a tab could not open the help dialog');
    assert.strictEqual(dom.item.mark.textContent, 'Installed \u2713');
    assert.strictEqual(dom.els.installBtn.hidden, true);
  });

  await checkAsync('in the STANDALONE app window: item is DISABLED and labelled Installed, header icon hidden', async () => {
    const dom = fakeDom({ standalone: true });
    const m = load({ userAgent: UA.edge }, dom);
    m.syncInstallUI();
    assert.strictEqual(dom.item.disabled, true);
    assert.strictEqual(dom.item.mark.textContent, 'Installed \u2713');
    assert.strictEqual(dom.els.installBtn.hidden, true);
  });

  await checkAsync('not installed anywhere: item enabled, no checkmark', async () => {
    const dom = fakeDom();
    const m = load({ userAgent: UA.firefox }, dom);
    m.syncInstallUI();
    assert.strictEqual(dom.item.disabled, false);
    assert.strictEqual(dom.item.mark, null);
  });

  await checkAsync('the help dialog in a tab, with the app installed, shows the edge://apps steps and a Copy button', async () => {
    const dom = fakeDom();
    const m = load({ userAgent: UA.edge }, dom);
    m.state.installedRelated = true;
    m.showInstallHelp();
    const html = dom.els.installHelp.innerHTML;
    assert.strictEqual(dom.els.installHelp.hidden, false);
    assert.match(html, /Squad Hub is installed/);
    assert.match(html, /<code id="ihCode">edge:\/\/apps<\/code>/);
    assert.match(html, /id="ihCopy"/);
    assert.match(html, /Start menu/);
  });

  await checkAsync('the help dialog on iOS has no Copy button', async () => {
    const dom = fakeDom();
    const m = load({ userAgent: UA.iphoneSafari, maxTouchPoints: 5 }, dom);
    m.showInstallHelp();
    assert.doesNotMatch(dom.els.installHelp.innerHTML, /ihCopy|<code/);
    assert.match(dom.els.installHelp.innerHTML, /Add to Home Screen/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
