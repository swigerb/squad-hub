'use strict';
/**
 * #180: the "Squad on ACA" status card.
 *
 * All the logic here is proven as pure functions of their inputs, through
 * `web/app.js`'s own DOM-free prefix (the same extraction every other web
 * suite uses) -- so every phase the card can be in (checking, not connected,
 * connected with nothing yet, connected mid-dispatch) is provable without a
 * browser. The browser-e2e suite only has to prove the wiring: that a real
 * fetch populates `#acaStatusCard`, and that Retry re-fetches.
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
const mod = { exports: {} };
new Function('module', 'exports', `${src}
module.exports = { ACA_PHASE, findWatcherDevice, findRalphDevice, acaWatcherLine,
  acaRalphLine, acaDispatchStatusLabel, acaLastDispatchLine, acaStatusModel,
  acaStatusCardHtml };`)(mod, mod.exports);

const {
  ACA_PHASE, findWatcherDevice, findRalphDevice, acaWatcherLine, acaRalphLine,
  acaDispatchStatusLabel, acaLastDispatchLine, acaStatusModel, acaStatusCardHtml,
} = mod.exports;

function dev(over = {}) {
  return {
    deviceId: over.name || 'd', name: 'device', platform: 'linux', kind: 'cloud',
    presence: 'online', lastSeen: Date.now(), fileAccess: 'off', ...over,
  };
}

/** An ACA device fixture, matching the shape `src/service/store.js` actually
 * sends: `kind: 'aca'`, and `meta: null` unless a test supplies one -- the
 * same as every real squad-on-aca deployment today. */
function acaDev(over = {}) {
  return dev({ kind: 'aca', meta: null, ...over });
}

/**
 * The exact, real production record (#233's Scout review): an online ACA
 * device named by its Container App Job revision, with no metadata at all.
 * `findWatcherDevice`'s old `/watcher/i` match returned null for this real
 * record because the name contains "watch", never the literal word
 * "watcher" -- the bug this whole revision exists to fix.
 */
const REAL_WATCH_DEVICE_NAME = 'aca-ca-squad-aca-watch--0000016-f4848bdc9-c77w5';

// ---------------------------------------------------------------------------
// findWatcherDevice / findRalphDevice
// ---------------------------------------------------------------------------

check('findWatcherDevice matches the REAL production device name/shape (#233)', () => {
  const d = acaDev({ name: REAL_WATCH_DEVICE_NAME, presence: 'online', meta: null });
  assert.strictEqual(findWatcherDevice([dev({ name: 'laptop' }), d]), d);
});

check('findWatcherDevice matches case-insensitively', () => {
  const d = acaDev({ name: REAL_WATCH_DEVICE_NAME.toUpperCase() });
  assert.strictEqual(findWatcherDevice([d]), d);
});

check('findWatcherDevice prefers an explicit, sanitized meta.role over any name match', () => {
  // Named like Ralph, but explicitly self-reports the watch role: the
  // verified fact wins over the name-based convention fallback.
  const d = acaDev({ name: 'aca-ca-squad-aca-ralph--0000020-abc', meta: { role: 'watch' } });
  assert.strictEqual(findWatcherDevice([d]), d);
});

check('findWatcherDevice returns null when no watcher device exists', () => {
  assert.strictEqual(findWatcherDevice([dev({ name: 'laptop' }), acaDev({ name: 'aca-ca-squad-aca-ralph--1-abc-def' })]), null);
});

check('findWatcherDevice treats an empty roster as "no watcher", not a crash', () => {
  assert.strictEqual(findWatcherDevice([]), null);
  assert.strictEqual(findWatcherDevice(), null);
});

check('findWatcherDevice ignores a non-ACA device even if its name matches the convention', () => {
  // kind: 'cloud', not 'aca' -- the watcher/Ralph jobs are categorically ACA
  // jobs, so a same-named cloud daemon is out of scope, not a coincidental
  // match.
  const d = dev({ name: REAL_WATCH_DEVICE_NAME, kind: 'cloud' });
  assert.strictEqual(findWatcherDevice([d]), null);
});

check('findWatcherDevice never matches an arbitrary implementation session containing "watcher"/"ralph" as a substring', () => {
  // Real dispatched implementation-session job names (see #233's own PR
  // history): "squad-aca-session-<slug>", never "squad-aca-watch" or
  // "squad-aca-ralph". A slug that happens to mention "watcher" in plain
  // English must not be picked up by a looser substring match.
  const sessionDevices = [
    acaDev({ name: 'aca-ca-squad-aca-session-fix-pr-233-live-status-truth--1-abc' }),
    acaDev({ name: 'aca-ca-squad-aca-session-project-watcher-dashboard--2-def' }),
    acaDev({ name: 'aca-ca-squad-aca-session-ralph-feature-notes--3-ghi' }),
  ];
  assert.strictEqual(findWatcherDevice(sessionDevices), null);
  assert.strictEqual(findRalphDevice(sessionDevices), null);
});

check('findRalphDevice matches the established "squad-aca-ralph" job naming convention', () => {
  const d = acaDev({ name: 'aca-ca-squad-aca-ralph--0000031-9a8b7c6d-x1y2z' });
  assert.strictEqual(findRalphDevice([acaDev({ name: REAL_WATCH_DEVICE_NAME }), d]), d);
});

check('findRalphDevice returns null when no Ralph device exists', () => {
  assert.strictEqual(findRalphDevice([acaDev({ name: REAL_WATCH_DEVICE_NAME })]), null);
});

// ---------------------------------------------------------------------------
// acaWatcherLine -- presence, and "watch-only" gated on VERIFIED approvalMode
// ---------------------------------------------------------------------------

check('acaWatcherLine says "Not connected" with no watcher device', () => {
  assert.strictEqual(acaWatcherLine([]), 'Not connected');
});

check('acaWatcherLine reports plain presence with no approvalMode metadata at all (today\'s real record)', () => {
  // The actual production shape: meta: null. Claiming "watch-only" here
  // would be inventing a fact no device confirmed.
  const line = acaWatcherLine([acaDev({ name: REAL_WATCH_DEVICE_NAME, presence: 'online', meta: null })]);
  assert.strictEqual(line, 'Online');
});

check('acaWatcherLine reports plain presence when approvalMode is explicitly "manual"', () => {
  const line = acaWatcherLine([acaDev({
    name: REAL_WATCH_DEVICE_NAME, presence: 'online', meta: { approvalMode: 'manual' },
  })]);
  assert.strictEqual(line, 'Online');
});

check('acaWatcherLine appends "watch-only" ONLY with a VERIFIED approvalMode of "auto"', () => {
  const line = acaWatcherLine([acaDev({
    name: REAL_WATCH_DEVICE_NAME, presence: 'online', meta: { approvalMode: 'auto' },
  })]);
  assert.strictEqual(line, 'Online \u00b7 watch-only');
});

check('acaWatcherLine reports a stale watcher\'s presence correctly alongside a verified approvalMode', () => {
  const line = acaWatcherLine([acaDev({
    name: REAL_WATCH_DEVICE_NAME, presence: 'stale', meta: { approvalMode: 'auto' },
  })]);
  assert.strictEqual(line, 'Stale \u00b7 watch-only');
});

check('acaWatcherLine reports an offline watcher\'s presence correctly alongside a verified approvalMode', () => {
  const line = acaWatcherLine([acaDev({
    name: REAL_WATCH_DEVICE_NAME, presence: 'offline', meta: { approvalMode: 'auto' },
  })]);
  assert.strictEqual(line, 'Offline \u00b7 watch-only');
});

// ---------------------------------------------------------------------------
// acaRalphLine -- a heartbeat is not proof of a sweep
// ---------------------------------------------------------------------------

check('acaRalphLine says "Not connected" with no Ralph device', () => {
  assert.strictEqual(acaRalphLine([]), 'Not connected');
});

check('acaRalphLine is honest about a heartbeat-only device with no lastSeen at all', () => {
  const line = acaRalphLine([acaDev({ name: 'aca-ca-squad-aca-ralph--1-a-b', lastSeen: 0, meta: null })]);
  assert.strictEqual(line, 'Last seen unknown \u00b7 no sweep confirmed');
});

check('acaRalphLine reports "Last seen <ago> · no sweep confirmed" for a bare heartbeat (no lastSweepAt)', () => {
  const line = acaRalphLine([acaDev({
    name: 'aca-ca-squad-aca-ralph--1-a-b', lastSeen: Date.now() - 4 * 60 * 1000, meta: null,
  })]);
  assert.strictEqual(line, 'Last seen 4m ago \u00b7 no sweep confirmed');
});

check('acaRalphLine reports "Last sweep <ago>" ONLY from a confirmed meta.lastSweepAt', () => {
  const line = acaRalphLine([acaDev({
    name: 'aca-ca-squad-aca-ralph--1-a-b',
    lastSeen: Date.now() - 60 * 1000, // a much more recent heartbeat
    meta: { lastSweepAt: new Date(Date.now() - 4 * 60 * 1000).toISOString() },
  })]);
  // The confirmed sweep time wins over the newer, but merely-heartbeat, lastSeen.
  assert.strictEqual(line, 'Last sweep 4m ago');
});

// ---------------------------------------------------------------------------
// acaDispatchStatusLabel
// ---------------------------------------------------------------------------

check('acaDispatchStatusLabel labels a pending run as "queued, waiting for the run"', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'pending' }), 'queued, waiting for the run');
});

check('acaDispatchStatusLabel labels a queued run as "queued"', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'queued' }), 'queued');
});

check('acaDispatchStatusLabel labels an in_progress run as "running"', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'in_progress' }), 'running');
});

check('acaDispatchStatusLabel labels a successful completed run as plain "completed"', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'completed', conclusion: 'success' }), 'completed');
});

check('acaDispatchStatusLabel labels a non-success conclusion as "completed (<conclusion>)"', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'completed', conclusion: 'failure' }), 'completed (failure)');
});

check('acaDispatchStatusLabel labels an error state with its reason', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'error', reason: 'workflow not found' }),
    'error: workflow not found');
});

check('acaDispatchStatusLabel labels an error state with no reason as plain "error"', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'error' }), 'error');
});

check('acaDispatchStatusLabel falls back to "unknown" for an unrecognized or missing state', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'bogus' }), 'unknown');
  assert.strictEqual(acaDispatchStatusLabel(), 'unknown');
});

// ---------------------------------------------------------------------------
// acaLastDispatchLine
// ---------------------------------------------------------------------------

check('acaLastDispatchLine says "No dispatches yet" with an empty list', () => {
  assert.strictEqual(acaLastDispatchLine([]), 'No dispatches yet');
});

check('acaLastDispatchLine renders the newest (first) dispatch as "owner/repo · status"', () => {
  const line = acaLastDispatchLine([
    { owner: 'swigerb', repo: 'squad-hub', status: { state: 'in_progress' } },
    { owner: 'swigerb', repo: 'other-repo', status: { state: 'completed', conclusion: 'success' } },
  ]);
  assert.strictEqual(line, 'swigerb/squad-hub \u00b7 running');
});

check('acaLastDispatchLine escapes owner/repo, since device and dispatch metadata is untrusted', () => {
  const line = acaLastDispatchLine([
    { owner: '<script>', repo: 'squad-hub', status: { state: 'queued' } },
  ]);
  assert.ok(!line.includes('<script>'), 'raw markup leaked into the dispatch line');
  assert.ok(line.includes('&lt;script&gt;'), 'owner was not escaped');
});

check('acaLastDispatchLine escapes an untrusted error reason carried in the status label', () => {
  const line = acaLastDispatchLine([
    { owner: 'swigerb', repo: 'squad-hub', status: { state: 'error', reason: '<img onerror=1>' } },
  ]);
  assert.ok(!line.includes('<img'), 'raw markup leaked into the dispatch line via the error reason');
  assert.ok(line.includes('&lt;img'), 'the error reason was not escaped');
});

// ---------------------------------------------------------------------------
// acaStatusModel
// ---------------------------------------------------------------------------

check('acaStatusModel defaults to CHECKING with no phase given', () => {
  assert.deepStrictEqual(acaStatusModel(), { phase: ACA_PHASE.CHECKING });
  assert.deepStrictEqual(acaStatusModel({}), { phase: ACA_PHASE.CHECKING });
});

check('acaStatusModel keeps NOT_CONNECTED and falls back to a default reason', () => {
  const model = acaStatusModel({ phase: ACA_PHASE.NOT_CONNECTED });
  assert.strictEqual(model.phase, ACA_PHASE.NOT_CONNECTED);
  assert.strictEqual(model.reason, 'the GitHub App is not configured');
});

check('acaStatusModel keeps NOT_CONNECTED and preserves a supplied reason', () => {
  const model = acaStatusModel({ phase: ACA_PHASE.NOT_CONNECTED, reason: 'custom reason' });
  assert.strictEqual(model.reason, 'custom reason');
});

check('acaStatusModel builds watcher/ralph/lastDispatch for CONNECTED', () => {
  const devices = [
    acaDev({ name: REAL_WATCH_DEVICE_NAME, presence: 'online', meta: { approvalMode: 'auto' } }),
    acaDev({
      name: 'aca-ca-squad-aca-ralph--0000031-9a8b7c6d-x1y2z',
      lastSeen: Date.now() - 60 * 1000,
      meta: { lastSweepAt: new Date(Date.now() - 60 * 1000).toISOString() },
    }),
  ];
  const dispatches = [{ owner: 'swigerb', repo: 'squad-hub', status: { state: 'queued' } }];
  const model = acaStatusModel({ phase: ACA_PHASE.CONNECTED, devices, dispatches });
  assert.strictEqual(model.phase, ACA_PHASE.CONNECTED);
  assert.strictEqual(model.watcher, 'Online \u00b7 watch-only');
  assert.strictEqual(model.ralph, 'Last sweep 1m ago');
  assert.strictEqual(model.lastDispatch, 'swigerb/squad-hub \u00b7 queued');
});

check('acaStatusModel handles CONNECTED with no watcher/ralph/dispatches yet', () => {
  const model = acaStatusModel({ phase: ACA_PHASE.CONNECTED });
  assert.strictEqual(model.watcher, 'Not connected');
  assert.strictEqual(model.ralph, 'Not connected');
  assert.strictEqual(model.lastDispatch, 'No dispatches yet');
});

check('acaStatusModel is honest about CONNECTED with a real-shaped watcher/ralph and no metadata', () => {
  // The actual production shape (#233): online devices, kind 'aca', meta:
  // null -- no approvalMode, no lastSweepAt. Neither row may claim more
  // than presence/heartbeat.
  const devices = [
    acaDev({ name: REAL_WATCH_DEVICE_NAME, presence: 'online', meta: null }),
    acaDev({ name: 'aca-ca-squad-aca-ralph--0000031-9a8b7c6d-x1y2z', lastSeen: Date.now() - 2 * 60 * 1000, meta: null }),
  ];
  const model = acaStatusModel({ phase: ACA_PHASE.CONNECTED, devices });
  assert.strictEqual(model.watcher, 'Online');
  assert.strictEqual(model.ralph, 'Last seen 2m ago \u00b7 no sweep confirmed');
});

// ---------------------------------------------------------------------------
// acaStatusCardHtml
// ---------------------------------------------------------------------------

check('acaStatusCardHtml renders a pulsing "Checking…" pill for CHECKING', () => {
  const html = acaStatusCardHtml({ phase: ACA_PHASE.CHECKING });
  assert.match(html, /class="status stale"/);
  assert.match(html, /Checking&hellip;/);
});

check('acaStatusCardHtml renders "Not connected" with the reason and a Set up link', () => {
  const html = acaStatusCardHtml({ phase: ACA_PHASE.NOT_CONNECTED, reason: 'the GitHub App is not configured' });
  assert.match(html, /class="status off">Not connected</);
  assert.match(html, /the GitHub App is not configured\./);
  assert.match(html, /Set up<\/a>/);
});

check('acaStatusCardHtml escapes an untrusted reason string in the Not-connected note', () => {
  const html = acaStatusCardHtml({ phase: ACA_PHASE.NOT_CONNECTED, reason: '<b>hi</b>' });
  assert.ok(!html.includes('<b>hi</b>'), 'raw markup leaked into the not-connected note');
  assert.ok(html.includes('&lt;b&gt;hi&lt;/b&gt;'), 'the reason was not escaped');
});

check('acaStatusCardHtml renders Connected with watcher/Ralph/last-dispatch rows and Retry/Learn more', () => {
  const html = acaStatusCardHtml({
    phase: ACA_PHASE.CONNECTED,
    watcher: 'Online \u00b7 watch-only',
    ralph: 'Last sweep 4m ago',
    lastDispatch: 'swigerb/squad-hub \u00b7 running',
  });
  assert.match(html, /class="status done">Connected</);
  assert.match(html, /Online \u00b7 watch-only/);
  assert.match(html, /Last sweep 4m ago/);
  assert.match(html, /swigerb\/squad-hub \u00b7 running/);
  assert.match(html, /data-action="aca-retry">Retry<\/a>/);
  assert.match(html, /Learn more<\/a>/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
