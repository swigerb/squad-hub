'use strict';
/**
 * The bell inbox (#174): every pending approval and every awaiting-reply
 * session, across every device, in one dropdown -- so a person checks one
 * place instead of scrolling a device-grouped list looking for the row that
 * wants them.
 *
 * `web/js/inbox.js` has zero runtime dependencies and is meant to run in a
 * real browser with no build step -- so there is no jsdom here either. Like
 * web-xss-unit.js, the module is read straight off disk, its `import`/
 * `export` syntax stripped, and the result evaluated directly in Node. Proof
 * that the merge/sort/count rules hold, not a simulation of them.
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

const WEB_ROOT = path.join(__dirname, '..', 'web');
const utilSrc = stripModuleSyntax(fs.readFileSync(path.join(WEB_ROOT, 'js', 'util.js'), 'utf8'));
const cleanupSrc = stripModuleSyntax(fs.readFileSync(path.join(WEB_ROOT, 'js', 'cleanup.js'), 'utf8'));
const inboxSrc = stripModuleSyntax(fs.readFileSync(path.join(WEB_ROOT, 'js', 'inbox.js'), 'utf8'));

const sandboxModule = { exports: {} };
const load = new Function('module', 'exports', `
  ${utilSrc}
  ${cleanupSrc}
  ${inboxSrc}
  module.exports = { inboxEntries, inboxCount, renderInboxItem, renderInboxList, EXPIRED_RECENCY_MS };
`);
load(sandboxModule, sandboxModule.exports);
const {
  inboxEntries, inboxCount, renderInboxItem, renderInboxList, EXPIRED_RECENCY_MS,
} = sandboxModule.exports;

const NOW = 1_700_000_000_000;

function device(id, name) {
  return { deviceId: id, name };
}

function overviewOf(groups) {
  return { groups, devices: [], counts: {} };
}

function sessionWithApproval(overrides = {}) {
  return {
    key: 'sess-1',
    id: 'id-1',
    cwd: '/repo',
    status: 'running',
    startedAt: NOW - 60_000,
    pendingApprovals: [{
      approvalId: 'ap-1',
      title: 'Run a migration',
      command: 'npm run migrate',
      requestedAt: NOW - 30_000,
      options: [
        { optionId: 'allow_once', label: 'Allow once' },
        { optionId: 'allow_always', label: 'Always allow' },
        { optionId: 'reject_once', label: 'Deny' },
      ],
    }],
    expiredApprovals: [],
    ...overrides,
  };
}

function idleSession(overrides = {}) {
  return {
    key: 'sess-2',
    id: 'id-2',
    cwd: '/repo2',
    status: 'idle',
    startedAt: NOW - 120_000,
    updatedAt: NOW - 5_000,
    lastAgentMessage: 'Should I use the staging or production database?',
    pendingApprovals: [],
    expiredApprovals: [],
    ...overrides,
  };
}

function expiredSession(overrides = {}) {
  return {
    key: 'sess-3',
    id: 'id-3',
    cwd: '/repo3',
    status: 'running',
    startedAt: NOW - 600_000,
    pendingApprovals: [],
    expiredApprovals: [{
      approvalId: 'ap-expired-1',
      title: 'Delete a branch',
      reason: 'device disconnected',
      requestedAt: NOW - 400_000,
      expiredAt: NOW - 60_000,
    }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// inboxEntries: what counts as "needs you"
// ---------------------------------------------------------------------------

check('a pending approval becomes one "approval" entry', () => {
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [sessionWithApproval()] }]);
  const entries = inboxEntries(ov, NOW);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'approval');
  assert.strictEqual(entries[0].sessionKey, 'sess-1');
  assert.strictEqual(entries[0].approval.approvalId, 'ap-1');
});

check('an idle session becomes one "reply" entry carrying lastAgentMessage', () => {
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [idleSession()] }]);
  const entries = inboxEntries(ov, NOW);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'reply');
  assert.strictEqual(entries[0].message, 'Should I use the staging or production database?');
});

check('a session that is neither blocked nor idle contributes nothing', () => {
  const ov = overviewOf([{
    device: device('d1', 'Laptop'),
    sessions: [{
      key: 'sess-4', id: 'id-4', cwd: '/x', status: 'running', pendingApprovals: [], expiredApprovals: [],
    }],
  }]);
  assert.deepStrictEqual(inboxEntries(ov, NOW), []);
});

check('a session can contribute more than one approval entry', () => {
  const s = sessionWithApproval({
    pendingApprovals: [
      { approvalId: 'ap-a', title: 'First', requestedAt: NOW - 10_000, options: [] },
      { approvalId: 'ap-b', title: 'Second', requestedAt: NOW - 5_000, options: [] },
    ],
  });
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [s] }]);
  const entries = inboxEntries(ov, NOW);
  assert.strictEqual(entries.length, 2);
  assert.deepStrictEqual(entries.map((e) => e.approval.approvalId), ['ap-a', 'ap-b']);
});

check('a recent device-disconnect expiry becomes one "expired" entry', () => {
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [expiredSession()] }]);
  const entries = inboxEntries(ov, NOW);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'expired');
});

check('an expiry older than the recency window is dropped entirely (#162: it is history, not news)', () => {
  const s = expiredSession({
    expiredApprovals: [{
      approvalId: 'ap-old',
      title: 'Old one',
      reason: 'device disconnected',
      expiredAt: NOW - (EXPIRED_RECENCY_MS + 1),
    }],
  });
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [s] }]);
  assert.deepStrictEqual(inboxEntries(ov, NOW), []);
});

check('an expiry exactly at the recency boundary still counts (inclusive)', () => {
  const s = expiredSession({
    expiredApprovals: [{
      approvalId: 'ap-edge',
      title: 'Edge one',
      reason: 'device disconnected',
      expiredAt: NOW - EXPIRED_RECENCY_MS,
    }],
  });
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [s] }]);
  assert.strictEqual(inboxEntries(ov, NOW).length, 1);
});

check('an expiry for any other reason never appears, recent or not (#162 guard is reason-specific)', () => {
  const s = expiredSession({
    expiredApprovals: [{
      approvalId: 'ap-other',
      title: 'Answered elsewhere',
      reason: 'answered on another device',
      expiredAt: NOW - 1000,
    }],
  });
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [s] }]);
  assert.deepStrictEqual(inboxEntries(ov, NOW), []);
});

check('an expiry missing expiredAt entirely is dropped rather than guessed recent', () => {
  const s = expiredSession({
    expiredApprovals: [{ approvalId: 'ap-no-ts', title: 'No timestamp', reason: 'device disconnected' }],
  });
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [s] }]);
  assert.deepStrictEqual(inboxEntries(ov, NOW), []);
});

check('entries are sorted approval, then reply, then expired, regardless of input order', () => {
  const ov = overviewOf([
    { device: device('d1', 'A'), sessions: [expiredSession()] },
    { device: device('d2', 'B'), sessions: [idleSession()] },
    { device: device('d3', 'C'), sessions: [sessionWithApproval()] },
  ]);
  const entries = inboxEntries(ov, NOW);
  assert.deepStrictEqual(entries.map((e) => e.kind), ['approval', 'reply', 'expired']);
});

check('within the same kind, the oldest entry leads', () => {
  const older = sessionWithApproval({
    key: 'older',
    pendingApprovals: [{
      approvalId: 'ap-older', title: 'Older', requestedAt: NOW - 90_000, options: [],
    }],
  });
  const newer = sessionWithApproval({
    key: 'newer',
    pendingApprovals: [{
      approvalId: 'ap-newer', title: 'Newer', requestedAt: NOW - 10_000, options: [],
    }],
  });
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [newer, older] }]);
  const entries = inboxEntries(ov, NOW);
  assert.deepStrictEqual(entries.map((e) => e.approval.approvalId), ['ap-older', 'ap-newer']);
});

check('an empty overview, and an overview with no groups at all, both produce no entries', () => {
  assert.deepStrictEqual(inboxEntries(overviewOf([]), NOW), []);
  assert.deepStrictEqual(inboxEntries({}, NOW), []);
  assert.deepStrictEqual(inboxEntries(null, NOW), []);
});

// ---------------------------------------------------------------------------
// inboxCount: the badge
// ---------------------------------------------------------------------------

check('inboxCount counts one approval and one reply as 2, matching the mockup\'s "Needs you 2"', () => {
  const ov = overviewOf([
    { device: device('d1', 'A'), sessions: [sessionWithApproval()] },
    { device: device('d2', 'B'), sessions: [idleSession()] },
  ]);
  assert.strictEqual(inboxCount(ov, NOW), 2);
});

check('inboxCount excludes expired entries -- a gone device does not inflate the badge', () => {
  const ov = overviewOf([{ device: device('d1', 'A'), sessions: [expiredSession()] }]);
  assert.strictEqual(inboxCount(ov, NOW), 0);
});

check('inboxCount is 0 for an empty overview', () => {
  assert.strictEqual(inboxCount(overviewOf([]), NOW), 0);
});

// ---------------------------------------------------------------------------
// Rendering: the #162 regression guard lives here too -- an expired card
// must not offer an answer control, only an approval card may.
// ---------------------------------------------------------------------------

check('an approval card renders Allow once / Always allow / Deny, each wired to answer the right approval', () => {
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [sessionWithApproval()] }]);
  const html = renderInboxItem(inboxEntries(ov, NOW)[0]);
  assert.ok(html.includes('Allow once'));
  assert.ok(html.includes('Always allow'));
  assert.ok(html.includes('Deny'));
  assert.ok(html.includes('data-approval="ap-1"'));
  assert.ok(html.includes('data-session-id="id-1"'));
  assert.ok(html.includes('data-device="d1"'));
});

check('a reply card shows the quoted last agent message and an "Open and reply" control, no answer buttons', () => {
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [idleSession()] }]);
  const html = renderInboxItem(inboxEntries(ov, NOW)[0]);
  assert.ok(html.includes('Should I use the staging or production database?'));
  assert.ok(html.includes('Open and reply'));
  assert.ok(!html.includes('data-answer'));
});

check('a reply card with no captured lastAgentMessage still renders, just without a quote', () => {
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [idleSession({ lastAgentMessage: null })] }]);
  const html = renderInboxItem(inboxEntries(ov, NOW)[0]);
  assert.ok(html.includes('Open and reply'));
  assert.ok(!html.includes('inbox-item-command'));
});

check('#162 regression guard: an expired card shows "Expired" and offers NO answer control at all', () => {
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [expiredSession()] }]);
  const html = renderInboxItem(inboxEntries(ov, NOW)[0]);
  assert.ok(html.includes('Expired'));
  assert.ok(!html.includes('data-answer'));
  assert.ok(html.includes('disconnected'));
});

check('every card carries data-inbox-open keyed on the session KEY, never the session id', () => {
  const ov = overviewOf([{ device: device('d1', 'Laptop'), sessions: [sessionWithApproval()] }]);
  const html = renderInboxItem(inboxEntries(ov, NOW)[0]);
  assert.ok(html.includes('data-inbox-open="sess-1"'));
});

check('renderInboxList shows the empty state when nothing needs the person, never an empty <div>', () => {
  const html = renderInboxList([]);
  assert.ok(html.includes('Nothing needs you'));
});

check('renderInboxList renders one item per entry, in the entries\' own order', () => {
  const ov = overviewOf([
    { device: device('d1', 'A'), sessions: [sessionWithApproval()] },
    { device: device('d2', 'B'), sessions: [idleSession()] },
  ]);
  const entries = inboxEntries(ov, NOW);
  const html = renderInboxList(entries);
  assert.ok(html.indexOf('Run a migration') < html.indexOf('Open and reply'));
});

// A malicious command/title must render as inert text, same guarantee the
// rest of the page already gives every device-supplied string (web-xss-unit.js).
check('a hostile approval title/command renders as inert escaped text, never live markup', () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const s = sessionWithApproval({
    pendingApprovals: [{
      approvalId: 'ap-xss', title: XSS, command: XSS, requestedAt: NOW, options: [],
    }],
  });
  const ov = overviewOf([{ device: device('d1', XSS), sessions: [s] }]);
  const html = renderInboxItem(inboxEntries(ov, NOW)[0]);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (require.main === module && fail) process.exitCode = 1;
