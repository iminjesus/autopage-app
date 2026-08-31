/**
 * AutoPage — automatic page turning for PDF sheet music.
 *
 * The app never tries to know where in the score the player is. It answers one
 * question per page: has the player reached the end of it yet?
 *
 * Two weak signals combine into one reliable trigger:
 *
 *   1. Coarse timing opens a window. A rehearsal pass measures how long each
 *      page ran, so the app knows roughly when the end is due. It only has to
 *      be right within a few seconds, and it re-anchors on every turn so error
 *      never accumulates across pages.
 *   2. Inside that window only, a chroma template matcher confirms the moment
 *      against how the end of that page sounded during the rehearsal.
 *
 * Neither works alone: timing drifts, and the matcher would fire on false
 * positives if it listened across the whole page. Gated together they don't.
 *
 * Nothing here reads the score. No optical music recognition, no staff
 * detection — the templates come from the audio, so the PDF is only ever drawn.
 * See docs/design.md.
 */

// Shown on screen so a bug report can name the build it came from, rather than
// leaving "did the pull actually take?" as an open question.
const BUILD = "2026-08-31q yaw-invariant-eye";

import * as pdfjsLib from "./vendor/pdf.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.js";

// --- Tuning constants ---
const FFT_SIZE = 8192; // ~6 Hz bins at 48 kHz — enough to resolve pitch classes
const HOP_MS = 100; // one chroma frame per 100ms; also the matcher's rate
const TEMPLATE_S = 4.0; // context length; one measure is not distinctive enough
const TEMPLATE_SONORITIES = 10; // how much of a page's ending the score template covers
const BUFFER_S = 12; // rolling history the matcher searches
const MATCH_THRESHOLD = 0.85; // measured: ~0.9 at a page end, ~0.5 elsewhere
const MATCH_HOLD_FRAMES = 3; // consecutive confident frames before turning
const ARM_WINDOW_S = 3.5; // floor for the detection window, either side
const ARM_WINDOW_FRACTION = 0.15; // widen it for a performance taken off-tempo
const TONALITY_MIN = 0.55; // measured: hiss and hum reach 0.40, played notes 0.94
const TONAL_RUN = 3; // frames of held pitch before it counts as a note (300ms)
const SILENCE_HOLD_S = 1.0; // silence shorter than this is a rest, not a stop
const MIN_HZ = 70;
const MAX_HZ = 5000;
const MAX_CACHED_PAGES = 6;
const MAX_DPR = 2; // a 3x phone triples raster cost for no gain on a score

const state = {
  doc: null,
  page: 1,
  pageCount: 0,
  mode: "manual", // "manual" | "auto"
  armed: false,
  confidence: 0,
  hold: 0,
  pageStartedAt: 0, // seconds; when the current page began
  // How long a bar lasts, measured from the player rather than typed in. The
  // seed only has to be the right order of magnitude; the first audio-driven
  // turn replaces it with the real thing.
  secondsPerBar: 2.0,
  tempoKnown: false,
  leadBars: 1,
  measures: new Map(), // page -> measures counted from the PDF's own drawing ops
  sonorities: new Map(), // page -> harmonies read off the page, in order
  templates: new Map(), // page -> chroma heard just before a previous turn
  playing: false, // is anything actually sounding right now
  tonality: 0, // 0.29 is a flat chroma (noise); a played note is well above
  started: false, // has the performance begun at all
  turnAt: null, // seconds; when the schedule says this page ends
  turnedBy: null, // "audio" | "schedule" | "manual" — what actually fired the last turn
  anchorIsEarly: false, // the anchor sits `leadBars` before the page's first bar
};

const el = {};
for (const id of [
  "score", "scoreCanvas", "scoreEmpty", "fileInput", "scoreError",
  "hud", "hudPage", "hudMode", "hudArmed", "nav", "prevBtn", "nextBtn",
  "setupPanel", "setupToggle", "startBtn", "leadInput", "diag",
  "gestureCheck", "camPreview", "gestureLive", "gestureAsym", "gestureStatus", "calibrateBtn",
  "holdField", "holdInput",
  "meter", "meterFill", "meterValue", "setupStatus",
]) el[id] = document.getElementById(id);

/**
 * Wall clock, in seconds. The arming window tolerates several seconds of error
 * by design, so there is no reason to reach for the audio clock here.
 */
const nowSeconds = () => performance.now() / 1000;

// ============================================================
// Score view — draw the PDF, nothing more
//
// It does have to be *fast*. A page turn that visibly stutters is worse than no
// automation at all, so neighbouring pages are rasterized ahead of time and the
// turn itself is only a blit.
// ============================================================

const pageCache = new Map(); // "page@layout" -> {canvas, cssW, cssH}
const pending = new Map();
let showToken = 0; // guards against a slow render landing after a newer turn

function layoutKey() {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const r = el.score.getBoundingClientRect();
  return `${Math.round(r.width)}x${Math.round(r.height)}@${dpr}`;
}

function fitScale(baseViewport) {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const r = el.score.getBoundingClientRect();
  const scale = Math.min(r.width / baseViewport.width, r.height / baseViewport.height);
  return { scale: scale * dpr, dpr };
}

async function rasterize(n) {
  const page = await state.doc.getPage(n);
  const { scale, dpr } = fitScale(page.getViewport({ scale: 1 }));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();

  return { canvas, cssW: canvas.width / dpr, cssH: canvas.height / dpr };
}

function rasterizeCached(n) {
  const key = `${n}@${layoutKey()}`;
  const hit = pageCache.get(key);
  if (hit) return Promise.resolve(hit);
  if (pending.has(key)) return pending.get(key);

  const job = rasterize(n)
    .then((entry) => {
      pageCache.set(key, entry);
      while (pageCache.size > MAX_CACHED_PAGES) {
        pageCache.delete(pageCache.keys().next().value);
      }
      return entry;
    })
    .finally(() => pending.delete(key));

  pending.set(key, job);
  return job;
}

async function showPage(n) {
  if (!state.doc) return;
  const token = ++showToken;

  const entry = await rasterizeCached(n);
  if (token !== showToken) return; // a newer turn already won

  el.scoreCanvas.width = entry.canvas.width;
  el.scoreCanvas.height = entry.canvas.height;
  el.scoreCanvas.style.width = `${entry.cssW}px`;
  el.scoreCanvas.style.height = `${entry.cssH}px`;
  el.scoreCanvas.getContext("2d", { alpha: false }).drawImage(entry.canvas, 0, 0);

  // The next page is what a turn will need; the previous one is what a mistaken
  // turn has to fall back to. Both are worth having ready.
  if (n + 1 <= state.pageCount) rasterizeCached(n + 1).catch(() => {});
  if (n - 1 >= 1) rasterizeCached(n - 1).catch(() => {});
}

async function openScore(file) {
  const data = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data }).promise;

  state.doc = doc;
  state.pageCount = doc.numPages;
  state.page = 1;
  state.templates.clear();
  state.measures.clear();
  state.sonorities.clear();
  pageCache.clear();
  pending.clear();
  resyncTiming();

  el.scoreEmpty.hidden = true;
  el.scoreCanvas.hidden = false;
  el.hud.hidden = false;
  el.nav.hidden = false;
  el.setupPanel.hidden = false;
  collapseSetup(false); // rehearsal is the next thing to do, so keep it open

  await showPage(1);
  render();

  for (let n = 1; n <= doc.numPages; n++) {
    const read = await readPage(doc, n);
    state.measures.set(n, read.measures);
    state.sonorities.set(n, read.sonorities);
  }
  buildTemplates();
  state.tempoKnown = false;
  const counts = [...state.measures.values()];
  if (counts.every((c) => c === null)) {
    setStatus("No staves found — a scanned score can only be turned by hand.");
  } else {
    setStatus(`Measures per page: ${counts.map((c) => c ?? "?").join(", ")}. Press Start and play.`);
  }
  resyncTiming();
  render();
}

// ============================================================
// Reading the score — from the PDF's drawing commands, not its pixels
//
// An engraved PDF is not a picture of a score, it is the instructions that drew
// one: staff lines are long horizontal strokes, barlines are vertical strokes
// exactly one staff tall. Counting measures is therefore a matter of reading
// the file, not recognising an image — no OMR, and nothing the player has to
// tell us. Scanned scores have none of this and fall back to manual.
// ============================================================

/** Multiply two PDF matrices, `outer` applied after `inner`. */
function matMul(outer, inner) {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

/** Straight segments from a page's operator list, in page space. */
function extractSegments(ops) {
  const segs = [];
  const stack = [];
  let m = [1, 0, 0, 1, 0, 0];
  const at = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === pdfjsLib.OPS.save) stack.push(m.slice());
    else if (fn === pdfjsLib.OPS.restore) m = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === pdfjsLib.OPS.transform) m = matMul(m, ops.argsArray[i]);
    else if (fn === pdfjsLib.OPS.constructPath) {
      const [fns, args] = ops.argsArray[i];
      let a = 0;
      let cur = null;
      for (const op of fns) {
        if (op === pdfjsLib.OPS.rectangle) {
          // Some engravers draw barlines and staff lines as filled rectangles.
          const [x, y, w, h] = args.slice(a, a + 4);
          a += 4;
          segs.push(w > h ? [...at(x, y + h / 2), ...at(x + w, y + h / 2)]
                          : [...at(x + w / 2, y), ...at(x + w / 2, y + h)]);
        } else if (op === pdfjsLib.OPS.moveTo) {
          cur = at(args[a], args[a + 1]);
          a += 2;
        } else if (op === pdfjsLib.OPS.lineTo) {
          const next = at(args[a], args[a + 1]);
          a += 2;
          if (cur) segs.push([...cur, ...next]);
          cur = next;
        } else if (op === pdfjsLib.OPS.curveTo) {
          cur = at(args[a + 4], args[a + 5]);
          a += 6;
        } else if (op === pdfjsLib.OPS.closePath) {
          cur = null;
        }
      }
    }
  }
  return segs;
}

/** Group sorted staff-line positions into staves of five evenly spaced lines. */
function findStaves(ys) {
  const staves = [];
  for (let i = 0; i + 4 < ys.length; ) {
    const gaps = [];
    for (let k = 0; k < 4; k++) gaps.push(ys[i + k + 1] - ys[i + k]);
    const mean = gaps.reduce((a, b) => a + b, 0) / 4;
    if (mean > 0 && gaps.every((g) => Math.abs(g - mean) < mean * 0.2)) {
      staves.push({ top: ys[i], bottom: ys[i + 4], spacing: mean });
      i += 5;
    } else {
      i += 1;
    }
  }
  return staves;
}

/**
 * Everything readable on one page: how many measures it holds, and the
 * harmonies drawn on it in order.
 * @returns {{measures: number|null, sonorities: Array}}
 */
async function readPage(doc, n) {
  const empty = { measures: null, sonorities: [] };
  const page = await doc.getPage(n);
  const segs = extractSegments(await page.getOperatorList());
  const textContent = await page.getTextContent();
  page.cleanup();
  if (!segs.length) return empty;

  const xs = segs.flatMap((s) => [s[0], s[2]]);
  const width = Math.max(...xs) - Math.min(...xs);

  const horizontal = segs.filter(
    (s) => Math.abs(s[3] - s[1]) < 1 && Math.abs(s[2] - s[0]) > width * 0.3
  );
  const ys = [...new Set(horizontal.map((s) => Math.round(s[1] * 10) / 10))].sort((a, b) => a - b);
  const staves = findStaves(ys);
  if (!staves.length) return empty;

  const staffHeight = staves[0].bottom - staves[0].top;
  const verticals = segs.filter((s) => Math.abs(s[2] - s[0]) < 1);

  // Staves of one system share their barlines, so counting per staff counts
  // every barline twice on a piano score. Two staves belong to the same system
  // when a barline actually bridges the gap between them — a geometric guess at
  // the spacing gets this wrong, because the gap varies with what is engraved
  // in it.
  const systems = [{ top: staves[0].top, bottom: staves[0].bottom }];
  for (let i = 1; i < staves.length; i++) {
    const gapTop = staves[i - 1].bottom;
    const gapBottom = staves[i].top;
    const bridged = verticals.some((s) => {
      const lo = Math.min(s[1], s[3]);
      const hi = Math.max(s[1], s[3]);
      return lo <= gapTop + staffHeight * 0.1 && hi >= gapBottom - staffHeight * 0.1;
    });
    if (bridged) systems[systems.length - 1].bottom = staves[i].bottom;
    else systems.push({ top: staves[i].top, bottom: staves[i].bottom });
  }
  // PDF y grows upward, so the system highest on the page has the largest y.
  // Sorting ascending reads the score bottom-up.
  systems.sort((a, b) => b.bottom - a.bottom);

  let total = 0;
  for (const sys of systems) {
    // A system opens with a vertical rule joining its staves. It looks exactly
    // like a barline but closes no measure, so drop anything sitting on the
    // left edge of the staff lines.
    const leftEdge = Math.min(
      ...horizontal
        .filter((h) => h[1] >= sys.top - 1 && h[1] <= sys.bottom + 1)
        .map((h) => Math.min(h[0], h[2]))
    );
    const bars = verticals.filter((s) => {
      const lo = Math.min(s[1], s[3]);
      const hi = Math.max(s[1], s[3]);
      // Exactly one staff tall: shorter is a stem, and anything outside the
      // system belongs to a neighbour.
      return hi - lo > staffHeight * 0.9 && lo >= sys.top - 1 && hi <= sys.bottom + 1;
    });

    // A repeat sign is two strokes a hair apart but only one measure boundary.
    const merged = [];
    for (const x of bars.map((s) => s[0]).sort((a, b) => a - b)) {
      if (x < leftEdge + staffHeight * 0.1) continue;
      if (!merged.length || x - merged[merged.length - 1] > staffHeight * 0.15) merged.push(x);
    }
    total += merged.length;
  }

  const glyphs = readGlyphs(textContent, staves);
  return { measures: total || null, sonorities: readSonorities(glyphs, staves, systems) };
}

// ============================================================
// Reading the notes
//
// Glyphs carry no usable characters — the embedded font is a subset with
// arbitrary codes — so they are classified by geometry instead. Advance width
// against staff spacing separates noteheads from dots, clefs and accidentals,
// and a clef glyph sits on its own reference line, which fixes the pitch of
// every step above and below it.
// ============================================================

const CLEF_BOTTOM_DEGREE = { 2: 30, 4: 26, 6: 18 }; // treble G4 / alto C4 / bass F3
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B, as letter indices
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];
const LETTER_SEMITONE = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B

/**
 * Glyphs near a staff, with their staff step.
 *
 * Glyph codes only mean anything inside one font — a subset font numbers its
 * glyphs from zero, so the brace font's glyph 0 and the music font's notehead
 * are both U+0 and are not remotely the same thing. Everything downstream keys
 * on font and code together.
 */
function readGlyphs(textContent, staves) {
  const out = [];
  for (const item of textContent.items) {
    const code = item.str.codePointAt(0);
    if (code === undefined || code === 32) continue;
    if (!(item.width > 0)) continue; // braces and other zero-advance decoration
    const x = item.transform[4];
    const y = item.transform[5];
    // Distance to the staff's *band*, not to its outermost lines: a note in the
    // middle of one staff is further from both of its edges than a note sitting
    // just outside a neighbouring staff, and picking the nearest edge hands it
    // to the wrong staff — and so to the wrong clef.
    let staff = null;
    for (const st of staves) {
      const d = y < st.top ? st.top - y : y > st.bottom ? y - st.bottom : 0;
      if (!staff || d < staff.d) staff = { st, d };
    }
    if (!staff || staff.d > (staff.st.bottom - staff.st.top) * 1.5) continue;
    out.push({
      key: `${item.fontName}|${code}`,
      font: item.fontName,
      x,
      y,
      staff: staff.st,
      width: item.width / staff.st.spacing,
      step: Math.round((y - staff.st.top) / (staff.st.spacing / 2)),
    });
  }
  return out;
}

/**
 * Which glyph codes are noteheads.
 *
 * Black and void heads are both a little over one staff space wide. Dots are
 * half that, clefs several times it, and accidentals fall just under — close
 * enough that the width test alone is not safe, so a class must also move
 * around vertically. Clefs and key signatures never do.
 */
function noteheadCodes(glyphs) {
  const classes = new Map();
  for (const g of glyphs) {
    const c = classes.get(g.key) || { widths: [], steps: [], font: g.font };
    c.widths.push(g.width);
    c.steps.push(g.step);
    classes.set(g.key, c);
  }

  const keys = new Set();
  const fonts = new Set();
  for (const [key, c] of classes) {
    if (c.steps.length < 3) continue;
    const w = c.widths.slice().sort((a, b) => a - b)[c.widths.length >> 1];
    if (w < 1.15 || w > 1.7) continue;
    const mean = c.steps.reduce((a, b) => a + b, 0) / c.steps.length;
    const spread = c.steps.reduce((a, b) => a + (b - mean) ** 2, 0) / c.steps.length;
    if (spread < 0.5) continue; // a key signature repeats one step exactly
    keys.add(key);
    fonts.add(c.font);
  }
  // Whichever font drew the noteheads drew the clefs and accidentals too. Page
  // numbers and titles are the right size to be mistaken for either.
  return { keys, fonts };
}

/** The clef on a staff, as the diatonic degree of its bottom line. */
function clefDegree(glyphs, staff) {
  const wide = glyphs
    .filter((g) => g.staff === staff && g.width > 2.5)
    .sort((a, b) => a.x - b.x);
  for (const g of wide) {
    const deg = CLEF_BOTTOM_DEGREE[g.step];
    if (deg !== undefined) return deg;
  }
  return CLEF_BOTTOM_DEGREE[2]; // treble is the safe default
}

/** Letters altered by the key signature, from the accidentals after the clef. */
function keySignature(glyphs, staff, bottomDegree, firstNoteX) {
  const accidentals = glyphs.filter(
    (g) => g.staff === staff && g.x < firstNoteX && g.width > 0.8 && g.width < 1.15
  );
  if (!accidentals.length) return new Map();

  // A key signature always starts on the same letter: sharps on F, flats on B.
  // Reading the direction of the run instead fails on a signature of one, where
  // there is no direction to read.
  accidentals.sort((a, b) => a.x - b.x);
  const firstLetter = (((bottomDegree + accidentals[0].step) % 7) + 7) % 7;
  const flats = firstLetter === 6;
  const order = flats ? FLAT_ORDER : SHARP_ORDER;
  const shift = flats ? -1 : 1;

  const map = new Map();
  for (let i = 0; i < Math.min(accidentals.length, 7); i++) map.set(order[i], shift);
  return map;
}

/** Pitch class 0..11 for a notehead. */
function pitchClass(step, bottomDegree, key) {
  const degree = bottomDegree + step;
  const letter = ((degree % 7) + 7) % 7;
  return (LETTER_SEMITONE[letter] + (key.get(letter) || 0) + 120) % 12;
}

/**
 * The page's music as a sequence of sonorities — noteheads sharing an x are
 * sounding together. Durations are ignored on purpose: the matcher warps time,
 * so the order of the harmonies is all it needs.
 */
function readSonorities(glyphs, staves, systems) {
  const { keys, fonts } = noteheadCodes(glyphs);
  const spacing = staves[0].spacing;
  const events = [];

  for (const staff of staves) {
    const staffGlyphs = glyphs.filter((g) => g.staff === staff && fonts.has(g.font));
    const notes = staffGlyphs.filter((g) => keys.has(g.key)).sort((a, b) => a.x - b.x);
    if (!notes.length) continue;
    const bottom = clefDegree(staffGlyphs, staff);
    const key = keySignature(staffGlyphs, staff, bottom, notes[0].x);
    const system = systems.findIndex((sys) => staff.top >= sys.top - 1 && staff.bottom <= sys.bottom + 1);
    for (const n of notes) {
      events.push({ system: system < 0 ? 0 : system, x: n.x, pc: pitchClass(n.step, bottom, key) });
    }
  }

  events.sort((a, b) => a.system - b.system || a.x - b.x);

  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && last.system === e.system && e.x - last.x < spacing * 0.8) last.pcs.add(e.pc);
    else out.push({ system: e.system, x: e.x, pcs: new Set([e.pc]) });
  }
  return out;
}

/**
 * Expected chroma for the moment each page should turn.
 *
 * The template comes from the page itself, so the very first run through a
 * score can be corrected by the music — nothing has to be heard first. It ends
 * `leadBars` before the page does, because matching the final chord would fire
 * the turn exactly when the page is already over.
 */
function buildTemplates() {
  state.templates.clear();
  for (const [n, sonorities] of state.sonorities) {
    const bars = state.measures.get(n);
    if (!bars || sonorities.length < TEMPLATE_SONORITIES * 1.5) continue;
    const drop = Math.round(state.leadBars * (sonorities.length / bars));
    const end = sonorities.length - drop;
    if (end < TEMPLATE_SONORITIES) continue;
    state.templates.set(n, chromaOf(sonorities.slice(end - TEMPLATE_SONORITIES, end)));
  }
}

/** One unit-length chroma frame per sonority. */
function chromaOf(sonorities) {
  return sonorities.map((s) => {
    const v = new Float32Array(12);
    for (const pc of s.pcs) v[pc] = 1;
    let norm = Math.sqrt([...v].reduce((a, b) => a + b * b, 0)) || 1;
    for (let i = 0; i < 12; i++) v[i] /= norm;
    return v;
  });
}

// ============================================================
// Scheduling — when this page runs out
// ============================================================

const secondsPerBar = () => state.secondsPerBar;

/**
 * Set the moment this page is due to end, or null if it cannot be known.
 *
 * The lead is only subtracted once. After an early turn the anchor already sits
 * `leadBars` before the page's first bar, so every later page is exactly its
 * own length — subtracting again would put the app a bar further behind the
 * music on every page.
 */
function scheduleTurn() {
  const bars = state.measures.get(state.page);
  if (!bars || state.page >= state.pageCount) {
    state.turnAt = null;
    return;
  }
  const lead = state.anchorIsEarly ? 0 : state.leadBars;
  state.turnAt = state.pageStartedAt + (bars - lead) * secondsPerBar();
}

/** Bars left on this page. Diagnostics only — never shown over the score. */
function barsRemaining(now) {
  if (state.turnAt === null) return null;
  return Math.max(0, (state.turnAt - now) / secondsPerBar());
}

/**
 * How far either side of the estimate to listen.
 *
 * Until a page has been timed there is no tempo to speak of, so the window
 * covers most of the page rather than pretending to know where the ending is.
 * Once one page has been heard out, it tightens to a couple of bars.
 */
function armSlack() {
  if (!state.tempoKnown) {
    const bars = state.measures.get(state.page) || 8;
    return bars * secondsPerBar() * 0.6;
  }
  return Math.max(ARM_WINDOW_S, secondsPerBar() * 2);
}

/** True while the audio detector should be listening. */
function isArmed(now) {
  if (state.turnAt === null) return false;
  return Math.abs(now - state.turnAt) <= armSlack();
}

/**
 * Re-anchor to a known position. Called on every turn — automatic or manual —
 * which is what keeps timing error from accumulating across pages.
 */
function resyncTiming() {
  state.pageStartedAt = nowSeconds();
  state.hold = 0;
  scheduleTurn();
}

// ============================================================
// Audio input and chroma features
// ============================================================

let audioCtx = null;
let micStream = null;
let analyser = null;
let featureTimer = null;
let spectrum = null;
let silentSince = null;
let heardAnything = false;
let tonalRun = 0;
const chromaLog = []; // {t, c: Float32Array(12)}, oldest first

/**
 * Is the instrument sounding?
 *
 * Judged by whether the sound has pitch, not by how loud it is. Loudness fails
 * in exactly the case that matters: a quiet room still has a floor, and any
 * level-based gate eventually decides that the floor is a performance. Room
 * noise is broadband and spreads evenly across the twelve pitch classes, so its
 * chroma is flat — a unit vector spread over twelve bins peaks at 0.29 — while
 * a played note concentrates most of its energy into one or two of them.
 *
 * Near-silence never gets this far: chromaFrom ignores bins at the analyser's
 * floor, so a silent input produces a zero vector and no tonality at all.
 */
function updatePlaying(chroma) {
  let peak = 0;
  for (let i = 0; i < 12; i++) if (chroma[i] > peak) peak = chroma[i];

  // Random noise lands on one pitch class often enough to clear the threshold
  // for a single frame. A played note holds for hundreds of milliseconds, so
  // requiring a run of frames separates them without touching the threshold.
  tonalRun = peak > TONALITY_MIN ? tonalRun + 1 : 0;
  const tonal = tonalRun >= TONAL_RUN;

  if (tonal) {
    silentSince = null;
    heardAnything = true;
  } else if (silentSince === null) {
    silentSince = nowSeconds();
  }

  state.tonality = peak;
  // A rest is silence too — but only once something has actually sounded.
  // Without that guard the grace period counts as playing from the first
  // frame, and an empty room starts the clock.
  state.playing = tonal || (heardAnything && nowSeconds() - silentSince < SILENCE_HOLD_S);
}

async function startListening() {
  if (analyser) return;

  micStream = await navigator.mediaDevices.getUserMedia({
    // Every one of these mangles music: gain control pumps, noise suppression
    // eats sustained tones, echo cancellation subtracts what the room plays.
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0; // smoothing would blur note onsets
  audioCtx.createMediaStreamSource(micStream).connect(analyser);
  // Deliberately not connected to the destination — that is a feedback loop.

  spectrum = new Float32Array(analyser.frequencyBinCount);
  featureTimer = setInterval(onFeatureFrame, HOP_MS);
}

function stopListening() {
  clearInterval(featureTimer);
  featureTimer = null;
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  analyser = null;
  if (audioCtx) audioCtx.close();
  audioCtx = null;
}

/**
 * Fold an FFT magnitude spectrum into 12 pitch classes.
 *
 * Chroma is used because it is forgiving in exactly the ways a performance
 * needs: a fluffed note moves one bin, an octave doubling moves none, and a
 * different instrument or room changes the timbre but not the pitch classes.
 */
function chromaFrom(db) {
  const out = new Float32Array(12);
  const binHz = audioCtx.sampleRate / FFT_SIZE;

  for (let i = 1; i < db.length; i++) {
    const f = i * binHz;
    if (f < MIN_HZ || f > MAX_HZ) continue;
    if (db[i] <= -90) continue; // the analyser's floor; nothing but noise below
    const mag = 10 ** (db[i] / 20);
    const pc = Math.round(12 * Math.log2(f / 440) + 69) % 12;
    out[(pc + 12) % 12] += mag;
  }

  let norm = 0;
  for (let i = 0; i < 12; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 12; i++) out[i] /= norm;
  return out;
}

function onFeatureFrame() {
  analyser.getFloatFrequencyData(spectrum);
  const chroma = chromaFrom(spectrum);
  updatePlaying(chroma);
  chromaLog.push({ t: nowSeconds(), c: chroma });

  const cutoff = nowSeconds() - BUFFER_S;
  while (chromaLog.length && chromaLog[0].t < cutoff) chromaLog.shift();

  if (state.mode !== "auto") return;

  // The schedule counts *played* time, not wall time. Before the first note it
  // has not started, and while nothing is sounding it does not advance — a page
  // must never turn under a player who is sitting still.
  if (!state.started) {
    if (!state.playing) {
      state.pageStartedAt = nowSeconds();
      scheduleTurn();
      return;
    }
    state.started = true;
    resyncTiming();
    setStatus("Following the music.");
  } else if (!state.playing) {
    // Hold the schedule where it is rather than letting it run through a
    // silence. On the last page there is no turn to postpone.
    state.pageStartedAt += HOP_MS / 1000;
    if (state.turnAt !== null) state.turnAt += HOP_MS / 1000;
    return;
  }

  detect();
}

/** The last `seconds` of chroma frames, oldest first. */
function recentFrames(seconds) {
  const from = nowSeconds() - seconds;
  return chromaLog.filter((f) => f.t >= from).map((f) => f.c);
}

// ============================================================
// Matcher — subsequence DTW against the rehearsal template
//
// DTW so a performance taken faster or slower than the rehearsal still matches.
// Subsequence — a free start column — so the template can begin anywhere in the
// buffer; only its *end* is pinned to now, which is the moment being detected.
// ============================================================

function distance(a, b) {
  let dot = 0;
  for (let i = 0; i < 12; i++) dot += a[i] * b[i];
  return 1 - dot; // both vectors are unit length, so this is cosine distance
}

/**
 * How well `template` explains the run of live frames ending at now.
 * @returns {number} 0..1
 */
function matchScore(live, template) {
  const m = template.length;
  const n = live.length;
  if (m < 4 || n < m) return 0;

  let prev = new Float64Array(n);
  let curr = new Float64Array(n);
  // Cost alone rewards squeezing the template into a short stretch of live
  // audio, which fires early. Carrying the path length and dividing by it
  // prices a compressed alignment honestly.
  let prevLen = new Float64Array(n);
  let currLen = new Float64Array(n);

  for (let j = 0; j < n; j++) {
    prev[j] = distance(template[0], live[j]); // free start
    prevLen[j] = 1;
  }

  for (let i = 1; i < m; i++) {
    const d0 = distance(template[i], live[0]);
    curr[0] = prev[0] + d0;
    currLen[0] = prevLen[0] + 1;

    for (let j = 1; j < n; j++) {
      let best = prev[j - 1];
      let len = prevLen[j - 1];
      if (prev[j] < best) {
        best = prev[j];
        len = prevLen[j];
      }
      if (curr[j - 1] < best) {
        best = curr[j - 1];
        len = currLen[j - 1];
      }
      curr[j] = best + distance(template[i], live[j]);
      currLen[j] = len + 1;
    }

    let swap = prev; prev = curr; curr = swap;
    swap = prevLen; prevLen = currLen; currLen = swap;
  }

  // Pinned to the newest frame: the template must have just finished.
  return Math.max(0, 1 - prev[n - 1] / prevLen[n - 1]);
}

/**
 * Runs on every chroma frame. Where the music actually is beats where the clock
 * thinks it is, so a confident match turns the page. The schedule still holds
 * the outside of the window: if nothing matches by the time it closes, the page
 * turns anyway rather than stranding the player.
 */
function detect() {
  const now = nowSeconds();
  state.armed = isArmed(now);

  const template = state.templates.get(state.page);
  if (!state.armed || !template) {
    state.confidence = 0;
    state.hold = 0;
    return;
  }


  state.confidence = matchScore(recentFrames(TEMPLATE_S * 1.6), template);

  // The peak is narrow — a couple of frames wide when the performance is off
  // the expected tempo — so demanding a long confident run misses it outright.
  // Two frames, at a threshold set from the measured gap between a real page
  // ending and everything else.
  state.hold = state.confidence >= MATCH_THRESHOLD ? state.hold + 1 : 0;
  if (state.hold >= MATCH_HOLD_FRAMES) {
    state.turnedBy = "audio";
    nextPage();
  }
}

/**
 * Remember how the end of this page sounded. Nobody is asked to do this — it
 * happens on every turn, so a second run through the same score is guided by
 * the music itself rather than by the clock alone.
 */
function captureTemplate() {
  if (!analyser) return;
  const frames = recentFrames(TEMPLATE_S);
  if (frames.length >= 8) state.templates.set(state.page, frames);
}

// ============================================================
// Gesture — winking to turn
//
// A normal blink is symmetric and a wink is not, so the signal is the
// *difference* between the eyes rather than how shut either one is. That is
// what makes it survive the things that break absolute measures: glasses
// reflecting the screen, stage lighting, or someone squinting at a hard
// passage all affect both eyes together and cancel out of a difference.
//
// Right eye forward, left eye back. Back matters at least as much: it is the
// recovery path when a page turns at the wrong moment.
// ============================================================

// How long a wink lasts is personal, and it is not something that can be
// settled from outside someone's face: two rounds of guessing at it both came
// back too slow. Sampling runs fast enough that the required length is a
// setting rather than a constant, and a run of two frames is kept as the floor
// so a single glitched frame can never fire a turn.
const GESTURE_FPS = 30;
const GESTURE_COOLDOWN_S = 0.6;
const HOLD_KEY = "autopage.winkHold";
let gestureHoldMs = 70;

// Head pose is measured but gates nothing. Turning the head hides part of one
// eye and the model reports that as closing, which is where the false turns
// come from — but two attempts to correct for it were designed against
// guesses rather than against a real face, and both made things worse. It is
// displayed instead, so the correction can be built from what actually
// happens rather than from what seemed likely.

const holdFrames = () =>
  Math.max(2, Math.round((gestureHoldMs * GESTURE_FPS) / 1000));
// On the eyelid-geometry scale one eye fully shut against one fully open is
// 1.0, so this is a little under half a wink.
const DEFAULT_ASYM_THRESHOLD = 0.45;
const CALIBRATION_KEY = "autopage.wink";
// Stamped into a saved calibration. Its numbers only mean anything on the scale
// that produced them, and the eyelid-geometry scale is not the blink-score one.
const CALIBRATION_SCALE = "eyelid-v1";

let landmarker = null;
let camStream = null;
let gestureTimer = null;
let gestureHold = 0;
let gestureDirection = 0;
// The last few frames' verdicts. A quick wink can dip under the threshold for
// a frame on its way up or down, and demanding an unbroken run throws the
// whole gesture away over that one frame.
const recent = [];
let lastGestureAt = 0;
let gestureLatched = false;
let calibration = null; // {threshold, separation}
let calibrating = null; // {phase, samples, until}
let staleCalibration = false; // a saved calibration from an older measurement
let prevPoints = null;
let headMotion = 0;
let headYaw = 0;
const yawHistory = [];
let yawSwing = 0;

// Shaking the head sweeps the yaw back and forth; a wink does not move the
// head at all. So the two are separable on an axis that has nothing to do with
// how long or how hard the wink is — which is what keeps making the gesture
// shorter from costing anything here.
// Swept against simulated shakes from 0.8 to 2Hz and playing sway up to 0.5Hz:
// 0.12 is the only value that vetoes every shake and no sway. Sway travels
// slowly enough that little of it lands inside a 150ms window; a shake is
// mostly travel.
const MAX_YAW_SWING = 0.12; // inter-eye widths of yaw travel within ~150ms
const MAX_YAW = 0.25; // head turned this far off centre: eye geometry unreliable
// A 30fps readout cannot be read by eye, so the peaks are held. Without this
// there is no way to tell "the model never sees the eye close" apart from
// "the threshold is wrong", and both have been guessed at for several rounds.
const peaks = { l: 0, r: 0, net: 0, at: 0 };

function notePeaks(left, right, net) {
  const now = nowSeconds();
  if (now - peaks.at > 3) {
    peaks.l = peaks.r = peaks.net = 0;
    peaks.at = now;
  }
  peaks.l = Math.max(peaks.l, left);
  peaks.r = Math.max(peaks.r, right);
  peaks.net = Math.max(peaks.net, Math.abs(net));
}

/**
 * Say whether a calibration is stored, without needing the camera on.
 *
 * The status only appeared once the gesture was switched on, so the only way to
 * check whether a calibration had survived was to start the camera and look —
 * which is a strange thing to have to do to answer "is it saved?".
 */
function showCalibrationState() {
  el.gestureStatus.hidden = false;
  if (calibration) {
    el.gestureStatus.textContent =
      `Calibrated ${calibration.savedAt ?? "earlier"}, saved in this browser ` +
      `(separation x${(calibration.separation ?? 0).toFixed(1)}, threshold ` +
      `${(calibration.threshold ?? 0).toFixed(2)}). Recalibrate any time to replace it.`;
  } else if (staleCalibration) {
    el.gestureStatus.textContent =
      "A saved calibration was discarded — it was measured the old way, before " +
      "the switch to eyelid geometry, so its numbers mean nothing now. " +
      "Calibrate once more and it will stick.";
  } else {
    el.gestureStatus.textContent =
      "Not calibrated — running on defaults. Switch on Wink to turn, then press " +
      "Calibrate. It is stored in this browser and only needs doing once.";
  }
}

function loadHold() {
  const stored = Number(localStorage.getItem(HOLD_KEY));
  if (stored >= 50 && stored <= 400) gestureHoldMs = stored;
  el.holdInput.value = String(gestureHoldMs);
}

function loadCalibration() {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    calibration = raw ? JSON.parse(raw) : null;
    // Only one rule decides whether a calibration is usable, and it runs when
    // the calibration is made. Having a second, stricter rule here meant a
    // result could be accepted, shown as saved, and then silently thrown away
    // on the next load — which looked exactly like calibration not persisting.
    // What is checked here is only whether it came from this scale at all.
    if (calibration && calibration.scale !== CALIBRATION_SCALE) {
      calibration = null;
      staleCalibration = true;
      localStorage.removeItem(CALIBRATION_KEY);
    }
    if (calibration?.noiseLevel && calibration?.rightLevel && calibration?.leftLevel) {
      calibration.threshold = thresholdFrom(
        calibration.noiseLevel,
        Math.min(calibration.rightLevel, calibration.leftLevel)
      );
    }
  } catch {
    calibration = null; // private windows and blocked storage are not errors
  }
}

/**
 * Where to put the line between a blink and a wink.
 *
 * Halfway between the two is too high: a quick wink never fully closes the eye,
 * so it lands well short of the level a held one reaches. A third of the way up
 * still clears blink noise several times over — the asymmetry does the
 * rejecting here, not the height of the bar.
 */
function thresholdFrom(noiseLevel, winkLevel) {
  return Math.max(noiseLevel * 1.5, noiseLevel + 0.25 * (winkLevel - noiseLevel), 0.15);
}

const asymThreshold = () => calibration?.threshold ?? DEFAULT_ASYM_THRESHOLD;

async function startGesture() {
  if (landmarker) return;

  // Imported here rather than at the top: the model and its runtime are 13MB,
  // and someone who never turns this on should never pay for them.
  const { FaceLandmarker, FilesetResolver } = await import("./vendor/mediapipe/vision_bundle.js");
  const fileset = await FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm");
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "./vendor/mediapipe/face_landmarker.task" },
    outputFaceBlendshapes: true,
    runningMode: "VIDEO",
    numFaces: 1,
  });

  camStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
  });
  el.camPreview.srcObject = camStream;
  await el.camPreview.play();

  gestureTimer = setInterval(onGestureFrame, Math.round(1000 / GESTURE_FPS));
  el.gestureLive.hidden = false;
  el.holdField.hidden = false;
}

function stopGesture() {
  clearInterval(gestureTimer);
  gestureTimer = null;
  gestureLatched = false;
  gestureHold = 0;
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  el.camPreview.srcObject = null;
  el.camPreview.hidden = true;
  el.gestureLive.hidden = true;
  el.holdField.hidden = true;
  landmarker?.close();
  landmarker = null;
}

function blendshape(shapes, name) {
  return shapes.find((c) => c.categoryName === name)?.score ?? 0;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

// Eyelid geometry, straight off the mesh.
//
// The blendshape route measured a wink at 0.09 of difference on a face whose
// eyes were plainly doing different things — both scores rose together, so the
// model was reporting "an eye is closing" without resolving which. The eyelid
// landmarks do not have that problem: the gap between the lids is a distance,
// and one eye's distance closing while the other's does not is unambiguous.
const EYE_POINTS = {
  // upper lid, lower lid, inner corner, outer corner
  left: [386, 374, 362, 263],
  right: [159, 145, 133, 33],
};

// Midline points, top of the forehead to the bottom of the chin.
const FACE_TOP = 10;
const FACE_BOTTOM = 152;

/**
 * Lid gap, scaled so that turning the head does not change it.
 *
 * Dividing by the eye's own width — the obvious choice — fails exactly where
 * this was reported failing: yaw foreshortens horizontal distances, so the far
 * eye's width shrinks while its lid gap does not, and the ratio climbs with
 * nobody having moved an eyelid. Turning away and back then lands a page turn.
 *
 * Rotating about a vertical axis leaves vertical distances alone, so the face's
 * own height is a scale that survives it, and it tracks distance from the
 * camera the same way the eye width did.
 */
function aspectRatio(landmarks, which) {
  const [up, low] = EYE_POINTS[which].map((i) => landmarks[i]);
  const top = landmarks[FACE_TOP];
  const bottom = landmarks[FACE_BOTTOM];
  if (!up || !low || !top || !bottom) return null;
  const height = dist(top, bottom);
  return height > 0 ? dist(up, low) / height : null;
}

// The open-eye ratio differs per person, per camera and per pair of glasses, so
// it is learned rather than assumed: the widest recently seen counts as open.
const openRef = { left: 0.045, right: 0.045 };

function closedness(landmarks, which, poseReliable) {
  const ear = aspectRatio(landmarks, which);
  if (ear === null) return 0;
  // A reference learned while the head was turned away is a reference learned
  // from bad geometry, and it stays wrong long after the head comes back.
  if (poseReliable) {
    openRef[which] = Math.max(ear, openRef[which] * 0.999 + ear * 0.001);
  }
  const ref = Math.max(openRef[which], 0.015);
  return Math.min(1, Math.max(0, 1 - ear / ref));
}

/**
 * How far the head is turned, and how fast it is moving.
 *
 * Both in units of the distance between the eye corners, so they mean the same
 * thing whether the player is close to the camera or far from it. Turning the
 * head moves the nose closer to one eye corner than the other, which is all the
 * yaw estimate needs to be.
 */
function updateHeadPose(landmarks) {
  const nose = landmarks[1];
  const eyeA = landmarks[33];
  const eyeB = landmarks[263];
  if (!nose || !eyeA || !eyeB) return;

  const interEye = dist(eyeA, eyeB) || 1e-6;
  headYaw = (dist(nose, eyeA) - dist(nose, eyeB)) / interEye;

  yawHistory.push(headYaw);
  while (yawHistory.length > Math.round(GESTURE_FPS * 0.15)) yawHistory.shift();
  yawSwing = Math.max(...yawHistory) - Math.min(...yawHistory);

  const points = [nose, eyeA, eyeB];
  headMotion = prevPoints
    ? points.reduce((sum, p, i) => sum + dist(p, prevPoints[i]), 0) / points.length / interEye
    : 0;
  prevPoints = points.map((p) => ({ x: p.x, y: p.y, z: p.z }));
}

function onGestureFrame() {
  if (!landmarker || el.camPreview.readyState < 2) return;
  try {
    gestureFrame();
  } catch (err) {
    // Anything thrown here fires thirty times a second and, without this, does
    // so entirely silently — the gesture simply stops working with no sign of
    // why. Say it on the panel and keep the rest of the app alive.
    console.error("gesture frame failed:", err);
    el.gestureAsym.textContent = `Gesture error: ${err.message}`;
  }
}

function gestureFrame() {

  const result = landmarker.detectForVideo(el.camPreview, performance.now());
  const shapes = result.faceBlendshapes?.[0]?.categories;
  const landmarks = result.faceLandmarks?.[0];
  if (landmarks) updateHeadPose(landmarks);
  if (!shapes) {
    gestureHold = 0;
    // Hold the calibration clock rather than filling a phase with nothing.
    // Without this it counts down against an empty frame and reports a result
    // built from no samples at all.
    prevPoints = null;
    yawHistory.length = 0;
    yawSwing = 0;
    if (calibrating) {
      calibrating.until += 1 / GESTURE_FPS;
      el.gestureAsym.textContent = "Waiting — no face in frame. Move into view.";
    } else {
      el.gestureAsym.textContent = "no face in frame";
    }
    return;
  }

  // Far enough round and the far eye's landmarks are guesswork. Nobody reads a
  // score from there either, so nothing is lost by declining to act on it.
  const poseReliable = Math.abs(headYaw) < MAX_YAW;
  const left = landmarks ? closedness(landmarks, "left", poseReliable) : 0;
  const right = landmarks ? closedness(landmarks, "right", poseReliable) : 0;
  const asym = left - right;

  // Kept only to show alongside, so the two measures can be compared on a real
  // face instead of argued about.
  const bsDiff = blendshape(shapes, "eyeBlinkLeft") - blendshape(shapes, "eyeBlinkRight");

  if (calibrating) return sampleCalibration(asym, Math.max(left, right));

  // Back to judging the raw difference between the eyes.
  //
  // Two attempts to handle head movement on top of this went in and came
  // straight back out: refusing frames while the head moved, and subtracting a
  // slow baseline. The first would have made the gesture unusable, and the
  // second was tuned against simulated signals rather than a real face — it
  // absorbed the wink along with the movement, and the readout below is here
  // because there was no way to see that happening.
  //
  // Movement still needs an answer. It will be a measured one this time.
  const shaking = yawSwing > MAX_YAW_SWING || !poseReliable;

  notePeaks(left, right, asym);
  el.gestureAsym.textContent =
    `now  L ${left.toFixed(2)}  R ${right.toFixed(2)}  diff ${asym >= 0 ? "+" : ""}${asym.toFixed(2)}` +
    `  ${gestureHold}/${holdFrames()}f${!poseReliable ? "  TURNED" : shaking ? "  SHAKING" : ""}\n` +
    `peak L ${peaks.l.toFixed(2)}  R ${peaks.r.toFixed(2)}  diff ${peaks.net.toFixed(2)} ` +
    `/ ${asymThreshold().toFixed(2)}   yaw ${headYaw.toFixed(2)}/${MAX_YAW}` +
    ` swing ${yawSwing.toFixed(2)}/${MAX_YAW_SWING}` +
    `   blendshape diff ${bsDiff >= 0 ? "+" : ""}${bsDiff.toFixed(2)}`;

  if (shaking) {
    recent.length = 0;
    gestureHold = 0;
    gestureDirection = 0;
    return;
  }

  const sign = calibration?.forwardSign ?? 1;
  const signed = asym * sign;
  const direction = signed > asymThreshold() ? 1 : signed < -asymThreshold() ? -1 : 0;

  recent.push(direction);
  while (recent.length > holdFrames() + 1) recent.shift();
  const votes = direction === 0 ? 0 : recent.filter((d) => d === direction).length;
  gestureHold = votes;
  gestureDirection = direction;

  // One turn per wink. A gesture that fires on a hold would otherwise fire
  // again every cooldown for as long as the eye stays shut, and holding a wink
  // a beat too long is the most natural thing in the world — so the eye has to
  // open again before the next one counts.
  if (direction === 0) gestureLatched = false;

  if (
    !gestureLatched &&
    votes >= holdFrames() &&
    nowSeconds() - lastGestureAt > GESTURE_COOLDOWN_S
  ) {
    gestureHold = 0;
    gestureLatched = true;
    lastGestureAt = nowSeconds();
    state.turnedBy = "wink";
    if (direction > 0) nextPage();
    else prevPage();
  }
}

// --- Calibration ---
//
// Thresholds cannot be constants here. What a wink looks like through one
// person's glasses under their lighting is not what it looks like through
// another's, and the only honest way to know whether this works for someone is
// to measure it on their face and show them the number.

const PHASES = [
  { key: "noise", seconds: 6, prompt: "Look at the camera and blink normally." },
  { key: "right", seconds: 6, prompt: "Wink your RIGHT eye and hold. Repeat a few times." },
  { key: "left", seconds: 6, prompt: "Wink your LEFT eye and hold. Repeat a few times." },
];

function startCalibration() {
  if (calibrating) {
    // A second press cancels: a calibration that cannot see a face would
    // otherwise wait forever with no way out.
    calibrating = null;
    el.camPreview.hidden = true;
    el.gestureStatus.textContent = "Calibration cancelled.";
    el.calibrateBtn.textContent = "Calibrate";
    return;
  }
  el.calibrateBtn.textContent = "Cancel";
  calibrating = {
    index: 0,
    samples: { noise: [], right: [], left: [] },
    eyePeaks: { right: 0, left: 0 },
    until: 0,
  };
  el.camPreview.hidden = false;
  nextCalibrationPhase();
}

function nextCalibrationPhase() {
  const phase = PHASES[calibrating.index];
  calibrating.until = nowSeconds() + phase.seconds;
  el.gestureStatus.hidden = false;
  el.gestureStatus.textContent = phase.prompt;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Mean of the strongest `frac` of samples.
 *
 * A wink might be held for half a second of a six-second phase. Measured
 * against a synthetic hold of a known 0.85: at half a second the 90th
 * percentile reads 0.08, because nine tenths of the window is the pauses
 * between winks. The mean of the top tenth reads 0.75, and stays right as the
 * hold gets longer.
 */
function topMean(values, frac) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => b - a);
  const n = Math.max(3, Math.round(sorted.length * frac));
  const top = sorted.slice(0, Math.min(n, sorted.length));
  return top.reduce((a, b) => a + b, 0) / top.length;
}

function sampleCalibration(asym, closedEye) {
  const phase = PHASES[calibrating.index];
  calibrating.samples[phase.key].push(asym);
  if (phase.key !== "noise") {
    calibrating.eyePeaks[phase.key] = Math.max(calibrating.eyePeaks[phase.key], closedEye);
  }
  const remaining = Math.max(0, calibrating.until - nowSeconds());
  el.gestureAsym.textContent =
    `${phase.prompt}  ${remaining.toFixed(0)}s\n` +
    `live  closed ${closedEye.toFixed(2)}  diff ${asym >= 0 ? "+" : ""}${asym.toFixed(2)}`;
  if (remaining > 0) return;

  calibrating.index += 1;
  if (calibrating.index < PHASES.length) return nextCalibrationPhase();

  finishCalibration();
}

function finishCalibration() {
  const { noise, right, left } = calibrating.samples;
  const eyePeaks = calibrating.eyePeaks;
  calibrating = null;
  el.camPreview.hidden = true;
  el.calibrateBtn.textContent = "Calibrate";

  // Blinks are symmetric, so their asymmetry is the noise this has to clear.
  const noiseLevel = Math.max(percentile(noise.map(Math.abs), 0.95), 0.03);

  // Which sign belongs to which eye is not assumed. Cameras mirror, front and
  // rear differ, and the model's "left" is the subject's left, not the
  // viewer's — three chances to get it backwards. The calibration just records
  // which way each wink actually moved the difference.
  const rightSigned = topMean(right, 0.1);
  const rightSignedNeg = topMean(right.map((v) => -v), 0.1);
  const leftSigned = topMean(left, 0.1);
  const leftSignedNeg = topMean(left.map((v) => -v), 0.1);

  const rightLevel = Math.max(rightSigned, rightSignedNeg);
  const leftLevel = Math.max(leftSigned, leftSignedNeg);
  const forwardSign = rightSigned >= rightSignedNeg ? 1 : -1;

  const winkLevel = Math.min(rightLevel, leftLevel);
  const separation = winkLevel / noiseLevel;

  const threshold = thresholdFrom(noiseLevel, winkLevel);
  // If the eye never registers as closed, the model is not seeing the gesture
  // and every knob downstream is beside the point. A result like that must not
  // be stored, or the app spends the rest of the session obeying it — which is
  // what a threshold of 0.15 from a wink measured at 0.10 amounted to.
  const closedPeak = Math.max(eyePeaks.right, eyePeaks.left);
  if (closedPeak < 0.5) {
    el.gestureStatus.textContent =
      `The eye never reads as closed — peak ${closedPeak.toFixed(2)}, expected above 0.8.\n` +
      "The face model is not seeing the wink at all, so no threshold will help. " +
      "More light on your face, or moving closer to the camera, is what to try. " +
      "Nothing was saved.";
    return;
  }

  calibration = {
    scale: CALIBRATION_SCALE,
    threshold, separation, forwardSign, rightLevel, leftLevel, noiseLevel,
    savedAt: new Date().toISOString().slice(0, 10),
  };
  staleCalibration = false;
  try {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
  } catch {}

  const verdict =
    separation >= 2.5
      ? "Good separation — winks are clearly distinct from blinks."
      : separation >= 1.5
      ? "Marginal. It will work but expect the occasional miss; better light or a closer camera helps."
      : "Not reliable on this face and setup. Use the pedal, the tap zones, or an arrow key instead — " +
        "the app will not pretend otherwise.";

  el.gestureStatus.textContent =
    `blink noise ${noiseLevel.toFixed(2)} · right wink ${rightLevel.toFixed(2)} · ` +
    `left wink ${leftLevel.toFixed(2)} · separation x${separation.toFixed(1)} · ` +
    `threshold ${threshold.toFixed(2)} · eye closed to ${closedPeak.toFixed(2)}\n${verdict}`;
}

// ============================================================
// Store — per-score state, keyed by a hash of the PDF
// ============================================================

async function loadScoreState(hash) {
  // TODO: IndexedDB read — templates and page durations.
  console.warn("loadScoreState: not implemented", hash);
  return null;
}

async function saveScoreState(hash) {
  // TODO: IndexedDB write.
  console.warn("saveScoreState: not implemented", hash);
}

// ============================================================
// Controller
// ============================================================

function turnTo(n) {
  if (!state.pageCount) return;
  const next = Math.min(Math.max(n, 1), state.pageCount);
  if (next === state.page) return;
  if (next === state.page + 1) {
    captureTemplate(); // only forward turns mark a page ending
    // A page heard out from one early turn to the next spans exactly its own
    // length, so its duration divided by its measures is the bar length. This
    // is why there is no tempo field: the performance states its own tempo.
    const bars = state.measures.get(state.page);
    if (state.turnedBy === "audio" && state.anchorIsEarly && bars) {
      state.secondsPerBar = (nowSeconds() - state.pageStartedAt) / bars;
      state.tempoKnown = true;
    }
    state.anchorIsEarly = true;
  }
  state.page = next;
  showPage(next);
  resyncTiming(); // every turn re-anchors the schedule, however it was triggered
  render();
}

const nextPage = () => turnTo(state.page + 1);
const prevPage = () => turnTo(state.page - 1);

/**
 * Drop out of automatic mode without turning. Preferred over guessing: a page
 * turned at the wrong moment breaks a performance, a missed one costs a tap.
 */
function fallBackToManual(reason) {
  state.mode = "manual";
  state.armed = false;
  state.confidence = 0;
  render();
  setStatus(`Auto off — ${reason}.`);
}

function renderDiag() {
  const pages = [...state.measures.entries()]
    .map(([n, m]) => `${m ?? "?"}${state.templates.has(n) ? "" : "!"}`)
    .join(" ");
  const flag = (on, label) => (on ? `<b>${label}</b>` : label);
  el.diag.innerHTML = [
    `bars/page ${pages || "—"}   (! = no template, turns on time)`,
    `mic ${analyser ? "on" : "OFF"}   tonality ${state.tonality.toFixed(2)} / ${TONALITY_MIN}   ` +
      `${flag(state.playing, "playing")}   ${flag(state.started, "started")}`,
    `match ${state.confidence.toFixed(2)} / ${MATCH_THRESHOLD}   ` +
      `${flag(state.armed, "armed")}   last turn: ${state.turnedBy || "—"}`,
    `bars left ${(barsRemaining(nowSeconds()) ?? 0).toFixed(1)}   build ${BUILD}`,
  ].join("\n");
}

function setStatus(text) {
  el.setupStatus.textContent = text;
}

function showError(message) {
  el.scoreError.textContent = message;
  el.scoreError.hidden = !message;
}

function render() {
  el.hudPage.textContent = state.pageCount ? `${state.page} / ${state.pageCount}` : "— / —";
  el.hudMode.textContent =
    state.mode !== "auto" ? "Manual" : state.started ? "Auto" : "Waiting";
  el.prevBtn.disabled = state.page <= 1;
  el.nextBtn.disabled = state.page >= state.pageCount;

  el.hudArmed.hidden = !(state.mode === "auto" && state.armed);

  el.meter.hidden = !(state.mode === "auto" && state.templates.has(state.page));
  el.meterFill.style.width = `${Math.round(state.confidence * 100)}%`;
  el.meterFill.classList.toggle("over", state.confidence >= MATCH_THRESHOLD);
  el.meterValue.textContent = state.confidence.toFixed(2);

  if (state.mode === "auto" && state.turnedBy) {
    el.hudMode.textContent = state.turnedBy === "audio" ? "Auto · heard" : "Auto · clock";
  }
  renderDiag();
  el.startBtn.textContent = state.mode === "auto" ? "Stop" : "Start";
  el.startBtn.disabled = !state.doc || !state.measures.get(1);
}

// ============================================================
// Transport
// ============================================================

let tickTimer = null;

async function startAuto() {
  if (state.mode === "auto") return stopAuto();

  state.mode = "auto";
  heardAnything = false;
  tonalRun = 0;
  silentSince = null;
  collapseSetup(true); // it covers the score, and there is nothing left to set
  turnTo(1);
  state.anchorIsEarly = false; // the player starts at bar 1, not ahead of it
  resyncTiming();

  state.tempoKnown = false; // each run measures the tempo afresh
  let heard = true;
  try {
    await startListening();
    state.started = false; // wait for the first note before any clock runs
    setStatus("Ready — start playing.");
  } catch (err) {
    // Without a microphone there is nothing to wait for and nothing to confirm
    // with, so the clock starts here and the tempo has to be right.
    heard = false;
    state.started = true;
    setStatus(`No microphone (${err.message}) — turning on the clock alone.`);
  }

  tickTimer = setInterval(() => {
    const now = nowSeconds();
    if (state.turnAt === null || !state.started) return render();
    // When the page's ending is known, hearing it is the only thing that turns
    // it. A clock cannot tell this piece from a different one, so letting it
    // turn on time alone means any playing at all advances the score.
    // Pages the reader could not parse have no such test, and fall back to time.
    if (state.templates.has(state.page)) return render();
    if (now >= state.turnAt) {
      state.turnedBy = "schedule";
      nextPage();
    } else render();
  }, 100);

  render();
  if (heard) el.hudMode.textContent = "Waiting";
}

function stopAuto() {
  state.mode = "manual";
  collapseSetup(false);
  state.turnAt = null;
  state.armed = false;
  state.started = false;
  state.playing = false;
  clearInterval(tickTimer);
  tickTimer = null;
  stopListening();
  render();
  setStatus("Stopped.");
}

// ============================================================
// Wiring
// ============================================================

function loadFile(file) {
  if (!file) return;
  showError("");
  if (file.type && file.type !== "application/pdf") {
    showError(`Not a PDF: ${file.name}`);
    return;
  }
  openScore(file)
    .then(() => collapseSetup(false))
    .catch((err) => {
      console.error("failed to open score:", err);
      showError(`Could not open ${file.name} — ${err.message}`);
    });
}

el.fileInput.addEventListener("change", (e) => loadFile(e.target.files && e.target.files[0]));

el.score.addEventListener("dragover", (e) => e.preventDefault());
el.score.addEventListener("drop", (e) => {
  e.preventDefault();
  loadFile(e.dataTransfer && e.dataTransfer.files[0]);
});

el.nextBtn.addEventListener("click", () => {
  state.turnedBy = "manual";
  nextPage();
});
el.prevBtn.addEventListener("click", () => {
  state.turnedBy = "manual";
  prevPage();
});
el.startBtn.addEventListener("click", startAuto);

el.gestureCheck.addEventListener("change", async () => {
  if (!el.gestureCheck.checked) {
    stopGesture();
    showCalibrationState();
    return;
  }
  el.gestureStatus.hidden = false;
  el.gestureStatus.textContent = "Loading the face model…";
  try {
    await startGesture();
    el.gestureStatus.textContent = calibration
      ? `Ready — calibrated ${calibration.savedAt ?? "earlier"}, saved in this browser. ` +
        `Right eye forward, left eye back.`
      : "Ready, on defaults. Calibrating tunes it to your face and is remembered — " +
        "you only do it once.";
  } catch (err) {
    el.gestureCheck.checked = false;
    el.gestureStatus.textContent = `Camera unavailable — ${err.message}`;
  }
});

el.calibrateBtn.addEventListener("click", startCalibration);

el.holdInput.addEventListener("change", () => {
  gestureHoldMs = Math.min(400, Math.max(50, Number(el.holdInput.value) || 70));
  el.holdInput.value = String(gestureHoldMs);
  try {
    localStorage.setItem(HOLD_KEY, String(gestureHoldMs));
  } catch {}
});

el.leadInput.addEventListener("change", () => {
  state.leadBars = Math.max(0, Number(el.leadInput.value) || 0);
  buildTemplates(); // the template ends where the lead says the page does
  scheduleTurn();
  render();
});

function collapseSetup(collapsed) {
  el.setupToggle.setAttribute("aria-expanded", String(!collapsed));
  el.setupPanel.classList.toggle("collapsed", collapsed);
}

el.setupToggle.addEventListener("click", () => {
  collapseSetup(el.setupToggle.getAttribute("aria-expanded") === "true");
});

// Keyboard and pedal-style remotes both arrive as arrow keys.
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
    state.turnedBy = "manual";
    nextPage();
  }
  if (e.key === "ArrowLeft" || e.key === "PageUp") {
    state.turnedBy = "manual";
    prevPage();
  }
});

// Rasters are sized to the viewport, so a resize invalidates every one of them.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    pageCache.clear();
    showPage(state.page);
  }, 150);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

loadCalibration();
loadHold();
showCalibrationState();
render();
window.__autopageReady = true;

// Exposed for the headless test harness in tools/.
window.__autopage = {
  state, matchScore, chromaLog, recentFrames, readPage, chromaOf, startListening,
  startGesture, stopGesture, get calibration() { return calibration; },
};
