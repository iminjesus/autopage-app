/**
 * Putting transposed chord symbols onto a rendered page.
 *
 * The music theory lives in transpose.js and is pure. This is the other half:
 * covering what was printed and writing the new symbol where it stood. One
 * copy, used by the app and by the preview page, because the preview is what
 * a chart gets checked against and the two drifting apart would make that
 * check worth nothing.
 */
import { parseChord, transposeChord } from "./transpose.js";

/**
 * Every chord symbol on a page, with where it sits.
 *
 * Positions come from the PDF's own text, in PDF coordinates — origin bottom
 * left — which is what `placeChords` expects to convert.
 */
export function findChords(textContent) {
  const found = [];
  for (const item of textContent.items ?? []) {
    const text = (item.str ?? "").trim();
    if (!text || !parseChord(text)) continue;
    found.push({
      text,
      x: item.transform[4],
      y: item.transform[5],
      w: item.width,
      size: Math.abs(item.transform[3]) || 10,
    });
  }
  return found;
}

/**
 * The page's own colour around a box, so a patch disappears into it.
 *
 * The whole ring, not one pixel. A single sample is a coin toss on a real
 * chart: the lyric line sits a few pixels above the chords, so the point just
 * outside the corner lands on the descender of a "g" about as often as it
 * lands on paper — and then the patch is painted in ink and leaves a black
 * rectangle where the chord was. The commonest colour around the edge is the
 * paper, because most of the edge is paper even when part of it is not.
 */
function backgroundAround(ctx, x, y, w, h) {
  const m = 3;
  const sx = Math.max(0, Math.round(x - m));
  const sy = Math.max(0, Math.round(y - m));
  const sw = Math.min(ctx.canvas.width - sx, Math.round(w + m * 2));
  const sh = Math.min(ctx.canvas.height - sy, Math.round(h + m * 2));
  if (sw < 3 || sh < 3) return "#fff";

  let data;
  try {
    data = ctx.getImageData(sx, sy, sw, sh).data;
  } catch {
    return "#fff";
  }

  const seen = new Map();
  const note = (px, py) => {
    const i = (py * sw + px) * 4;
    // Quantised, so the anti-aliased near-whites of a scan all count as the
    // same paper rather than as a hundred different colours.
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  };
  for (let px = 0; px < sw; px++) {
    note(px, 0);
    note(px, sh - 1);
  }
  for (let py = 1; py < sh - 1; py++) {
    note(0, py);
    note(sw - 1, py);
  }

  let best = null;
  let bestCount = -1;
  for (const [key, count] of seen) {
    if (count > bestCount || (count === bestCount && key > best)) {
      best = key;
      bestCount = count;
    }
  }
  if (best === null) return "#fff";
  const channel = (shift) => ((best >> shift) & 0xf) * 17;
  return `rgb(${channel(8)},${channel(4)},${channel(0)})`;
}

/**
 * Cover each chord on an already-rendered page and write the new one.
 *
 * @param ctx        the canvas the page has just been drawn on
 * @param chords     from findChords, for this page
 * @param semitones  how far to move them
 * @param flats      whether the key it lands in is written with flats
 */
export function placeChords(ctx, chords, semitones, flats, scale) {
  if (!semitones) return;
  const canvas = ctx.canvas;

  for (const c of chords) {
    const moved = transposeChord(c.text, semitones, flats);
    if (!moved || moved === c.text) continue;

    const x = c.x * scale;
    const y = canvas.height - c.y * scale; // baseline, in canvas coordinates
    const h = c.size * scale;
    const pad = Math.max(2, h * 0.18);
    // Brackets and a comma hang below the baseline, and a patch that stops at
    // it leaves their feet behind on the page under the new chord.
    const below = Math.max(3, h * 0.32);
    const top = y - h - pad;
    const boxW = c.w * scale + pad * 2;
    const boxH = h + pad + below;

    ctx.fillStyle = backgroundAround(ctx, x - pad, top, boxW, boxH);
    ctx.fillRect(x - pad, top, boxW, boxH);

    ctx.fillStyle = "#000";
    ctx.textBaseline = "alphabetic";
    let size = h;
    const font = (s) => `600 ${s}px ui-sans-serif, system-ui, Helvetica, Arial, sans-serif`;
    ctx.font = font(size);
    // Shrink only when the new symbol is wider than the old one, so that a C
    // turning into a C# does not run into the chord beside it.
    const room = Math.max(c.w * scale, h * 1.2);
    const width = ctx.measureText(moved).width;
    if (width > room * 1.35) ctx.font = font(size * ((room * 1.35) / width));
    ctx.fillText(moved, x, y);
  }
}
