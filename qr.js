/**
 * A QR encoder, byte mode, error-correction level M, versions 1-10.
 *
 * Vendored as code rather than pulled from a CDN for the same reason pdf.js is:
 * the app has to work on a stand with no network. It is small because it does
 * one job — a short https URL — and refuses anything it cannot encode instead
 * of guessing. Every module it produces is checked against an independent
 * reference implementation in tools/qr-check.mjs; a QR that is subtly wrong is
 * worse than none, because it fails silently in someone else's camera.
 */

// --- GF(256), the field Reed-Solomon works in -------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d; // the QR generator polynomial
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * The generator polynomial for `degree` error-correction codewords: the product
 * of (x + a^i) for i below `degree`.
 *
 * Coefficients run highest power first, so poly[0] is the leading 1. Multiplying
 * by (x + a^i) sends each coefficient both up a power — same index in the longer
 * array — and, scaled by a^i, down one. Having those two the wrong way round
 * builds the polynomial reversed, which still produces plausible-looking parity
 * bytes and a QR no camera can read.
 */
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function remainder(data, degree) {
  const out = new Array(degree).fill(0);
  const gen = generator(degree);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.shift();
    out.push(0);
    for (let i = 0; i < degree; i++) out[i] ^= mul(gen[i + 1], factor);
  }
  return out;
}

// --- Version tables, level M only -------------------------------------------
// [total codewords, EC codewords per block, group-1 blocks, group-2 blocks]
const VERSIONS = {
  1: [26, 10, 1, 0],
  2: [44, 16, 1, 0],
  3: [70, 26, 1, 0],
  4: [100, 18, 2, 0],
  5: [134, 24, 2, 0],
  6: [172, 16, 4, 0],
  7: [196, 18, 4, 0],
  8: [242, 22, 2, 2],
  9: [292, 22, 3, 2],
  10: [346, 26, 4, 1],
};
// Where the alignment patterns sit, per version.
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const capacity = (v) => {
  const [total, ecPer, g1, g2] = VERSIONS[v];
  return total - ecPer * (g1 + g2);
};

// --- Bit stream --------------------------------------------------------------
class Bits {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
  toBytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      out.push(byte);
    }
    return out;
  }
}

/** Data codewords for `text`, padded to the version's capacity. */
function encodeData(bytes, version) {
  const room = capacity(version);
  const bits = new Bits();
  bits.push(0b0100, 4); // byte mode
  bits.push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) bits.push(b, 8);
  bits.push(0, Math.min(4, room * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0, 1);

  const out = bits.toBytes();
  // The pad bytes are fixed by the standard and alternate.
  for (let i = 0; out.length < room; i++) out.push(i % 2 === 0 ? 0xec : 0x11);
  return out;
}

/** Split into blocks, add error correction, interleave. */
function buildCodewords(data, version) {
  const [, ecPer, g1, g2] = VERSIONS[version];
  const blocks = g1 + g2;
  const short = Math.floor(data.length / blocks);

  const dataBlocks = [];
  const ecBlocks = [];
  let at = 0;
  for (let i = 0; i < blocks; i++) {
    const size = i < g1 ? short : short + 1;
    const block = data.slice(at, at + size);
    at += size;
    dataBlocks.push(block);
    ecBlocks.push(remainder(block, ecPer));
  }

  const out = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPer; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

// --- The grid ----------------------------------------------------------------
function blankGrid(size) {
  return {
    modules: Array.from({ length: size }, () => new Array(size).fill(null)),
    reserved: Array.from({ length: size }, () => new Array(size).fill(false)),
    size,
  };
}

function place(g, r, c, value) {
  g.modules[r][c] = value;
  g.reserved[r][c] = true;
}

function drawFunctionPatterns(g) {
  const n = g.size;
  const finder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r;
        const cc = left + c;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark =
          inRing &&
          (r === 0 || r === 6 || c === 0 || c === 6 ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        place(g, rr, cc, dark ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);

  for (let i = 8; i < n - 8; i++) {
    const dark = i % 2 === 0 ? 1 : 0;
    place(g, 6, i, dark);
    place(g, i, 6, dark);
  }

  for (const r of ALIGN[g.version]) {
    for (const c of ALIGN[g.version]) {
      // The three corners already carry finder patterns.
      if ((r === 6 && c === 6) || (r === 6 && c === g.size - 7) || (r === g.size - 7 && c === 6))
        continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          place(g, r + dr, c + dc, ring === 1 ? 0 : 1);
        }
      }
    }
  }

  place(g, n - 8, 8, 1); // the dark module, always set

  // Format information: reserved now, written once the mask is chosen.
  for (let i = 0; i <= 8; i++) {
    if (!g.reserved[8][i]) place(g, 8, i, 0);
    if (!g.reserved[i][8]) place(g, i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!g.reserved[8][n - 1 - i]) place(g, 8, n - 1 - i, 0);
    if (!g.reserved[n - 1 - i][8]) place(g, n - 1 - i, 8, 0);
  }
}

/** Zigzag up and down the columns, skipping the timing column. */
function placeData(g, codewords) {
  let bit = 0;
  const bitAt = (i) => (codewords[i >> 3] >> (7 - (i & 7))) & 1;
  let upward = true;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // column 6 is timing and carries no data
    for (let step = 0; step < g.size; step++) {
      const row = upward ? g.size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (g.reserved[row][col]) continue;
        g.modules[row][col] = bit < codewords.length * 8 ? bitAt(bit) : 0;
        bit++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(m) {
  const n = m.length;
  let score = 0;

  // Rule 1: runs of five or more.
  for (const line of [
    ...m,
    ...Array.from({ length: n }, (_, c) => m.map((row) => row[c])),
  ]) {
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules on one
  // side of it — the thing a decoder can mistake for a finder.
  //
  // The light run may be the quiet zone: a pattern flush against the edge of
  // the symbol counts, because outside the symbol is light. Requiring all
  // eleven modules to fall inside instead misses every occurrence that touches
  // an edge, which here was four fifths of them — the scores came out so far
  // below a reference implementation's that the mask chosen was rarely the
  // right one.
  const N3 = [1, 0, 1, 1, 1, 0, 1];
  const allLight = (line, from, to) => {
    for (let i = Math.max(from, 0); i < Math.min(to, n); i++) if (line[i]) return false;
    return true;
  };
  for (const line of [
    ...m,
    ...Array.from({ length: n }, (_, c) => m.map((row) => row[c])),
  ]) {
    let i = 0;
    while (i + 7 <= n) {
      if (!N3.every((v, k) => line[i + k] === v)) {
        i++;
        continue;
      }
      if (i === 0 || i === n - 7 || allLight(line, i - 4, i) || allLight(line, i + 7, i + 11)) {
        score += 40;
        i += 7;
      } else {
        // The pattern can overlap itself; carry on from inside it.
        i += 4;
      }
    }
  }

  // Rule 4: how far from half dark.
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** Format bits: level M is 00, then the mask, then BCH(15,5) and a fixed XOR. */
function formatBits(mask) {
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >> 9) * 0b10100110111);
  }
  return (((data << 10) | rem) ^ 0b101010000010010) & 0x7fff;
}

/**
 * The fifteen format bits, twice, most significant first.
 *
 * `j` counts from the most significant bit, not the least. Numbering them from
 * the other end lays the whole string down mirrored — every module still looks
 * like a format module, and the symbol is unreadable.
 */
function writeFormat(g, mask) {
  const bits = formatBits(mask);
  const n = g.size;
  const bit = (j) => (bits >> (14 - j)) & 1;

  // Around the top-left finder.
  for (let j = 0; j <= 5; j++) g.modules[8][j] = bit(j);
  g.modules[8][7] = bit(6);
  g.modules[8][8] = bit(7);
  g.modules[7][8] = bit(8);
  for (let j = 9; j <= 14; j++) g.modules[14 - j][8] = bit(j);

  // The second copy, split between the other two finders.
  for (let j = 0; j <= 6; j++) g.modules[n - 1 - j][8] = bit(j);
  for (let j = 7; j <= 14; j++) g.modules[8][n - 15 + j] = bit(j);
  g.modules[n - 8][8] = 1; // the dark module survives every mask
}

/**
 * @returns {number[][]} rows of 0/1, no quiet zone. Throws if the text does not
 *          fit in version 10 rather than producing something unscannable.
 */
export function encodeQr(text, { mask: forced = null } = {}) {
  const bytes = [...new TextEncoder().encode(text)];
  const version = Object.keys(VERSIONS)
    .map(Number)
    .find((v) => bytes.length + (v <= 9 ? 2 : 3) <= capacity(v));
  if (!version) throw new Error(`too long for this encoder: ${bytes.length} bytes`);

  const codewords = buildCodewords(encodeData(bytes, version), version);

  const g = blankGrid(version * 4 + 17);
  g.version = version;
  drawFunctionPatterns(g);
  placeData(g, codewords);

  // Try every mask and keep the least ugly, which is what the standard asks
  // for and what a phone camera is tuned against.
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forced !== null && mask !== forced) continue;
    const trial = g.modules.map((row, r) =>
      row.map((v, c) => (g.reserved[r][c] ? v : v ^ (MASKS[mask](r, c) ? 1 : 0)))
    );
    const copy = { modules: trial, reserved: g.reserved, size: g.size };
    writeFormat(copy, mask);
    const score = penalty(trial);
    if (!best || score < best.score) best = { score, modules: trial };
  }
  return best.modules;
}

/** The same thing as an SVG path, which is all the page needs. */
export function qrSvg(text, { size = 160, margin = 2 } = {}) {
  const m = encodeQr(text);
  const n = m.length + margin * 2;
  let d = "";
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) {
      if (m[r][c]) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="Link to this app as a QR code">` +
    `<rect width="${n}" height="${n}" fill="#fff"/>` +
    `<path d="${d}" fill="#000"/></svg>`
  );
}

// Exposed only so tools/qr-check.mjs can compare the codeword stream, not
// just the finished picture: a difference in the bytes is a different bug from
// a difference in where they were drawn.
// Exposed for tools/qr-check.mjs, which compares this scoring against the
// standard's on every mask — the chosen mask being right by luck is not the
// same as the rules being right.
export const __internals = { penalty };
