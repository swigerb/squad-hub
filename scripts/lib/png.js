'use strict';
/**
 * Hand-rolled PNG writer, shared by every script under scripts/ that needs to
 * produce a raster asset.
 *
 * No image library: Squad Hub has no dependencies and that is worth keeping
 * (see scripts/icons.js). This is the common bottom half -- CRC, chunking and
 * the IHDR/IDAT/IEND framing -- factored out so a second script (generating
 * the maskable icon and the install-card screenshots for #171) does not have
 * to re-derive a CRC-32 table to draw a rectangle.
 */

const zlib = require('zlib');

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

/** Encode an RGBA buffer (width*height*4 bytes, row-major, no padding) as a PNG. */
function png(width, height, rgba) {
  // One filter byte (0 = None) in front of each row, as the format requires.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A blank RGBA canvas, pre-filled with one colour. */
function canvas(width, height, [r, g, b, a] = [0, 0, 0, 255]) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  }
  return buf;
}

/** Axis-aligned filled rectangle, clipped to the canvas. Alpha-blended onto whatever is already there. */
function fillRect(buf, width, height, x, y, w, h, [r, g, b, a] = [0, 0, 0, 255]) {
  const x0 = Math.max(0, Math.round(x)); const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, Math.round(x + w)); const y1 = Math.min(height, Math.round(y + h));
  const alpha = a / 255;
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      const i = (yy * width + xx) * 4;
      buf[i] = Math.round(r * alpha + buf[i] * (1 - alpha));
      buf[i + 1] = Math.round(g * alpha + buf[i + 1] * (1 - alpha));
      buf[i + 2] = Math.round(b * alpha + buf[i + 2] * (1 - alpha));
      buf[i + 3] = 255;
    }
  }
}

/** A rectangle with rounded corners, approximated by trimming the four corner squares to quarter-circles. */
function fillRoundedRect(buf, width, height, x, y, w, h, radius, color) {
  fillRect(buf, width, height, x + radius, y, w - 2 * radius, h, color);
  fillRect(buf, width, height, x, y + radius, w, h - 2 * radius, color);
  const corners = [
    [x + radius, y + radius], [x + w - radius, y + radius],
    [x + radius, y + h - radius], [x + w - radius, y + h - radius],
  ];
  for (const [cx, cy] of corners) fillCircle(buf, width, height, cx, cy, radius, color);
}

/** Filled circle, alpha-blended the same way fillRect is. */
function fillCircle(buf, width, height, cx, cy, radius, [r, g, b, a] = [0, 0, 0, 255]) {
  const x0 = Math.max(0, Math.floor(cx - radius)); const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(width, Math.ceil(cx + radius)); const y1 = Math.min(height, Math.ceil(cy + radius));
  const alpha = a / 255;
  const r2 = radius * radius;
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      const dx = xx - cx + 0.5; const dy = yy - cy + 0.5;
      if ((dx * dx) + (dy * dy) > r2) continue;
      const i = (yy * width + xx) * 4;
      buf[i] = Math.round(r * alpha + buf[i] * (1 - alpha));
      buf[i + 1] = Math.round(g * alpha + buf[i + 1] * (1 - alpha));
      buf[i + 2] = Math.round(b * alpha + buf[i + 2] * (1 - alpha));
      buf[i + 3] = 255;
    }
  }
}

module.exports = {
  crc32, chunk, png, canvas, fillRect, fillRoundedRect, fillCircle,
};
