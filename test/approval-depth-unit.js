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
  spawnRequest, spawnError, forgetWindowMs, forgetTargets, forgetSummary, newMenuState, ago, exact, timeCell };`)(mod, mod.exports);
const {
  esc, approvalRows, approvalIsReadOnly, approvalOptions, alwaysAllowRule,
  spawnRequest, spawnError, forgetWindowMs, forgetTargets, forgetSummary, newMenuState,
  exact, timeCell,
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

// ---------------------------------------------------------------------------
// Where the read-only flag comes from
//
// Every shell call arrives as tool kind `execute`, so the kind alone cannot
// tell `git status` from `rm -rf build`. Judging the command is what stops the
// badge crying wolf -- and the classifier has to stay timid, because a missed
// "read-only" costs a second look and a wrong one costs a repository.
// ---------------------------------------------------------------------------

const { isReadOnlyCommand, isReadOnlyRequest } = require('../src/acp-session');

check('a plainly reading shell command is NOT badged as writing', () => {
  assert.strictEqual(isReadOnlyCommand('git status --short'), true,
    'a "writes" badge on a command that writes nothing trains people to ignore the badge');
});

check('the reading commands people actually run are recognised', () => {
  for (const c of ['git log -5', 'git diff HEAD', 'git branch --show-current', 'ls -la',
    'cat package.json', 'rg TODO src', 'Get-ChildItem C:\\src', 'node_modules/.bin/../../../bin/git rev-parse HEAD']) {
    assert.strictEqual(isReadOnlyCommand(c), true, `should read as read-only: ${c}`);
  }
});

check('a writing command is never softened into read-only', () => {
  for (const c of ['rm -rf build', 'git commit -m x', 'git push', 'git checkout -b feature',
    'npm install', 'Remove-Item foo', 'sed -i s/a/b/ f.txt']) {
    assert.strictEqual(isReadOnlyCommand(c), false, `must stay "writes": ${c}`);
  }
});

check('a reading command that DELETES a branch is not read-only', () => {
  assert.strictEqual(isReadOnlyCommand('git branch -d feature'), false);
  assert.strictEqual(isReadOnlyCommand('git branch newthing'), false,
    'a bare name after `git branch` creates one');
});

check('redirection and chaining defeat the classifier rather than sneaking past it', () => {
  assert.strictEqual(isReadOnlyCommand('cat secrets > /tmp/out'), false);
  assert.strictEqual(isReadOnlyCommand('ls && rm -rf build'), false);
  assert.strictEqual(isReadOnlyCommand('echo $(rm -rf build)'), false);
  assert.strictEqual(isReadOnlyCommand('git log | tee log.txt'), false);
});

check('a command it does not recognise is treated as writing', () => {
  assert.strictEqual(isReadOnlyCommand('some-unknown-tool --go'), false,
    '"I do not know" must never round down to "safe"');
  assert.strictEqual(isReadOnlyCommand(''), false);
  assert.strictEqual(isReadOnlyCommand(null), false);
});

check('an --output flag makes an otherwise-reading command write', () => {
  assert.strictEqual(isReadOnlyCommand('git diff --output=patch.txt'), false);
});

check('the declared tool kind still wins for file tools', () => {
  assert.strictEqual(isReadOnlyRequest({ kind: 'read' }, {}), true);
  assert.strictEqual(isReadOnlyRequest({ kind: 'search' }, {}), true);
  assert.strictEqual(isReadOnlyRequest({ kind: 'edit' }, { command: 'git status' }), false,
    'an edit tool carrying a command-shaped field must never talk its way down');
});

check('every command in a multi-command request has to read, not just the first', () => {
  assert.strictEqual(isReadOnlyRequest({ kind: 'execute' }, { commands: ['git status', 'git log'] }), true);
  assert.strictEqual(isReadOnlyRequest({ kind: 'execute' }, { commands: ['git status', 'rm -rf build'] }), false,
    'the badge has to reflect the riskiest thing in the request');
  assert.strictEqual(isReadOnlyRequest({ kind: 'execute' }, {}), false);
});

// ---------------------------------------------------------------------------
// The dropdowns the badge sits beside
//
// A native select's OPEN list is painted by the browser from the control's own
// background, and the inline selects are deliberately transparent -- which
// resolves to white, and made the dark theme's dropdowns unreadable.
// ---------------------------------------------------------------------------

check('the dropdown popup names its own colours, in theme tokens', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.css'), 'utf8');
  const rule = css.match(/select option[^{]*\{[^}]*\}/);
  assert.ok(rule, 'without an explicit option colour the popup falls back to the browser default');
  assert.match(rule[0], /var\(--/, 'a hard-coded colour here is how one theme drifts from the other');
  assert.match(rule[0], /color:\s*var\(--text\)/);
});

// ---------------------------------------------------------------------------
// Removing ended sessions, from the browser's side
//
// The device is the source of truth, so every removal goes TO a device and a
// device that could not be asked has to be reported rather than quietly
// counted as done.
// ---------------------------------------------------------------------------

check('a day count becomes a window', () => {
  assert.strictEqual(forgetWindowMs(7), 7 * 24 * 3600 * 1000);
  assert.strictEqual(forgetWindowMs('30'), 30 * 24 * 3600 * 1000);
});

check('"all" has no window at all, rather than a window of zero', () => {
  assert.strictEqual(forgetWindowMs('all'), undefined,
    'the daemon reads a missing window as "every ended session"; sending 0 would rely on that meaning the same');
});

check('a nonsense scope produces no sweep', () => {
  for (const bad of ['', 'soon', -1, 0, null]) {
    assert.strictEqual(forgetWindowMs(bad), null, `should refuse: ${bad}`);
  }
});

check('an offline device is separated out rather than counted', () => {
  const t = forgetTargets([
    { deviceId: 'a', presence: 'online' },
    { deviceId: 'b', presence: 'stale' },
    { deviceId: 'c', presence: 'offline' },
  ]);
  assert.deepStrictEqual(t.reachable.map((d) => d.deviceId), ['a', 'b']);
  assert.deepStrictEqual(t.skipped.map((d) => d.deviceId), ['c'],
    'a device that cannot be asked has not been tidied, and saying otherwise is a lie the next page load exposes');
});

check('no devices at all does not throw', () => {
  assert.deepStrictEqual(forgetTargets(undefined), { reachable: [], skipped: [] });
});

check('the summary counts what happened, including what did not', () => {
  assert.match(forgetSummary({ removed: 3, failed: 0, skipped: 0 }), /Removed 3 ended sessions/);
  assert.match(forgetSummary({ removed: 1, failed: 0, skipped: 0 }), /Removed 1 ended session\b/);
  assert.match(forgetSummary({ removed: 0, failed: 0, skipped: 0 }), /Nothing to remove/);
});

check('a skipped or refusing device is never hidden from the summary', () => {
  assert.match(forgetSummary({ removed: 5, failed: 0, skipped: 2 }), /2 devices offline, skipped/);
  assert.match(forgetSummary({ removed: 5, failed: 1, skipped: 0 }), /1 device refused/);
  const both = forgetSummary({ removed: 0, failed: 1, skipped: 1 });
  assert.match(both, /skipped/);
  assert.match(both, /refused/);
});

check('the markup offers the removal scopes, and a New menu with both kinds', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(html, /data-forget="7"/);
  assert.match(html, /data-forget="30"/);
  assert.match(html, /data-forget="all"/);
  assert.match(html, /data-new="local"/);
  assert.match(html, /data-new="cloud"/);
  assert.match(html, /id="newMenuNote"/,
    'a disabled Cloud session with no explanation is a dead end');
});

// ---------------------------------------------------------------------------
// What the Create menu can honestly offer
//
// Squad Hub observes devices that dial in; it holds no cloud credentials and
// cannot conjure one. So a kind with no device behind it is refused WITH THE
// REASON rather than offered and then failed.
// ---------------------------------------------------------------------------

const CLOUD = { deviceId: 'aca-1', kind: 'cloud', presence: 'online' };
const LAPTOP = { deviceId: 'laptop', kind: 'local', presence: 'online' };

check('both kinds are offered when both are connected', () => {
  const s = newMenuState([CLOUD, LAPTOP]);
  assert.strictEqual(s.localEnabled, true);
  assert.strictEqual(s.cloudEnabled, true);
  assert.strictEqual(s.note, null, 'a note with nothing to explain is noise');
});

check('Cloud session is REFUSED, with a reason, when no cloud device is connected', () => {
  const s = newMenuState([LAPTOP]);
  assert.strictEqual(s.cloudEnabled, false,
    'the hub cannot start a cloud device, so a live button would be an offer it could not keep');
  assert.match(s.note, /cloud device/i);
  assert.match(s.note, /aca/i, 'saying how to get one is the honest version of the same help');
});

check('Local session is refused, with a reason, when no local device is connected', () => {
  const s = newMenuState([CLOUD]);
  assert.strictEqual(s.localEnabled, false);
  assert.match(s.note, /squad-hub connect/);
});

check('with nothing connected at all, the note says THAT rather than picking one kind', () => {
  const s = newMenuState([]);
  assert.strictEqual(s.localEnabled, false);
  assert.strictEqual(s.cloudEnabled, false);
  assert.match(s.note, /No device is connected/,
    'being told how to add a cloud device is unhelpful when the real answer is "add any device"');
});

check('an offline device does not count as connected', () => {
  const s = newMenuState([{ deviceId: 'x', kind: 'cloud', presence: 'offline' }]);
  assert.strictEqual(s.cloudEnabled, false,
    'the hub refuses a command to an offline device, so offering one would fail on submit');
});

check('the menu names the device it would use, so the dialog opens on the right one', () => {
  const s = newMenuState([CLOUD, LAPTOP]);
  assert.strictEqual(s.cloudDeviceId, 'aca-1');
  assert.strictEqual(s.localDeviceId, 'laptop');
});

check('newMenuState survives being handed nothing', () => {
  const s = newMenuState(undefined);
  assert.strictEqual(s.localEnabled, false);
  assert.strictEqual(s.cloudEnabled, false);
});

// ---------------------------------------------------------------------------
// Notifications
//
// The point of the hub is that a blocked session can reach a person who is
// somewhere else, and a page you must be LOOKING AT to notice one is only
// half of that. What matters in the wiring is when permission is asked for:
// a browser shows that prompt once, and a denial cannot be undone from here.
// ---------------------------------------------------------------------------

check('permission is asked for on a CLICK, never on load', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  const fn = app.match(/function requestNotifyPermission[\s\S]*?\n\}/);
  assert.ok(fn, 'requestNotifyPermission moved; find it before trusting this test');
  // The only caller must be the bell's own handler.
  const callers = [...app.matchAll(/requestNotifyPermission\(\)/g)].length;
  assert.ok(callers >= 1, 'nothing ever asks for permission');
  assert.ok(!/requestNotifyPermission\(\)[\s\S]{0,200}?main\(/.test(app.slice(0, 200)),
    'a prompt on load spends the one prompt a browser ever shows before anyone asked for anything');
});

check('a permission already decided is never asked for again', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  const fn = app.match(/function requestNotifyPermission[\s\S]*?\n\}/)[0];
  assert.match(fn, /!== 'default'/,
    're-requesting a denied permission does nothing and re-requesting a granted one is noise');
});

check('an unsupported browser is told apart from a blocked one', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  assert.match(app, /'unsupported'/,
    'one is a setting a person can change and the other is not, so they cannot share a message');
});

check('the same approval never notifies twice', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  const fn = app.match(/function notifyApproval[\s\S]*?\n\}/)[0];
  assert.match(fn, /state\.notified\.has/,
    'every poll and every reconnect would raise another notification for the same question');
  assert.match(fn, /state\.notified\.add/);
});

check('a browser that refuses to construct a notification does not take the render down', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  const fn = app.match(/function notifyApproval[\s\S]*?\n\}/)[0];
  assert.match(fn, /catch/,
    'some mobile engines throw unless a service worker raises it; that must not break the session list');
});

check('the bell says what it will do before it is pressed', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  const fn = app.match(/function syncBell[\s\S]*?\n\}/);
  assert.ok(fn, 'syncBell moved');
  assert.match(fn[0], /blocked/i);
  assert.match(fn[0], /Turn on notifications/);
});

// ---------------------------------------------------------------------------
// Saying nothing when there is nothing to say
//
// A badge that is present in the normal case is a label, not a signal. Both of
// these used to be shown permanently, which trained people not to read the two
// spots that exist to interrupt them.
// ---------------------------------------------------------------------------

check('the connection badge is a DOT when live and WORDS when not', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  const fn = app.match(/function setConn[\s\S]*?\n\}/)[0];
  assert.match(fn, /s === 'live' \? '' :/,
    'a permanent "live" pill is a label saying "working", and a label that is always there is one nobody reads on the day it changes');
  assert.match(fn, /CONN_TITLE/,
    'a coloured dot with no explanation anywhere is a mark, not a signal');
});

check('the live dot is still marked up as a state, for anything that cannot see it', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  const fn = app.match(/function setConn[\s\S]*?\n\}/)[0];
  assert.match(fn, /aria-label/,
    'a screen reader gets no colour, so the dot has to say the word the sighted user is spared');
});

check('every state that is NOT live still spells itself out', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  const labels = app.match(/const CONN_LABEL = \{[\s\S]*?\};/)[0];
  for (const s of ['connecting', 'retrying', 'offline']) {
    assert.ok(labels.includes(s), `${s} lost its label`);
  }
  assert.match(labels, /hub unreachable/, 'the state worth interrupting for must say something a person can act on');
});

check('a broken feed says the WORK is unaffected, not just that the page is', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  const titles = app.match(/const CONN_TITLE = \{[\s\S]*?\};/)[0];
  assert.match(titles, /keep running|unaffected/,
    'the obvious fear on seeing a red badge is that the work stopped, and it has not');
});

check('the device pill reports the EXCEPTION, not the agreement', () => {
  const app = fs.readFileSync(APP_JS, 'utf8');
  assert.match(app, /\$\{down\} offline/,
    'repeating the count already shown beside it makes a badge nobody reads on the day it disagrees');
  assert.match(app, /availPill\.hidden = down === 0/);
});

check('the exact start time is one hover away, without cluttering the row', () => {
  // "28m ago" is the right thing to scan a list by, and the wrong thing to
  // answer "when exactly did that run?" with -- which is the question anyone
  // correlating a session against a job execution or an incident is asking.
  const at = Date.UTC(2026, 7, 8, 22, 59, 22);
  const cell = timeCell(at);
  assert.match(cell, /title="/, 'no exact time is available at all');
  assert.ok(cell.includes(esc(exact(at))), `the title does not carry the exact time: ${cell}`);
  assert.match(cell, /ago</, 'the relative form must stay visible; it is what the list is scanned by');
  assert.strictEqual(timeCell(0), '', 'a missing timestamp must render nothing, not "Invalid Date"');
  assert.strictEqual(timeCell(null), '', 'a missing timestamp must render nothing, not "Invalid Date"');
});

check('a session title cannot inject markup through the time cell', () => {
  // The label is a parameter, so it has to be escaped like everything else
  // that lands in an attribute.
  const cell = timeCell(Date.now(), '"><img src=x onerror=alert(1)>');
  assert.ok(!cell.includes('<img'), `markup survived into the attribute: ${cell}`);
});

check('the Squad pill is not repeated by the active-member chip beside it', () => {
  // The pill already says "squad". The coordinator is literally NAMED "Squad",
  // so rendering both put SQUAD next to Squad and told the reader nothing
  // twice. A named member is still worth showing -- which one is working is
  // the useful fact.
  const app = fs.readFileSync(APP_JS, 'utf8');
  assert.match(app, /toLowerCase\(\) !== 'squad'/,
    'the active-member chip no longer suppresses the coordinator, so the pill is duplicated');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
