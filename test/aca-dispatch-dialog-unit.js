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
const { readWebSource, stripModuleSyntax } = require('./helpers/web-source');

function deferred() {
  let resolve; let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/**
 * A stand-in for web/js/combobox.js (which needs a real DOM and is driven in
 * the browser tests): the same contract -- `value()` is only ever what was
 * CHOSEN, typed text is `unresolved()`, and `resolve()` runs the real `load`
 * and `matches` the dialog passed in -- so what is proven here is the dialog's
 * own logic, not the widget's.
 */
function fakeCombobox(registry) {
  return function createCombobox(opts) {
    let chosen = null;
    let free = false;
    const text = () => String(opts.input.value || '').trim();
    const box = {
      opts,
      blocked: null,
      get free() { return free; },
      value: () => (free ? (text() || null) : (chosen ? chosen.value : null)),
      item: () => chosen,
      typed: text,
      unresolved: () => !free && !chosen && text() !== '',
      choose(item, quiet) {
        chosen = item;
        opts.input.value = item.label;
        if (!quiet && opts.onChange) opts.onChange(item);
      },
      setText(v) { chosen = null; opts.input.value = v; },
      async resolve() {
        if (free || chosen || !text()) return chosen;
        const r = await opts.load(text(), 1, {});
        const hit = opts.matches && r.items.find((x) => opts.matches(x, text()));
        if (hit) box.choose(hit);
        return chosen;
      },
      reload() {},
      clear() { chosen = null; opts.input.value = ''; },
      setBlocked(reason) { box.blocked = reason; opts.input.disabled = !!reason; },
      setFree(on) { free = !!on; if (on) chosen = null; },
    };
    registry.push(box);
    return box;
  };
}

function dialogFixture(repoReplies = []) {
  const fs = require('fs');
  const path = require('path');
  const source = ['aca.js', 'aca-created-issue.js', 'aca-choices.js']
    .map((file) => stripModuleSyntax(fs.readFileSync(path.join(__dirname, '..', 'web', 'js', file), 'utf8')))
    .join('\n');
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', hidden: false, style: {}, focus() {}, replaceChildren(...c) { this.options = c; },
      });
    }
    return elements.get(id);
  };
  const requests = [];
  const choiceRequests = [];
  const lookups = [];
  const tracked = [];
  const notifications = [];
  const registry = [];
  const request = (url, options = {}) => {
    if (url === '/api/aca/repos') return repoReplies.length ? repoReplies.shift().promise : Promise.resolve({ repos: [] });
    const reply = deferred();
    if (/^\/api\/aca\/(branches|issues)\?/.test(url)) {
      lookups.push({ ...reply, url, signal: options.signal });
      return reply.promise;
    }
    if (url.startsWith('/api/aca/choices')) {
      choiceRequests.push({ ...reply, url, signal: options.signal });
      return reply.promise;
    }
    requests.push({ ...reply, body: options.body });
    return reply.promise;
  };
  const state = { currentSession: null };
  const dialog = new Function('state', 'api', '$', 'esc', 'toast', 'render', 'trackAcaDispatch', 'createCombobox', 'Option',
    `${source}\nreturn { openAca, submitAcaDispatch, acaChoiceValues };`)(
    state, request, element, String, (message) => notifications.push(message), () => {}, (entry) => tracked.push(entry),
    fakeCombobox(registry), function Option(text, value) { return { text, value }; },
  );
  const boxFor = (kind) => registry.find((b) => b.opts.input === element({ repo: 'acaRepo', branch: 'acaBranch', issue: 'acaIssueNumber' }[kind]));
  // What picking from a list does: the box holds the entry and the dialog hears about it.
  const choose = (kind, value, label) => boxFor(kind).choose({ value, label: label || String(value) });
  const open = (prompt) => {
    dialog.openAca();
    choose('repo', 'acme/widgets');
    element('acaPrompt').value = prompt;
  };
  return {
    ...dialog, state, open, choose, boxFor, element, requests, choiceRequests, lookups, tracked, notifications,
  };
}
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
  acaBuildDispatchBody, acaRepoDeclaredInputs, acaOptionsNote, acaStepsForStatus, acaPendingAttached, acaPendingMatch, acaPendingRowHtml,
  acaPendingSectionHtml, ACA_DISPATCH_STEPS, ACA_COMPLETED_WAIT_MS, ACA_MAX_PENDING_MS,
  acaDeviceIdFor, acaDispatchEvidence, acaAttachFromOverview, acaCreatedIssueOf,
  trackAcaDispatch, syncAcaPending, retryAcaPending, state, api,
};`)(browser);
const {
  acaBuildDispatchBody, acaRepoDeclaredInputs, acaOptionsNote, acaStepsForStatus, acaPendingAttached, acaPendingMatch, acaPendingRowHtml,
  acaPendingSectionHtml, ACA_DISPATCH_STEPS, ACA_COMPLETED_WAIT_MS, ACA_MAX_PENDING_MS,
  acaDeviceIdFor, acaDispatchEvidence, acaAttachFromOverview, acaCreatedIssueOf,
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

// The workflow's declared inputs decide whether a default-valued option is sent
// (#251, F3): a workflow without `publish_pr`/`watch_only` is refused by the hub
// for being sent them, so its dialog defaults must not travel -- but any choice
// that differs from the default, and every choice for a workflow that declares
// the input, must.
const LEGACY_INPUTS = ['issue', 'prompt'];
const MODERN_INPUTS = ['issue', 'prompt', 'model', 'base_branch', 'publish_pr', 'reviewer', 'watch_only'];

check('the default dialog choices are omitted for a workflow known to declare neither option', () => {
  const r = acaBuildDispatchBody({ ...baseForm(), declaredInputs: LEGACY_INPUTS });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.publishPr, null);
  assert.strictEqual(r.value.watchOnly, null);
});

check('a non-default choice is still sent for a workflow that does not declare the option, so the hub can refuse it', () => {
  const noPublish = acaBuildDispatchBody({ ...baseForm(), declaredInputs: LEGACY_INPUTS, publishPr: false });
  assert.strictEqual(noPublish.value.publishPr, false);
  assert.strictEqual(noPublish.value.watchOnly, null);
  const watch = acaBuildDispatchBody({ ...baseForm(), declaredInputs: LEGACY_INPUTS, watchOnly: true });
  assert.strictEqual(watch.value.watchOnly, true);
  assert.strictEqual(watch.value.publishPr, null);
});

check('each option is decided by its own input: declaring only publish_pr still omits a default watch-only', () => {
  const r = acaBuildDispatchBody({ ...baseForm(), declaredInputs: ['issue', 'prompt', 'publish_pr'] });
  assert.strictEqual(r.value.publishPr, true);
  assert.strictEqual(r.value.watchOnly, null);
  const r2 = acaBuildDispatchBody({ ...baseForm(), declaredInputs: ['issue', 'prompt', 'watch_only'] });
  assert.strictEqual(r2.value.publishPr, null);
  assert.strictEqual(r2.value.watchOnly, false);
});

check('a workflow that declares the options always receives the dialog\'s choices, whatever default it declares itself', () => {
  for (const [publishPr, watchOnly] of [[true, false], [false, false], [true, true], [false, true]]) {
    const r = acaBuildDispatchBody({ ...baseForm(), declaredInputs: MODERN_INPUTS, publishPr, watchOnly });
    assert.strictEqual(r.value.publishPr, publishPr);
    assert.strictEqual(r.value.watchOnly, watchOnly);
  }
});

check('an unknown capability (no list, repository absent, unreadable workflow) keeps sending both choices', () => {
  for (const declaredInputs of [undefined, null, 'issue,prompt', {}]) {
    const r = acaBuildDispatchBody({ ...baseForm(), declaredInputs });
    assert.strictEqual(r.value.publishPr, true, `declaredInputs ${JSON.stringify(declaredInputs)}`);
    assert.strictEqual(r.value.watchOnly, false);
  }
});

check('acaRepoDeclaredInputs reads the chosen repository case-insensitively and reports unknown as null, never as empty', () => {
  const repos = [
    { fullName: 'Acme/Widgets', declaredInputs: LEGACY_INPUTS },
    { fullName: 'acme/none', hasDispatchWorkflow: false, declaredInputs: null },
    { fullName: 'acme/old-hub' },
    { fullName: 'acme/bare', declaredInputs: [] },
  ];
  assert.deepStrictEqual(acaRepoDeclaredInputs(repos, 'acme/widgets'), LEGACY_INPUTS);
  assert.strictEqual(acaRepoDeclaredInputs(repos, 'acme/none'), null);
  assert.strictEqual(acaRepoDeclaredInputs(repos, 'acme/old-hub'), null);
  assert.deepStrictEqual(acaRepoDeclaredInputs(repos, 'acme/bare'), []);
  assert.strictEqual(acaRepoDeclaredInputs(repos, 'acme/missing'), null);
  assert.strictEqual(acaRepoDeclaredInputs(repos, 'not a repo'), null);
  assert.strictEqual(acaRepoDeclaredInputs(null, 'acme/widgets'), null);
});

check('the options note is silent when the workflow declares both options or its inputs are unknown', () => {
  assert.strictEqual(acaOptionsNote(MODERN_INPUTS), '');
  assert.strictEqual(acaOptionsNote(null), '');
  assert.strictEqual(acaOptionsNote(undefined), '');
  assert.strictEqual(acaOptionsNote('issue,prompt'), '');
});

// What a note may and may not say. The historical squad-on-aca workflow declared
// only issue/prompt, opened a pull request only when there were changes, and had
// no Hub or supervision setting at all -- supervision depended on how the worker
// was deployed -- so a note that promises a pull request or an approval prompt is
// a false claim about a workflow the dialog cannot read behavior from.
const FALSE_BEHAVIOR_CLAIM = /pull request|opens|approval|approve|asks|built-in|supervis|always|default behavior/i;

check('the note for a workflow lacking both options names both inputs, says the workflow owns them, and promises no behavior', () => {
  const both = acaOptionsNote(LEGACY_INPUTS);
  assert.doesNotMatch(both, FALSE_BEHAVIOR_CLAIM, 'the note claims behavior the workflow never declared');
  assert.match(both, /does not declare publish_pr or watch_only/);
  assert.match(both, /this dialog cannot send them/);
  assert.match(both, /Its workflow decides what Publish PR and Watch-only do/);
  assert.match(both, /leaving Publish PR checked and Watch-only unchecked sends nothing/);
  assert.match(both, /unchecking Publish PR or checking Watch-only will be refused rather than ignored/);
});

check('a workflow that declares publish_pr but not watch_only gets a note about watch_only alone, and no claim about the Publish PR it honors', () => {
  const note = acaOptionsNote(['issue', 'prompt', 'publish_pr']);
  assert.doesNotMatch(note, FALSE_BEHAVIOR_CLAIM, 'the note claims behavior the workflow never declared');
  assert.match(note, /does not declare watch_only,/);
  assert.match(note, /Its workflow decides what Watch-only does/);
  assert.match(note, /checking Watch-only will be refused/);
  assert.doesNotMatch(note, /publish|Publish|PR/, 'the note speaks about an option the workflow does declare');
});

check('a workflow that declares watch_only but not publish_pr gets a note about publish_pr alone, and no claim about the Watch-only it honors', () => {
  const note = acaOptionsNote(['issue', 'prompt', 'watch_only']);
  assert.doesNotMatch(note, FALSE_BEHAVIOR_CLAIM, 'the note claims behavior the workflow never declared');
  assert.match(note, /does not declare publish_pr,/);
  assert.match(note, /Its workflow decides what Publish PR does/);
  assert.match(note, /unchecking Publish PR will be refused/);
  assert.doesNotMatch(note, /watch|Watch/, 'the note speaks about an option the workflow does declare');
});

check('each option the workflow declares is still sent as chosen next to one it does not, so the note never contradicts the request', () => {
  const pr = acaBuildDispatchBody({ ...baseForm(), declaredInputs: ['issue', 'prompt', 'publish_pr'], publishPr: false });
  assert.strictEqual(pr.value.publishPr, false);
  assert.strictEqual(pr.value.watchOnly, null);
  const watch = acaBuildDispatchBody({ ...baseForm(), declaredInputs: ['issue', 'prompt', 'watch_only'], watchOnly: true });
  assert.strictEqual(watch.value.watchOnly, true);
  assert.strictEqual(watch.value.publishPr, null);
});

// --- acaStepsForStatus --------------------------------------------------------

check('there are exactly the four steps issue #178 asks for, in order', () => {
  assert.deepStrictEqual(ACA_DISPATCH_STEPS, ['Dispatched', 'Lease claimed', 'Starting job', 'Attached']);
});

const EXEC = 'squad-aca-job-x7k2p';
const done = (v) => v.steps.filter((s) => s.done).map((s) => s.label);
const current = (v) => v.steps.filter((s) => s.current).map((s) => s.label);

check('no status yet (just dispatched) shows "Dispatched" done and "Lease claimed" current', () => {
  const v = acaStepsForStatus(null, false);
  assert.strictEqual(v.failed, false);
  assert.strictEqual(v.resolved, false);
  assert.strictEqual(v.pillClass, 'q');
  assert.deepStrictEqual(done(v), ['Dispatched']);
  assert.deepStrictEqual(current(v), ['Lease claimed']);
});

check('a queued run shows "Lease claimed" current, with only Dispatched proven done -- Actions queued is not lease proof', () => {
  const v = acaStepsForStatus({ state: 'queued' }, false);
  assert.deepStrictEqual(done(v), ['Dispatched']);
  assert.deepStrictEqual(current(v), ['Lease claimed']);
  assert.strictEqual(v.failed, false);
});

check('an in_progress run with no confirmed execution shows "Starting job" current, with only Dispatched proven done', () => {
  const v = acaStepsForStatus({ state: 'in_progress' }, false);
  assert.deepStrictEqual(done(v), ['Dispatched']);
  assert.deepStrictEqual(current(v), ['Starting job']);
});

check('a hub-confirmed execution proves "Lease claimed" and "Starting job"; only "Attached" is left', () => {
  for (const state of ['in_progress', 'completed']) {
    const v = acaStepsForStatus({ state, conclusion: state === 'completed' ? 'success' : null }, false, false, EXEC);
    assert.deepStrictEqual(done(v), ['Dispatched', 'Lease claimed', 'Starting job'], state);
    assert.deepStrictEqual(current(v), ['Attached'], state);
    assert.strictEqual(v.pillLabel, 'Queued on ACA');
    assert.strictEqual(v.resolved, false);
    assert.strictEqual(v.failed, false);
  }
});

check('an execution name is only honored for an in-flight or finished run, never for queued/pending', () => {
  for (const status of [null, { state: 'pending' }, { state: 'queued' }]) {
    const v = acaStepsForStatus(status, false, false, EXEC);
    assert.deepStrictEqual(done(v), ['Dispatched'], JSON.stringify(status));
  }
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
  assert.strictEqual(v.resolved, true);
});

check('a run that completed without a confirmed execution and without success is reported as failed', () => {
  const v = acaStepsForStatus({ state: 'completed', conclusion: 'failure' }, false);
  assert.strictEqual(v.failed, true);
  assert.ok(/failure/.test(v.failureReason));
  assert.strictEqual(v.resolved, true);
  assert.strictEqual(acaStepsForStatus({ state: 'completed', conclusion: 'failure' }, false, true).failed, true,
    'a failed run stays a failure even past the wait bound');
});

check('a failed run whose execution WAS confirmed is not called a failed dispatch -- the job did start', () => {
  const v = acaStepsForStatus({ state: 'completed', conclusion: 'failure' }, false, false, EXEC);
  assert.strictEqual(v.failed, false);
  assert.strictEqual(v.resolved, false);
  assert.deepStrictEqual(current(v), ['Attached']);
});

check('a run that completed successfully, but with no receipt yet, is NOT reported failed before the wait expires', () => {
  const v = acaStepsForStatus({ state: 'completed', conclusion: 'success' }, false, false);
  assert.strictEqual(v.failed, false);
  assert.strictEqual(v.resolved, false);
  assert.strictEqual(v.pillLabel, 'Queued on ACA');
  assert.deepStrictEqual(done(v), ['Dispatched']);
});

check('success with no confirmed execution past the bound is an honest unknown outcome that names the lease, not a failure', () => {
  const v = acaStepsForStatus({ state: 'completed', conclusion: 'success' }, false, true);
  assert.strictEqual(v.failed, false, 'this hub has no evidence the job failed');
  assert.strictEqual(v.resolved, true);
  assert.strictEqual(v.pillLabel, 'Unknown outcome');
  assert.strictEqual(v.pillClass, 'stale');
  assert.ok(/no confirmed ACA run/.test(v.failureReason));
  assert.ok(/lease may be held elsewhere/.test(v.failureReason));
});

check('a confirmed execution whose device never attached within the bound is an unknown outcome, not a failure', () => {
  const v = acaStepsForStatus({ state: 'completed', conclusion: 'success' }, false, true, EXEC);
  assert.strictEqual(v.failed, false);
  assert.strictEqual(v.resolved, true);
  assert.strictEqual(v.pillLabel, 'Unknown outcome');
  assert.ok(/never attached/.test(v.failureReason));
});

check('a bounded wait that expires while the run is still queued, in progress or unmatched is an unknown outcome too', () => {
  for (const status of [null, { state: 'pending' }, { state: 'queued' }, { state: 'in_progress' }]) {
    const v = acaStepsForStatus(status, false, true);
    assert.strictEqual(v.resolved, true, JSON.stringify(status));
    assert.strictEqual(v.pillLabel, 'Unknown outcome');
    assert.strictEqual(v.failed, false);
  }
});

check('an errored dispatch is a failure even past the bound, never softened into an unknown outcome', () => {
  assert.strictEqual(acaStepsForStatus({ state: 'error', reason: 'x' }, false, true).failed, true);
});

check('an unsupported workflow (no correlation receipt) is a terminal unknown outcome carrying the hub\'s reason', () => {
  const reason = 'squad-dispatch.yml does not accept hub_correlation_id';
  for (const expired of [false, true]) {
    const v = acaStepsForStatus({ state: 'unsupported', reason }, false, expired);
    assert.strictEqual(v.pillLabel, 'Unknown outcome');
    assert.strictEqual(v.failureReason, reason);
    assert.strictEqual(v.resolved, true);
    assert.strictEqual(v.failed, false);
    assert.deepStrictEqual(done(v), ['Dispatched']);
  }
  assert.ok(acaStepsForStatus({ state: 'unsupported' }, false).failureReason.length > 10, 'a missing reason still gets an explanation');
});

// --- acaDeviceIdFor / acaDispatchEvidence: only what the hub proved --------

check('the job device id is aca- plus a valid execution name, and nothing else', () => {
  assert.strictEqual(acaDeviceIdFor(EXEC), `aca-${EXEC}`);
  for (const bad of [null, undefined, '', 7, 'has space', '../x', 'a/b', '-lead', 'trail-', 'x'.repeat(129), 'ü', 'a\nb']) {
    assert.strictEqual(acaDeviceIdFor(bad), null, JSON.stringify(bad));
  }
});

const runStatus = (state, extra) => ({
  state, conclusion: state === 'completed' ? 'success' : null, runId: 900, runAttempt: 1, htmlUrl: 'https://github.com/x/y/actions/runs/900', ...extra,
});
const dispatchRow = (id, status, executionName) => ({
  id, owner: 'swigerb', repo: 'squad-on-aca', ref: 'main', dispatchedAt: 1, executionName: executionName === undefined ? null : executionName, status,
});
const trackedEntry = (extra) => ({
  localId: 'e1', repo: REPO, issue: 7, dispatchedAt: Date.now(), trackerId: 'T1', status: null, attached: false,
  runId: null, runAttempt: null, executionName: null, deviceId: null, completedAt: null, confirmedAt: null, resolved: false, ...extra,
});

check('a row for this entry\'s own trackerId, with a receipt for an in-flight run, confirms the execution', () => {
  const ev = acaDispatchEvidence(trackedEntry(), dispatchRow('T1', runStatus('in_progress', { executionName: EXEC }), EXEC));
  assert.strictEqual(ev.executionName, EXEC);
  assert.strictEqual(ev.runId, 900);
  assert.strictEqual(ev.runAttempt, 1);
  assert.strictEqual(ev.status.state, 'in_progress');
});

check('a row is ignored unless it carries this entry\'s own trackerId', () => {
  assert.strictEqual(acaDispatchEvidence(trackedEntry(), dispatchRow('T2', runStatus('in_progress'), EXEC)), null);
  assert.strictEqual(acaDispatchEvidence(trackedEntry({ trackerId: null }), dispatchRow(null, runStatus('in_progress'), EXEC)), null);
  assert.strictEqual(acaDispatchEvidence(trackedEntry(), undefined), null);
  assert.strictEqual(acaDispatchEvidence(undefined, dispatchRow('T1', null)), null);
});

check('a receipt only counts for a run that is in progress or finished, with a known attempt', () => {
  for (const status of [runStatus('queued'), runStatus('pending'), runStatus('error'), runStatus('in_progress', { runAttempt: null }), runStatus('in_progress', { runAttempt: 0 })]) {
    const ev = acaDispatchEvidence(trackedEntry(), dispatchRow('T1', status, EXEC));
    assert.strictEqual(ev && ev.executionName, null, JSON.stringify(status));
  }
  assert.strictEqual(acaDispatchEvidence(trackedEntry(), dispatchRow('T1', { state: 'pending' }, EXEC)).executionName, null);
});

check('an implausible or disagreeing execution name is never trusted', () => {
  for (const bad of ['has space', '../etc', 'x'.repeat(200), '']) {
    const ev = acaDispatchEvidence(trackedEntry(), dispatchRow('T1', runStatus('in_progress', { executionName: bad }), bad));
    assert.strictEqual(ev.executionName, null, JSON.stringify(bad));
  }
  assert.strictEqual(acaDispatchEvidence(trackedEntry(),
    dispatchRow('T1', runStatus('in_progress', { executionName: 'job-a' }), 'job-b')), null,
  'the top-level and status copies must agree');
});

check('a different run, or a LOWER attempt, is never merged into what is already known', () => {
  const known = trackedEntry({ runId: 900, runAttempt: 2, executionName: 'job-new', status: runStatus('in_progress', { runAttempt: 2 }) });
  assert.strictEqual(acaDispatchEvidence(known, dispatchRow('T1', runStatus('completed', { runAttempt: 1 }), 'job-old')), null);
  assert.strictEqual(acaDispatchEvidence(known, dispatchRow('T1', runStatus('completed', { runId: 901, runAttempt: 2 }), 'job-other')), null);
  assert.strictEqual(acaDispatchEvidence(known, dispatchRow('T1', runStatus('completed', { runId: 901, runAttempt: 3 }), 'job-other')), null,
    'a different run is not a rerun of this one, even with a higher attempt number');
});

check('within one attempt the confirmed name is sticky and never changes; a rerun starts over', () => {
  const known = trackedEntry({ runId: 900, runAttempt: 1, executionName: 'job-a', status: runStatus('in_progress') });
  assert.strictEqual(acaDispatchEvidence(known, dispatchRow('T1', runStatus('completed'), null)).executionName, 'job-a');
  assert.strictEqual(acaDispatchEvidence(known, dispatchRow('T1', runStatus('completed'), 'job-b')), null,
    'a different name in the same attempt is a contradiction, ignored');
  const rerunNoReceipt = acaDispatchEvidence(known, dispatchRow('T1', runStatus('in_progress', { runAttempt: 2 }), null));
  assert.strictEqual(rerunNoReceipt.executionName, null, 'the rerun has no receipt yet -- the old attempt\'s name must not carry over');
  assert.strictEqual(rerunNoReceipt.runAttempt, 2);
  const rerun = acaDispatchEvidence(known, dispatchRow('T1', runStatus('in_progress', { runAttempt: 2 }), 'job-b'));
  assert.strictEqual(rerun.executionName, 'job-b');
});

check('a transient error never discards a confirmed execution, but is shown when nothing was confirmed', () => {
  const known = trackedEntry({ runId: 900, runAttempt: 1, executionName: 'job-a', status: runStatus('in_progress') });
  assert.strictEqual(acaDispatchEvidence(known, dispatchRow('T1', { state: 'error', reason: 'GitHub 502' })), null);
  const bound = trackedEntry({ runId: 900, runAttempt: 1, status: runStatus('queued') });
  assert.strictEqual(acaDispatchEvidence(bound, dispatchRow('T1', { state: 'error', reason: 'GitHub 502' })), null,
    'a run that was already bound is not turned into a failed dispatch by one bad read');
  const ev = acaDispatchEvidence(trackedEntry(), dispatchRow('T1', { state: 'error', reason: 'GitHub 502' }));
  assert.strictEqual(ev.status.state, 'error');
});

check('an unsupported status passes through and never confirms anything', () => {
  const ev = acaDispatchEvidence(trackedEntry(), dispatchRow('T1', { state: 'unsupported', reason: 'no receipt contract' }, EXEC));
  assert.strictEqual(ev.status.state, 'unsupported');
  assert.strictEqual(ev.executionName, null);
});

// --- acaPendingMatch / acaPendingAttached: the exact device the receipt names

const dev = (deviceId, extra) => ({ deviceId, kind: 'aca', presence: 'online', meta: null, ...extra });

check('the device named by the confirmed execution is the match, and only that device', () => {
  const entry = trackedEntry({ executionName: EXEC });
  const devices = [dev('aca-someone-elses-job'), dev(`aca-${EXEC}`), dev('desktop-1', { kind: 'local' })];
  assert.strictEqual(acaPendingMatch(entry, devices, [entry]).deviceId, `aca-${EXEC}`);
  assert.strictEqual(acaPendingAttached(entry, devices, [entry]), true);
});

check('with no confirmed execution there is nothing to join on: no device ever matches', () => {
  const entry = trackedEntry();
  const devices = [dev('aca-anything', { meta: { repo: REPO, issue: 7 } })];
  assert.strictEqual(acaPendingMatch(entry, devices, [entry]), null);
  assert.strictEqual(acaPendingAttached(entry, devices, [entry]), false);
});

check('an older or concurrent session for the SAME repository and issue never attaches, however well it fits', () => {
  const entry = trackedEntry({ executionName: EXEC, dispatchedAt: 5000 });
  const devices = [
    dev('aca-older-job-aaaa', { meta: { repo: REPO, issue: 7, executionName: 'older-job-aaaa' } }),
    dev('aca-concurrent-job-bbbb', { meta: { repo: REPO, issue: 7 } }),
  ];
  assert.strictEqual(acaPendingMatch(entry, devices, [entry]), null);
});

check('near-miss device ids never match: other prefix, other case, extra suffix', () => {
  const entry = trackedEntry({ executionName: EXEC });
  for (const id of [EXEC, `ACA-${EXEC}`, `aca-${EXEC}-2`, `aca-${EXEC.slice(0, -1)}`, `xaca-${EXEC}`]) {
    assert.strictEqual(acaPendingMatch(entry, [dev(id)], [entry]), null, id);
  }
});

check('a device that reports facts contradicting the entry is refused; absent facts are fine', () => {
  const entry = trackedEntry({ executionName: EXEC });
  const id = `aca-${EXEC}`;
  assert.ok(acaPendingMatch(entry, [dev(id, { meta: null })], [entry]), 'today\'s jobs send no meta at all');
  assert.ok(acaPendingMatch(entry, [dev(id, { meta: { repo: REPO.toUpperCase(), issue: 7, executionName: EXEC } })], [entry]));
  assert.strictEqual(acaPendingMatch(entry, [dev(id, { meta: { repo: 'someone/else' } })], [entry]), null);
  assert.strictEqual(acaPendingMatch(entry, [dev(id, { meta: { issue: 8 } })], [entry]), null);
  assert.strictEqual(acaPendingMatch(entry, [dev(id, { meta: { executionName: 'another-exec' } })], [entry]), null);
});

check('two tracked entries that resolve to the same device never both claim it -- neither does', () => {
  const a = trackedEntry({ localId: 'a', trackerId: 'TA', executionName: EXEC });
  const b = trackedEntry({ localId: 'b', trackerId: 'TB', executionName: EXEC });
  const devices = [dev(`aca-${EXEC}`)];
  assert.strictEqual(acaPendingMatch(a, devices, [a, b]), null);
  assert.strictEqual(acaPendingMatch(b, devices, [a, b]), null);
});

check('an empty, undefined, or malformed device list never throws and never matches', () => {
  const entry = trackedEntry({ executionName: EXEC });
  for (const devices of [[], undefined, null, [{}], [null], [{ deviceId: null }]]) {
    assert.strictEqual(acaPendingAttached(entry, devices, [entry]), false);
  }
  assert.strictEqual(acaPendingMatch(undefined, undefined, undefined), null);
  assert.strictEqual(acaPendingMatch({}, [{}]), null);
  assert.strictEqual(acaPendingMatch(entry, [dev(`aca-${EXEC}`), dev(`aca-${EXEC}`)], [entry]), null, 'a duplicated device id is ambiguous, not a match');
});

// --- the pending row ---------------------------------------------------------

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

check('a row with a confirmed execution shows three steps done and "Attached" as the one in flight', () => {
  const html = acaPendingRowHtml(trackedEntry({ executionName: EXEC, confirmedAt: Date.now(), status: runStatus('completed') }));
  assert.strictEqual((html.match(/aca-step done/g) || []).length, 3, html);
  assert.ok(/aca-step now">Attached/.test(html), html);
  assert.ok(!html.includes('Check again'), 'a row still waiting inside its bound offers no retry');
});

check('a completed-success row with no receipt still shows "Queued on ACA" while within the bounded wait', () => {
  const html = acaPendingRowHtml({
    localId: 'x', repo: REPO, dispatchedAt: Date.now(),
    completedAt: Date.now() - (ACA_COMPLETED_WAIT_MS - 1000),
    status: { state: 'completed', conclusion: 'success' },
  });
  assert.ok(!html.includes('Unknown outcome'), html);
});

check('a completed-success row past the bounded wait reports an honest unknown outcome and offers "Check again"', () => {
  const html = acaPendingRowHtml({
    localId: 'x', repo: REPO, dispatchedAt: Date.now(),
    completedAt: Date.now() - (ACA_COMPLETED_WAIT_MS + 1000),
    status: { state: 'completed', conclusion: 'success' },
  });
  assert.ok(html.includes('Unknown outcome'), html);
  assert.ok(html.includes('data-aca-retry="x"'), html);
});

check('a confirmed execution that never attached is bounded from its confirmation, and a stuck run from its dispatch', () => {
  const waiting = (extra) => acaPendingRowHtml(trackedEntry({ status: runStatus('in_progress'), ...extra }));
  assert.ok(!waiting({ executionName: EXEC, confirmedAt: Date.now() - (ACA_COMPLETED_WAIT_MS - 1000) }).includes('Unknown outcome'));
  assert.ok(waiting({ executionName: EXEC, confirmedAt: Date.now() - (ACA_COMPLETED_WAIT_MS + 1000) }).includes('Unknown outcome'));
  assert.ok(!waiting({ dispatchedAt: Date.now() - (ACA_MAX_PENDING_MS - 60_000) }).includes('Unknown outcome'));
  assert.ok(waiting({ dispatchedAt: Date.now() - (ACA_MAX_PENDING_MS + 60_000) }).includes('Unknown outcome'));
});

check('an unsupported row is terminal, explained, and never claims a failure the hub cannot prove', () => {
  const html = acaPendingRowHtml(trackedEntry({ status: { state: 'unsupported', reason: 'squad-dispatch.yml has no receipt contract' } }));
  assert.ok(html.includes('Unknown outcome'));
  assert.ok(html.includes('squad-dispatch.yml has no receipt contract'));
  assert.ok(!html.includes('Dispatch failed'));
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
    await checkAsync('a stale failed dispatch cannot unlock or overwrite a newer submission', async () => {
      const f = dialogFixture();
      f.open('First job');
      const first = f.submitAcaDispatch();
      f.element('acaScrim').hidden = true;
      f.open('Second job');
      const second = f.submitAcaDispatch();
      let duplicate;
      try {
        f.requests[0].reject(new Error('first job failed'));
        await first;
        assert.strictEqual(f.element('acaStart').disabled, true, 'the older finally unlocked the newer POST');
        assert.strictEqual(f.element('acaStart').textContent, 'Starting\u2026');
        assert.strictEqual(f.element('acaErr').hidden, true, 'the older catch overwrote the newer form');
        assert.match(f.notifications[0], /previous job: first job failed/, 'the older request failure was silently lost');
        duplicate = f.submitAcaDispatch();
        assert.strictEqual(f.requests.length, 2, 'the newer job was dispatched twice');
      } finally {
        for (const reply of f.requests.slice(1)) reply.resolve({ issue: { number: 43 }, trackerId: 'T-second' });
        await Promise.all([second, duplicate]);
      }
    });

    await checkAsync('a stale successful dispatch is tracked without closing a newer dialog', async () => {
      const f = dialogFixture();
      f.open('First job');
      const first = f.submitAcaDispatch();
      f.element('acaScrim').hidden = true;
      f.open('Second job');
      const second = f.submitAcaDispatch();
      try {
        f.requests[0].resolve({ issue: { number: 42 }, trackerId: 'T-first' });
        await first;
        assert.strictEqual(f.element('acaScrim').hidden, false, 'the older success closed the newer dialog');
        assert.strictEqual(f.element('acaStart').disabled, true);
        assert.strictEqual(f.tracked.length, 1, 'the completed older job was lost');
        assert.strictEqual(f.tracked[0].trackerId, 'T-first');
      } finally {
        f.requests[1].resolve({ issue: { number: 43 }, trackerId: 'T-second' });
        await second;
      }
      assert.strictEqual(f.element('acaScrim').hidden, true, 'the current success did not close its own dialog');
      assert.deepStrictEqual(f.tracked.map((entry) => entry.trackerId), ['T-first', 'T-second']);
    });

    await checkAsync('an in-flight dispatch rejects a second submission from the same dialog', async () => {
      const f = dialogFixture();
      f.open('One job');
      const first = f.submitAcaDispatch();
      let duplicate;
      try {
        duplicate = f.submitAcaDispatch();
        assert.strictEqual(f.requests.length, 1, 'two invocations sent the same job twice');
      } finally {
        for (const reply of f.requests) reply.resolve({ issue: { number: 42 }, trackerId: 'T-one' });
        await Promise.all([first, duplicate]);
      }
    });

    await checkAsync('a stale repository failure cannot disable a reopened ACA dialog', async () => {
      const older = deferred();
      const newer = deferred();
      const f = dialogFixture([older, newer]);
      f.open('First job');
      f.element('acaScrim').hidden = true;
      f.open('Second job');
      older.reject(Object.assign(new Error('no App'), { status: 501 }));
      await Promise.resolve();
      assert.strictEqual(f.element('acaForm').hidden, false);
      assert.strictEqual(f.element('acaStart').hidden, false);
      newer.resolve({ repos: [] });
      await Promise.resolve();
    });

    await checkAsync('a stale repository success cannot overwrite the reopened ACA repository list', async () => {
      const older = deferred();
      const newer = deferred();
      const f = dialogFixture([older, newer]);
      f.open('First job');
      f.element('acaScrim').hidden = true;
      f.open('Second job');
      newer.resolve({ repos: [{ fullName: 'acme/widgets', hasDispatchWorkflow: true }] });
      await new Promise((resolve) => setImmediate(resolve));
      older.resolve({ repos: [{ fullName: 'stale/old', hasDispatchWorkflow: false }] });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(f.state.acaRepos.map((r) => r.fullName), ['acme/widgets']);
    });

    // The dialog as a person meets it: the REAL `openAca` defaults (Publish PR
    // checked, Watch-only unchecked), the repository list answering what the
    // hub read from the workflow, and the body Start posts (#251, F3).
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const dispatchedBody = async (repos, tweak) => {
      const reply = deferred();
      const f = dialogFixture([reply]);
      f.open('Compatibility job');
      if (tweak) tweak(f);
      if (repos) {
        reply.resolve({ repos });
        await settle();
      }
      const sent = f.submitAcaDispatch();
      const { body } = f.requests[0];
      f.requests[0].resolve({ issue: { number: 42 }, trackerId: 'T-compat' });
      await sent;
      return { body, f };
    };
    const legacyRepo = [{ fullName: 'acme/widgets', hasDispatchWorkflow: true, declaredInputs: ['issue', 'prompt'] }];
    const modernRepo = [{
      fullName: 'acme/widgets', hasDispatchWorkflow: true,
      declaredInputs: ['issue', 'prompt', 'publish_pr', 'watch_only'],
    }];

    await checkAsync('an untouched dialog dispatches to a legacy workflow without Publish PR or Watch-only, and says why', async () => {
      const { body, f } = await dispatchedBody(legacyRepo);
      assert.strictEqual(body.publishPr, null);
      assert.strictEqual(body.watchOnly, null);
      assert.match(f.element('acaOptionsHint').textContent, /does not declare publish_pr or watch_only/);
    });

    await checkAsync('unchecking Publish PR on a legacy workflow is still sent, never silently dropped', async () => {
      const { body } = await dispatchedBody(legacyRepo, (f) => { f.element('acaPublishPr').checked = false; });
      assert.strictEqual(body.publishPr, false);
      assert.strictEqual(body.watchOnly, null);
    });

    await checkAsync('a workflow that declares the options receives the dialog\'s checked and unchecked choices', async () => {
      const untouched = await dispatchedBody(modernRepo);
      assert.strictEqual(untouched.body.publishPr, true);
      assert.strictEqual(untouched.body.watchOnly, false);
      assert.strictEqual(untouched.f.element('acaOptionsHint').textContent, '');
      const changed = await dispatchedBody(modernRepo, (f) => {
        f.element('acaPublishPr').checked = false;
        f.element('acaWatchOnly').checked = true;
      });
      assert.strictEqual(changed.body.publishPr, false);
      assert.strictEqual(changed.body.watchOnly, true);
    });

    await checkAsync('before the repository list has answered, the dialog does not assume the workflow\'s capabilities', async () => {
      const reply = deferred();
      const f = dialogFixture([reply]);
      f.open('Early job');
      const sent = f.submitAcaDispatch();
      assert.strictEqual(f.requests[0].body.publishPr, true);
      assert.strictEqual(f.requests[0].body.watchOnly, false);
      f.requests[0].resolve({ issue: { number: 42 }, trackerId: 'T-early' });
      await sent;
    });

    await checkAsync('a repository list that failed to load leaves the capability unknown', async () => {
      const reply = deferred();
      const f = dialogFixture([reply]);
      f.open('Offline list job');
      reply.reject(Object.assign(new Error('upstream down'), { status: 502 }));
      await settle();
      const sent = f.submitAcaDispatch();
      assert.strictEqual(f.requests[0].body.publishPr, true);
      assert.strictEqual(f.requests[0].body.watchOnly, false);
      f.requests[0].resolve({ issue: { number: 42 }, trackerId: 'T-offline' });
      await sent;
    });

    await checkAsync('a capability read on an earlier open is not reused once the dialog is reopened', async () => {
      const first = deferred();
      const second = deferred();
      const f = dialogFixture([first, second]);
      f.open('First job');
      first.resolve({ repos: legacyRepo });
      await settle();
      f.element('acaScrim').hidden = true;
      f.open('Second job');
      assert.strictEqual(f.element('acaOptionsHint').textContent, '');
      const sent = f.submitAcaDispatch();
      assert.strictEqual(f.requests[0].body.publishPr, true, 'the earlier open\'s capability decided this dispatch');
      f.requests[0].resolve({ issue: { number: 42 }, trackerId: 'T-reopen' });
      await sent;
      second.resolve({ repos: [] });
    });

    await checkAsync('a current dispatch failure remains visible and permits a deliberate retry', async () => {
      const f = dialogFixture();
      f.open('Retry job');
      const first = f.submitAcaDispatch();
      f.requests[0].reject(new Error('workflow refused'));
      await first;
      assert.strictEqual(f.element('acaScrim').hidden, false);
      assert.strictEqual(f.element('acaErr').hidden, false);
      assert.match(f.element('acaErr').textContent, /workflow refused/);
      assert.strictEqual(f.element('acaStart').disabled, false);
      const retry = f.submitAcaDispatch();
      assert.strictEqual(f.requests.length, 2);
      f.requests[1].resolve({ issue: { number: 42 }, trackerId: 'T-retry' });
      await retry;
      assert.strictEqual(f.element('acaScrim').hidden, true);
    });

    // --- #253 (F4): a dispatch that failed after creating its issue ----------
    // The hub creates the issue first, so a failed dispatch leaves one behind and
    // answers `{error, issue: {number, url}}`. The dialog must move to that issue
    // rather than leave New-issue mode, where Start would create a second one.
    const failedAfterIssue = (number = 42, message = 'workflow_dispatch refused') => Object.assign(new Error(message), {
      status: 502, body: { error: message, issue: { number, url: `https://github.com/acme/widgets/issues/${number}` } },
    });
    const fillOptions = (f) => {
      f.choose('branch', 'release');
      f.element('acaModel').value = 'a-model';
      f.element('acaReviewer').value = 'someone';
      f.element('acaPublishPr').checked = false;
      f.element('acaWatchOnly').checked = true;
    };

    check('only a positive integer number from a New-issue request is a created issue', () => {
      const asked = { repo: 'acme/widgets', issue: null, newIssue: { title: 'T' } };
      const failure = (issue) => ({ body: { issue } });
      const ok = acaCreatedIssueOf(failure({ number: 42, url: 'https://evil.example/x' }), asked);
      assert.deepStrictEqual(ok, { repo: 'acme/widgets', number: 42, link: 'https://github.com/acme/widgets/issues/42' });
      for (const number of ['42', 0, -1, 1.5, NaN, Infinity, 2 ** 60, null, undefined, true, {}, [42]]) {
        assert.strictEqual(acaCreatedIssueOf(failure({ number }), asked), null, `accepted ${String(number)}`);
      }
      for (const issue of [undefined, null, 42, 'x', [], {}]) {
        assert.strictEqual(acaCreatedIssueOf(failure(issue), asked), null, `accepted issue ${JSON.stringify(issue)}`);
      }
      for (const e of [null, undefined, new Error('plain'), { body: null }, { body: 'text' }]) {
        assert.strictEqual(acaCreatedIssueOf(e, asked), null);
      }
      assert.strictEqual(acaCreatedIssueOf(failure({ number: 42 }), { repo: 'acme/widgets', issue: 7, newIssue: null }), null,
        'an Existing-issue request was described as having created an issue');
      assert.strictEqual(acaCreatedIssueOf(failure({ number: 42 }), { repo: 'acme/widgets', issue: null, newIssue: null }), null);
      assert.strictEqual(acaCreatedIssueOf(failure({ number: 42 }), null), null);
    });

    await checkAsync('a dispatch that failed after creating issue N selects Existing issue N, says the dispatch failed, and retries on N (#253 F4)', async () => {
      const f = dialogFixture();
      f.open('Retry on the created issue');
      fillOptions(f);
      f.element('acaNewIssueTitle').value = 'A custom title';
      const first = f.submitAcaDispatch();
      assert.deepStrictEqual([f.requests[0].body.issue, f.requests[0].body.newIssue], [null, { title: 'A custom title' }]);
      f.requests[0].reject(failedAfterIssue(42));
      await first;

      assert.strictEqual(f.element('acaScrim').hidden, false, 'the dialog closed on a failed dispatch');
      assert.strictEqual(f.element('acaIssueModeExisting').checked, true, 'the form stayed in New-issue mode');
      assert.strictEqual(f.element('acaIssueNumber').value, '#42');
      assert.strictEqual(f.boxFor('issue').value(), 42, 'the created issue was typed in, not chosen');
      assert.strictEqual(f.element('acaNewIssueFields').hidden, true);
      assert.strictEqual(f.element('acaExistingIssueFields').hidden, false);
      const shown = f.element('acaErr').innerHTML;
      assert.strictEqual(f.element('acaErr').hidden, false);
      assert.match(shown, /Could not start the job: workflow_dispatch refused/);
      assert.match(shown, /acme\/widgets#42 was already created/);
      assert.match(shown, /dispatch failed or was not confirmed/);
      assert.match(shown, /Existing issue #42 is selected/);
      assert.match(shown, /href="https:\/\/github\.com\/acme\/widgets\/issues\/42" target="_blank" rel="noopener noreferrer"/);
      assert.doesNotMatch(shown, /Dispatched|is queued|has started|running on ACA/, 'a failed dispatch was described as started');
      assert.deepStrictEqual(f.notifications, [], 'a failure was announced as a success');
      assert.strictEqual(f.tracked.length, 0, 'a pending row was tracked for a dispatch that never started');
      assert.strictEqual(f.element('acaStart').disabled, false);
      assert.strictEqual(f.element('acaStart').textContent, 'Start job');

      const retry = f.submitAcaDispatch();
      assert.strictEqual(f.requests.length, 2);
      const { body } = f.requests[1];
      assert.strictEqual(body.issue, 42, 'the retry was not sent against the created issue');
      assert.strictEqual(body.newIssue, null, 'the retry asked for another new issue');
      assert.deepStrictEqual(
        { ...body, issue: null, newIssue: null },
        { ...f.requests[0].body, issue: null, newIssue: null },
        'the retry changed the repository, options or instructions the person had entered',
      );
      f.requests[1].resolve({ issue: { number: 42 }, trackerId: 'T-retry' });
      await retry;
      assert.strictEqual(f.element('acaScrim').hidden, true);
      assert.strictEqual(f.tracked.length, 1);
    });

    await checkAsync('metadata from a failed Existing-issue request never claims a creation or changes the form (#253 F4)', async () => {
      const f = dialogFixture();
      f.open('Existing issue job');
      f.element('acaIssueModeExisting').checked = true;
      f.choose('issue', 7, '#7 An open issue');
      const sent = f.submitAcaDispatch();
      f.requests[0].reject(failedAfterIssue(99));
      await sent;
      assert.strictEqual(f.boxFor('issue').value(), 7);
      assert.strictEqual(f.element('acaErr').hidden, false);
      assert.strictEqual(f.element('acaErr').textContent, 'Could not start the job: workflow_dispatch refused');
      assert.strictEqual(f.element('acaErr').innerHTML, undefined, 'the failure was rendered as a creation');
    });

    await checkAsync('a failure without usable created-issue metadata keeps the ordinary failure and New-issue mode (#253 F4)', async () => {
      for (const issue of [undefined, null, { number: '42' }, { number: 0 }, { number: 1.5 }, 42]) {
        const f = dialogFixture();
        f.open('No metadata job');
        const sent = f.submitAcaDispatch();
        f.requests[0].reject(Object.assign(new Error('GitHub refused'), { status: 502, body: { error: 'GitHub refused', issue } }));
        await sent;
        const label = JSON.stringify(issue);
        assert.strictEqual(f.element('acaErr').hidden, false, label);
        assert.strictEqual(f.element('acaErr').textContent, 'Could not start the job: GitHub refused', label);
        assert.strictEqual(f.element('acaIssueModeExisting').checked, undefined, `mode changed for ${label}`);
        assert.strictEqual(f.element('acaIssueNumber').value, '', `number bound for ${label}`);
      }
      const plain = dialogFixture();
      plain.open('Plain failure');
      const sent = plain.submitAcaDispatch();
      plain.requests[0].reject(new Error('offline'));
      await sent;
      assert.strictEqual(plain.element('acaErr').textContent, 'Could not start the job: offline');
      assert.strictEqual(plain.element('acaIssueNumber').value, '');
    });

    await checkAsync('an error arriving after the dialog was reopened reports the issue without touching the new form (#253 F4)', async () => {
      const f = dialogFixture();
      f.open('First job');
      const first = f.submitAcaDispatch();
      f.element('acaScrim').hidden = true;
      f.open('Second job');
      f.choose('repo', 'other/repo');
      f.requests[0].reject(failedAfterIssue(42));
      await first;
      assert.strictEqual(f.element('acaIssueModeExisting').checked, undefined, 'the older error switched the newer form to Existing issue');
      assert.strictEqual(f.element('acaIssueNumber').value, '', 'issue 42 of acme/widgets was bound into the newer form');
      assert.strictEqual(f.element('acaErr').hidden, true, 'the older error overwrote the newer form');
      assert.strictEqual(f.element('acaRepo').value, 'other/repo');
      assert.strictEqual(f.element('acaPrompt').value, 'Second job');
      assert.strictEqual(f.notifications.length, 1, 'the older failure was silently lost');
      assert.match(f.notifications[0], /previous job: workflow_dispatch refused/);
      assert.match(f.notifications[0], /acme\/widgets#42 was already created/);
      assert.match(f.notifications[0], /Retry on that issue, not as a new one/);
      assert.strictEqual(f.element('acaStart').disabled, false);
    });

    await checkAsync('an error arriving after the dialog was closed reports the issue and leaves the next open alone (#253 F4)', async () => {
      const f = dialogFixture();
      f.open('Closed job');
      const sent = f.submitAcaDispatch();
      f.element('acaScrim').hidden = true;
      f.requests[0].reject(failedAfterIssue(42));
      await sent;
      assert.strictEqual(f.element('acaIssueNumber').value, '');
      assert.strictEqual(f.element('acaIssueModeExisting').checked, undefined);
      assert.match(f.notifications[0], /acme\/widgets#42 was already created/);
    });

    await checkAsync('changing the repository while the request is in flight keeps issue N out of the new repository (#253 F4)', async () => {
      const f = dialogFixture();
      f.open('Repository changed job');
      const sent = f.submitAcaDispatch();
      f.choose('repo', 'other/repo');
      f.requests[0].reject(failedAfterIssue(42));
      await sent;
      assert.strictEqual(f.element('acaIssueModeExisting').checked, undefined, 'issue 42 of acme/widgets was selected for other/repo');
      assert.strictEqual(f.element('acaIssueNumber').value, '');
      assert.strictEqual(f.element('acaRepo').value, 'other/repo');
      const shown = f.element('acaErr').innerHTML;
      assert.match(shown, /acme\/widgets#42 was already created/);
      assert.match(shown, /left as you set it/);
      assert.match(shown, /Existing issue 42 with acme\/widgets/);
      assert.match(shown, /href="https:\/\/github\.com\/acme\/widgets\/issues\/42"/);
      assert.doesNotMatch(shown, /other\/repo/);
    });

    await checkAsync('an Existing issue the person chose while the request was in flight is not overwritten (#253 F4)', async () => {
      const f = dialogFixture();
      f.open('Changed mode job');
      const sent = f.submitAcaDispatch();
      f.element('acaIssueModeExisting').checked = true;
      f.choose('issue', 77, '#77 Mine');
      f.requests[0].reject(failedAfterIssue(42));
      await sent;
      assert.strictEqual(f.boxFor('issue').value(), 77, 'the person\'s own issue number was overwritten');
      assert.match(f.element('acaErr').innerHTML, /acme\/widgets#42 was already created/);
      assert.match(f.element('acaErr').innerHTML, /left as you set it/);
    });

    // --- #257: the dialog sends what was CHOSEN from the target's own lists ------
    const okChoices = (extra = {}) => ({
      repo: 'acme/widgets',
      defaultBranch: 'trunk',
      workflow: { exists: true, declaredInputs: [] },
      model: { state: 'ok', source: 'repository-config', default: 'm-default', choices: [{ id: 'm-default' }, { id: 'm-fast', hint: 'fast' }] },
      reviewer: { state: 'ok', source: 'casting-registry', choices: [{ id: 'lead' }, { id: 'tester' }] },
      ...extra,
    });
    const optionValues = (el) => (el.options || []).map((o) => o.value);

    await checkAsync('typed text that names nothing in the list is never sent, and no request is made for it (#257)', async () => {
      const f = dialogFixture();
      f.open('Typed branch');
      f.boxFor('branch').setText('release/typo');
      const sent = f.submitAcaDispatch();
      assert.strictEqual(f.requests.length, 0, 'a dispatch went out for text that was never chosen');
      assert.match(f.lookups[0].url, /^\/api\/aca\/branches\?repo=acme%2Fwidgets&q=release%2Ftypo&page=1$/);
      f.lookups[0].resolve({ branches: [], nextPage: null });
      await settle();
      assert.strictEqual(f.requests.length, 0, 'a dispatch went out once the lookup found nothing');
      await sent;
      assert.strictEqual(f.element('acaErr').hidden, false);
      assert.match(f.element('acaErr').textContent, /Choose the base branch from the list/);
      assert.strictEqual(f.element('acaStart').disabled, false);
    });

    await checkAsync('a value typed in full is looked up against the target and, if it is there, chosen and sent (#257)', async () => {
      const f = dialogFixture();
      f.open('Typed branch');
      f.boxFor('branch').setText('release/1.0');
      const sent = f.submitAcaDispatch();
      f.lookups[0].resolve({ branches: [{ name: 'release/1.0.1' }, { name: 'release/1.0' }], nextPage: null });
      await settle();
      assert.strictEqual(f.requests[0].body.baseBranch, 'release/1.0');
      f.requests[0].resolve({ issue: { number: 1 }, trackerId: 'T-typed' });
      await sent;
    });

    await checkAsync('an issue that was typed but never chosen blocks Existing-issue dispatch (#257)', async () => {
      const f = dialogFixture();
      f.open('Existing issue');
      f.element('acaIssueModeExisting').checked = true;
      f.boxFor('issue').setText('999');
      const sent = f.submitAcaDispatch();
      f.lookups[0].resolve({ issues: [{ number: 12, title: 'Another issue' }], nextPage: null });
      await sent;
      assert.strictEqual(f.requests.length, 0);
      assert.match(f.element('acaErr').textContent, /Choose the issue from the list/);
    });

    await checkAsync('choosing a repository asks THAT repository for its choices, and fills model and reviewer from the reply (#257)', async () => {
      const f = dialogFixture();
      f.open('Choices');
      assert.strictEqual(f.choiceRequests.length, 1);
      assert.strictEqual(f.choiceRequests[0].url, '/api/aca/choices?repo=acme%2Fwidgets');
      assert.strictEqual(f.element('acaModel').disabled, true, 'a model could be picked before the target answered');
      assert.match(f.element('acaModelNote').textContent, /Loading/);
      f.choiceRequests[0].resolve(okChoices());
      await settle();
      assert.deepStrictEqual(optionValues(f.element('acaModel')), ['', 'm-default', 'm-fast']);
      assert.deepStrictEqual(optionValues(f.element('acaReviewer')), ['', 'lead', 'tester']);
      assert.strictEqual(f.element('acaModel').disabled, false);
      assert.strictEqual(f.element('acaModel').value, '', 'the default is explicit, not the first catalog entry');
      assert.strictEqual(f.element('acaModel').options[2].text, 'm-fast (fast)');
      assert.match(f.element('acaModelNote').textContent, /Not a check of what the job can run/);
      assert.match(f.element('acaBranch').placeholder, /trunk/);
    });

    await checkAsync('model and reviewer say why only the default is offered, and never offer a made-up list (#257)', async () => {
      const cases = [
        [{ state: 'default-only', choices: [], reason: 'the repository names no model' }, /Only the Squad default is available: the repository names no model/],
        [{ state: 'unsupported', choices: [], reason: 'squad-dispatch.yml declares no model input' }, /Only the Squad default is available: squad-dispatch.yml declares no model input/],
        [{ state: 'unavailable', choices: [], reason: 'its config is malformed' }, /Could not list models: its config is malformed/],
      ];
      for (const [model, note] of cases) {
        const f = dialogFixture();
        f.open('States');
        f.choiceRequests[0].resolve(okChoices({ model }));
        await settle();
        assert.deepStrictEqual(optionValues(f.element('acaModel')), [''], model.state);
        assert.strictEqual(f.element('acaModel').disabled, true, model.state);
        assert.match(f.element('acaModelNote').textContent, note, model.state);
        assert.strictEqual(f.element('acaChoicesRetry').hidden, model.state !== 'unavailable', model.state);
      }
    });

    await checkAsync('a failed choices request disables model and reviewer, says so, and offers a retry (#257)', async () => {
      const f = dialogFixture();
      f.open('Failure');
      f.choiceRequests[0].reject(Object.assign(new Error('GitHub could not be reached'), { status: 502 }));
      await settle();
      assert.strictEqual(f.element('acaModel').disabled, true);
      assert.strictEqual(f.element('acaReviewer').disabled, true);
      assert.match(f.element('acaModelNote').textContent, /Could not load this repository's choices: GitHub could not be reached/);
      assert.strictEqual(f.element('acaChoicesRetry').hidden, false);
      const sent = f.submitAcaDispatch();
      assert.strictEqual(f.requests[0].body.model, null, 'a model nobody could choose was sent');
      f.requests[0].resolve({ issue: { number: 1 }, trackerId: 'T-fail' });
      await sent;
    });

    await checkAsync('changing the repository drops every choice that belonged to the old one and ignores its late reply (#257)', async () => {
      const f = dialogFixture();
      f.open('Switch');
      f.choose('branch', 'release');
      f.choose('issue', 5, '#5 Old issue');
      f.element('acaModel').value = 'm-fast';
      f.element('acaReviewer').value = 'lead';
      f.choose('repo', 'other/repo');
      assert.strictEqual(f.boxFor('branch').value(), null);
      assert.strictEqual(f.boxFor('issue').value(), null);
      assert.strictEqual(f.element('acaBranch').value, '');
      assert.strictEqual(f.element('acaModel').value, '', 'the old repository\'s model survived the change');
      assert.strictEqual(f.element('acaReviewer').value, '', 'the old repository\'s reviewer survived the change');
      assert.strictEqual(f.choiceRequests[1].url, '/api/aca/choices?repo=other%2Frepo');

      // The first answer for the repository that was replaced arrives LAST.
      f.choiceRequests[1].resolve(okChoices({ model: { state: 'ok', choices: [{ id: 'other-model' }] } }));
      await settle();
      f.choiceRequests[0].resolve(okChoices({ model: { state: 'ok', choices: [{ id: 'stale-model' }] } }));
      await settle();
      assert.deepStrictEqual(optionValues(f.element('acaModel')), ['', 'other-model'], 'a late reply overwrote the current repository\'s choices');
      const sent = f.submitAcaDispatch();
      assert.strictEqual(f.requests[0].body.repo, 'other/repo');
      assert.strictEqual(f.requests[0].body.baseBranch, null);
      assert.strictEqual(f.requests[0].body.model, null);
      f.requests[0].resolve({ issue: { number: 1 }, trackerId: 'T-switch' });
      await sent;
    });

    await checkAsync('replacing the repository aborts the choices request still in flight for the old one (#257)', async () => {
      const f = dialogFixture();
      f.open('Abort');
      f.choose('repo', 'other/repo');
      assert.strictEqual(f.choiceRequests[0].signal.aborted, true);
      assert.strictEqual(f.choiceRequests[1].signal.aborted, false);
    });

    await checkAsync('clearing the repository aborts the choices request still in flight and shows no choices (#257)', async () => {
      const f = dialogFixture();
      f.open('Cleared');
      assert.strictEqual(f.choiceRequests[0].signal.aborted, false);
      f.boxFor('repo').opts.onChange(null);
      assert.strictEqual(f.choiceRequests[0].signal.aborted, true, 'the old repository\'s request kept running after it was cleared');
      assert.match(f.element('acaModelNote').textContent, /Choose a repository to see its choices/);
      assert.strictEqual(f.element('acaModel').disabled, true);
    });

    await checkAsync('branch and issue are unavailable until a repository is chosen, and again once it is cleared (#257)', async () => {
      const f = dialogFixture();
      f.dialogOpen = f.openAca();
      assert.match(f.boxFor('branch').blocked, /Choose a repository first/);
      assert.match(f.boxFor('issue').blocked, /Choose a repository first/);
      f.choose('repo', 'acme/widgets');
      assert.strictEqual(f.boxFor('branch').blocked, null);
      assert.strictEqual(f.boxFor('issue').blocked, null);
      f.boxFor('repo').opts.onChange(null);
      assert.match(f.boxFor('branch').blocked, /Choose a repository first/);
      assert.match(f.element('acaModelNote').textContent, /Choose a repository/);
    });

    await checkAsync('a repository the hub refused for a field clears that choice and reloads the list it came from (#257)', async () => {
      const f = dialogFixture();
      f.open('Refused');
      f.choiceRequests[0].resolve(okChoices());
      await settle();
      f.choose('branch', 'gone');
      f.element('acaModel').value = 'm-fast';
      let focused = null;
      f.element('acaBranch').focus = () => { focused = 'acaBranch'; };
      f.element('acaModel').focus = () => { focused = 'acaModel'; };
      const first = f.submitAcaDispatch();
      f.requests[0].reject(Object.assign(new Error('branch "gone" does not exist in acme/widgets'), {
        status: 422, body: { error: 'branch "gone" does not exist', field: 'baseBranch' },
      }));
      await first;
      assert.strictEqual(f.boxFor('branch').value(), null, 'a branch the repository rejected stayed chosen');
      assert.strictEqual(focused, 'acaBranch');
      assert.match(f.element('acaErr').textContent, /does not exist in acme\/widgets/);

      const second = f.submitAcaDispatch();
      f.requests[1].reject(Object.assign(new Error('model "m-fast" is not offered'), {
        status: 422, body: { error: 'model not offered', field: 'model' },
      }));
      await second;
      assert.strictEqual(focused, 'acaModel');
      assert.strictEqual(f.choiceRequests.length, 2, 'the model list was not reloaded after the model was refused');
      assert.strictEqual(f.element('acaModel').value, '');
    });

    await checkAsync('a hub with no GitHub App leaves repository and issue as plain text for the link fallback (#257)', async () => {
      const reply = deferred();
      const f = dialogFixture([reply]);
      f.open('No app');
      f.boxFor('repo').setText('acme/widgets');
      reply.reject(Object.assign(new Error('no App'), { status: 501 }));
      await settle();
      assert.strictEqual(f.boxFor('repo').free, true);
      assert.strictEqual(f.boxFor('issue').free, true);
      assert.strictEqual(f.boxFor('issue').blocked, null, 'the issue box was blocked on a hub with nothing to search');
      f.boxFor('issue').setText('#72');
      assert.strictEqual(f.boxFor('issue').value(), '#72');
    });

    await checkAsync('the repository the session ran in is only a prefill: it is chosen only if the list contains it (#257)', async () => {
      const reply = deferred();
      const f = dialogFixture([reply]);
      f.state.currentSession = { session: { prompt: 'p', git: { host: 'github.com', repository: 'acme/widgets' } } };
      f.openAca();
      assert.strictEqual(f.boxFor('repo').value(), null, 'a prefill was treated as a chosen repository');
      assert.strictEqual(f.choiceRequests.length, 0);
      reply.resolve({ repos: [{ fullName: 'acme/widgets', hasDispatchWorkflow: true }] });
      await settle();
      assert.strictEqual(f.boxFor('repo').value(), 'acme/widgets');
      assert.strictEqual(f.choiceRequests.length, 1);

      const other = deferred();
      const g = dialogFixture([other]);
      g.state.currentSession = { session: { prompt: 'p', git: { host: 'github.com', repository: 'private/not-granted' } } };
      g.openAca();
      other.resolve({ repos: [{ fullName: 'acme/widgets', hasDispatchWorkflow: true }] });
      await settle();
      assert.strictEqual(g.boxFor('repo').value(), null, 'a repository outside the list was chosen');
      assert.strictEqual(g.choiceRequests.length, 0);
    });

    check('the dispatch body refuses unresolved typed text and still names a blank repository (#257)', () => {
      const r = acaBuildDispatchBody({ ...baseForm(), unresolved: ['the repository', 'the base branch'] });
      assert.strictEqual(r.ok, false);
      assert.match(r.reason, /Choose the repository and the base branch from the list/);
      const blank = acaBuildDispatchBody({ ...baseForm(), repo: '' });
      assert.strictEqual(blank.ok, false);
      assert.match(blank.reason, /repository/);
    });
    await checkAsync('a live overview invalidates an older GET without losing the pushed session', async () => {
      const fs = require('fs');
      const path = require('path');
      const source = stripModuleSyntax(fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'ws.js'), 'utf8'));
      const reply = deferred();
      const clientState = { token: 'test', filters: {}, overview: { groups: [] } };
      const conn = { dataset: {}, setAttribute() {} };
      class FakeWebSocket { close() {} }
      const client = new Function('state', 'api', '$', 'location', 'WebSocket', 'render', 'acaAttachFromOverview', 'syncAcaPending',
        `${source}\nreturn { connect, refresh };`)(
        clientState, () => reply.promise, () => conn, { protocol: 'http:', host: 'localhost' },
        FakeWebSocket, () => {}, () => {}, async () => {},
      );
      client.connect();
      const refresh = client.refresh();
      const pushed = { type: 'overview', devices: [{ deviceId: `aca-${EXEC}` }], groups: [{ sessions: [{ id: 'pushed-session' }] }], counts: { sessions: 1 } };
      clientState.ws.onmessage({ data: JSON.stringify(pushed) });
      reply.resolve({ devices: [], groups: [], counts: { sessions: 0 } });
      await refresh;
      assert.strictEqual(clientState.overview.groups[0]?.sessions[0]?.id, 'pushed-session',
        'the older GET erased the newer pushed session');
      assert.strictEqual(clientState.overview.counts.sessions, 1);
    });

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

    // --- the authoritative attach join, end to end through syncAcaPending ---
    // (#178's original acceptance: a pending row is replaced when ITS `aca-`
    // device attaches). Identity comes only from the hub's own receipt:
    // trackerId -> executionName -> device id `aca-<executionName>`.
    {
      const calls = [];
      const serve = (dispatches) => {
        global.fetch = async (url, opts) => {
          calls.push({ url, method: (opts && opts.method) || 'GET' });
          return { ok: true, status: 200, json: async () => ({ dispatches: typeof dispatches === 'function' ? dispatches() : dispatches }) };
        };
      };
      const reset = () => { calls.length = 0; state.acaPending = []; state.overview = { devices: [], groups: [] }; };

      await checkAsync('the pending row polls, confirms the execution from the hub receipt, and is replaced the moment its own device attaches', async () => {
        reset();
        const entry = trackedEntry();
        state.acaPending = [entry];

        serve([dispatchRow('T1', runStatus('queued'), null)]);
        await syncAcaPending();
        assert.strictEqual(entry.executionName, null);
        assert.strictEqual(entry.attached, false);

        serve([dispatchRow('T1', runStatus('in_progress', { executionName: EXEC }), EXEC)]);
        await syncAcaPending();
        assert.strictEqual(entry.executionName, EXEC);
        assert.ok(entry.confirmedAt > 0, 'the bounded wait for the device starts at the confirmation');
        assert.strictEqual(entry.attached, false, 'the receipt alone is not an attach -- the device has not registered');
        assert.ok(acaPendingSectionHtml(state.acaPending, 'all').includes(`data-local-id="${entry.localId}"`));

        calls.length = 0;
        state.overview = { devices: [dev('aca-other-job-zzzz'), dev(`aca-${EXEC}`)], groups: [] };
        await syncAcaPending();
        assert.strictEqual(entry.attached, true, 'the device named by the receipt attached');
        assert.strictEqual(entry.deviceId, `aca-${EXEC}`);
        assert.strictEqual(calls.length, 0, 'attaching is decided locally -- no request is spent on it');
        assert.strictEqual(acaPendingSectionHtml(state.acaPending, 'all'), '', 'the pending row is gone, replaced by the real session');

        state.overview = { devices: [], groups: [] };
        await syncAcaPending();
        assert.strictEqual(entry.attached, true, 'attached is sticky -- a later, older overview cannot bring the pending row back');
        assert.strictEqual(calls.length, 0);
      });

      await checkAsync('the local attach check also runs without any request: acaAttachFromOverview is what the WS push calls', async () => {
        reset();
        const confirmed = trackedEntry({ localId: 'c', trackerId: 'TC', executionName: EXEC });
        const waiting = trackedEntry({ localId: 'w', trackerId: 'TW' });
        state.acaPending = [confirmed, waiting];
        state.overview = { devices: [dev(`aca-${EXEC}`)], groups: [] };
        assert.strictEqual(acaAttachFromOverview(), true);
        assert.strictEqual(confirmed.attached, true);
        assert.strictEqual(waiting.attached, false, 'an entry with no confirmed execution attaches to nothing');
        assert.strictEqual(acaAttachFromOverview(), false, 'nothing further to attach');
        state.overview = undefined;
        assert.strictEqual(acaAttachFromOverview(), false, 'a missing overview is not an error');

        const twinA = trackedEntry({ localId: 'ta', trackerId: 'TTA', executionName: 'twin-job-1' });
        const twinB = trackedEntry({ localId: 'tb', trackerId: 'TTB', executionName: 'twin-job-1' });
        state.acaPending = [twinA, twinB];
        state.overview = { devices: [dev('aca-twin-job-1')], groups: [] };
        assert.strictEqual(acaAttachFromOverview(), false, 'two entries naming one device is a contradiction: the local check hands the matcher every entry');
        assert.strictEqual(twinA.attached || twinB.attached, false);
      });

      await checkAsync('a dispatch tracked from the POST response binds to the hub row by its trackerId, and to no other row', async () => {
        reset();
        trackAcaDispatch({ repo: REPO, issue: 7, runUrl: 'https://github.com/x/y/actions/runs/900', trackerId: 'T-posted' });
        const entry = state.acaPending[0];
        assert.strictEqual(entry.trackerId, 'T-posted');
        assert.strictEqual(entry.attached, false);
        serve([
          dispatchRow('T-other', runStatus('in_progress', { runId: 5, executionName: 'job-other-1' }), 'job-other-1'),
          dispatchRow('T-posted', runStatus('in_progress', { executionName: EXEC }), EXEC),
        ]);
        await syncAcaPending();
        assert.strictEqual(entry.executionName, EXEC);
        assert.strictEqual(entry.runId, 900);
        trackAcaDispatch({ repo: REPO, issue: 8 });
        assert.strictEqual(state.acaPending[1].trackerId, null, 'no trackerId from the hub means nothing to bind on');
      });

      await checkAsync('the bounded-wait clocks start once: the first time a run was seen completed and an execution first confirmed survive later polls', async () => {
        reset();
        const t0 = Date.now() - 120_000;
        const entry = trackedEntry({ runId: 900, runAttempt: 1, executionName: EXEC, confirmedAt: t0, completedAt: t0, status: runStatus('completed') });
        state.acaPending = [entry];
        serve([dispatchRow('T1', runStatus('completed', { executionName: EXEC }), EXEC)]);
        await syncAcaPending();
        assert.strictEqual(calls.length, 1, 'still inside both bounds, so the poll asks');
        assert.strictEqual(entry.completedAt, t0, 'a later poll restarted the completed-wait clock');
        assert.strictEqual(entry.confirmedAt, t0, 'a later poll restarted the confirmed-wait clock');
      });

      await checkAsync('a new run attempt that is already finished starts its own completed-wait clock', async () => {
        reset();
        const t0 = Date.now() - 4 * 60_000;
        const entry = trackedEntry({ runId: 900, runAttempt: 1, completedAt: t0, status: runStatus('completed') });
        state.acaPending = [entry];
        serve([dispatchRow('T1', runStatus('completed', { runAttempt: 2 }), null)]);
        await syncAcaPending();
        assert.strictEqual(entry.runAttempt, 2);
        assert.ok(entry.completedAt > Date.now() - 5000, 'the rerun inherited the previous attempt\'s clock, so its wait is cut short');
      });

      await checkAsync('"Check again" is spent by its one request: an answer with nothing new never leaves the entry polling forever', async () => {
        reset();
        const entry = trackedEntry({ dispatchedAt: Date.now() - (ACA_MAX_PENDING_MS + 1000), status: runStatus('queued'), resolved: true });
        state.acaPending = [entry];
        serve([]);
        await retryAcaPending(entry.localId);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(entry.forceRecheck, undefined, 'the one-shot recheck flag was left set');
        await syncAcaPending();
        assert.strictEqual(entry.resolved, true, 'the expired wait resolves again from local knowledge');
        assert.strictEqual(calls.length, 1, 'no further request once the one asked for was made');
      });

      await checkAsync('two same-repository dispatches plus an unrelated pre-existing aca- device: only the dispatch whose receipt names a device attaches', async () => {
        reset();
        const first = trackedEntry({ localId: 'a', trackerId: 'TA', issue: 7 });
        const second = trackedEntry({ localId: 'b', trackerId: 'TB', issue: 7 });
        state.acaPending = [first, second];
        state.overview = {
          devices: [dev('aca-old-job-1111', { meta: { repo: REPO, issue: 7 } }), dev('aca-job-for-b-2222', { meta: { repo: REPO, issue: 7 } })],
          groups: [],
        };
        serve([
          dispatchRow('TA', runStatus('queued', { runId: 1 }), null),
          dispatchRow('TB', runStatus('in_progress', { runId: 2, executionName: 'job-for-b-2222' }), 'job-for-b-2222'),
        ]);
        await syncAcaPending();
        assert.strictEqual(first.attached, false, 'the first dispatch has no receipt yet, and a same-repo same-issue device is not its proof');
        assert.strictEqual(second.attached, true);
        assert.strictEqual(second.deviceId, 'aca-job-for-b-2222');
        assert.deepStrictEqual(state.acaPending.filter((e) => !e.attached).map((e) => e.localId), ['a']);
      });

      await checkAsync('a device for the same repository and issue but a different execution never attaches, however recently it started', async () => {
        reset();
        const entry = trackedEntry({ trackerId: 'TX' });
        state.acaPending = [entry];
        state.overview = {
          devices: [dev('aca-someone-elses-job', { meta: { repo: REPO, issue: 7, executionName: 'someone-elses-job' }, lastSeen: Date.now() })],
          groups: [{ device: dev('aca-someone-elses-job'), sessions: [{ id: 's', startedAt: Date.now() + 1000 }] }],
        };
        serve([dispatchRow('TX', runStatus('in_progress', { executionName: EXEC }), EXEC)]);
        await syncAcaPending();
        assert.strictEqual(entry.executionName, EXEC);
        assert.strictEqual(entry.attached, false);
      });

      await checkAsync('overlapping syncs coalesce: one request in flight at a time, and one follow-up pass for the callers that arrived meanwhile', async () => {
        reset();
        state.acaPending = [trackedEntry()];
        let release;
        const gate = new Promise((r) => { release = r; });
        let inflight = 0; let peak = 0;
        global.fetch = async () => {
          calls.push({ url: '/api/aca/dispatches', method: 'GET' });
          inflight += 1; peak = Math.max(peak, inflight);
          await gate;
          inflight -= 1;
          return { ok: true, status: 200, json: async () => ({ dispatches: [dispatchRow('T1', runStatus('queued'), null)] }) };
        };
        const a = syncAcaPending(); const b = syncAcaPending(); const c = syncAcaPending();
        assert.strictEqual(a, b, 'a call during a sync joins it');
        release();
        await Promise.all([a, b, c]);
        assert.strictEqual(peak, 1, 'two requests were in flight at once');
        assert.strictEqual(calls.length, 2, 'one pass plus exactly one follow-up, however many callers piled on');
        await syncAcaPending();
        assert.strictEqual(calls.length, 3, 'the gate is released after the sync finishes: a later call syncs again');
      });

      await checkAsync('a stale reply (lower run attempt) arriving after a newer one cannot undo it', async () => {
        reset();
        const entry = trackedEntry();
        state.acaPending = [entry];
        serve([dispatchRow('T1', runStatus('in_progress', { runAttempt: 2, executionName: 'job-new' }), 'job-new')]);
        await syncAcaPending();
        assert.strictEqual(entry.runAttempt, 2);
        serve([dispatchRow('T1', runStatus('queued', { runAttempt: 1 }), null)]);
        await syncAcaPending();
        assert.strictEqual(entry.runAttempt, 2);
        assert.strictEqual(entry.executionName, 'job-new');
        assert.strictEqual(entry.status.state, 'in_progress');
      });

      await checkAsync('a rerun starts over: the old attempt\'s execution never carries over, and only the new one\'s device attaches', async () => {
        reset();
        const entry = trackedEntry();
        state.acaPending = [entry];
        state.overview = { devices: [dev('aca-job-a-1111')], groups: [] };
        serve([dispatchRow('T1', runStatus('in_progress', { executionName: 'job-a-1111' }), 'job-a-1111')]);
        await syncAcaPending();
        assert.strictEqual(entry.attached, true, 'attempt 1\'s own device attached');

        const rerun = trackedEntry({ localId: 'r', trackerId: 'TR', runId: 900, runAttempt: 1, executionName: 'job-a-1111', confirmedAt: Date.now() - 10, status: runStatus('completed') });
        state.acaPending = [rerun];
        state.overview = { devices: [], groups: [] };
        serve([dispatchRow('TR', runStatus('in_progress', { runAttempt: 2 }), null)]);
        await syncAcaPending();
        assert.strictEqual(rerun.executionName, null);
        assert.strictEqual(rerun.confirmedAt, null);
        state.overview = { devices: [dev('aca-job-a-1111')], groups: [] };
        serve([dispatchRow('TR', runStatus('in_progress', { runAttempt: 2, executionName: 'job-b-2222' }), 'job-b-2222')]);
        await syncAcaPending();
        assert.strictEqual(rerun.executionName, 'job-b-2222');
        assert.strictEqual(rerun.attached, false, 'attempt 1\'s device is not the rerun\'s');
        state.overview = { devices: [dev('aca-job-a-1111'), dev('aca-job-b-2222')], groups: [] };
        await syncAcaPending();
        assert.strictEqual(rerun.deviceId, 'aca-job-b-2222');
      });

      await checkAsync('an unsupported workflow resolves terminally, never fetches again, and never attaches to a lookalike device', async () => {
        reset();
        const entry = trackedEntry();
        state.acaPending = [entry];
        state.overview = { devices: [dev('aca-lookalike-job', { meta: { repo: REPO, issue: 7 } })], groups: [] };
        serve([dispatchRow('T1', { state: 'unsupported', reason: 'squad-dispatch.yml does not accept hub_correlation_id' }, null)]);
        await syncAcaPending();
        assert.strictEqual(entry.resolved, true);
        assert.strictEqual(entry.attached, false);
        calls.length = 0;
        await syncAcaPending();
        await syncAcaPending();
        assert.strictEqual(calls.length, 0);
        assert.ok(acaPendingRowHtml(entry).includes('Unknown outcome'));
      });

      await checkAsync('a stuck run is bounded from dispatch, and a confirmed execution from its confirmation -- both resolve before any request', async () => {
        reset();
        const stuck = trackedEntry({ localId: 's', trackerId: 'TS', dispatchedAt: Date.now() - (ACA_MAX_PENDING_MS + 1000), status: runStatus('queued') });
        const silent = trackedEntry({
          localId: 'q', trackerId: 'TQ', executionName: EXEC, confirmedAt: Date.now() - (ACA_COMPLETED_WAIT_MS + 1000), status: runStatus('in_progress'),
        });
        state.acaPending = [stuck, silent];
        serve([]);
        await syncAcaPending();
        assert.strictEqual(calls.length, 0, 'both bounds were already expired locally -- nothing left to ask');
        assert.strictEqual(stuck.resolved, true);
        assert.strictEqual(silent.resolved, true);
        assert.ok(acaPendingRowHtml(silent).includes('Unknown outcome'));
      });

      await checkAsync('a device that finally attaches after the row gave up (Unknown outcome) is still recognized, because the proof is the receipt', async () => {
        reset();
        const late = trackedEntry({
          executionName: EXEC, confirmedAt: Date.now() - (ACA_COMPLETED_WAIT_MS + 1000), status: runStatus('completed'), resolved: true,
        });
        state.acaPending = [late];
        state.overview = { devices: [dev(`aca-${EXEC}`)], groups: [] };
        serve([]);
        await syncAcaPending();
        assert.strictEqual(late.attached, true);
        assert.strictEqual(late.resolved, false);
        assert.strictEqual(calls.length, 0);
      });

      await checkAsync('an entry with no trackerId is never given a status, and other tabs\' dispatches are never adopted', async () => {
        reset();
        const orphan = trackedEntry({ trackerId: null });
        state.acaPending = [orphan];
        serve([dispatchRow('someone-elses-tracker', runStatus('in_progress', { executionName: EXEC }), EXEC)]);
        state.overview = { devices: [dev(`aca-${EXEC}`)], groups: [] };
        await syncAcaPending();
        assert.strictEqual(orphan.status, null);
        assert.strictEqual(orphan.executionName, null);
        assert.strictEqual(orphan.attached, false);
        assert.strictEqual(state.acaPending.length, 1, 'a dispatch made elsewhere never becomes a row here');
      });

      await checkAsync('a failed lookup leaves a confirmed execution alone: the poll error never flips it to a failure', async () => {
        reset();
        const entry = trackedEntry({ runId: 900, runAttempt: 1, executionName: EXEC, confirmedAt: Date.now(), status: runStatus('in_progress') });
        state.acaPending = [entry];
        serve([dispatchRow('T1', { state: 'error', reason: 'GitHub is having a moment' }, null)]);
        await syncAcaPending();
        assert.strictEqual(entry.executionName, EXEC);
        assert.strictEqual(entry.status.state, 'in_progress');
        assert.strictEqual(entry.resolved, false);
      });

      reset();
    }

    state.acaPending = [];
    state.overview = { groups: [] };

    global.fetch = realFetch;

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
