'use strict';
/**
 * Escape dismissal order in `web/js/wiring.js` (#243 Scout re-review, PR #243):
 * one Escape dismisses the TOPMOST thing, and only a later Escape closes the
 * detail page once nothing else is left to dismiss.
 *
 * Loaded the same flattened way as row-menu-action-unit.js so this exercises
 * the shipped `openRowMenu`/`closeRowMenu`/detail wiring helpers, not a copy.
 */

const assert = require('assert');
const { readWebSource } = require('./helpers/web-source');

let pass = 0; let fail = 0;
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

const src = readWebSource();
const mod = { exports: {} };
new Function('module', 'exports', `${src}
module.exports = { dismissTopmostEscapeTarget, openRowMenu, closeRowMenu, closeDetail, state };`)(mod, mod.exports);
const {
  dismissTopmostEscapeTarget, openRowMenu, closeRowMenu, closeDetail, state,
} = mod.exports;

function makeClassList(initial = []) {
  const classes = new Set(initial);
  return {
    add(name) { classes.add(name); },
    remove(name) { classes.delete(name); },
    contains(name) { return classes.has(name); },
    toggle(name) {
      if (classes.has(name)) { classes.delete(name); return false; }
      classes.add(name);
      return true;
    },
  };
}

function makeElement(id, doc, overrides = {}) {
  const attrs = new Map();
  const el = {
    id,
    hidden: false,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    title: '',
    dataset: {},
    style: {},
    classList: makeClassList(),
    onclick: null,
    onkeydown: null,
    oninput: null,
    onchange: null,
    getBoundingClientRect: () => ({
      left: 100, right: 140, top: 20, bottom: 44, width: 40, height: 24,
    }),
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus() { doc.activeElement = el; },
    ...overrides,
  };
  return el;
}

function makeEnvironment() {
  const doc = {
    activeElement: null,
    title: '',
    _els: new Map(),
    getElementById(id) { return this._els.get(id) || null; },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ value: '', select() {}, remove() {} }),
    body: { appendChild() {} },
    execCommand: () => false,
  };
  const add = (id, overrides = {}) => {
    const el = makeElement(id, doc, overrides);
    doc._els.set(id, el);
    return el;
  };

  add('approvalScrim', { hidden: true });
  add('newScrim', { hidden: true });
  add('detailScrim', { hidden: true });
  add('listPage', { hidden: false });
  add('menu', { hidden: true });
  add('menuBtn');
  add('menuMeta');
  add('newMenu', { hidden: true });
  add('newMoreBtn');
  add('tidyMenu', { hidden: true });
  add('tidyBtn');
  add('inboxMenu', { hidden: true });
  add('bellBtn');
  add('filterbarEnd');
  add('filterToggle');

  const rowMenu = add('rowMenu', { hidden: true });
  rowMenu.getBoundingClientRect = () => ({
    left: 0, right: 0, top: 0, bottom: 0, width: 180, height: 120,
  });
  const firstItem = makeElement('rowMenuFirst', doc);
  rowMenu.querySelector = (sel) => (sel === 'button:not([disabled])' && !rowMenu.hidden ? firstItem : null);
  rowMenu.querySelectorAll = () => [];

  const opener = add('dtMoreBtn');
  opener.focusCalls = 0;
  opener.focus = () => {
    opener.focusCalls += 1;
    doc.activeElement = opener;
  };

  return { doc, opener };
}

function resetState() {
  state.overview = {
    devices: [],
    groups: [],
    counts: { devices: 1, sessions: 1, actionNeeded: 0 },
    hubVersion: '',
  };
  state.filters = {
    q: '', status: '', device: '', repo: '', org: '', window: '',
  };
  state.scope = 'all';
  state.groupBy = 'device';
  state.sortBy = 'started_desc';
  state.favorites = new Set();
  state.names = {};
  state.currentSession = { session: { id: 's1', key: 's1' }, device: { deviceId: 'd1', name: 'Device' } };
  state.seenApprovals = new Set();
  state.notified = new Set();
  state.openApproval = null;
}

function setOverview() {
  state.overview.groups = [{
    device: { deviceId: 'd1', name: 'Device', presence: 'online' },
    sessions: [{
      id: 's1',
      key: 's1',
      prompt: 'Prompt',
      status: 'running',
    }],
  }];
}

function pressEscapeLikeApp(doc) {
  const dismissed = dismissTopmostEscapeTarget();
  if (!dismissed && !doc.getElementById('detailScrim').hidden) closeDetail();
  return dismissed;
}

(async () => {
  const oldWindow = global.window;
  const oldDocument = global.document;
  const oldLocation = Object.getOwnPropertyDescriptor(global, 'location');
  const oldHistory = Object.getOwnPropertyDescriptor(global, 'history');
  const setLocation = (v) => Object.defineProperty(global, 'location', { value: v, configurable: true });
  const setHistory = (v) => Object.defineProperty(global, 'history', { value: v, configurable: true });

  try {
    await checkAsync('Escape closes the detail header row menu first, returns focus, and only the next Escape closes detail', async () => {
      resetState();
      const { doc, opener } = makeEnvironment();
      global.document = doc;
      global.window = { innerWidth: 1280, innerHeight: 900, confirm: () => true, prompt: () => null, navigator: {} };
      setLocation({ origin: 'https://hub.example', pathname: '/', search: '' });
      setHistory({ pushState() {}, replaceState() {} });
      setOverview();
      closeRowMenu();
      doc.getElementById('detailScrim').hidden = false;

      openRowMenu('s1', opener);
      assert.strictEqual(doc.getElementById('rowMenu').hidden, false, 'setup failed: the shared row menu never opened');
      assert.strictEqual(doc.activeElement.id, 'rowMenuFirst', 'setup failed: focus never entered the opened menu');

      const first = pressEscapeLikeApp(doc);
      assert.strictEqual(first, true, 'the first Escape should dismiss the row menu');
      assert.strictEqual(doc.getElementById('rowMenu').hidden, true, 'Escape did not close the shared row menu from the detail header');
      assert.strictEqual(doc.getElementById('detailScrim').hidden, false, 'Escape closed the detail page instead of just the header menu');
      assert.strictEqual(opener.focusCalls, 1, 'Escape did not return focus to the detail header ⋯ button');
      assert.strictEqual(doc.activeElement, opener, 'focus did not land back on the detail header opener');

      const second = pressEscapeLikeApp(doc);
      assert.strictEqual(second, false, 'the second Escape should find nothing else to dismiss first');
      assert.strictEqual(doc.getElementById('detailScrim').hidden, true, 'a second Escape should close the detail page once the menu is gone');
    });

    await checkAsync('a higher-priority approval scrim dismisses before the shared row menu, leaving detail untouched', async () => {
      resetState();
      const { doc, opener } = makeEnvironment();
      global.document = doc;
      global.window = { innerWidth: 1280, innerHeight: 900, confirm: () => true, prompt: () => null, navigator: {} };
      setLocation({ origin: 'https://hub.example', pathname: '/', search: '' });
      setHistory({ pushState() {}, replaceState() {} });
      setOverview();
      closeRowMenu();
      doc.getElementById('detailScrim').hidden = false;

      // This combination can happen: `showApproval()` opens the scrim without
      // closing `rowMenu`, and `openRowMenu()` never closes the approval scrim.
      openRowMenu('s1', opener);
      doc.getElementById('approvalScrim').hidden = false;

      const dismissed = pressEscapeLikeApp(doc);
      assert.strictEqual(dismissed, true, 'Escape should dismiss the approval scrim first');
      assert.strictEqual(doc.getElementById('approvalScrim').hidden, true, 'the approval scrim stayed open');
      assert.strictEqual(doc.getElementById('rowMenu').hidden, false, 'Escape skipped the scrim and closed the row menu instead');
      assert.strictEqual(doc.getElementById('detailScrim').hidden, false, 'dismissing the scrim also closed the detail page');
      assert.strictEqual(opener.focusCalls, 0, 'closing the scrim should not have restored focus from the still-open row menu');
    });

    await checkAsync('when nothing else is open, the dismiss helper returns false and leaves detail alone', async () => {
      resetState();
      const { doc } = makeEnvironment();
      global.document = doc;
      global.window = { innerWidth: 1280, innerHeight: 900, confirm: () => true, prompt: () => null, navigator: {} };
      setLocation({ origin: 'https://hub.example', pathname: '/', search: '' });
      setHistory({ pushState() {}, replaceState() {} });
      setOverview();
      closeRowMenu();
      doc.getElementById('detailScrim').hidden = false;

      const before = doc.getElementById('detailScrim').hidden;
      const dismissed = dismissTopmostEscapeTarget();
      assert.strictEqual(dismissed, false, 'nothing was open, so the helper should report that it dismissed nothing');
      assert.strictEqual(doc.getElementById('detailScrim').hidden, before, 'the helper itself should not close the detail page');
    });
  } finally {
    if (oldWindow === undefined) delete global.window; else global.window = oldWindow;
    if (oldDocument === undefined) delete global.document; else global.document = oldDocument;
    if (oldLocation) Object.defineProperty(global, 'location', oldLocation); else delete global.location;
    if (oldHistory) Object.defineProperty(global, 'history', oldHistory); else delete global.history;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
