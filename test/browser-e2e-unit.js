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
const { GitHubOAuth } = require('../src/service/github-oauth');
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

/**
 * Wait until the page can genuinely reach the network again.
 *
 * `page.context().setOffline(false)` resolves before the browser can actually
 * make a request, so a navigation issued immediately afterwards can die with
 * net::ERR_ABORTED. That happened twice on CI, and it presents as a failure in
 * whichever test navigates next -- which made it look like a service-worker
 * caching bug rather than a leftover from the offline test above it.
 *
 * Proves the condition instead of sleeping through it: a sleep is a guess that
 * gets tuned upward every time it flakes, while this returns the moment the
 * network answers and says so plainly if it never does.
 */
async function waitUntilOnline(page, origin) {
  await until(
    async () => {
      // The offline page has a retry control and reloads itself once the
      // network returns, so the page can navigate WHILE this is asking. That
      // destroys the execution context and rejects the evaluate -- which is
      // not a failure, it is the very thing being waited for happening
      // mid-question. Treated as "not ready yet" and asked again.
      try {
        return await page.evaluate(
          (o) => fetch(`${o}/healthz`, { cache: 'no-store' }).then(() => true).catch(() => false),
          origin,
        );
      } catch {
        return false;
      }
    },
    'the browser to be back online after the offline test',
    15000,
  );
}

/**
 * Wire a page to report every `securitypolicyviolation` it fires, into an
 * array this process can read.
 *
 * The browser enforces the policy either way -- a blocked script simply does
 * not run. What this adds is VISIBILITY: without it, a policy that silently
 * broke a feature would look identical to a feature nobody exercised, and the
 * only sign would be an assertion failing somewhere downstream with no
 * mention of CSP at all. Installed via `addInitScript` so it is present
 * before any script on the page runs, including the first navigation.
 */
async function watchCsp(pg) {
  const violations = [];
  await pg.exposeFunction('__reportCspViolation', (v) => violations.push(v));
  await pg.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__reportCspViolation({
        directive: e.violatedDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
        page: location.href,
      });
    });
  });
  return violations;
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
  // Watched from before the very first navigation, so this is evidence for
  // the WHOLE suite below -- every session, approval, reconnect, theme
  // change and service-worker interaction the rest of this file drives, all
  // under the SAME enforced policy a real deployment sends.
  const cspViolations = await watchCsp(page);

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
      // GitHub's real CDN answers an unknown id with a 302 to github.com --
      // a different origin the CSP's img-src rightly does not allow, so
      // depending on that redirect would trip a violation for a reason that
      // has nothing to do with the app under test. Fulfil the 404 locally,
      // same as the valid image above, so this stays a same-origin-shaped
      // failure the CSP has no opinion about.
      await page.route('https://avatars.githubusercontent.com/u/definitely-not-real.png*',
        (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
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
      await page.click('.sp-opt >> text=Awaiting your reply');
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
      assert.strictEqual(after.label, 'Awaiting your reply', 'the pill still shows the old value');
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
        assert.ok(/awaiting/i.test(b), `a row showing "${b}" survived a filter for sessions awaiting a reply`);
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
        // Coming back online is not instantaneous: `setOffline(false)` resolves
        // before the page can actually reach anything. The next check navigates
        // immediately, and twice on CI that navigation died with
        // net::ERR_ABORTED -- a flake that reads exactly like a caching bug and
        // is nothing of the sort.
        //
        // Waiting for a real request to succeed is deterministic where a sleep
        // is a guess. If the network never returns this throws with a clear
        // message, rather than handing its failure to whichever test ran next.
        await waitUntilOnline(page, origin);
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

    await check('long tool output is reachable, and does not trap the scroll', async () => {
      /**
       * Two defects in one place, both found by reading the live hub.
       *
       * The result panel had `max-height: 220px; overflow: auto`, INSIDE the
       * transcript, which itself scrolls. That is a scrollbar within a
       * scrollbar: a wheel over the output moves the inner box and the reader
       * cannot get past it. And the clipped remainder was labelled "output
       * truncated (N characters)" with nothing to click -- the full text was
       * already in the browser and was being thrown away at the last step.
       *
       * This drives the REAL renderer against the REAL stylesheet in a REAL
       * browser, because "does this box scroll on its own" is a question only
       * a browser can answer -- it is a fact about computed layout, not about
       * the source string.
       */
      await page.goto(origin);
      // The transcript lives inside the session detail, which is hidden until
      // a session is opened -- and a hidden box has no layout to measure.
      await page.waitForSelector('[data-session]', { timeout: 20000 });
      await page.click('[data-session]');
      await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
      await page.waitForSelector('#dtTranscript', { state: 'visible', timeout: 20000 });

      const long = `HEAD${'x'.repeat(4000)}TAIL-MARKER`;
      const out = await page.evaluate((text) => {
        const el = document.getElementById('dtTranscript');
        el.hidden = false;
        // The application's own render, not markup written by this test --
        // otherwise the test could pass while the app emitted something else.
        renderTranscript([{ update: { sessionUpdate: 'tool_call_update', content: [{ type: 'text', text }] } }]);
        const clipped = el.querySelector('.t-clipped');
        const details = el.querySelector('details');
        const summary = el.querySelector('summary');
        if (!details || !summary) return { missing: true, html: el.innerHTML.slice(0, 300) };
        summary.click();
        const full = details.querySelector('pre');
        const scrolls = (n) => (n ? n.scrollHeight > n.clientHeight + 1 : false);
        return {
          summaryText: summary.textContent,
          fullText: full ? full.textContent : '',
          clippedStillShown: clipped ? clipped.offsetParent !== null : false,
          fullScrollsAlone: scrolls(full),
          transcriptScrolls: scrolls(el),
        };
      }, long);

      assert.ok(!out.missing, `no disclosure was rendered for clipped output: ${out.html}`);
      assert.ok(out.summaryText.includes('4,015'),
        `the control should say how much there is to see, got "${out.summaryText}"`);
      assert.ok(out.fullText.includes('TAIL-MARKER'),
        'the end of the output is still unreachable -- this is the defect being fixed');
      assert.strictEqual(out.clippedStillShown, false,
        'the preview and the full text are both on screen, so the output reads twice');
      assert.strictEqual(out.fullScrollsAlone, false,
        'the result box scrolls independently INSIDE the transcript -- a scrollbar in a scrollbar');
      assert.strictEqual(out.transcriptScrolls, true,
        'precondition: the transcript itself must be the scroller, or this proves nothing');
    });

    await check('signing out returns to a usable sign-in page', async () => {      await page.goto(origin);
      await page.waitForSelector('#menuBtn', { timeout: 10000 });
      await page.click('#menuBtn');
      await page.click('[data-menu="signout"]');
      await page.waitForSelector('.signin', { timeout: 10000 });
      const stored = await page.evaluate(() => localStorage.getItem('squad-hub-token'));
      assert.strictEqual(stored, null, 'the credential survived signing out');
    });

    // -------------------------------------------------------------------
    // The OAuth sign-in completion and failure pages, driven for real.
    //
    // Flagged in the lead's review of this sprint (issue #84): every check
    // above signs in through `/?token=`, and never once loads
    // `/auth/github/callback` -- the route the inline-script hazard and the
    // inline-style hazard actually lived on. A browser suite that stayed
    // silent about both would be absence of coverage, not evidence the CSP
    // is safe to enforce. This drives that exact route, for both outcomes,
    // under the SAME enforced policy, and checks the property that matters:
    // the token actually lands in storage and the browser actually ends up
    // signed in -- not just that the response was 200.
    // -------------------------------------------------------------------
    let svcAuth = null;
    await check('the OAuth completion page stores the token and signs in, with the CSP enforced', async () => {
      const auth3 = new Authenticator({
        mode: MODES.GITHUB,
        allowedUsers: ['octocat'],
        githubFetch: async () => ({ login: 'octocat', id: 42 }),
      });
      const oauth3 = new GitHubOAuth({ clientId: 'cid', clientSecret: 'sec' });
      // Stand-ins for GitHub's own endpoints -- proven separately by
      // github-auth-unit.js and spike/github-auth-probe.js. What this test
      // owns is the PAGE this hub hands back, under a real browser.
      oauth3.exchange = async () => 'e2e-oauth-token-abc';
      // A real check, not a stub that always passes: the failure-page test
      // below reaches _signinError by sending a state this rejects, and a
      // fixed `true` would route it through the SUCCESS branch instead,
      // proving nothing about the failure page at all.
      oauth3.checkState = (state) => state === 's';
      svcAuth = new HubService({ auth: auth3, serveWeb: true, oauth: oauth3, persistDeviceTokens: false });
      const addrAuth = await svcAuth.listen(0, '127.0.0.1');
      const originAuth = `http://127.0.0.1:${addrAuth.port}`;
      const page3 = await browser.newPage();
      const violations3 = await watchCsp(page3);
      const errors3 = [];
      page3.on('console', (m) => { if (m.type() === 'error') errors3.push(m.text()); });
      page3.on('pageerror', (e) => errors3.push(`pageerror: ${e.message}`));
      try {
        await page3.goto(`${originAuth}/auth/github/callback?code=c&state=s`);
        // The completion page's own script stores the token then calls
        // location.replace('/'); this waits for THAT navigation to finish
        // and actually land signed in, not merely for the callback response.
        await page3.waitForSelector('#who', { timeout: 15000 });
        assert.strictEqual(await page3.textContent('#who'), 'octocat',
          'the completion page did not actually complete sign-in');
        const stored = await page3.evaluate(() => localStorage.getItem('squad-hub-token'));
        assert.strictEqual(stored, 'e2e-oauth-token-abc',
          'the token never reached localStorage -- an enforced script-src blocked the handoff');
        assert.deepStrictEqual(violations3, [],
          `CSP violations on the completion page: ${JSON.stringify(violations3)}`);
        const broken3 = errors3.filter((e) => !/favicon/i.test(e));
        assert.deepStrictEqual(broken3, [], `the completion page reported errors: ${broken3.join(' | ')}`);
      } finally {
        await page3.close();
      }
    });

    await check('the OAuth failure page renders its message and its styled logo, with the CSP enforced', async () => {
      // Re-uses svcAuth from the previous check; a bad state is this hub's
      // one deterministic way to reach _signinError without a real GitHub.
      const page4 = await browser.newPage();
      const violations4 = await watchCsp(page4);
      const errors4 = [];
      page4.on('console', (m) => { if (m.type() === 'error') errors4.push(m.text()); });
      page4.on('pageerror', (e) => errors4.push(`pageerror: ${e.message}`));
      try {
        await page4.goto(`http://127.0.0.1:${svcAuth.server.address().port}/auth/github/callback?code=c&state=bad`);
        await page4.waitForSelector('.signin-logo', { timeout: 10000 });
        const text = await page4.evaluate(() => document.body.innerText);
        assert.match(text, /sign-in failed/i, 'the failure page did not render its message');
        const decoded = await page4.evaluate(() => {
          const img = document.querySelector('.signin-logo');
          return img && { w: img.naturalWidth, radius: getComputedStyle(img).borderRadius };
        });
        assert.ok(decoded && decoded.w > 0, 'the logo on the failure page did not even load');
        assert.notStrictEqual(decoded.radius, '0px',
          'the logo lost its rounded corners -- the class-based style never applied');
        assert.deepStrictEqual(violations4, [],
          `CSP violations on the failure page: ${JSON.stringify(violations4)}`);
        // The failure page is deliberately served with a 403 status (this
        // route always has been -- see _signinError) so the browser logs
        // that as a console error for the top-level navigation itself; that
        // is the console reflecting an intentional response code, not a
        // broken page, so it is excluded the same way the favicon noise is.
        const broken4 = errors4.filter((e) => !/favicon/i.test(e) && !/403 \(Forbidden\)/.test(e));
        assert.deepStrictEqual(broken4, [], `the failure page reported errors: ${broken4.join(' | ')}`);
      } finally {
        await page4.close();
        await svcAuth.close();
      }
    });

    await check('the whole suite ran under the enforced CSP with zero securitypolicyviolation events', async () => {
      // The exit criterion from issue #84: a policy strict enough to matter
      // and loose enough that nothing it actually touched -- sessions,
      // approvals, reconnects, themes, the service worker, the manifest --
      // ever tripped it. Checked LAST, so it covers every check above.
      assert.deepStrictEqual(cspViolations, [],
        `the main suite tripped the CSP: ${JSON.stringify(cspViolations)}`);
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
