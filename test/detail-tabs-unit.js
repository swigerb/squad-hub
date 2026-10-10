'use strict';
/**
 * #182: the session detail page's tabs, the inline approval card and the Info
 * tab.
 *
 * Proven against the real web modules through the same DOM-free flattening the
 * other web suites use. The click-through behavior (a real tab switch, a real
 * answer, the history that follows it) is proven in a real browser by
 * browser-e2e-unit.js; this file owns the parts that are pure: which tab a key
 * moves to, what the card and the Info rows say, and what they must NOT say.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', `${readWebSource()}
module.exports = {
  DETAIL_TABS, nextDetailTab, selectDetailTab,
  approvalToolChips, inlineApprovalHtml, approvalChipsHtml, approvalButtonsHtml,
  sessionInfoRows, approvalHistory, approvalHistoryHtml, squadHealthView, infoLinks, safeHttpUrl,
};`)(mod, mod.exports);
const {
  DETAIL_TABS, nextDetailTab, selectDetailTab,
  approvalToolChips, inlineApprovalHtml, approvalChipsHtml, approvalButtonsHtml,
  sessionInfoRows, approvalHistory, approvalHistoryHtml, squadHealthView, infoLinks, safeHttpUrl,
} = mod.exports;

const NOW = Date.now();
const ONCE = { optionId: 'allow_once', kind: 'allow_once', name: null };
const ALWAYS = { optionId: 'allow_always', kind: 'allow_always', name: null };
const DENY = { optionId: 'reject_once', kind: 'reject_once', name: null };

const approval = (over = {}) => ({
  approvalId: 'ap-1',
  title: 'Create marker file',
  kind: 'execute',
  command: 'echo ran > marker.txt',
  commands: ['echo ran > marker.txt'],
  paths: ['C:\\work\\app\\marker.txt'],
  readOnly: false,
  options: [ONCE, ALWAYS, DENY],
  requestedAt: NOW - 120000,
  ...over,
});

const device = (over = {}) => ({
  deviceId: 'dev-1', name: 'build-box', kind: 'local', platform: 'win32', presence: 'online', ...over,
});

const session = (over = {}) => ({
  key: 'dev-1:s-1',
  id: 's-1',
  cwd: 'C:\\work\\app',
  startedAt: NOW - 3600000,
  lastActivityAt: NOW - 60000,
  toolCallCount: 7,
  agent: 'Copilot CLI',
  applied: { agent: 'Squad', model: 'claude-sonnet-5', mode: 'autopilot' },
  git: { repository: 'octo/app', branch: 'feature/x', host: 'github.com' },
  ...over,
});

const rowHtml = (rows, key) => (rows.find((r) => r.key === key) || {}).html;
const allHtml = (rows) => rows.map((r) => `${r.label} ${r.html}`).join('\n');

// ---------------------------------------------------------------------------
// The tabs
// ---------------------------------------------------------------------------

check('the tab keys wrap around the three real tabs and never land on Files', () => {
  assert.strictEqual(nextDetailTab('chat', 'ArrowRight'), 'squad');
  assert.strictEqual(nextDetailTab('info', 'ArrowRight'), 'chat', 'ArrowRight wraps from the last tab to the first');
  assert.strictEqual(nextDetailTab('chat', 'ArrowLeft'), 'info', 'ArrowLeft wraps from the first tab to the last');
  assert.strictEqual(nextDetailTab('squad', 'ArrowLeft'), 'chat');
  assert.strictEqual(nextDetailTab('squad', 'Home'), 'chat');
  assert.strictEqual(nextDetailTab('chat', 'End'), 'info');
  assert.strictEqual(nextDetailTab('squad', 'x'), 'squad', 'an unrelated key leaves the selection alone');
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    for (const t of DETAIL_TABS) assert.notStrictEqual(nextDetailTab(t, key), 'files');
  }
});

check('Files is never a selectable tab', () => {
  assert.deepStrictEqual(DETAIL_TABS, ['chat', 'squad', 'info']);
  assert.strictEqual(selectDetailTab('files'), false, 'selecting Files must be refused before it touches the page');
  assert.strictEqual(selectDetailTab('nonsense'), false);
});

// ---------------------------------------------------------------------------
// The inline approval card
// ---------------------------------------------------------------------------

check('tool chips name every program in a compound command once, from reported data only', () => {
  assert.deepStrictEqual(
    approvalToolChips({ kind: 'execute', commands: ['git status && npm test | tee out.txt', 'git log'] }),
    ['execute', 'git', 'npm', 'tee'],
  );
  assert.deepStrictEqual(approvalToolChips({ kind: 'read', commands: [] }), ['read']);
  assert.deepStrictEqual(approvalToolChips({ title: 'Edit file' }), [], 'nothing is guessed from the title');
  assert.deepStrictEqual(approvalToolChips(null), []);
  const many = approvalToolChips({ commands: Array.from({ length: 20 }, (_, i) => `tool${i} arg`) });
  assert.ok(many.length <= 8, 'a runaway command list cannot flood the card with chips');
});

check('the inline card shows the command, tool chips, read-only badges, paths and the offered buttons', () => {
  const html = inlineApprovalHtml(approval());
  assert.ok(html.includes('data-approval="ap-1"'));
  assert.ok(html.includes('echo ran &gt; marker.txt'), 'the command is shown (escaped)');
  assert.ok(html.includes('class="dt-chip">execute<'), 'the tool kind is a chip');
  assert.ok(html.includes('class="dt-chip">echo<'), 'the command\'s program is a chip');
  assert.ok(html.includes('C:\\work\\app\\marker.txt'), 'the path is shown');
  assert.ok(/ap-badge[^>]*>\s*writes/i.test(html), 'a writing approval says it writes');
  assert.ok(html.includes('data-answer="allow_once"') && html.includes('data-answer="allow_always"') && html.includes('data-answer="reject_once"'));
  const ro = inlineApprovalHtml(approval({ readOnly: true, command: 'cat a.txt', commands: ['cat a.txt'], paths: ['/a.txt'] }));
  assert.ok(/ap-badge[^>]*>\s*read[- ]only/i.test(ro), 'a read-only approval carries the read-only badge');
});

check('the inline card offers Always allow only when the agent offered it', () => {
  const html = inlineApprovalHtml(approval({ options: [ONCE, DENY] }));
  assert.ok(!html.includes('allow_always'), 'Always allow must never be invented');
  assert.ok(!html.includes('class="ap-rule"'), 'with no standing option there is no standing rule to explain');
  assert.ok(html.includes('data-answer="allow_once"') && html.includes('data-answer="reject_once"'));
  assert.ok(inlineApprovalHtml(approval()).includes('class="ap-rule"'), 'when it is offered, the rule it would create is spelled out');
});

check('the inline card renders its chips and buttons through the same helpers as the pop-up', () => {
  const a = approval();
  const html = inlineApprovalHtml(a);
  assert.ok(html.includes(approvalChipsHtml(a)), 'chips must come from the shared helper');
  assert.ok(html.includes(approvalButtonsHtml(a)), 'buttons must come from the shared helper');
  const notifications = read('web/js/notifications.js');
  assert.ok(notifications.includes('approvalChipsHtml(') && notifications.includes('approvalButtonsHtml('),
    'the pop-up uses the same shared helpers');
  assert.ok(notifications.includes('submitApproval('), 'the pop-up answers through the shared helper');
  assert.ok(read('web/js/approval-card.js').includes('submitApproval('), 'the card answers through the shared helper');
});

check('only the shared helper posts an approval answer', () => {
  const answerCalls = (rel) => (read(rel).match(/\/approve\b/g) || []).length;
  assert.strictEqual(answerCalls('web/js/approvals.js'), 1, 'exactly one place knows the answer endpoint');
  for (const rel of ['web/js/approval-card.js', 'web/js/notifications.js', 'web/js/wiring.js', 'web/js/detail-tabs.js', 'web/js/session-info.js']) {
    assert.strictEqual(answerCalls(rel), 0, `${rel} must not post an answer itself`);
  }
});

check('the inline card escapes everything the agent sent', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = inlineApprovalHtml(approval({
    approvalId: '"><script>x</script>', title: evil, command: evil, commands: [evil], kind: evil, paths: [evil],
  }));
  assert.ok(!html.includes('<img'), 'no raw tag from the agent');
  assert.ok(!html.includes('<script'), 'no raw tag from the approval id');
});

check('the inline card carries a labelled explainer hint button', () => {
  const html = inlineApprovalHtml(approval());
  const m = html.match(/<button type="button" class="hint-btn" aria-label="([^"]+)" title="([^"]+)"/);
  assert.ok(m, 'a hint-btn with an aria-label and a title');
  assert.ok(/pop-up/.test(m[2]) && /bell/.test(m[2]), 'it says this is the same request the pop-up and the bell show');
  assert.ok(/Always allow/.test(m[2]), 'it explains when Always allow appears');
  const info = read('web/index.html');
  assert.ok(/<h3 class="dt-sec">Approval history\s*<button type="button" class="hint-btn" aria-label="[^"]+" title="[^"]{20,}">/.test(info),
    'the approval history heading has its own explainer');
});

check('the inline card never invents an expiry, a Teams control or an inline style', () => {
  const html = inlineApprovalHtml(approval());
  assert.ok(!/expires in|expiry/i.test(html), 'the device reports no expiry time, so none is shown');
  assert.ok(!/teams/i.test(html), 'no Teams surface');
  assert.ok(!/style=/i.test(html), 'the CSP forbids inline styles');
  assert.ok(/requested 2m ago/.test(html), 'only the real request time is shown');
});

// ---------------------------------------------------------------------------
// The Info tab
// ---------------------------------------------------------------------------

check('Info shows the device, directory, repository, branch, agent, model, mode, times and tool count', () => {
  const rows = sessionInfoRows({ device: device(), session: session() });
  assert.deepStrictEqual(rows.map((r) => r.label), [
    'Device', 'Working directory', 'Repository', 'Branch', 'Agent', 'Model', 'Mode',
    'Started', 'Last activity', 'Tool calls', 'Squad health',
  ]);
  assert.ok(rowHtml(rows, 'device').includes('build-box') && /Online/.test(rowHtml(rows, 'device')));
  assert.ok(rowHtml(rows, 'cwd').includes('C:\\work\\app'));
  assert.ok(rowHtml(rows, 'repository').includes('octo/app'));
  assert.ok(rowHtml(rows, 'branch').includes('feature/x'));
  assert.ok(rowHtml(rows, 'agent').includes('Squad'));
  assert.ok(rowHtml(rows, 'model').includes('claude-sonnet-5'));
  assert.ok(rowHtml(rows, 'mode').includes('autopilot'));
  assert.ok(/1h ago/.test(rowHtml(rows, 'started')) && /1m ago/.test(rowHtml(rows, 'lastActivity')), 'times read both exact and relative');
  assert.strictEqual(rowHtml(rows, 'toolCalls'), '7');
});

check('Info says not reported for every field the device did not send, and invents nothing', () => {
  const rows = sessionInfoRows({ device: device(), session: { key: 'k', id: 's' } });
  for (const key of ['cwd', 'repository', 'branch', 'agent', 'model', 'mode', 'started', 'lastActivity', 'toolCalls']) {
    assert.ok(/not reported/.test(rowHtml(rows, key)), `${key} must say so rather than guess`);
  }
  assert.ok(!rows.some((r) => r.key === 'links'), 'a local device with no links gets no link row');
  assert.ok(!/main|master|default/i.test(rowHtml(rows, 'branch')), 'no default branch is made up');
  assert.strictEqual(rowHtml(sessionInfoRows({ device: device(), session: session({ toolCallCount: 0 }) }), 'toolCalls'), '0', 'zero is a real count');
});

check('Info prefers what the device applied and labels a mere request as one', () => {
  const asked = sessionInfoRows({
    device: device(),
    session: session({ applied: undefined, agentSelection: { agent: 'Squad', model: 'gpt-x', mode: 'plan' } }),
  });
  assert.ok(/gpt-x/.test(rowHtml(asked, 'model')) && /requested/.test(rowHtml(asked, 'model')), 'a request is marked as only a request');
  const applied = sessionInfoRows({
    device: device(),
    session: session({ agentSelection: { agent: 'Squad', model: 'gpt-x', mode: 'plan' } }),
  });
  assert.ok(/claude-sonnet-5/.test(rowHtml(applied, 'model')) && !/gpt-x/.test(rowHtml(applied, 'model')), 'what was applied wins over what was asked for');
  assert.ok(!/requested/.test(rowHtml(applied, 'model')));
});

check('Info escapes hostile device and session text', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const rows = sessionInfoRows({
    device: device({ name: evil }),
    session: session({
      cwd: evil, agent: evil, applied: { agent: evil, model: evil, mode: evil }, git: { repository: evil, branch: evil, host: evil },
    }),
  });
  assert.ok(!allHtml(rows).includes('<img'), 'no raw tag reaches the page');
  const history = approvalHistoryHtml(approvalHistory(session({
    answeredApprovals: [{ approvalId: evil, title: evil, optionId: 'allow_once', answeredBy: evil, answeredVia: 'hub', answeredAt: NOW }],
    expiredApprovals: [{ approvalId: evil, title: evil, requestedAt: NOW - 5000, expiredAt: NOW, reason: evil }],
  }), device({ name: evil })));
  assert.ok(!history.includes('<img'), 'no raw tag reaches the history');
});

check('Squad health shows each check with its own word, not only a color', () => {
  const squad = { health: { status: 'fail', checks: [
    { id: 'team', status: 'pass' }, { id: 'registry-charters', status: 'pass' }, { id: 'routing', status: 'fail' },
    { id: 'state-backend', status: 'skip' }, { id: 'env-vars', status: 'pass' },
  ] } };
  const view = squadHealthView({ squad });
  assert.strictEqual(view.state, 'fail');
  assert.deepStrictEqual(view.checks.map((c) => `${c.label}:${c.status}`), [
    'Team:pass', 'Charters:pass', 'Routing:fail', 'State backend:skip', 'Environment:pass',
  ]);
  const html = rowHtml(sessionInfoRows({ device: device(), session: session({ squad }) }), 'squadHealth');
  for (const word of ['Routing · fail', 'Team · pass', 'State backend · skip', 'A check failed']) {
    assert.ok(html.includes(word), `the row must say "${word}" in words`);
  }
  assert.ok(/dt-pill failed[^>]*>Routing/.test(html) && /dt-pill review[^>]*>Team/.test(html), 'pills reuse the shared 22px status pill');
});

check('Squad health is honest when the device cannot or has not checked', () => {
  assert.ok(/No Squad workspace/.test(rowHtml(sessionInfoRows({ device: device(), session: session() }), 'squadHealth')));
  const unavailable = rowHtml(sessionInfoRows({ device: device(), session: session({ squad: { health: { status: 'unavailable', checks: [] } } }) }), 'squadHealth');
  assert.ok(/Unavailable on this device/.test(unavailable) && !/pass/.test(unavailable), 'unavailable is never shown as passing');
  const unknown = rowHtml(sessionInfoRows({ device: device(), session: session({ squad: { health: { status: 'unknown', checks: [] } } }) }), 'squadHealth');
  assert.ok(/Not checked yet/.test(unknown) && !/pass/.test(unknown));
  assert.ok(/Not reported/.test(rowHtml(sessionInfoRows({ device: device(), session: session({ squad: {} }) }), 'squadHealth')));
});

check('the ACA row lists only links the device reported, and never a lease', () => {
  const aca = device({
    kind: 'aca', name: 'aca-job-x', deviceId: 'aca-1',
    meta: { repo: 'octo/app', issue: 42, executionName: 'exec-123' },
  });
  const full = sessionInfoRows({
    device: aca,
    session: session({ pullRequest: { url: 'https://github.com/octo/app/pull/7', number: 7 }, aspireUrl: 'https://aspire.example.com/d' }),
  });
  const html = rowHtml(full, 'links');
  assert.ok(html.includes('href="https://github.com/octo/app/issues/42"') && html.includes('Issue #42'), 'the issue link is built from what the job reported');
  assert.ok(html.includes('href="https://github.com/octo/app/pull/7"') && html.includes('Pull request #7'));
  assert.ok(html.includes('href="https://aspire.example.com/d"') && html.includes('Aspire dashboard'));
  assert.ok(html.includes('rel="noopener noreferrer"') && html.includes('target="_blank"'));
  assert.ok(!/lease/i.test(allHtml(full)), 'no lease is reported by any device, so none is shown');
  assert.ok(rowHtml(full, 'device').includes('exec-123'), 'the execution id is reported by the job');
  const bare = sessionInfoRows({ device: aca, session: session() });
  assert.ok(/Issue #42/.test(rowHtml(bare, 'links')) && !/Pull request|Aspire/.test(rowHtml(bare, 'links')),
    'with no pull request or dashboard reported, only the issue the job itself named is linked');
  const noMeta = sessionInfoRows({ device: device({ kind: 'aca', meta: {} }), session: session() });
  assert.ok(/no issue, pull request or dashboard link reported/.test(rowHtml(noMeta, 'links')), 'an ACA run with nothing reported says so');
  assert.ok(!/href=/.test(rowHtml(noMeta, 'links')), 'and invents no link');
});

check('Info only links http and https addresses', () => {
  assert.strictEqual(safeHttpUrl('javascript:alert(1)'), null);
  assert.strictEqual(safeHttpUrl('data:text/html,<b>x</b>'), null);
  assert.strictEqual(safeHttpUrl('not a url'), null);
  assert.strictEqual(safeHttpUrl(''), null);
  assert.strictEqual(safeHttpUrl('https://example.com/a'), 'https://example.com/a');
  const links = infoLinks({
    device: device(),
    session: session({ pullRequest: { url: 'javascript:alert(1)', number: 1 }, aspireUrl: 'file:///etc/passwd' }),
  });
  assert.deepStrictEqual(links, [], 'an unsafe address is not a link');
});

// ---------------------------------------------------------------------------
// Approval history
// ---------------------------------------------------------------------------

check('approval history merges answered and expired requests, newest first, with who, what, when and where', () => {
  const s = session({
    answeredApprovals: [
      { approvalId: 'a1', title: 'Run tests', optionId: 'allow_once', answeredBy: 'Pat', answeredVia: 'hub', answeredAt: NOW - 600000 },
      { approvalId: 'a2', title: 'Delete build', optionId: 'reject_once', answeredBy: 'someone', answeredVia: 'terminal', answeredAt: NOW - 60000 },
    ],
    expiredApprovals: [{ approvalId: 'e1', title: 'Install deps', requestedAt: NOW - 900000, expiredAt: NOW - 300000, reason: 'device disconnected' }],
  });
  const h = approvalHistory(s, device());
  assert.deepStrictEqual(h.map((r) => r.approvalId), ['a2', 'e1', 'a1'], 'newest first');
  assert.strictEqual(h[0].label, 'Denied');
  assert.strictEqual(h[0].who, 'someone');
  assert.strictEqual(h[0].from, 'at the terminal on build-box', 'a terminal answer says where it was given');
  assert.strictEqual(h[2].label, 'Allowed');
  assert.strictEqual(h[2].who, 'Pat');
  assert.strictEqual(h[2].from, 'from the hub');
  const html = approvalHistoryHtml(h);
  assert.ok(html.includes('data-outcome="reject_once"') && html.includes('data-outcome="allow_once"') && html.includes('data-outcome="expired"'));
  assert.ok(html.includes('by Pat') && html.includes('Run tests') && html.includes('1m ago') && html.includes('10m ago'));
  assert.ok(html.includes('dt-pill failed') && html.includes('dt-pill review') && html.includes('dt-pill stale'), 'outcomes reuse the shared 22px pill');
  assert.ok(/<li class="dt-empty">/.test(approvalHistoryHtml([])), 'an empty history says so');
});

check('an expired request is shown as not answered, never attributed to anyone', () => {
  const h = approvalHistory(session({
    expiredApprovals: [{ approvalId: 'e1', title: 'Install deps', requestedAt: NOW - 900000, expiredAt: NOW - 300000, reason: 'device disconnected' }],
  }), device());
  assert.strictEqual(h[0].who, null);
  assert.strictEqual(h[0].label, 'Expired');
  assert.ok(h[0].from.includes('build-box') && h[0].from.includes('device disconnected'), 'where, and why when the hub knows');
  const html = approvalHistoryHtml(h);
  assert.ok(/not answered/.test(html) && !/by someone/.test(html));
});

// ---------------------------------------------------------------------------
// Boundaries: no requests, no Teams, no device token, no inline styles
// ---------------------------------------------------------------------------

check('the tab, card and Info modules make no requests of their own', () => {
  for (const rel of ['web/js/detail-tabs.js', 'web/js/session-info.js']) {
    const src = read(rel);
    assert.ok(!/\bfetch\s*\(|\bapi\s*\(|XMLHttpRequest|WebSocket/.test(src), `${rel} must not make a request: switching a tab never touches the network`);
  }
  const card = read('web/js/approval-card.js');
  assert.ok(!/\bfetch\s*\(|\bapi\s*\(/.test(card), 'the card answers only through the shared helper');
  assert.ok(!/\/spawn|deviceToken|device-token|connect-token/i.test(`${card}${read('web/js/detail-tabs.js')}${read('web/js/session-info.js')}`),
    'nothing here starts work on a device or handles a device token');
});

check('no Teams surface is added to the detail page', () => {
  for (const rel of ['web/js/detail-tabs.js', 'web/js/approval-card.js', 'web/js/session-info.js', 'web/css/detail-tabs.css']) {
    assert.ok(!/teams/i.test(read(rel)), `${rel} must not mention Teams`);
  }
  const html = read('web/index.html');
  const detail = html.slice(html.indexOf('id="detailScrim"'), html.indexOf('id="connectScrim"'));
  assert.ok(!/teams/i.test(detail), 'the detail page has no Teams control');
});

check('the new modules use no inline styles, which the page CSP forbids', () => {
  for (const rel of ['web/js/detail-tabs.js', 'web/js/approval-card.js', 'web/js/session-info.js', 'web/js/squad-panel.js']) {
    assert.ok(!/style\s*=\s*["'`]|\.style\.|setAttribute\(\s*['"]style/.test(read(rel)), `${rel} must not set inline styles`);
  }
});

// ---------------------------------------------------------------------------
// The markup and the styles
// ---------------------------------------------------------------------------

check('the markup has Chat, Squad and Info tabs and a disabled Files tab with its tooltip', () => {
  const html = read('web/index.html');
  for (const id of ['chat', 'squad', 'info']) {
    assert.ok(new RegExp(`id="dtTab-${id}"[^>]*role="tab"`).test(html), `a ${id} tab`);
    assert.ok(new RegExp(`id="dtPane-${id}" role="tabpanel"`).test(html), `a ${id} panel`);
  }
  const files = html.match(/<button[^>]*id="dtTab-files"[^>]*>/);
  assert.ok(files, 'a Files tab exists');
  assert.ok(/\sdisabled[\s>]/.test(files[0]) && /aria-disabled="true"/.test(files[0]), 'Files is disabled');
  assert.ok(files[0].includes('title="Spike only: appears when the device allows file access"'), 'Files carries the spike tooltip');
  assert.ok(!html.includes('id="dtPane-files"'), 'Files has no panel behind it');
  assert.ok(html.indexOf('id="dtPane-info"') < html.indexOf('class="composer"'), 'the composer sits after every panel, outside all of them');
});

check('the new styles keep the product sizes: 22px status pills and 32px buttons', () => {
  const css = read('web/css/detail-tabs.css');
  assert.ok(!/\.dt-pill\s*\{/.test(css), 'the status pill is defined once, in detail.css, at 22px');
  assert.ok(/\.dt-appr-actions button\s*\{[^}]*height:\s*32px/.test(css), 'answer buttons are 32px');
  assert.ok(/\.dt-appr-actions button\s*\{[^}]*border-radius:\s*6px/.test(css), 'with the 6px radius');
  assert.ok(/\.dt-chip\s*\{[^}]*height:\s*22px/.test(css), 'chips match the 22px pill');
  assert.ok(!/height:\s*(?!22px|32px|28px|40px|8px|15px|auto)\d+px/.test(css.replace(/min-height:\s*\d+px/g, '')), 'no stray control height');
  const detailCss = read('web/css/detail.css');
  assert.ok(/\.dt-pill\s*\{[^}]*height:\s*22px/.test(detailCss), 'the shared pill really is 22px');
});

check('a system that prefers light, with no saved choice, still flips the code surfaces', () => {
  const tokens = read('web/css/tokens.css');
  const block = (opening) => {
    const at = tokens.indexOf(opening);
    assert.ok(at >= 0, `tokens.css has no ${opening} block`);
    return tokens.slice(at, tokens.indexOf('\n}', at));
  };
  for (const opening of [':root[data-theme="light"] {', '@media (prefers-color-scheme: light) {']) {
    const b = block(opening);
    assert.ok(/--code-bg:\s*#f2f4f8/.test(b) && /--code-line:\s*#dfe4ec/.test(b),
      `${opening} leaves the near-black code surfaces under light text: the card's command and the transcript would be unreadable`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
