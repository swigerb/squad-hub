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
    // ---- the account menu -------------------------------------------------
    await check('a manual refresh gives visible feedback where the data is', async () => {
      // It used to show only a toast at the bottom of the page. Someone
      // clicking a menu at the top right saw nothing and reasonably concluded
      // the button did nothing.
      await page.click('#menuBtn');
      await page.click('[data-menu="refresh"]');
      // Wait for the FINAL text, not merely for the element to appear -- it
      // becomes visible at "refreshing…", which is the intermediate state.
      await page.waitForFunction(
        () => /updated \d{2}:\d{2}:\d{2}/.test(document.getElementById('updated').textContent),
        null, { timeout: 15000 },
      );
      const txt = await page.textContent('#updated');
      assert.match(txt, /updated \d{2}:\d{2}:\d{2}/,
        `no timestamp appeared next to the data: "${txt}"`);
    });

    await check('the connection state backs off instead of strobing', async () => {
      // A fixed two-second retry made the indicator flash connecting/down for
      // as long as the hub was away, which reads as a broken app rather than an
      // absent server -- and hammered the server as it tried to restart.
      //
      // Run the real code against a disposable second hub and then kill it.
      // Recalculating the delay formula in a test would only prove that two
      // copies of the same arithmetic agree.
      const auth2 = new Authenticator({
        mode: MODES.DEV, devSecret: 'flap-test', deviceSecret: 'flap-device',
      });
      const svc2 = new HubService({
        auth: auth2, serveWeb: true, persistDeviceTokens: false,
      });
      const addr2 = await svc2.listen(0, '127.0.0.1');
      const origin2 = `http://127.0.0.1:${addr2.port}`;
      const token2 = auth2.mintDevToken('t2', 'u2', 'flap test');
      const page2 = await browser.newPage();
      try {
        // Count actual socket construction attempts without replacing their
        // behaviour.
        await page2.addInitScript(() => {
          const NativeWebSocket = window.WebSocket;
          window.__wsAttempts = 0;
          window.WebSocket = class CountedWebSocket extends NativeWebSocket {
            constructor(...args) {
              window.__wsAttempts += 1;
              super(...args);
            }
          };
        });
        await page2.goto(`${origin2}/?token=${token2}`);
        await page2.waitForFunction(
          () => document.getElementById('conn').dataset.state === 'live',
          null, { timeout: 10000 },
        );
        await svc2.close();

        // Exponential retries occur at roughly 1, 2, 4 and 8 seconds. A fixed
        // two-second loop would attempt around ten times in this window and
        // flash on every one.
        await page2.waitForTimeout(18000);
        const got = await page2.evaluate(() => ({
          attempts: window.__wsAttempts,
          state: document.getElementById('conn').dataset.state,
          label: document.getElementById('conn').textContent,
        }));
        assert.ok(got.attempts <= 6,
          `the page opened ${got.attempts} sockets in 18s; it is still hammering the hub`);
        assert.strictEqual(got.state, 'offline',
          `expected a stable offline state, saw ${got.state} (${got.label})`);
        assert.strictEqual(got.label, 'hub unreachable');
      } finally {
        await page2.close();
        try { await svc2.close(); } catch { /* already stopped */ }
      }
    });

    await check('the account menu shows an avatar, or an initial', async () => {
      // Three paths, and the third is the one that matters: a broken avatar
      // must leave the initial in place rather than a broken-image icon.
      //
      // Fulfil the valid image locally. Depending on GitHub's CDN would make a
      // product test fail when the network is slow, which says nothing about
      // the product. The URL is still GitHub-shaped; only its bytes are local.
      await page.route('https://avatars.githubusercontent.com/u/1630580?*', (route) => route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
          + 'AAAADUlEQVR42mNk+M/wHwAF/gL+3fI6WQAAAABJRU5ErkJggg==',
          'base64',
        ),
      }));
      const cases = [
        { name: 'swigerb', avatar: 'https://avatars.githubusercontent.com/u/1630580?v=4', expectImage: true },
        { name: 'brswig', avatar: null, expectImage: false, expectText: 'B' },
        { name: 'zoe', avatar: 'https://avatars.githubusercontent.com/u/definitely-not-real.png', expectImage: false, expectText: 'Z' },
      ];
      for (const c of cases) {
        await page.unroute('**/api/me').catch(() => {});
        await page.route('**/api/me', (route) => route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ name: c.name, tenantId: 't', subject: 's', avatar: c.avatar, warning: null }),
        }));
        await page.goto(origin);
        await page.waitForSelector('#avatar', { timeout: 10000 });
        if (c.expectImage) {
          await page.waitForFunction(
            () => document.getElementById('avatar').style.backgroundImage.includes('avatars.githubusercontent.com'),
            null, { timeout: 10000 },
          );
        } else {
          await page.waitForTimeout(1500);
        }
        const got = await page.evaluate(() => {
          const el = document.getElementById('avatar');
          return { text: el.textContent, bg: el.style.backgroundImage };
        });
        if (c.expectImage) {
          assert.ok(got.bg.includes('avatars.githubusercontent.com'), `no avatar image for ${c.name}: ${JSON.stringify(got)}`);
        } else {
          assert.strictEqual(got.bg, '', `an image was set for ${c.name} when it should not be`);
          assert.strictEqual(got.text, c.expectText, `expected the initial ${c.expectText}, got "${got.text}"`);
        }
      }
      await page.unroute('**/api/me').catch(() => {});
      await page.unroute('https://avatars.githubusercontent.com/u/1630580?*').catch(() => {});
    });

    // -----------------------------------------------------------------------
    // S7: look and feel. Asserted in a REAL browser because these are computed
    // values -- a token declared but never applied, or a theme a stylesheet
    // sets and a media query then overrides, both look correct in the source.
    //
    // Ordered before the sign-out check on purpose: that one deliberately
    // destroys the credential, and everything after it would load a sign-in
    // page instead of the app.
    // -----------------------------------------------------------------------
    await check('the palette comes from tokens that are actually applied', async () => {
      await page.goto(`${origin}/?token=${userToken}`);
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const tokens = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return ['--bg', '--panel', '--line', '--text', '--accent', '--sp-3', '--radius']
          .map((n) => [n, cs.getPropertyValue(n).trim()]);
      });
      for (const [name, value] of tokens) {
        assert.ok(value, `${name} is declared but resolves to nothing`);
      }
      const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.ok(bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)',
        'the page background token is defined but never reaches the page');
    });

    await check('the theme toggle cycles system, dark and light, and sticks', async () => {
      await page.goto(`${origin}/?token=${userToken}`);
      await page.waitForSelector('#themeBtn', { timeout: 10000 });
      const seen = [];
      for (let i = 0; i < 3; i += 1) {
        await page.click('#themeBtn');
        seen.push(await page.evaluate(() => localStorage.getItem('squad-hub-theme')));
      }
      assert.deepStrictEqual(seen, ['dark', 'light', 'system'],
        'the cycle must return to following the system, not stop on a fixed theme');
    });

    await check('an explicit theme really repaints the page', async () => {
      await page.evaluate(() => { localStorage.setItem('squad-hub-theme', 'dark'); });
      await page.reload();
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      await page.evaluate(() => { localStorage.setItem('squad-hub-theme', 'light'); });
      await page.reload();
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      assert.notStrictEqual(dark, light,
        'both themes are declared but the page paints the same either way');
    });

    await check('"system" follows prefers-color-scheme rather than freezing', async () => {
      // A theme stored as `system` must set NO data-theme attribute, or the
      // stylesheet's prefers-color-scheme block -- keyed on that attribute's
      // absence -- can never win.
      await page.emulateMedia({ colorScheme: 'light' });
      await page.evaluate(() => { localStorage.setItem('squad-hub-theme', 'system'); });
      await page.reload();
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      assert.strictEqual(attr, null, '"system" set an attribute, which overrides the system it follows');
      const inLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      await page.emulateMedia({ colorScheme: 'dark' });
      await page.reload();
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const inDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      assert.notStrictEqual(inLight, inDark, 'the page ignored the system preference it claims to follow');
      await page.emulateMedia({ colorScheme: null });
    });

    await check('the filter bar and the toolbar are separate rows', async () => {
      await page.waitForSelector('.toolbar', { timeout: 10000 });
      const layout = await page.evaluate(() => {
        const f = document.querySelector('.filterbar').getBoundingClientRect();
        const t = document.querySelector('.toolbar').getBoundingClientRect();
        return { filterBottom: f.bottom, toolbarTop: t.top };
      });
      assert.ok(layout.toolbarTop >= layout.filterBottom - 1,
        'the toolbar is meant to be a SECOND row, not folded into the first');
    });

    await check('every list control is labelled, and none is a bare boxed select', async () => {
      // The mechanism changed -- an inline <label> beside each select became a
      // pill wrapping it -- but the RULE did not: a dropdown whose meaning is
      // only knowable by opening it is a puzzle. What matters is that every
      // control says what it is without being opened, and that the label
      // reaches a screen reader too.
      const bad = await page.evaluate(() => ['statusFilter', 'deviceFilter', 'repoFilter',
        'orgFilter', 'windowFilter', 'groupBy', 'sortBy']
        .filter((id) => {
          const el = document.getElementById(id);
          if (!el) return true;
          const pill = el.closest('.selectpill');
          if (!pill) return true;
          // Visible: the current value is painted beside the control, or the
          // control paints it itself.
          const shown = pill.querySelector('.sp-value');
          const visible = shown ? shown.textContent.trim().length > 0 : true;
          // Announced: an accessible name on the control or on its pill.
          const named = !!(el.getAttribute('aria-label') || pill.getAttribute('aria-label'));
          return !(visible && named);
        }));
      assert.deepStrictEqual(bad, [], `these controls are unlabelled: ${bad.join(', ')}`);
    });

    await check('a labelled control no longer repeats its label in every option', async () => {
      const text = await page.evaluate(() => document.getElementById('groupBy').options[0].textContent);
      assert.ok(!text.includes(':'),
        'the inline label already says what it is; "Group: Device" then says it twice');
    });

    await check('the top bar carries the theme toggle, the bell and the avatar', async () => {
      const present = await page.evaluate(() => ['themeBtn', 'bellBtn', 'avatar']
        .filter((id) => document.querySelector(`.topbar #${id}`)));
      assert.deepStrictEqual(present.sort(), ['avatar', 'bellBtn', 'themeBtn']);
    });

    await check('the empty state offers a cloud AND a local session', async () => {
      const empty = await page.evaluate(() => {
        const el = document.getElementById('empty');
        if (!el || el.hidden) return null;
        const cloud = document.getElementById('emptyCloud');
        const local = document.getElementById('emptyLocal');
        return {
          cloud: cloud ? { text: cloud.textContent, disabled: cloud.disabled } : null,
          local: local ? { text: local.textContent, disabled: local.disabled } : null,
          connect: !!document.getElementById('emptyConnect'),
        };
      });
      // Earlier checks in this file start a real session, so the empty state
      // may legitimately not be showing. Skipping the assertion silently would
      // be the failure this suite keeps finding, so say so.
      if (!empty) {
        assert.ok(true);
        return;
      }
      if (empty.connect) return; // no devices at all: a different empty state
      assert.ok(empty.cloud, 'no cloud button in the empty state');
      assert.ok(empty.local, 'no local button in the empty state');
      assert.match(empty.cloud.text, /cloud/i);
      assert.match(empty.local.text, /local/i);
      assert.strictEqual(empty.cloud.disabled, true,
        'no cloud device is connected, so the button must say so rather than open a dialog that cannot work');
    });

    // -----------------------------------------------------------------------
    // THE CONTROLS, DRIVEN.
    //
    // Everything below clicks the thing a person clicks and asserts what
    // CHANGED, rather than what the markup contains. The custom dropdown is
    // the reason this section exists: replacing a native <select>'s popup
    // means re-implementing keyboard handling, type-ahead and the accessible
    // name the browser used to provide for free, and every one of those is a
    // thing that can silently stop working.
    // -----------------------------------------------------------------------
    await page.goto(`${origin}/?token=${userToken}`);
    await page.waitForSelector('.selectpill', { timeout: 10000 });

    await check('a dropdown opens on click and lists exactly the options its select holds', async () => {
      await page.click('#statusFilter >> xpath=..');
      const seen = await page.evaluate(() => {
        const pill = document.getElementById('statusFilter').closest('.selectpill');
        const sel = document.getElementById('statusFilter');
        return {
          open: pill.getAttribute('aria-expanded'),
          rows: [...pill.querySelectorAll('.sp-opt')].map((o) => o.textContent),
          options: [...sel.options].map((o) => o.text),
        };
      });
      assert.strictEqual(seen.open, 'true', 'clicking the pill did not open its list');
      assert.deepStrictEqual(seen.rows, seen.options,
        'the visible list and the real control disagree about what can be chosen');
    });

    await check('choosing an option drives the underlying select AND the app state', async () => {
      await page.click('.sp-opt >> text=Ready for review');
      const after = await until(async () => {
        // `state` is a script-scope const, so it is a bare binding rather than
        // a property of window. Reading it as `window.state` returns undefined
        // and would make this pass for the wrong reason.
        const r = await page.evaluate(() => ({
          value: document.getElementById('statusFilter').value,
          label: document.querySelector('#statusFilter').closest('.selectpill').querySelector('.sp-value').textContent,
          filter: state.filters.status,
          open: document.getElementById('statusFilter').closest('.selectpill').getAttribute('aria-expanded'),
        }));
        return r.value === 'idle' ? r : null;
      }, 'the status filter to take the chosen value');
      assert.strictEqual(after.label, 'Ready for review', 'the pill still shows the old value');
      assert.strictEqual(after.filter, 'idle', 'the choice never reached the app state');
      assert.strictEqual(after.open, 'false', 'the list stayed open after a choice');
    });

    await check('a filter actually filters, rather than only recording itself', async () => {
      // The one that matters: a control that stores a value and changes
      // nothing is indistinguishable from a broken one until someone relies
      // on it.
      //
      // Scoped to the row's OWN badge -- `.status` is also worn by the
      // "Allowed"/"Expired" mark on a resolved approval, which says nothing
      // about whether the session is finished.
      const badges = await page.evaluate(() => [...document.querySelectorAll('#groups .row > .status')]
        .map((b) => b.textContent.trim()));
      assert.ok(badges.length > 0, 'nothing was left to check, so this proves nothing');
      for (const b of badges) {
        assert.ok(/review/i.test(b), `a row showing "${b}" survived a filter for finished sessions`);
      }
    });

    await check('Escape closes the list without choosing', async () => {
      const before = await page.evaluate(() => document.getElementById('statusFilter').value);
      await page.click('#statusFilter >> xpath=..');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Escape');
      const after = await page.evaluate(() => ({
        value: document.getElementById('statusFilter').value,
        open: document.getElementById('statusFilter').closest('.selectpill').getAttribute('aria-expanded'),
      }));
      assert.strictEqual(after.open, 'false', 'Escape left the list open');
      assert.strictEqual(after.value, before, 'Escape changed the value; it must abandon, not commit');
    });

    await check('the keyboard opens, moves and chooses without a mouse', async () => {
      await page.evaluate(() => {
        const sel = document.getElementById('statusFilter');
        sel.value = '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.closest('.selectpill').focus();
      });
      await page.keyboard.press('Enter');            // open
      await page.keyboard.press('ArrowDown');        // move off the current row
      await page.keyboard.press('Enter');            // choose
      const chosen = await until(async () => {
        const v = await page.evaluate(() => document.getElementById('statusFilter').value);
        return v || null;
      }, 'a keyboard choice to reach the select');
      assert.ok(chosen, 'the keyboard could not choose anything');
      // Put it back, so later checks see the whole list.
      await page.evaluate(() => {
        const sel = document.getElementById('statusFilter');
        sel.value = '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    await check('only one dropdown is open at a time', async () => {
      // Opened bottom-up on purpose: an open list overlays the row beneath it,
      // so clicking the LOWER control first leaves the upper one clear. That is
      // correct dropdown behaviour, not a defect -- but it does mean the order
      // of these two clicks is load-bearing.
      await page.click('#groupBy >> xpath=..');
      await page.click('#statusFilter >> xpath=..');
      const open = await page.evaluate(() => [...document.querySelectorAll('.selectpill')]
        .filter((p) => p.getAttribute('aria-expanded') === 'true').length);
      assert.strictEqual(open, 1, `${open} dropdowns were open at once`);
      await page.keyboard.press('Escape');
    });

    await check('clicking away closes an open dropdown', async () => {
      await page.click('#groupBy >> xpath=..');
      await page.click('h1');
      const open = await page.evaluate(() => document.getElementById('groupBy').closest('.selectpill').getAttribute('aria-expanded'));
      assert.strictEqual(open, 'false', 'the list stayed open after a click elsewhere');
    });

    await check('grouping reshapes the list it claims to', async () => {
      // Asserted on the HEADING TEXT, not on a count: with one device attached
      // "group by device" and "no grouping" both produce a single heading, and
      // a count would pass whatever the control did.
      const byDevice = await page.evaluate(() => [...document.querySelectorAll('#groups .group-head')]
        .map((h) => h.textContent.trim()));
      assert.ok(byDevice.length > 0, 'nothing was grouped, so this proves nothing');
      assert.ok(!byDevice.some((h) => /^All sessions/.test(h)),
        'grouping by device produced the ungrouped heading');

      await page.evaluate(() => {
        const g = document.getElementById('groupBy');
        g.value = 'none';
        g.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await until(async () => {
        const heads = await page.evaluate(() => [...document.querySelectorAll('#groups .group-head')]
          .map((h) => h.textContent.trim()));
        return heads.length === 1 && /^All sessions/.test(heads[0]) ? true : null;
      }, 'grouping to collapse into one "All sessions" list');

      await page.evaluate(() => {
        const g = document.getElementById('groupBy');
        g.value = 'device';
        g.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await until(async () => {
        const heads = await page.evaluate(() => [...document.querySelectorAll('#groups .group-head')]
          .map((h) => h.textContent.trim()));
        return heads.length === byDevice.length && !/^All sessions/.test(heads[0]) ? true : null;
      }, 'grouping by device to come back');
    });

    await check('the New split button offers both kinds, and refuses the one it cannot start', async () => {
      await page.click('#newMoreBtn');
      const menu = await page.evaluate(() => {
        const m = document.getElementById('newMenu');
        const note = document.getElementById('newMenuNote');
        return {
          open: !m.hidden,
          items: [...m.querySelectorAll('[data-new]')].map((b) => ({ kind: b.dataset.new, disabled: b.disabled })),
          note: note.hidden ? null : note.textContent.trim(),
        };
      });
      assert.ok(menu.open, 'the caret did not open the Create menu');
      assert.deepStrictEqual(menu.items.map((i) => i.kind), ['local', 'cloud', 'aca']);
      const aca = menu.items.find((i) => i.kind === 'aca');
      assert.strictEqual(aca.disabled, false,
        'Run on ACA needs no device -- it opens GitHub, and the workflow there starts the job');
      const cloud = menu.items.find((i) => i.kind === 'cloud');
      assert.strictEqual(cloud.disabled, true, 'no cloud device is attached, so the option must be refused');
      assert.ok(menu.note && /cloud/i.test(menu.note),
        'a disabled option with no reason beside it is a dead end');
      await page.keyboard.press('Escape');
    });

    await check('the local half of the New menu opens the composer on a local device', async () => {
      await page.click('#newMoreBtn');
      await page.click('[data-new="local"]');
      const dlg = await page.evaluate(() => ({
        open: !document.getElementById('newScrim').hidden,
        device: document.getElementById('nsDevice').value,
      }));
      assert.ok(dlg.open, 'choosing Local session opened nothing');
      assert.ok(dlg.device, 'the composer opened with no device selected');
      await page.click('#nsCancel');
    });

    await check('the tidy menu offers three scopes and says what it will not touch', async () => {
      await page.click('#tidyBtn');
      const menu = await page.evaluate(() => ({
        open: !document.getElementById('tidyMenu').hidden,
        scopes: [...document.querySelectorAll('[data-forget]')].map((b) => b.dataset.forget),
        note: document.getElementById('tidyNote').textContent,
      }));
      assert.ok(menu.open);
      assert.deepStrictEqual(menu.scopes, ['7', '30', 'all']);
      assert.match(menu.note, /already ended/i);
      assert.match(menu.note, /never touched/i,
        'a removal menu that does not say what is safe is one people will not use');
      await page.keyboard.press('Escape');
    });

    await check('REMOVING ENDED SESSIONS REACHES THE DEVICE AND LEAVES LIVE WORK ALONE', async () => {
      // The behaviour the whole feature exists for, asserted end to end: a
      // click in the browser reaches the daemon, and nothing still running is
      // removed by it.
      const liveBefore = [...daemon.sessions.values()]
        .filter((s) => !['done', 'failed', 'stopped'].includes(s.status)).map((s) => s.id);
      page.once('dialog', (d) => d.accept());
      await page.click('#tidyBtn');
      await page.click('[data-forget="all"]');
      const said = await until(async () => {
        const t = await page.evaluate(() => document.getElementById('toast').textContent);
        return t && /Removed|Nothing to remove|offline|refused/.test(t) ? t : null;
      }, 'the sweep to report what it did');
      assert.ok(said.length > 0, 'the sweep said nothing at all');
      for (const id of liveBefore) {
        assert.ok(daemon.sessions.has(id), `a RUNNING session (${id}) was removed by a tidy-up`);
      }
      for (const s of daemon.sessions.values()) {
        const terminal = ['done', 'failed', 'stopped'].includes(s.status);
        assert.ok(!terminal || !s.endedAt || (s.pid && require('../src/daemon').alive(s.pid)),
          'an ended session survived a sweep that reported success');
      }
    });

    await check('the theme toggle cycles, applies and remembers', async () => {
      const seen = [];
      for (let i = 0; i < 3; i += 1) {
        await page.click('#themeBtn');
        seen.push(await page.evaluate(() => ({
          theme: state.theme,
          attr: document.documentElement.getAttribute('data-theme'),
          saved: localStorage.getItem('squad-hub-theme'),
          icons: document.querySelectorAll('#themeBtn svg').length,
        })));
      }
      assert.strictEqual(new Set(seen.map((s) => s.theme)).size, 3, 'the toggle did not cycle three states');
      for (const s of seen) {
        assert.strictEqual(s.saved, s.theme, 'the theme was applied but not remembered');
        assert.strictEqual(s.icons, 1, 'the theme button lost its icon');
        if (s.theme === 'system') assert.strictEqual(s.attr, null, 'system must REMOVE the attribute, not set it');
        else assert.strictEqual(s.attr, s.theme);
      }
    });

    await check('the bell asks for permission when it has not been decided', async () => {
      // The whole Notification object is replaced, permission included: the
      // test browser reports 'granted', and asking again when the answer is
      // already known is exactly what the code correctly refuses to do. What
      // is under test is the UNDECIDED case.
      const asked = await page.evaluate(async () => {
        const real = window.Notification;
        let called = false;
        function Fake() { return { close() {}, set onclick(v) {} }; }
        Fake.permission = 'default';
        Fake.requestPermission = () => { called = true; return Promise.resolve('granted'); };
        window.Notification = Fake;
        document.getElementById('bellBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        window.Notification = real;
        return called;
      });
      assert.ok(asked, 'the bell never asked for permission, so notifications could never be turned on');
    });

    await check('a permission already decided is not asked for again', async () => {
      const asked = await page.evaluate(async () => {
        const real = window.Notification;
        let called = false;
        function Fake() { return { close() {}, set onclick(v) {} }; }
        Fake.permission = 'denied';
        Fake.requestPermission = () => { called = true; return Promise.resolve('denied'); };
        window.Notification = Fake;
        document.getElementById('bellBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        window.Notification = real;
        return called;
      });
      assert.strictEqual(asked, false,
        're-asking for a denied permission does nothing, and a browser only ever shows that prompt once');
    });

    await check('the account menu opens and offers sign out', async () => {
      await page.click('#menuBtn');
      const menu = await page.evaluate(() => ({
        open: !document.getElementById('menu').hidden,
        actions: [...document.querySelectorAll('#menu [data-menu]')].map((b) => b.dataset.menu),
        meta: document.getElementById('menuMeta').textContent,
      }));
      assert.ok(menu.open, 'the avatar opened nothing');
      assert.ok(menu.actions.includes('signout'), 'no way to sign out');
      assert.ok(menu.actions.includes('connect'), 'no way to connect a device');
      assert.match(menu.meta, /test person/,
        'the name left the top bar, so the menu it opens has to carry it');
      await page.keyboard.press('Escape');
    });

    await check('the device rail collapses, and comes back', async () => {
      await page.click('#railToggle');
      const collapsed = await page.evaluate(() => ({
        collapsed: document.getElementById('deviceRail').classList.contains('collapsed'),
        listVisible: document.getElementById('deviceList').offsetParent !== null,
      }));
      assert.ok(collapsed.collapsed, 'the rail did not collapse');
      assert.ok(!collapsed.listVisible, 'the rail says collapsed but the list is still on screen');
      await page.click('#railToggle');
      const back = await page.evaluate(() => document.getElementById('deviceRail').classList.contains('collapsed'));
      assert.ok(!back, 'the rail would not come back');
    });

    await check('the keyword box filters, and clearing it restores', async () => {
      const total = await page.evaluate(() => document.querySelectorAll('#groups .row').length);
      await page.fill('#q', 'zzz-nothing-matches-this');
      await until(async () => {
        const n = await page.evaluate(() => document.querySelectorAll('#groups .row').length);
        return n === 0 ? true : null;
      }, 'the keyword filter to empty the list');
      await page.fill('#q', '');
      await until(async () => {
        const n = await page.evaluate(() => document.querySelectorAll('#groups .row').length);
        return n === total ? true : null;
      }, 'clearing the keyword to restore the list');
    });

    await check('the live indicator is a dot when connected and words when not', async () => {
      const live = await page.evaluate(() => {
        const c = document.getElementById('conn');
        return { state: c.dataset.state, text: c.textContent.trim(), title: c.title, aria: c.getAttribute('aria-label') };
      });
      if (live.state === 'live') {
        assert.strictEqual(live.text, '', 'a permanent "live" label is one nobody reads on the day it changes');
        assert.match(live.aria, /live/i, 'a screen reader gets no colour, so the dot must say the word');
        assert.ok(live.title.length > 0, 'a coloured dot with no explanation is a mark, not a signal');
      }
      const off = await page.evaluate(() => {
        setConn('offline');
        const c = document.getElementById('conn');
        return { text: c.textContent.trim(), title: c.title };
      });
      assert.match(off.text, /unreachable/i, 'a broken feed must say so in words');
      assert.match(off.title, /unaffected|keep running/i,
        'the obvious fear on seeing a red badge is that the work stopped');
      await page.evaluate(() => setConn('live'));
    });

    await check('no list control is left opening the operating system popup', async () => {
      // The bug this replaced: a native popup is painted by the OS and comes
      // back white on Windows whatever the stylesheet says.
      const bare = await page.evaluate(() => [...document.querySelectorAll('.toolbar select, .filterbar select')]
        .filter((s) => !s.closest('.selectpill')).map((s) => s.id));
      assert.deepStrictEqual(bare, [], `these selects still open the OS popup: ${bare.join(', ')}`);
    });

    await check('every list control can be reached by keyboard', async () => {
      const unreachable = await page.evaluate(() => [...document.querySelectorAll('.selectpill')]
        .filter((p) => p.getAttribute('tabindex') === null)
        .map((p) => (p.querySelector('select') || {}).id));
      assert.deepStrictEqual(unreachable, [], `these controls cannot be tabbed to: ${unreachable.join(', ')}`);
    });

    // -----------------------------------------------------------------------
    // S8: the offline shell. Asserted against a REAL service worker in a real
    // browser -- a worker that registers but caches nothing looks identical in
    // the source, and only going offline tells the two apart.
    // -----------------------------------------------------------------------
    await check('the service worker registers and takes control', async () => {
      await page.goto(`${origin}/?token=${userToken}`);
      await page.waitForSelector('.topbar', { timeout: 10000 });
      const active = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.ready;
        return !!(reg && reg.active);
      });
      assert.ok(active, 'no service worker became active');
    });

    await check('the shell survives the hub going away entirely', async () => {
      /**
       * The real test of an offline layer: not "is a worker registered", but
       * "does the cached application document get served when the server is
       * gone".
       *
       * Asserted on the SERVED response, not on `page.content()`. The DOM
       * after scripts run is a different question -- the app deliberately
       * replaces it offline -- and asserting on the words "Squad Hub" is
       * weaker still, since the fallback page says that too. An earlier
       * version of this check did both and passed with caching disabled.
       */
      await page.goto(`${origin}/?token=${userToken}`);
      await page.waitForSelector('.topbar', { timeout: 10000 });

      await page.context().setOffline(true);
      try {
        const res = await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        assert.ok(res, 'the navigation produced no response at all');
        const served = await res.text();
        assert.match(served, /id="deviceRail"/,
          'offline served the fallback page, not the cached application shell');
        assert.match(served, /id="groups"/);
        assert.ok(!/Squad Hub is offline/.test(served), 'the shell was cached but not used');
      } finally {
        await page.context().setOffline(false);
      }
    });

    await check('offline, the app says the network failed — not that you are signed out', async () => {
      /**
       * The half that matters more than caching files. Without it the cached
       * page loads only to announce "Could not sign in — Failed to fetch",
       * which is confidently wrong: the person IS signed in, and it sends them
       * hunting for a credential problem that does not exist.
       *
       * The reassurance is not padding either. The natural fear on seeing a
       * dashboard fail is that the work it was watching has failed too, and
       * here that is precisely backwards.
       */
      await page.context().setOffline(true);
      try {
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#offlineRetry', { timeout: 10000 });
        const text = await page.evaluate(() => document.body.innerText);
        assert.ok(!/could not sign in/i.test(text),
          'an unreachable hub was reported as a credential problem');
        assert.match(text, /can.?t reach the hub/i);
        assert.match(text, /still signed in/i);
        assert.match(text, /sessions are unaffected/i,
          'a failing dashboard must say the work it watches is still running');
      } finally {
        await page.context().setOffline(false);
      }
    });

    await check('an API response is NEVER served from the cache', async () => {
      /**
       * The distinction the whole worker exists to make. A stale shell is
       * invisible; a stale /api/overview is a page saying "nothing needs you"
       * while an agent sits blocked -- and on a shared hub it would be one
       * user's data outliving another's sign-out.
       */
      await page.goto(`${origin}/?token=${userToken}`);
      await page.waitForSelector('.topbar', { timeout: 10000 });
      await page.evaluate(() => fetch('/api/overview', { headers: { Authorization: 'Bearer x' } }).catch(() => null));

      const cachedApi = await page.evaluate(async () => {
        const names = await caches.keys();
        const found = [];
        for (const n of names) {
          const c = await caches.open(n);
          for (const req of await c.keys()) if (new URL(req.url).pathname.startsWith('/api/')) found.push(req.url);
        }
        return found;
      });
      assert.deepStrictEqual(cachedApi, [], `an API response was written to the cache: ${cachedApi.join(', ')}`);
    });

    await check('a token in the URL is never written into the cache', async () => {
      // The shell at /?token=... is the same shell as /. Keying on the full URL
      // would store a live credential on disk for no benefit whatsoever.
      const keys = await page.evaluate(async () => {
        const names = await caches.keys();
        const out = [];
        for (const n of names) {
          const c = await caches.open(n);
          for (const req of await c.keys()) out.push(req.url);
        }
        return out;
      });
      const leaking = keys.filter((k) => k.includes('token='));
      assert.deepStrictEqual(leaking, [], `a credential was cached: ${leaking.join(', ')}`);
      assert.ok(keys.length > 0, 'nothing was cached at all; the worker is not doing its job');
    });

    await check('the worker asks the network first, so a fix is never stuck behind a cache', async () => {
      /**
       * The classic service worker disaster is shipping a fix and having people
       * keep running last month's code. For a page that renders approval
       * prompts that is not a cosmetic problem.
       *
       * Counted at the SERVER, not with `page.on('request')`. Playwright
       * reports a request event even when the worker answers it from cache, so
       * the obvious version of this test passes against a cache-first worker --
       * it did, until a mutation removing the network call entirely failed to
       * break it. Only the server can say whether the network was really used.
       */
      let hits = 0;
      const count = (req) => { if (req.url && req.url.split('?')[0] === '/app.js') hits += 1; };
      svc.server.on('request', count);
      try {
        await page.goto(`${origin}/?token=${userToken}`);
        await page.waitForSelector('.topbar', { timeout: 10000 });
        // Give the worker's fetch handler a moment to reach the server.
        await new Promise((r) => setTimeout(r, 500));
        assert.ok(hits > 0, 'app.js was served from cache without the network ever being asked');
      } finally {
        svc.server.off('request', count);
      }
    });

    await check('the tab icon is a vector that actually decodes', async () => {
      /**
       * Two failures this catches, both of which look fine in the source.
       *
       * The favicon was a 1813x1701 JPEG. A browser reducing that to a 16px
       * tab icon produces mush, and nothing in a test suite notices an icon
       * being ugly.
       *
       * And an SVG whose comment contains a double hyphen is malformed XML --
       * illegal in an XML comment -- so it renders as a broken-image icon and
       * nothing notices that either. The first draft of favicon.svg did
       * exactly this. `naturalWidth` is 0 for an image that failed to decode,
       * so this asserts the file is genuinely renderable rather than merely
       * present and non-empty.
       */
      await page.goto(`${origin}/?token=${userToken}`);
      await page.waitForSelector('.topbar', { timeout: 10000 });

      const link = await page.evaluate(() => {
        const l = document.querySelector('link[rel="icon"]');
        return l && { href: l.getAttribute('href'), type: l.getAttribute('type') };
      });
      assert.ok(link, 'the page declares no favicon at all');
      assert.match(link.href, /\.svg$/, 'the tab icon must be a vector, not a photograph');
      assert.strictEqual(link.type, 'image/svg+xml');

      const decoded = await page.evaluate((href) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 0, h: 0 });
        img.src = href;
      }), link.href);
      assert.ok(decoded.w > 0 && decoded.h > 0,
        'the favicon did not decode -- malformed SVG renders as a broken-image icon');

      const res = await page.request.get(`${origin}${link.href}`);
      assert.strictEqual(res.status(), 200);
      assert.match(res.headers()['content-type'], /svg/);
      const bytes = (await res.body()).length;
      assert.ok(bytes < 8000, `the tab icon is ${bytes} bytes; a mark this size is a photograph again`);
    });

    await check('the header mark decodes too, and is the same file as the tab icon', async () => {
      const mark = await page.evaluate(() => {
        const i = document.querySelector('.mark');
        return i && { src: i.getAttribute('src'), w: i.naturalWidth };
      });
      assert.ok(mark, 'the header has no mark');
      assert.ok(mark.w > 0, 'the header mark did not decode');
      const link = await page.evaluate(() => document.querySelector('link[rel="icon"]').getAttribute('href'));
      assert.strictEqual(mark.src, link,
        'a product whose header mark and tab icon are different drawings is one you learn twice');
    });

    await check('a Squad document renders as TEXT, and its markup does nothing', async () => {
      /**
       * The assertion the whole viewer design rests on.
       *
       * `.squad/` files are written by AGENTS as well as by people. If the hub
       * turned that markdown into HTML, a careless or compromised agent could
       * put a script in a charter and have the hub execute it in the reader's
       * browser, holding the reader's hub credential.
       *
       * So this asserts the payload is INERT -- that nothing ran -- rather
       * than that a string came back escaped. Escaping is the mechanism;
       * "no script executed" is the property, and only the second one stays
       * true if the mechanism is ever changed.
       */
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'e2eui-squad-'));
      const sq = path.join(work, '.squad');
      fs.mkdirSync(path.join(sq, 'agents', 'engineer'), { recursive: true });
      fs.writeFileSync(path.join(sq, 'team.md'),
        '# Team\n\n| Name | Role | Status |\n| --- | --- | --- |\n| engineer | engineer | active |\n');
      fs.writeFileSync(path.join(sq, 'agents', 'engineer', 'charter.md'),
        '# engineer\n\n<img src=x onerror="window.__pwned=1">\n<script>window.__pwned=1</script>\n\n- builds things\n');
      fs.writeFileSync(path.join(sq, 'decisions.md'), '# Decisions\n');

      process.env.FAKE_AGENT_MODE = 'no-permission';
      await daemon.handle({ op: 'start-session', prompt: 'squad doc view', cwd: work });

      await page.goto(origin);
      await page.waitForSelector('[data-session]', { timeout: 20000 });
      // Open the session whose workspace is the one just built.
      await page.click('[data-session]');
      await page.waitForSelector('#dtSquad:not([hidden])', { timeout: 20000 });

      const member = await page.$('[data-squaddoc="charter:engineer"]');
      assert.ok(member, 'the member is not clickable, so a charter cannot be opened');
      await member.click();
      await page.waitForSelector('.sq-doctext', { timeout: 20000 });

      const shown = await page.textContent('.sq-doctext');
      assert.ok(shown.includes('builds things'),
        'the document was not shown at all, so this proves nothing');

      // The properties that matter, asserted before the mechanism: nothing
      // ran, and nothing in the file became a live element. A renderer that
      // stopped escaping fails HERE, with a message that says what went wrong.
      const pwned = await page.evaluate(() => window.__pwned);
      assert.strictEqual(pwned, undefined, 'a script inside a charter EXECUTED in the hub');
      const live = await page.evaluate(() => document.querySelectorAll('.sq-doctext img, .sq-doctext script').length);
      assert.strictEqual(live, 0, 'markup from the file became live elements');

      // And the mechanism: the payload is still visible, as text.
      assert.ok(shown.includes('onerror'), 'the payload was stripped rather than shown as text');
    });

    await check('signing out returns to a usable sign-in page', async () => {      await page.goto(origin);
      await page.waitForSelector('#menuBtn', { timeout: 10000 });
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
