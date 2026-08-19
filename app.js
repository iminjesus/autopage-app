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
 * STATUS: scaffold. The sections below define the contracts; the bodies are
 * still TODO.
 */

// --- Tuning constants ---
const ARM_WINDOW_S = 3.5; // how far either side of the estimate to listen
const MATCH_HOLD_FRAMES = 3; // consecutive confident frames before turning
const MATCH_THRESHOLD = 0.8; // deliberately high: a miss beats a wrong turn
const TEMPLATE_MEASURES = 3; // context length; one measure is not distinctive
const GESTURE_HOLD_MS = 400; // suppresses gestures that happen while playing

const state = {
  doc: null, // loaded PDF handle
  page: 1,
  pageCount: 0,
  bpm: 120,
  beatsPerBar: 4,
  leadMeasures: 1,
  mode: "manual", // "manual" | "auto" | "rehearsing"
  armed: false,
  pageStartedAt: 0, // audio-clock time the current page began
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
};

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
// ============================================================

/** Load a PDF from a File and render page 1. */
async function openScore(file) {
  // TODO: pdf.js must be vendored locally — no CDN, the app has to work offline.
  console.warn("openScore: not implemented", file && file.name);
}

/** Draw `n` into the canvas, sized to fit the viewport. */
async function renderPage(n) {
  // TODO: render via pdf.js at a fixed scale so coordinates stay stable.
  console.warn("renderPage: not implemented", n);
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
  state.pageStartedAt = ensureAudio().currentTime;
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
  renderPage(next);
  resyncTiming(); // every turn re-anchors the estimate, however it was triggered
  render();
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
  console.info("auto disabled:", reason);
}

function render() {
  el.hudPage.textContent = state.pageCount
    ? `${state.page} / ${state.pageCount}`
    : "— / —";
  el.hudMode.textContent =
    state.mode === "auto" ? "Auto" : state.mode === "rehearsing" ? "Rehearsing" : "Manual";
  el.hudArmed.hidden = !state.armed;
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

el.fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) openScore(file);
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

el.setupToggle.addEventListener("click", () => {
  const open = el.setupToggle.getAttribute("aria-expanded") === "true";
  el.setupToggle.setAttribute("aria-expanded", String(!open));
  el.setupPanel.classList.toggle("collapsed", open);
});

// Keyboard and pedal-style remotes both arrive as arrow keys.
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === "PageDown") nextPage();
  if (e.key === "ArrowLeft" || e.key === "PageUp") prevPage();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

render();
