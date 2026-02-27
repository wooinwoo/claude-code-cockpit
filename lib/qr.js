// Minimal QR Code SVG generator — Byte mode, ECC-L, Version 1-10
// No external dependencies. Returns SVG string.

const ECC_L = {
  totalCW:  [26,44,70,100,134,172,196,242,292,346],
  eccCW:    [7,10,15,20,26,36,40,48,56,68],
  capacity: [17,32,53,78,106,134,154,192,230,271],
};

const ALIGNMENT = [
  [], [], [6,18], [6,22], [6,26], [6,30],
  [6,34], [6,22,38], [6,24,42], [6,26,46], [6,28,50],
];

// GF(256) tables for Reed-Solomon
const gfExp = new Uint8Array(512);
const gfLog = new Uint8Array(256);
{
  let v = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = v; gfLog[v] = i;
    v <<= 1; if (v >= 256) v ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];
}

function gfMul(a, b) {
  return (a === 0 || b === 0) ? 0 : gfExp[gfLog[a] + gfLog[b]];
}

function rsEncode(data, eccCount) {
  // Generator polynomial
  let gen = [1];
  for (let i = 0; i < eccCount; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], gfExp[i]);
    }
    gen = next;
  }
  const result = new Array(eccCount).fill(0);
  for (const d of data) {
    const fb = result[0] ^ d;
    for (let i = 0; i < eccCount - 1; i++) result[i] = result[i + 1] ^ gfMul(gen[i + 1], fb);
    result[eccCount - 1] = gfMul(gen[eccCount], fb);
  }
  return result;
}

function encodeData(text, ver) {
  const bytes = Buffer.from(text, 'utf8');
  const dataCW = ECC_L.totalCW[ver - 1] - ECC_L.eccCW[ver - 1];
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };

  push(0b0100, 4); // byte mode
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  // Terminator
  const cap = dataCW * 8;
  push(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  // Pad codewords
  const pads = [0xEC, 0x11];
  let pi = 0;
  while (bits.length < cap) { push(pads[pi], 8); pi ^= 1; }

  // Convert to codewords
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i + j] || 0);
    cw.push(v);
  }

  const ecc = rsEncode(cw, ECC_L.eccCW[ver - 1]);
  return [...cw, ...ecc];
}

function createMatrix(size) {
  return {
    mod: Array.from({ length: size }, () => Array(size).fill(false)),
    fn:  Array.from({ length: size }, () => Array(size).fill(false)), // function pattern flag
  };
}

function setModule(m, x, y, val, isFunction) {
  m.mod[y][x] = val;
  if (isFunction) m.fn[y][x] = true;
}

function placeFinderPattern(m, cx, cy, size) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      const maxD = Math.max(adx, ady);
      // Finder: solid ring at 0 and 2, white at 1, separator at 4
      const val = maxD <= 3 && maxD !== 2;
      setModule(m, x, y, val && maxD < 4, true);
    }
  }
}

function placeTimingPatterns(m, size) {
  for (let i = 8; i < size - 8; i++) {
    setModule(m, i, 6, i % 2 === 0, true);
    setModule(m, 6, i, i % 2 === 0, true);
  }
}

function placeAlignmentPatterns(m, ver, size) {
  const pos = ALIGNMENT[ver] || [];
  for (const ay of pos) {
    for (const ax of pos) {
      // Skip if overlapping finder pattern
      if (m.fn[ay]?.[ax]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = ax + dx, y = ay + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          const maxD = Math.max(Math.abs(dx), Math.abs(dy));
          setModule(m, x, y, maxD !== 1, true);
        }
      }
    }
  }
}

function reserveFormatInfo(m, size) {
  // Around top-left finder
  for (let i = 0; i <= 8; i++) {
    if (i < size) { m.fn[8][i] = true; m.fn[i][8] = true; }
  }
  // Bottom-left
  for (let i = 0; i < 7; i++) m.fn[size - 1 - i][8] = true;
  // Top-right
  for (let i = 0; i < 8; i++) m.fn[8][size - 1 - i] = true;
  // Dark module
  setModule(m, 8, size - 8, true, true);
}

function placeData(m, allCW, size) {
  const allBits = [];
  for (const cw of allCW) {
    for (let i = 7; i >= 0; i--) allBits.push((cw >> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip timing column
    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const row of rows) {
      for (const col of [right, right - 1]) {
        if (col < 0 || m.fn[row][col]) continue;
        if (bitIdx < allBits.length) {
          m.mod[row][col] = !!allBits[bitIdx++];
        }
      }
    }
    upward = !upward;
  }
}

// Mask functions
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];

function applyMask(m, maskIdx, size) {
  const fn = MASKS[maskIdx];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!m.fn[y][x] && fn(y, x)) {
        m.mod[y][x] = !m.mod[y][x];
      }
    }
  }
}

// Penalty score for mask selection
function penaltyScore(m, size) {
  let score = 0;
  // Rule 1: runs of same color
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (m.mod[y][x] === m.mod[y][x - 1]) { run++; }
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (m.mod[y][x] === m.mod[y - 1][x]) { run++; }
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  // Rule 2: 2x2 blocks
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = m.mod[y][x];
      if (v === m.mod[y][x + 1] && v === m.mod[y + 1][x] && v === m.mod[y + 1][x + 1]) score += 3;
    }
  }
  return score;
}

function getFormatBits(eccMask) {
  let val = eccMask << 10;
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if (val & (1 << i)) val ^= gen << (i - 10);
  }
  val = (eccMask << 10) | val;
  val ^= 0b101010000010010;
  const bits = [];
  for (let i = 14; i >= 0; i--) bits.push((val >> i) & 1);
  return bits;
}

function writeFormatInfo(m, maskIdx, size) {
  // ECC-L = 01, mask = maskIdx (3 bits) → 5-bit value
  const eccMask = (0b01 << 3) | maskIdx;
  const bits = getFormatBits(eccMask);

  // Positions around top-left finder
  const hx = [0, 1, 2, 3, 4, 5, 7, 8, 8, 8, 8, 8, 8, 8, 8];
  const hy = [8, 8, 8, 8, 8, 8, 8, 8, 7, 5, 4, 3, 2, 1, 0];

  // Second copy: bottom-left column + top-right row
  const vx = [8, 8, 8, 8, 8, 8, 8, 8, size - 7, size - 6, size - 5, size - 4, size - 3, size - 2, size - 1];
  const vy = [size - 1, size - 2, size - 3, size - 4, size - 5, size - 6, size - 7, size - 8, 8, 8, 8, 8, 8, 8, 8];

  for (let i = 0; i < 15; i++) {
    m.mod[hy[i]][hx[i]] = !!bits[i];
    m.mod[vy[i]][vx[i]] = !!bits[i];
  }
}

export function generateQRSvg(text, { scale = 6, margin = 4 } = {}) {
  const bytes = Buffer.from(text, 'utf8');
  const len = bytes.length;

  // Pick version
  let ver = 1;
  for (let i = 0; i < ECC_L.capacity.length; i++) {
    if (len <= ECC_L.capacity[i]) { ver = i + 1; break; }
  }
  const size = 17 + ver * 4;

  // Encode data
  const allCW = encodeData(text, ver);

  // Try all 8 masks, pick best
  let bestMask = 0, bestScore = Infinity;
  for (let mi = 0; mi < 8; mi++) {
    const m = createMatrix(size);
    placeFinderPattern(m, 3, 3, size);
    placeFinderPattern(m, size - 4, 3, size);
    placeFinderPattern(m, 3, size - 4, size);
    placeTimingPatterns(m, size);
    placeAlignmentPatterns(m, ver, size);
    reserveFormatInfo(m, size);
    placeData(m, allCW, size);
    applyMask(m, mi, size);
    writeFormatInfo(m, mi, size);
    const score = penaltyScore(m, size);
    if (score < bestScore) { bestScore = score; bestMask = mi; }
  }

  // Generate final matrix with best mask
  const m = createMatrix(size);
  placeFinderPattern(m, 3, 3, size);
  placeFinderPattern(m, size - 4, 3, size);
  placeFinderPattern(m, 3, size - 4, size);
  placeTimingPatterns(m, size);
  placeAlignmentPatterns(m, ver, size);
  reserveFormatInfo(m, size);
  placeData(m, allCW, size);
  applyMask(m, bestMask, size);
  writeFormatInfo(m, bestMask, size);

  // Render SVG
  const total = (size + margin * 2) * scale;
  let rects = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m.mod[y][x]) {
        rects += `<rect x="${(x + margin) * scale}" y="${(y + margin) * scale}" width="${scale}" height="${scale}"/>`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}">` +
    `<rect width="${total}" height="${total}" fill="#fff"/>` +
    `<g fill="#000">${rects}</g></svg>`;
}
