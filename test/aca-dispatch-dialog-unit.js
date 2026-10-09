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

// --- acaPendingAttached / acaPendingMatch: never claims identity from
// repo+issue+timing alone (third review, see aca-match.js's own doc comment
// for the full REVIEW HISTORY) -------------------------------------------
//
// Two earlier review rounds already removed proximity-based ranking between
// same-issue siblings. A THIRD review round proved the revision that
// replaced it -- "a sibling that has already reached its own terminal
// `resolved` state stops counting as a live competitor" -- was ITSELF a
// false-positive source: `resolved` can mean "this hub's own local
// `ACA_COMPLETED_WAIT_MS` wait bound expired with no attach seen", which is
// this hub giving up waiting, never an authoritative GitHub fact that the
// dispatch can no longer produce a session. The same review also found the
// single-entry, no-known-sibling case was ALSO never proof of identity:
// `GET /api/aca/dispatches` only knows about dispatches made through THIS
// hub's own feature, so "no visible sibling" is not "no real sibling"
// either (a manual `/squad-aca` slash command, a Ralph-initiated dispatch,
// or any other way of triggering the same workflow for the same repo+issue
// is invisible to it).
//
// `acaPendingMatch` therefore now always returns `null`, and
// `acaPendingAttached` always returns `false` -- every test below proves
// that holds for every input shape the earlier (now-removed) rule-1/rule-2
// logic used to treat as a legitimate match, including the exact
// counter-example that proved the previous revision wrong.

const acaGroup = (overrides) => ({
  device: { kind: 'aca', ...(overrides && overrides.device) },
  sessions: (overrides && overrides.sessions) || [],
});

check('acaPendingMatch never returns a match for an exact repo+issue+timing fit -- no authoritative join exists for it (see aca-match.js doc comment)', () => {
  // This is EXACTLY the shape earlier revisions treated as proof: an
  // aca-kind device reporting the same repo+issue as the entry, with its
  // session's startedAt safely after dispatchedAt. It still resolves to
  // null -- repo+issue+timing is evidence, never proof.
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const groups = [acaGroup({ device: { meta: { repo: REPO, issue: 42 } }, sessions: [{ id: 's1', startedAt: 2000 }] })];
  assert.strictEqual(acaPendingMatch(entry, groups, new Set()), null);
  assert.strictEqual(acaPendingAttached(entry, groups), false);
});

check('acaPendingAttached never returns true, repository case folding included', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const groups = [acaGroup({ device: { meta: { repo: REPO.toUpperCase(), issue: 42 } }, sessions: [{ startedAt: 2000 }] })];
  assert.strictEqual(acaPendingAttached(entry, groups), false);
});

check('an empty, undefined, or malformed group list never throws and never matches', () => {
  assert.strictEqual(acaPendingAttached({ repo: REPO, issue: 42, dispatchedAt: 1000 }, []), false);
  assert.strictEqual(acaPendingAttached({ repo: REPO, issue: 42, dispatchedAt: 1000 }, undefined), false);
  assert.strictEqual(acaPendingMatch(undefined, undefined, undefined, undefined), null);
  assert.strictEqual(acaPendingMatch({}, [{}], new Set(), [{}]), null);
});

check('the Scout-review counter-example: a resolved sibling (local wait-bound expiry, not an authoritative GitHub fact) must never let an unrelated later dispatch claim its session -- and now it simply can\'t, because nothing can', () => {
  // Dispatch A: dispatchedAt=10000. A's own run eventually resolves locally
  // via the "completed success, but ACA_COMPLETED_WAIT_MS expired with no
  // attach seen" path (aca.js's acaStepsForStatus, "Unknown outcome") --
  // entry.resolved = true. This is NOT proof A's job can never produce a
  // session; the real device can still attach late.
  const dispatchA = { repo: REPO, issue: 42, dispatchedAt: 10000, resolved: true };
  // Dispatch B: dispatchedAt=20000, still genuinely pending.
  const dispatchB = { repo: REPO, issue: 42, dispatchedAt: 20000, resolved: false };
  // The REAL session that actually belongs to A (a slow-starting job)
  // finally starts at startedAt=25000, reporting the same repo+issue as
  // both A and B. A prior revision's sibling filter excluded A (because
  // `!e.resolved` filtered it out of B's ambiguity check), so B saw no
  // competing sibling and confidently (and wrongly) claimed A's own session.
  const session = { id: 'the-session', startedAt: 25000 };
  const groups = [acaGroup({ device: { meta: { repo: REPO, issue: 42 } }, sessions: [session] })];
  const allPending = [dispatchA, dispatchB];

  assert.strictEqual(acaPendingMatch(dispatchB, groups, new Set(), allPending), null,
    'B must never claim a session purely because its only known sibling (A) happened to be locally resolved -- that proves nothing about which dispatch produced the session');
  assert.strictEqual(acaPendingMatch(dispatchA, groups, new Set(), allPending), null,
    'A itself must not claim it either -- no entry is ever matched by this heuristic anymore, resolved or not');
});

check('the single-entry, no-known-sibling case is also never proof -- GET /api/aca/dispatches has no visibility into a manual/Ralph/other-origin dispatch for the same repo+issue', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  // No sibling at all, not even in allPending -- the case a prior revision
  // treated as the easy, unambiguous win.
  const groups = [acaGroup({ device: { meta: { repo: REPO, issue: 42 } }, sessions: [{ id: 'only-candidate', startedAt: 2000 }] })];
  assert.strictEqual(acaPendingMatch(entry, groups, new Set(), [entry]), null);
  assert.strictEqual(acaPendingMatch(entry, groups, new Set()), null, 'omitting allPending entirely must not change the answer either');
});

check('a device whose meta reports the exact same repo+issue, with a session started well within the old clock-drift tolerance, still never matches', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1_000_000 };
  const groups = [acaGroup({
    device: { meta: { repo: REPO, issue: 42 } },
    sessions: [{ id: 'within-tolerance', startedAt: entry.dispatchedAt - (ACA_START_TOLERANCE_MS - 1) }],
  })];
  assert.strictEqual(acaPendingMatch(entry, groups, new Set()), null);
});

check('a candidate with no meta.repo/meta.issue at all, a non-aca device, or a different repository all equally never match (all were already null before this review; still null after)', () => {
  const entry = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const noMeta = [acaGroup({ sessions: [{ startedAt: 2000 }] })];
  assert.strictEqual(acaPendingMatch(entry, noMeta, new Set()), null);
  const partialMeta = [acaGroup({ device: { meta: { repo: REPO } }, sessions: [{ startedAt: 2000 }] })];
  assert.strictEqual(acaPendingMatch(entry, partialMeta, new Set()), null);
  const nonAca = [{ device: { kind: 'cloud', meta: { repo: REPO, issue: 42 } }, sessions: [{ startedAt: 2000 }] }];
  assert.strictEqual(acaPendingAttached(entry, nonAca), false);
  const differentRepo = [acaGroup({ device: { meta: { repo: 'someone/else', issue: 42 } }, sessions: [{ startedAt: 2000 }] })];
  assert.strictEqual(acaPendingAttached(entry, differentRepo), false);
});

check('an entry with no issue number never matches anything, proof or not', () => {
  const entry = { repo: REPO, dispatchedAt: 1000 };
  const groups = [acaGroup({ device: { meta: { repo: REPO, issue: 42 } }, sessions: [{ startedAt: 2000 }] })];
  assert.strictEqual(acaPendingMatch(entry, groups, new Set()), null);
});

check('claimedKeys and multiple same-issue siblings never change the outcome -- there is no code path left that reads them toward a match', () => {
  const older = { repo: REPO, issue: 42, dispatchedAt: 1000 };
  const newer = { repo: REPO, issue: 42, dispatchedAt: 5000 };
  const groups = [acaGroup({
    device: { meta: { repo: REPO, issue: 42 } },
    sessions: [{ id: 's1', startedAt: 6000 }],
  })];
  const allPending = [older, newer];
  assert.strictEqual(acaPendingMatch(older, groups, new Set(), allPending), null);
  assert.strictEqual(acaPendingMatch(newer, groups, new Set(), allPending), null);
  assert.strictEqual(acaPendingMatch(newer, groups, new Set(['s1']), allPending), null);
  assert.strictEqual(acaPendingMatch(older, groups, new Set(['s1']), allPending), null);
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

    // --- offline bound: a failed GET must never extend an already-expired
    // local wait bound (ground-truth regression) ---------------------------
    {
      await checkAsync('an entry whose local wait bound already expired resolves from known status BEFORE any fetch, so a failing network can never keep it "pending" forever', async () => {
        const calls = [];
        global.fetch = async (url, opts) => {
          calls.push({ url, method: (opts && opts.method) || 'GET' });
          throw new Error('network down');
        };
        state.acaPending = [{
          localId: 'offline-1',
          repo: REPO,
          issue: 2,
          dispatchedAt: Date.now() - (ACA_COMPLETED_WAIT_MS + 60_000),
          trackerId: 'tracker-offline-1',
          status: { state: 'completed', conclusion: 'success' },
          completedAt: Date.now() - (ACA_COMPLETED_WAIT_MS + 1000),
          attached: false,
          resolved: false, // not yet locally re-evaluated -- exactly the state an old tab left open across an outage would be in
        }];
        state.overview = { groups: [] };

        await syncAcaPending();
        assert.strictEqual(calls.length, 0,
          'the entry\'s own bound was already expired, so this must resolve from local knowledge alone -- it never even needs to ask the (failing) network');
        assert.strictEqual(state.acaPending[0].resolved, true,
          'an expired completed-success wait resolves to the honest "unknown outcome" terminal state entirely from local data');

        // A further tick, still fully offline: must stay resolved, and must
        // still never call the network for this entry.
        await syncAcaPending();
        assert.strictEqual(calls.length, 0, 'once resolved locally, no amount of further offline polling may ever call the network for this entry');
      });

      state.acaPending = [];
    }

    // --- "Check again" on a failed recheck restores terminal state, and
    // does NOT leave auto-retry silently on (ground-truth regression) ------
    {
      await checkAsync('a failed one-shot "Check again" restores the previous terminal state, costs exactly one request, and never leaves auto-retry running for the next two ticks', async () => {
        const calls = [];
        global.fetch = async (url, opts) => {
          calls.push({ url, method: (opts && opts.method) || 'GET' });
          throw new Error('network down');
        };

        const recheckEntry = {
          localId: 'offline-2',
          repo: REPO,
          issue: 3,
          dispatchedAt: Date.now() - (ACA_COMPLETED_WAIT_MS + 60_000),
          trackerId: 'tracker-offline-2',
          status: { state: 'completed', conclusion: 'success' },
          completedAt: Date.now() - (ACA_COMPLETED_WAIT_MS + 1000),
          attached: false,
          resolved: true, // already closed out by an earlier (successful) poll
        };
        // A second, genuinely-still-live entry must be entirely unaffected by
        // the first entry's failed recheck: it has no completedAt at all, so
        // its own bound was never even started, let alone expired.
        const liveEntry = {
          localId: 'offline-3',
          repo: REPO,
          issue: 4,
          dispatchedAt: Date.now(),
          trackerId: 'tracker-offline-3',
          status: null,
          completedAt: null,
          attached: false,
          resolved: false,
        };
        state.acaPending = [recheckEntry, liveEntry];
        state.overview = { groups: [] };

        calls.length = 0;
        await retryAcaPending('offline-2');
        assert.strictEqual(calls.length, 1, 'the explicit "Check again" click must attempt exactly one GET /api/aca/dispatches');
        assert.ok(calls.every((c) => c.method !== 'POST'), 'a failed recheck must never fall back to POST /api/aca/dispatch -- no duplicate job, ever');
        assert.strictEqual(recheckEntry.resolved, true,
          'a failed one-shot recheck must restore the entry\'s previous terminal state, not leave it stuck "unresolved" forever');
        assert.strictEqual(liveEntry.resolved, false,
          'an unrelated, genuinely-still-live entry must be completely unaffected by another entry\'s failed recheck');

        // Remove the genuinely-still-live sibling before the next check:
        // IT legitimately needs its own further fetches regardless of this
        // fix (it has never completed, so its own wait bound never started,
        // let alone expired) -- that is correct, unrelated behavior, and
        // would otherwise make the next assertion about `recheckEntry`
        // alone impossible to isolate from `liveEntry`'s own, independent
        // polling need.
        state.acaPending = [recheckEntry];

        // Two further automatic poll ticks: since the recheck above already
        // restored `resolved`, these must cost NOTHING for this entry --
        // this is the fix for "a failed GET leaves auto-retry on": before
        // this fix, `resolved` stayed false forever after a failed recheck,
        // so every subsequent ACA_POLL_MS tick kept re-fetching with no
        // bound (1 explicit + 2 ticks => 3 requests, forever, for just this
        // one entry). After the fix, exactly the 1 explicit request above is
        // ever made for it.
        await syncAcaPending();
        await syncAcaPending();
        assert.strictEqual(calls.length, 1,
          'a failed recheck must not leave auto-retry running -- the next two ticks must add zero further requests, not two more');
      });

      state.acaPending = [];
    }

    // --- cross-tab siblings: `syncAcaPending` never attaches via the
    // repo+issue+timing heuristic at all anymore, regardless of whether an
    // unseen other tab's dispatch for the same issue exists (follow-up
    // review on top of the Scout review on 23a1af5 that originally added
    // this cross-tab coverage; see `acaPendingMatch`'s own doc comment in
    // aca-match.js for why) -------------------------------------------------
    {
      await checkAsync('a fresh tab never attaches via syncAcaPending, same-issue cross-tab sibling or not -- repo+issue+timing is never proof', async () => {
        const [owner, name] = REPO.split('/');
        global.fetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            dispatches: [{
              id: 'other-tab-tracker', owner, repo: name, issue: 5, dispatchedAt: 20_000,
              status: { state: 'queued' },
            }],
          }),
        });

        const localEntry = {
          localId: 'cross-1',
          repo: REPO,
          issue: 5,
          dispatchedAt: 10_000,
          trackerId: 'tracker-cross-1',
          status: null,
          completedAt: null,
          attached: false,
          resolved: false,
        };
        state.acaPending = [localEntry];
        // A session reporting the same repo+issue as this entry, started
        // comfortably after its own dispatchedAt -- exactly the shape an
        // earlier revision of acaPendingMatch would have attached, cross-tab
        // sibling or not. It still must never attach: this hub no longer
        // treats repo+issue+timing as proof of identity, so the presence or
        // absence of a competing cross-tab dispatch no longer changes the
        // answer either way.
        state.overview = {
          groups: [acaGroup({ device: { meta: { repo: REPO, issue: 5 } }, sessions: [{ id: 'cross-session', startedAt: 25_000 }] })],
        };

        await syncAcaPending();
        assert.strictEqual(localEntry.attached, false,
          'this tab\'s own entry must never attach via the repo+issue+timing heuristic, regardless of cross-tab siblings');
      });

      state.acaPending = [];
      state.overview = { groups: [] };
    }

    global.fetch = realFetch;

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
