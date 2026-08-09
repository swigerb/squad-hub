#!/usr/bin/env node
'use strict';
/**
 * Generate the PNG app icons from web/logo.jpg.
 *
 * PNG, not SVG, because iOS ignores SVG for `apple-touch-icon` and for manifest
 * icons -- a Home Screen web app with only an SVG gets a screenshot of the page
 * as its icon, which is how you end up with a blurry rectangle of your own UI
 * on the home screen.
 *
 * No image library: Squad Hub has no dependencies and that is worth keeping.
 * This writes PNGs by hand from raw pixels, using only zlib from Node's own
 * standard library, and reads the JPEG through the platform decoder.
 *
 *   node scripts/icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const web = path.join(__dirname, '..', 'web');
const SRC = path.join(web, 'logo.jpg');

/** Square-crop and resize with the platform's own imaging, to raw RGBA. */
function rawPixels(size) {
  const out = path.join(require('os').tmpdir(), `sqicon-${size}.raw`);
  const ps = `
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile('${SRC.replace(/\\/g, '\\\\')}')
    $side = [Math]::Min($src.Width, $src.Height)
    $sx = [int](($src.Width - $side) / 2)
    $sy = [int](($src.Height - $side) / 2)
    $bmp = New-Object System.Drawing.Bitmap ${size}, ${size}
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.PixelOffsetMode = 'HighQuality'
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0,0,${size},${size}),
                 $sx, $sy, $side, $side, 'Pixel')
    $bytes = New-Object byte[] (${size} * ${size} * 4)
    $i = 0
    for ($y = 0; $y -lt ${size}; $y++) {
      for ($x = 0; $x -lt ${size}; $x++) {
        $c = $bmp.GetPixel($x, $y)
        $bytes[$i++] = $c.R; $bytes[$i++] = $c.G; $bytes[$i++] = $c.B; $bytes[$i++] = 255
      }
    }
    [IO.File]::WriteAllBytes('${out.replace(/\\/g, '\\\\')}', $bytes)
    $g.Dispose(); $bmp.Dispose(); $src.Dispose()
  `;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe' });
  const buf = fs.readFileSync(out);
  fs.unlinkSync(out);
  return buf;
}

function crc32(buf) {
  let c; const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  // One filter byte (0 = None) in front of each row, as the format requires.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 180 is what iOS asks for; 192 and 512 are what a manifest wants.
for (const size of [180, 192, 512]) {
  const file = path.join(web, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, rawPixels(size)));
  console.log(`  icon-${size}.png  ${Math.round(fs.statSync(file).size / 1024)} KB`);
}
