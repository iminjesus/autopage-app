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
const BUILD = "2026-09-01a wink-only";

import * as pdfjsLib from "./vendor/pdf.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.js";

// --- Tuning constants ---
const MAX_CACHED_PAGES = 6;
const MAX_DPR = 2; // a 3x phone triples raster cost for no gain on a score

const state = {
  doc: null,
  page: 1,
  pageCount: 0,
  measures: new Map(), // page -> measures counted from the PDF's own drawing ops
  templates: new Map(), // page -> chroma heard just before a previous turn
  turnAt: null, // seconds; when the schedule says this page ends
  turnedBy: null, // what fired the last turn
  turnLog: [], // recent turns with their cause, so none of them is a mystery
  anchorIsEarly: false, // the anchor sits `leadBars` before the page's first bar
};

const el = {};
for (const id of [
  "score", "scoreCanvas", "scoreEmpty", "fileInput", "scoreError",
  "hud", "hudPage", "hudMode", "hudArmed", "nav", "prevBtn", "nextBtn",
  "setupPanel", "setupToggle", "diag", "allowBtn",
  "camPreview", "gestureAsym", "gestureStatus", "calibrateBtn", "watch", "calibStatus",
  "holdField", "holdInput", "swapField", "swapInput",
  "setupStatus",
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
  state.measures.clear();
  pageCache.clear();
  pending.clear();

  el.scoreEmpty.hidden = true;
  el.scoreCanvas.hidden = false;
  el.hud.hidden = false;
  el.nav.hidden = false;
  el.setupPanel.hidden = false;

  await showPage(1);
  render();

  for (let n = 1; n <= doc.numPages; n++) {
    state.measures.set(n, await readPage(doc, n));
  }
  const counts = [...state.measures.values()];
  setStatus(
    counts.every((c) => c === null)
      ? `${doc.numPages} pages. No staves found — this looks like a scan.`
      : `${doc.numPages} pages, measures: ${counts.map((c) => c ?? "?").join(", ")}.`
  );
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
 * Measures drawn on one page, counted from the file's own barlines.
 * @returns {number|null} null when the page has no readable staves
 */
async function readPage(doc, n) {
  const page = await doc.getPage(n);
  const segs = extractSegments(await page.getOperatorList());
  page.cleanup();
  if (!segs.length) return null;

  const xs = segs.flatMap((s) => [s[0], s[2]]);
  const width = Math.max(...xs) - Math.min(...xs);

  const horizontal = segs.filter(
    (s) => Math.abs(s[3] - s[1]) < 1 && Math.abs(s[2] - s[0]) > width * 0.3
  );
  const ys = [...new Set(horizontal.map((s) => Math.round(s[1] * 10) / 10))].sort((a, b) => a - b);
  const staves = findStaves(ys);
  if (!staves.length) return null;

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

  return total || null;
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
// Which eye means forward is worked out from the image, but that reasoning has
// been wrong about enough conventions in this project to deserve an override
// that takes one click rather than another round trip.
let swapEyes = false;

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
// v3: the sides are decided from coordinates rather than from landmark names,
// so anything measured before this had a chance of being mirrored.
const CALIBRATION_SCALE = "eyelid-v3";
const SWAP_KEY = "autopage.winkSwap";

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
let lastWinkReport = ""; // kept so the evidence is still there to read later
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
// Both are in the image-plane proxy, where about 20 degrees of turn reads 0.44.
// Simulated shakes from 0.8 to 2Hz travel 0.21 to 0.37 within a 150ms window;
// playing sway travels 0.03 to 0.06. The gap between those is where this sits.
const MAX_YAW_SWING = 0.12;
const MAX_YAW = 0.45; // turned further than this and the far eye is guesswork
// A 30fps readout cannot be read by eye, so the peaks are held. Without this
// there is no way to tell "the model never sees the eye close" apart from
// "the threshold is wrong", and both have been guessed at for several rounds.
const peaks = { l: 0, r: 0, net: 0, at: 0 };

// A rolling record of the last few seconds, kept so that a turn nobody asked
// for can be looked at afterwards instead of guessed about. Three explanations
// for turning on head movement have been wrong so far, each of them plausible.
const trace = [];
const TRACE_FRAMES = 120; // four seconds at 30fps

function recordFrame(row) {
  trace.push(row);
  if (trace.length > TRACE_FRAMES) trace.shift();
}

/** The frames leading up to a fire, as something that can be pasted back. */
function traceReport(reason) {
  const rows = trace.slice(-9);
  const lines = rows.map(
    (f) =>
      `  ${f.t.toFixed(2)}s  openL${f.l.toFixed(3)} openR${f.r.toFixed(3)} ` +
      `diff${f.d >= 0 ? "+" : ""}${f.d.toFixed(2)} yaw${f.y >= 0 ? "+" : ""}${f.y.toFixed(2)} ` +
      `swing${f.s.toFixed(2)}${f.p ? "" : " TURNED"}`
  );
  return `Turned by ${reason}. The frames before it:\n${lines.join("\n")}`;
}

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
  const target = el.calibStatus;
  if (calibration) {
    target.textContent =
      `Calibrated ${calibration.savedAt ?? "earlier"}, saved in this browser ` +
      `(separation x${(calibration.separation ?? 0).toFixed(1)}, threshold ` +
      `${(calibration.threshold ?? 0).toFixed(2)}). Recalibrate any time to replace it.`;
  } else if (staleCalibration) {
    target.textContent =
      "A saved calibration was discarded — it was measured the old way, before " +
      "the switch to eyelid geometry, so its numbers mean nothing now. " +
      "Calibrate once more and it will stick.";
  } else {
    target.textContent =
      "Not calibrated — running on defaults. Press Calibrate at the top of the " +
      "screen if winks are missed. It is stored here and only needs doing once.";
  }
}

function loadHold() {
  const stored = Number(localStorage.getItem(HOLD_KEY));
  if (stored >= 50 && stored <= 400) gestureHoldMs = stored;
  el.holdInput.value = String(gestureHoldMs);

  swapEyes = localStorage.getItem(SWAP_KEY) === "1";
  el.swapInput.checked = swapEyes;
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
  el.holdField.hidden = false;
  el.swapField.hidden = false;
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
  el.holdField.hidden = true;
  el.swapField.hidden = true;
  landmarker?.close();
  landmarker = null;
}

function blendshape(shapes, name) {
  return shapes.find((c) => c.categoryName === name)?.score ?? 0;
}

/**
 * Distance in the image plane only.
 *
 * The z coordinate must stay out of this. Rotating a head does not change the
 * distances between points on it, so any measure built from 3D distances is
 * rotation-invariant by construction — the yaw estimate computed that way read
 * exactly 0.00 at every angle, and every gate depending on it had been doing
 * nothing at all. Foreshortening is a projection effect, so it only exists in
 * the projection.
 */
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Eyelid geometry, straight off the mesh.
//
// The blendshape route measured a wink at 0.09 of difference on a face whose
// eyes were plainly doing different things — both scores rose together, so the
// model was reporting "an eye is closing" without resolving which. The eyelid
// landmarks do not have that problem: the gap between the lids is a distance,
// and one eye's distance closing while the other's does not is unambiguous.
// The two eyes' lid points. Which of these belongs to the player's right eye is
// deliberately not read off the names: whether a face model's "left" means the
// subject's left or the viewer's left differs between sources, the camera image
// is not mirrored while the preview is, and getting it backwards swaps forward
// and back. It is decided from the coordinates instead — see eyeSignal.
const EYE_A = [386, 374]; // upper lid, lower lid
const EYE_B = [159, 145];

// Midline points, top of the forehead to the bottom of the chin.
const FACE_TOP = 10;
const FACE_BOTTOM = 152;
const BOTH_SHUT = 0.012; // both lid gaps this small: a blink, and no signal

/** Lid gap and horizontal position for one eye, in the image plane. */
function eyeOf(landmarks, points) {
  const [up, low] = points.map((i) => landmarks[i]);
  if (!up || !low) return null;
  return { gap: dist(up, low), x: (up.x + low.x) / 2 };
}

/**
 * How far apart the two eyes are, as a fraction of how open they are together.
 *
 * The two eyes share a head. They are the same distance from the camera, at the
 * same angle, in the same light — so a ratio between them cancels every one of
 * those, and none of it has to be modelled or tracked.
 *
 * The version before this compared each eye against a learned "open" value for
 * that eye. Learning a reference means the reference can be wrong: it tracked
 * the largest gap seen and decayed over some twenty seconds, so anything that
 * briefly widened the eye pinned it high, and afterwards a perfectly open eye
 * read as closing. Moving the head sideways registered both eyes at 0.56 and
 * 0.78 closed at once, which is the signature of a reference problem rather
 * than an eye problem — a real wink cannot close both.
 *
 * @returns {{asym: number, openL: number, openR: number}|null}
 */
function eyeSignal(landmarks) {
  const a = eyeOf(landmarks, EYE_A);
  const b = eyeOf(landmarks, EYE_B);
  const top = landmarks[FACE_TOP];
  const bottom = landmarks[FACE_BOTTOM];
  if (!a || !b || !top || !bottom) return null;

  const height = dist(top, bottom);
  if (!(height > 0)) return null;

  // Facing a camera, the player's right side falls on the left of the image —
  // the frame the landmarks come from is not mirrored, whatever the preview
  // does. So the eye further left is theirs on the right, and no naming
  // convention has to be trusted for that.
  const right = a.x < b.x ? a : b;
  const left = right === a ? b : a;

  const sum = left.gap + right.gap;
  // Both eyes shut is a blink, and the ratio of two numbers near zero is noise.
  if (sum / height < BOTH_SHUT) return { asym: 0, openL: 0, openR: 0 };

  // Positive when the right eye is the more closed one, which is the direction
  // the panel promises turns the page forward.
  return {
    asym: (left.gap - right.gap) / sum,
    openL: left.gap / height,
    openR: right.gap / height,
  };
}

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
  const eyes = landmarks ? eyeSignal(landmarks) : null;
  const left = eyes ? eyes.openL : 0;
  const right = eyes ? eyes.openR : 0;
  const asym = eyes ? eyes.asym : 0;

  // Kept only to show alongside, so the two measures can be compared on a real
  // face instead of argued about.
  const bsDiff = blendshape(shapes, "eyeBlinkLeft") - blendshape(shapes, "eyeBlinkRight");

  if (calibrating) return sampleCalibration(asym, Math.abs(asym));

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

  recordFrame({
    t: nowSeconds() % 1000,
    l: left, r: right, d: asym, y: headYaw, s: yawSwing, p: poseReliable,
  });
  notePeaks(left, right, asym);
  el.gestureAsym.textContent =
    `now  openL ${left.toFixed(3)}  openR ${right.toFixed(3)}  diff ${asym >= 0 ? "+" : ""}${asym.toFixed(2)}` +
    `  ${gestureHold}/${holdFrames()}f${!poseReliable ? "  TURNED" : shaking ? "  SHAKING" : ""}\n` +
    `peak openL ${peaks.l.toFixed(3)}  openR ${peaks.r.toFixed(3)}  diff ${peaks.net.toFixed(2)} ` +
    `/ ${asymThreshold().toFixed(2)}   yaw ${headYaw.toFixed(2)}/${MAX_YAW}` +
    ` swing ${yawSwing.toFixed(2)}/${MAX_YAW_SWING}` +
    `   blendshape diff ${bsDiff >= 0 ? "+" : ""}${bsDiff.toFixed(2)}`;

  if (shaking) {
    recent.length = 0;
    gestureHold = 0;
    gestureDirection = 0;
    return;
  }

  const sign = (calibration?.forwardSign ?? 1) * (swapEyes ? -1 : 1);
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
    // Say what the numbers were, every time, so a wrong turn explains itself
    // without anyone having to catch it happening.
    lastWinkReport = traceReport(direction > 0 ? "wink forward" : "wink back");
    el.calibStatus.textContent = lastWinkReport;
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

function setCardMessage(text) {
  el.gestureStatus.hidden = !text;
  el.gestureStatus.textContent = text || "";
  showWatch();
}

/** The card exists only while it has a prompt, a preview, or a problem. */
function showWatch() {
  el.watch.hidden = el.gestureStatus.hidden && el.camPreview.hidden && el.allowBtn.hidden;
}

function startCalibration() {
  if (calibrating) {
    // A second press cancels: a calibration that cannot see a face would
    // otherwise wait forever with no way out.
    calibrating = null;
    el.camPreview.hidden = true;
    setCardMessage("");
    showWatch();
    el.calibrateBtn.textContent = "Calibrate";
    showCalibrationState();
    return;
  }
  el.calibrateBtn.textContent = "Cancel";
  collapseSetup(false); // the countdown and the result are worth seeing
  calibrating = {
    index: 0,
    samples: { noise: [], right: [], left: [] },
    eyePeaks: { right: 0, left: 0 },
    until: 0,
  };
  el.camPreview.hidden = false;
  showWatch();
  nextCalibrationPhase();
}

function nextCalibrationPhase() {
  const phase = PHASES[calibrating.index];
  calibrating.until = nowSeconds() + phase.seconds;
  setCardMessage(phase.prompt);
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
  showWatch();

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
  if (closedPeak < 0.35) {
    setCardMessage(
      `The eyes never came apart — peak difference ${closedPeak.toFixed(2)}, expected above 0.6.\n` +
      "The face model is not seeing the wink at all, so no threshold will help. " +
      "More light on your face, or moving closer to the camera, is what to try. " +
      "Nothing was saved."
    );
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

  setCardMessage(
    `separation x${separation.toFixed(1)} · threshold ${threshold.toFixed(2)}\n${verdict}`
  );
  showCalibrationState();
  setTimeout(() => setCardMessage(""), 12000); // then get off the score
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

  // Every turn says where it came from. The tap zones cover the outer sixth of
  // each side of the score, so a stray click turns a page as silently as a
  // misread wink does, and "it changed and I do not know why" cannot be
  // narrowed down while any path stays anonymous.
  state.turnLog.push({
    from: state.page,
    to: next,
    by: state.turnedBy ?? "tap or key",
    at: new Date().toLocaleTimeString(),
  });
  if (state.turnLog.length > 6) state.turnLog.shift();
  state.turnedBy = null;
  state.page = next;
  showPage(next);
  render();
}

const nextPage = () => turnTo(state.page + 1);
const prevPage = () => turnTo(state.page - 1);

function renderDiag() {
  el.diag.innerHTML = [
    `camera ${landmarker ? "on" : "off"}   build ${BUILD}`,
    state.turnLog.length
      ? "turns: " +
        state.turnLog
          .slice(-4)
          .map((t) => `${t.from}\u2192${t.to} <b>${t.by}</b> ${t.at}`)
          .join("   ")
      : "turns: none yet",
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
  el.hudMode.textContent = landmarker ? "Wink" : "Manual";
  el.hudArmed.hidden = true;
  el.prevBtn.disabled = state.page <= 1;
  el.nextBtn.disabled = state.page >= state.pageCount;
  renderDiag();
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

// Named apart from the keyboard on purpose: a stray click on the tap zone and a
// stray keypress look identical in a log that calls both "manual", and telling
// them apart is the whole point of the log.
el.nextBtn.addEventListener("click", () => {
  state.turnedBy = "tap zone";
  nextPage();
});
el.prevBtn.addEventListener("click", () => {
  state.turnedBy = "tap zone";
  prevPage();
});
/**
 * Start the camera as soon as the app opens.
 *
 * The permission prompt appears the first time and the browser remembers the
 * answer, so every visit after that starts looking without being asked and
 * without anything to switch on. If it is refused or blocked, a button appears
 * to try again rather than the app quietly doing nothing.
 */
async function beginWatching() {
  el.allowBtn.hidden = true;
  setCardMessage("");
  showWatch();
  try {
    await startGesture();
    showCalibrationState();
  } catch (err) {
    el.allowBtn.hidden = false;
    setCardMessage(
      `Camera unavailable — ${err.message}. Pages still turn with the arrow ` +
        "keys, a pedal, or by tapping the sides of the score."
    );
  }
  render();
}

el.allowBtn.addEventListener("click", beginWatching);

el.calibrateBtn.addEventListener("click", startCalibration);

el.swapInput.addEventListener("change", () => {
  swapEyes = el.swapInput.checked;
  try {
    localStorage.setItem(SWAP_KEY, swapEyes ? "1" : "0");
  } catch {}
});

el.holdInput.addEventListener("change", () => {
  gestureHoldMs = Math.min(400, Math.max(50, Number(el.holdInput.value) || 70));
  el.holdInput.value = String(gestureHoldMs);
  try {
    localStorage.setItem(HOLD_KEY, String(gestureHoldMs));
  } catch {}
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
    state.turnedBy = `key ${e.key === " " ? "space" : e.key}`;
    nextPage();
  }
  if (e.key === "ArrowLeft" || e.key === "PageUp") {
    state.turnedBy = `key ${e.key}`;
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
collapseSetup(true); // nothing but the score, until someone asks for more
render();
beginWatching();
window.__autopageReady = true;

// Exposed for the headless test harness in tools/.
window.__autopage = {
  state, readPage, startGesture, stopGesture,
  get calibration() { return calibration; },
};
