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
const fs = require('fs');
const path = require('path');

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

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const MARKER = '(async function main()';
const idx = src.indexOf(MARKER);
if (idx < 0) {
  console.log(`  FAIL could not find the "${MARKER}" extraction anchor in web/app.js -- it moved`);
  console.log('RESULT\tfail\tweb/app.js extraction anchor is present\tanchor not found');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

// `navigator` is a parameter, so it shadows the (absent) global for the whole
// prefix -- no globals are mutated and nothing leaks between cases.
function stepsFor(ua, maxTouchPoints = 0) {
  return load({ userAgent: ua, maxTouchPoints }).installSteps();
}

function load(navigator) {
  const mod = { exports: {} };
  const fn = new Function(
    'module', 'navigator',
    `${src.slice(0, idx)}\nmodule.exports = { installSteps, isInstalled };`,
  );
  fn(mod, navigator);
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
  const r = stepsFor(UA.windows);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
