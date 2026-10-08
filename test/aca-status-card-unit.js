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

// ---------------------------------------------------------------------------
// findWatcherDevice / findRalphDevice
// ---------------------------------------------------------------------------

check('findWatcherDevice matches a device named "squad-aca watcher"', () => {
  const d = dev({ name: 'squad-aca watcher' });
  assert.strictEqual(findWatcherDevice([dev({ name: 'laptop' }), d]), d);
});

check('findWatcherDevice matches case-insensitively', () => {
  const d = dev({ name: 'SQUAD-ACA WATCHER' });
  assert.strictEqual(findWatcherDevice([d]), d);
});

check('findWatcherDevice returns null when no watcher device exists', () => {
  assert.strictEqual(findWatcherDevice([dev({ name: 'laptop' }), dev({ name: 'squad-aca ralph' })]), null);
});

check('findWatcherDevice treats an empty roster as "no watcher", not a crash', () => {
  assert.strictEqual(findWatcherDevice([]), null);
  assert.strictEqual(findWatcherDevice(), null);
});

check('findRalphDevice matches a device named "squad-aca ralph"', () => {
  const d = dev({ name: 'squad-aca ralph' });
  assert.strictEqual(findRalphDevice([dev({ name: 'squad-aca watcher' }), d]), d);
});

check('findRalphDevice returns null when no Ralph device exists', () => {
  assert.strictEqual(findRalphDevice([dev({ name: 'squad-aca watcher' })]), null);
});

// ---------------------------------------------------------------------------
// acaWatcherLine
// ---------------------------------------------------------------------------

check('acaWatcherLine says "Not connected" with no watcher device', () => {
  assert.strictEqual(acaWatcherLine([]), 'Not connected');
});

check('acaWatcherLine reports an online watcher as "Online · watch-only"', () => {
  const line = acaWatcherLine([dev({ name: 'squad-aca watcher', presence: 'online' })]);
  assert.strictEqual(line, 'Online \u00b7 watch-only');
});

check('acaWatcherLine reports a stale watcher as "Stale · watch-only"', () => {
  const line = acaWatcherLine([dev({ name: 'squad-aca watcher', presence: 'stale' })]);
  assert.strictEqual(line, 'Stale \u00b7 watch-only');
});

check('acaWatcherLine reports an offline watcher as "Offline · watch-only"', () => {
  const line = acaWatcherLine([dev({ name: 'squad-aca watcher', presence: 'offline' })]);
  assert.strictEqual(line, 'Offline \u00b7 watch-only');
});

// ---------------------------------------------------------------------------
// acaRalphLine
// ---------------------------------------------------------------------------

check('acaRalphLine says "Not connected" with no Ralph device', () => {
  assert.strictEqual(acaRalphLine([]), 'Not connected');
});

check('acaRalphLine says "No sweeps yet" when Ralph has never reported a heartbeat', () => {
  const line = acaRalphLine([dev({ name: 'squad-aca ralph', lastSeen: 0 })]);
  assert.strictEqual(line, 'No sweeps yet');
});

check('acaRalphLine reports "Last sweep <ago>" from the device\'s own lastSeen', () => {
  const line = acaRalphLine([dev({ name: 'squad-aca ralph', lastSeen: Date.now() - 4 * 60 * 1000 })]);
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
    dev({ name: 'squad-aca watcher', presence: 'online' }),
    dev({ name: 'squad-aca ralph', lastSeen: Date.now() - 60 * 1000 }),
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
