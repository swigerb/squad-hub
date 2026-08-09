#!/usr/bin/env node
'use strict';
/**
 * Take the README screenshots against a REAL hub.
 *
 * Not a mock: it signs in to whatever hub URL it is given, with a real token,
 * and photographs what is actually there. A screenshot of a fixture is a
 * drawing of a product rather than a picture of one, and it drifts silently.
 *
 *   node scripts/shots.js <url-with-token> <outDir>
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const url = process.argv[2];
const outDir = process.argv[3] || path.join(__dirname, '..', 'docs', 'images');
if (!url) { console.error('usage: node scripts/shots.js <url-with-token> [outDir]'); process.exit(2); }

const shot = async (page, name, opts = {}) => {
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, type: 'jpeg', quality: 88, ...opts });
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`  ${name}  ${kb} KB`);
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  try {
    // Dark, deliberately and explicitly. The app follows the system until
    // someone chooses, and a headless browser's "system" is light -- so
    // without this the screenshots drift with whatever the runner prefers,
    // which is not a property a README should have.
    await page.addInitScript(() => {
      try { localStorage.setItem('squad-hub-theme', 'dark'); } catch { /* first load */ }
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-session]', { timeout: 30000 });
    await page.waitForTimeout(1500);

    console.log('screenshots:');

    /**
     * The approval card raises ITSELF when something is waiting, which is the
     * product working -- and it also covers the page, so it has to be
     * photographed and dismissed before anything underneath can be clicked.
     */
    const card = await page.$('#approvalScrim:not([hidden])');
    if (card) {
      await page.waitForTimeout(800);
      await shot(page, 'approval.jpg');
      await page.click('#apCancel');
      await page.waitForTimeout(600);
    }

    await shot(page, 'all-sessions.jpg');

    // The session detail, which carries the Squad panel.
    await page.click('[data-session]');
    await page.waitForSelector('#detailScrim:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(2500);
    await shot(page, 'session-detail.jpg');

    // A charter, read from the device and rendered as text. The panel is
    // re-rendered on every refresh, so the click is delegated -- take the
    // element fresh rather than holding a handle across a re-render.
    const memberSel = '#dtSquad .sq-member[data-squaddoc]:not([disabled])';
    if (await page.$(memberSel)) {
      await page.click(memberSel);
      await page.waitForSelector('.sq-doctext', { timeout: 20000 });
      await page.waitForTimeout(1200);
      await shot(page, 'squad-charter.jpg');
    } else {
      console.log('  (no Squad member button found -- is this session in a Squad workspace?)');
    }

    await page.click('#dtClose');
    await page.waitForTimeout(600);

    // New session, with the pickers populated by the device.
    const newBtn = await page.$('#newBtn');
    if (newBtn) {
      await newBtn.click();
      await page.waitForSelector('#newScrim:not([hidden])', { timeout: 10000 });
      await page.waitForTimeout(1200);
      await shot(page, 'new-session.jpg');
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
