#!/usr/bin/env node
'use strict';
/**
 * The hub, driven the way a person drives it.
 *
 * Every other suite talks to the API or the daemon directly. That leaves the
 * web app -- the part everyone actually touches -- covered by nothing, and it
 * is where the last few defects lived: a "+ New" button that opened a dialog
 * with an empty dropdown and failed on submit, a menu entry that handed out the
 * signed-in user's own credential as a device credential, and a script served
 * as application/octet-stream that no browser would execute.
 *
 * So this drives a REAL browser against a REAL hub with a REAL daemon attached,
 * and asserts SIDE EFFECTS rather than appearances: a session that actually
 * exists on the device, a tool that actually ran.
 *
 * PLAYWRIGHT IS OPTIONAL. Squad Hub has no dependencies and that is worth
 * keeping, so this skips when Playwright is absent -- loudly, with exit 0 and a
 * clear line saying nothing was checked. A skip that reads like a pass is the
 * failure this project keeps finding, so it must not read like one.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* optional */ }

if (!chromium) {
  console.log('  SKIPPED  browser end-to-end: playwright is not installed');
  console.log('           npm i -D playwright && npx playwright install chromium');
  console.log('RESULT\tskip\tbrowser end-to-end (playwright not installed)');
  console.log('\n0 passed, 0 failed, 1 skipped');
  process.exit(0);
}

const { Authenticator, MODES } = require('../src/service/auth');
const { HubService } = require('../src/service/hub-service');
const { Daemon } = require('../src/daemon');
const config = require('../src/config');

const FAKE = path.join(__dirname, 'fake-agent.js');

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

/** Wait for a condition, or explain what it still was when time ran out. */
async function until(fn, what, budgetMs = 15000) {
  const deadline = Date.now() + budgetMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

(async () => {
  console.log('browser end-to-end');
  console.log('='.repeat(60));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eui-'));
  process.env.SQUAD_HUB_HOME = home;
  config.update({ allowFiles: true, allowFilesAll: true, filesRoot: null });

  const auth = new Authenticator({ mode: MODES.DEV, devSecret: 'e2e-ui', deviceSecret: 'e2e-dev' });
  const svc = new HubService({ auth, serveWeb: true });
  const addr = await svc.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${addr.port}`;
  const userToken = auth.mintDevToken('t1', 'u1', 'test person');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  let daemon = null;
  try {
    // ---- signing in ------------------------------------------------------
    await check('the app loads and signs in with a token in the URL', async () => {
      await page.goto(`${origin}/?token=${userToken}`);
      await page.waitForSelector('#who', { timeout: 15000 });
      assert.strictEqual(await page.textContent('#who'), 'test person');
    });

    await check('no script or stylesheet failed to load', async () => {
      // A missing MIME type returns 200 and renders nothing, so "the page
      // loaded" is not the same as "the page works".
      const broken = consoleErrors.filter((e) => !/favicon/i.test(e));
      assert.deepStrictEqual(broken, [], `the page reported errors: ${broken.join(' | ')}`);
    });

    // ---- no devices ------------------------------------------------------
    await check('with no device, the page says what to do instead of failing', async () => {
      await page.waitForSelector('#empty:not([hidden])', { timeout: 10000 });
      const txt = await page.textContent('#empty');
      assert.match(txt, /No devices connected/i, `the empty state said: ${txt.trim().slice(0, 80)}`);
      assert.ok(await page.$('#emptyConnect'), 'no way to get from "no devices" to connecting one');
    });

    await check('+ New with no device opens the connect dialog, not a broken form', async () => {
      // The defect: it used to open the new-session dialog with an EMPTY device
      // dropdown, so a prompt could be typed and submitted and would fail.
      await page.click('#newBtn');
      await page.waitForSelector('#connectScrim:not([hidden])', { timeout: 5000 });
      const visible = await page.isVisible('#newScrim');
      assert.strictEqual(visible, false, 'the new-session form opened with no device to run on');
      await page.click('#cnCancel');
    });

    // ---- minting a device token through the UI ---------------------------
    let deviceToken = null;
    await check('the UI mints a DEVICE token, not the user credential', async () => {
      // The defect: the menu used to copy a command containing the signed-in
      // user's own token, so following the built-in instructions produced a
      // credential on a server that could also drive every other device.
      await page.click('#menuBtn');
      await page.click('[data-menu="connect"]');
      await page.fill('#cnLabel', 'e2e device');
      await page.click('#cnCreate');
      await page.waitForSelector('#cnResult:not([hidden])', { timeout: 10000 });
      const cmd = await page.textContent('#cnCmd');
      deviceToken = cmd.split('--token ')[1].trim();
      assert.ok(deviceToken.startsWith('sqhd1.'), `not a device token: ${deviceToken.slice(0, 12)}`);
      assert.strictEqual(deviceToken === userToken, false, 'the UI handed out the user credential');
      await page.click('#cnCancel');
    });

    await check('that token really is limited to being a device', async () => {
      const r = await page.evaluate(async (t) => {
        const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${t}` } });
        return res.status;
      }, deviceToken);
      assert.strictEqual(r, 403, `a UI-minted device token could read the API (${r})`);
    });

    // ---- a real device attaches ------------------------------------------
    await check('a device attaches with the minted token and appears in the UI', async () => {
      daemon = new Daemon();
      daemon.agentCommand = process.execPath;
      daemon.agentArgs = [FAKE];
      daemon.deviceName = 'E2E Device';
      await daemon.listen();
      await daemon.attachHub({
        url: `${origin.replace('http', 'ws')}/ws`, token: deviceToken, deviceId: 'e2e-device',
      });
      await until(async () => (await page.textContent('#deviceList')).includes('E2E Device'),
        'the device to appear in the UI');
    });

    // ---- starting a session from the browser ------------------------------
    await check('a session started from the browser really runs on the device', async () => {
      process.env.FAKE_AGENT_MODE = 'no-permission';
      await page.click('#newBtn');
      await page.waitForSelector('#newScrim:not([hidden])', { timeout: 5000 });
      await page.fill('#nsPrompt', 'end to end from the browser');
      await page.click('#nsStart');

      // The side effect: the DEVICE has the session, not merely the page.
      const st = await until(async () => {
        const s = await daemon.handle({ op: 'status' });
        return (s.sessions || []).length ? s : null;
      }, 'the daemon to report a session');
      assert.ok(st.sessions[0].id, 'no session reached the device');
    });

    await check('the running session is visible in the UI', async () => {
      await until(async () => (await page.textContent('#groups')).includes('end to end from the browser'),
        'the session to render');
    });

    // ---- an approval, answered from the browser ---------------------------
    await check('approving in the browser ACTUALLY runs the tool', async () => {
      // The assertion that matters, and the most end-to-end one here: the
      // approval card the app raises by itself, answered by clicking the button
      // a person would click, checked by the file the agent writes.
      //
      // A hub reporting "approved" while nothing runs is the failure worth
      // catching, so this asserts the SIDE EFFECT and not the reply.
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eui-work-'));
      process.env.FAKE_AGENT_MODE = 'approve-gate';
      process.env.FAKE_AGENT_MARKER = 'marker.txt';
      await daemon.handle({ op: 'start-session', prompt: 'needs approval', cwd: work });

      // The app raises the card on its own; that behaviour is part of what is
      // being tested.
      await page.waitForSelector('#approvalScrim:not([hidden])', { timeout: 20000 });

      const cmd = await page.textContent('#apCommand');
      assert.ok(cmd && cmd.trim().length, 'the card did not show what would run');

      const allow = await page.$('#apActions button:has-text("Allow once")')
        || await page.$('#apActions button');
      assert.ok(allow, 'the approval card offered no way to allow');
      await allow.click();

      await until(() => fs.existsSync(path.join(work, 'marker.txt')),
        'the approved tool to actually run');
    });

    await check('the approval card closes once it is answered', async () => {
      // A card that stays up after being answered would be clicked twice.
      await until(async () => !(await page.isVisible('#approvalScrim')),
        'the approval card to close');
    });

    // ---- signing out ------------------------------------------------------
    await check('signing out returns to a usable sign-in page', async () => {
      await page.click('#menuBtn');
      await page.click('[data-menu="signout"]');
      await page.waitForSelector('.signin', { timeout: 10000 });
      const stored = await page.evaluate(() => localStorage.getItem('squad-hub-token'));
      assert.strictEqual(stored, null, 'the credential survived signing out');
    });
  } finally {
    try { await browser.close(); } catch { /* closing */ }
    try { if (daemon) await daemon.close?.(); } catch { /* closing */ }
    try { await svc.close(); } catch { /* closing */ }
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`ERROR: ${e.message}`); console.log(e.stack); process.exit(1); });
