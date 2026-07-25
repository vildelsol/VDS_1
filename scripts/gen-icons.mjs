/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Generate the PWA app icons without any image dependency.
 *
 * Writes solid teal rounded-look PNGs (a plain brand tile) at the sizes a PWA
 * needs. Run once with `node scripts/gen-icons.mjs`; the PNGs are committed so a
 * normal install does not need to run this.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
fs.mkdirSync(OUT, { recursive: true });

// Brand colours.
const TEAL = [13, 148, 136]; // #0d9488
const LIGHT = [204, 251, 241]; // #ccfbf1
const bg = [15, 23, 42]; // slate-900, for the maskable safe area

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Build a PNG from an (x,y)->[r,g,b] painter. */
function png(size, paint) {
  const bytesPerRow = size * 3;
  const raw = Buffer.alloc((bytesPerRow + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (bytesPerRow + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = paint(x, y, size);
      const o = y * (bytesPerRow + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// A simple mark: teal field, a lighter rounded inner square, on a dark maskable
// backdrop so it reads on any launcher.
function paintMark(maskable) {
  return (x, y, size) => {
    const pad = maskable ? size * 0.14 : 0; // maskable safe area
    const inField = x >= pad && y >= pad && x < size - pad && y < size - pad;
    if (!inField) return bg;
    // inner accent square
    const q = size * 0.30;
    if (x > q && x < size - q && y > q && y < size - q) return LIGHT;
    return TEAL;
  };
}

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), png(size, paintMark(false)));
  fs.writeFileSync(path.join(OUT, `icon-${size}-maskable.png`), png(size, paintMark(true)));
}
// Apple touch icon (no maskable padding).
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), png(180, paintMark(false)));

console.log('Wrote PWA icons to', OUT);
