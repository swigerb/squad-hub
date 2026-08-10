'use strict';
/**
 * Stored XSS (Opus review, HIGH): `.squad-hub.json` agent/model -> a
 * session's `agentSelection` -> the hub -> `web/app.js`'s `sessionRow`.
 *
 * `sessionRow` used to interpolate `agentSelection.agent/model/source` (and
 * the device name / cwd / squad project in the same `meta` line) straight
 * into an HTML string with no escaping, so a project config carrying an
 * `agent` of `<img src=x onerror=...>` would render as a LIVE element in
 * every browser viewing that session, not as text.
 *
 * `web/app.js` has zero runtime dependencies and is meant to run in a real
 * browser with no build step -- so there is no jsdom here either. Instead,
 * the file's pure, DOM-free prefix (everything before the `main()` IIFE,
 * which is the only place `document` is ever touched) is sliced out and
 * evaluated directly in Node. `esc`, `ago`, `statusBadge`, and `sessionRow`
 * never reference `document`/`window` themselves -- they only build and
 * return strings -- so this is not a workaround, it is proof of exactly
 * that property.
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

const APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');
const MARKER = '(async function main()';
const idx = src.indexOf(MARKER);
if (idx < 0) {
  console.log(`  FAIL could not find the "${MARKER}" extraction anchor in web/app.js -- it moved`);
  console.log('RESULT\tfail\tweb/app.js extraction anchor is present\tanchor not found');
  console.log(`\n0 passed, 1 failed`);
  process.exit(1);
}
const pureSource = src.slice(0, idx);

// A sandbox with no `document`/`window` at all: if any of this prefix ever
// touched the DOM directly (rather than only inside functions main() calls
// later), this throws immediately instead of silently doing nothing.
const sandboxModule = { exports: {} };
const load = new Function('module', 'exports', `${pureSource}\nmodule.exports = { esc, num, ago, statusBadge, sessionRow, peopleRows };`);
load(sandboxModule, sandboxModule.exports);
const {
  esc, num, sessionRow, peopleRows,
} = sandboxModule.exports;

const XSS = '<img src=x onerror=alert(1)>';

// ---------------------------------------------------------------------------
// Numbers that arrive from a DEVICE
//
// A device token is meant to be able to be a device and nothing else: it cannot
// read the API, and it cannot drive another device. But a device supplies what
// this page renders, so markup arriving where a count belongs would run in the
// OWNER'S browser -- and that browser holds the user token. That would turn
// "can register a device" into "can take the account", which is the one thing
// the device-token design exists to prevent.
// ---------------------------------------------------------------------------

check('a count is coerced to a number, so a device cannot put markup where one belongs', () => {
  assert.strictEqual(num(XSS), 0);
  assert.strictEqual(num('7'), 7);
  assert.strictEqual(num(7.9), 7);
  assert.strictEqual(num(null), 0);
  assert.strictEqual(num(undefined), 0);
  assert.strictEqual(num({}), 0);
  assert.strictEqual(num(Infinity), 0);
  assert.strictEqual(num(NaN), 0);
});

check('a hostile toolCallCount from a device renders as inert text', () => {
  const html = sessionRow({
    id: 's1', key: 's1', prompt: 'hi', status: 'active', cwd: '/w', toolCallCount: XSS,
  }, 'my-device');
  assert.ok(!html.includes('<img'), `a device injected markup through a count: ${html}`);
});

check('hostile Squad counts from a device render as inert text', () => {
  const html = sessionRow({
    id: 's1',
    key: 's1',
    prompt: 'hi',
    status: 'active',
    cwd: '/w',
    squad: {
      memberCount: XSS, activeMembers: XSS, decisionCount: XSS, members: [], decisions: [],
    },
  }, 'my-device');
  assert.ok(!html.includes('<img'), `a device injected markup through a Squad count: ${html}`);
});

check('a hostile login renders as inert escaped text on the access screen', () => {
  // Of all the screens to get this wrong on, the one listing who may sign in
  // is the worst.
  const html = peopleRows({ users: [{ login: XSS, source: 'added', removable: true }] }, '', '');
  assert.ok(!html.includes('<img'), 'a hostile login survived unescaped into the access list');
  assert.ok(html.includes(esc(XSS)));
});

check('a hostile note and a hostile "added by" render as inert text too', () => {
  const html = peopleRows({
    users: [{
      login: 'someone', source: 'added', removable: true, addedBy: XSS, note: XSS,
    }],
  }, '', '');
  assert.ok(!html.includes('<img'), 'a hostile note or actor survived unescaped');
});

check('a hostile login cannot break out of the remove button attribute', () => {
  const html = peopleRows({
    users: [{ login: '" onclick="alert(1)', source: 'added', removable: true }],
  }, '', '');
  assert.ok(!html.includes('onclick="alert'), `the attribute was broken out of: ${html}`);
});

check('esc() escapes all five HTML-special characters', () => {
  assert.strictEqual(esc(XSS), '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(esc(`"'&`), '&quot;&#39;&amp;');
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
});

check('a malicious agentSelection.agent renders as inert escaped text, never a live <img>', () => {
  const html = sessionRow({
    id: 's1', key: 's1', prompt: 'hello world', status: 'active', cwd: '/work',
    agentSelection: { agent: XSS, model: 'gpt-fake', source: 'project config' },
  }, 'my-device');
  assert.ok(!html.includes('<img'), 'the raw <img> tag survived unescaped into the rendered HTML');
  assert.ok(html.includes(esc(XSS)), 'the escaped form of the payload is missing entirely -- was it dropped, not escaped?');
});

check('a malicious agentSelection.model renders as inert escaped text', () => {
  const html = sessionRow({
    id: 's2', key: 's2', prompt: 'hello world', status: 'active', cwd: '/work',
    agentSelection: { agent: 'squad', model: XSS, source: 'project config' },
  }, 'my-device');
  assert.ok(!html.includes('<img'), 'a malicious model value survived unescaped');
  assert.ok(html.includes(esc(XSS)));
});

check('a malicious agentSelection.source renders as inert escaped text', () => {
  const html = sessionRow({
    id: 's3', key: 's3', prompt: 'hello world', status: 'active', cwd: '/work',
    agentSelection: { agent: 'squad', model: 'gpt-fake', source: XSS },
  }, 'my-device');
  assert.ok(!html.includes('<img'), 'a malicious source value survived unescaped');
  assert.ok(html.includes(esc(XSS)));
});

check('a malicious s.agent fallback (no agentSelection at all) also renders as inert text', () => {
  const html = sessionRow({
    id: 's4', key: 's4', prompt: 'hello world', status: 'active', cwd: '/work', agent: XSS,
  }, 'my-device');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes(esc(XSS)));
});

check('a malicious device name, cwd, and squad project (same meta line) also render as inert text', () => {
  const html = sessionRow({
    id: 's5', key: 's5', prompt: 'hello world', status: 'active', cwd: XSS,
    squad: { project: XSS, activeMembers: 1, memberCount: 1 },
  }, XSS);
  assert.ok(!html.includes('<img'), 'device name / cwd / squad project let a live tag through');
});

check('a legitimate agent/model/source selection still renders normally, unaffected by escaping', () => {
  const html = sessionRow({
    id: 's6', key: 's6', prompt: 'a perfectly normal prompt', status: 'active', cwd: '/work',
    agentSelection: { agent: 'squad', model: 'claude-opus-4.8', source: 'project' },
  }, 'my-device');
  assert.ok(html.includes('squad'));
  assert.ok(html.includes('claude-opus-4.8'));
  assert.ok(html.includes('project'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
