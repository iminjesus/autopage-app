/**
 * AutoPage — automatic page turning for PDF sheet music.
 *
 * The app never tries to know where in the score the player is. It answers one
 * question per page: has the player reached the last measure yet?
 *
 * Two weak signals combine into one reliable trigger:
 *
 *   1. Coarse timing (tempo x meter) estimates when the last measure arrives and
 *      opens a detection window around it. It only has to be right within a few
 *      seconds, and it resets on every turn so error never accumulates.
 *   2. Inside that window only, a chroma template matcher confirms the moment
 *      against a recording made during a rehearsal pass.
 *
 * Neither works alone: timing drifts, and the matcher would fire on false
 * positives if it listened across the whole page. Gated together they don't.
 *
 * A face gesture is always live as a complement — forward, back, and a resync of
 * the timing estimate. See docs/design.md.
 *
 * STATUS: the score view works. The detector sections below are still stubs.
 */

import * as pdfjsLib from "./vendor/pdf.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.js";

// --- Tuning constants ---
const ARM_WINDOW_S = 3.5; // how far either side of the estimate to listen
const MATCH_HOLD_FRAMES = 3; // consecutive confident frames before turning
const MATCH_THRESHOLD = 0.8; // deliberately high: a miss beats a wrong turn
const TEMPLATE_MEASURES = 3; // context length; one measure is not distinctive
const GESTURE_HOLD_MS = 400; // suppresses gestures that happen while playing
const MAX_CACHED_PAGES = 6;
const MAX_DPR = 2; // a 3x phone triples raster cost for no gain on a score

const state = {
  doc: null,
  page: 1,
  pageCount: 0,
  bpm: 120,
  beatsPerBar: 4,
  leadMeasures: 1,
  mode: "manual", // "manual" | "auto" | "rehearsing"
  armed: false,
  pageStartedAt: 0, // seconds; when the current page began
  templates: new Map(), // page number -> chroma template
  measuresPerPage: new Map(), // page number -> measure count (from rehearsal)
};

const el = {
  score: document.getElementById("score"),
  canvas: document.getElementById("scoreCanvas"),
  empty: document.getElementById("scoreEmpty"),
  fileInput: document.getElementById("fileInput"),
  hud: document.getElementById("hud"),
  hudPage: document.getElementById("hudPage"),
  hudMode: document.getElementById("hudMode"),
  hudArmed: document.getElementById("hudArmed"),
  nav: document.getElementById("nav"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  setupPanel: document.getElementById("setupPanel"),
  setupToggle: document.getElementById("setupToggle"),
  rehearseBtn: document.getElementById("rehearseBtn"),
  markBtn: document.getElementById("markBtn"),
  bpmInput: document.getElementById("bpmInput"),
  meterInput: document.getElementById("meterInput"),
  leadInput: document.getElementById("leadInput"),
  gestureCheck: document.getElementById("gestureCheck"),
  error: document.getElementById("scoreError"),
};

/**
 * Wall clock, in seconds. The arming window tolerates several seconds of error
 * by design, so there is no reason to spin up an AudioContext for it — the
 * audio clock belongs to feature framing, once the microphone is running.
 */
const nowSeconds = () => performance.now() / 1000;

let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// ============================================================
// Score view — draw the PDF, nothing more
//
// The app deliberately does not analyse the page image. No staff detection, no
// barlines, no optical music recognition: the turn trigger comes from audio, so
// the renderer only has to put pixels on screen.
//
// It does have to be *fast*. A page turn that visibly stutters is worse than no
// automation at all, so neighbouring pages are rasterized ahead of time and the
// turn itself is only a blit.
// ============================================================

const pageCache = new Map(); // "page@layout" -> {canvas, cssW, cssH}
const pending = new Map(); // same key -> in-flight rasterize promise
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

/** Rasterize into the cache, reusing an in-flight render for the same key. */
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

  el.canvas.width = entry.canvas.width;
  el.canvas.height = entry.canvas.height;
  el.canvas.style.width = `${entry.cssW}px`;
  el.canvas.style.height = `${entry.cssH}px`;
  el.canvas.getContext("2d", { alpha: false }).drawImage(entry.canvas, 0, 0);

  // The next page is the one a turn will need; the previous one is what a
  // mistaken turn has to fall back to. Both are worth having ready.
  if (n + 1 <= state.pageCount) rasterizeCached(n + 1).catch(() => {});
  if (n - 1 >= 1) rasterizeCached(n - 1).catch(() => {});
}

async function openScore(file) {
  const data = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data }).promise;

  state.doc = doc;
  state.pageCount = doc.numPages;
  state.page = 1;
  pageCache.clear();
  pending.clear();
  resyncTiming();

  el.empty.hidden = true;
  el.canvas.hidden = false;
  el.hud.hidden = false;
  el.nav.hidden = false;
  el.setupPanel.hidden = false;
  collapseSetup(true); // the panel overlaps the forward tap zone; get it out of the way

  await showPage(1);
  render();
window.__autopageReady = true;
}

// ============================================================
// Arming — coarse timing
//
// Estimates when the last measure of the page begins, then opens a window
// around it. Weak on purpose: it gates the matcher, it does not trigger turns.
// ============================================================

/** Seconds from the start of the current page until the turn point. */
function estimateTurnDelay() {
  const measures = state.measuresPerPage.get(state.page);
  if (!measures) return null; // no rehearsal data for this page
  const secondsPerMeasure = (60 / state.bpm) * state.beatsPerBar;
  return (measures - state.leadMeasures) * secondsPerMeasure;
}

/** True while the detector should be listening. */
function isArmed(now) {
  const delay = estimateTurnDelay();
  if (delay === null) return false;
  return Math.abs(now - state.pageStartedAt - delay) <= ARM_WINDOW_S;
}

/**
 * Re-anchor the estimate to a known position. Called on every turn — automatic
 * or manual — which is what keeps drift from accumulating across pages.
 */
function resyncTiming() {
  state.pageStartedAt = nowSeconds();
}

// ============================================================
// Audio input and chroma features
// ============================================================

/** Start microphone capture and the feature loop. */
async function startListening() {
  // TODO: getUserMedia + AnalyserNode, hop ~23ms.
  console.warn("startListening: not implemented");
}

/**
 * Fold an FFT magnitude spectrum into 12 pitch classes.
 * Chroma is used because it is robust to wrong notes and octave differences —
 * the matcher should tolerate a fluffed note without losing the page.
 */
function chromaFrom(spectrum) {
  // TODO
  console.warn("chromaFrom: not implemented", spectrum && spectrum.length);
  return new Float32Array(12);
}

// ============================================================
// Matcher — subsequence DTW against the rehearsal template
//
// DTW so a performance taken faster or slower than the rehearsal still matches.
// Subsequence so the template can be found anywhere inside the rolling buffer.
// ============================================================

/**
 * Score the live buffer against this page's template.
 * @returns {number} 0..1 confidence
 */
function matchScore(buffer, template) {
  // TODO: subsequence DTW over cosine distance between chroma frames.
  console.warn("matchScore: not implemented", buffer, template);
  return 0;
}

// ============================================================
// Gesture — the complement
//
// Bidirectional and always live. Back matters more than forward: it is the
// recovery path when the app turns early. Gestures must be ones that do not
// occur while playing, so no nods and no blinks — musicians do both constantly.
// Hold time is what actually suppresses false positives.
// ============================================================

async function startGesture() {
  // TODO: face landmarks, locally. Nothing leaves the device.
  console.warn("startGesture: not implemented");
}

// ============================================================
// Store — per-score state, keyed by a hash of the PDF
// ============================================================

async function loadScoreState(hash) {
  // TODO: IndexedDB read — templates, measure counts, tempo, lead.
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
  state.page = next;
  showPage(next);
  resyncTiming(); // every turn re-anchors the estimate, however it was triggered
  render();
window.__autopageReady = true;
}

const nextPage = () => turnTo(state.page + 1);
const prevPage = () => turnTo(state.page - 1);

/**
 * Drop out of automatic mode without turning. Preferred over guessing: a page
 * turned at the wrong moment breaks a performance, a missed one costs a gesture.
 */
function fallBackToManual(reason) {
  state.mode = "manual";
  state.armed = false;
  render();
window.__autopageReady = true;
  console.info("auto disabled:", reason);
}

function render() {
  el.hudPage.textContent = state.pageCount
    ? `${state.page} / ${state.pageCount}`
    : "— / —";
  el.hudMode.textContent =
    state.mode === "auto" ? "Auto" : state.mode === "rehearsing" ? "Rehearsing" : "Manual";
  el.hudArmed.hidden = !state.armed;
  el.prevBtn.disabled = state.page <= 1;
  el.nextBtn.disabled = state.page >= state.pageCount;
}

// ============================================================
// Rehearsal
// ============================================================

function startRehearsal() {
  state.mode = "rehearsing";
  el.markBtn.disabled = false;
  startListening();
  resyncTiming();
  render();
window.__autopageReady = true;
}

/**
 * Called when the player taps at a page-turn point. Freezes the preceding few
 * seconds of chroma as this page's template and records how many measures the
 * page ran for.
 */
function markTurn() {
  // TODO: snapshot the rolling buffer into state.templates, derive the measure
  // count from elapsed time, then advance to the next page.
  console.warn("markTurn: not implemented");
  nextPage();
}

// ============================================================
// Wiring
// ============================================================

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = !message;
}

function loadFile(file) {
  if (!file) return;
  showError("");
  if (file.type && file.type !== "application/pdf") {
    showError(`Not a PDF: ${file.name}`);
    return;
  }
  openScore(file).catch((err) => {
    console.error("failed to open score:", err);
    showError(`Could not open ${file.name} — ${err.message}`);
  });
}

el.fileInput.addEventListener("change", (e) => loadFile(e.target.files && e.target.files[0]));

// Dropping a file onto the score is the fastest way in once you have used the
// app before and no longer need the empty state's button.
el.score.addEventListener("dragover", (e) => e.preventDefault());
el.score.addEventListener("drop", (e) => {
  e.preventDefault();
  loadFile(e.dataTransfer && e.dataTransfer.files[0]);
});

el.nextBtn.addEventListener("click", nextPage);
el.prevBtn.addEventListener("click", prevPage);
el.rehearseBtn.addEventListener("click", startRehearsal);
el.markBtn.addEventListener("click", markTurn);

el.bpmInput.addEventListener("change", () => {
  state.bpm = Number(el.bpmInput.value) || 120;
});
el.meterInput.addEventListener("change", () => {
  state.beatsPerBar = Number(el.meterInput.value) || 4;
});
el.leadInput.addEventListener("change", () => {
  state.leadMeasures = Number(el.leadInput.value) || 1;
});
el.gestureCheck.addEventListener("change", () => {
  if (el.gestureCheck.checked) startGesture();
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
