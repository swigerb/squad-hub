'use strict';
/**
 * #225: an offline/unreachable ACA session must not be shown as an
 * actionable "Awaiting your reply" card.
 *
 * Before this, a session's displayed status came from `s.status` alone. A
 * non-terminal status (`idle`, `waiting_approval`, `active`, `starting`) on a
 * device the hub can no longer reach read exactly like a live, actionable
 * prompt -- "Awaiting your reply", amber row highlight and all -- even though
 * the transcript cannot load, the composer cannot be verified, and `Stop`
 * 409s. The fix threads the session's DEVICE through the same pure functions
 * the row, the badge and the sort already share (list-controls-unit.js),
 * plus a new `cleanupControls` that decides what the detail header's
 * Stop/Forget buttons should look like -- all DOM-free, same as
 * list-controls-unit.js, so the decision can be proven without a browser.
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
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\t')[0].split('\n')[0]}`);
  }
}

const src = readWebSource();
const mod = { exports: {} };
new Function('module', 'exports', `${src}
module.exports = {
  isStaleSession, isDeviceUnreachable, cleanupControls, STOP_UNREACHABLE_REASON,
  statusLabel, statusBadge, activityLine, needsAttention, sessionRow, buildView,
};`)(mod, mod.exports);

const {
  isStaleSession, isDeviceUnreachable, cleanupControls, STOP_UNREACHABLE_REASON,
  statusLabel, statusBadge, activityLine, needsAttention, sessionRow, buildView,
} = mod.exports;

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

let n = 0;
function sess(over = {}) {
  n += 1;
  return {
    id: `s${n}`, key: `k${n}`, prompt: `prompt ${n}`, status: 'idle',
    cwd: '/work', startedAt: NOW - HOUR, toolCallCount: 0, pendingApprovals: [],
    ...over,
  };
}
function device(presence, over = {}) {
  return { name: 'aca-job-1', deviceId: 'aca-job-1', platform: 'linux', presence, ...over };
}

// ---------------------------------------------------------------------------
// isDeviceUnreachable / isStaleSession
// ---------------------------------------------------------------------------

check('an online device is reachable', () => {
  assert.strictEqual(isDeviceUnreachable(device('online')), false);
});

check('a stale device counts as unreachable, same as offline', () => {
  assert.strictEqual(isDeviceUnreachable(device('stale')), true);
  assert.strictEqual(isDeviceUnreachable(device('offline')), true);
});

check('no device at all is not "unreachable" -- there is nothing to ask', () => {
  assert.strictEqual(isDeviceUnreachable(undefined), false);
  assert.strictEqual(isDeviceUnreachable(null), false);
});

check('idle on an unreachable device is stale -- the exact #225 report', () => {
  assert.strictEqual(isStaleSession(sess({ status: 'idle' }), device('offline')), true);
});

check('waiting_approval on an unreachable device is stale too', () => {
  assert.strictEqual(isStaleSession(sess({ status: 'waiting_approval' }), device('offline')), true);
});

check('pending approvals on an unreachable device are stale, whatever the status says', () => {
  const s = sess({ status: 'active', pendingApprovals: [{ optionId: 'allow_once' }] });
  assert.strictEqual(isStaleSession(s, device('stale')), true);
});

check('idle on an ONLINE device is not stale -- an ordinary actionable reply', () => {
  assert.strictEqual(isStaleSession(sess({ status: 'idle' }), device('online')), false);
});

check('a FINISHED session on an unreachable device is not "stale" -- nothing is stuck', () => {
  for (const status of ['done', 'failed', 'stopped', 'disconnected']) {
    assert.strictEqual(isStaleSession(sess({ status }), device('offline')), false, status);
  }
});

check('no device at all is never stale', () => {
  assert.strictEqual(isStaleSession(sess({ status: 'idle' }), null), false);
});

// ---------------------------------------------------------------------------
// What the person is told: statusLabel / statusBadge / activityLine
// ---------------------------------------------------------------------------

check('the label says unreachable, not "Awaiting your reply"', () => {
  const label = statusLabel(sess({ status: 'idle' }), device('offline'));
  assert.ok(/unreachable/i.test(label), label);
  assert.ok(!/awaiting your reply/i.test(label), label);
});

check('an online idle session keeps its ordinary label', () => {
  assert.strictEqual(statusLabel(sess({ status: 'idle' }), device('online')), 'Awaiting your reply');
});

check('the badge is styled "stale", never the amber "needs approval"/"review" classes', () => {
  const badge = statusBadge(sess({ status: 'idle' }), device('offline'));
  assert.ok(badge.includes('status stale'), badge);
  assert.ok(!badge.includes('attention'), badge);
  assert.ok(!badge.includes('"status review"'), badge);
});

check('the activity line says there is nothing to answer, not "Waiting for input"', () => {
  const line = activityLine(sess({ status: 'idle' }), device('offline'));
  assert.ok(/unreachable/i.test(line), line);
  assert.ok(!/waiting for input/i.test(line), line);
});

// ---------------------------------------------------------------------------
// needsAttention / sort+row placement
// ---------------------------------------------------------------------------

check('a stale session no longer counts as "needs attention"', () => {
  const s = sess({ status: 'waiting_approval', pendingApprovals: [{ optionId: 'allow_once' }] });
  assert.strictEqual(needsAttention(s, device('offline')), false);
  // The identical session on a live device still does.
  assert.strictEqual(needsAttention(s, device('online')), true);
});

check('a stale row never carries the "attention" (amber/blocked) class', () => {
  const html = sessionRow(sess({ status: 'idle' }), 'aca-job-1', { device: device('offline') });
  assert.ok(!html.includes('row attention'), html);
});

check('buildView does not float a stale card above ordinary rows', () => {
  const stale = sess({ status: 'waiting_approval', pendingApprovals: [{ optionId: 'allow_once' }], startedAt: NOW - HOUR });
  const ordinary = sess({ status: 'active', startedAt: NOW - 2 * HOUR });
  const groups = [{ device: device('offline'), sessions: [stale] }, { device: device('online', { name: 'laptop', deviceId: 'laptop' }), sessions: [ordinary] }];
  const view = buildView({ groups, groupBy: 'none', sortBy: 'started_desc', now: NOW });
  const keys = view.sections[0].entries.map((e) => e.session.key);
  // Newest-first is the plain `started_desc` order: the stale card does not
  // jump the queue just because its status still reads "waiting_approval".
  assert.deepStrictEqual(keys, [stale.key, ordinary.key]);
});

// ---------------------------------------------------------------------------
// cleanupControls -- the detail header's Stop/Forget pair
// ---------------------------------------------------------------------------

check('Stop is disabled whenever the device is unreachable, whatever the status', () => {
  assert.strictEqual(cleanupControls(sess({ status: 'idle' }), device('offline')).stopDisabled, true);
  assert.strictEqual(cleanupControls(sess({ status: 'done' }), device('offline')).stopDisabled, true);
  assert.strictEqual(cleanupControls(sess({ status: 'idle' }), device('online')).stopDisabled, false);
});

check('a disabled Stop explains itself and points at the cleanup action', () => {
  const c = cleanupControls(sess({ status: 'idle' }), device('offline'));
  assert.strictEqual(c.stopReason, STOP_UNREACHABLE_REASON);
  assert.ok(/forget stale session/i.test(c.stopReason), c.stopReason);
  // A live device gets no excuse to show -- there is nothing to explain.
  assert.strictEqual(cleanupControls(sess({ status: 'idle' }), device('online')).stopReason, '');
});

check('Forget is offered only for a session actually stuck on an unreachable device', () => {
  assert.strictEqual(cleanupControls(sess({ status: 'idle' }), device('offline')).forgetVisible, true);
  // Already finished: nothing here needs the cleanup action (the Tidy menu
  // covers it), so it stays hidden rather than cluttering a normal card.
  assert.strictEqual(cleanupControls(sess({ status: 'done' }), device('offline')).forgetVisible, false);
  // Reachable device: Stop is live, so there is nothing to clean up either.
  assert.strictEqual(cleanupControls(sess({ status: 'idle' }), device('online')).forgetVisible, false);
});

check('THE PROPERTY THAT MATTERS: a stale session is never left with only disabled controls', () => {
  // Exactly the shape #225 reports: Stop 409s and nothing else was offered.
  // Any non-terminal status, any unreachable presence -- Forget must be live
  // whenever Stop is not, so the person always has one working button.
  for (const status of ['active', 'starting', 'waiting_approval', 'idle']) {
    for (const presence of ['stale', 'offline']) {
      const c = cleanupControls(sess({ status }), device(presence));
      assert.ok(!(c.stopDisabled && !c.forgetVisible),
        `status=${status} presence=${presence}: Stop disabled with no Forget offered strands the user`);
    }
  }
});

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 100);
