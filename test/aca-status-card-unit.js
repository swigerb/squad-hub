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
  acaStatusCardHtml, acaConnectionCounts, isPersistentAcaJob, acaDispatchSession };`)(mod, mod.exports);

const {
  ACA_PHASE, findWatcherDevice, findRalphDevice, acaWatcherLine, acaRalphLine,
  acaDispatchStatusLabel, acaLastDispatchLine, acaStatusModel, acaStatusCardHtml, acaConnectionCounts, isPersistentAcaJob, acaDispatchSession,
} = mod.exports;

check('a connected ACA service is flagged beside the counts, never added to them', () => {
  assert.deepStrictEqual(acaConnectionCounts({}, ACA_PHASE.CONNECTED), {
    devices: 0, online: 0, sessions: 0, service: 1,
  });
  for (const phase of [undefined, ACA_PHASE.CHECKING, ACA_PHASE.NOT_CONNECTED]) {
    assert.deepStrictEqual(acaConnectionCounts({}, phase), {
      devices: 0, online: 0, sessions: 0, service: 0,
    });
  }
  assert.deepStrictEqual(acaConnectionCounts({ devices: 2, online: 1, sessions: 3 }, ACA_PHASE.CONNECTED), {
    devices: 2, online: 1, sessions: 3, service: 1,
  }, 'two real devices stay two with the service connected, not three');
});

check('the persistent watcher and Ralph jobs are recognized by verified role first, then by job naming', () => {
  assert.strictEqual(isPersistentAcaJob({ kind: 'aca', meta: { role: 'watch' }, name: 'anything' }), true);
  assert.strictEqual(isPersistentAcaJob({ kind: 'aca', meta: { role: 'ralph' }, name: 'anything' }), true);
  assert.strictEqual(isPersistentAcaJob({ kind: 'aca', meta: null, name: 'aca-ca-squad-aca-watch--0000016-f4848bdc9-c77w5' }), true);
  assert.strictEqual(isPersistentAcaJob({ kind: 'aca', meta: null, name: 'aca-ca-squad-aca-ralph--0000004-abc12345-x1y2z' }), true);
  // A verified role outranks a name that merely looks like another job.
  assert.strictEqual(isPersistentAcaJob({ kind: 'aca', meta: { role: 'run' }, name: 'aca-ca-squad-aca-watch--0000016-f4848bdc9-c77w5' }), false);
  assert.strictEqual(isPersistentAcaJob({ kind: 'aca', meta: { repo: 'acme/widgets', issue: 42 }, name: 'squad-run-42-xyz' }), false);
  assert.strictEqual(isPersistentAcaJob({ kind: 'cloud', meta: { role: 'watch' }, name: 'squad-hub-watcher' }), false);
  assert.strictEqual(isPersistentAcaJob(null), false);
});

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

  // PREFERENCE, not mere detection: a verified device and a name-only device
  // compete for the same role, and the verified one is the LESS alive and
  // older. Presence and recency alone would pick the name match, so only a
  // real "explicit role first" rule returns the verified device, whichever
  // way round the roster is ordered.
  const nameWatch = acaDev({ name: REAL_WATCH_DEVICE_NAME, meta: null, presence: 'online', lastSeen: Date.now() });
  const verifiedWatch = acaDev({ name: 'renamed-job', meta: { role: 'watch' }, presence: 'offline', lastSeen: Date.now() - 600000 });
  assert.strictEqual(findWatcherDevice([nameWatch, verifiedWatch]), verifiedWatch, 'a name match outranked the verified role');
  assert.strictEqual(findWatcherDevice([verifiedWatch, nameWatch]), verifiedWatch, 'roster order changed the answer');
  assert.strictEqual(findWatcherDevice([nameWatch]), nameWatch, 'the name fallback still works when no device verifies a role');

  // Same rule for Ralph, and an online verified device still wins over a
  // fresher name match.
  const nameRalph = acaDev({ name: 'aca-ca-squad-aca-ralph--0000004-abc12345-x1y2z', meta: null, presence: 'online', lastSeen: Date.now() });
  const verifiedRalph = acaDev({ name: 'renamed-ralph', meta: { role: 'ralph' }, presence: 'online', lastSeen: Date.now() - 600000 });
  assert.strictEqual(findRalphDevice([nameRalph, verifiedRalph]), verifiedRalph, 'a fresher name match outranked the verified Ralph');
  assert.strictEqual(findRalphDevice([verifiedRalph, nameRalph]), verifiedRalph);

  // A non-ACA device that claims the role never joins the competition.
  const cloudClaim = dev({ name: 'claims-watch', kind: 'cloud', meta: { role: 'watch' }, presence: 'online', lastSeen: Date.now() });
  assert.strictEqual(findWatcherDevice([cloudClaim, nameWatch]), nameWatch, 'a non-ACA claim displaced the ACA name match');
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

  // The kind filter is the boundary on BOTH paths, not only the name fallback:
  // a non-ACA device that explicitly claims the role through meta.role is
  // refused too, and for either persistent job.
  const RALPH_NAME = 'aca-ca-squad-aca-ralph--0000004-abc12345-x1y2z';
  for (const kind of ['cloud', 'local', undefined]) {
    const watch = dev({ name: 'claims-watch', kind, meta: { role: 'watch' } });
    const ralph = dev({ name: 'claims-ralph', kind, meta: { role: 'ralph' } });
    const named = dev({ name: RALPH_NAME, kind, meta: null });
    assert.strictEqual(findWatcherDevice([watch]), null, `a ${kind} device claiming meta.role watch was accepted`);
    assert.strictEqual(findRalphDevice([ralph]), null, `a ${kind} device claiming meta.role ralph was accepted`);
    assert.strictEqual(findRalphDevice([named]), null, `a ${kind} device named like Ralph was accepted`);
    assert.strictEqual(findWatcherDevice([ralph, named]), null, `a ${kind} device claiming another role leaked into watch`);
  }

  // Precedence: a non-ACA device with an explicit role can never displace, or
  // be chosen ahead of, the real ACA job, whichever order the roster lists
  // them in and however recently the impostor was seen.
  const real = acaDev({ name: REAL_WATCH_DEVICE_NAME, presence: 'offline', lastSeen: 1000 });
  const impostor = dev({ name: 'impostor', kind: 'cloud', presence: 'online', lastSeen: 9000, meta: { role: 'watch' } });
  assert.strictEqual(findWatcherDevice([impostor, real]), real, 'a non-ACA meta.role device outranked the ACA job');
  assert.strictEqual(findWatcherDevice([real, impostor]), real, 'roster order let a non-ACA meta.role device win');
  const realByRole = acaDev({ name: 'aca-job', meta: { role: 'ralph' }, presence: 'offline', lastSeen: 1000 });
  const ralphImpostor = dev({ name: 'impostor', kind: 'local', presence: 'online', lastSeen: 9000, meta: { role: 'ralph' } });
  assert.strictEqual(findRalphDevice([ralphImpostor, realByRole]), realByRole);
  assert.strictEqual(findRalphDevice([realByRole, ralphImpostor]), realByRole);
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
// findWatcherDevice / findRalphDevice -- live/fresh selection, order-reversal
// (#233's third review, finding 2)
// ---------------------------------------------------------------------------

check('findWatcherDevice prefers an online, fresh record over an older offline one, whichever order the roster lists them in', () => {
  const stale = acaDev({ name: 'aca-ca-squad-aca-watch--1-old', presence: 'offline', lastSeen: Date.now() - 600000 });
  const fresh = acaDev({ name: 'aca-ca-squad-aca-watch--2-new', presence: 'online', lastSeen: Date.now() });
  assert.strictEqual(findWatcherDevice([stale, fresh]), fresh, 'old-offline-first order picked the stale record');
  assert.strictEqual(findWatcherDevice([fresh, stale]), fresh, 'reversing roster order changed the winner');
});

check('findWatcherDevice prefers presence over mere recency: an online-but-older record beats an offline-but-more-recently-seen one', () => {
  // Isolates the presence-ranking step from the lastSeen tie-break: the
  // OFFLINE record here has the LATER lastSeen timestamp, so a selection
  // that (incorrectly) fell straight through to comparing lastSeen without
  // ranking presence first would pick the wrong one.
  const offlineButRecentlySeen = acaDev({ name: 'aca-ca-squad-aca-watch--1-x', presence: 'offline', lastSeen: Date.now() });
  const onlineButOlder = acaDev({ name: 'aca-ca-squad-aca-watch--2-y', presence: 'online', lastSeen: Date.now() - 500000 });
  assert.strictEqual(findWatcherDevice([offlineButRecentlySeen, onlineButOlder]), onlineButOlder);
  assert.strictEqual(findWatcherDevice([onlineButOlder, offlineButRecentlySeen]), onlineButOlder,
    'reversing roster order changed the winner');
});

check('findWatcherDevice prefers the more recently seen record when both candidates are equally online', () => {
  const older = acaDev({ name: 'aca-ca-squad-aca-watch--1-old', presence: 'online', lastSeen: Date.now() - 5000 });
  const newer = acaDev({ name: 'aca-ca-squad-aca-watch--2-new', presence: 'online', lastSeen: Date.now() });
  assert.strictEqual(findWatcherDevice([older, newer]), newer);
  assert.strictEqual(findWatcherDevice([newer, older]), newer, 'reversing roster order changed the winner');
});

check('findWatcherDevice still honestly reports the only historical record as Offline when nothing newer is online', () => {
  const onlyOld = acaDev({ name: 'aca-ca-squad-aca-watch--1-old', presence: 'offline', lastSeen: Date.now() - 600000 });
  assert.strictEqual(findWatcherDevice([onlyOld]), onlyOld);
  assert.strictEqual(acaWatcherLine([onlyOld]), 'Offline');
});

check('findRalphDevice applies the same live-over-offline selection as findWatcherDevice, order-reversed', () => {
  const stale = acaDev({ name: 'aca-ca-squad-aca-ralph--1-old', presence: 'offline', lastSeen: Date.now() - 600000 });
  const fresh = acaDev({ name: 'aca-ca-squad-aca-ralph--2-new', presence: 'online', lastSeen: Date.now() });
  assert.strictEqual(findRalphDevice([stale, fresh]), fresh);
  assert.strictEqual(findRalphDevice([fresh, stale]), fresh, 'reversing roster order changed the winner');
});

// ---------------------------------------------------------------------------
// findWatcherDevice / findRalphDevice -- an explicit role excludes the OTHER
// role's name-based fallback; canonical job identity, not a slug substring
// (#233's third review, findings 3)
// ---------------------------------------------------------------------------

check('a device explicitly self-reporting meta.role "watch" is never ALSO picked up as Ralph by name coincidence', () => {
  // Named exactly like the established Ralph job convention, but VERIFIED
  // (meta.role) as the watcher. The explicit, recognized role is
  // authoritative and exclusive: it must win the watcher role AND must
  // exclude this same record from Ralph's own name-based fallback.
  const d = acaDev({ name: 'aca-ca-squad-aca-ralph--1-abc', meta: { role: 'watch' } });
  assert.strictEqual(findWatcherDevice([d]), d);
  assert.strictEqual(findRalphDevice([d]), null);
});

check('a device explicitly self-reporting meta.role "ralph" is never ALSO picked up as the watcher by name coincidence', () => {
  const d = acaDev({ name: 'aca-ca-squad-aca-watch--1-abc', meta: { role: 'ralph' } });
  assert.strictEqual(findRalphDevice([d]), d);
  assert.strictEqual(findWatcherDevice([d]), null);
});

check('findWatcherDevice rejects a job-identity token run embedded mid-slug, never anchored to a real revision suffix', () => {
  // "squad", "aca", "watch" appear here consecutively purely because an
  // implementation session's own slug happens to end
  // "...-squad-aca-watch-card" -- immediately followed by a plain word, never
  // a revision number and never the end of the name, which is what the real
  // Container App Job convention always does. This is the exact slug Scout's
  // review named: it must stay unknown, not masquerade as the watcher.
  const d = acaDev({ name: 'aca-caj-squad-aca-session-repair-squad-aca-watch-card' });
  assert.strictEqual(findWatcherDevice([d]), null);
  assert.strictEqual(findRalphDevice([d]), null);
});

check('findWatcherDevice still matches the canonical convention when the role token is the very last token (no suffix)', () => {
  const d = acaDev({ name: 'squad-aca-watch' });
  assert.strictEqual(findWatcherDevice([d]), d);
});

// A fourth Scout review (#233): the mid-slug rejection above still scanned
// EVERY token position looking for the "squad","aca",role run, anchoring
// only on what followed it (a number or the end). An adversarial name can
// supply that too -- a fabricated, revision-shaped numeric suffix tacked
// onto an embedded match -- and the old scan accepted it. The real
// convention only ever has the run starting the name outright, or starting
// right after the literal "aca","ca" prefix; these two checks anchor to
// those START positions instead of scanning the whole token list.
check('findWatcherDevice rejects an embedded canonical run padded with a fabricated revision-shaped suffix, anchored to known job identity only (#233 fourth review)', () => {
  // "squad","aca","watch" appears here too, followed by "0000016" -- a
  // purely numeric token that looks exactly like a real Azure revision
  // suffix -- but this name is an implementation session's own slug that
  // merely embeds the run partway through, not the known job identity
  // itself (which would start with "aca","ca" or be the bare run outright).
  const d = acaDev({ name: 'aca-caj-squad-aca-session-repair-squad-aca-watch--0000016-x' });
  assert.strictEqual(findWatcherDevice([d]), null);
  assert.strictEqual(findRalphDevice([d]), null);
});

check('findRalphDevice rejects the same embedded-run-plus-fabricated-suffix pattern for the ralph role', () => {
  const d = acaDev({ name: 'aca-caj-squad-aca-session-repair-squad-aca-ralph--0000031-y' });
  assert.strictEqual(findRalphDevice([d]), null);
  assert.strictEqual(findWatcherDevice([d]), null);
});

check('findWatcherDevice still requires the role token itself to be followed by nothing or a numeric revision, even at a known START position', () => {
  // The run starts the name outright ("squad","aca","watch" at index 0, the
  // bare form), so the START-position anchor alone is already satisfied --
  // but it is followed by the plain word "extra", never a revision number
  // and never the end of the name. The suffix anchor must still reject this
  // independently of the start-position anchor, which this isolates from
  // the mid-slug tests above (those are rejected by the START anchor before
  // the suffix is ever checked).
  const d = acaDev({ name: 'squad-aca-watch-extra' });
  assert.strictEqual(findWatcherDevice([d]), null);
});

check('findWatcherDevice requires the literal "squad","aca" tokens immediately before the role word, not merely the role word somewhere', () => {
  // The role word alone, however well-anchored to the end of the name or a
  // numeric suffix, is not the established convention -- "squad" and "aca"
  // must immediately precede it. Without this, a name that merely ends in
  // the role word (coincidentally, not because it IS the ACA job) would
  // also match.
  const d = acaDev({ name: 'random-op-watch' });
  assert.strictEqual(findWatcherDevice([d]), null);
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

check('dispatch workflow success does not claim that the ACA job succeeded', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'completed', conclusion: 'success' }),
    'Dispatch workflow succeeded; job outcome not confirmed');
  assert.strictEqual(acaDispatchStatusLabel({ state: 'completed' }),
    'Dispatch workflow completed; job outcome not confirmed');
});

check('acaDispatchStatusLabel labels a non-success conclusion as "completed (<conclusion>)"', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'completed', conclusion: 'failure' }), 'dispatch workflow completed (failure)');
});

check('acaDispatchStatusLabel labels an error state with its reason', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'error', reason: 'workflow not found' }),
    'error: workflow not found');
});

check('acaDispatchStatusLabel labels an unsupported run honestly', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'unsupported' }), "can't confirm (older workflow)");
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

// ---------------------------------------------------------------------------
// #262: the job's own outcome, from the session the dispatch provably started
// ---------------------------------------------------------------------------

const NOT_CONFIRMED = 'Dispatch workflow succeeded; job outcome not confirmed';
const dispatchRow = (over = {}) => ({
  id: 'trk-1', owner: 'swigerb', repo: 'squad-hub', executionName: 'job-abc123',
  status: {
    state: 'completed', conclusion: 'success', runId: 7, runAttempt: 1, executionName: 'job-abc123',
  },
  ...over,
});
const acaDevice = (over = {}) => ({ deviceId: 'aca-job-abc123', kind: 'aca', presence: 'online', ...over });
const acaGroups = (sessions, deviceId = 'aca-job-abc123') => [{ device: { deviceId }, sessions: sessions.map((st) => ({ deviceId, status: st })) }];
const ctx = (over = {}) => ({ devices: [acaDevice()], groups: acaGroups(['done']), tracked: [], ...over });
const lastLine = (rows, c) => acaLastDispatchLine(rows, c);
const modelLine = (rows, c) => acaStatusModel({ phase: ACA_PHASE.CONNECTED, dispatches: rows, ...c }).lastDispatch;

check('acaDispatchStatusLabel reports the matched session outcome in session vocabulary', () => {
  const run = dispatchRow().status;
  assert.strictEqual(acaDispatchStatusLabel(run, { status: 'done' }), 'job completed');
  assert.strictEqual(acaDispatchStatusLabel(run, { status: 'failed' }), 'job failed');
  assert.strictEqual(acaDispatchStatusLabel(run, { status: 'stopped' }), 'job stopped');
  for (const st of ['starting', 'active', 'waiting_approval', 'idle']) {
    assert.strictEqual(acaDispatchStatusLabel({ ...run, state: 'in_progress', conclusion: null }, { status: st }), 'job running');
  }
});

check('acaDispatchStatusLabel never infers an outcome without a session, or from an unknown/disconnected one', () => {
  const run = dispatchRow().status;
  assert.strictEqual(acaDispatchStatusLabel(run), NOT_CONFIRMED);
  assert.strictEqual(acaDispatchStatusLabel(run, null), NOT_CONFIRMED);
  assert.strictEqual(acaDispatchStatusLabel(run, { status: 'disconnected' }), NOT_CONFIRMED);
  assert.strictEqual(acaDispatchStatusLabel(run, { status: 'bogus' }), NOT_CONFIRMED);
  assert.strictEqual(acaDispatchStatusLabel(run, { status: 'toString' }), NOT_CONFIRMED);
});

check('acaDispatchStatusLabel keeps a failed dispatch run and queued states in their own words', () => {
  assert.strictEqual(acaDispatchStatusLabel({ state: 'completed', conclusion: 'failure' }, { status: 'done' }), 'dispatch workflow completed (failure)');
  assert.strictEqual(acaDispatchStatusLabel({ state: 'queued' }, { status: 'done' }), 'queued');
});

  check('acaLastDispatchLine: confirmed execution + matching device + running session says running', () => {
    const row = dispatchRow({ status: { ...dispatchRow().status, state: 'in_progress', conclusion: null } });
    assert.strictEqual(lastLine([row], ctx({ groups: acaGroups(['active']) })), 'swigerb/squad-hub \u00b7 job running');
  });
  check('acaLastDispatchLine: confirmed execution + matching device + finished session says completed', () => {
    assert.strictEqual(lastLine([dispatchRow()], ctx()), 'swigerb/squad-hub \u00b7 job completed');
  });
  check('acaLastDispatchLine: failed and stopped sessions say failed / stopped', () => {
    assert.strictEqual(lastLine([dispatchRow()], ctx({ groups: acaGroups(['failed']) })), 'swigerb/squad-hub \u00b7 job failed');
    assert.strictEqual(lastLine([dispatchRow()], ctx({ groups: acaGroups(['stopped']) })), 'swigerb/squad-hub \u00b7 job stopped');
  });
  check('acaLastDispatchLine: no executionName stays not confirmed', () => {
    const row = dispatchRow({ executionName: null, status: { ...dispatchRow().status, executionName: null } });
    assert.ok(lastLine([row], ctx()).endsWith(NOT_CONFIRMED));
  });
  check('acaLastDispatchLine: no matching device stays not confirmed', () => {
    assert.ok(lastLine([dispatchRow()], ctx({ devices: [acaDevice({ deviceId: 'aca-other-run' })], groups: acaGroups(['done'], 'aca-other-run') })).endsWith(NOT_CONFIRMED));
  });
  check('acaLastDispatchLine: a mismatched attempt stays not confirmed', () => {
    const noAttempt = dispatchRow({ status: { ...dispatchRow().status, runAttempt: null } });
    assert.ok(lastLine([noAttempt], ctx()).endsWith(NOT_CONFIRMED), 'a receipt with no valid attempt must not join');
    const tracked = [{ trackerId: 'trk-1', repo: 'swigerb/squad-hub', issue: 5, runId: 7, runAttempt: 2, executionName: null }];
    assert.ok(lastLine([dispatchRow()], ctx({ tracked })).endsWith(NOT_CONFIRMED), 'a stale lower attempt must not join');
  });
  check('acaLastDispatchLine: a mismatched issue stays not confirmed', () => {
    const tracked = [{ trackerId: 'trk-1', repo: 'swigerb/squad-hub', issue: 5, runId: 7, runAttempt: 1, executionName: null }];
    const devices = [acaDevice({ meta: { issue: 6 } })];
    assert.ok(lastLine([dispatchRow()], ctx({ tracked, devices })).endsWith(NOT_CONFIRMED));
    const same = [acaDevice({ meta: { issue: 5 } })];
    assert.ok(lastLine([dispatchRow()], ctx({ tracked, devices: same })).endsWith('job completed'));
  });
  check('acaLastDispatchLine: a device with no session stays not confirmed, heartbeat is not an outcome', () => {
    assert.ok(lastLine([dispatchRow()], ctx({ groups: [{ device: { deviceId: 'aca-job-abc123' }, sessions: [] }] })).endsWith(NOT_CONFIRMED));
    assert.ok(lastLine([dispatchRow()], ctx({ groups: [] })).endsWith(NOT_CONFIRMED));
    assert.ok(lastLine([dispatchRow()], { devices: [acaDevice({ presence: 'online', lastSeen: Date.now() })] }).endsWith(NOT_CONFIRMED));
  });

  check('acaStatusModel: confirmed execution + matching device + running session says running', () => {
    const row = dispatchRow({ status: { ...dispatchRow().status, state: 'in_progress', conclusion: null } });
    assert.strictEqual(modelLine([row], ctx({ groups: acaGroups(['active']) })), 'swigerb/squad-hub \u00b7 job running');
  });
  check('acaStatusModel: confirmed execution + matching device + finished session says completed', () => {
    assert.strictEqual(modelLine([dispatchRow()], ctx()), 'swigerb/squad-hub \u00b7 job completed');
  });
  check('acaStatusModel: failed and stopped sessions say failed / stopped', () => {
    assert.strictEqual(modelLine([dispatchRow()], ctx({ groups: acaGroups(['failed']) })), 'swigerb/squad-hub \u00b7 job failed');
    assert.strictEqual(modelLine([dispatchRow()], ctx({ groups: acaGroups(['stopped']) })), 'swigerb/squad-hub \u00b7 job stopped');
  });
  check('acaStatusModel: no executionName stays not confirmed', () => {
    const row = dispatchRow({ executionName: null, status: { ...dispatchRow().status, executionName: null } });
    assert.ok(modelLine([row], ctx()).endsWith(NOT_CONFIRMED));
  });
  check('acaStatusModel: no matching device stays not confirmed', () => {
    assert.ok(modelLine([dispatchRow()], ctx({ devices: [acaDevice({ deviceId: 'aca-other-run' })], groups: acaGroups(['done'], 'aca-other-run') })).endsWith(NOT_CONFIRMED));
  });
  check('acaStatusModel: a mismatched attempt stays not confirmed', () => {
    const noAttempt = dispatchRow({ status: { ...dispatchRow().status, runAttempt: null } });
    assert.ok(modelLine([noAttempt], ctx()).endsWith(NOT_CONFIRMED), 'a receipt with no valid attempt must not join');
    const tracked = [{ trackerId: 'trk-1', repo: 'swigerb/squad-hub', issue: 5, runId: 7, runAttempt: 2, executionName: null }];
    assert.ok(modelLine([dispatchRow()], ctx({ tracked })).endsWith(NOT_CONFIRMED), 'a stale lower attempt must not join');
  });
  check('acaStatusModel: a mismatched issue stays not confirmed', () => {
    const tracked = [{ trackerId: 'trk-1', repo: 'swigerb/squad-hub', issue: 5, runId: 7, runAttempt: 1, executionName: null }];
    const devices = [acaDevice({ meta: { issue: 6 } })];
    assert.ok(modelLine([dispatchRow()], ctx({ tracked, devices })).endsWith(NOT_CONFIRMED));
    const same = [acaDevice({ meta: { issue: 5 } })];
    assert.ok(modelLine([dispatchRow()], ctx({ tracked, devices: same })).endsWith('job completed'));
  });
  check('acaStatusModel: a device with no session stays not confirmed, heartbeat is not an outcome', () => {
    assert.ok(modelLine([dispatchRow()], ctx({ groups: [{ device: { deviceId: 'aca-job-abc123' }, sessions: [] }] })).endsWith(NOT_CONFIRMED));
    assert.ok(modelLine([dispatchRow()], ctx({ groups: [] })).endsWith(NOT_CONFIRMED));
    assert.ok(modelLine([dispatchRow()], { devices: [acaDevice({ presence: 'online', lastSeen: Date.now() })] }).endsWith(NOT_CONFIRMED));
  });

check('acaDispatchSession refuses a device claimed by another dispatch and an ambiguous session list', () => {
  const other = dispatchRow({ id: 'trk-2' });
  assert.strictEqual(acaDispatchSession(dispatchRow(), { ...ctx(), dispatches: [dispatchRow(), other] }), null);
  assert.strictEqual(acaDispatchSession(dispatchRow(), ctx({ groups: acaGroups(['done', 'failed']) })), null);
  assert.strictEqual(acaDispatchSession(dispatchRow(), ctx()).status, 'done');
});

check('the last-dispatch line still escapes text when a session outcome is shown', () => {
  const line = lastLine([dispatchRow({ owner: '<b>' })], ctx());
  assert.ok(!line.includes('<b>') && line.includes('&lt;b&gt;'));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
