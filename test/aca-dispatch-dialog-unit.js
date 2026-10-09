'use strict';
/**
 * The New ACA job dialog (#178), and the "Queued on ACA" pending rows that
 * stand in for a session until a real `aca-` device attaches.
 *
 * This dialog dispatches straight through `POST /api/aca/dispatch` (#177,
 * hardened in #213), so the interesting properties are: a request is never
 * sent with an obviously-incomplete body, the status this hub can actually
 * observe (a GitHub Actions run) maps onto the four steps #178 asks for, and
 * "has the job attached yet" is decided ONLY from data the client already
 * polls (`/api/overview`), never a dedicated request of its own.
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
const browser = { exports: {} };
new Function('module', `${src}\nmodule.exports = {
  acaBuildDispatchBody, acaStepsForStatus, acaPendingAttached, acaPendingMatch, acaPendingRowHtml,
  acaPendingSectionHtml, ACA_DISPATCH_STEPS, ACA_COMPLETED_WAIT_MS, ACA_START_TOLERANCE_MS,
  trackAcaDispatch, syncAcaPending, retryAcaPending, state, api,
};`)(browser);
const {
  acaBuildDispatchBody, acaStepsForStatus, acaPendingAttached, acaPendingMatch, acaPendingRowHtml,
  acaPendingSectionHtml, ACA_DISPATCH_STEPS, ACA_COMPLETED_WAIT_MS, ACA_START_TOLERANCE_MS,
  trackAcaDispatch, syncAcaPending, retryAcaPending, state, api,
} = browser.exports;

const REPO = 'swigerb/squad-on-aca';
const baseForm = () => ({
  repo: REPO, prompt: 'Update the docs', issueMode: 'new', newIssueTitle: '', publishPr: true, watchOnly: false,
});

async function checkAsync(name, fn) {
  try {
    await fn(); pass += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n         ${e.message}`);
    console.log(`RESULT\tfail\t${name}\t${String(e.message).split('\n')[0]}`);
  }
}

// --- acaBuildDispatchBody ----------------------------------------------------

check('a complete new-issue form builds a dispatch body', () => {
  const r = acaBuildDispatchBody(baseForm());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.repo, REPO);
  assert.strictEqual(r.value.prompt, 'Update the docs');
  assert.strictEqual(r.value.issue, null);
  assert.deepStrictEqual(r.value.newIssue, { title: 'Update the docs' });
  assert.strictEqual(r.value.publishPr, true);
  assert.strictEqual(r.value.watchOnly, false);
});

check('a blank repository is refused before any request is made', () => {
  const r = acaBuildDispatchBody({ ...baseForm(), repo: '' });
  assert.strictEqual(r.ok, false);
  assert.ok(/repository/i.test(r.reason));
});

check('a malformed repository (not owner/repo) is refused', () => {
  for (const repo of ['just-a-name', 'owner/repo/extra', '../evil']) {
    const r = acaBuildDispatchBody({ ...baseForm(), repo });
    assert.strictEqual(r.ok, false, `accepted ${repo}`);
  }
});

check('blank instructions are refused, new issue or existing', () => {
  const r1 = acaBuildDispatchBody({ ...baseForm(), prompt: '   ' });
  assert.strictEqual(r1.ok, false);
  assert.ok(/instructions/i.test(r1.reason));
  const r2 = acaBuildDispatchBody({
    ...baseForm(), prompt: '', issueMode: 'existing', issueNumber: '72',
  });
  assert.strictEqual(r2.ok, false);
});

check('an existing issue needs a positive integer number', () => {
  for (const issueNumber of ['', '0', '-1', '1.5', 'abc', undefined]) {
    const r = acaBuildDispatchBody({
      ...baseForm(), issueMode: 'existing', issueNumber,
    });
    assert.strictEqual(r.ok, false, `accepted issue number ${JSON.stringify(issueNumber)}`);
  }
  const ok = acaBuildDispatchBody({ ...baseForm(), issueMode: 'existing', issueNumber: '72' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.issue, 72);
  assert.strictEqual(ok.value.newIssue, null);
});

check('a blank new-issue title falls back to acaTitle of the instructions', () => {
  const r = acaBuildDispatchBody({ ...baseForm(), newIssueTitle: '  ', prompt: 'Fix the thing\nmore detail' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.newIssue.title, 'Fix the thing more detail');
});

check('model, base branch and reviewer are optional, and blank means unset (null), not empty string', () => {
  const r = acaBuildDispatchBody(baseForm());
  assert.strictEqual(r.value.model, null);
  assert.strictEqual(r.value.baseBranch, null);
  assert.strictEqual(r.value.reviewer, null);
  const r2 = acaBuildDispatchBody({ ...baseForm(), model: ' gpt ', baseBranch: ' main ', reviewer: ' alice ' });
  assert.strictEqual(r2.value.model, 'gpt');
  assert.strictEqual(r2.value.baseBranch, 'main');
  assert.strictEqual(r2.value.reviewer, 'alice');
});

check('publishPr defaults to true and watchOnly defaults to false, matching the dialog\'s own checked state', () => {
  const r = acaBuildDispatchBody({ ...baseForm(), publishPr: undefined, watchOnly: undefined });
  assert.strictEqual(r.value.publishPr, true);
  assert.strictEqual(r.value.watchOnly, false);
});

// --- acaStepsForStatus --------------------------------------------------------

check('there are exactly the four steps issue #178 asks for, in order', () => {
  assert.deepStrictEqual(ACA_DISPATCH_STEPS, ['Dispatched', 'Lease claimed', 'Starting job', 'Attached']);
});

check('no status yet (just dispatched) shows "Dispatched" done and "Lease claimed" current', () => {
  const v = acaStepsForStatus(null, false);
  assert.strictEqual(v.failed, false);
  assert.strictEqual(v.pillClass, 'q');
  assert.strictEqual(v.steps[0].done, true);
  assert.strictEqual(v.steps[1].current, true);
});

check('a queued run shows "Lease claimed" current, with only Dispatched proven done -- Actions queued is not lease proof', () => {
  const v = acaStepsForStatus({ state: 'queued' }, false);
  assert.strictEqual(v.steps[0].done, true);
  // #178's release-gate review: a bare `queued` Actions state is never
  // treated as proof the dispatch lease was claimed -- only "Dispatched"
  // (the POST that already succeeded) is ever marked done here.
  assert.strictEqual(v.steps[1].done, false);
  assert.strictEqual(v.steps[1].current, true);
  assert.strictEqual(v.failed, false);
});

check('an in_progress run shows "Starting job" current, with only Dispatched proven done -- Actions in_progress is not job-start proof', () => {
  const v = acaStepsForStatus({ state: 'in_progress' }, false);
  assert.strictEqual(v.steps[0].done, true);
  // Likewise: `in_progress` only proves the Actions run itself is executing,
  // never that the ACA job it may or may not launch has actually started.
  assert.strictEqual(v.steps[1].done, false);
  assert.strictEqual(v.steps[2].done, false);
  assert.strictEqual(v.steps[2].current, true);
});

check('attached is reported once the session shows up, regardless of the last known run status', () => {
  const v = acaStepsForStatus({ state: 'queued' }, true);
  assert.strictEqual(v.pillLabel, 'Queued on ACA');
  assert.strictEqual(v.steps.every((s) => s.done), true);
  assert.strictEqual(v.failed, false);
});

check('an errored dispatch is reported as failed, with the reason shown verbatim', () => {
  const v = acaStepsForStatus({ state: 'error', reason: 'no installation for this repository' }, false);
  assert.strictEqual(v.failed, true);
  assert.strictEqual(v.pillClass, 'failed');
  assert.strictEqual(v.failureReason, 'no installation for this repository');
  // Terminal: there is nothing further to learn by asking GitHub again, so
  // syncAcaPending must stop polling this entry forever (see aca-pending.js).
  assert.strictEqual(v.resolved, true);
});

check('a run that completed without ever attaching is reported as failed', () => {
  const v = acaStepsForStatus({ state: 'completed', conclusion: 'failure' }, false);
  assert.strictEqual(v.failed, true);
  assert.ok(/failure/.test(v.failureReason));
  // Same terminal contract as the errored-dispatch case above: GitHub has
  // already given its final word, so this is resolved immediately, not only
  // once some additional wait expires.
  assert.strictEqual(v.resolved, true);
});

check('a run that completed successfully, but the session has not attached yet, is NOT reported failed before the wait expires', () => {
  const v = acaStepsForStatus({ state: 'completed', conclusion: 'success' }, false, false);
  assert.strictEqual(v.failed, false);
  assert.strictEqual(v.pillLabel, 'Queued on ACA');
  // Still only "Dispatched" is proven; a successful Actions conclusion is
  // not proof the ACA job itself ran (#178's release-gate review).
  assert.strictEqual(v.steps[0].done, true);
  assert.strictEqual(v.steps[1].done, false);
});

check('a run that completed successfully but never attached within the bound wait reports an honest unknown outcome, not a failure', () => {
  const v = acaStepsForStatus({ state: 'completed', conclusion: 'success' }, false, true);
  assert.strictEqual(v.failed, false, 'this hub has no evidence the job failed -- only that it cannot prove it attached');
  assert.strictEqual(v.pillLabel, 'Unknown outcome');
  assert.strictEqual(v.pillClass, 'stale');
  assert.ok(/no ACA session attached/.test(v.failureReason));
});

// --- acaPendingAttached / acaPendingMatch: authoritative device.meta -------
//
// #178's release-gate review: repository-and-recency alone is a guess, not a
// correlation -- an unrelated same-repo session, a second dispatch racing
// ahead of a first, and two dispatches on the SAME issue all broke it. The
// only thing actually proving an attached `aca-` device belongs to THIS
// dispatch is its own reported `meta.repo`/`meta.issue` (src/device-meta.js,
// already shipped -- the squad-on-aca worker reports its own identity, this
// is not invented here), matched against the entry's OWN repo/issue -- the
// same issue its POST was dispatched against in the first place.

const acaGroup = (overrides) => ({
  device: { kind: 'aca', ...(overrides && overrides.device) },
  sessions: (overrides && overrides.sessions) || [],
});
check('matches an aca-kind device whose meta reports the same repository and issue', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const groups = [acaGroup({ device: { meta: { repo: REPO, issue: 42 } }, sessions: [{ startedAt: 2000 }] })];
  assert.strictEqual(acaPendingAttached(entry, groups), true);
});

check('is case-insensitive about the repository name', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const groups = [acaGroup({ device: { meta: { repo: REPO.toUpperCase(), issue: 42 } }, sessions: [{ startedAt: 2000 }] })];
  assert.strictEqual(acaPendingAttached(entry, groups), true);
});

check('a near-time session on the SAME repository but a DIFFERENT issue never matches', () => {
  // The exact case repository-and-recency guessing could not tell apart:
  // an unrelated dispatch (or a pre-existing/manually-started job) on the
  // same repository, whose device attached mere seconds apart from this
  // entry's own dispatch. Only the issue number proves which is which.
  const entry = { repo: REPO, issue: 42, dispatchedAt: 100000 };
  const groups = [acaGroup({
    device: { meta: { repo: REPO, issue: 999 } },
    sessions: [{ startedAt: 100000 + 1000 }],
  })];
  assert.strictEqual(acaPendingMatch(entry, groups, new Set()), null);
});

check('a device whose meta omits repo/issue is never treated as a match (no proof, no guess)', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const noMeta = [acaGroup({ sessions: [{ startedAt: 2000 }] })];
  assert.strictEqual(acaPendingMatch(entry, noMeta, new Set()), null);
  const partialMeta = [acaGroup({ device: { meta: { repo: REPO } }, sessions: [{ startedAt: 2000 }] })];
  assert.strictEqual(acaPendingMatch(entry, partialMeta, new Set()), null);
});

check('an entry with no issue number never matches anything, proof or not', () => {
  const entry = { repo: REPO, dispatchedAt: 1000 };
  const groups = [acaGroup({ device: { meta: { repo: REPO, issue: 42 } }, sessions: [{ startedAt: 2000 }] })];
  assert.strictEqual(acaPendingMatch(entry, groups, new Set()), null);
});

check('does not match a non-aca device, even with matching meta', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const groups = [{ device: { kind: 'cloud', meta: { repo: REPO, issue: 42 } }, sessions: [{ startedAt: 2000 }] }];
  assert.strictEqual(acaPendingAttached(entry, groups), false);
});

check('does not match a different repository', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const groups = [acaGroup({ device: { meta: { repo: 'someone/else', issue: 42 } }, sessions: [{ startedAt: 2000 }] })];
  assert.strictEqual(acaPendingAttached(entry, groups), false);
});

check('an empty group list never matches, and never throws', () => {
  assert.strictEqual(acaPendingAttached({ repo: REPO, issue: 42, dispatchedAt: 1000 }, []), false);
  assert.strictEqual(acaPendingAttached({ repo: REPO, issue: 42, dispatchedAt: 1000 }, undefined), false);
});

// --- acaPendingMatch: repeated/same-issue exclusivity ----------------------
//
// The bug this guards against: two pending dispatches on the SAME
// repository+issue (a re-dispatch after an earlier one appeared to stall),
// or an unrelated/pre-existing `aca-` session reporting that same identity,
// must never let one real session resolve more than one pending row.

check('a single matching session only ever satisfies ONE of two repeated-same-issue pending entries', () => {
  // UPDATED by the follow-up to #178 (see acaPendingMatch's own doc comment,
  // "ON THE PRE-EXISTING... TEST"): this test ORIGINALLY asserted the OLDER
  // of two same-issue entries always wins a session either could plausibly
  // match, mirroring DispatchTracker's own oldest-dispatch-claims-first
  // server-side tie-break. That was a reasonable choice when nothing else
  // distinguished the two candidates -- but it is no longer the best
  // available signal: a session's own `startedAt` IS real evidence about
  // which dispatch actually produced it (closer in time is more likely to
  // be the actual cause), where "which entry is older" says nothing about
  // the SESSION at all. `older` (dispatchedAt 1000) and `newer` (dispatchedAt
  // 5000) are both timing-eligible for a session that started at 6000, but
  // `newer` is the CLOSER preceding dispatch -- so it is `newer`, not
  // `older`, that now wins. The exclusivity guarantee this test exists for
  // is unchanged: whichever entry wins, the OTHER must never also resolve to
  // the same session.
  const older = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const newer = { repo: REPO, issue: 42, dispatchedAt: 5000 };
  const groups = [acaGroup({
    device: { meta: { repo: REPO, issue: 42 } },
    sessions: [{ id: 's1', startedAt: 6000 }],
  })];

  // Unclaimed, and with no sibling awareness (acaPendingAttached's plain
  // yes/no, by design -- see its own doc comment): both independently see
  // the one session. Exclusivity and the closest-preceding tie-break only
  // apply through acaPendingMatch's `claimedKeys`/`allPending`.
  assert.strictEqual(acaPendingAttached(older, groups), true);
  assert.strictEqual(acaPendingAttached(newer, groups), true);

  const allPending = [older, newer];
  const matchNewer = acaPendingMatch(newer, groups, new Set(), allPending);
  assert.strictEqual(matchNewer && matchNewer.key, 's1', 'the CLOSEST preceding entry (newer) should win the one real session');
  assert.strictEqual(acaPendingMatch(older, groups, new Set(), allPending), null,
    'the older entry is not the closest preceding dispatch for this session, so it must not also claim it');

  // With the session already claimed (by `newer`, per the above), neither
  // entry may claim it again -- not `newer` (already has it, so there is
  // nothing left to find), and not `older` (never eligible for it either).
  const claimed = new Set(['s1']);
  assert.strictEqual(acaPendingMatch(newer, groups, claimed, allPending), null, 'newer should not re-claim what it already has');
  assert.strictEqual(acaPendingMatch(older, groups, claimed, allPending), null,
    'a repeat dispatch on the same issue must not also consume the first dispatch\'s attached session');
});

check('a session startedAt before EITHER sibling entry\'s tolerance window matches neither (no fabricated guess)', () => {
  // The genuinely ambiguous case the brief's "leave unknown, do not
  // fabricate" instruction is actually about: two sibling entries whose
  // dispatchedAt are EQUALLY the closest preceding value for one candidate
  // session -- there is no time-based way to prefer one over the other, so
  // this must resolve to NEITHER rather than guess (unlike the test above,
  // where `newer` is unambiguously closer).
  const a = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const b = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const groups = [acaGroup({
    device: { meta: { repo: REPO, issue: 42 } },
    sessions: [{ id: 'tied-session', startedAt: 2000 }],
  })];
  const allPending = [a, b];
  assert.strictEqual(acaPendingMatch(a, groups, new Set(), allPending), null);
  assert.strictEqual(acaPendingMatch(b, groups, new Set(), allPending), null);
});

check('a pre-existing/unrelated aca- session reporting a different issue does not steal a different pending entry\'s claim', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 10000 };
  // A session on the SAME repo but a DIFFERENT issue -- the two-minute
  // clock-drift floor this replaced would have let this through purely on
  // timing; issue-based matching rejects it regardless of when it started.
  const preExisting = [acaGroup({
    device: { meta: { repo: REPO, issue: 7 } },
    sessions: [{ id: 'old-session', startedAt: entry.dispatchedAt - (10 * 60 * 1000) }],
  })];
  assert.strictEqual(acaPendingMatch(entry, preExisting, new Set()), null);

  // A genuinely unrelated device on a DIFFERENT repository, running
  // concurrently, must never match either.
  const unrelated = [acaGroup({
    device: { meta: { repo: 'someone/else', issue: 42 } },
    sessions: [{ id: 'other-device', startedAt: entry.dispatchedAt + 1000 }],
  })];
  assert.strictEqual(acaPendingMatch(entry, unrelated, new Set()), null);
});

check('a newer job attaching before an older one still only ever resolves its OWN issue\'s entry', () => {
  // Out-of-order attach: the job for a LATER dispatch (issue 43) reports in
  // before the job for an EARLIER dispatch (issue 42) does. Repository-only
  // matching had no way to tell these apart except array/time order; issue
  // identity makes the order irrelevant to correctness.
  const earlierEntry = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const laterEntry = { repo: REPO, issue: 43, dispatchedAt: 2000 };
  const groups = [
    acaGroup({ device: { meta: { repo: REPO, issue: 43 } }, sessions: [{ id: 'later-job', startedAt: 2500 }] }),
  ];
  assert.strictEqual(acaPendingMatch(earlierEntry, groups, new Set()), null);
  const match = acaPendingMatch(laterEntry, groups, new Set());
  assert.strictEqual(match && match.key, 'later-job');
});

check('acaPendingMatch picks the earliest-started eligible session among genuine ties, matching the oldest-dispatch-claims-first rule', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const groups = [acaGroup({
    device: { meta: { repo: REPO, issue: 42 } },
    sessions: [
      { id: 'later', startedAt: 9000 },
      { id: 'earlier', startedAt: 2000 },
    ],
  })];
  const match = acaPendingMatch(entry, groups, new Set());
  assert.strictEqual(match && match.key, 'earlier');
});

// --- acaPendingMatch: time-ordering is dispatch-ATTEMPT identity -----------
//
// Repo+issue alone proves "the right repository and issue", never "the
// right OCCASION" -- see acaPendingMatch's own doc comment for the two real
// bugs this closes (Bug A: a fresh tab binding to a stale historical
// session; Bug B: a same-issue retry swapping with its own predecessor).

check('a fresh tab does not bind to a historical same-issue session that started long before this dispatch (Bug A)', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1_000_000 };
  // An "aca-" session from ten minutes before this dispatch was even made --
  // left over from an earlier, unrelated run against the same issue. Its
  // own device is reported ONLINE and its own session has no particular
  // "finished" marker; only its startedAt is implicated here, which is
  // exactly the point -- presence/online-ness tells this rule nothing.
  const groups = [acaGroup({
    device: { presence: 'online', meta: { repo: REPO, issue: 42 } },
    sessions: [{ id: 'ancient-online', startedAt: entry.dispatchedAt - (10 * 60 * 1000) }],
  })];
  assert.strictEqual(acaPendingMatch(entry, groups, new Set()), null);
});

check('a fresh tab does not bind to a historical same-issue session whose device has since gone offline (Bug A)', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1_000_000 };
  const groups = [acaGroup({
    device: { presence: 'offline', meta: { repo: REPO, issue: 42 } },
    sessions: [{ id: 'ancient-offline', startedAt: entry.dispatchedAt - (10 * 60 * 1000) }],
  })];
  assert.strictEqual(acaPendingMatch(entry, groups, new Set()), null);
});

check('a fresh tab does not bind to a historical same-issue session that has since completed (Bug A)', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1_000_000 };
  const groups = [acaGroup({
    device: { presence: 'online', meta: { repo: REPO, issue: 42 } },
    sessions: [{ id: 'ancient-completed', status: 'completed', startedAt: entry.dispatchedAt - (10 * 60 * 1000) }],
  })];
  assert.strictEqual(acaPendingMatch(entry, groups, new Set()), null);
});

check('a session that started just within the clock-drift tolerance before the dispatch still matches', () => {
  // The flip side of Bug A's fix: ACA_START_TOLERANCE_MS exists precisely so
  // a session that genuinely IS this dispatch's own job, but whose own
  // clock reports starting a few seconds "before" this hub believes it
  // dispatched, is not rejected by the same rule that excludes Bug A.
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1_000_000 };
  const groups = [acaGroup({
    device: { meta: { repo: REPO, issue: 42 } },
    sessions: [{ id: 'within-tolerance', startedAt: entry.dispatchedAt - (ACA_START_TOLERANCE_MS - 1) }],
  })];
  const match = acaPendingMatch(entry, groups, new Set());
  assert.strictEqual(match && match.key, 'within-tolerance');
});

check('a candidate with no meta.repo/meta.issue at all is never treated as a match, colocated with the time-ordering tests above', () => {
  // Explicit coverage of the "no proof" case alongside the new time-ordering
  // tests, per the brief -- this already passed before this fix (see the
  // original "a device whose meta omits repo/issue..." test above) and must
  // continue to, unaffected by the new rules.
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1_000_000 };
  const groups = [acaGroup({ device: {}, sessions: [{ id: 'no-meta', startedAt: entry.dispatchedAt + 1000 }] })];
  assert.strictEqual(acaPendingMatch(entry, groups, new Set()), null);
});

check('a same-issue retry resolves correctly even when the NEWER dispatch\'s own session attaches first (Bug B, out-of-order attach)', () => {
  // The single most important regression test for this fix: dispatch A
  // stalls, the same issue is dispatched again as B. Both real sessions
  // eventually exist, but GitHub/Azure timing can attach them in EITHER
  // order. This simulates sessionB (B's own job) attaching FIRST, across
  // two separate resolution passes -- exactly the ordering `syncAcaPending`
  // would see in practice, and exactly the ordering the OLD
  // "earliest-started-wins, processed oldest-entry-first" code bound
  // WRONGLY to entry A (see acaPendingMatch's own doc comment, "Bug B").
  const entryA = { repo: REPO, issue: 42, dispatchedAt: 1_000_000, attached: false };
  const entryB = { repo: REPO, issue: 42, dispatchedAt: 1_100_000, attached: false }; // a genuine retry, 100s later
  const sessionA = { id: 'sessionA', startedAt: 1_001_000 }; // really A's own job
  const sessionB = { id: 'sessionB', startedAt: 1_101_000 }; // really B's own job

  // Pass 1: only sessionB has attached so far.
  const groupsPass1 = [acaGroup({ device: { meta: { repo: REPO, issue: 42 } }, sessions: [sessionB] })];
  const allPending = [entryA, entryB];
  const claimedKeys = new Set();

  assert.strictEqual(acaPendingMatch(entryA, groupsPass1, claimedKeys, allPending), null,
    'entry A must NOT claim sessionB -- B is the closer preceding dispatch for sessionB\'s own startedAt');
  const matchB = acaPendingMatch(entryB, groupsPass1, claimedKeys, allPending);
  assert.strictEqual(matchB && matchB.key, 'sessionB', 'entry B should correctly claim its own session on the very first poll');

  // Simulate what syncAcaPending does once a match is found.
  entryB.attached = true;
  claimedKeys.add('sessionB');

  // Pass 2: sessionA has now also attached. Both sessions are visible, B is
  // already attached (and excluded from `allPending`'s sibling computation
  // by acaPendingMatch itself, since it is no longer pending).
  const groupsPass2 = [acaGroup({ device: { meta: { repo: REPO, issue: 42 } }, sessions: [sessionA, sessionB] })];
  const matchA = acaPendingMatch(entryA, groupsPass2, claimedKeys, allPending);
  assert.strictEqual(matchA && matchA.key, 'sessionA', 'entry A should now correctly claim ITS OWN session -- no swap');
});



check('a pending row names its repository and does not render as clickable session markup', () => {
  const html = acaPendingRowHtml({ localId: 'x', repo: REPO, status: null, dispatchedAt: Date.now() });
  assert.ok(html.includes(REPO));
  assert.ok(html.includes('Queued on ACA'));
  assert.ok(!html.includes('data-session='), 'a pending row must not be mistaken for a real session row');
});

check('a failed pending row shows its failure reason', () => {
  const html = acaPendingRowHtml({
    localId: 'x', repo: REPO, dispatchedAt: Date.now(), status: { state: 'error', reason: 'rate limited' },
  });
  assert.ok(html.includes('rate limited'));
  assert.ok(html.includes('Dispatch failed'));
});

check('user-controlled text in a pending row is escaped', () => {
  const html = acaPendingRowHtml({
    localId: 'x', repo: '<img src=x onerror=alert(1)>/x', dispatchedAt: Date.now(), status: null,
  });
  assert.ok(!html.includes('<img'), html);
});

check('a completed-success row still shows "Queued on ACA" while within the bounded wait', () => {
  const html = acaPendingRowHtml({
    localId: 'x', repo: REPO, dispatchedAt: Date.now(),
    completedAt: Date.now() - (ACA_COMPLETED_WAIT_MS - 1000),
    status: { state: 'completed', conclusion: 'success' },
  });
  assert.ok(!html.includes('Unknown outcome'), html);
});

check('a completed-success row with no attach past the bounded wait reports an honest unknown outcome, not a lie about success', () => {
  const html = acaPendingRowHtml({
    localId: 'x', repo: REPO, dispatchedAt: Date.now(),
    completedAt: Date.now() - (ACA_COMPLETED_WAIT_MS + 1000),
    status: { state: 'completed', conclusion: 'success' },
  });
  assert.ok(html.includes('Unknown outcome'), html);
});

check('the section is empty with nothing pending, and on the Local scope (an ACA job cannot run there)', () => {
  assert.strictEqual(acaPendingSectionHtml([], 'all'), '');
  assert.strictEqual(acaPendingSectionHtml([{ repo: REPO }], 'local'), '');
});

check('the section lists unattached dispatches on All and Cloud scopes, and counts them', () => {
  const pending = [{ repo: REPO, status: null }, { repo: 'a/b', status: null }];
  for (const scope of ['all', 'cloud']) {
    const html = acaPendingSectionHtml(pending, scope);
    assert.ok(html.includes('Queued on ACA'));
    assert.ok(html.includes('2 jobs'), html);
  }
});

check('an attached entry drops out of the section once it is marked attached', () => {
  const html = acaPendingSectionHtml([{ repo: REPO, status: null, attached: true }], 'all');
  assert.strictEqual(html, '');
});

// ===========================================================================
// The dialog's own markup: every field explains itself, Repository and
// Instructions survive the disabled-mode fallback (issue #178)
// ===========================================================================

check('every field in the New ACA job dialog explains itself', () => {
  // Same failure mode `approval-depth-unit.js` already guards for the New
  // session dialog: a field nobody explains gets guessed at, and a guessed
  // reviewer or a guessed "watch-only" is only found to be wrong once the
  // job is already running out of anyone's sight.
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const dialog = html.slice(html.indexOf('id="acaScrim"'), html.indexOf('id="peopleScrim"'))
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const field of ['Repository', 'Base branch', 'Issue', 'Model', 'Required reviewer', 'Publish PR', 'Watch-only', 'Instructions']) {
    const at = dialog.indexOf(field);
    assert.ok(at > -1, `the ${field} field label is not even present`);
    // The explainer button sits in the same label/fieldset as its field, well
    // within a couple of lines -- a wide window here would let an unrelated
    // later field's hint-btn satisfy a field that has none of its own.
    const nearby = dialog.slice(at, at + 400);
    assert.match(nearby, /<button[^>]*class="hint-btn"/, `the ${field} field has no explanation beside it`);
  }
});

check('Repository and Instructions sit outside #acaForm, so the 501 fallback can still use them', () => {
  // acaSetMode() (web/js/aca.js) hides the whole #acaForm when the GitHub
  // App is not configured -- if these two fields were inside it, the two
  // fallback links below (the ONLY path in that case) would have nothing to
  // read their repository/instructions from.
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const dialog = html.slice(html.indexOf('id="acaScrim"'), html.indexOf('id="peopleScrim"'));
  const formStart = dialog.indexOf('<div id="acaForm">');
  const formEnd = dialog.indexOf('</div>', dialog.lastIndexOf('aca-route', dialog.indexOf('acaPrompt')));
  assert.ok(formStart > -1 && formEnd > formStart, 'could not locate #acaForm in the dialog markup');
  const repoIdx = dialog.indexOf('id="acaRepo"');
  const promptIdx = dialog.indexOf('id="acaPrompt"');
  assert.ok(repoIdx > -1 && promptIdx > -1, 'could not find acaRepo/acaPrompt in the dialog markup');
  assert.ok(repoIdx < formStart, 'acaRepo is inside #acaForm -- it would be hidden in the 501 fallback');
  assert.ok(promptIdx > formEnd, 'acaPrompt is inside #acaForm -- it would be hidden in the 501 fallback');
});

// --- api() error-message extraction (#178) ----------------------------------
// hub-service.js's `/api/aca/repos` and `/api/aca/dispatches` 501s
// deliberately answer `{ reason }`, not `{ error }` (see the big comment
// above those handlers) -- the ONE place in this app a non-2xx body uses that
// shape. `api()` must surface it, or the disabled-form note in aca.js
// (`acaSetMode('disabled', e.message)`) falls back to a bare, unhelpful
// "HTTP 501" instead of explaining why the form is disabled.
{
  const realFetch = global.fetch;

  (async () => {
    global.fetch = async () => ({
      ok: false,
      status: 501,
      json: async () => ({ reason: 'This hub has no GitHub App configured.' }),
    });
    try {
      await api('/api/aca/repos');
      fail += 1;
      console.log('  FAIL api() surfaces a `reason`-shaped 501 body as its error message\n         expected api() to throw');
      console.log('RESULT\tfail\tapi() surfaces a `reason`-shaped 501 body as its error message\texpected api() to throw');
    } catch (e) {
      try {
        assert.strictEqual(e.status, 501);
        assert.strictEqual(e.message, 'This hub has no GitHub App configured.');
        pass += 1;
        console.log('  ok   api() surfaces a `reason`-shaped 501 body as its error message');
        console.log('RESULT\tok\tapi() surfaces a `reason`-shaped 501 body as its error message');
      } catch (assertErr) {
        fail += 1;
        console.log(`  FAIL api() surfaces a \`reason\`-shaped 501 body as its error message\n         ${assertErr.message}`);
        console.log(`RESULT\tfail\tapi() surfaces a \`reason\`-shaped 501 body as its error message\t${String(assertErr.message).split('\n')[0]}`);
      }
    }

    global.fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'no such device' }),
    });
    try {
      await api('/api/devices/x');
      fail += 1;
      console.log('  FAIL api() still prefers an `error`-shaped body over `reason`\n         expected api() to throw');
      console.log('RESULT\tfail\tapi() still prefers an `error`-shaped body over `reason`\texpected api() to throw');
    } catch (e) {
      try {
        assert.strictEqual(e.message, 'no such device');
        pass += 1;
        console.log('  ok   api() still prefers an `error`-shaped body over `reason`');
        console.log('RESULT\tok\tapi() still prefers an `error`-shaped body over `reason`');
      } catch (assertErr) {
        fail += 1;
        console.log(`  FAIL api() still prefers an \`error\`-shaped body over \`reason\`\n         ${assertErr.message}`);
        console.log(`RESULT\tfail\tapi() still prefers an \`error\`-shaped body over \`reason\`\t${String(assertErr.message).split('\n')[0]}`);
      }
    }

    // --- syncAcaPending / retryAcaPending: bounded polling (follow-up to
    // #178) --------------------------------------------------------------
    // `GET /api/aca/dispatches` must be called exactly once more each time
    // there is genuinely something new to learn, and NEVER again once every
    // tracked entry is attached or terminally resolved -- see
    // acaPendingMatch's sibling module aca-pending.js's own doc comments on
    // `syncAcaPending` and `retryAcaPending`.
    {
      const calls = [];
      global.fetch = async (url, opts) => {
        calls.push({ url, method: (opts && opts.method) || 'GET' });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            dispatches: [{ id: 'tracker-err', status: { state: 'error', reason: 'boom' } }],
          }),
        };
      };

      await checkAsync('once syncAcaPending marks an entry terminally resolved, it never fetches /api/aca/dispatches for that entry again', async () => {
        state.acaPending = [{
          localId: 'x1',
          repo: REPO,
          issue: 1,
          dispatchedAt: Date.now(),
          owner: REPO.split('/')[0],
          name: REPO.split('/')[1],
          trackerId: 'tracker-err',
          status: null,
          attached: false,
          completedAt: null,
          matchedKey: null,
          resolved: false,
        }];
        state.overview = { groups: [] };

        calls.length = 0;
        await syncAcaPending();
        assert.strictEqual(calls.length, 1, 'the first sync, with an unresolved entry, must fetch once');
        assert.strictEqual(state.acaPending[0].resolved, true,
          'an errored dispatch status must mark the entry resolved -- the SAME acaStepsForStatus branch the row itself renders from');

        // Two more ticks: a terminally-resolved, unattached entry must cost
        // nothing at all, forever -- this is the exact #178 follow-up fix
        // (syncAcaPending's own `!e.attached && !e.resolved` filter).
        await syncAcaPending();
        await syncAcaPending();
        assert.strictEqual(calls.length, 1, 'once resolved, NO further /api/aca/dispatches fetch may ever happen for this entry');
      });

      await checkAsync('retryAcaPending forces exactly one re-check of a resolved entry, and never dispatches a second job', async () => {
        calls.length = 0;
        await retryAcaPending('x1');
        assert.strictEqual(calls.length, 1, 'retryAcaPending should force exactly one more GET /api/aca/dispatches');
        assert.ok(calls.every((c) => c.method !== 'POST'), 'retryAcaPending must never call POST /api/aca/dispatch -- it must never start a second real job');
        assert.ok(calls.every((c) => c.url === '/api/aca/dispatches'), 'retryAcaPending must only ever hit the status-check endpoint');
        assert.strictEqual(state.acaPending[0].resolved, true,
          'with nothing changed upstream, the entry resolves back to the same honest terminal outcome -- not an endless unresolved loop');

        calls.length = 0;
        await syncAcaPending();
        assert.strictEqual(calls.length, 0, 'retrying one entry must not resume polling for every OTHER already-resolved entry');
      });

      state.acaPending = [];
    }

    global.fetch = realFetch;

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
