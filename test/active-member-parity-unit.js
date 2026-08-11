'use strict';
/**
 * Issue #92, Sprint 4 -- "put it where it is read".
 *
 * `inferActiveMember` produces one payload. This file proves that payload
 * reaches every surface that shows it -- the CLI's `squad-hub status`, the
 * Teams approval card, and the web session row -- and that all three AGREE
 * for the same session, because they are reading the very same field rather
 * than three independent re-derivations that can drift apart.
 *
 * It also proves the negative cases Sprint 3/4 call out by name:
 *   - a non-Squad workspace shows no member and no empty slot where one
 *     would go
 *   - the coordinator acting shows nothing (the pill already says "squad")
 *   - "unknown" invents no name
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

const { squadLine } = require('../src/cli');
const { approvalCard } = require('../src/notify/teams');

// ---------------------------------------------------------------------------
// The web row: extracted the same way test/web-xss-unit.js does -- app.js has
// zero runtime dependencies and is meant to run with no build step, so its
// pure, DOM-free prefix is sliced out and evaluated directly rather than
// pulled in through jsdom.
// ---------------------------------------------------------------------------
const APP_JS = path.join(__dirname, '..', 'web', 'app.js');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const MARKER = '(async function main()';
const idx = appSrc.indexOf(MARKER);
if (idx < 0) {
  console.log(`  FAIL could not find the "${MARKER}" extraction anchor in web/app.js -- it moved`);
  console.log('RESULT\tfail\tweb/app.js extraction anchor is present\tanchor not found');
  console.log(`\n0 passed, 1 failed`);
  process.exit(1);
}
const sandboxModule = { exports: {} };
const load = new Function('module', 'exports', `${appSrc.slice(0, idx)}\nmodule.exports = { sessionRow };`);
load(sandboxModule, sandboxModule.exports);
const { sessionRow } = sandboxModule.exports;

function makeSession(sq) {
  return {
    id: 's001', key: 's001', prompt: 'do the thing', cwd: '/repo', agent: 'Copilot CLI', squad: sq,
  };
}

const approval = {
  approvalId: 'a1', title: 'Create marker file', kind: 'execute', command: 'npm test', paths: [],
  options: [{ optionId: 'allow_once' }],
};
const device = { name: 'DEV1', deviceId: 'd1' };

// ---------------------------------------------------------------------------
// A named member acting -- all three surfaces show it.
// ---------------------------------------------------------------------------
const namedSq = {
  project: 'squad-hub', memberCount: 8, activeMembers: 8,
  activeMember: { name: 'engineer', role: 'engineer', coordinator: false, inferred: false },
};

check('the CLI status line names the acting member', () => {
  assert.match(squadLine(namedSq), /engineer/, squadLine(namedSq));
});

check('the Teams card names the acting member', () => {
  const card = approvalCard({ session: makeSession(namedSq), device, approval, hubUrl: 'https://hub.example.com' });
  assert.ok(JSON.stringify(card).includes('engineer'), 'the Teams card omitted the acting member');
});

check('the web row names the acting member', () => {
  const row = sessionRow(makeSession(namedSq), 'DEV1');
  assert.ok(row.includes('engineer'), 'the web row omitted the acting member');
});

check('the CLI, Teams and web row agree for the same session', () => {
  const cliHas = squadLine(namedSq).includes('engineer');
  const teamsHas = JSON.stringify(approvalCard({ session: makeSession(namedSq), device, approval, hubUrl: 'https://hub.example.com' })).includes('engineer');
  const rowHas = sessionRow(makeSession(namedSq), 'DEV1').includes('engineer');
  assert.strictEqual(cliHas, true);
  assert.strictEqual(teamsHas, true);
  assert.strictEqual(rowHas, true);
});

// ---------------------------------------------------------------------------
// The coordinator acting -- all three surfaces show NOTHING (the pill/label
// already says "squad"; repeating the coordinator's own name says it twice).
// ---------------------------------------------------------------------------
const coordinatorSq = {
  project: 'squad-hub', memberCount: 8, activeMembers: 8,
  activeMember: { name: null, role: null, coordinator: true, inferred: false },
};

check('the CLI status line is silent when the coordinator is acting', () => {
  // "squad:" is the line's own label and is expected; what must NOT appear is
  // a name after it -- the coordinator's own name repeated next to a line
  // that already says "squad".
  assert.ok(!squadLine(coordinatorSq).includes('\u00b7'), squadLine(coordinatorSq));
});

check('the Teams card is silent when the coordinator is acting', () => {
  const card = approvalCard({ session: makeSession(coordinatorSq), device, approval, hubUrl: 'https://hub.example.com' });
  const facts = JSON.stringify(card.body.find((b) => b.type === 'FactSet'));
  assert.ok(!/·\s*Squad/i.test(facts), `the coordinator's own name leaked into the card: ${facts}`);
});

check('the web row shows no member chip when the coordinator is acting', () => {
  const row = sessionRow(makeSession(coordinatorSq), 'DEV1');
  assert.ok(!row.includes('sq-role'), 'a member chip was rendered for the coordinator');
});

// ---------------------------------------------------------------------------
// Unknown -- no idea who is acting. Still silent, and still no invented name.
// ---------------------------------------------------------------------------
const unknownSq = {
  project: 'squad-hub', memberCount: 8, activeMembers: 8,
  activeMember: { name: null, role: null, coordinator: false, inferred: false },
};

check('nothing is invented for "unknown" on the CLI, Teams card, or web row', () => {
  assert.doesNotMatch(squadLine(unknownSq), /null|undefined/, squadLine(unknownSq));
  const card = approvalCard({ session: makeSession(unknownSq), device, approval, hubUrl: 'https://hub.example.com' });
  assert.ok(!JSON.stringify(card).includes('null'), 'the Teams card rendered the literal word "null"');
  const row = sessionRow(makeSession(unknownSq), 'DEV1');
  assert.ok(!row.includes('sq-role'), 'a member chip was rendered for "unknown"');
});

// ---------------------------------------------------------------------------
// A non-Squad workspace -- no member, and no empty slot where one would go.
// ---------------------------------------------------------------------------
check('a session in a non-Squad workspace shows no member and no empty slot on the web row', () => {
  const row = sessionRow(makeSession(undefined), 'DEV1');
  assert.ok(!row.includes('squadline'), 'a Squad slot was rendered for a non-Squad session');
  assert.ok(!row.includes('sq-pill'), 'a Squad pill was rendered for a non-Squad session');
});

check('the CLI prints no Squad line at all for a non-Squad session', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  assert.match(cli, /if \(s\.squad\) out\(`\s*\$\{squadLine\(s\.squad\)\}`\);/,
    'the CLI status output no longer guards the Squad line on s.squad being present');
});

check('a non-Squad session produces no "Squad" fact on the Teams card', () => {
  const card = approvalCard({ session: makeSession(undefined), device, approval, hubUrl: 'https://hub.example.com' });
  const hasSquadFact = (card.body.find((b) => b.type === 'FactSet') || { facts: [] }).facts
    .some((f) => f.title === 'Squad');
  assert.strictEqual(hasSquadFact, false, 'a Squad fact appeared for a non-Squad session');
});

// ---------------------------------------------------------------------------
// Single source: the row and the session-detail panel both read
// `session.squad.activeMember` -- the very same field -- so they cannot
// disagree the way two independent re-derivations could.
// ---------------------------------------------------------------------------
check('the session detail panel reads activeMember from the same field the row does', () => {
  assert.match(appSrc, /sq\.activeMember\s*&&\s*sq\.activeMember\.name\s*===\s*m\.name/,
    'renderSquadPanel no longer reads sq.activeMember -- it and the row could now disagree');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
