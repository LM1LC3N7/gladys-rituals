// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a warm gradient, a
// cylindrical perfume diffuser on a shelf, a soft plume of scented mist
// rising from it, and three intensity dots. Plain Node (zlib), no
// dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const TOP = [44, 30, 46];
const BOTTOM = [120, 82, 92];
const SHELF = [70, 48, 52];
const BODY = [236, 226, 214];
const BODY_DARK = [196, 182, 168];
const GOLD = [214, 176, 98];
const MIST = [250, 244, 240];
const DOT = [240, 214, 150];

/** A soft plume: wavy, widening and fading as it rises. */
function mist(color, x, y) {
  if (y > 250 || y < 40) return color;
  const rise = (250 - y) / 210;
  const center = 400 + 26 * Math.sin(y / 34) * rise;
  const width = 16 + 70 * rise;
  const d = Math.abs(x - center) / width;
  const fade = Math.min(1, (y - 40) / 90);
  const alpha = Math.max(0, 1 - d * d) * (1 - rise * 0.85) * 0.75 * fade;
  return mix(color, MIST, alpha);
}

function pixel(x, y) {
  let color = mix(TOP, BOTTOM, y / HEIGHT);
  // A soft halo behind the diffuser.
  color = mix(color, [160, 110, 120], Math.max(0, 1 - Math.hypot(x - 400, y - 300) / 260) * 0.5);
  // The shelf.
  color = mix(color, SHELF, smooth(0, roundedBox(x, y, 400, 452, 330, 10, 4)));
  // The diffuser: a rounded cylinder, shaded, a gold ring and a top vent.
  const inside = smooth(0, roundedBox(x, y, 400, 345, 70, 97, 26));
  const shade = Math.min(1, Math.abs(x - 380) / 80);
  color = mix(color, mix(BODY, BODY_DARK, shade), inside);
  color = mix(color, GOLD, smooth(0, roundedBox(x, y, 400, 395, 70, 5, 2)) * inside);
  color = mix(color, BODY_DARK, smooth(0, roundedBox(x, y, 400, 256, 36, 5, 4)));
  // The mist.
  color = mist(color, x, y);
  // Intensity dots on the shelf.
  for (const [i, cx] of [372, 400, 428].entries()) {
    color = mix(color, i < 2 ? DOT : BODY_DARK, smooth(4.5, Math.hypot(x - cx, y - 490)));
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
