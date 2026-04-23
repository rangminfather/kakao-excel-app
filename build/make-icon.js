// 간단한 ICO 파일 생성기 (외부 의존 없음)
// 카카오 옐로우 배경 + 📊 이모지 느낌의 심플 패턴을 256×256 PNG로 만들어 ICO로 감쌈
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function makePng(size, drawPixel) {
  // RGBA 버퍼 생성
  const bpp = 4;
  const stride = size * bpp;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = drawPixel(x, y);
      const off = y * stride + x * bpp;
      raw[off] = r; raw[off+1] = g; raw[off+2] = b; raw[off+3] = a;
    }
  }
  // PNG scanlines: 각 줄 앞에 filter byte(0) 추가
  const scanlines = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    scanlines[y * (stride + 1)] = 0;
    raw.copy(scanlines, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = zlib.deflateSync(scanlines);

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

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function makeIco(pngs) {
  // pngs: [{size, buf}, ...]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type = 1 (icon)
  header.writeUInt16LE(pngs.length, 4); // count

  const dirEntries = [];
  let offset = 6 + 16 * pngs.length;
  for (const p of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = p.size === 256 ? 0 : p.size;  // width
    entry[1] = p.size === 256 ? 0 : p.size;  // height
    entry[2] = 0;                             // color count
    entry[3] = 0;                             // reserved
    entry.writeUInt16LE(1, 4);                // color planes
    entry.writeUInt16LE(32, 6);               // bit count
    entry.writeUInt32LE(p.buf.length, 8);     // data size
    entry.writeUInt32LE(offset, 12);          // data offset
    offset += p.buf.length;
    dirEntries.push(entry);
  }
  return Buffer.concat([header, ...dirEntries, ...pngs.map(p => p.buf)]);
}

// 간단한 디자인: 카카오 옐로우 바탕 + 둥근 모서리 + 중앙에 막대그래프 모양
function drawIcon(size) {
  const r = size * 0.15; // 모서리 반경
  return (x, y) => {
    // 라운드 사각형 안인지
    const inRound =
      (x >= r && x <= size - r) || (y >= r && y <= size - r) ||
      ((x < r || x > size - r) && (y < r || y > size - r) &&
        Math.pow(x - Math.max(r, Math.min(size - r, x)), 2) +
        Math.pow(y - Math.max(r, Math.min(size - r, y)), 2) <= r * r);
    if (!inRound) return [0, 0, 0, 0];
    const yellow = [254, 229, 0, 255];
    // 바의 위치 (왼쪽부터 낮음→높음)
    const cx = size / 2;
    const cy = size / 2;
    const barWidth = size * 0.12;
    const gap = size * 0.04;
    const bars = [
      { x: cx - 2*(barWidth+gap), h: size * 0.22 },
      { x: cx - (barWidth+gap),   h: size * 0.34 },
      { x: cx,                     h: size * 0.46 },
      { x: cx + (barWidth+gap),    h: size * 0.58 }
    ];
    const baseY = cy + size * 0.25;
    for (const b of bars) {
      if (x >= b.x && x <= b.x + barWidth && y <= baseY && y >= baseY - b.h) {
        return [17, 24, 39, 255]; // 진한 검정 (#111827)
      }
    }
    // 바닥선
    if (y >= baseY && y <= baseY + Math.max(2, size * 0.015) && x > size * 0.18 && x < size * 0.82) {
      return [17, 24, 39, 255];
    }
    return yellow;
  };
}

const sizes = [16, 32, 48, 64, 128, 256];
const pngs = sizes.map(s => ({ size: s, buf: makePng(s, drawIcon(s)) }));
const ico = makeIco(pngs);
const outPath = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, ico);
console.log(`Icon written: ${outPath} (${ico.length} bytes, ${sizes.length} sizes)`);
