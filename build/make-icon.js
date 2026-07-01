'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size, drawPixel) {
  const stride = size * 4;
  const scanlines = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    scanlines[y * (stride + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = drawPixel(x, y);
      const off = y * (stride + 1) + 1 + x * 4;
      scanlines[off] = r;
      scanlines[off + 1] = g;
      scanlines[off + 2] = b;
      scanlines[off + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function makeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(p => {
    const entry = Buffer.alloc(16);
    entry[0] = p.size === 256 ? 0 : p.size;
    entry[1] = p.size === 256 ? 0 : p.size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(p.buf.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += p.buf.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.buf)]);
}

function drawIcon(size) {
  const radius = size * 0.15;
  const bg = [15, 118, 110, 255];
  const white = [255, 255, 255, 255];
  const accent = [249, 115, 22, 255];

  return (x, y) => {
    const clampedX = Math.max(radius, Math.min(size - radius, x));
    const clampedY = Math.max(radius, Math.min(size - radius, y));
    const inRound =
      (x >= radius && x <= size - radius) ||
      (y >= radius && y <= size - radius) ||
      (Math.pow(x - clampedX, 2) + Math.pow(y - clampedY, 2) <= radius * radius);
    if (!inRound) return [0, 0, 0, 0];

    const pageX = size * 0.22;
    const pageY = size * 0.18;
    const pageW = size * 0.56;
    const pageH = size * 0.64;
    const line = Math.max(1, size * 0.018);
    if (x >= pageX && x <= pageX + pageW && y >= pageY && y <= pageY + pageH) {
      const border = Math.max(1, size * 0.025);
      if (x < pageX + border || x > pageX + pageW - border || y < pageY + border || y > pageY + pageH - border) {
        return white;
      }
      const row1 = pageY + pageH * 0.34;
      const row2 = pageY + pageH * 0.53;
      const row3 = pageY + pageH * 0.72;
      const col = pageX + pageW * 0.42;
      if (Math.abs(y - row1) <= line || Math.abs(y - row2) <= line || Math.abs(y - row3) <= line || Math.abs(x - col) <= line) {
        return white;
      }
    }

    const sparkCx = size * 0.74;
    const sparkCy = size * 0.27;
    if (Math.abs(x - sparkCx) + Math.abs(y - sparkCy) < size * 0.10) return accent;
    return bg;
  };
}

const sizes = [16, 32, 48, 64, 128, 256];
const pngs = sizes.map(size => ({ size, buf: makePng(size, drawIcon(size)) }));
const outPath = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, makeIco(pngs));
console.log(`Icon written: ${outPath}`);
