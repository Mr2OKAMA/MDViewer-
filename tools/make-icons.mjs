/**
 * アイコン PNG を生成する (外部依存なし)。
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';

const BG = [9, 105, 218, 255]; // GitHub ブルー
const FG = [255, 255, 255, 255];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 角丸の背景に「M + 下向き矢印」のマークを描く。 */
function pixel(x, y, size) {
  const u = (x + 0.5) / size;
  const v = (y + 0.5) / size;
  const r = 0.18;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) return [0, 0, 0, 0];

  const w = 0.09;
  const bar = (center, top, bottom) =>
    Math.abs(u - center) < w / 2 && v > top && v < bottom;
  const mLeft = bar(0.24, 0.26, 0.6);
  const mRight = bar(0.76, 0.26, 0.6);
  const mMid = bar(0.5, 0.42, 0.6);
  const diagL = Math.abs(u - (0.24 + (v - 0.26) * 1.6)) < w / 2 && v > 0.26 && v < 0.43;
  const diagR = Math.abs(u - (0.76 - (v - 0.26) * 1.6)) < w / 2 && v > 0.26 && v < 0.43;
  const arrowStem = bar(0.5, 0.62, 0.76);
  const arrowHead = v >= 0.7 && v < 0.82 && Math.abs(u - 0.5) < (0.82 - v) * 1.4;

  return mLeft || mRight || mMid || diagL || diagR || arrowStem || arrowHead ? FG : BG;
}

await mkdir('icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(`icons/icon${size}.png`, png(size, pixel));
  console.log(`icons/icon${size}.png`);
}
