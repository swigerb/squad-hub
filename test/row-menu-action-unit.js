'use strict';
/**
 * `onRowMenuAction` (web/js/rowmenu.js, split out of `wiring.js` for #170):
 * what actually happens when a row-menu item is clicked.
 *
 * PR #236 review finding 4: the "Copy link" action wrapped `copyToClipboard`
 * in a `try`/`catch` and always toasted "Link copied", because
 * `copyToClipboard` never throws -- it resolves `true`/`false` instead (see
 * its own doc comment in util.js, and test/copy-clipboard-unit.js). A
 * genuine clipboard failure was reported to the user as a success. The fix
 * reads the boolean return value and toasts honestly either way; this
 * exercises that contract end-to-end through the real `onRowMenuAction`,
 * not just `copyToClipboard` in isolation.
 *
 * Loaded the same way list-controls-unit.js loads app.js's whole dependency
 * graph: `readWebSource()` walks app.js's imports transitively and
 * concatenates every reachable module's stripped source into one eval'd
 * function body, so `onRowMenuAction` (and everything it calls -- `state`,
 * `toast`, `copyToClipboard`, `closeRowMenu`, ...) is the SAME code that
 * ships, not a reimplementation. No jsdom, per the zero-runtime-dependency
 * constraint -- `window`/`document`/`navigator`/`location` are faked by hand
 * and read as bare globals, exactly like web-xss-unit.js's
 * `renderSquadPanel` case.
 */

const assert = require('assert');
const { readWebSource } = require('./helpers/web-source');

let pass = 0; let fail = 0;
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

const src = readWebSource();
const mod = { exports: {} };
new Function('module', 'exports', `${src}
module.exports = { onRowMenuAction, state, closeRowMenu };`)(mod, mod.exports);
const { onRowMenuAction, state, closeRowMenu } = mod.exports;

/** A fake `navigator.clipboard` whose `writeText` behaves on command, same shape as copy-clipboard-unit.js's. */
function fakeNav(behavior) {
  return {
    clipboard: {
      writeText: () => {
        if (behavior === 'resolve') return Promise.resolve();
        if (behavior === 'reject') return Promise.reject(new Error('denied'));
        throw new Error(`unknown behavior: ${behavior}`);
      },
    },
  };
}

/** A fake `document`: the toast element plus the execCommand textarea fallback. */
function fakeDocument({ execOk = true } = {}) {
  const toastEl = { hidden: true, textContent: '' };
  return {
    toastEl,
    getElementById: (id) => (id === 'toast' ? toastEl : { innerHTML: '' }),
    createElement: () => ({ value: undefined, select() {}, remove() {} }),
    body: { appendChild: () => {} },
    execCommand: () => execOk,
  };
}

function session(overrides = {}) {
  return { id: 's1', key: 's1', prompt: 'hello', status: 'ended', ...overrides };
}

function setOverview(sess, device = null) {
  state.overview.groups = [{ device, sessions: [sess] }];
}

(async () => {
  const oldWindow = global.window;
  const oldDocument = global.document;
  const oldNavigator = Object.getOwnPropertyDescriptor(global, 'navigator');
  const oldLocation = Object.getOwnPropertyDescriptor(global, 'location');
  const setNavigator = (v) => Object.defineProperty(global, 'navigator', { value: v, configurable: true });
  const setLocation = (v) => Object.defineProperty(global, 'location', { value: v, configurable: true });

  try {
    global.window = { prompt: () => null, confirm: () => true };
    setLocation({ origin: 'https://hub.example' });

    await checkAsync('copylink toasts "Link copied" on a genuine clipboard success', async () => {
      setNavigator(fakeNav('resolve'));
      const doc = fakeDocument({ execOk: false });
      global.document = doc;
      setOverview(session());
      await onRowMenuAction('s1', 'copylink', null);
      assert.strictEqual(doc.toastEl.hidden, false, 'the toast must be shown');
      assert.strictEqual(doc.toastEl.textContent, 'Link copied');
    });

    await checkAsync(
      'copylink toasts an honest failure, never "Link copied", when the clipboard write really fails (PR #236 finding 4)',
      async () => {
        setNavigator(fakeNav('reject'));
        const doc = fakeDocument({ execOk: false }); // execCommand fallback also fails -> copyToClipboard resolves false
        global.document = doc;
        setOverview(session());
        await onRowMenuAction('s1', 'copylink', null);
        assert.strictEqual(doc.toastEl.hidden, false, 'the toast must still be shown');
        assert.notStrictEqual(
          doc.toastEl.textContent,
          'Link copied',
          'a failed copy was toasted as a success -- this is PR #236 review finding 4',
        );
        assert.strictEqual(doc.toastEl.textContent, 'Could not copy the link');
      },
    );

    await checkAsync('copylink toasts success when the clipboard promise rejects but the execCommand fallback succeeds', async () => {
      setNavigator(fakeNav('reject'));
      const doc = fakeDocument({ execOk: true });
      global.document = doc;
      setOverview(session());
      await onRowMenuAction('s1', 'copylink', null);
      assert.strictEqual(doc.toastEl.textContent, 'Link copied');
    });
  } finally {
    if (oldWindow === undefined) delete global.window; else global.window = oldWindow;
    if (oldDocument === undefined) delete global.document; else global.document = oldDocument;
    if (oldNavigator) Object.defineProperty(global, 'navigator', oldNavigator); else delete global.navigator;
    if (oldLocation) Object.defineProperty(global, 'location', oldLocation); else delete global.location;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
