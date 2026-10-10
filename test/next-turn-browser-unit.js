#!/usr/bin/env node
'use strict';
/**
 * Mode and Model for the next turn (#183), driven the way a person drives them.
 *
 * A REAL browser, a REAL hub and REAL daemons, each running a real fake-agent
 * child (test/fake-agent.js, shaped like `copilot --acp` 1.0.93 / 1.0.95). The
 * assertions are about SIDE EFFECTS: the fake agent's own log of every mode and
 * model RPC and, for each prompt, the mode and model that prompt RAN in
 * (FAKE_AGENT_RPC_LOG). "Applied before the prompt" is read off that log, not
 * inferred from what the page says.
 *
 * Also here, because the issue asks for it: the composer's vertical alignment
 * within 1px at 1280, 900 and 390px, in the dark and the light theme.
 *
 * PLAYWRIGHT IS OPTIONAL, exactly as in browser-e2e-unit.js, and a skip says so
 * loudly. SQUAD_HUB_E2E_CHROMIUM names a browser binary when Playwright's own
 * download is not the one to use; SQUAD_HUB_E2E_SHOTS names a directory to
 * write the dark/light, desktop/phone screenshots into.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* optional */ }

if (!chromium) {
  console.log('  SKIPPED  next-turn browser end-to-end: playwright is not installed');
  console.log('RESULT\tskip\tnext-turn browser end-to-end (playwright not installed)');
  console.log('\n0 passed, 0 failed, 1 skipped');
  process.exit(0);
}

const { Authenticator, MODES } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');
const { Daemon } = require('../src/daemon');
const config = require('../src/config');

const FAKE = path.join(__dirname, 'fake-agent.js');
const modeUri = (n) => `https://agentclientprotocol.com/protocol/session-modes#${n}`;
const SHOTS = process.env.SQUAD_HUB_E2E_SHOTS || '';

let pass = 0; let fail = 0;
async function check(name, fn) {
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

async function until(fn, what, budgetMs = 15000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A navigation can be interrupted by the app's own; ask once more, as browser-e2e does. */
async function gotoSettled(page, url) {
  try {
    return await page.goto(url);
  } catch (e) {
    if (!/interrupted by another navigation|Execution context was destroyed/i.test(String(e && e.message))) throw e;
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch { /* busy is fine */ }
    return page.goto(url);
  }
}

(async () => {
  console.log('next-turn browser end-to-end');
  console.log('='.repeat(60));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sqntui-'));
  process.env.SQUAD_HUB_HOME = home;
  config.update({ allowFiles: true, allowFilesAll: true, filesRoot: null });

  const auth = new Authenticator({ mode: MODES.DEV, devSecret: crypto.randomBytes(16).toString('hex') });
  const svc = new HubService({ auth, serveWeb: true });
  const addr = await svc.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${addr.port}`;
  const wsUrl = `${origin.replace('http', 'ws')}/ws`;
  const userToken = auth.mintDevToken('t1', 'u1', 'test person');
  const bearer = { Authorization: `Bearer ${userToken}` };

  const daemons = [];
  /**
   * A device with one session that has finished its first turn, running the
   * fake-agent variant `variant`. The variant is read by the agent child at
   * spawn, so it is set around `start-session` and nowhere else.
   */
  async function device(id, name, variant, { agentMode = 'no-permission', waitFor = 'idle' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqntui-w-'));
    process.env.FAKE_AGENT_NEXT_TURN = variant;
    process.env.FAKE_AGENT_MODE = agentMode;
    process.env.FAKE_AGENT_RPC_LOG = 'rpc.log';
    const d = new Daemon();
    d.agentCommand = process.execPath;
    d.agentArgs = [FAKE];
    d.deviceName = name;
    await d.attachHub({ url: wsUrl, token: userToken, deviceId: id });
    const started = await d.handle({ op: 'start-session', prompt: 'first turn', cwd: dir });
    const s = d.sessions.get(started.id);
    await until(() => s.status === waitFor, `${id}'s session to be ${waitFor}`);
    delete process.env.FAKE_AGENT_NEXT_TURN;
    delete process.env.FAKE_AGENT_MODE;
    delete process.env.FAKE_AGENT_RPC_LOG;
    daemons.push(d);
    const dev = {
      id, name, d, s, dir, sessionId: started.id, key: `${id}:${started.id}`,
    };
    // Until the hub has heard it from the device, the page has nothing to show.
    await until(async () => {
      const r = await fetch(`${origin}/api/sessions`, { headers: bearer });
      const body = await r.json();
      const row = (body.sessions || []).find((x) => x.key === dev.key);
      return row && row.status === waitFor && row.nextTurn;
    }, `the hub to list ${id}'s session with its nextTurn`);
    return dev;
  }

  const rpcLog = (dev) => {
    const p = path.join(dev.dir, 'rpc.log');
    return fs.existsSync(p)
      ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  };

  const launch = { headless: true };
  if (process.env.SQUAD_HUB_E2E_CHROMIUM) launch.executablePath = process.env.SQUAD_HUB_E2E_CHROMIUM;
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  const dialogs = [];
  const steerBodies = [];
  const steerReplies = [];
  const cspViolations = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('dialog', (dlg) => { dialogs.push(dlg.message()); dlg.dismiss().catch(() => {}); });
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/steer$/.test(req.url())) {
      try { steerBodies.push(JSON.parse(req.postData() || '{}')); } catch { steerBodies.push(null); }
    }
  });
  page.on('response', (res) => {
    if (res.request().method() === 'POST' && /\/steer$/.test(res.url())) steerReplies.push(res.status());
  });
  await page.exposeFunction('__reportCspViolation', (v) => cspViolations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__reportCspViolation({ directive: e.violatedDirective, blockedURI: e.blockedURI, page: location.href });
    });
  });

  // `?token=` is read and the whole query string dropped, so the token goes in
  // on one load. A session is then opened the way a person opens one: by
  // clicking its row in the list.
  let signedIn = false;
  const isSynced = async () => (await page.textContent('#dtControlLabel')).trim() === 'Synced';
  const openSession = async (dev) => {
    if (!signedIn) {
      await gotoSettled(page, `${origin}/?token=${userToken}`);
      signedIn = true;
    }
    if (await page.$('#detailScrim:not([hidden])')) {
      await page.click((await page.isVisible('#dtBack')) ? '#dtBack' : '#dtBackPhone');
      await page.waitForSelector('#detailScrim', { state: 'hidden', timeout: 10000 });
    }
    const row = `.row[data-session="${dev.key}"]`;
    await page.waitForSelector(row, { timeout: 20000 });
    await page.click(row);
    await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
    await until(isSynced, 'the composer to report Synced', 12000);
  };
  const selectedText = (id) => page.$eval(`#${id}`, (s) => (s.options[s.selectedIndex] || {}).text || '');
  const optionTexts = (id) => page.$eval(`#${id}`, (s) => [...s.options].map((o) => o.text));
  const pillOf = (id) => page.locator(`#${id}`).locator('xpath=ancestor::div[contains(@class,"selectpill")]');
  async function choose(id, text) {
    const pill = pillOf(id);
    await pill.click();
    await pill.locator('.sp-opt').filter({ hasText: new RegExp(`^${text}$`) }).click();
  }

  let a = null;
  let b = null;
  let c = null;
  let w = null;
  let l = null;
  let s = null;
  try {
    a = await device('nt-capable', 'Capable Device', 'copilot');
    b = await device('nt-nolist', 'No Confirm Device', 'models-only');
    c = await device('nt-refuse', 'Refusing Device', 'refuse-mode');
    w = await device('nt-working', 'Working Device', 'copilot', { agentMode: 'steer-race', waitFor: 'active' });
    l = await device('nt-slow', 'Slow Device', 'slow');
    s = await device('nt-stuck', 'Stuck Device', 'stuck');

    // ---- what is offered ---------------------------------------------------
    await check('composer: the bar offers Agent, Plan and Autopilot and the model list the device gave, each at its current value', async () => {
      await openSession(a);
      await until(async () => !(await page.$eval('#dtNtMode', (s) => s.disabled)), 'the Mode selector to enable');
      assert.deepStrictEqual(await optionTexts('dtNtMode'), ['Agent', 'Plan', 'Autopilot'],
        'Mode did not offer exactly the three labels the device advertised');
      const fromDevice = a.s.nextTurnState().model.choices.map((x) => x.name);
      assert.ok(fromDevice.length >= 3, 'the fake device should advertise several models');
      assert.deepStrictEqual(await optionTexts('dtNtModel'), fromDevice,
        'Model did not list what the device itself reported');
      assert.strictEqual(await selectedText('dtNtMode'), 'Agent', 'Mode did not show the session\'s current mode');
      assert.strictEqual(await selectedText('dtNtModel'), 'Fake Fast', 'Model did not show the session\'s current model');
      const shown = await page.textContent('#dtNextTurn .nt-field:nth-child(1) .sp-value');
      assert.strictEqual(shown.trim(), 'Agent', 'the visible pill does not show the current mode');
    });

    await check('composer: Mode and Model each have an i explainer with a title, and pressing it says the same under the bar', async () => {
      for (const [id, field, words] of [
        ['dtNtModeHint', 'Mode', /next message/i], ['dtNtModelHint', 'Model', /device/i],
      ]) {
        const hint = await page.$eval(`#${id}`, (el) => ({
          cls: el.className, title: el.getAttribute('title'), aria: el.getAttribute('aria-label'),
          text: el.textContent, tag: el.tagName, insidePill: !!el.closest('.selectpill'),
        }));
        assert.strictEqual(hint.tag, 'BUTTON', `${field}'s explainer is not a button`);
        assert.match(hint.cls, /\bhint-btn\b/, `${field}'s explainer is not a .hint-btn`);
        assert.strictEqual(hint.text.trim(), 'i');
        assert.ok(hint.title && hint.title.length > 60, `${field}'s explainer carries no real title`);
        assert.match(hint.title, words, `${field}'s explainer does not explain what it does`);
        assert.strictEqual(hint.aria, `About ${field}`);
        assert.strictEqual(hint.insidePill, false, `${field}'s explainer sits inside the dropdown it explains`);
        // A title cannot be read on a phone, so pressing the i says it where a thumb can reach.
        await page.click(`#${id}`);
        assert.match(await page.textContent('#dtNtNote'), words, `pressing ${field}'s i did not say what it says`);
        assert.strictEqual(await page.isVisible('#dtNtNote'), true, `${field}'s explanation is not visible`);
        await page.click(`#${id}`);
        assert.strictEqual((await page.textContent('#dtNtNote')).trim(), '', `pressing ${field}'s i again did not put the explanation away`);
      }
      await page.click('#dtNtModeHint');
      await page.fill('#dtInput', 'typing puts it away');
      assert.strictEqual((await page.textContent('#dtNtNote')).trim(), '', 'an explanation stayed open while the person typed');
      await page.fill('#dtInput', '');
    });

    // ---- the next turn -----------------------------------------------------
    await check('composer: choosing Plan and a model then sending runs the prompt in both, with both changes made first', async () => {
      await choose('dtNtMode', 'Plan');
      await choose('dtNtModel', 'Fake Deep');
      assert.strictEqual(await selectedText('dtNtMode'), 'Plan');
      // A pick is only a pick: nothing has gone to the agent yet.
      assert.deepStrictEqual(rpcLog(a).filter((e) => e.method !== 'session/prompt'), [],
        'a change reached the agent before the message was sent');
      await page.fill('#dtInput', 'plan the next step');
      steerBodies.length = 0;
      await page.click('#dtSend');
      await until(() => rpcLog(a).some((e) => e.method === 'session/prompt' && e.text === 'plan the next step'),
        'the prompt to reach the agent');
      const log = rpcLog(a);
      const promptAt = log.findIndex((e) => e.method === 'session/prompt' && e.text === 'plan the next step');
      const before = log.slice(0, promptAt).filter((e) => e.method !== 'session/prompt');
      assert.deepStrictEqual(before.map((e) => `${e.method}:${e.field}:${e.value}`).sort(), [
        'session/set_config_option:mode:' + modeUri('plan'),
        'session/set_config_option:model:fake-deep',
      ].sort(), 'the changes were not both made, over set_config_option, before the prompt');
      assert.strictEqual(log[promptAt].mode, 'plan', 'the prompt did not run in plan mode');
      assert.strictEqual(log[promptAt].model, 'fake-deep', 'the prompt did not run on the chosen model');
      assert.deepStrictEqual(steerBodies, [{
        sessionId: a.sessionId, text: 'plan the next step', mode: modeUri('plan'), model: 'fake-deep',
      }], 'the page did not send exactly the pick and the message');
      assert.strictEqual(await page.inputValue('#dtInput'), '', 'the draft was kept after it landed');
    });

    await check('composer: the transcript shows each confirmed change, and the bar reports only what the agent confirmed', async () => {
      await until(async () => (await page.textContent('#dtNtNote')).includes('The agent confirmed'),
        'the bar to report the confirmed change');
      const note = await page.textContent('#dtNtNote');
      assert.match(note, /Mode is now Plan\./);
      assert.match(note, /Model is now Fake Deep\./);
      assert.strictEqual(await page.getAttribute('#dtNtNote', 'data-kind'), 'ok');
      // A local device does not stream its transcript to the hub, so the page
      // reads it the way a person does: by opening the session again.
      await openSession(a);
      const entries = await until(async () => {
        const all = await page.$$eval('#dtTranscript .t-entry', (els) => els.map((e) => ({
          cls: e.className, text: e.textContent.replace(/\s+/g, ' ').trim(),
        })));
        return all.filter((e) => /t-selection/.test(e.cls)).length >= 2 ? all : null;
      }, 'the transcript to show both changes');
      const rows = entries.filter((e) => /t-selection/.test(e.cls)).map((e) => e.text);
      assert.deepStrictEqual(rows.slice().sort(), ['mode Agent → Plan', 'model Fake Fast → Fake Deep'],
        `the transcript did not show exactly the two confirmed changes: ${rows.join(' | ')}`);
      // Written where they took effect: before the message that needed them.
      const sentAt = entries.findIndex((e) => /t-you/.test(e.cls) && e.text.includes('plan the next step'));
      assert.ok(sentAt >= 0, 'the sent message is not in the transcript');
      entries.forEach((e, i) => {
        if (/t-selection/.test(e.cls)) assert.ok(i < sentAt, `"${e.text}" is listed after the message it was for`);
      });
      assert.strictEqual(await selectedText('dtNtMode'), 'Plan', 'the bar does not show the mode the agent now confirms');
    });

    await check('composer: a pick does not outlive its message, and choosing what the session already has sends no change request', async () => {
      await until(async () => !(await page.$eval('#dtNtMode', (s) => s.disabled)), 'the selectors to come back at idle');
      // The agent leaves plan mode by itself. The Plan that was chosen for the
      // PREVIOUS message must not come back and take its place on the bar.
      await page.fill('#dtInput', 'wrap up EXIT-PLAN');
      steerBodies.length = 0;
      await page.click('#dtSend');
      await until(() => rpcLog(a).some((e) => e.text === 'wrap up EXIT-PLAN'), 'the prompt to arrive');
      assert.deepStrictEqual(steerBodies, [{ sessionId: a.sessionId, text: 'wrap up EXIT-PLAN' }],
        'an earlier pick rode along with a later message');
      await until(async () => (await selectedText('dtNtMode')) === 'Agent',
        'the bar to show the mode the agent moved to, and not the pick an earlier message carried');
      await until(async () => !(await page.$eval('#dtNtMode', (s) => s.disabled)), 'the selectors to come back after the agent moved');
      assert.strictEqual(await selectedText('dtNtModel'), 'Fake Deep');
      await choose('dtNtMode', 'Autopilot');
      await choose('dtNtMode', 'Agent');
      const before = rpcLog(a).length;
      await page.fill('#dtInput', 'same mode again');
      steerBodies.length = 0;
      await page.click('#dtSend');
      await until(() => rpcLog(a).some((e) => e.text === 'same mode again'), 'the second prompt to arrive');
      assert.deepStrictEqual(steerBodies, [{ sessionId: a.sessionId, text: 'same mode again' }],
        'a pick equal to the current value was sent as a change');
      const added = rpcLog(a).slice(before).filter((e) => e.method !== 'session/prompt');
      assert.deepStrictEqual(added, [], 'the agent was asked to change something that was already so');
    });

    // ---- refusals ----------------------------------------------------------
    await check('composer: a refused change keeps the draft and the pick, names the reason, and claims nothing applied', async () => {
      await openSession(c);
      await until(async () => !(await page.$eval('#dtNtMode', (s) => s.disabled)), 'the Mode selector to enable');
      await choose('dtNtMode', 'Plan');
      await page.fill('#dtInput', 'keep this draft');
      dialogs.length = 0;
      steerBodies.length = 0;
      await page.click('#dtSend');
      await until(async () => (await page.getAttribute('#dtNtNote', 'data-kind')) === 'error', 'the refusal to be reported');
      const note = await page.textContent('#dtNtNote');
      assert.match(note, /could not change the mode to Plan/i, `the reason was not given: ${note}`);
      assert.match(note, /not sent/i, 'the note did not say the message was not sent');
      assert.match(note, /kept/i, 'the note did not say the draft and choices are kept');
      assert.strictEqual(await page.inputValue('#dtInput'), 'keep this draft', 'the draft was thrown away by a refusal');
      assert.strictEqual(await selectedText('dtNtMode'), 'Plan', 'the pick was lost by a refusal');
      assert.deepStrictEqual(dialogs, [], 'a refusal raised a dialog instead of saying so under the bar');
      assert.strictEqual(await page.$('#dtTranscript .t-selection'), null, 'the transcript shows a change that was never confirmed');
      assert.ok(!/confirmed|is now/i.test(note), `the bar claims something was applied: ${note}`);
      const prompts = rpcLog(c).filter((e) => e.text === 'keep this draft');
      assert.deepStrictEqual(prompts, [], 'the message was delivered although the change was refused');
      assert.strictEqual(c.s.nextTurnState().mode.current, modeUri('agent'), 'the device reports a mode it never entered');
    });

    await check('composer: an agent that cannot change them shows both disabled with the reason, and an ordinary message still sends', async () => {
      await openSession(b);
      await until(async () => (await page.getAttribute('#dtNextTurn .nt-field >> nth=0', 'data-state')) === 'off',
        'Mode to be marked unavailable');
      for (const id of ['dtNtMode', 'dtNtModel']) {
        assert.strictEqual(await page.$eval(`#${id}`, (s) => s.disabled), true, `${id} is enabled on a device that cannot do it`);
        assert.strictEqual(await selectedText(id), 'Unavailable');
        assert.strictEqual(await pillOf(id).getAttribute('aria-disabled'), 'true');
      }
      const note = await page.textContent('#dtNtNote');
      assert.match(note, /unavailable/i);
      assert.match(note, /did not offer a choice of mode/i, `Mode's reason is missing: ${note}`);
      assert.match(note, /no way to confirm/i, `Model's reason is missing: ${note}`);
      const title = await page.getAttribute('#dtNtModelHint', 'title');
      assert.match(title, /Not available right now: .*no way to confirm/is, 'the i explainer does not carry the reason');
      await page.fill('#dtInput', 'hello there');
      steerBodies.length = 0;
      await page.click('#dtSend');
      await until(() => steerBodies.length === 1, 'the ordinary message to be sent');
      assert.deepStrictEqual(steerBodies, [{ sessionId: b.sessionId, text: 'hello there' }],
        'an unsupported device was sent a mode or model');
      await until(async () => (await page.inputValue('#dtInput')) === '', 'the draft to clear once it landed');
    });

    await check('composer: a disabled selector cannot be opened by pointer or script', async () => {
      const opened = await page.evaluate(() => {
        const pill = document.getElementById('dtNtMode').closest('.selectpill');
        pill.click();
        pill.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return !pill.querySelector('.sp-list').hidden || pill.classList.contains('open');
      });
      assert.strictEqual(opened, false, 'a disabled selector opened its list');
      assert.strictEqual(await pillOf('dtNtMode').getAttribute('tabindex'), '-1', 'a disabled selector is a tab stop');
    });

    await check('composer: the selectors are disabled while the agent is working, and say when they come back', async () => {
      await openSession(w);
      await until(async () => (await page.getAttribute('#dtNextTurn .nt-field >> nth=0', 'data-state')) === 'off',
        'the selectors to be marked unavailable');
      assert.strictEqual(await page.$eval('#dtNtMode', (s) => s.disabled), true);
      assert.strictEqual(await page.$eval('#dtNtModel', (s) => s.disabled), true);
      const note = await page.textContent('#dtNtNote');
      assert.match(note, /waiting for your next message/i, `the note did not say when: ${note}`);
    });

    await check('composer: an unknown mode or model sent straight to the API is refused as not offered, and changes nothing', async () => {
      const post = async (body) => {
        const r = await fetch(`${origin}/api/devices/${encodeURIComponent(a.id)}/steer`, {
          method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: a.sessionId, text: 'smuggled', ...body }),
        });
        return { status: r.status, body: await r.json() };
      };
      await until(() => a.s.status === 'idle', 'the capable session to be idle');
      const before = rpcLog(a).length;
      const badMode = await post({ mode: 'turbo' });
      const badModel = await post({ model: 'gpt-nonexistent' });
      assert.strictEqual(badMode.status, 422, `an unknown mode answered ${badMode.status}`);
      assert.strictEqual(badMode.body.code, 'selection-not-offered');
      assert.strictEqual(badModel.status, 422, `an unknown model answered ${badModel.status}`);
      assert.strictEqual(badModel.body.code, 'selection-not-offered');
      assert.deepStrictEqual(rpcLog(a).slice(before), [], 'a value nobody advertised reached the agent');
    });

    // ---- races -------------------------------------------------------------
    const waitReplies = async (n, what) => { await until(() => steerReplies.length >= n, what, 20000); await new Promise((r) => setTimeout(r, 400)); };
    const selectorsOn = (id = 'dtNtMode') => until(async () => !(await page.$eval(`#${id}`, (el) => el.disabled)), `${id} to enable`);

    await check('composer: while a change is confirmed Send and the selectors are held, and a send that lands after the person moved on leaves the box of the session they are in alone', async () => {
      await openSession(l);
      await selectorsOn();
      await choose('dtNtMode', 'Plan');
      await page.fill('#dtInput', 'slow message');
      steerBodies.length = 0;
      steerReplies.length = 0;
      await page.click('#dtSend');
      await until(async () => (await page.textContent('#dtNtNote')).includes('Sending your message'),
        'the bar to say the change is being confirmed');
      assert.strictEqual(await page.$eval('#dtSend', (el) => el.disabled), true, 'Send stayed live while the change was being confirmed');
      assert.strictEqual(await page.$eval('#dtNtMode', (el) => el.disabled), true, 'Mode stayed live while the change was being confirmed');
      await page.press('#dtInput', 'Enter');
      // Another session, while the agent is still making up its mind.
      await openSession(a);
      await selectorsOn();
      assert.strictEqual(await page.$eval('#dtSend', (el) => el.disabled), false, 'a send in flight for another session held this one');
      assert.ok(!(await page.textContent('#dtNtNote')).includes('Sending your message'), 'another session\'s send was reported here');
      await waitReplies(1, 'the slow change to be confirmed');
      assert.strictEqual(steerBodies.length, 1, `a second press sent a second message: ${JSON.stringify(steerBodies)}`);
      assert.strictEqual(steerReplies[0], 200);
      assert.strictEqual(await page.inputValue('#dtInput'), 'slow message', 'a send that landed after the person moved on changed the box of the session they are in');
      assert.ok(!(await page.textContent('#dtNtNote')).includes('The agent confirmed'), 'another session\'s outcome showed here');
      const log = rpcLog(l);
      const ran = log.find((e) => e.method === 'session/prompt' && e.text === 'slow message');
      assert.ok(ran, 'the slow message never reached the agent');
      assert.strictEqual(ran.mode, 'plan', 'the slow message did not run in the mode it was sent with');
      await openSession(l);
      await until(async () => (await selectedText('dtNtMode')) === 'Plan', 'the session to show the mode the agent confirmed');
      assert.ok(!(await page.textContent('#dtNtNote')).includes('The agent confirmed'), 'a send that outlived its page wrote its outcome on a page opened since');
      assert.strictEqual(await page.$eval('#dtSend', (el) => el.disabled), false, 'Send was left held after the send finished');
    });

    await check('composer: something typed in another session while a change is confirmed is not cleared when it lands', async () => {
      await selectorsOn();
      await choose('dtNtMode', 'Autopilot');
      await page.fill('#dtInput', 'second slow message');
      steerReplies.length = 0;
      await page.click('#dtSend');
      await until(async () => (await page.textContent('#dtNtNote')).includes('Sending your message'), 'the second change to be in flight');
      await openSession(a);
      await selectorsOn();
      await page.fill('#dtInput', 'typed in the other session');
      await waitReplies(1, 'the second change to be confirmed');
      assert.strictEqual(await page.inputValue('#dtInput'), 'typed in the other session', 'a later message was thrown away by an earlier send landing');
      assert.strictEqual(await page.$eval('#dtSend', (el) => el.disabled), false);
      assert.ok(rpcLog(l).some((e) => e.method === 'session/prompt' && e.text === 'second slow message' && e.mode === 'autopilot'),
        'the second message did not run in Autopilot');
      await page.fill('#dtInput', '');
    });

    await check('composer: something typed in the same session while a change is confirmed is kept when it lands', async () => {
      await openSession(l);
      await selectorsOn();
      await choose('dtNtMode', 'Agent');
      await page.fill('#dtInput', 'third slow message');
      steerReplies.length = 0;
      await page.click('#dtSend');
      await until(async () => (await page.textContent('#dtNtNote')).includes('Sending your message'), 'the third change to be in flight');
      await page.fill('#dtInput', 'and one more thought');
      await waitReplies(1, 'the third change to be confirmed');
      assert.strictEqual(await page.inputValue('#dtInput'), 'and one more thought', 'a later thought was thrown away by the earlier send landing');
      assert.ok(rpcLog(l).some((e) => e.method === 'session/prompt' && e.text === 'third slow message' && e.mode === 'agent'),
        'the third message did not run in Agent');
      await page.fill('#dtInput', '');
    });

    await check('composer: a queued note is not shown on a session the message was not sent to', async () => {
      // No local test device is a watched terminal, so the answer a watched
      // session gives is stood in for, at the network edge only, and held until
      // the person has moved on.
      let release;
      const held = new Promise((r) => { release = r; });
      let seen = false;
      await page.route('**/api/devices/*/steer', async (route) => {
        seen = true;
        await held;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queued: true }) });
      });
      try {
        await openSession(a);
        await selectorsOn();
        await page.fill('#dtInput', 'queued for a watched terminal');
        steerReplies.length = 0;
        await page.click('#dtSend');
        await until(() => seen, 'the steer request to be on its way');
        await openSession(l);
        await selectorsOn();
        release();
        await waitReplies(1, 'the held answer to land');
      } finally {
        release();
        await page.unroute('**/api/devices/*/steer');
      }
      const why = await page.textContent('#dtControlWhy');
      assert.ok(!/queued/i.test(why), `another session was told its message was queued: ${why}`);
      assert.strictEqual(await page.inputValue('#dtInput'), 'queued for a watched terminal', 'the landing of a send from another session changed the box of this one');
      await openSession(a);
      assert.deepStrictEqual(rpcLog(a).filter((e) => e.text === 'queued for a watched terminal'), [], 'the held request reached the device, so the stand-in is not the only answer there was');
    });

    await check('composer: a refusal that arrives after the person moved on is shown in a dialog, keeps the pick on its session, and nothing is claimed', async () => {
      process.env.SQUAD_HUB_SELECTION_TIMEOUT_MS = '2500';
      dialogs.length = 0;
      try {
        await openSession(s);
        await selectorsOn();
        await choose('dtNtMode', 'Plan');
        await page.fill('#dtInput', 'doomed message');
        steerReplies.length = 0;
        steerBodies.length = 0;
        await page.click('#dtSend');
        await until(async () => (await page.textContent('#dtNtNote')).includes('Sending your message'), 'the change to be in flight');
        await openSession(a);
        await selectorsOn();
        await page.fill('#dtInput', 'keep typing here');
        await waitReplies(1, 'the unanswered change to give up');
      } finally {
        delete process.env.SQUAD_HUB_SELECTION_TIMEOUT_MS;
      }
      assert.strictEqual(steerReplies[0], 502, `an unconfirmed change answered ${steerReplies[0]}`);
      assert.strictEqual(await page.inputValue('#dtInput'), 'keep typing here');
      assert.strictEqual((await page.textContent('#dtControlLabel')).trim(), 'Synced', 'another session\'s failure changed this session\'s control state');
      assert.notStrictEqual(await page.getAttribute('#dtNtNote', 'data-kind'), 'error', 'another session\'s refusal showed here');
      assert.strictEqual(await page.$eval('#dtSend', (el) => el.disabled), false);
      await openSession(s);
      const note = await page.textContent('#dtNtNote');
      assert.notStrictEqual(await page.getAttribute('#dtNtNote', 'data-kind'), 'error', 'a refusal from a page that was left was written under the bar of the session opened since');
      assert.ok(!/may or may not|kept/i.test(note), `a refusal from a page that was left showed under the bar: ${note}`);
      assert.strictEqual(dialogs.length, 1, `the refusal was shown ${dialogs.length} times, not once: ${JSON.stringify(dialogs)}`);
      assert.match(dialogs[0], /may or may not have applied/i, `the unconfirmed change was not reported: ${dialogs[0]}`);
      assert.match(dialogs[0], /session you left/i, `the dialog did not say it came from a session left behind: ${dialogs[0]}`);
      assert.strictEqual(await selectedText('dtNtMode'), 'Plan', 'the pick was lost');
      assert.strictEqual(await page.$eval('#dtSend', (el) => el.disabled), false, 'Send was left held after the failure');
      assert.deepStrictEqual(rpcLog(s).filter((e) => e.text === 'doomed message'), [], 'the message ran although the change was never confirmed');
      assert.strictEqual(steerBodies.length, 1);
      assert.ok(!(await page.$('#dtTranscript .t-selection')), 'the transcript shows a change nobody confirmed');
    });

    await check('composer: Escape closes an open list first and only then leaves the session', async () => {
      await openSession(a);
      await selectorsOn();
      await pillOf('dtNtMode').click();
      assert.strictEqual(await pillOf('dtNtMode').getAttribute('aria-expanded'), 'true', 'the list did not open');
      await page.keyboard.press('Escape');
      assert.strictEqual(await pillOf('dtNtMode').getAttribute('aria-expanded'), 'false', 'Escape left the list open');
      assert.ok(await page.$('#detailScrim:not([hidden])'), 'Escape closed the whole session along with the list');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#detailScrim', { state: 'hidden', timeout: 5000 });
    });

    // ---- layout ------------------------------------------------------------
    await check('composer: the open list stays inside the window at 390px', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openSession(a);
      await until(async () => !(await page.$eval('#dtNtModel', (s) => s.disabled)), 'the selectors to enable');
      for (const id of ['dtNtMode', 'dtNtModel']) {
        await pillOf(id).click();
        const box = await pillOf(id).locator('.sp-list').boundingBox();
        assert.ok(box, `${id}'s list did not open`);
        const vp = page.viewportSize();
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width && box.y + box.height <= vp.height,
          `${id}'s list runs off the window: ${JSON.stringify(box)} in ${vp.width}x${vp.height}`);
        await page.keyboard.press('Escape');
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await check('composer: Mode, Model and Send share one vertical center line at 1280, 900 and 390px in dark and light', async () => {
      if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => {
          localStorage.setItem('squad-hub-theme', t);
          document.documentElement.setAttribute('data-theme', t);
        }, theme);
        await openSession(a);
        await until(async () => !(await page.$eval('#dtNtModel', (s) => s.disabled)), 'the selectors to enable');
        assert.strictEqual(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme,
          `the ${theme} theme did not apply`);
        for (const width of [1280, 900, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          const ids = ['dtNtMode', 'dtNtModeHint', 'dtNtModel', 'dtNtModelHint', 'dtSend'];
          const items = await page.evaluate((list) => list.map((id) => {
            const el = document.getElementById(id);
            const box = (id === 'dtNtMode' || id === 'dtNtModel') ? el.closest('.selectpill') : el;
            if (!box || box.offsetParent === null) return { id, center: null };
            const r = box.getBoundingClientRect();
            return { id, center: r.top + r.height / 2, height: r.height };
          }), ids);
          const missing = items.filter((i) => i.center === null).map((i) => i.id);
          assert.deepStrictEqual(missing, [], `at ${width}px (${theme}) these were not visible to compare: ${missing.join(', ')}`);
          const centers = items.map((i) => i.center);
          const spread = Math.max(...centers) - Math.min(...centers);
          assert.ok(spread <= 1,
            `at ${width}px (${theme}) the composer bar does not share a center line -- spread ${spread}px: ${JSON.stringify(items)}`);
          // One row, not two: a wrapped bar can pass a center-line check by luck.
          const tops = items.map((i) => i.center - (i.height || 0) / 2);
          assert.ok(Math.max(...tops) - Math.min(...tops) <= 17,
            `at ${width}px (${theme}) the composer bar wrapped onto a second row`);
          // A phone has room for the values, not for a word in front of each.
          const words = await page.$$eval('.nt-lab', (els) => els.map((e) => getComputedStyle(e).display));
          assert.strictEqual(words.length, 2, `expected a Mode and a Model word, found ${words.length}`);
          assert.ok(words.every((d) => (d === 'none') === (width <= 520)),
            `at ${width}px (${theme}) the words in front of the selectors are ${JSON.stringify(words)}`);
          const sendRight = await page.$eval('#dtSend', (el) => el.getBoundingClientRect().right);
          assert.ok(sendRight <= width, `at ${width}px (${theme}) Send runs off the right edge (${sendRight}px)`);
          if (SHOTS && (width === 1280 || width === 390)) {
            await page.screenshot({
              path: path.join(SHOTS, `composer-${theme}-${width === 1280 ? 'desktop' : 'phone'}.png`),
            });
          }
        }
        await page.setViewportSize({ width: 1280, height: 900 });
      }
      await page.evaluate(() => {
        localStorage.removeItem('squad-hub-theme');
        document.documentElement.removeAttribute('data-theme');
      });
    });

    await check('composer: no script, style or CSP violation and no console error across the whole flow', async () => {
      assert.deepStrictEqual(cspViolations, [], `CSP violations: ${JSON.stringify(cspViolations)}`);
      const broken = consoleErrors.filter((e) => !/favicon|Failed to load resource.*(409|422|502)/i.test(e));
      assert.deepStrictEqual(broken, [], `the page reported errors: ${broken.join(' | ')}`);
    });
  } finally {
    await browser.close().catch(() => {});
    for (const d of daemons) { try { d.shutdown && d.shutdown(); } catch { /* gone */ } }
    try { await svc.close(); } catch { /* gone */ }
  }

  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  console.log(`RESULT\tfail\tnext-turn browser end-to-end setup\t${String(e.message).split('\n')[0]}`);
  process.exit(1);
});
