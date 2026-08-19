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
const BUFFER_S = 12; // rolling history the matcher searches
const MATCH_THRESHOLD = 0.8; // deliberately high: a miss beats a wrong turn
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
  mode: "manual", // "manual" | "rehearsing" | "auto"
  armed: false,
  confidence: 0,
  hold: 0,
  pageStartedAt: 0, // seconds; when the current page began
  templates: new Map(), // page -> chroma frames captured before the tap
  pageDurations: new Map(), // page -> seconds that page ran during rehearsal
};

const el = {};
for (const id of [
  "score", "scoreCanvas", "scoreEmpty", "fileInput", "scoreError",
  "hud", "hudPage", "hudMode", "hudArmed", "nav", "prevBtn", "nextBtn",
  "setupPanel", "setupToggle", "rehearseBtn", "markBtn", "performBtn",
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
  state.pageDurations.clear();
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
}

// ============================================================
// Arming — coarse timing
//
// Rehearsal measures how long each page actually ran, which beats deriving it
// from tempo and time signature: the measurement already contains the player's
// pacing, repeats, and the fact that the last system is usually taken broadly.
// ============================================================

/** Seconds from the start of the current page until its turn point. */
function estimateTurnDelay() {
  const d = state.pageDurations.get(state.page);
  return d === undefined ? null : d;
}

/** True while the detector should be listening. */
function isArmed(now) {
  const delay = estimateTurnDelay();
  if (delay === null) return false;
  // Proportional slack so a performance taken off the rehearsal tempo still
  // opens the window over the right stretch of music.
  const slack = Math.max(ARM_WINDOW_S, delay * ARM_WINDOW_FRACTION);
  return Math.abs(now - state.pageStartedAt - delay) <= slack;
}

/**
 * Re-anchor the estimate to a known position. Called on every turn — automatic
 * or manual — which is what keeps drift from accumulating across pages.
 */
function resyncTiming() {
  state.pageStartedAt = nowSeconds();
  state.hold = 0;
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

function detect() {
  const now = nowSeconds();
  state.armed = isArmed(now);

  if (!state.armed || state.page >= state.pageCount) {
    state.confidence = 0;
    state.hold = 0;
    render();
    return;
  }

  const template = state.templates.get(state.page);
  if (!template) return fallBackToManual(`no template for page ${state.page}`);

  const live = recentFrames(TEMPLATE_S * 1.6);
  state.confidence = matchScore(live, template);
  state.hold = state.confidence >= MATCH_THRESHOLD ? state.hold + 1 : 0;

  if (state.hold >= MATCH_HOLD_FRAMES) {
    state.hold = 0;
    nextPage();
    return;
  }
  render();
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
  state.page = next;
  showPage(next);
  resyncTiming(); // every turn re-anchors the estimate, however it was triggered
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
  el.hudMode.textContent =
    state.mode === "auto" ? "Auto" : state.mode === "rehearsing" ? "Rehearsing" : "Manual";
  el.hudArmed.hidden = !state.armed;
  el.prevBtn.disabled = state.page <= 1;
  el.nextBtn.disabled = state.page >= state.pageCount;

  el.meter.hidden = state.mode !== "auto";
  el.meterFill.style.width = `${Math.round(state.confidence * 100)}%`;
  el.meterFill.classList.toggle("over", state.confidence >= MATCH_THRESHOLD);
  el.meterValue.textContent = state.confidence.toFixed(2);

  el.markBtn.disabled = state.mode !== "rehearsing";
  el.performBtn.disabled = state.templates.size === 0 || state.mode === "rehearsing";
  el.rehearseBtn.textContent = state.mode === "rehearsing" ? "Cancel" : "Rehearse";
}

// ============================================================
// Rehearsal
//
// The tap defines the turn point, which is why there is no "turn N measures
// early" setting: the player taps where they want the page to flip, and the
// template is the music leading up to that instant.
// ============================================================

async function startRehearsal() {
  if (state.mode === "rehearsing") {
    state.mode = "manual";
    render();
    setStatus("Rehearsal cancelled.");
    return;
  }
  try {
    await startListening();
  } catch (err) {
    showError(`Microphone unavailable — ${err.message}`);
    return;
  }
  state.mode = "rehearsing";
  state.templates.clear();
  state.pageDurations.clear();
  turnTo(1);
  resyncTiming();
  render();
  setStatus(`Playing page 1 of ${state.pageCount} — tap Mark turn at the page end.`);
}

function markTurn() {
  const template = recentFrames(TEMPLATE_S);
  if (template.length < 8) {
    setStatus("Not enough audio yet — let it play a few seconds first.");
    return;
  }

  state.templates.set(state.page, template);
  state.pageDurations.set(state.page, nowSeconds() - state.pageStartedAt);

  // Templates are needed for pages 1..n-1 — the last page has no turn after it.
  if (state.page >= state.pageCount - 1) {
    state.mode = "manual";
    render();
    setStatus(`Rehearsed ${state.templates.size} turns. Press Perform to run it.`);
    return;
  }
  nextPage();
  render();
  setStatus(`Page ${state.page} of ${state.pageCount} — tap at the page end.`);
}

async function startPerform() {
  try {
    await startListening();
  } catch (err) {
    showError(`Microphone unavailable — ${err.message}`);
    return;
  }
  state.mode = "auto";
  turnTo(1);
  resyncTiming();
  render();
  setStatus("Listening. Start from the top.");
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
    .then(() => setStatus("Press Rehearse, then tap at each page end."))
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
el.rehearseBtn.addEventListener("click", startRehearsal);
el.markBtn.addEventListener("click", markTurn);
el.performBtn.addEventListener("click", startPerform);

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
window.__autopage = { state, matchScore, chromaLog, recentFrames };
