#!/usr/bin/env node
'use strict';
/**
 * `.github/workflows/squad-dispatch.yml` -- issue #242's durable record,
 * checked as TEXT, the same technique `test/retro-action-workflow-unit.js`
 * and `test/deploy-guard-unit.js` already use for a workflow/script that
 * cannot run inside this suite (it needs a real GitHub Actions event, Azure
 * OIDC, and a live ACA control plane).
 *
 * What actually gets checked, and why each one is a real incident risk, not
 * a hypothetical:
 *
 *   - `workflow_dispatch` is the ONLY trigger -- #242's prior attempt (and
 *     squad-on-aca's own copy, which this is explicitly narrower than) shows
 *     what an `issues`/`issue_comment` auto-trigger looks like; it must not
 *     be present here, or this repository gets a SECOND coordinator writer.
 *   - every input the hub's own `src/aca-dispatch.js` can send is declared,
 *     by name, so a hub-originated dispatch never hits a `422` for an input
 *     this workflow forgot to add.
 *   - the dispatch core is checked out from `swigerb/squad-on-aca` at an
 *     IMMUTABLE 40-character commit SHA, not a branch or tag, and the
 *     checked-out commit is verified to BE that SHA before anything else
 *     runs -- a floating `@main` would let an unreviewed upstream change
 *     execute here with no review in this repository.
 *   - this repository's own checkout and the pinned core checkout land at
 *     two distinct paths, and the scripts that need THIS repository's own
 *     registry/branch/lease context (`--repo-dir`, `--repository`) point at
 *     the real checkout, never at `aca-core`.
 *   - the core checkout is read-only (`persist-credentials: false`) and is
 *     never pushed to.
 *   - the lease MUST be claimed before Azure is ever asked to start
 *     anything, and a claimed lease with no resulting execution is a hard
 *     failure (red), not a quiet success.
 *   - the job template's image/cpu/memory are asserted present before an
 *     override is attempted, and the merged environment must carry a
 *     `GITHUB_TOKEN` secret reference or the start is refused.
 *   - the dispatched ref is always the repository's real default branch,
 *     read back from the event, never a caller-supplied override used as the
 *     checkout/dispatch ref (`base_branch` only ever travels as an `OV_`
 *     environment override `ralph_build_session_env` merges in).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'squad-dispatch.yml');
const src = fs.readFileSync(WORKFLOW, 'utf8');

const { requestedInputNames } = require('../src/aca-dispatch');

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

console.log('squad-dispatch.yml: a manual-only target dispatch workflow, pinned to a reviewed core');
console.log('='.repeat(60));

check('workflow_dispatch is declared', () => {
  assert.match(src, /\n {2}workflow_dispatch:\n/);
});

check('issues/issue_comment auto-dispatch triggers are NOT present', () => {
  const onBlock = src.slice(src.indexOf('\non:'), src.indexOf('\npermissions:'));
  assert.ok(!/\n {2}issues:/.test(onBlock), 'an issues: trigger would duplicate this repository\'s own coordinator writers');
  assert.ok(!/\n {2}issue_comment:/.test(onBlock), 'an issue_comment: trigger would duplicate this repository\'s own coordinator writers');
});

check('every input the hub can send is declared by this workflow', () => {
  // The hub only ever sends issue/prompt plus whichever optional fields a
  // caller supplied -- requestedInputNames() enumerates every name it is
  // capable of sending across all optional combinations.
  const allPossible = requestedInputNames({
    model: 'x', baseBranch: 'x', publishPr: true, reviewer: 'x', watchOnly: true,
  });
  const onBlock = src.slice(src.indexOf('workflow_dispatch:\n    inputs:'), src.indexOf('\npermissions:'));
  for (const name of allPossible) {
    assert.match(onBlock, new RegExp(`\\n {6}${name}:\\n`), `input '${name}' is not declared`);
  }
});

check('hub_correlation_id is declared as an internal workflow_dispatch input', () => {
  const onBlock = src.slice(src.indexOf('workflow_dispatch:\n    inputs:'), src.indexOf('\npermissions:'));
  assert.match(onBlock, /\n {6}hub_correlation_id:\n/);
  assert.match(onBlock, /Hub-issued per-attempt correlation token \(internal\)/);
});

check('run-name surfaces the hub correlation id through github.event.inputs.hub_correlation_id', () => {
  assert.match(src, /^run-name: .*\bgithub\.event\.inputs\.hub_correlation_id\b/m);
  assert.match(src, /Squad dispatch \[corr:\{0\}\]/);
});

check('the dispatch core is pinned to a 40-character commit SHA, not a branch or tag', () => {
  const m = src.match(/SQUAD_ACA_CORE_REF:\s*([^\s#]+)/);
  assert.ok(m, 'SQUAD_ACA_CORE_REF is not set');
  assert.match(m[1], /^[0-9a-f]{40}$/, `'${m[1]}' is not a 40-character lowercase commit SHA`);
});

check('the pinned checkout is verified to actually resolve to the pinned SHA before any side effect runs', () => {
  const idx = src.indexOf('Refuse a floating core checkout');
  assert.ok(idx !== -1, 'no step refuses a floating/unpinned checkout');
  const decideIdx = src.indexOf('Decide whether this manual dispatch is well-formed');
  assert.ok(idx < decideIdx, 'the pin check must run before any dispatch decision or side effect');
  const block = src.slice(idx, decideIdx);
  assert.match(block, /git -C aca-core rev-parse HEAD/);
  assert.match(block, /!= "\$\{\{ env\.SQUAD_ACA_CORE_REF \}\}"/);
  assert.match(block, /exit 1/);
});

check('this repository and the pinned core are checked out to two distinct paths', () => {
  assert.match(src, /uses: actions\/checkout@v4\s*\n\s*with:\s*\n\s*path: target/);
  assert.match(src, /repository: \$\{\{ env\.SQUAD_ACA_CORE_REPOSITORY \}\}\s*\n\s*ref: \$\{\{ env\.SQUAD_ACA_CORE_REF \}\}\s*\n\s*path: aca-core/);
});

check('the pinned core checkout is read-only (no credentials persisted)', () => {
  const idx = src.indexOf('path: aca-core');
  const block = src.slice(idx, idx + 200);
  assert.match(block, /persist-credentials: false/);
});

check('lease/registry/decision steps read THIS repository\'s own checkout, never aca-core, for --repo-dir', () => {
  const repoDirUses = [...src.matchAll(/--repo-dir['"]?,?\s*['"]?target/g), ...src.matchAll(/--repo-dir "?target"?/g), ...src.matchAll(/'--repo-dir', 'target'/g)];
  assert.ok(repoDirUses.length >= 2, `expected at least two --repo-dir target usages (validate-manual-inputs and decide), found ${repoDirUses.length}`);
  assert.ok(!/--repo-dir[^\n]*aca-core/.test(src), '--repo-dir must never point at the pinned core checkout');
});

check('dispatch runs with --repository "${GITHUB_REPOSITORY}", the repo this workflow lives in, never the core repo', () => {
  assert.match(src, /--repository "\$\{GITHUB_REPOSITORY\}"/);
  assert.ok(!src.includes('--repository "${{ env.SQUAD_ACA_CORE_REPOSITORY }}"'), 'the lease/decision core must never be told to operate against squad-on-aca itself');
});

check('the shared lease is claimed before Azure is ever asked to start a job', () => {
  const claimIdx = src.indexOf('Claim the shared lease');
  const startIdx = src.indexOf('Start the ACA session job');
  assert.ok(claimIdx !== -1 && startIdx !== -1 && claimIdx < startIdx);
});

check('the claim outcome is mapped through the tested vocabulary module, never a raw jq boolean', () => {
  assert.match(src, /outcome="\$\(printf '%s' "\$claim" \| jq -r '\.outcome \/\/ ""'\)"/);
  assert.match(src, /actions-event\.js --claim-outcome "\$outcome"/);
});

check('the job template is checked for image/cpu/memory before an override is attempted', () => {
  const idx = src.indexOf('Start the ACA session job');
  const block = src.slice(idx, src.indexOf('Mark the issue as dispatched'));
  assert.match(block, /properties\.template\.containers\[0\]\.image and/);
  assert.match(block, /resources\.cpu != null/);
  assert.match(block, /resources\.memory/);
});

check('a merged environment with no GITHUB_TOKEN secret reference refuses to start', () => {
  const idx = src.indexOf('Start the ACA session job');
  const block = src.slice(idx, src.indexOf('Mark the issue as dispatched'));
  assert.match(block, /grep -q '\^GITHUB_TOKEN=secretref:'/);
});

check('input validation carries a GH_TOKEN so its gh api base-branch check is authenticated', () => {
  // validate-manual-inputs calls `gh api .../git/ref/...` to confirm a
  // supplied base_branch actually exists. The checkout step's git
  // credentials authenticate git, not the `gh` CLI -- without GH_TOKEN
  // here that lookup is unauthenticated and a valid base_branch fails at
  // runtime instead of being accepted.
  const idx = src.indexOf('Validate workflow_dispatch inputs');
  assert.ok(idx !== -1, 'no "Validate workflow_dispatch inputs" step found');
  const block = src.slice(idx, src.indexOf('Azure login via OIDC'));
  assert.match(block, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});

check('hub_correlation_id validation rejects a malformed token before Azure is touched', () => {
  const idx = src.indexOf('Validate hub_correlation_id format');
  assert.ok(idx !== -1, 'no "Validate hub_correlation_id format" step found');
  const block = src.slice(idx, src.indexOf('Azure login via OIDC'));
  assert.match(block, /INPUT_HUB_CORRELATION_ID: \$\{\{ github\.event\.inputs\.hub_correlation_id \|\| '' \}\}/);
  assert.match(block, /grep -Eq '\^\[A-Za-z0-9\]\{8,64\}\$'/);
  assert.match(block, /::error::hub_correlation_id must match \^\[A-Za-z0-9\]\{8,64\}\$ when provided\./);
  assert.match(block, /exit 1/);
});

check('a claimed lease with no resulting execution is a hard failure, not a quiet success', () => {
  const idx = src.indexOf('A claimed lease MUST have produced an execution');
  assert.ok(idx !== -1);
  const block = src.slice(idx);
  assert.match(block, /if: steps\.lease\.outputs\.action == 'start'/);
  assert.match(block, /\[ -z "\$\{EXEC\}" \]/);
  assert.match(block, /exit 1/);
});

check('a confirmed-execution receipt artifact is published, gated on a confirmed start, with a validated name', () => {
  const gate = "if: steps.lease.outputs.action == 'start' && steps.start.outputs.exec != ''";
  const stepBlock = (title) => {
    const idx = src.indexOf(`- name: ${title}`);
    assert.ok(idx !== -1, `missing step: ${title}`);
    const next = src.indexOf('\n      - name:', idx + 1);
    return src.slice(idx, next === -1 ? undefined : next);
  };
  const validate = stepBlock('Validate ACA execution name format');
  assert.ok(validate.includes(gate));
  assert.match(validate, /grep -Eq '\^\[A-Za-z0-9\]\(\[A-Za-z0-9-\]\{0,126\}\[A-Za-z0-9\]\)\?\$'/);
  assert.match(validate, /::error::/);
  assert.match(validate, /exit 1/);
  const publish = stepBlock('Publish confirmed ACA execution receipt');
  assert.ok(publish.includes(gate));
  assert.match(publish, /uses: actions\/upload-artifact@v4/);
  assert.ok(publish.includes('name: aca-exec-attempt${{ github.run_attempt }}-${{ steps.start.outputs.exec }}'));
  assert.match(publish, /retention-days: 1\b/);
  assert.match(publish, /if-no-files-found: error/);
  assert.ok(src.indexOf('Start the ACA session job') < src.indexOf('Validate ACA execution name format'));
  assert.ok(src.indexOf('Validate ACA execution name format') < src.indexOf('Publish confirmed ACA execution receipt'));
  assert.ok(src.indexOf('Publish confirmed ACA execution receipt') < src.indexOf('A claimed lease MUST have produced an execution'));
});

check('the receipt step adds no permission scope: the job keeps exactly id-token, contents and issues', () => {
  const jobIdx = src.indexOf('jobs:');
  const permsBlock = src.slice(jobIdx, src.indexOf('steps:', jobIdx));
  const scopes = [...permsBlock.matchAll(/^\s{6}([a-z-]+): (read|write)/gm)].map((m) => m[1]).sort();
  assert.deepStrictEqual(scopes, ['contents', 'id-token', 'issues']);
  assert.match(src, /\npermissions: \{\}/);
});

check('the dispatched ref is always the repository default branch read from the event, never a raw caller override', () => {
  assert.match(src, /DEFAULT_BASE_REF: \$\{\{ github\.event\.repository\.default_branch \|\| 'main' \}\}/);
  // base_branch only ever becomes an OV_ override merged by ralph_build_session_env,
  // which is a declared, validated input -- it must never select the actions/checkout ref.
  assert.ok(!/uses: actions\/checkout@v4\s*\n\s*with:\s*\n\s*ref: \$\{\{.*base_branch/.test(src),
    'base_branch must never be used to select the checked-out ref');
});

check('permissions are minimal at the workflow level and scoped at the job level', () => {
  assert.match(src, /\npermissions: \{\}/);
  const jobIdx = src.indexOf('jobs:');
  const permsBlock = src.slice(jobIdx, src.indexOf('steps:'));
  assert.match(permsBlock, /id-token: write/);
  assert.match(permsBlock, /contents: write/);
  assert.match(permsBlock, /issues: write/);
  assert.ok(!/actions: write/.test(permsBlock), 'this job never needs Actions permission on itself');
});

check('every prompt value is carried through a randomized delimiter heredoc, never a plain key=value line', () => {
  const matches = [...src.matchAll(/SQUAD_EOF_\$\(openssl rand -hex 16\)/g)];
  assert.ok(matches.length >= 2, 'expected the delimiter pattern in both the decide and prompt-preparation steps');
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
