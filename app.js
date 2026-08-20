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
  bpm: 120,
  beatsPerBar: 3,
  leadBars: 1,
  measures: new Map(), // page -> measures counted from the PDF's own drawing ops
  sonorities: new Map(), // page -> harmonies read off the page, in order
  templates: new Map(), // page -> chroma heard just before a previous turn
  turnAt: null, // seconds; when the schedule says this page ends
  anchorIsEarly: false, // the anchor sits `leadBars` before the page's first bar
};

const el = {};
for (const id of [
  "score", "scoreCanvas", "scoreEmpty", "fileInput", "scoreError",
  "hud", "hudPage", "hudMode", "hudArmed", "nav", "prevBtn", "nextBtn",
  "setupPanel", "setupToggle", "startBtn", "tapBtn",
  "bpmInput", "meterInput", "leadInput",
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
  const counts = [...state.measures.values()];
  if (counts.every((c) => c === null)) {
    setStatus("No staves found — a scanned score can only be turned by hand.");
  } else {
    setStatus(`Measures per page: ${counts.map((c) => c ?? "?").join(", ")}. Set the tempo and press Start.`);
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

const secondsPerBar = () => (60 / state.bpm) * state.beatsPerBar;

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

/** Bars left on this page, for the countdown. */
function barsRemaining(now) {
  if (state.turnAt === null) return null;
  return Math.max(0, (state.turnAt - now) / secondsPerBar());
}

const armSlack = () => Math.max(ARM_WINDOW_S, secondsPerBar() * 2);

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
const chromaLog = []; // {t, c: Float32Array(12)}, oldest first

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
  chromaLog.push({ t: nowSeconds(), c: chromaFrom(spectrum) });

  const cutoff = nowSeconds() - BUFFER_S;
  while (chromaLog.length && chromaLog[0].t < cutoff) chromaLog.shift();

  if (state.mode === "auto") detect();
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
  state.hold = state.confidence >= MATCH_THRESHOLD ? state.hold + 1 : 0;
  if (state.hold >= MATCH_HOLD_FRAMES) nextPage();
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
// Gesture — the complement
//
// Bidirectional and always live. Back matters more than forward: it is the
// recovery path when the app turns early. Gestures must be ones that do not
// occur while playing, so no nods and no blinks — musicians do both constantly.
// ============================================================

async function startGesture() {
  // TODO: face landmarks, locally. Nothing leaves the device.
  console.warn("startGesture: not implemented");
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

function setStatus(text) {
  el.setupStatus.textContent = text;
}

function showError(message) {
  el.scoreError.textContent = message;
  el.scoreError.hidden = !message;
}

function render() {
  el.hudPage.textContent = state.pageCount ? `${state.page} / ${state.pageCount}` : "— / —";
  el.hudMode.textContent = state.mode === "auto" ? "Auto" : "Manual";
  el.prevBtn.disabled = state.page <= 1;
  el.nextBtn.disabled = state.page >= state.pageCount;

  const bars = state.mode === "auto" ? barsRemaining(nowSeconds()) : null;
  el.hudArmed.hidden = bars === null;
  if (bars !== null) {
    el.hudArmed.textContent =
      bars < 1 ? "turning…" : `${Math.ceil(bars)} bar${Math.ceil(bars) === 1 ? "" : "s"} left`;
  }

  el.meter.hidden = !(state.mode === "auto" && state.templates.has(state.page));
  el.meterFill.style.width = `${Math.round(state.confidence * 100)}%`;
  el.meterFill.classList.toggle("over", state.confidence >= MATCH_THRESHOLD);
  el.meterValue.textContent = state.confidence.toFixed(2);

  el.startBtn.textContent = state.mode === "auto" ? "Stop" : "Start";
  el.startBtn.disabled = !state.doc || !state.measures.get(1);
}

// ============================================================
// Transport
// ============================================================

const taps = [];

/** Tap tempo — the median interval, so one stray tap does not move it. */
function tapTempo() {
  const now = nowSeconds();
  if (taps.length && now - taps[taps.length - 1] > 2.5) taps.length = 0;
  taps.push(now);
  if (taps.length > 6) taps.shift();
  if (taps.length < 2) return setStatus("Keep tapping…");

  const gaps = taps.slice(1).map((t, i) => t - taps[i]).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  setBpm(Math.round(60 / median));
  setStatus(`Tempo ${state.bpm} BPM.`);
}

function setBpm(bpm) {
  state.bpm = Math.min(240, Math.max(30, bpm));
  el.bpmInput.value = String(state.bpm);
  scheduleTurn();
  render();
}

let tickTimer = null;

async function startAuto() {
  if (state.mode === "auto") return stopAuto();

  state.mode = "auto";
  collapseSetup(true); // it covers the score, and there is nothing left to set
  turnTo(1);
  state.anchorIsEarly = false; // the player starts at bar 1, not ahead of it
  resyncTiming();
  // The microphone is optional: it only lets a second run through the score be
  // guided by the music instead of the clock. Denying it costs nothing today.
  startListening().catch((err) => console.info("running without audio:", err.message));

  tickTimer = setInterval(() => {
    const now = nowSeconds();
    if (state.turnAt === null) return render();
    // With a template the schedule waits for the audio and only steps in when
    // the window closes; without one it is all there is.
    const deadline = state.templates.has(state.page) ? state.turnAt + armSlack() : state.turnAt;
    if (now >= deadline) nextPage();
    else render();
  }, 100);

  render();
  setStatus(`Turning on schedule at ${state.bpm} BPM. Start playing.`);
}

function stopAuto() {
  state.mode = "manual";
  collapseSetup(false);
  state.turnAt = null;
  state.armed = false;
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

el.nextBtn.addEventListener("click", nextPage);
el.prevBtn.addEventListener("click", prevPage);
el.startBtn.addEventListener("click", startAuto);
el.tapBtn.addEventListener("click", tapTempo);

el.bpmInput.addEventListener("change", () => setBpm(Number(el.bpmInput.value) || 120));
el.meterInput.addEventListener("change", () => {
  state.beatsPerBar = Math.min(12, Math.max(1, Number(el.meterInput.value) || 4));
  scheduleTurn();
  render();
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
  if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") nextPage();
  if (e.key === "ArrowLeft" || e.key === "PageUp") prevPage();
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

render();
window.__autopageReady = true;

// Exposed for the headless test harness in tools/.
window.__autopage = { state, matchScore, chromaLog, recentFrames, readPage, chromaOf, startListening };
