'use strict';
/**
 * `copyToClipboard` (web/js/util.js): the device rail's "no local device"
 * pitch and the Connect-a-device dialog both copy a command with this, and
 * both tell the user whether it worked with a toast built on its return
 * value.
 *
 * Headless Chromium -- every CI run of test/browser-e2e-unit.js, and any
 * real browser without clipboard permission granted -- does not reliably
 * REJECT `navigator.clipboard.writeText`; some builds leave the permission
 * prompt pending forever and the promise never settles either way (#229).
 * `copyToClipboard` must still resolve, so the caller's toast always fires:
 * "Copied" on a genuine success, the execCommand fallback's result
 * otherwise. This exercises that contract directly, with no browser at all.
 *
 * Like web-xss-unit.js and bell-inbox-unit.js, `web/js/util.js` has zero
 * runtime dependencies and is meant to run in a real browser with no build
 * step -- so there is no jsdom here either. The file is read straight off
 * disk, its `import`/`export` syntax stripped, and the result evaluated
 * directly in Node with a fake `navigator` and `document` injected as
 * parameters -- `copyToClipboard` reading those bare identifiers at CALL
 * time, inside that same scope, is what lets the parameters shadow them.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripModuleSyntax } = require('./helpers/web-source');

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

const WEB_ROOT = path.join(__dirname, '..', 'web');
const utilSrc = stripModuleSyntax(fs.readFileSync(path.join(WEB_ROOT, 'js', 'util.js'), 'utf8'));

function load(navigator, document) {
  const mod = { exports: {} };
  const fn = new Function('module', 'navigator', 'document', `
    ${utilSrc}
    module.exports = { copyToClipboard };
  `);
  fn(mod, navigator, document);
  return mod.exports;
}

/** A fake `navigator.clipboard` whose `writeText` behaves on command. */
function fakeNav(behavior) {
  const calls = [];
  return {
    calls,
    clipboard: {
      writeText: (text) => {
        calls.push(text);
        if (behavior === 'resolve') return Promise.resolve();
        if (behavior === 'reject') return Promise.reject(new Error('denied'));
        if (behavior === 'hang') return new Promise(() => {}); // never settles
        throw new Error(`unknown behavior: ${behavior}`);
      },
    },
  };
}

/** A fake `document` standing in for the execCommand textarea fallback. */
function fakeDocument({ execOk = true } = {}) {
  const created = [];
  return {
    created,
    execCommandCalls: [],
    createElement: () => {
      const el = { value: undefined, selected: false, removed: false, select() { el.selected = true; }, remove() { el.removed = true; } };
      created.push(el);
      return el;
    },
    body: { appendChild: (el) => { el.appended = true; } },
    execCommand: (cmd) => {
      // Record, so a test can assert the fallback path was really taken.
      fakeDocument.lastExecCommand = cmd;
      return execOk;
    },
  };
}

(async () => {
  await checkAsync('a successful clipboard write resolves true without touching the execCommand fallback', async () => {
    const nav = fakeNav('resolve');
    const doc = fakeDocument({ execOk: false }); // if this were reached, it would return false
    const ok = await load(nav, doc).copyToClipboard('npx squad-hub start');
    assert.strictEqual(ok, true, 'a resolved clipboard write must report success');
    assert.deepStrictEqual(nav.calls, ['npx squad-hub start']);
    assert.strictEqual(doc.created.length, 0, 'the execCommand fallback textarea must not be created on success');
  });

  await checkAsync('a rejected clipboard write falls back to execCommand and reports its result', async () => {
    const nav = fakeNav('reject');
    const doc = fakeDocument({ execOk: true });
    const ok = await load(nav, doc).copyToClipboard('npx squad-hub start');
    assert.strictEqual(ok, true, 'a successful execCommand fallback must report success');
    assert.strictEqual(doc.created.length, 1, 'the fallback textarea must be created');
    assert.ok(doc.created[0].selected, 'the fallback textarea must be selected before execCommand(copy)');
  });

  await checkAsync('a rejected clipboard write that the fallback also fails reports false, never throws', async () => {
    const nav = fakeNav('reject');
    const doc = fakeDocument({ execOk: false });
    const ok = await load(nav, doc).copyToClipboard('npx squad-hub start');
    assert.strictEqual(ok, false, 'a failed fallback must report failure, not success');
  });

  await checkAsync('a clipboard write that never settles still resolves via the execCommand fallback (#229)', async () => {
    // This is the headless-Chromium shape: writeText neither resolves NOR
    // rejects because the permission prompt it is implicitly waiting on
    // never fires. Without a timeout race this call hangs forever and the
    // caller's toast never appears -- exactly the bug #229 fixed.
    const nav = fakeNav('hang');
    const doc = fakeDocument({ execOk: true });
    const start = Date.now();
    const ok = await load(nav, doc).copyToClipboard('npx squad-hub start');
    const elapsed = Date.now() - start;
    assert.strictEqual(ok, true, 'a hung clipboard write must still resolve through the fallback');
    assert.ok(elapsed < 5000, `copyToClipboard must not wait indefinitely on a hung clipboard write (took ${elapsed}ms)`);
    assert.strictEqual(doc.created.length, 1, 'the fallback textarea must be created once the race times out');
  });

  await checkAsync('a missing clipboard API falls back to execCommand instead of throwing', async () => {
    const doc = fakeDocument({ execOk: true });
    const ok = await load({}, doc).copyToClipboard('npx squad-hub start');
    assert.strictEqual(ok, true, 'no navigator.clipboard at all must still fall back, not throw');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
