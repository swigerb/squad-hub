'use strict';
/**
 * The parity checklist, checked against the code.
 *
 * Every row here is an item from the hub-parity sprints. The point is not to
 * re-test behaviour -- the suites do that -- but to catch a capability being
 * REMOVED or renamed while its tests are deleted alongside it, which is the
 * one way a green suite can coexist with a lost feature.
 *
 * Two questions per row, and the second matters as much as the first:
 *
 *   is it built?   the mechanism is present in the source
 *   is it tested?  a test exists whose NAME describes it
 *
 * "Built but untested" is reported as a failure, not a pass. A capability
 * nobody tests is one that can break without anyone finding out, which is the
 * state this whole codebase has spent its effort escaping.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; } };

const app = read('web/app.js');
const html = read('web/index.html');
const css = read('web/app.css');
const cli = read('src/cli.js');
const daemon = read('src/daemon.js');
const acp = read('src/acp-session.js');
const svc = read('src/service/hub-service.js');
const sw = read('web/sw.js');
const docs = read('docs/commands.md');

const testNames = new Set();
for (const f of fs.readdirSync(path.join(ROOT, 'test')).filter((x) => x.endsWith('.js'))) {
  const body = read(`test/${f}`);
  for (const m of body.matchAll(/check(?:Async)?\(\s*(['"`])([\s\S]*?)\1\s*,/g)) testNames.add(m[2]);
}
const tested = (frag) => [...testNames].some((n) => n.toLowerCase().includes(frag.toLowerCase()));

const CHECKS = [
  ['S1', 'config edit', () => /sub === 'edit'/.test(cli), 'config edit'],
  ['S1', 'autostart enable|disable|status', () => /cmdAutostart/.test(cli) && /'autostart'/.test(cli), 'autostart'],
  ['S1', 'old service verbs still work', () => /case 'install-service'/.test(cli), 'install-service'],
  ['S1', '--env prod|ppe', () => /ENVIRONMENTS/.test(cli), '--env is accepted BEFORE'],
  ['S1', '--no-config-cache', () => /no-config-cache/.test(cli), 'no-config-cache'],
  ['S1', 'docs updated', () => /--no-config-cache/.test(docs), null],

  ['S2', 'repository and branch', () => /git-context/.test(acp) && /git\.repository/.test(app), 'repository and branch appear'],
  ['S2', 'live activity line', () => /function activityLine/.test(app), 'Waiting for input'],
  ['S2', 'status badges', () => /Ready for review/.test(app) && /Action needed/.test(app), 'Ready for review'],
  ['S2', 'action-needed to top + coloured edge', () => /sessionSort/.test(app) && /row\.attention/.test(css), 'pulled to the top'],

  ['S3', 'time-window filter', () => /TIME_WINDOWS/.test(app), 'time window'],
  ['S3', 'grouping control', () => /GROUPINGS/.test(app), 'grouping by repository'],
  ['S3', 'sort control', () => /SORTS/.test(app), 'Started'],
  ['S3', 'repository + org scope', () => /sessionOrg/.test(app), 'organisation scope'],
  ['S3', 'favorites + Pinned section', () => /favorites/.test(app) && /Pinned/.test(app), 'pinned session is lifted'],

  ['S4', 'cloud listed first', () => /kind === 'cloud'/.test(app), 'cloud device is listed first'],
  ['S4', 'platform names', () => /PLATFORM_LABEL/.test(app), 'platform'],
  ['S4', 'presence + last seen', () => /presenceLabel/.test(app), 'last seen'],
  ['S4', 'CPU/RAM meters', () => /function meter/.test(app) && /telemetry/.test(read('src/telemetry.js')), 'meters'],
  ['S4', 'per-device +', () => /data-spawn/.test(app), 'start a session on it'],
  ['S4', 'collapsible rail + counted pill', () => /railToggle/.test(html) && /deviceAvailable/.test(html), 'available count'],

  ['S5', 'verify before enabling composer', () => /controlsEnabled/.test(app) && /control-check/.test(daemon), 'controls are DISABLED before'],
  ['S5', 'Not synced + Sync session', () => /NOT_SYNCED/.test(app) && /dtSync/.test(html), 'Not synced'],
  ['S5', 'Sync resumes under same session id', () => /resyncSession/.test(daemon), 'UNDER THE SAME session id'],
  ['S5', "Control couldn't be verified, draft kept", () => /couldn't be verified/.test(app), 'draft survives a verification'],
  ['S5', 'approval expiry resolves as Expired', () => /expiredApprovals/.test(acp) && /Expired/.test(app), 'expired approval is shown'],

  ['S6', 'mode/model in composer', () => /nsAgent/.test(html) && /nsModel/.test(html), 'named agent and model are sent'],
  ['S6', 'read-only badges on tools', () => /approvalRows/.test(app) && /ap-badge/.test(css), 'read-only'],
  ['S6', 'Always-Allow with a stated rule', () => /alwaysAllowRule/.test(app), 'standing rule says exactly'],

  ['S7', 'palette + spacing tokens', () => /--sp-3/.test(css), 'tokens that are actually applied'],
  ['S7', 'top bar: theme, bell, avatar', () => /themeBtn/.test(html) && /bellBtn/.test(html), 'theme toggle, the bell'],
  ['S7', 'inline filter labels', () => /inline-select/.test(html), 'inline label'],
  ['S7', 'secondary toolbar row', () => /class="toolbar"/.test(html), 'separate rows'],
  ['S7', 'two-button empty state', () => /emptyCloud/.test(app) && /emptyLocal/.test(app), 'cloud AND a local'],
  ['S7', 'theme honours prefers-color-scheme', () => /prefers-color-scheme/.test(css), 'prefers-color-scheme'],

  ['S8', 'service worker / offline', () => sw.length > 0 && /registerServiceWorker/.test(app), 'shell survives the hub'],
];

let built = 0; let missing = 0; let untested = 0;
let sprint = '';
for (const [s, item, present, testFrag] of CHECKS) {
  if (s !== sprint) { console.log(''); sprint = s; }
  const ok = present();
  const hasTest = testFrag ? tested(testFrag) : true;
  const name = `${s}: ${item}`;
  if (!ok) {
    missing += 1;
    console.log(`  FAIL ${name}\n         the mechanism is not in the source any more`);
    console.log(`RESULT\tfail\t${name}\tthe mechanism is not in the source any more`);
  } else if (!hasTest) {
    untested += 1;
    console.log(`  FAIL ${name}\n         built, but no test names it`);
    console.log(`RESULT\tfail\t${name}\tbuilt, but no test names it`);
  } else {
    built += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  }
}

// A scan that silently matched nothing would report a clean parity sweep.
if (CHECKS.length < 30) {
  console.log('  FAIL the parity checklist is suspiciously short');
  console.log('RESULT\tfail\tthe parity checklist covers every sprint\ttoo few rows');
  missing += 1;
} else {
  console.log('  ok   the parity checklist covers every sprint');
  console.log('RESULT\tok\tthe parity checklist covers every sprint');
}


// ---------------------------------------------------------------------------
// The PRD's own acceptance criteria and stated mutations.
//
// A separate list from the parity checklist above, because they answer
// different questions: parity asks "does it match the reference hub", the PRD
// asks "does it do what this product was specified to do". Both can regress
// independently, and each is checked by NAME so a renamed-away test is caught.
// ---------------------------------------------------------------------------
const namedTests = [];
for (const f of fs.readdirSync(path.join(ROOT, 'test')).filter((x) => x.endsWith('.js'))) {
  const body = read(`test/${f}`);
  for (const m of body.matchAll(/check(?:Async)?\(\s*(['"`])([\s\S]*?)\1\s*,/g)) namedTests.push([m[2], f]);
}
const mutants = require('./mutate').MUTATIONS.map((m) => m.name);

function findTest(...frags) {
  for (const [n, f] of namedTests) {
    const low = n.toLowerCase();
    if (frags.every((fr) => low.includes(fr.toLowerCase()))) return `${f}: ${n}`;
  }
  return null;
}
function findMutant(...frags) {
  for (const n of mutants) {
    const low = n.toLowerCase();
    if (frags.every((fr) => low.includes(fr.toLowerCase()))) return n;
  }
  return null;
}
const PRD = [
  ['S0.1', 'a real permission request is observed on the wire', () => findTest('approval') || findTest('permission')],
  ['S0.2', 'allow -> the tool runs', () => findTest('ACTUALLY runs the tool') || findTest('the tool ran')],
  ['S0.3', 'deny -> the tool does not run', () => findTest('denied', 'not') || findTest('deny')],
  ['S0.4', 'no answer -> resolves as expired, never a hang', () => findTest('expired')],
  ['S0.m1', 'mutant: allow returned for a denial', () => findMutant('deny') || findMutant('denied')],
  ['S0.m2', 'mutant: never answer', () => findMutant('unanswered approval waits forever')],
  ['S0.m3', 'an answer for the WRONG request id is rejected', () => findTest('WRONG request id is rejected')],

  ['S1.1', 'a started session appears with a live status', () => findTest('session') && findTest('status')],
  ['S1.2', 'killing the daemon does not orphan the agent', () => findTest('orphan')],
  ['S1.3', 'a killed agent is marked failed within a heartbeat', () => findTest('marks the session failed') || findTest('dead agent')],
  ['S1.4', 'two concurrent sessions do not interleave', () => findTest('side by side') || findTest('interleave')],
  ['S1.m1', 'mutant: status from last known value', () => findMutant('heartbeat does not notice a dead agent')],
  ['S1.m3', 'mutant: heartbeat unconditionally', () => findMutant('heartbeat')],

  ['S2.1', 'the daemon connects outbound only', () => findTest('listens on no TCP port')],
  ['S2.2', 'presence goes stale then offline on missed beats', () => findTest('stale')],
  ['S2.3', 'two users cannot see each other', () => findTest('own device') || findTest('other user')],
  ['S2.4', "a token scoped to A is rejected on B's channel", () => findTest('another user') || findTest('cross-user')],
  ['S2.5', 'an expired token is refused', () => findTest('expired token') || findTest('expires')],
  ['S2.m1', 'mutant: filter in the UI instead of the query', () => findMutant('store filters by user at read time')],
  ['S2.m2', 'mutant: trust the claim without validating', () => findMutant('signature') || findMutant('claim')],

  ['S3.1', 'the card shows command, tools and paths', () => findTest('paths') && findTest('command')],
  ['S3.2', 'allow proceeds, deny does not', () => findTest('approving in the browser')],
  ['S3.3', 'always-allow is scoped, never global by accident', () => findTest('session A') || findTest('pre-approve')],
  ['S3.4', 'a resolved approval shows WHO answered, everywhere', () => findTest('who answered')],
  ['S3.5', 'unanswered requests expire, session stays clean', () => findTest('expired approval') || findTest('expires')],
  ['S3.6', 'the card never renders repo text as markup', () => findTest('script tag') || findTest('inert escaped')],
  ['S3.m3', 'answering one of TWO simultaneous prompts resolves the right one', () => findTest('simultaneous')],

  ['S4.1', 'transcript survives a reconnect without loss or duplication', () => findTest('transcript') && findTest('reconnect')],
  ['S4.2', 'spawn starts a session on the chosen device', () => findTest('really runs on the device') || findTest('spawn')],
  ['S4.3', 'steering reaches the running agent', () => findTest('steer')],
  ['S4.4', 'stop is confirmed by process death, not by success', () => findTest('no surviving process') || findTest('agent dies')],
  ['S4.5', 'file access is off by default', () => findTest('file access is OFF by default')],
  ['S4.m1', 'mutant: report stop success on dispatch', () => findMutant('remote stop reports success')],
  ['S4.m3', 'mutant: default file access on', () => findMutant('file access')],

  ['S5.1', 'a cloud session appears with its execution identity', () => findTest('oneshot') || findTest('cloud')],
  ['S5.3', 'an unreachable hub does not fail the session', () => findTest('hub is an observer') || findTest('unreachable')],
  ['S5.4', 'no credential reaches the hub', () => findTest('redact')],

  ['S6.1', 'a Squad team shows the active agent and roster', () => findTest('members') || findTest('roster')],
  ['S6.2', 'decisions appear, attributed', () => findTest('decision')],
  ['S6.3', 'a repo with no .squad renders cleanly', () => findTest('without') && findTest('squad')],
  ['S6.4', 'malformed .squad degrades, never breaks the view', () => findTest('malformed')],

  ['S7.1', 'a pending approval produces a Teams card with the same context', () => findTest('card carries')],
  ['S7.4', 'the card carries no repo text as markup', () => findTest('redacted') || findTest('escaped')],
];


for (const [id, what, prove] of PRD) {
  const name = `PRD ${id}: ${what}`;
  if (prove()) {
    built += 1;
    console.log(`  ok   ${name}`);
    console.log(`RESULT\tok\t${name}`);
  } else {
    missing += 1;
    console.log(`  FAIL ${name}\n         nothing in the suite proves this any more`);
    console.log(`RESULT\tfail\t${name}\tnothing in the suite proves this any more`);
  }
}

if (PRD.length < 40) {
  console.log('  FAIL the PRD checklist is suspiciously short');
  console.log('RESULT\tfail\tthe PRD checklist covers every sprint\ttoo few rows');
  missing += 1;
} else {
  console.log('  ok   the PRD checklist covers every sprint');
  console.log('RESULT\tok\tthe PRD checklist covers every sprint');
}
console.log(`\n${built} passed, ${missing + untested} failed`);
process.exit(missing || untested ? 1 : 0);
