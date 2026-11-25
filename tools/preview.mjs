// Dev utility: render terrain views to PNG with Node, no browser needed.
//   node tools/preview.mjs [seed]
// Writes /tmp/atlas-*.png so the palette and generation can be checked quickly.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { renderRegion, findStart } from '../js/terrain.js';

const W = 1200;
const H = 760;
const seedText = process.argv[2] || 'quiet-harbor-42';

function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const seed = hashString(seedText);
const start = findStart(seed);
console.log(`seed "${seedText}" -> ${seed}, start ${start.x.toFixed(0)},${start.y.toFixed(0)} score ${start.score.toFixed(3)}`);

const views = [
  ['mid', 0.6, start.x, start.y],
  ['far', 0.12, start.x, start.y],
  ['close', 3.5, start.x + 180, start.y - 120],
];

for (const [name, scale, cx, cy] of views) {
  const wpp = 1 / scale;
  const x0 = cx - (W / 2) * wpp;
  const y0 = cy - (H / 2) * wpp;
  const t0 = performance.now();
  const data = renderRegion({ x0, y0, width: W, height: H, worldPerPixel: wpp, seed });
  const ms = performance.now() - t0;
  writeFileSync(`/tmp/atlas-${name}.png`, encodePNG(W, H, data));
  console.log(`${name}: ${ms.toFixed(1)} ms for ${W}x${H} (${((W * H) / ms / 1000).toFixed(2)} MPx/s)`);
}
