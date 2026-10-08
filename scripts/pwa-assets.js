#!/usr/bin/env node
'use strict';
/**
 * Generate the maskable icon and the manifest screenshots for #171.
 *
 * Maskable icon: Android (and some desktop launchers) crop a PWA icon to
 * whatever shape their own icon theme uses -- circle, squircle, rounded
 * square -- discarding anything outside a centred "safe zone" that is 80% of
 * the icon's width. The existing icon-512.png has no padding for that: a
 * circular crop would clip the mark. This generates a SEPARATE icon, flagged
 * `"purpose": "maskable"` in the manifest, with the mark scaled to sit fully
 * inside that safe zone on a full-bleed brand background.
 *
 * Screenshots: a manifest `screenshots` entry is what lets Chromium and
 * Windows show the richer install UI (the one with a product preview) instead
 * of the bare one-line prompt. They are drawn here as a stylised rendering of
 * the actual layout -- the topbar, the install card, the session list --
 * rather than a live browser capture: the project has no headless browser
 * dependency to take one with (see scripts/shots.js, which needs Playwright
 * and a *running* hub, and is a manual README tool rather than a build step).
 * Same reasoning as icons.js: no image library, raw pixels, zlib only.
 *
 *   node scripts/pwa-assets.js
 */

const fs = require('fs');
const path = require('path');
const {
  png, canvas, fillRect, fillRoundedRect, fillCircle,
} = require('./lib/png');

const web = path.join(__dirname, '..', 'web');

// The brand mark: three circles in a triangle, the same geometry as
// web/icon.svg and web/favicon.svg, just rasterised instead of vector.
const BRAND_BG = [0x14, 0x16, 0x1a, 255];
const BRAND_BLUE = [0x4c, 0x8d, 0xff, 255];
const BRAND_VIOLET = [0xa0, 0x5c, 0xff, 255];

/** The three-circle mark, centred at (cx, cy), scaled by `r` (the radius of one circle). */
function drawMark(buf, width, height, cx, cy, r) {
  // Blend blue -> violet across the three circles rather than picking one
  // colour, so the rasterised mark still reads as the same gradient mark used
  // everywhere else, not a flat recolour of it.
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  const colorAt = (t) => [lerp(BRAND_BLUE[0], BRAND_VIOLET[0], t), lerp(BRAND_BLUE[1], BRAND_VIOLET[1], t), lerp(BRAND_BLUE[2], BRAND_VIOLET[2], t), 255];
  fillCircle(buf, width, height, cx, cy - r * 0.78, r, colorAt(0));
  fillCircle(buf, width, height, cx - r * 0.9, cy + r * 0.47, r, colorAt(0.5));
  fillCircle(buf, width, height, cx + r * 0.9, cy + r * 0.47, r, colorAt(1));
}

/**
 * The maskable icon.
 *
 * Android's safe zone is the centred 80% of the icon; anything outside it may
 * be cropped by the launcher's mask shape. The mark is scaled to fit inside a
 * circle of that radius, with the brand background filling the rest edge to
 * edge -- "full bleed" is what makes a maskable icon maskABLE at all, since a
 * transparent or inset background shows through as a hard square behind
 * whatever shape the launcher cuts.
 */
function maskableIcon(size) {
  const buf = canvas(size, size, BRAND_BG);
  const safeRadius = size * 0.4; // 80% of size, as a radius
  const cx = size / 2; const cy = size / 2;
  drawMark(buf, size, size, cx, cy, safeRadius * 0.46);
  return png(size, size, buf);
}

const PANEL = [0x1b, 0x1e, 0x24, 255];
const PANEL2 = [0x22, 0x26, 0x2e, 255];
const LINE = [0x2f, 0x34, 0x3f, 255];
const TEXT_ROW = [0x2a, 0x2e, 0x37, 255];
const ACCENT = [0x4c, 0x8d, 0xff, 255];
const WARN = [0xff, 0xc5, 0x3d, 255];
const OK = [0x3e, 0xcf, 0x8e, 255];

/**
 * A stylised render of the all-sessions screen with the install card open,
 * for the richer install UI. See the module doc for why this is drawn rather
 * than captured.
 */
function screenshot(width, height) {
  const buf = canvas(width, height, BRAND_BG);
  const topbarH = Math.round(height * 0.07);
  fillRect(buf, width, height, 0, 0, width, topbarH, PANEL);
  fillRect(buf, width, height, 0, topbarH, width, 1, LINE);
  drawMark(buf, width, height, topbarH * 0.6, topbarH / 2, topbarH * 0.16);
  // The install icon, right-aligned in the bar, as a small accent-tinted square.
  const iconSize = topbarH * 0.5;
  fillRoundedRect(buf, width, height, width - iconSize * 4.6, (topbarH - iconSize) / 2, iconSize, iconSize, iconSize * 0.25, [0x1d, 0x35, 0x63, 255]);
  fillRoundedRect(buf, width, height, width - iconSize * 3.0, (topbarH - iconSize) / 2, iconSize, iconSize, iconSize * 0.25, PANEL2);
  const avatarSize = iconSize;
  fillCircle(buf, width, height, width - iconSize * 0.8, topbarH / 2, avatarSize / 2, ACCENT);

  // Page title bar.
  const pad = Math.round(width * 0.04);
  let y = topbarH + pad * 1.4;
  fillRoundedRect(buf, width, height, pad, y, width * 0.34, pad * 0.9, 4, [0xe8, 0xea, 0xef, 255]);
  y += pad * 1.6;
  fillRoundedRect(buf, width, height, pad, y, width * 0.5, pad * 0.5, 4, [0xa3, 0xaa, 0xb8, 255]);
  y += pad * 1.6;

  // A handful of session rows, one of them flagged "needs you".
  const rowH = Math.max(36, Math.round(height * 0.085));
  const rowGap = Math.round(rowH * 0.18);
  const statuses = [WARN, OK, ACCENT, LINE, OK];
  for (let i = 0; i < statuses.length && y + rowH < height - pad; i += 1) {
    fillRoundedRect(buf, width, height, pad, y, width - pad * 2, rowH, 8, i === 0 ? TEXT_ROW : PANEL);
    fillRect(buf, width, height, pad, y, 3, rowH, i === 0 ? WARN : [0, 0, 0, 0]);
    const innerPad = pad * 0.8;
    fillRoundedRect(buf, width, height, pad + innerPad, y + rowH * 0.22, width * 0.3, rowH * 0.22, 3, [0xe8, 0xea, 0xef, 255]);
    fillRoundedRect(buf, width, height, pad + innerPad, y + rowH * 0.58, width * 0.42, rowH * 0.14, 3, [0x75, 0x7d, 0x8d, 255]);
    // The status pill, right-aligned on the row.
    const pillW = width * 0.16; const pillH = rowH * 0.3;
    fillRoundedRect(buf, width, height, width - pad - innerPad - pillW, y + rowH * 0.2, pillW, pillH, pillH / 2, statuses[i]);
    y += rowH + rowGap;
  }
  return png(width, height, buf);
}

const jobs = [
  { file: 'icon-mask-512.png', make: () => maskableIcon(512) },
  { file: 'screenshot-wide.png', make: () => screenshot(1280, 800) },
  { file: 'screenshot-narrow.png', make: () => screenshot(720, 1280) },
];

for (const { file, make } of jobs) {
  const out = path.join(web, file);
  fs.writeFileSync(out, make());
  console.log(`  ${file}  ${Math.round(fs.statSync(out).size / 1024)} KB`);
}
