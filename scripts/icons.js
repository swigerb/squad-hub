#!/usr/bin/env node
'use strict';

// Uses the same Playwright/Chromium prerequisite as the browser tests.
// Render the SVG itself so installed icons cannot drift from the app mark.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function main() {
  const web = path.join(__dirname, '..', 'web');
  const svg = fs.readFileSync(path.join(web, 'icon.svg'), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [size, file, maskable] of [
      [180, 'icon-180.png', false],
      [192, 'icon-192.png', false],
      [512, 'icon-512.png', false],
      [512, 'icon-mask-512.png', true],
    ]) {
      const page = await browser.newPage({
        viewport: { width: size, height: size },
        deviceScaleFactor: 1,
      });
      try {
        const drawing = maskable ? svg.replace('rx="112"', 'rx="0"') : svg;
        await page.setContent(`<style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${drawing}`);
        await page.screenshot({ path: path.join(web, file), omitBackground: true });
        console.log(`  ${file}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
