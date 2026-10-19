'use strict';
/**
 * The hub's own version in the web UI (#271): "Squad Hub v<version>", linked to
 * that release, and nothing at all until the overview has reported a version.
 *
 * The module is loaded the way the browser runs it (real util.js `esc`, real
 * hub-version.js), and the wiring is checked by driving a stand-in element, so
 * a deleted call site fails here rather than only in the browser suite.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

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

const escSource = /export const esc = [\s\S]*?\}\[c\]\)\);/.exec(read('js/util.js'))[0].replace('export ', '');
const moduleSource = read('js/hub-version.js')
  .replace(/^import .*$/m, '')
  .replace(/^export /gm, '');
const { hubVersionHtml, renderHubVersion } = new Function(`${escSource}\n${moduleSource}\nreturn { hubVersionHtml, renderHubVersion };`)();

const REL = 'https://github.com/swigerb/squad-hub/releases/tag/';

check('a known version renders "Squad Hub v<version>" linking its release', () => {
  const html = hubVersionHtml('0.7.2');
  assert.ok(html.includes('>Squad Hub v0.7.2</a>'), html);
  assert.ok(html.includes(`href="${REL}v0.7.2"`), html);
  assert.ok(/rel="noopener noreferrer"/.test(html) && /target="_blank"/.test(html), html);
});

check('an unknown version renders nothing: no placeholder, no empty link', () => {
  for (const v of [undefined, null, '']) {
    assert.strictEqual(hubVersionHtml(v), '', `rendered something for ${JSON.stringify(v)}`);
  }
});

check('the version is escaped in the text and encoded in the link target', () => {
  const html = hubVersionHtml('1.0"><img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'), `markup survived: ${html}`);
  assert.ok(html.includes('v1.0&quot;&gt;&lt;img'), `text not escaped: ${html}`);
  assert.ok(html.includes(`href="${REL}v1.0%22%3E%3Cimg`), `target not encoded: ${html}`);
  assert.ok(!/href="[^"]*[<>]/.test(html), 'a raw angle bracket reached the href');
});

check('renderHubVersion fills the footer and hides it again when the version is unknown', () => {
  const el = { innerHTML: '', hidden: true };
  renderHubVersion(el, '0.7.2');
  assert.strictEqual(el.hidden, false);
  assert.ok(el.innerHTML.includes('Squad Hub v0.7.2'));
  renderHubVersion(el, null);
  assert.strictEqual(el.hidden, true, 'the footer stayed visible with no version');
  assert.strictEqual(el.innerHTML, '', 'a stale version stayed in the footer');
  assert.doesNotThrow(() => renderHubVersion(null, '0.7.2'));
});

check('the rail, the account menu and the page are wired to the module', () => {
  assert.match(read('js/devices.js'), /renderHubVersion\(\$\('hubVersion'\), hubVersion\)/, 'the rail never renders the version');
  assert.match(read('js/wiring.js'), /versionLine \? `\$\{versionLine\}<br>` : ''/, 'the account menu has no conditional version line');
  assert.match(read('index.html'), /id="hubVersion"[^>]*\shidden/, 'the footer mount is missing or visible by default');
  assert.ok(/'\/js\/hub-version\.js'/.test(read('sw.js')), 'the module is not in the service worker shell');
});

check('the footer is quiet: dim 12px text, no box, hidden state really hides', () => {
  const css = read('css/topbar.css');
  assert.match(css, /\.hub-version\s*\{[^}]*color: var\(--dim\)[^}]*font-size: 12px/);
  assert.match(css, /\.hub-version-foot\[hidden\]\s*\{\s*display: none/);
  assert.ok(!/\.hub-version-foot\s*\{[^}]*(border|background)/.test(css), 'the footer grew a box');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
