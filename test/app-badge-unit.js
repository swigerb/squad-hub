'use strict';
/**
 * The home-screen app badge (#171, E2.4): a live "needs you" count on the
 * installed icon, without opening the app.
 *
 * `navigator.setAppBadge` is unsupported in most browsers and some reject it
 * entirely depending on page visibility, so every assertion here is really
 * about the same thing `install-prompt-unit.js` checks for its own API: a
 * missing or throwing browser capability must never surface as an error, and
 * a present one must be called with exactly the right arguments.
 *
 * Extraction follows the same pattern as install-prompt-unit.js: `web/js/*.js`
 * are concatenated with import/export syntax stripped (see
 * test/helpers/web-source.js), and evaluated with a fake `navigator` injected
 * as a parameter -- `syncAppBadge` reading the bare `navigator` identifier at
 * CALL time, inside that same scope, is what lets the parameter shadow it.
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

function load(navigator) {
  const mod = { exports: {} };
  const fn = new Function('module', 'navigator', `${src}\nmodule.exports = { syncAppBadge };`);
  fn(mod, navigator);
  return mod.exports;
}

/** A fake `navigator` that records calls instead of touching a real badge. */
function fakeNav({ supported = true, throws = false } = {}) {
  const calls = [];
  const nav = {};
  if (supported) {
    nav.setAppBadge = (n) => { if (throws) throw new Error('rejected'); calls.push(['set', n]); };
    nav.clearAppBadge = () => { if (throws) throw new Error('rejected'); calls.push(['clear']); };
  }
  return { nav, calls };
}

check('a positive count sets the badge to that exact number', () => {
  const { nav, calls } = fakeNav();
  load(nav).syncAppBadge(3);
  assert.deepStrictEqual(calls, [['set', 3]]);
});

check('a count of zero clears the badge, rather than setting it to "0"', () => {
  // A badge reading 0 is still a badge -- the visual difference from "no
  // badge at all" is the entire point of clearing instead of setting here.
  const { nav, calls } = fakeNav();
  load(nav).syncAppBadge(0);
  assert.deepStrictEqual(calls, [['clear']]);
});

check('a browser with no Badging API at all is a silent no-op, not a throw', () => {
  const { nav, calls } = fakeNav({ supported: false });
  load(nav).syncAppBadge(5); // must not throw
  assert.deepStrictEqual(calls, []);
});

check('a browser that rejects the call (backgrounded page) cannot break the render loop', () => {
  const { nav } = fakeNav({ throws: true });
  load(nav).syncAppBadge(2); // must not throw
  load(nav).syncAppBadge(0); // must not throw
});

check('no navigator at all (non-browser eval) is also a silent no-op', () => {
  const mod = { exports: {} };
  const fn = new Function('module', `${src}\nmodule.exports = { syncAppBadge };`);
  fn(mod); // navigator left undefined entirely
  mod.exports.syncAppBadge(1); // must not throw
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
