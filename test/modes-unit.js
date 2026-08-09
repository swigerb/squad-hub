'use strict';
/**
 * Modes: interactive, plan, autopilot.
 *
 * The mode decides how much a person is asked before the agent acts, which
 * makes silently failing to apply it worse than silently failing to apply an
 * agent or a model. Someone who chose autopilot and got interactive is waiting
 * for a session that is waiting for them, and neither says so. Someone who
 * chose plan and got autopilot has an agent changing files they expected only
 * to be told about.
 *
 * So this asserts two things end to end: that the mode is APPLIED over the
 * protocol rather than accepted and dropped, and that when it cannot be applied
 * the session SAYS SO rather than reporting what was asked for as though it
 * were what happened.
 *
 * `web/app.js` has no build step and no exports, so its DOM-free prefix is
 * evaluated directly, exactly as web-xss-unit.js does.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

let pass = 0; let fail = 0;
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }

const { selectAgent, MODES } = require('../src/agent-select');

// --- the mode reaches the protocol ------------------------------------------

/**
 * A stand-in for the agent's side of ACP.
 *
 * Records every `session/set_config_option` it is asked for, so "was the mode
 * applied" is answered by what the peer RECEIVED rather than by what the hub
 * says about itself. A hub that believes it applied a mode and did not is the
 * exact defect this whole area already shipped once.
 */
function fakeSession({ modes = ['agent', 'plan', 'autopilot'], refuse = false } = {}) {
  const { AcpSession } = require('../src/acp-session');
  const s = Object.create(AcpSession.prototype);
  EventEmitter.call(s);
  Object.assign(s, EventEmitter.prototype);
  s._events = {};
  s._eventsCount = 0;
  s.acpSessionId = 'acp-1';
  s.sent = [];
  s._request = async (method, params) => {
    s.sent.push({ method, params });
    if (refuse) throw new Error('nope');
    return {};
  };
  const newSession = {
    configOptions: [
      {
        id: 'agent',
        options: [{ name: 'Squad', value: 'squad' }],
      },
      {
        id: 'mode',
        options: modes.map((m) => ({
          name: m,
          value: `https://agentclientprotocol.com/protocol/session-modes#${m}`,
        })),
      },
    ],
    models: { availableModels: [{ modelId: 'claude-opus-5' }] },
  };
  return { s, newSession };
}

check('the mode is applied over the protocol, not accepted and dropped', async () => {
  const { s, newSession } = fakeSession();
  s.agentSelection = { mode: 'autopilot' };
  const applied = await s._applySelection(newSession);
  const call = s.sent.find((c) => c.method === 'session/set_config_option' && c.params.configId === 'mode');
  assert.ok(call, 'no session/set_config_option was sent for the mode -- it was accepted and ignored');
  assert.match(call.params.value, /#autopilot$/, `sent the wrong value: ${call.params.value}`);
  assert.strictEqual(applied.mode, 'autopilot');
  assert.deepStrictEqual(applied.warnings, []);
});

check('a mode is matched by its readable name, not only its URI', async () => {
  for (const m of MODES) {
    const { s, newSession } = fakeSession();
    s.agentSelection = { mode: m };
    const applied = await s._applySelection(newSession);
    assert.strictEqual(applied.mode, m, `${m} was not applied`);
  }
});

check('the full URI is accepted too, so a caller that has one need not strip it', async () => {
  const { s, newSession } = fakeSession();
  s.agentSelection = { mode: 'https://agentclientprotocol.com/protocol/session-modes#plan' };
  const applied = await s._applySelection(newSession);
  assert.strictEqual(applied.mode, 'plan');
});

check('asking for no mode sends nothing at all', async () => {
  const { s, newSession } = fakeSession();
  s.agentSelection = { agent: 'squad' };
  const applied = await s._applySelection(newSession);
  assert.ok(!s.sent.some((c) => c.params && c.params.configId === 'mode'),
    'a mode was set when none was asked for');
  assert.strictEqual(applied.mode, null);
});

check('a mode this agent does not offer is REPORTED, never silently swapped', async () => {
  const { s, newSession } = fakeSession({ modes: ['agent'] });
  s.agentSelection = { mode: 'autopilot' };
  const applied = await s._applySelection(newSession);
  assert.strictEqual(applied.mode, null, 'claimed to have applied a mode the agent never offered');
  assert.strictEqual(applied.warnings.length, 1);
  assert.match(applied.warnings[0], /autopilot/);
  assert.match(applied.warnings[0], /available: agent/, 'the warning does not say what IS available');
});

check('a peer that refuses the mode degrades, and never takes the session down', async () => {
  const { s, newSession } = fakeSession({ refuse: true });
  s.agentSelection = { mode: 'plan' };
  const applied = await s._applySelection(newSession);
  assert.strictEqual(applied.mode, null);
  assert.match(applied.warnings.join(' '), /could not select the mode/);
});

check('what the agent offers is recorded, so a surface can offer it back', async () => {
  const { s, newSession } = fakeSession();
  let announced = null;
  s.on('capabilities', (c) => { announced = c; });
  await s._applySelection(newSession);
  assert.deepStrictEqual(s.available.modes, ['agent', 'plan', 'autopilot']);
  assert.ok(announced && announced.modes.length === 3, 'capabilities were not announced');
});

// --- the mode is validated before it travels --------------------------------

check('a mode that is not a mode is refused, and says so', () => {
  const sel = selectAgent({ cwd: process.cwd(), explicitMode: 'yolo' });
  assert.strictEqual(sel.mode, null, 'an invented mode was passed through');
  assert.match(sel.warnings.join(' '), /is not a mode/);
});

check('the mode is a closed set, not a name pattern', () => {
  // `squad` is a perfectly valid NAME, and would pass a name check. It is not
  // a mode, and the difference is the point of validating it separately.
  const sel = selectAgent({ cwd: process.cwd(), explicitMode: 'squad' });
  assert.strictEqual(sel.mode, null);
});

check('the mode is case-insensitive, because a dropdown value and a typed one differ', () => {
  assert.strictEqual(selectAgent({ cwd: process.cwd(), explicitMode: 'AutoPilot' }).mode, 'autopilot');
});

check('a project config cannot set the mode for whoever runs the session', () => {
  // Deliberate: the mode decides how much a person is asked before a tool runs.
  // A checked-out repository choosing that for them would let a repository turn
  // off its reader's approvals.
  const sel = selectAgent({ cwd: process.cwd() });
  assert.strictEqual(sel.mode, null, 'a mode arrived from somewhere other than the caller');
});

// --- the row tells the truth about it ---------------------------------------

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
const idx = src.indexOf('(async function main()');
const mod = { exports: {} };
new Function('module', `${src.slice(0, idx)}\nmodule.exports = { sessionRow, spawnRequest };`)(mod);
const { sessionRow, spawnRequest } = mod.exports;

const row = (agentSelection, applied) => sessionRow({
  id: 's1', key: 's1', prompt: 'do the thing', status: 'active', cwd: '/work', agentSelection, applied,
}, 'my-device');

check('a session that did not get the mode it asked for says so', () => {
  const html = row(
    { agent: 'squad', mode: 'autopilot', source: 'explicit' },
    { agent: 'squad', model: null, mode: null, warnings: [] },
  );
  assert.ok(/not squad, autopilot|running .*not/.test(html),
    `the row does not report the mismatch: ${html}`);
});

check('a session that DID get the mode it asked for is not accused of a mismatch', () => {
  const html = row(
    { agent: 'squad', mode: 'autopilot', source: 'explicit' },
    { agent: 'squad', model: null, mode: 'autopilot', warnings: [] },
  );
  assert.ok(!html.includes('running '), `a correct session was reported as a mismatch: ${html}`);
  assert.ok(html.includes('autopilot'), 'the mode is not shown at all');
});

check('the mode is matched against the readable form of what was applied', () => {
  // The peer may report the URI rather than the short name; that is the same
  // mode, and calling it a mismatch would be a false alarm on every session.
  const html = row(
    { agent: 'squad', mode: 'plan', source: 'explicit' },
    {
      agent: 'squad',
      model: null,
      mode: 'https://agentclientprotocol.com/protocol/session-modes#plan',
      warnings: [],
    },
  );
  assert.ok(!html.includes('running '), `a URI-reported mode was called a mismatch: ${html}`);
});

check('the ordinary interactive mode is not announced on every row', () => {
  // "agent" mode is what happens anyway. Printing it on every session spends a
  // column saying nothing.
  const html = row(
    { agent: 'squad', mode: 'agent', source: 'explicit' },
    { agent: 'squad', model: null, mode: 'agent', warnings: [] },
  );
  assert.ok(!html.includes(', agent'), `interactive mode was announced needlessly: ${html}`);
});

check('a malicious mode renders as inert escaped text, never live markup', () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const html = row(
    { agent: 'squad', mode: XSS, source: 'explicit' },
    { agent: 'squad', model: null, mode: null, warnings: [] },
  );
  assert.ok(!html.includes('<img'), 'a malicious mode value survived unescaped into the row');
});

// --- the request carries it -------------------------------------------------

check('the spawn request carries the mode', () => {
  assert.strictEqual(spawnRequest({ prompt: 'x', mode: 'autopilot' }).mode, 'autopilot');
});

check('"no preference" is an ABSENT field, not a mode named empty string', () => {
  const body = spawnRequest({ prompt: 'x', mode: '' });
  assert.ok(!('mode' in body), 'an empty mode was sent as a value');
});

(async () => {
  for (const { name, fn } of queue) {
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
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
