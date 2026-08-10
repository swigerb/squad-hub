'use strict';
/**
 * The access list at a size somebody actually has.
 *
 * A dialog that reads well with three people can be unusable with fifty: no way
 * to find anyone, no idea how many there are, and a filter box that scrolls
 * away exactly when it is needed. These assertions are about the list holding
 * up, and about the filter never being able to mislead — on an access screen,
 * a row silently hidden is a person you think you removed.
 *
 * `web/app.js` has no build step, so its DOM-free prefix is evaluated directly,
 * as web-xss-unit.js does.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const idx = src.indexOf('(async function main()');
const mod = { exports: {} };
new Function('module', `${src.slice(0, idx)}\nmodule.exports = { peopleVisible, peopleRows, peopleSummary };`)(mod);
const { peopleVisible, peopleRows, peopleSummary } = mod.exports;

/** A hub with an owner, a couple of deployment entries, and 60 added people. */
function bigList() {
  const users = [
    { login: 'swigerb', source: 'owner', removable: false },
    { login: 'llowevad', source: 'deployment', removable: false },
    { login: 'ops-account', source: 'deployment', removable: false },
  ];
  for (let i = 0; i < 60; i += 1) {
    users.push({
      login: `person${String(i).padStart(2, '0')}@example.com`,
      source: 'added',
      removable: true,
      addedBy: 'swigerb',
      note: i % 3 === 0 ? 'platform team' : 'trial',
    });
  }
  return { users, durable: true, ok: true };
}

// --- finding somebody --------------------------------------------------------

check('the filter finds a person by login', () => {
  const found = peopleVisible(bigList().users, 'person07', '');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].login, 'person07@example.com');
});

check('the filter finds people by note, and by who added them', () => {
  const all = bigList().users;
  assert.strictEqual(peopleVisible(all, 'platform team', '').length, 20);
  assert.strictEqual(peopleVisible(all, 'swigerb', '').length, 61, 'added-by is not searchable');
});

check('the filter ignores case and surrounding spaces', () => {
  assert.strictEqual(peopleVisible(bigList().users, '  PERSON07  ', '').length, 1);
});

check('an empty filter hides nobody', () => {
  const all = bigList().users;
  assert.strictEqual(peopleVisible(all, '', '').length, all.length);
  assert.strictEqual(peopleVisible(all, '   ', '').length, all.length);
});

check('the source picker narrows to one kind, and never invents rows', () => {
  const all = bigList().users;
  assert.strictEqual(peopleVisible(all, '', 'owner').length, 1);
  assert.strictEqual(peopleVisible(all, '', 'deployment').length, 2);
  assert.strictEqual(peopleVisible(all, '', 'added').length, 60);
  const sum = ['owner', 'deployment', 'added']
    .reduce((n, s) => n + peopleVisible(all, '', s).length, 0);
  assert.strictEqual(sum, all.length, 'the three sources do not account for everyone');
});

check('filter and source combine rather than fighting', () => {
  const all = bigList().users;
  assert.strictEqual(peopleVisible(all, 'person07', 'added').length, 1);
  assert.strictEqual(peopleVisible(all, 'person07', 'owner').length, 0);
});

// --- the list says how big it is --------------------------------------------

check('the summary counts people and owners separately', () => {
  const data = bigList();
  const s = peopleSummary(data, data.users.length);
  assert.match(s, /62 people with access/);
  assert.match(s, /1 owner/);
});

check('a filtered list SAYS it is filtered, so nobody reads it as the whole list', () => {
  // The dangerous version: a filter left in the box, a short list, and someone
  // concluding a person no longer has access.
  const data = bigList();
  const s = peopleSummary(data, 1);
  assert.match(s, /showing 1/, `a filtered view does not admit it: ${s}`);
});

check('an unfiltered list does not claim to be filtered', () => {
  const data = bigList();
  assert.ok(!peopleSummary(data, data.users.length).includes('showing'));
});

check('singular and plural both read correctly', () => {
  const one = { users: [{ login: 'a', source: 'owner' }, { login: 'b', source: 'added' }] };
  assert.match(peopleSummary(one, 2), /1 person with access, 1 owner/);
});

// --- what the rows say -------------------------------------------------------

check('every row renders, and only removable ones offer a Remove', () => {
  const data = bigList();
  const html = peopleRows(data, '', '');
  const rows = html.split('role="listitem"').length - 1;
  assert.strictEqual(rows, 63, `expected every person to render, got ${rows}`);
  const removes = html.split('data-remove=').length - 1;
  assert.strictEqual(removes, 60, 'a fixed entry was given a Remove button, or an added one was not');
});

check('an owner is marked as one, because it is not an ordinary grant', () => {
  const html = peopleRows({ users: [{ login: 'me', source: 'owner', removable: false }] }, '', '');
  assert.match(html, /Owner/);
  assert.match(html, /shares your devices/, 'the row does not say what being an owner means');
});

check('a fixed row explains itself instead of offering an action that fails', () => {
  const html = peopleRows({ users: [{ login: 'x', source: 'deployment', removable: false }] }, '', '');
  assert.ok(!html.includes('data-remove='), 'a row that cannot be removed offered a Remove button');
  assert.match(html, /configuration/);
});

check('an empty list and an empty filter result read differently', () => {
  // "Nobody has access" and "nobody matches" are very different facts, and
  // confusing them on this screen is alarming.
  const empty = peopleRows({ users: [] }, '', '');
  assert.match(empty, /Nobody else has access yet/);
  const noMatch = peopleRows(bigList(), 'zzzzz', '');
  assert.match(noMatch, /Nobody matches/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
