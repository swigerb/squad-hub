'use strict';
/**
 * S6: composer and approval depth.
 *
 * An approval card that says only "the agent wants to run a tool" makes every
 * decision look the same. Reading a file and rewriting a directory are not the
 * same decision, and a standing permission that does not say what it makes
 * standing is a blank cheque.
 *
 * Proven through `web/app.js`'s DOM-free prefix, like the other web suites.
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
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}
const mod = { exports: {} };
new Function('module', 'exports', `${src.slice(0, idx)}
module.exports = { esc, approvalRows, approvalIsReadOnly, approvalOptions, alwaysAllowRule,
  spawnRequest, spawnError };`)(mod, mod.exports);
const {
  esc, approvalRows, approvalIsReadOnly, approvalOptions, alwaysAllowRule,
  spawnRequest, spawnError,
} = mod.exports;

const ONCE = { optionId: 'allow_once', kind: 'allow_once', name: null };
const ALWAYS = { optionId: 'allow_always', kind: 'allow_always', name: null };
const DENY = { optionId: 'reject_once', kind: 'reject_once', name: null };

// ---------------------------------------------------------------------------
// What the approval touches
// ---------------------------------------------------------------------------

check('the tool itself is the first row', () => {
  const rows = approvalRows({ command: 'rm -rf build', paths: [], readOnly: false });
  assert.strictEqual(rows[0].kind, 'tool');
  assert.strictEqual(rows[0].label, 'rm -rf build');
});

check('every path it named gets its own row', () => {
  const rows = approvalRows({ command: 'cat', paths: ['/a/one', '/a/two'], readOnly: true });
  assert.deepStrictEqual(rows.map((r) => r.label), ['cat', '/a/one', '/a/two']);
});

check('a read-only approval marks every row read-only', () => {
  const rows = approvalRows({ command: 'grep', paths: ['/src'], readOnly: true });
  assert.ok(rows.every((r) => r.readOnly), 'a read badge is the single fact that most changes the answer');
});

check('a writing approval marks every row as writing', () => {
  const rows = approvalRows({ command: 'sed -i', paths: ['/src'], readOnly: false });
  assert.ok(rows.every((r) => !r.readOnly));
});

check('an approval with no command still names something', () => {
  const rows = approvalRows({ title: 'Edit file', paths: [], readOnly: false });
  assert.strictEqual(rows[0].label, 'Edit file');
});

check('an approval with neither command nor title says so, rather than showing blank', () => {
  const rows = approvalRows({ paths: [], readOnly: false });
  assert.strictEqual(rows[0].label, 'an unnamed tool',
    'a blank row reads as a rendering bug rather than as missing information');
});

check('no approval at all produces no rows, and does not throw', () => {
  assert.deepStrictEqual(approvalRows(null), []);
  assert.deepStrictEqual(approvalRows(undefined), []);
});

check('a read-only approval is recognised as read-only', () => {
  assert.strictEqual(approvalIsReadOnly({ command: 'cat', paths: ['/a'], readOnly: true }), true);
});

check('an empty approval is NOT treated as read-only', () => {
  assert.strictEqual(approvalIsReadOnly(null), false,
    '"nothing to show" must never soften into "safe"');
  assert.strictEqual(approvalIsReadOnly({ paths: [] }), false);
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

check('the options offered are exactly the ones the agent offered', () => {
  const opts = approvalOptions({ options: [ONCE, DENY] });
  assert.deepStrictEqual(opts.map((o) => o.optionId), ['allow_once', 'reject_once']);
});

check('Always allow is NEVER invented when the agent did not offer it', () => {
  const opts = approvalOptions({ options: [ONCE, DENY] });
  assert.ok(!opts.some((o) => o.standing),
    'the daemon refuses an option the agent did not offer, so the button could only ever produce an error');
});

check('Always allow is offered when the agent DID offer it', () => {
  const opts = approvalOptions({ options: [ONCE, ALWAYS, DENY] });
  const standing = opts.find((o) => o.standing);
  assert.ok(standing);
  assert.strictEqual(standing.label, 'Always allow');
});

check('the agent\'s own wording wins over the built-in label', () => {
  const opts = approvalOptions({ options: [{ optionId: 'allow_once', name: 'Yes, just this once' }] });
  assert.strictEqual(opts[0].label, 'Yes, just this once');
});

check('an option nobody has a label for is still shown, by its id', () => {
  const opts = approvalOptions({ options: [{ optionId: 'some_new_option' }] });
  assert.strictEqual(opts[0].label, 'some_new_option',
    'dropping an option the agent offered removes an answer the person is allowed to give');
});

check('Deny is marked as the dangerous one', () => {
  const opts = approvalOptions({ options: [ONCE, DENY] });
  assert.strictEqual(opts.find((o) => o.optionId === 'reject_once').danger, true);
  assert.strictEqual(opts.find((o) => o.optionId === 'allow_once').danger, false);
});

check('an approval with no options produces no buttons, and does not throw', () => {
  assert.deepStrictEqual(approvalOptions(null), []);
  assert.deepStrictEqual(approvalOptions({}), []);
});

// ---------------------------------------------------------------------------
// The standing rule
// ---------------------------------------------------------------------------

check('the standing rule says exactly what would become standing', () => {
  const rule = alwaysAllowRule({ command: 'npm test', options: [ONCE, ALWAYS] });
  assert.match(rule, /npm test/,
    'a permission button that does not say what it makes standing is a blank cheque');
  assert.match(rule, /without asking again/);
});

check('no rule is shown when the agent offered no standing option', () => {
  assert.strictEqual(alwaysAllowRule({ command: 'npm test', options: [ONCE, DENY] }), null,
    'describing a decision nobody can take is worse than saying nothing');
});

check('a standing rule with nothing to name still explains itself', () => {
  const rule = alwaysAllowRule({ options: [ALWAYS] });
  assert.ok(rule && rule.length > 0);
  assert.ok(!rule.includes('""'), 'an empty quoted subject reads as a bug');
});

check('no approval at all yields no rule', () => {
  assert.strictEqual(alwaysAllowRule(null), null);
});

// ---------------------------------------------------------------------------
// The new-session composer: agent and model
// ---------------------------------------------------------------------------

check('a blank agent is OMITTED, not sent as an empty string', () => {
  const body = spawnRequest({ prompt: 'do it', agent: '', model: '   ' });
  assert.deepStrictEqual(body, { prompt: 'do it' },
    'an empty value would override the project\'s own choice with nothing at all');
});

check('a named agent and model are sent', () => {
  const body = spawnRequest({ prompt: 'do it', agent: 'squad', model: 'claude-opus-4.8' });
  assert.strictEqual(body.agent, 'squad');
  assert.strictEqual(body.model, 'claude-opus-4.8');
});

check('surrounding whitespace never reaches the device', () => {
  const body = spawnRequest({ prompt: '  do it  ', cwd: '  /work  ', agent: ' squad ', model: ' m ' });
  assert.deepStrictEqual(body, { prompt: 'do it', cwd: '/work', agent: 'squad', model: 'm' },
    'a pasted value with a trailing space would be a different agent name to the daemon');
});

check('a blank working directory is omitted, leaving the daemon\'s default', () => {
  const body = spawnRequest({ prompt: 'do it', cwd: '' });
  assert.ok(!('cwd' in body));
});

check('a missing prompt is refused with a reason a person can act on', () => {
  const err = spawnError(spawnRequest({ prompt: '   ' }));
  assert.ok(err);
  assert.match(err, /prompt is required/);
  assert.match(err, /say what the agent should do/, 'the fix belongs in the message');
});

check('a request with a prompt is accepted', () => {
  assert.strictEqual(spawnError(spawnRequest({ prompt: 'go' })), null);
});

check('spawnRequest survives being handed nothing', () => {
  assert.deepStrictEqual(spawnRequest(), { prompt: '' });
  assert.ok(spawnError(spawnRequest()));
});

// ---------------------------------------------------------------------------
// The markup this feeds
// ---------------------------------------------------------------------------

check('the approval card has somewhere to put the standing rule', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(html, /id="apRule"/,
    'the rule is computed and then has nowhere to go, which is the same as not computing it');
});

check('the new-session dialog offers an agent and a model', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(html, /id="nsAgent"/);
  assert.match(html, /id="nsModel"/);
});

check('a malicious tool name or path renders as inert escaped text', () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const rows = approvalRows({ command: XSS, paths: [XSS], readOnly: false });
  // The rows are data; escaping happens where they are rendered. Prove the
  // escaper handles them, since this is agent-supplied text reaching the DOM.
  for (const r of rows) {
    assert.ok(!esc(r.label).includes('<img'), 'a tool name or path could reach the DOM as live markup');
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
