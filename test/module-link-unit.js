'use strict';
/**
 * Native ES module linking for web/app.js's real, on-disk module graph.
 *
 * Scout's source review of 046b708 (PR #243) found a LIVE browser boot
 * failure that every other unit suite missed: `web/app.js` imported
 * `syncSession` from `./js/detail.js`, but the detail-control split
 * (34256a0) moved `syncSession` out into `./js/detail-control.js` and
 * `detail.js` never re-exported it. `wiring.js` was updated correctly;
 * `app.js` was not. A browser loading `/app.js` as `type="module"` gets:
 *
 *   SyntaxError: The requested module './js/detail.js' does not provide
 *   an export named 'syncSession'
 *
 * Module LINKING happens before a single statement of the module body runs,
 * so this is not a timeout or a flaky approval round-trip to paper over --
 * `main()` in app.js never starts, the page never boots, and every
 * browser-e2e scenario fails identically (run 37901451265: Node 24 reported
 * 2246 passed / 11 failed, including the very first "page actually loads"
 * assertion).
 *
 * `test/helpers/web-source.js`'s `readWebSource()` -- which every DOM-free
 * unit suite in this repo uses to get app.js's dependency graph into Node --
 * STRIPS every `import`/`export` keyword before `new Function`-evaluating
 * the result (see its own `stripModuleSyntax`). That is precisely why this
 * class of bug reached a real CI run with ~2700 other tests green: a helper
 * imported by name but never exported under that name is syntactically
 * fine prose to `new Function`, which only ever sees the stripped body. No
 * amount of calling the moved function directly (detail-control-unit.js
 * already does, correctly) proves the public import graph a BROWSER would
 * actually have to resolve.
 *
 * So this suite does not strip anything. It reads every real file app.js's
 * own `import` statements name, transitively, straight off disk, and links
 * them with Node's native ESM linker (`vm.SourceTextModule`) -- the same
 * algorithm (resolve specifiers, bind named exports, fail on anything
 * missing) a browser's module loader runs BEFORE evaluating a single module
 * body. Nothing is evaluated here -- `.link()` is called, `.evaluate()`
 * never is -- so this never runs the application, opens a socket, or
 * touches the network; it only proves the import graph resolves, exactly
 * as Scout reproduced it independently.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const APP_JS = path.join(WEB_ROOT, 'app.js');

// `vm.SourceTextModule` only exists behind this flag (still true on Node 24).
// `run-tests.js` spawns this file with a bare `node <file>`, so re-exec
// ourselves with the flag added rather than requiring every caller (the full
// suite, `mutate.js`, a developer running this file directly) to know to
// pass it. `stdio: 'inherit'` means the re-exec's RESULT/ok/FAIL lines reach
// run-tests.js exactly as if this process had printed them itself.
if (typeof vm.SourceTextModule !== 'function') {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', __filename], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(r.status === null ? 1 : r.status);
}

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

/**
 * One `vm.SourceTextModule` per real file, keyed and cached by its absolute
 * path -- the same file imported from two different modules (e.g.
 * `detail-control.js`, reached both via `detail.js` and directly from
 * `app.js`) must link to the SAME module instance, exactly as a browser's
 * module map would, or a genuinely-shared singleton (the in-flight sync
 * lock, the selection-generation counter) would silently fork in two.
 */
function makeLinker() {
  const cache = new Map();
  function moduleFor(absPath) {
    let m = cache.get(absPath);
    if (m) return m;
    const source = fs.readFileSync(absPath, 'utf8');
    m = new vm.SourceTextModule(source, { identifier: absPath });
    cache.set(absPath, m);
    return m;
  }
  // eslint-disable-next-line no-unused-vars
  async function linker(specifier, referencingModule) {
    if (!specifier.startsWith('.')) {
      throw new Error(`unexpected non-relative import "${specifier}" -- this graph is expected to be all-relative`);
    }
    const abs = path.resolve(path.dirname(referencingModule.identifier), specifier);
    if (!fs.existsSync(abs)) {
      throw new Error(`"${referencingModule.identifier}" imports "${specifier}", which resolves to ${abs}, which does not exist`);
    }
    return moduleFor(abs);
  }
  return { moduleFor, linker, cache };
}

async function checkAppLinks() {
  const { moduleFor, linker, cache } = makeLinker();
  const entry = moduleFor(APP_JS);
  await entry.link(linker);
  return cache;
}

(async () => {
  await checkAsync(
    'web/app.js and its entire real module graph link under native ES module resolution (no missing or renamed export)',
    async () => {
      const cache = await checkAppLinks();
      // A graph of one file would mean the walk silently failed to descend --
      // app.js alone imports well over a dozen modules under web/js/.
      assert.ok(cache.size > 10, `only linked ${cache.size} module(s) -- app.js's real import graph did not get walked`);
    },
  );

  await checkAsync(
    'the module graph includes web/js/detail-control.js, reached through its real importers',
    async () => {
      const cache = await checkAppLinks();
      const detailControl = path.join(WEB_ROOT, 'js', 'detail-control.js');
      assert.ok(cache.has(detailControl), 'web/js/detail-control.js was never reached while linking app.js');
    },
  );

  check('every relative import in every linked module resolves to a file that actually exists on disk', () => {
    // Redundant with the link failing on a missing file above, but named and
    // asserted on its own so a future reader does not have to infer it from a
    // thrown linker error.
    const IMPORT_FROM = /^import\s+[\s\S]*?\sfrom\s+['"](\..+?)['"];\s*$/gm;
    const files = [APP_JS];
    const seen = new Set();
    const missing = [];
    while (files.length) {
      const f = files.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(IMPORT_FROM)) {
        const abs = path.resolve(path.dirname(f), m[1]);
        if (!fs.existsSync(abs)) missing.push(`${f} -> ${m[1]}`);
        else files.push(abs);
      }
    }
    assert.deepStrictEqual(missing, [], `unresolved relative imports: ${missing.join(', ')}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
