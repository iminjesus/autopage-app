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
const BUILD = "2026-11-25f natural-step";

import * as pdfjsLib from "./vendor/pdf.js";
import { spelling, keyName, parseChord } from "./transpose.js";
import { findChords, placeChords } from "./chord-paint.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.js";

/**
 * Google, for opening a Sunday out of a shared Drive folder.
 *
 * Both of these are public by design: they ship in this file, which is served
 * to every browser that opens the app, and anyone can read them. What protects
 * them is not secrecy but the authorised-origin list on the OAuth client and
 * the HTTP-referrer restriction on the API key. There is no client *secret*
 * here, and there must never be one — this is a browser-only client, and a
 * secret in a static file is a secret given away.
 *
 * The consent screen is "AutoPage", and the only scope asked for is
 * drive.file, which is non-sensitive and so needs no Google review.
 */
const GOOGLE_CLIENT_ID =
  "239071426944-oilkavqvffm07q1tal7hncfuuhtv2g9f.apps.googleusercontent.com";
const GOOGLE_API_KEY = "AIzaSyBtVu_Eqc0GtO2B9kbtOwLlN8I4YpW1ZPY";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";

// --- Tuning constants ---
const MAX_CACHED_PAGES = 6;
const MAX_DPR = 2; // a 3x phone triples raster cost for no gain on a score

const state = {
  doc: null,
  page: 1,
  pageCount: 0,
  name: null, // the file it came from, for error messages
  scoreId: null, // its key in the store: a hash of its contents
  measures: new Map(), // page -> measures counted from the PDF's own drawing ops
  templates: new Map(), // page -> chroma heard just before a previous turn
  turnAt: null, // seconds; when the schedule says this page ends
  turnedBy: null, // what fired the last turn
  turnLog: [], // recent turns with their cause, so none of them is a mystery
  anchorIsEarly: false, // the anchor sits `leadBars` before the page's first bar
};

const el = {};
for (const id of [
  "score", "scoreCanvas", "scoreEmpty", "fileInput", "scoreError", "loading",
  "nav", "prevBtn", "nextBtn",
  "setupPanel", "setupToggle", "diag", "allowBtn", "swapFileInput",
  "sampleBtn", "startCalibrateBtn", "startCalibrateState", "recent", "recentPanel",
  "installHint", "installText", "installBtn", "shareBtn", "installDismiss", "qrBox",
  "installSteps", "installArrow", "panelInstallBtn", "panelInstallHow",
  "offlineState", "offlineBtn", "screenState", "reloadBtn",
  "driveBtn", "panelDriveBtn", "driveToast",
  "keyRow", "keyNow", "keyUp", "keyDown", "keyReset", "keyBand", "keyNote",
  "naturalStepField", "naturalStepOn",
  "thumbsField", "thumbsOn", "thumbsDownField", "thumbsDownOn",
  "camPreview", "gestureAsym", "gestureStatus", "calibrateBtn", "cancelCalibBtn",
  "watch", "calibStatus",
  "holdField", "holdInput", "holdLabel", "swapField", "swapInput",
  "modeField", "modeTilt", "modeWink", "gestureHelp", "setupStatus",
]) el[id] = document.getElementById(id);

/**
 * What this page did not have.
 *
 * Almost always one thing: an index.html a version behind the app.js beside
 * it. GitHub Pages sends a ten-minute max-age and there is no build step to
 * fingerprint filenames with, so a browser tab opened just after a deploy can
 * genuinely hold the old page and the new script together.
 */
const missingEls = Object.keys(el).filter((id) => !el[id]);

/**
 * Bind a listener, or carry on without it.
 *
 * This used to be `el.thing.addEventListener(...)` straight down the file, so
 * a single element the page did not have threw at the top level and took the
 * whole module with it — the gesture, the page turns, the chooser, everything,
 * because none of it had been defined yet. A button that is missing should
 * cost you that button.
 */
function on(id, type, handler, opts) {
  if (!el[id]) return;
  el[id].addEventListener(type, handler, opts);
}

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

const pageCache = new Map(); // "page@layout@key" -> {canvas, cssW, cssH}

// ============================================================
// Key
//
// The chord symbols move; the notes on the staff do not, and cannot — what is
// in the PDF is "draw this shape here", not "this is a D". Reading that back
// would be optical music recognition and redrawing it would be a typesetter,
// and a staff that is 95% right is worse than one nobody touched, because
// somebody sings it. So the chords move and the screen says so, every moment
// it is true.
// ============================================================

const KEY_OF = (id) => `autopage-key:${id}`;
let transposeBy = 0;
let chordsByPage = new Map();
let firstChord = null;
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

  // Onto the page that was just drawn, before it is cached — so a turn into a
  // transposed page is the same blit as any other and costs nothing extra.
  if (transposeBy) {
    if (!chordsByPage.has(n)) chordsByPage.set(n, findChords(await page.getTextContent()));
    placeChords(ctx, chordsByPage.get(n), transposeBy, spelling(firstChord, transposeBy), scale);
  }
  page.cleanup();

  return { canvas, cssW: canvas.width / dpr, cssH: canvas.height / dpr };
}

function rasterizeCached(n) {
  const key = `${n}@${layoutKey()}@${transposeBy}`;
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

// ============================================================
// Changing key by hand
//
// A worship set goes up a tone for the last chorus, and that happens while
// both hands are busy and the Setup panel is three taps away. A thumb held up
// to the camera is the one signal a player can give mid-song without stopping.
//
// It is held to a stricter standard than a page turn, because it costs more
// to get wrong: a page turned by mistake is turned back, while a key changed
// by mistake rewrites every chord on the stand mid-chorus. So it has to be
// held, it has to be let go of before it counts again, and the band across
// the screen says what happened and undoes it on a tap.
// ============================================================

const THUMBS_KEY = "autopage-thumbs";
const THUMBS_DOWN_KEY = "autopage-thumbs-down";

// A fifth of the face's rate. A thumb is held for the best part of a second,
// so looking six times in that second is plenty — and the face model is
// already using the camera thirty times a second, which is the work that
// must not be disturbed.
const HAND_FPS = 6;
const THUMB_HOLD_MS = 600;
const THUMB_CONFIDENCE = 0.7;

// Up is a tone and down is a semitone, which is lopsided on purpose. Going up
// for the last chorus is a tone almost every time — D to E — so asking for it
// twice would be asking twice for the only thing anybody wants. Coming back
// down is rare, and when it happens it is a smaller correction.
const THUMB_UP = 2;
const THUMB_DOWN = -1;

// Except from E and from B, where up a tone lands in F# and C#: six and seven
// sharps, keys nobody hands a band on a Sunday. Those two are where the scale
// has its own semitone — E to F, B to C — so a thumb follows the scale rather
// than the interval, and the ladder up reads C D E F G A B, all of them keys
// somebody can actually read at speed.
const NATURAL_STEP_KEY = "autopage-natural-step";
const SEMITONE_FROM = new Set([4, 11]); // E and B
let naturalStep = true;

/** Where the chords are now, as a pitch class. */
function keyPitch() {
  const chord = parseChord(firstChord ?? "");
  return chord === null ? null : (chord.pitch + transposeBy + 144) % 12;
}

function thumbUpSteps() {
  const pitch = keyPitch();
  return naturalStep && pitch !== null && SEMITONE_FROM.has(pitch) ? 1 : THUMB_UP;
}

let thumbsOn = false;
let thumbsDownOn = true;
let recognizer = null;
let handTimer = null;
let thumbWhich = 0;
let thumbSince = 0;
let thumbLatched = false;

/**
 * What the hand is doing, in words, for the diagnostics line.
 *
 * A gesture nobody can watch failing is a gesture nobody can report. The face
 * side has said its numbers out loud from the beginning, and that is how
 * every problem with it was found; this had nothing, and the first thing it
 * produced was "I ticked the box and nothing happens", which is unanswerable.
 */
let handReport = "off";

/**
 * The model is 8MB and most people will never ask for this.
 *
 * Fetched when the setting is switched on and not before, the same bargain
 * the face model gets. The service worker keeps it in the cache that is never
 * swept, so it is downloaded once and then belongs to the device.
 */
async function startHands() {
  if (recognizer) return;
  // The camera has to be running before there is anything to watch. Returning
  // quietly here is what made "I ticked the box and nothing happens" into a
  // thing with no explanation anywhere. It says so now, and the camera
  // starting later turns it on, because startGesture asks again.
  if (!landmarker) {
    handReport = "waiting for the camera";
    return;
  }
  handReport = "loading the hand model…";
  const { GestureRecognizer, FilesetResolver } =
    await import("./vendor/mediapipe/vision_bundle.js");
  const fileset = await FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm");
  recognizer = await GestureRecognizer.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "./vendor/mediapipe/gesture_recognizer.task" },
    runningMode: "VIDEO",
    numHands: 1,
  });
  clearInterval(handTimer);
  handReport = "watching";
  handTimer = setInterval(onHandFrame, Math.round(1000 / HAND_FPS));
}

function stopHands() {
  handReport = "off";
  clearInterval(handTimer);
  handTimer = null;
  recognizer?.close();
  recognizer = null;
  thumbWhich = 0;
  thumbLatched = false;
}

function onHandFrame() {
  if (!recognizer || el.camPreview.readyState < 2) return;
  // Nothing to move on a score with no chord symbols, so do not pay to look.
  // This is most of the cost on most scores.
  if (!firstChord) {
    handReport = "no chords on this score to move";
    return;
  }
  try {
    const result = recognizer.recognizeForVideo(el.camPreview, performance.now());
    handSignal(result?.gestures?.[0]?.[0], performance.now());
  } catch (err) {
    // Same reasoning as the face loop: this runs on a timer and would
    // otherwise fail silently several times a second.
    handReport = `hand error: ${err.message}`;
    console.warn("hand frame failed:", err.message);
  }
}

/**
 * Decide on one reading of the hand.
 *
 * Split out so a test can hand it gestures directly. A thumb in front of a
 * headless camera is not a thing that can be arranged, and the part worth
 * testing is the holding and the latching rather than whether Google's model
 * knows a thumb when it sees one.
 */
/**
 * The hand's state, for the end of the diagnostics line.
 *
 * Always, not only once it is switched on. Showing it only while it was on
 * meant an empty space answered two different questions — "you have not
 * turned this on" and "you turned it on and it is broken" — and the second
 * one is the one somebody is looking at the panel to ask. One short line
 * ends that for good; the rest of this readout is four lines of numbers
 * already.
 */
function handLine() {
  if (thumbsOn) return `\nhand  ${handReport}`;
  if (!firstChord) return "\nhand  off — no chord symbols on this score";
  return '\nhand  off — tick "Thumbs up raises the key" in Setup';
}

function handSignal(gesture, now) {
  const seen = gesture ? `${gesture.categoryName} ${gesture.score.toFixed(2)}` : "no hand";
  const name = gesture && gesture.score >= THUMB_CONFIDENCE ? gesture.categoryName : null;
  const want =
    name === "Thumb_Up"
      ? thumbUpSteps()
      : name === "Thumb_Down" && thumbsDownOn
        ? THUMB_DOWN
        : 0;

  if (!want) {
    // The hand has to go away before another one counts. Without this a thumb
    // held up while somebody thinks about it walks the key up a tone every
    // second or so.
    const short = gesture && gesture.score < THUMB_CONFIDENCE;
    handReport = short ? `${seen} — needs ${THUMB_CONFIDENCE}` : seen;
    thumbWhich = 0;
    thumbLatched = false;
    return 0;
  }
  if (Math.sign(want) !== Math.sign(thumbWhich)) {
    thumbWhich = want;
    thumbSince = now;
    handReport = `${seen} — holding`;
    return 0;
  }
  if (thumbLatched) {
    handReport = `${seen} — counted, put your hand down`;
    return 0;
  }
  if (now - thumbSince < THUMB_HOLD_MS) {
    handReport = `${seen} — held ${Math.round(now - thumbSince)}/${THUMB_HOLD_MS}ms`;
    return 0;
  }

  thumbLatched = true;
  handReport = `${seen} — ${want > 0 ? "+" : ""}${want}`;
  if (!firstChord) {
    setProgress("No chord symbols on this score to move.", "problem");
    return 0;
  }
  setKeyShift(transposeBy + want);
  return want;
}

/** Turn it on or off, and remember which. */
async function setThumbs(on) {
  thumbsOn = on;
  remember(THUMBS_KEY, on ? "1" : null);
  if (el.thumbsDownField) el.thumbsDownField.hidden = !on;
  if (el.naturalStepField) el.naturalStepField.hidden = !on;
  if (!on) {
    stopHands();
    return;
  }
  try {
    setProgress("Getting the hand model…");
    await startHands();
    setProgress("");
  } catch (err) {
    setProgress(`Could not start hand detection — ${err.message}`, "problem");
    thumbsOn = false;
    if (el.thumbsOn) el.thumbsOn.checked = false;
  }
}

/**
 * Look for chord symbols, once, in the background.
 *
 * Page one only. It decides whether this score has chords worth offering to
 * move at all, and names the key they are in; the rest of the pages are read
 * when they are first drawn in another key, which is work nobody is waiting
 * on. A score with no chords never pays for any of this.
 */
async function scanForChords() {
  if (!state.doc) return;
  try {
    const page = await state.doc.getPage(1);
    const found = findChords(await page.getTextContent());
    page.cleanup();
    chordsByPage.set(1, found);
    firstChord = found[0]?.text ?? null;
  } catch (err) {
    console.warn("no chords read:", err.message);
    firstChord = null;
  }
  showKey();
}

/** Move the chords, and redraw whatever is on screen. */
async function setKeyShift(next) {
  const was = transposeBy;
  // Round, not clamped. A chord symbol is the same name twelve semitones up,
  // so there is no edge to stop at — and stopping at one meant thumbing up
  // from a chart in Ab walked as far as G and then refused, with the next key
  // up being A and perfectly reachable.
  transposeBy = next % 12;
  if (transposeBy === was) return;
  if (state.scoreId) remember(KEY_OF(state.scoreId), transposeBy ? String(transposeBy) : null);
  showKey();
  await showPage(state.page);
}

const BAND_FOR_MS = 6000;
let bandTimer = null;

/**
 * Say what key the chords are in, for a moment after they move.
 *
 * It used to stay there for as long as the chart was transposed, on the
 * reasoning that somebody reading the melody while the band plays moved
 * chords is the one way this can do harm. In front of a real score for a
 * whole service that reads as clutter, which is its own kind of harm: a
 * warning nobody wants on screen is a warning they will turn the feature off
 * to be rid of.
 *
 * So it appears when the key changes — which is the moment an accidental
 * change needs taking back, and the moment the tap-to-undo is worth having —
 * and then goes. What is permanent is the Key control in the panel, which
 * says the key and says in words that only the chords moved.
 */
function showKey() {
  if (!el.keyRow) return;
  const has = Boolean(firstChord);
  el.keyRow.hidden = !has;
  if (el.thumbsField) el.thumbsField.hidden = !has;
  if (el.thumbsDownField) el.thumbsDownField.hidden = !has || !thumbsOn;
  if (el.naturalStepField) el.naturalStepField.hidden = !has || !thumbsOn;
  if (has) {
    el.keyNow.textContent = transposeBy
      ? `${keyName(firstChord, transposeBy)} (${transposeBy > 0 ? "+" : ""}${transposeBy})`
      : (keyName(firstChord, 0) ?? "—");
  }
  if (el.keyNote) el.keyNote.hidden = !has;
  if (!el.keyBand) return;

  clearTimeout(bandTimer);
  const on = has && transposeBy !== 0;
  el.keyBand.hidden = !on;
  if (!on) return;
  el.keyBand.textContent = `Chords in ${keyName(firstChord, transposeBy)}  ·  tap to undo`;
  bandTimer = setTimeout(() => {
    el.keyBand.hidden = true;
  }, BAND_FOR_MS);
}

/**
 * @param bytes  the PDF itself. Not a File: the same call has to serve a score
 *               being picked and one being restored from storage, and only the
 *               first of those has a File behind it.
 * @param name   for error messages.
 * @param startPage  where to land. Coming back to a score should come back to
 *               the page it was left on — a set is not always played from the
 *               top, and neither is a rehearsal.
 */
async function openScore(bytes, name, startPage = 1, id = null) {
  // pdf.js takes ownership of the buffer it is handed and leaves it detached,
  // so what goes to storage has to be a copy taken before it does.
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;

  state.doc = doc;
  state.pageCount = doc.numPages;
  state.name = name;
  state.scoreId = id;
  state.page = Math.min(Math.max(startPage, 1), doc.numPages);
  state.measures.clear();

  // A key belongs to a score, not to the app: the next song in the set is a
  // different chart and starts where it was printed.
  chordsByPage = new Map();
  firstChord = null;
  transposeBy = Number(remembered(KEY_OF(id))) || 0;
  showKey();
  pageCache.clear();
  pending.clear();

  el.scoreEmpty.hidden = true;
  el.scoreCanvas.hidden = false;
  el.nav.hidden = false;
  el.setupPanel.hidden = false;

  // A page turner whose screen has gone dark is not a page turner. This is the
  // moment it starts to matter, so this is where it is asked for.
  keepAwake();
  watchWakeLock();
  // And this is the moment the gesture is about to be wanted. If the camera is
  // not already running, starting it here is what pulls the model down — while
  // there is still, presumably, a network.
  if (!landmarker) beginWatching();

  await showPage(state.page);
  render();
  storeThumb(id, doc); // not awaited: a picture for the chooser, not for now
  renderRecent();
  scanForChords(); // not awaited either: it only decides what the panel offers

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
// Bumped so the new default applies: a stored 70ms from when the goal was
// catching quick winks would defeat the point of asking for a deliberate one.
const HOLD_KEY = "autopage.winkHold2";
// Settled by trying it: 70ms caught things nobody meant, half a second was
// tiring to hold mid-piece, and 200ms is where it stops being noticeable. The
// gap gate and the per-direction thresholds are what keep a look down out, so
// duration only has to be longer than an accident.
let gestureHoldMs = 200;

/**
 * How long a tilt has to stay over before it counts, in milliseconds.
 *
 * Its own number, not the wink's. Measured, the two gestures are not telling
 * apart by dwell alone: a two hundred millisecond wink and a tilt flicked over
 * and released without pausing both read as exactly 200ms of held direction.
 * One of those is the gesture and the other is a head moving, so the dwell
 * that makes a tilt deliberate has to be longer than the one that makes a wink
 * deliberate. The setting in the panel says "Wink length" because that is what
 * it is.
 */
const TILT_HOLD_MS = 280;
// Which eye means forward is worked out from the image, but that reasoning has
// been wrong about enough conventions in this project to deserve an override
// that takes one click rather than another round trip.
let swapEyes = false;
let gestureMode = "wink"; // "wink" | "tilt"

// Head pose is measured but gates nothing. Turning the head hides part of one
// eye and the model reports that as closing, which is where the false turns
// come from — but two attempts to correct for it were designed against
// guesses rather than against a real face, and both made things worse. It is
// displayed instead, so the correction can be built from what actually
// happens rather than from what seemed likely.

const holdFrames = () =>
  Math.max(2, Math.round((gestureHoldMs * GESTURE_FPS) / 1000));

// Frames the wink is looked for over, and how many of them have to agree.
//
// Demanding every frame is fine over two of them and impossible over fifteen:
// landmark tracking drops a frame here and there, and at half a second that
// turned into never firing at all. The tolerance has to scale with the window,
// not stay at "one dropped frame".
const VOTE_FRACTION = 0.75;
// Kept for the harness, which still reports them; nothing decides on them any
// more. What a gesture has to clear is a duration, not a number of frames.
const holdWindow = () => holdFrames() + 2;
const requiredVotes = () => Math.max(2, Math.round(holdFrames() * VOTE_FRACTION));
// One eye fully shut against one fully open is 1.0 — but a wink that only half
// closes, which is what glasses and a tired face produce, is about 0.43, and a
// default of 0.45 rejected exactly that. Calibration replaces this with a
// figure measured on the face in front of the camera.
const DEFAULT_ASYM_THRESHOLD = 0.35;
const CALIBRATION_KEY = "autopage.wink";
// Stamped into a saved calibration. Its numbers only mean anything on the scale
// that produced them, and the eyelid-geometry scale is not the blink-score one.
// v3: the sides are decided from coordinates rather than from landmark names,
// so anything measured before this had a chance of being mirrored.
const CALIBRATION_SCALE = "eyelid-v3";
const SWAP_KEY = "autopage.winkSwap";
const MODE_KEY = "autopage.gestureMode";

// The head tilt, for faces the eyelids cannot be read on.
//
// A lens rim sits exactly where the lid contour is and reflections wash out the
// lower lid, so eyelid geometry is at its limit behind glasses — that is not a
// threshold that can be tuned, it is the measurement being obstructed. A tilt
// is geometry of a different kind: the angle of the line between the eyes. No
// lens is in its way, so it reads the same with glasses on or off, and it is
// the one gesture that does.
//
// It carries both directions on its own. Tilting to the player's right turns
// forward, to their left turns back — the eyebrows used to carry forward, and
// they are gone: a brow raise was a second scale to calibrate, a second thing
// to explain, and one that could only ever mean one of the two directions.
//
// Twelve degrees, down from seventeen, and the reason it can come down is a
// change in what the speed test means.
//
// A tilt also has to arrive quickly, because angle alone does not say whether
// it was meant. Nodding to the beat is pitch, and pitch does not change the
// angle between the eyes at all, so it is invisible here. Leaning the head over
// for expression does change it, and reaches the same angles a command does —
// but it drifts in over a second or more where a command arrives in about a
// third of one. Measured against both, inside a 300ms window: an expressive
// lean to 20 degrees over 1.5s moves 3.6 degrees, one to 25 over 2.5s moves
// 2.7, and a deliberate tilt moves 11 to 18.
//
// The mistake was asking that of *every* frame of the gesture. Past the angle
// AND still moving fast, for five frames running, is only satisfiable by
// overshooting — you have to be accelerating through seventeen degrees, so you
// end up at twenty-five, and it is the neck that pays. Reported as "tilt too
// far, head hurts", and it was the rule, not the number.
//
// Arriving quickly is a fact about how the head got here, not about what it is
// doing this instant. So the onset is latched: once the head has moved
// decisively away from level, that counts for the next 0.6s, and the frames
// after it only have to hold the angle. Flick it over and stop — which is what
// the gesture always looked like it was asking for.
const ROLL_THRESHOLD = 0.16; // radians, about 9 degrees from where the head rests
const ROLL_RATE = 0.14; // radians of change within 300ms, about 8 degrees
const ONSET_FRAMES = Math.round(0.6 * 30); // how long an onset stays good for
const ROLL_WINDOW_MS = 300; // the span ROLL_RATE is measured over

let landmarker = null;
let camStream = null;
let gestureTimer = null;
let gestureHold = 0;
// The longest a direction has been held since this was last cleared. Kept so
// that "how long does this movement actually read as a gesture?" is a number
// somebody can look at rather than a guess.
let peakHeld = 0;
let gestureDirection = 0;
// The last few frames' verdicts. A quick wink can dip under the threshold for
// a frame on its way up or down, and demanding an unbroken run throws the
// whole gesture away over that one frame.
const recent = [];
let lastGestureAt = -Infinity;
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
const rollHistory = []; // {at, roll}, trimmed by time rather than by count

/**
 * The moment the frame being processed happened.
 *
 * Every gate below used to be counted in frames — a 300ms rate window was
 * "the last 9 samples", an onset stayed good for "18 frames". That is only the
 * same thing as time while the camera holds 30fps, and it does not: rendering
 * a page, a warm iPad or another app running turns 30 into 12 without warning,
 * and every threshold silently moves with it. The gesture worked, then
 * suddenly did not, for no reason the player could see.
 */
let frameNow = 0;
let rollRate = 0;
let onsetAge = Infinity; // frames since the head last moved away from level
let onsetSign = 0; // and which way it went

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
      `Calibrated ${calibration.savedAt ?? "earlier"} · x${(calibration.separation ?? 0).toFixed(1)} separation`;
  } else if (staleCalibration) {
    target.textContent = "Old calibration discarded. Calibrate again.";
  } else {
    target.textContent = "Not calibrated — using defaults.";
  }

  // And on the first screen, next to the button, in four words.
  //
  // A calibration is kept and survives reloads, but that was only visible by
  // opening the settings — so the honest answer to "do I have to do this every
  // time?" was yes as far as anyone could tell. Put beside the button it
  // answers itself.
  el.startCalibrateState.textContent = calibration
    ? `Calibrated ${calibration.savedAt ?? "earlier"} — kept on this device`
    : staleCalibration
    ? "Old calibration discarded"
    : "Not calibrated yet — optional";
}

/**
 * Bring back the hand setting, without bringing back the model.
 *
 * The box is ticked and the model is fetched when the camera is next running
 * — there is nothing for a hand recogniser to watch before then, and 8MB is
 * not something to spend on a page that may only be opening a PDF.
 */
function loadThumbs() {
  thumbsOn = remembered(THUMBS_KEY) === "1";
  thumbsDownOn = remembered(THUMBS_DOWN_KEY) !== "0";
  naturalStep = remembered(NATURAL_STEP_KEY) !== "0";
  if (el.thumbsOn) el.thumbsOn.checked = thumbsOn;
  if (el.thumbsDownOn) el.thumbsDownOn.checked = thumbsDownOn;
  if (el.naturalStepOn) el.naturalStepOn.checked = naturalStep;
}

function loadHold() {
  const stored = Number(localStorage.getItem(HOLD_KEY));
  if (stored >= 100 && stored <= 1500) gestureHoldMs = stored;
  el.holdInput.value = String(gestureHoldMs);

  swapEyes = localStorage.getItem(SWAP_KEY) === "1";
  el.swapInput.checked = swapEyes;

  // "brow" is what this used to be stored as, back when raising the eyebrows
  // was forward and the tilt was only back. The tilt carries both directions
  // now, so anyone already on that mode belongs here.
  // The tilt is the default, everywhere. It is the one that works behind
  // glasses, and on a stand at arm's length — which is where this lives — the
  // eyelid measure is at its weakest while the angle between the eyes barely
  // notices the distance. The wink is the choice you make, not the one you are
  // given. ("brow" is what the tilt used to be stored as.)
  const storedMode = localStorage.getItem(MODE_KEY);
  gestureMode = storedMode === "wink" ? "wink" : "tilt";
  el.modeTilt.checked = gestureMode === "tilt";
  el.modeWink.checked = gestureMode === "wink";
  describeGesture();
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

  // 720p, not VGA. On a stand the face is 50-70cm away and small in frame, and
  // at VGA an eyelid gap is a handful of pixels there — which is the measurement
  // running out, not a threshold needing a nudge. Asked for as `ideal` so a
  // camera that cannot manage it still starts.
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
  });
  el.camPreview.srcObject = camStream;
  // A play() that a newer load supersedes rejects with AbortError, and that
  // is not a failure — the newer load is the one that matters. Letting it
  // throw here abandoned the rest of this function and left the camera half
  // started, with no timer watching it and nothing on screen to say so.
  await el.camPreview.play().catch(() => {});

  lastSeenTime = -1;
  lastAdvanceAt = performance.now();
  if (thumbsOn) startHands().catch((err) => console.warn("hands:", err.message));
  gestureTimer = setInterval(onGestureFrame, Math.round(1000 / GESTURE_FPS));
  el.holdField.hidden = false;
  el.swapField.hidden = false;
  el.modeField.hidden = false;
  describeGesture();
}

function stopGesture() {
  stopHands();
  clearInterval(gestureTimer);
  gestureTimer = null;
  lastSeenTime = -1;
  lastAdvanceAt = 0;
  gestureLatched = false;
  gestureHold = 0;
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  el.camPreview.srcObject = null;
  el.camPreview.hidden = true;
  el.holdField.hidden = true;
  el.swapField.hidden = true;
  el.modeField.hidden = true;
  landmarker?.close();
  landmarker = null;
}

/**
 * Which way this frame votes: +1 forward, -1 back, 0 nothing.
 *
 * Both tests have to pass — the eyes far apart as a proportion, and far apart
 * outright. Pulled out as a function with no state so it can be checked against
 * real numbers, which is what the frame loop around it cannot be: the headless
 * camera has no face, so nothing downstream of "is there a face" was ever
 * exercised before it shipped.
 */
/**
 * Thresholds, per direction.
 *
 * One number for both eyes assumes the two are equally readable, and they are
 * not: a lens rim, a light on one side, or a face that simply winks harder one
 * way leaves one direction below a shared threshold and dead, while the other
 * works — which is exactly how it was reported. Each direction is measured on
 * its own during calibration and judged on its own here.
 */
function limitsFor(direction) {
  const side = direction > 0 ? "forward" : "back";
  return {
    threshold: calibration?.[side]?.threshold ?? asymThreshold(),
    gate: calibration?.[side]?.gate ?? minAbsDiff(),
  };
}

function minAbsDiff() {
  // Set from the wink that was actually measured, not from a constant. Whether
  // the winking eye reads as fully shut depends on the face, the camera and the
  // glasses, and a gate that assumes it does blocks every wink on a face where
  // it does not.
  return calibration?.minAbsDiff ?? MIN_ABS_DIFF;
}

/** How far the head has to go over, in radians. Measured if it has been. */
function tiltLimit() {
  if (calibration?.mode === "tilt") return calibration.tilt?.limit ?? ROLL_THRESHOLD;
  return ROLL_THRESHOLD;
}

/**
 * Which sign of roll means "tilted to the player's right", and so forward.
 *
 * Unmirrored, the player's right eye falls on the left of the image, and
 * dropping it towards their right shoulder turns the eye line clockwise on
 * screen — which comes out of atan2 negative. That is the default. It is not
 * relied on: calibration watches which way the roll actually went when the
 * player was asked to tilt right, and the Swap sides box is there for the case
 * where neither was right.
 */
const DEFAULT_TILT_SIGN = -1;

function tiltSign() {
  const measured = calibration?.mode === "tilt" ? calibration.tilt?.forwardSign : null;
  return (measured ?? DEFAULT_TILT_SIGN) * (swapEyes ? -1 : 1);
}

/** How fast it has to arrive. Measured if it has been. */
function tiltRate() {
  if (calibration?.mode === "tilt") return calibration.tilt?.rate ?? ROLL_RATE;
  return ROLL_RATE;
}

function tiltDirection(roll) {
  if (Math.abs(roll) <= tiltLimit()) return 0;
  // The onset is remembered rather than demanded of this frame — see the note
  // on ROLL_THRESHOLD. Holding still at the angle is the rest of the gesture,
  // and holding still is not something a neck should have to fight.
  if (onsetAge > ONSET_FRAMES) return 0;
  // A tilt that began to the left is not a tilt to the right, however far the
  // head ends up over.
  if (onsetSign !== Math.sign(roll)) return 0;
  return roll * tiltSign() > 0 ? 1 : -1;
}

function winkDirection(signedAsym, absDiff) {
  const towards = signedAsym > 0 ? 1 : -1;
  const { threshold, gate } = limitsFor(towards);
  if (absDiff <= gate) return 0;
  return Math.abs(signedAsym) > threshold ? towards : 0;
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
// A ratio between two small numbers is noise. Looking down lowers both lids, so
// both gaps shrink together and a difference that means nothing becomes a large
// ratio — glancing at the keyboard and back was turning pages on it. A wink has
// one eye shut and the other wide, so the gap between them is large in absolute
// terms too, and that is what is required here on top of the ratio.
const MIN_ABS_DIFF = 0.012; // in face heights, used only before calibrating

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
/**
 * Where this player's head rests, tracked while they sit there.
 *
 * Nobody's eyes are level. A stand off to one side, a strap, a habit of
 * leaning in — seven degrees is ordinary, and measured from horizontal that
 * makes one direction seven degrees short and the other seven degrees over.
 * It worked one way and not the other, and it changed whenever they shifted,
 * which is what "it works, then suddenly it doesn't" actually was.
 *
 * So level is wherever the head has been sitting, not where the horizon is. It
 * follows slowly, and only while the head is somewhere a gesture is not: hold
 * a tilt and it stays put, or the gesture would dissolve underneath you.
 */
let neutralRoll = null;
let neutralSeenAt = -Infinity;
// Level follows quickly when the head is near it and slowly when it is far.
//
// Far from level is ambiguous by nature: a head held twenty degrees over is
// either a gesture or somebody who has leaned into the stand, and at the
// moment it happens there is nothing to tell them apart. Adopting it slowly
// splits the difference honestly — a gesture lasts under a second and barely
// moves level at all, while a posture is still there ten seconds later and
// gets taken on. It is also what stops straightening up out of a long lean
// from reading as a deliberate tilt the other way.
const NEUTRAL_TAU_MS = 2500; // near level: ordinary drift, followed readily
const NEUTRAL_SLOW_TAU_MS = 6000; // far from it: taken on only if it persists
const NEUTRAL_FORGET_MS = 3000; // a face gone this long is probably a new one

/** How far the head is tilted, in radians, from where this head rests. */
function headRoll(landmarks) {
  const a = landmarks[33];
  const b = landmarks[263];
  if (!a || !b) return 0;
  const raw = Math.atan2(b.y - a.y, b.x - a.x);

  // First sight, or a new person: take where they are as level at once. There
  // is no useful halfway state to sit in while it converges.
  if (neutralRoll === null || frameNow - neutralSeenAt > NEUTRAL_FORGET_MS) {
    neutralRoll = raw;
    rollHistory.length = 0;
  }
  const dt = Math.max(0, Math.min(500, frameNow - neutralSeenAt));
  neutralSeenAt = frameNow;

  const roll = raw - neutralRoll;

  // The rate window is 300 milliseconds, not nine frames.
  //
  // Nine frames is 300ms only while the camera holds 30, and it does not: a
  // page being rendered, a warm iPad or another app turns 30 into 12 without
  // warning. At 8fps those nine frames spanned more than a second, so a slow
  // lean looked exactly like a flick and turned the page on its own.
  rollHistory.push({ at: frameNow, roll });
  while (rollHistory.length > 1 && frameNow - rollHistory[0].at > ROLL_WINDOW_MS) {
    rollHistory.shift();
  }
  const delta = roll - rollHistory[0].roll;
  rollRate = Math.abs(delta);

  // Level follows the head only while the head is still. Mid-movement it is a
  // gesture, and level stays where it was or the gesture dissolves underneath.
  // Not while calibrating: that asks the player to hold a tilt for a couple of
  // seconds, and level creeping towards it would make the tilt they performed
  // read as smaller than it was.
  if (!calibrating && rollRate < tiltRate() * 0.5) {
    const near = Math.abs(roll) < tiltLimit() * 0.6;
    const tau = near ? NEUTRAL_TAU_MS : NEUTRAL_SLOW_TAU_MS;
    neutralRoll += roll * (1 - Math.exp(-dt / tau));
  }

  onsetAge += 1;
  // Away from level, not back towards it. Straightening up from a lean is quick
  // too, and it sweeps back down through every angle it came up through — which
  // is how "I looked back and the page had turned" happens. Only movement that
  // deepens a tilt starts one.
  if (rollRate > tiltRate() && delta * roll > 0) {
    onsetAge = 0;
    onsetSign = Math.sign(roll);
  }

  return roll;
}

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
  if (sum / height < BOTH_SHUT) return { asym: 0, absDiff: 0, openL: 0, openR: 0 };

  // Positive when the right eye is the more closed one, which is the direction
  // the panel promises turns the page forward.
  return {
    asym: (left.gap - right.gap) / sum,
    absDiff: Math.abs(left.gap - right.gap) / height,
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

/**
 * A camera that has stopped is the one failure nobody can see.
 *
 * This used to be `if (readyState < 2) return` and nothing else, so a video
 * element that had been paused — which Android does freely after a full
 * screen overlay, a sign-in window or a trip to another app — left the
 * gesture dead with no sign of it anywhere. The score sits there and tilting
 * your head does nothing, which is indistinguishable from the gesture being
 * broken.
 */
const CAMERA_STALL_MS = 2500;
let faceFrames = 0; // only so the cost of anything else can be measured
let lastSeenTime = -1; // the video's own clock, which stops when it does
let lastAdvanceAt = 0;
let reviving = false;

async function reviveCamera() {
  // Not while the camera is still being started: the two would be setting
  // srcObject and calling play() over each other.
  if (reviving || !gestureTimer) return;
  reviving = true;
  setProgress("Restarting the camera…");
  try {
    // A paused element is the common case and the cheap one. Try that before
    // asking for the camera again, which can prompt and always costs a second.
    if (el.camPreview.paused) await el.camPreview.play().catch(() => {});

    const track = camStream?.getVideoTracks?.()[0];
    if (!camStream || !track || track.readyState === "ended") {
      camStream?.getTracks().forEach((t) => t.stop());
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      });
      el.camPreview.srcObject = camStream;
      await el.camPreview.play();
    }
    lastSeenTime = -1;
    lastAdvanceAt = performance.now();
    setProgress("");
  } catch (err) {
    setProgress("The camera stopped.", "problem", {
      label: "Restart",
      run: () => {
        stopGesture();
        startGesture().catch((e) => setProgress(`Camera: ${e.message}`, "problem"));
      },
    });
  } finally {
    reviving = false;
  }
}

function onGestureFrame() {
  if (!landmarker) return;
  const video = el.camPreview;
  const now = performance.now();

  // Whether the picture is moving, which is not the same question as whether
  // the element is ready. A paused video still reports readyState 2 and still
  // hands over its last frame for ever, so asking readiness finds nothing
  // wrong while the gesture quietly reads one frozen face thirty times a
  // second. Its own clock is the thing that stops.
  if (video.currentTime !== lastSeenTime) {
    lastSeenTime = video.currentTime;
    lastAdvanceAt = now;
  }
  if (!lastAdvanceAt) lastAdvanceAt = now;

  if (now - lastAdvanceAt > CAMERA_STALL_MS) {
    reviveCamera();
    return;
  }
  if (video.readyState < 2) return;

  faceFrames++;
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
  processFrame(result.faceLandmarks?.[0], result.faceBlendshapes?.[0]?.categories);
}

/**
 * Everything that happens once a face has been found.
 *
 * Split out so a test can drive it with landmarks it makes up. A headless
 * camera has no face in it, so this whole path — the eye measure, the
 * thresholds, the vote counting, the turn itself — used to ship unexercised,
 * and it broke twice in a row with nothing to notice.
 */
/**
 * @param now  When this frame happened, in milliseconds. Defaults to the clock.
 *             Passing it lets the harness replay one physical gesture at any
 *             frame rate, which is the only way to check that the frame rate
 *             does not change what the gesture feels like.
 */
function processFrame(landmarks, shapes, now = performance.now()) {
  frameNow = now;
  if (landmarks) updateHeadPose(landmarks);
  if (!shapes || !landmarks) {
    gestureHold = 0;
    // Hold the calibration clock rather than filling a phase with nothing.
    // Without this it counts down against an empty frame and reports a result
    // built from no samples at all.
    prevPoints = null;
    yawHistory.length = 0;
    yawSwing = 0;
    rollHistory.length = 0;
    rollRate = 0;
    onsetAge = Infinity;
    onsetSign = 0;
    if (calibrating) {
      calibrating.until += 1 / GESTURE_FPS;
      el.gestureAsym.textContent = "Waiting — no face in frame. Move into view.";
    } else {
      el.gestureAsym.textContent = `no face in frame${handLine()}`;
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
  const absDiff = eyes ? eyes.absDiff : 0;

  // Kept only to show alongside, so the two measures can be compared on a real
  // face instead of argued about.
  const bsDiff = blendshape(shapes, "eyeBlinkLeft") - blendshape(shapes, "eyeBlinkRight");

  if (calibrating) {
    // In tilt mode the measurement is an angle, and its sign is the whole
    // point — it is what says which way "right" came out on this camera. So the
    // signed roll is what gets recorded, not its size.
    if (gestureMode === "tilt") {
      const roll = headRoll(landmarks);
      // How fast the head moved, as well as how far. Both gates are measured
      // through the same camera at the same angle, so both have to be learned
      // from it — see finishTiltCalibration.
      const phase = phases()[calibrating.index].key;
      (calibrating.rates[phase] ??= []).push(rollRate);
      return sampleCalibration(roll, Math.abs(roll), 1);
    }
    return sampleCalibration(asym, Math.abs(asym), absDiff);
  }

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
  const sign = (calibration?.forwardSign ?? 1) * (swapEyes ? -1 : 1);
  const signed = asym * sign;

  recordFrame({
    t: nowSeconds() % 1000,
    l: left, r: right, d: asym, y: headYaw, s: yawSwing, p: poseReliable,
  });
  notePeaks(left, right, asym);

  if (gestureMode === "tilt") {
    // The swing veto does not apply here, and applying it made the gesture veto
    // itself. It exists because a wink moves no head at all, so head movement
    // during one can only be something else — reasoning that says nothing about
    // a gesture which *is* head movement. Worse, the yaw proxy is built from
    // nose-to-eye-corner distances, and rolling the head changes those: a tilt
    // arriving at the speed this mode demands registered as a shake and threw
    // away the first four frames of every one. What separates a deliberate tilt
    // from swaying is its own angle and onset, below; nothing else is needed.
    const unstable = !poseReliable;
    const roll = headRoll(landmarks);
    const towards = roll * tiltSign() > 0 ? "forward" : "back";
    const deg = (rad) => `${rad >= 0 ? "+" : ""}${((rad * 180) / Math.PI).toFixed(0)}°`;
    el.gestureAsym.textContent =
      `tilt  roll ${deg(roll)} (${towards})  moving ${((rollRate * 180) / Math.PI).toFixed(0)}°/0.3s` +
      `  held ${Math.round(peakHeld)}/${gestureMode === "tilt" ? TILT_HOLD_MS : gestureHoldMs}ms${unstable ? "  TURNED AWAY" : ""}\n` +
      `needs  past ${((tiltLimit() * 180) / Math.PI).toFixed(0)}°, flicked there faster than ` +
      `${((tiltRate() * 180) / Math.PI).toFixed(0)}°/0.3s  —  ` +
      `${onsetAge > ONSET_FRAMES ? "no flick yet" : `flicked ${onsetAge}f ago`}` +
      handLine();
    return decide(unstable ? 0 : tiltDirection(roll), unstable);
  }

  el.gestureAsym.textContent =
    `now  openL ${left.toFixed(3)}  openR ${right.toFixed(3)}  diff ${asym >= 0 ? "+" : ""}${asym.toFixed(2)}` +
    `  gap ${absDiff.toFixed(3)}/${limitsFor(signed > 0 ? 1 : -1).gate.toFixed(3)}` +
    `  held ${Math.round(peakHeld)}/${gestureMode === "tilt" ? TILT_HOLD_MS : gestureHoldMs}ms${!poseReliable ? "  TURNED" : shaking ? "  SHAKING" : ""}\n` +
    `peak openL ${peaks.l.toFixed(3)}  openR ${peaks.r.toFixed(3)}  diff ${peaks.net.toFixed(2)} ` +
    `/ ${limitsFor(signed > 0 ? 1 : -1).threshold.toFixed(2)}   yaw ${headYaw.toFixed(2)}/${MAX_YAW}` +
    ` swing ${yawSwing.toFixed(2)}/${MAX_YAW_SWING}` +
    `   blendshape diff ${bsDiff >= 0 ? "+" : ""}${bsDiff.toFixed(2)}` +
    handLine();

  decide(shaking ? 0 : winkDirection(signed, absDiff), shaking);
}

/**
 * Turn the page, or don't, on this frame's verdict.
 *
 * Shared by both gestures. Everything above it is the measurement, which is
 * where the two differ; the voting, the release latch and the cooldown are the
 * same rules whichever way the page was asked for, and having had two copies of
 * them is how one mode kept drifting away from the other.
 */
function decide(direction, shaking) {
  if (shaking) {
    recent.length = 0;
    gestureHold = 0;
    gestureDirection = 0;
    return;
  }

  // Held for two hundred milliseconds, not for six frames.
  //
  // Six frames is 200ms at 30 and half a second at 12, so the dwell that made
  // a gesture deliberate grew and shrank with whatever else the iPad was
  // doing. The window is time now, and the vote inside it is still a fraction
  // rather than a run, because a landmark drops out for a frame and that
  // should not undo the gesture.
  recent.push({ at: frameNow, d: direction });
  const span = (gestureMode === "tilt" ? TILT_HOLD_MS : gestureHoldMs) * 1.6;
  while (recent.length > 2 && frameNow - recent[0].at > span) recent.shift();

  // How long this direction has been going, and how cleanly.
  //
  // Measured from when it started rather than across a fixed buffer, so the
  // frames before the gesture began do not count against it — and a landmark
  // that drops out for a frame costs a vote rather than the whole gesture.
  const agreeing = direction === 0 ? [] : recent.filter((e) => e.d === direction);
  // A frame stands for the interval it ends, so the first agreeing frame is
  // worth one sampling gap of dwell. Without that a gesture of exactly the
  // hold length always measures one frame short of it — which at 30fps is the
  // difference between a 200ms wink working and not.
  const gap = recent.length > 1 ? (frameNow - recent[0].at) / (recent.length - 1) : 0;
  const heldFor = agreeing.length ? frameNow - agreeing[0].at + gap : 0;
  const sinceStart = agreeing.length
    ? recent.filter((e) => e.at >= agreeing[0].at).length
    : 0;
  const votes = agreeing.length;
  const needHeld = gestureMode === "tilt" ? TILT_HOLD_MS : gestureHoldMs;
  // A millisecond of slack, because heldFor is a sum of floating point frame
  // gaps and a gesture of exactly the hold length lands on 199.999999999998.
  const held =
    direction !== 0 && heldFor >= needHeld - 1 && votes / sinceStart >= VOTE_FRACTION;
  if (heldFor > peakHeld) peakHeld = heldFor;
  gestureHold = votes;
  gestureDirection = direction;

  // One turn per wink. A gesture that fires on a hold would otherwise fire
  // again every cooldown for as long as the eye stays shut, and holding a wink
  // a beat too long is the most natural thing in the world — so the eye has to
  // open again before the next one counts.
  if (direction === 0) {
    gestureLatched = false;
    peakHeld = 0;
  }

  if (
    !gestureLatched &&
    held &&
    frameNow - lastGestureAt > GESTURE_COOLDOWN_S * 1000
  ) {
    gestureHold = 0;
    gestureLatched = true;
    lastGestureAt = frameNow;
    const gesture = gestureMode === "tilt" ? "tilt" : "wink";
    state.turnedBy = gesture;
    // Say what the numbers were, every time, so a wrong turn explains itself
    // without anyone having to catch it happening.
    lastWinkReport = traceReport(`${gesture} ${direction > 0 ? "forward" : "back"}`);
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

const WINK_PHASES = [
  { key: "noise", seconds: 6, prompt: "Blink normally." },
  { key: "right", seconds: 6, prompt: "Wink your RIGHT eye. Repeat." },
  { key: "left", seconds: 6, prompt: "Wink your LEFT eye. Repeat." },
];
const TILT_PHASES = [
  { key: "noise", seconds: 6, prompt: "Head level. Sway as you would playing." },
  { key: "right", seconds: 6, prompt: "Flick your head RIGHT. Repeat." },
  { key: "left", seconds: 6, prompt: "Flick your head LEFT. Repeat." },
];
const phases = () => (gestureMode === "tilt" ? TILT_PHASES : WINK_PHASES);

/**
 * Say what the app is actually watching for, in the mode it is actually in.
 *
 * Three gestures turn pages, not two, and the head tilt was the one with no
 * description anywhere — it lived in a clause at the end of a checkbox label.
 * A gesture nobody has been told about reads as the app misfiring. The numbers
 * come from the constants above so the text cannot drift away from the code.
 */
function describeGesture() {
  const deg = (rad) => Math.round((rad * 180) / Math.PI);

  if (gestureMode === "tilt") {
    el.gestureHelp.textContent =
      `Right ${deg(tiltLimit())}° → forward\n` +
      `Left ${deg(tiltLimit())}° → back\n` +
      "Flick it. A slow lean does not count.";
  } else {
    el.gestureHelp.textContent =
      "Wink right eye → forward\n" +
      "Wink left eye → back\n" +
      "Blinks are ignored.";
  }

  el.holdLabel.textContent = gestureMode === "tilt" ? "Hold length (ms)" : "Wink length (ms)";
}

function setCardMessage(text) {
  el.gestureStatus.hidden = !text;
  el.gestureStatus.textContent = text || "";
  showWatch();
}

/** The card exists only while it has a prompt, a preview, or a problem. */
function showWatch() {
  el.watch.hidden = el.gestureStatus.hidden && el.camPreview.hidden && el.allowBtn.hidden;
  publishWatchHeight();
}

/**
 * Tell the stylesheet where the camera card ends, so the panel can stop above
 * it.
 *
 * The card floats over everything at the top of the screen and the panel grows
 * upward from the bottom. On an iPad they never meet; on a phone the panel
 * reached up behind the card and the first thing it hid was Open PDF. Nothing
 * in CSS can know the card's height — it depends on the prompt's wording and
 * whether the preview is up — so it is measured.
 */
function publishWatchHeight() {
  const bottom = el.watch.hidden ? 0 : Math.round(el.watch.getBoundingClientRect().bottom);
  document.documentElement.style.setProperty("--watch-bottom", `${bottom}px`);
}

// The card changes height on its own: a longer prompt wraps, the preview
// appears and disappears. Watching it is simpler than finding every caller.
if (typeof ResizeObserver === "function") {
  new ResizeObserver(publishWatchHeight).observe(el.watch);
}
window.addEventListener("resize", publishWatchHeight);

function startCalibration() {
  if (calibrating) {
    // A second press cancels: a calibration that cannot see a face would
    // otherwise wait forever with no way out.
    calibrating = null;
    el.camPreview.hidden = true;
    el.cancelCalibBtn.hidden = true;
    setCardMessage("");
    showWatch();
    el.calibrateBtn.textContent = "Calibrate";
    showCalibrationState();
    return;
  }
  el.calibrateBtn.textContent = "Cancel";
  el.cancelCalibBtn.hidden = false;
  // Out of the way, rather than half-covered. Everything calibration needs —
  // the prompt, your face, and the way out — is in the card at the top, and on
  // a phone the panel underneath it had nowhere to be that the card was not
  // already sitting on.
  collapseSetup(true);
  calibrating = {
    index: 0,
    samples: { noise: [], right: [], left: [] },
    rates: { noise: [], right: [], left: [] },
    eyePeaks: { right: 0, left: 0 },
    gapPeaks: { right: 0, left: 0 },
    until: 0,
  };
  el.camPreview.hidden = false;
  showWatch();
  nextCalibrationPhase();
}

function nextCalibrationPhase() {
  const phase = phases()[calibrating.index];
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

function sampleCalibration(asym, closedEye, absDiff) {
  const phase = phases()[calibrating.index];
  calibrating.samples[phase.key].push(asym);
  if (phase.key !== "noise") {
    calibrating.eyePeaks[phase.key] = Math.max(calibrating.eyePeaks[phase.key], closedEye);
    calibrating.gapPeaks[phase.key] = Math.max(calibrating.gapPeaks[phase.key], absDiff);
  }
  const remaining = Math.max(0, calibrating.until - nowSeconds());
  el.gestureAsym.textContent =
    `${phase.prompt}  ${remaining.toFixed(0)}s\n` +
    `live  closed ${closedEye.toFixed(2)}  diff ${asym >= 0 ? "+" : ""}${asym.toFixed(2)}`;
  if (remaining > 0) return;

  calibrating.index += 1;
  if (calibrating.index < phases().length) return nextCalibrationPhase();

  finishCalibration();
}

function finishCalibration() {
  const { noise, right, left } = calibrating.samples;
  const rates = calibrating.rates;
  const eyePeaks = calibrating.eyePeaks;
  const gapPeaks = calibrating.gapPeaks;
  const mode = gestureMode;
  calibrating = null;
  el.camPreview.hidden = true;
  el.cancelCalibBtn.hidden = true;
  el.calibrateBtn.textContent = "Calibrate";
  showWatch();

  // A tilt is an angle, not a pair of eyelids. None of what follows applies to
  // it, so it does not run through any of it.
  if (mode === "tilt") return finishTiltCalibration(noise, right, left, rates);

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
      `Not saved — the wink did not register (${closedPeak.toFixed(2)}, needs 0.6).\n` +
      "More light, or move closer."
    );
    return;
  }

  // Each direction gets the limits its own wink earned. Taking the weaker of
  // the two and applying it to both is what left one eye working and the other
  // dead.
  const limits = (level, gapPeak) => ({
    threshold: thresholdFrom(noiseLevel, level),
    gate: Math.max(0.006, Math.min(0.02, gapPeak * 0.4)),
    level,
    gapPeak,
  });
  const forward = limits(
    forwardSign > 0 ? rightLevel : leftLevel,
    forwardSign > 0 ? gapPeaks.right : gapPeaks.left
  );
  const back = limits(
    forwardSign > 0 ? leftLevel : rightLevel,
    forwardSign > 0 ? gapPeaks.left : gapPeaks.right
  );
  const gapPeak = Math.min(gapPeaks.right, gapPeaks.left);
  const gate = Math.max(0.006, Math.min(0.02, gapPeak * 0.4));

  calibration = {
    scale: CALIBRATION_SCALE,
    mode: "wink",
    threshold, separation, forwardSign, rightLevel, leftLevel, noiseLevel,
    minAbsDiff: gate, gapPeak, forward, back,
    savedAt: new Date().toISOString().slice(0, 10),
  };
  staleCalibration = false;
  try {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
  } catch {}

  // Three words, then the numbers. The verdict is what someone needs in the
  // two seconds after calibrating; the levels behind it belong in the panel,
  // for the day something is wrong and they have to be asked for.
  const verdict =
    separation >= 2.5 ? "Good." : separation >= 1.5 ? "Will work, expect the odd miss." : "Unreliable — use the tap zones.";

  setCardMessage(`Calibrated. ${verdict}`);
  el.calibStatus.textContent =
    `forward ${forward.level.toFixed(2)}/${forward.threshold.toFixed(2)}  ` +
    `back ${back.level.toFixed(2)}/${back.threshold.toFixed(2)}  x${separation.toFixed(1)}`;
  showCalibrationState();
  setTimeout(() => setCardMessage(""), 12000); // then get off the score
}

/**
 * Turn three phases of head angles into a limit and a direction.
 *
 * Two things come out of this, and the second matters more than the first.
 * The limit is how far over counts, set from the tilt the player actually
 * performed rather than from a constant. The direction is which sign of roll
 * their right-hand tilt produced on this camera — measured, because a mirrored
 * preview, a front camera and a rear one give three chances to get it
 * backwards, and getting it backwards swaps forward and back.
 */
function finishTiltCalibration(noise, right, left, rates) {
  // Swaying at the keyboard is what a tilt has to clear, so the level phase is
  // deliberately not "hold still" — it is "sway as you would playing".
  const noiseLevel = Math.max(percentile(noise.map(Math.abs), 0.95), 0.03);

  const rightPos = topMean(right, 0.1);
  const rightNeg = topMean(right.map((v) => -v), 0.1);
  const leftPos = topMean(left, 0.1);
  const leftNeg = topMean(left.map((v) => -v), 0.1);

  const rightLevel = Math.max(rightPos, rightNeg);
  const leftLevel = Math.max(leftPos, leftNeg);
  const forwardSign = rightPos >= rightNeg ? 1 : -1;
  const level = Math.min(rightLevel, leftLevel);
  const deg = (rad) => ((rad * 180) / Math.PI).toFixed(0);

  // Under about nine degrees the tilt is inside the range a player sways
  // through anyway. No threshold rescues that, and storing it would spend the
  // session turning pages on posture.
  if (level < 0.15) {
    setCardMessage(
      `Not saved — tilt was only ${deg(level)}°, swaying reaches ${deg(noiseLevel)}°.\n` +
        "Tilt further and try again."
    );
    return;
  }

  // A fraction of what was performed, and capped at the default rather than
  // scaled from it. Calibrating with a big demonstrative tilt should not be a
  // way to sentence yourself to big tilts forever — this can lower the bar, and
  // the only thing that raises it is sway that would otherwise trip it.
  //
  // The absolute floor is a sanity guard and nothing more. It used to be 12
  // degrees, which quietly undid the measurement for anyone whose camera sees
  // them at an angle: a low music stand flattens every angle it sees, so the
  // floor was the binding gate rather than the sway it was meant to clear.
  // Sway is measured through the same camera, so `noiseLevel` is the floor that
  // actually means something.
  const limit = Math.min(0.3, Math.max(0.07, noiseLevel * 2, level * 0.4));
  const separation = level / noiseLevel;

  // The same again for how quickly a tilt has to arrive.
  //
  // This was a constant, and a constant is wrong here for exactly the reason
  // the angle was: a camera looking up at a guitarist flattens the roll it
  // sees, so it flattens the rate of change too, and the fixed requirement
  // became the thing blocking the gesture. Leaning is slowed by the same
  // factor, so the ratio between a flick and a lean survives — which is the
  // part that has to.
  const onset = Math.max(topMean(rates?.right ?? [], 0.1), topMean(rates?.left ?? [], 0.1));
  const swayRate = percentile((rates?.noise ?? []).map(Math.abs), 0.95);
  const rate = onset
    ? Math.min(ROLL_RATE, Math.max(0.04, swayRate * 1.5, onset * 0.5))
    : ROLL_RATE;

  calibration = {
    scale: CALIBRATION_SCALE,
    mode: "tilt",
    tilt: { limit, rate, forwardSign, rightLevel, leftLevel, noiseLevel },
    threshold: limit,
    separation,
    savedAt: new Date().toISOString().slice(0, 10),
  };
  staleCalibration = false;
  try {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
  } catch {}

  const verdict = separation >= 2.5 ? "Good." : "Will work, expect the odd miss.";

  setCardMessage(`Calibrated — ${deg(limit)}° turns the page. ${verdict}`);
  el.calibStatus.textContent =
    `right ${deg(rightLevel)}°  left ${deg(leftLevel)}°  sway ${deg(noiseLevel)}°  ` +
    `→ ${deg(limit)}° at ${deg(rate)}°/0.3s`;
  showCalibrationState();
  setTimeout(() => setCardMessage(""), 12000);
  describeGesture(); // the help text quotes the limit, which just changed
}

// ============================================================
// Keeping the screen on
//
// An iPad dims and locks after a couple of minutes with nothing touching it,
// and a player mid-piece is touching nothing — which is the entire point of the
// app. Without this the screen goes dark somewhere in the second page and every
// other thing here is beside the point.
// ============================================================

let wakeLock = null;

async function keepAwake() {
  if (wakeLock || !("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    // The system drops the lock on its own — switching apps, low battery. The
    // handle is not reusable after that, so it is cleared and asked for again.
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      render();
    });
  } catch (err) {
    // Refused rather than absent: a low battery, or the tab not being visible.
    // Nothing to do but say so on the panel.
    console.warn("wake lock refused:", err.message);
  }
  render();
}

// Leaving the app and coming back releases the lock without asking. Coming back
// to a score that is still open should not mean coming back to a screen that
// will go dark in two minutes.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state.doc) keepAwake();
  // Coming back is when the camera is most likely to have been paused behind
  // our back, and it is also the moment somebody is about to need it.
  if (gestureTimer && el.camPreview.paused) el.camPreview.play().catch(() => {});
});

const wakeState = () =>
  !("wakeLock" in navigator) ? "unsupported" : wakeLock ? "held" : "off";

/**
 * Ask again, periodically, for as long as a score is open.
 *
 * One request at the moment the score opens is not enough, and a screen that
 * has quietly gone back to dimming is indistinguishable from one that was never
 * held — it was reported as "screen off" on an iPad with a score up. The system
 * takes the lock back on its own (a trip to the home screen, a low battery, a
 * refusal while the document was not yet visible), and the handle does not come
 * back with it. Asking again costs nothing when it is already held.
 */
let wakeTimer = null;

function watchWakeLock() {
  clearInterval(wakeTimer);
  wakeTimer = setInterval(() => {
    if (state.doc && !wakeLock && document.visibilityState === "visible") keepAwake();
  }, 20000);
}

// A touch is the one moment Safari is certain to allow it, so take it.
document.addEventListener(
  "pointerdown",
  () => {
    if (state.doc && !wakeLock) keepAwake();
  },
  { passive: true }
);

// ============================================================
// Store — the score itself, so it does not have to be picked again
//
// Picking a file out of iCloud Drive is the last thing anyone wants to be doing
// on a stand at the start of a piece. The score that was open last time is the
// score to open, on the page it was left on.
// ============================================================

const DB_NAME = "autopage";
const DB_STORE = "scores";
const LAST = "last"; // -> the id of the score to reopen
// A worship set is four to six songs, so a cap of five scores filled up with
// one Sunday and pushed the previous one out. Sets are the unit now, and they
// are what gets pruned: whole Sundays, oldest first.
const MAX_SETS = 4;
const MAX_LOOSE = 6; // scores opened on their own, belonging to no set

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDo(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const req = fn(tx.objectStore(DB_STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

/**
 * A score's identity is its contents.
 *
 * Not its filename: the same piece arrives as "score.pdf" from three different
 * places, and two copies of one file should be one entry with one bookmark
 * rather than two that disagree about which page you are on.
 */
async function scoreId(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Everything in the store: score records, set records, the `last` pointer. */
async function allRecords() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const store = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

const byNewest = (x, y) => (y.at ?? 0) - (x.at ?? 0);

/** Every stored score, newest first. */
async function recentScores() {
  return (await allRecords()).filter((r) => r && r.bytes && r.id).sort(byNewest);
}

const setKey = (setId) => `set:${setId}`;

/**
 * The sets, newest first, each with its scores in the order they were added.
 *
 * A set is a Sunday: the songs that belong together, in the order they are
 * played. The set record holds only the order — the scores themselves stay
 * where they were, so a song in two Sundays is still one entry with one
 * bookmark.
 */
async function allSets() {
  const records = await allRecords();
  const scores = new Map(records.filter((r) => r?.bytes && r.id).map((r) => [r.id, r]));
  return records
    .filter((r) => r?.setId && Array.isArray(r.order))
    .sort(byNewest)
    .map((set) => ({ ...set, scores: set.order.map((id) => scores.get(id)).filter(Boolean) }))
    .filter((set) => set.scores.length);
}

/** Scores that belong to no set — opened one at a time. */
async function looseScores() {
  const sets = await allSets();
  const inASet = new Set(sets.flatMap((s) => s.order));
  return (await recentScores()).filter((r) => !inASet.has(r.id));
}

/**
 * Storing a score is a convenience, never a requirement. A private window, a
 * browser with storage blocked, or a quota a large score does not fit in are
 * all ordinary — the app opens the file it was handed either way, so none of
 * them is allowed to surface as an error.
 */
async function rememberScore(id, bytes, name, page, { pointAt = true } = {}) {
  try {
    const existing = await dbDo("readonly", (store) => store.get(id));
    await dbDo("readwrite", (store) =>
      store.put(
        { id, bytes, name, page: existing?.page ?? page, thumb: existing?.thumb, at: Date.now() },
        id
      )
    );
    if (pointAt) await dbDo("readwrite", (store) => store.put(id, LAST));
    await prune();
  } catch (err) {
    // Out of room is the likely one, and dropping the oldest is the answer
    // rather than refusing to remember anything ever again.
    console.warn("could not store the score:", err.message);
    await prune(MAX_SETS - 1, MAX_LOOSE - 1).catch(() => {});
  }
}

/**
 * Store a Sunday: several scores that belong together, in order.
 *
 * Named for the day rather than by the player, because that is what makes two
 * of them tell apart at a glance, and because it is what a shared folder of
 * dated subfolders will hand over later.
 */
async function rememberSet(name, ids) {
  if (!ids.length) return null;

  // Opening the same folder again is the same Sunday, not a second one that
  // happens to hold the same songs under the same heading.
  const already = (await allSets()).find(
    (s) => s.order.length === ids.length && s.order.every((id, i) => id === ids[i])
  );
  if (already) {
    const { scores: _members, ...record } = already;
    await dbDo("readwrite", (store) =>
      store.put({ ...record, at: Date.now() }, setKey(already.setId))
    ).catch(() => {});
    return already.setId;
  }

  // Two different sets on one day would otherwise both read "Nov 21", which
  // tells you nothing about which is which.
  const taken = new Set((await allSets()).map((s) => s.name));
  let unique = name;
  for (let n = 2; taken.has(unique); n++) unique = `${name} (${n})`;

  const setId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    await dbDo("readwrite", (store) =>
      store.put({ setId, name: unique, order: ids, at: Date.now() }, setKey(setId))
    );
    await prune();
  } catch (err) {
    console.warn("could not store the set:", err.message);
  }
  return setId;
}

/**
 * Keep the last few Sundays whole, and a few loose scores beside them.
 *
 * Pruning by score count was wrong once sets existed: five is one Sunday, so
 * every new Sunday erased the one before it mid-list, leaving half a set
 * behind. A Sunday goes or stays as a unit.
 */
async function prune(keepSets = MAX_SETS, keepLoose = MAX_LOOSE) {
  const sets = await allSets();
  const staying = sets.slice(0, keepSets);
  // A song can be in two Sundays. Dropping the older Sunday must not take the
  // newer one's copy of it with it — there is one stored score behind both,
  // and deleting it leaves the Sunday that is still on the list missing a
  // song it says it has.
  const stillWanted = new Set(staying.flatMap((s) => s.order));

  for (const set of sets.slice(keepSets)) {
    for (const score of set.scores) {
      if (stillWanted.has(score.id)) continue;
      await dbDo("readwrite", (store) => store.delete(score.id));
    }
    await dbDo("readwrite", (store) => store.delete(setKey(set.setId)));
  }
  for (const rec of (await looseScores()).slice(keepLoose)) {
    await dbDo("readwrite", (store) => store.delete(rec.id));
  }
}

/**
 * Add songs to a Sunday that already exists.
 *
 * Because picking them all at once is not always on offer. Google's picker
 * decides for itself whether it will let somebody select more than one thing
 * at a time, and on a phone it often will not — so the set has to be able to
 * grow instead of being whatever was caught in a single pass.
 */
async function addToSet(setId, ids) {
  const key = setKey(setId);
  try {
    const record = await dbDo("readonly", (store) => store.get(key));
    if (!record?.order) return;
    const order = [...record.order];
    for (const id of ids) if (!order.includes(id)) order.push(id);
    await dbDo("readwrite", (store) => store.put({ ...record, order, at: Date.now() }, key));
  } catch (err) {
    console.warn("could not add to the set:", err.message);
  }
}

/** Forget a whole Sunday, scores and all. */
async function removeSet(setId) {
  const sets = await allSets();
  const set = sets.find((s) => s.setId === setId);
  if (!set) return;
  // Only the songs no other Sunday is holding on to.
  const elsewhere = new Set(sets.filter((s) => s.setId !== setId).flatMap((s) => s.order));
  removed = { set, scores: set.scores };
  for (const score of set.scores) {
    if (elsewhere.has(score.id)) continue;
    await dbDo("readwrite", (store) => store.delete(score.id));
  }
  await dbDo("readwrite", (store) => store.delete(setKey(setId)));
  armUndo();
  await renderRecent();
}

/**
 * Draw the chooser, in both places it lives.
 *
 * A filename in a list is not a score anyone recognises — the top of the first
 * page is. Both containers get the same markup from here rather than one being
 * written twice and drifting.
 */
async function renderRecent() {
  const sets = await allSets();
  const loose = await looseScores();
  const total = sets.reduce((n, s) => n + s.scores.length, 0) + loose.length;

  for (const box of [el.recent, el.recentPanel]) {
    box.replaceChildren();
    // One score is not a choice — but an undo offer has to be reachable even
    // when removing the second one is what left you with one.
    box.hidden = total < 2 && !removed;
    if (box.hidden) continue;

    for (const set of sets) {
      box.append(groupHeading(set.name, set.scores.length, () => removeSet(set.setId)));
      const row = document.createElement("div");
      row.className = "recent-row";
      for (const rec of set.scores) row.append(recentTile(rec));
      box.append(row);
    }
    if (loose.length) {
      // Only worth a heading when there is a set above it to tell it from.
      if (sets.length) box.append(groupHeading("Other", loose.length));
      const row = document.createElement("div");
      row.className = "recent-row";
      for (const rec of loose) row.append(recentTile(rec));
      box.append(row);
    }
    if (removed) box.append(undoRow());
  }
}

function groupHeading(name, count, onRemove) {
  const head = document.createElement("div");
  head.className = "recent-head";

  const label = document.createElement("span");
  label.textContent = name;
  const n = document.createElement("span");
  n.className = "recent-count";
  n.textContent = count === 1 ? "1 score" : `${count} scores`;
  head.append(label, n);

  if (onRemove) {
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "recent-drop";
    drop.textContent = "−";
    drop.title = `Remove ${name} and its scores`;
    drop.setAttribute("aria-label", drop.title);
    drop.addEventListener("click", onRemove);
    head.append(drop);
  }
  return head;
}

/**
 * One entry: a picture to open it by, and a way to forget it.
 *
 * A div rather than one big button, because the remove control is a button and
 * buttons do not nest. The whole tile is still the open target — the remove is
 * a corner of it.
 */
function recentTile(rec) {
  const tile = document.createElement("div");
  tile.className = "recent-item";
  tile.title = rec.name ?? "score";
  tile.dataset.id = rec.id;
  if (rec.id === state.scoreId) tile.setAttribute("aria-current", "true");

  const open = document.createElement("button");
  open.className = "recent-open";
  open.type = "button";
  if (rec.thumb) {
    const img = document.createElement("img");
    img.src = rec.thumb;
    img.alt = "";
    open.append(img);
  } else {
    const blank = document.createElement("span");
    blank.className = "blank";
    open.append(blank);
  }
  const label = document.createElement("span");
  label.className = "recent-name";
  label.textContent = (rec.name ?? "score").replace(/\.pdf$/i, "");
  open.append(label);
  open.addEventListener("click", () => openStored(rec.id));

  const remove = document.createElement("button");
  remove.className = "recent-remove";
  remove.type = "button";
  remove.textContent = "−";
  remove.title = `Remove ${rec.name ?? "this score"} from the list`;
  remove.setAttribute("aria-label", remove.title);
  remove.addEventListener("click", (e) => {
    e.stopPropagation(); // removing it is not opening it
    removeStored(rec.id);
  });

  tile.append(open, remove);
  return tile;
}

function undoRow() {
  const row = document.createElement("div");
  row.className = "recent-undo";
  const text = document.createElement("span");
  text.textContent = `Removed ${removedLabel()}`;
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "linkish";
  undo.textContent = "Undo";
  undo.addEventListener("click", undoRemove);
  row.append(text, undo);
  return row;
}

// --- Forgetting one ---
//
// Low stakes: the file itself is still wherever it came from, and this only
// drops the stored copy and the page it was left on. Low enough not to put a
// dialog in front of it on a touch screen — but the page bookmark is worth
// something, and a "−" in the corner of a 72px tile is easy to catch with a
// thumb, so what was removed is held for a few seconds and offered back.
let removed = null;
let undoTimer = null;
const UNDO_FOR_MS = 8000;

async function removeStored(id) {
  try {
    const rec = await dbDo("readonly", (store) => store.get(id));
    if (!rec) return;
    await dbDo("readwrite", (store) => store.delete(id));
    removed = { scores: [rec] };
    armUndo();
    await renderRecent();
  } catch (err) {
    console.warn("could not remove that score:", err.message);
  }
}

function armUndo() {
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    removed = null;
    renderRecent();
  }, UNDO_FOR_MS);
}

async function undoRemove() {
  if (!removed) return;
  const { set, scores } = removed;
  removed = null;
  clearTimeout(undoTimer);
  try {
    for (const rec of scores) {
      await dbDo("readwrite", (store) => store.put(rec, rec.id));
    }
    // The set record has to come back too, or its songs return as loose ones.
    if (set) {
      const { scores: _members, ...record } = set;
      await dbDo("readwrite", (store) => store.put(record, setKey(set.setId)));
    }
  } catch (err) {
    console.warn("could not put it back:", err.message);
  }
  await renderRecent();
}

/** What the undo line says it will bring back. */
function removedLabel() {
  if (removed?.set) return `${removed.set.name} (${removed.scores.length})`;
  const name = removed?.scores?.[0]?.name ?? "score";
  return name.replace(/\.pdf$/i, "");
}

async function openStored(id) {
  if (id === state.scoreId) return collapseSetup(true); // already here
  showError("");

  markChosen(id);
  collapseSetup(true);
  setBusy(true);

  try {
    const rec = await dbDo("readonly", (store) => store.get(id));
    if (!rec?.bytes) return;
    await openScore(rec.bytes, rec.name ?? "score", rec.page ?? 1, id);
    // Which one is newest, and which to reopen next launch. Neither is worth
    // a frame of the player's time.
    dbDo("readwrite", (store) => store.put({ ...rec, at: Date.now() }, id)).catch(() => {});
    dbDo("readwrite", (store) => store.put(id, LAST)).catch(() => {});
  } catch (err) {
    showError(`Could not reopen that score — ${err.message}`);
  } finally {
    setBusy(false);
  }
}

/** Move the blue mark now, rather than when the score has finished loading. */
function markChosen(id) {
  for (const box of [el.recent, el.recentPanel]) {
    for (const tile of box.querySelectorAll(".recent-item")) {
      if (tile.dataset.id === id) tile.setAttribute("aria-current", "true");
      else tile.removeAttribute("aria-current");
    }
  }
}

function setBusy(busy) {
  el.loading.hidden = !busy;
  el.score.classList.toggle("busy", busy);
}

/**
 * A picture of the first page, small enough to keep five of.
 *
 * Taken once per score and stored with it, because rendering five first pages
 * to choose between them would mean parsing five PDFs before the chooser could
 * be drawn — on the screen whose whole job is to be quick.
 */
async function storeThumb(id, doc) {
  try {
    if (!id || (await dbDo("readonly", (store) => store.get(id)))?.thumb) return;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 150 / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    const thumb = canvas.toDataURL("image/jpeg", 0.7);
    const rec = await dbDo("readonly", (store) => store.get(id));
    if (rec) await dbDo("readwrite", (store) => store.put({ ...rec, thumb }, id));
    renderRecent();
  } catch (err) {
    console.warn("no thumbnail:", err.message);
  }
}

let pageWrite = null;
let pendingPage = null;

async function writePage(page) {
  try {
    if (!state.scoreId) return;
    const rec = await dbDo("readonly", (store) => store.get(state.scoreId));
    if (rec) await dbDo("readwrite", (store) => store.put({ ...rec, page }, state.scoreId));
  } catch {}
}

function rememberPage(page) {
  // Turns come in bursts while someone finds their place. One write after the
  // bursts stop is all the next launch needs.
  pendingPage = page;
  clearTimeout(pageWrite);
  pageWrite = setTimeout(async () => {
    // Cleared when the write has actually landed, not when it was started. With
    // the camera running the round trip can take a second or more, and a page
    // still in flight is a page that has not been saved — the flush below has
    // to be able to see it.
    await writePage(page);
    if (pendingPage === page) pendingPage = null;
  }, 400);
}

// Swiping the app away is the normal way to put it down, and it does not wait
// for a debounce. Flush on the way out so the page you stopped on is the page
// you come back to.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && pendingPage !== null) {
    clearTimeout(pageWrite);
    const page = pendingPage;
    pendingPage = null;
    writePage(page);
  }
});

async function restoreLastScore() {
  try {
    let pointer = await dbDo("readonly", (store) => store.get(LAST));

    // What "last" used to hold was the record itself. Anyone who has used this
    // before has one, and it is their score — move it to its own id rather
    // than make them find the file again.
    if (pointer && typeof pointer === "object" && pointer.bytes) {
      const id = await scoreId(pointer.bytes);
      await dbDo("readwrite", (store) => store.put({ ...pointer, id, at: Date.now() }, id));
      await dbDo("readwrite", (store) => store.put(id, LAST));
      pointer = id;
    }
    if (typeof pointer !== "string") return false;

    const rec = await dbDo("readonly", (store) => store.get(pointer));
    if (!rec?.bytes) return false;
    await openScore(rec.bytes, rec.name ?? "the last score", rec.page ?? 1, rec.id);
    return true;
  } catch (err) {
    console.warn("could not reopen the last score:", err.message);
    return false;
  }
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
  rememberPage(next);
  showPage(next);
  render();
}

const nextPage = () => turnTo(state.page + 1);
const prevPage = () => turnTo(state.page - 1);

function renderDiag() {
  const escape = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  el.diag.innerHTML = [
    `page ${state.page}/${state.pageCount || "?"}   camera ${landmarker ? "on" : "off"}` +
      `   screen ${wakeState()}   build ${BUILD}`,
    state.turnLog.length
      ? "turns: " +
        state.turnLog
          .slice(-4)
          .map((t) => `${t.from}\u2192${t.to} <b>${t.by}</b> ${t.at}`)
          .join("   ")
      : "turns: none yet",
    // Why the last gesture-driven turn happened, frame by frame. It used to sit
    // in the status line above the controls, where it was the longest thing in
    // the panel by far and the first thing anyone read.
    lastWinkReport ? escape(lastWinkReport) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function setStatus(text) {
  el.setupStatus.textContent = text;
}

function showError(message) {
  el.scoreError.textContent = message;
  el.scoreError.hidden = !message;
}

/**
 * What is happening, while it is happening.
 *
 * Six songs off a church wifi is not instant, and a bar that sweeps without
 * saying anything is indistinguishable from a bar that is stuck.
 */
/**
 * Say it in both places, because only one of them is ever on screen.
 *
 * The first screen is gone the moment a score is open, and the Setup panel is
 * where the Drive button is reached from after that. A message that lands in
 * whichever one is hidden reads as nothing having happened at all.
 */
function setProgress(message, kind = "busy", action = null) {
  const box = el.driveToast;
  if (!box) return;
  box.replaceChildren();
  box.hidden = !message;
  box.classList.toggle("is-problem", kind === "problem");
  if (!message) return;

  const said = document.createElement("span");
  said.textContent = message;
  box.append(said);

  if (action) {
    const go = document.createElement("button");
    go.type = "button";
    go.className = "toast-action";
    go.textContent = action.label;
    go.addEventListener("click", (e) => {
      e.stopPropagation(); // the toast dismisses on click; this does not
      setProgress("");
      action.run();
    });
    box.append(go);
  }
}

/** A Drive problem, where it can actually be read. */
function driveProblem(message) {
  setProgress(message, "problem");
  console.warn("drive:", message);
}

/**
 * Whether the screen is actually being kept awake, in words.
 *
 * It was in the diagnostics line and nowhere else, which is where things go to
 * not be noticed. A screen that dims in the middle of a piece is the one
 * failure that ends a performance, so it says so where the settings are.
 */
function showScreenState() {
  if (!state.doc || wakeState() === "held") {
    el.screenState.hidden = true;
    return;
  }
  el.screenState.hidden = false;
  el.screenState.textContent =
    wakeState() === "unsupported"
      ? "Screen may dim — turn off Auto-Lock in Settings."
      : "Screen may dim. Tap the score once.";
}

function render() {
  showScreenState();
  // No page counter over the score. The score has its own page numbers, and a
  // second one floating on top of the music is one more thing in the way of
  // the only thing anyone is looking at.
  el.prevBtn.disabled = state.page <= 1;
  el.nextBtn.disabled = state.page >= state.pageCount;
  renderDiag();
}

// ============================================================
// Wiring
// ============================================================

/**
 * Open what was picked. Several files at once become a set.
 *
 * Which is how a Sunday arrives: you select the week's songs together, from
 * one folder, and they belong together. It is also the shape a shared Drive
 * folder of dated subfolders will hand over, so the grouping is built before
 * the thing that will fill it.
 */
async function loadFiles(files) {
  const picked = [...(files ?? [])].filter(
    (f) => !f.type || f.type === "application/pdf" || /\.pdf$/i.test(f.name)
  );
  if (!picked.length) {
    if (files?.length) showError(`Not a PDF: ${files[0].name}`);
    return;
  }
  showError("");
  await adoptSet(
    picked.map((file) => ({ name: file.name, bytes: () => file.arrayBuffer() })),
    todayName()
  );
}

/**
 * Take a pile of scores and make them a set.
 *
 * Where they came from is the only thing that differs between picking files off
 * the device and pulling a Sunday out of a shared Drive folder, so everything
 * after "here are some names and some bytes" happens once, here. Each item
 * carries a `bytes()` rather than its bytes, because the Drive path has not
 * downloaded anything yet when it calls this and should not download a song
 * nobody can see yet.
 */
/**
 * @param defer  Leave the grouping to the caller and just return what was
 *               stored. The Drive path needs this: whether these songs are a
 *               Sunday depends on what arrives next, not on this pass.
 */
async function adoptSet(items, setName, { defer = false } = {}) {
  if (!items.length) return null;

  // In the order they are named, which is the order a set is usually numbered.
  const sorted = [...items].sort((x, y) =>
    x.name.localeCompare(y.name, undefined, { numeric: true })
  );

  let setId = null;
  let stored = [];
  try {
    setBusy(true);
    const ids = [];
    for (const item of sorted) {
      if (sorted.length > 1) setProgress(`Opening ${ids.length + 1} of ${sorted.length}…`);
      const bytes = await item.bytes();
      const id = await scoreId(bytes);
      // Only the first one becomes "the score to reopen"; the rest are stored.
      await rememberScore(id, bytes, item.name, 1, { pointAt: ids.length === 0 });
      ids.push({ id, bytes, name: item.name });
    }
    setProgress("");

    const members = ids.map((x) => x.id);
    stored = members;
    if (!defer && members.length > 1) setId = await rememberSet(setName, members);

    const first = ids[0];
    const rec = await dbDo("readonly", (store) => store.get(first.id)).catch(() => null);
    await openScore(first.bytes, first.name, rec?.page ?? 1, first.id);

    // The ones not opened have no picture yet, and the chooser is about to
    // show them. Draw them in the background rather than making anyone wait.
    for (const other of ids.slice(1)) thumbLater(other.id, other.bytes);

    // And draw the list now, rather than relying on a thumbnail landing to do
    // it: a song added to a Sunday it has been in before already has its
    // picture, so nothing would have redrawn and the set would look unchanged.
    //
    // Not when the caller is still deciding what these songs are. Drawing them
    // loose and then again as a Sunday is a visible flicker, and it is the
    // ungrouped half that anything watching would catch first.
    if (!defer) await renderRecent();
  } catch (err) {
    console.error("failed to open score:", err);
    setProgress("");
    showError(`Could not open ${sorted[0].name} — ${err.message}`);
  } finally {
    setBusy(false);
  }
  return defer ? stored : setId;
}

// ============================================================
// Google Drive — a Sunday out of a shared folder
//
// Churches already keep the week's songs in a dated folder that somebody
// shares with the team. That folder *is* the set, so the job here is only to
// get it onto the device. Once it is, nothing about playing from it touches
// the network again: the scores go into the same store as a score opened off
// the device, so a wifi that dies during the service costs nothing.
//
// The scope asked for is drive.file and only drive.file. It is non-sensitive —
// no Google review, no security assessment — and it is the honest one: this
// app has no business reading a drive, only the songs somebody handed it.
// ============================================================

// Both values ship in this file and are meant to. See the note at the top.
const GOOGLE_APP_ID = GOOGLE_CLIENT_ID.split("-")[0];
const GSI_SRC = "https://accounts.google.com/gsi/client";
const GAPI_SRC = "https://apis.google.com/js/api.js";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";

/**
 * The token lives in memory and nowhere else.
 *
 * Not in localStorage, not in the score store: a page reload is a cheap place
 * to ask again, and a token on disk is a token that outlives the person who
 * meant to grant it. An hour is what Google issues; fifty minutes is when this
 * stops trusting it, so a download never dies halfway through a set.
 */
let driveToken = null;
let driveTokenUntil = 0;
const TOKEN_GOOD_FOR_MS = 50 * 60 * 1000;

const scriptsLoaded = new Map();

/**
 * Load Google's scripts only when somebody asks for Drive.
 *
 * Never at startup. The whole app is built to open a score with no network at
 * all, and two scripts from a third party in the critical path would quietly
 * undo that — on a dead wifi they do not fail, they hang.
 */
function loadScript(src) {
  if (!scriptsLoaded.has(src)) {
    scriptsLoaded.set(
      src,
      new Promise((resolve, reject) => {
        const tag = document.createElement("script");
        tag.src = src;
        tag.async = true;
        tag.onload = resolve;
        tag.onerror = () => {
          scriptsLoaded.delete(src); // so a later try is allowed to work
          reject(new Error("could not reach Google"));
        };
        document.head.append(tag);
      })
    );
  }
  return scriptsLoaded.get(src);
}

let googleIsReady = false;

async function googleReady() {
  await Promise.all([loadScript(GSI_SRC), loadScript(GAPI_SRC)]);
  if (!window.google?.picker) {
    await new Promise((resolve, reject) =>
      window.gapi.load("picker", { callback: resolve, onerror: reject })
    );
  }
  googleIsReady = true;
}

/**
 * Start fetching Google's scripts on the way down of the tap, not after it.
 *
 * A sign-in window may only be opened while the browser still considers the
 * tap to be happening, and Safari stops considering it after an await that
 * goes to the network. Tap, fetch two scripts, open a window was therefore
 * "the button does nothing" for anybody who had not used Drive yet on that
 * page — the one group for whom it has to work the first time.
 *
 * Still nothing at startup: this runs on a press of the Drive button and
 * nowhere else, so a device with no network is never waiting on Google.
 */
function warmGoogle() {
  if (googleIsReady || !navigator.onLine) return;
  googleReady().catch(() => {});
}

/** Sign in, or reuse the sign-in from a few minutes ago. */
function driveSignIn() {
  if (driveToken && Date.now() < driveTokenUntil) return Promise.resolve(driveToken);
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GOOGLE_SCOPE,
      callback: (res) => {
        if (!res?.access_token) return reject(new Error(res?.error ?? "no access"));
        driveToken = res.access_token;
        driveTokenUntil = Date.now() + TOKEN_GOOD_FOR_MS;
        resolve(driveToken);
      },
      error_callback: (err) => reject(new Error(signInProblem(err?.type))),
    });
    client.requestAccessToken();
  });
}

/** Google's error types, in words somebody can act on. */
function signInProblem(type) {
  if (type === "popup_closed") return "sign-in was closed";
  if (type === "popup_failed_to_open") {
    return "the browser blocked the sign-in window — tap Google Drive again";
  }
  return type ?? "sign-in did not finish";
}

const isFolder = (doc) => doc.mimeType === "application/vnd.google-apps.folder";
const isPdf = (doc) => doc.mimeType === "application/pdf" || /\.pdf$/i.test(doc.name ?? "");

/**
 * The one line of instruction there is room for, in the only place a player
 * is looking while the picker is up.
 */
function pickerTitle(choosingFolder, gathered) {
  if (choosingFolder) return "Pick the Sunday's folder";
  if (gathered) return `${gathered} added — pick the next, or close when done`;
  return "Pick a song — the picker reopens for the next";
}

/**
 * One pass of the picker, opened wherever we were told to open it.
 *
 * Folders are selectable, and that is deliberate even though drive.file will
 * not hand over what is inside one. Making them unselectable instead meant a
 * tap on a folder did nothing at all on a phone — the picker only enters an
 * unselectable folder on a double tap, which nobody discovers. A choice that
 * does nothing is worse than a dead end, because a dead end at least says so.
 *
 * What a picked folder means here is "go in there", and the caller obliges by
 * opening the picker again inside it. The thing drive.file refuses is listing
 * a folder's contents; showing them to the player in Google's own picker is
 * not that, and never needed permission in the first place.
 */
function drivePicker(token, openAt, { choosingFolder = true, gathered = 0 } = {}) {
  return new Promise((resolve) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
      .setMimeTypes("application/pdf")
      .setIncludeFolders(true)
      // Selectable while a folder is what is being looked for, and not once
      // we are inside one. The picker appears to refuse multi-select while a
      // folder could be part of the selection, which left the one view that
      // exists to choose several songs in able to choose exactly one.
      .setSelectFolderEnabled(choosingFolder);

    // A list rather than a grid of thumbnails.
    //
    // The grid is what a phone gets by default, and it is the view that will
    // only ever hold one thing selected. A list is the shape the picker's own
    // toggle offers next to it, and the shape every multi-select on a phone
    // takes — a row per item with somewhere for a tick to go. Guarded because
    // it is a newer part of the picker than the rest of this.
    const mode = window.google.picker.DocsViewMode?.LIST;
    if (mode && typeof view.setMode === "function") view.setMode(mode);

    if (openAt) view.setParent(openAt);

    // Features before views, which is the order Google's own sample uses.
    // Builder calls ought not to care, and this one may well not — but
    // multi-select is refusing to appear on a phone and the documented order
    // is a cheaper thing to match than it is to rule out.
    new window.google.picker.PickerBuilder()
      .enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED)
      .setDeveloperKey(GOOGLE_API_KEY)
      .setOAuthToken(token)
      .setAppId(GOOGLE_APP_ID)
      .addView(view)
      .setTitle(pickerTitle(choosingFolder, gathered))
      .setCallback((data) => {
        const { Action } = window.google.picker;
        if (data.action === Action.PICKED) resolve(data.docs ?? []);
        else if (data.action === Action.CANCEL) resolve([]);
      })
      .build()
      .setVisible(true);
  });
}

const DRIVE_ROOT_KEY = "autopage-drive-root";

/**
 * What a folder is called, and what it sits inside.
 *
 * One request, and worth it twice over. The name is the point of a set —
 * these churches name the folder for the Sunday it belongs to, often a date
 * still in the future, which beats anything the app could invent. And the
 * folder it sits inside is where *next* Sunday will appear, which is what
 * saves hunting for it every week.
 *
 * drive.file may refuse both — it granted the files, not their parent. Then
 * the day names the set, the picker opens where it always did, and nothing is
 * lost but convenience.
 */
async function driveFolderInfo(id, token, fields = "name,parents") {
  if (!id) return null;
  try {
    const res = await fetch(
      `${DRIVE_API}/${encodeURIComponent(id)}?fields=${fields}&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** The one folder these songs all came out of, if they came out of one. */
function sharedParent(docs) {
  const parents = new Set(docs.map((d) => d.parentId).filter(Boolean));
  return parents.size === 1 ? [...parents][0] : null; // two places is not a Sunday
}

const remembered = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key, value) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* a private window is not a reason to fail */
  }
};

/**
 * Where to open the picker: inside the folder the Sundays live in.
 *
 * Checked before it is used rather than trusted, because a folder that has
 * been moved, renamed away or unshared would otherwise open the picker on an
 * empty view with no way to tell why. If it is no longer reachable it is
 * forgotten and the picker opens where it always did.
 */
async function drivePickerRoot(token) {
  const saved = remembered(DRIVE_ROOT_KEY);
  if (!saved) return null;
  const still = await driveFolderInfo(saved, token, "id");
  if (still?.id) return saved;
  remember(DRIVE_ROOT_KEY, null);
  return null;
}

async function driveDownload(fileId, token) {
  const res = await fetch(
    `${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive refused that file (${res.status})`);
  return res.arrayBuffer();
}

/**
 * Pick songs, going into folders on the way if that is what they chose.
 *
 * A folder is not an answer, it is a direction. Choosing one reopens the
 * picker inside it, which is what "go into the folder and select the songs"
 * means when the folder cannot be read any other way. The hop count is only
 * there so that a strange answer cannot spin forever.
 */
/**
 * Collect the Sunday's songs, reopening the picker after each one.
 *
 * Google's picker will not multi-select on a phone. Not with the feature
 * enabled, not with folders kept out of the selection, not in list view, and
 * not in the order its own sample uses — tapping a second song moves the
 * selection to it. Every switch the API offers has been tried.
 *
 * So the picker is reopened instead. Two taps a song, in the same folder,
 * which is as close to ticking a list as this can be made; closing it is what
 * says you are finished. The player keeps tapping songs, which is the thing
 * they were trying to do.
 */
async function pickSongs(token, startAt = null, browse = false) {
  let openAt = startAt ?? (await drivePickerRoot(token));
  // "Add more" comes back inside a folder, where songs are what is wanted.
  // "Browse folders" comes back to the same place wanting to go deeper.
  let inside = Boolean(startAt) && !browse;

  const collected = [];
  const seen = new Set();

  // Generous, because it bounds a loop the player drives, not a retry.
  for (let hop = 0; hop < 60; hop++) {
    const docs = await drivePicker(token, openAt, {
      choosingFolder: !inside,
      gathered: collected.length,
    });

    if (!docs.length) {
      if (collected.length) return collected; // closing it is how you finish

      // Closed inside a folder, having taken nothing. That can mean the songs
      // are a level further down and folders were not selectable there, so
      // offer the way back rather than treating it as "never mind".
      if (inside && openAt) {
        setProgress("Nothing picked.", "done", {
          label: "Browse folders",
          run: () => openFromDrive({ openAt, browse: true }),
        });
      }
      return [];
    }

    const songs = docs.filter((d) => !isFolder(d) && isPdf(d));
    if (songs.length) {
      for (const song of songs) {
        if (seen.has(song.id)) continue; // tapped twice is still one song
        seen.add(song.id);
        collected.push(song);
      }
      openAt = openAt ?? sharedParent(songs);
      inside = true;
      continue; // straight back in for the next one
    }

    const folders = docs.filter(isFolder);
    if (folders.length !== 1) return collected.length ? collected : docs;

    setProgress(`Opening ${folders[0].name}…`);
    openAt = folders[0].id;
    inside = true;
  }
  return collected;
}

/**
 * @param addTo    A set to add to, rather than starting a new one.
 * @param openAt   The folder to open the picker in, skipping the hunt.
 * @param soFar    Songs already collected on this trip through the picker.
 * @param browse   Open that folder wanting to go deeper, not to pick songs.
 */
async function openFromDrive({ addTo = null, openAt = null, soFar = [], browse = false } = {}) {
  if (!GOOGLE_API_KEY) {
    driveProblem("Google Drive is not configured in this build.");
    return;
  }
  showError("");
  try {
    if (!googleIsReady) setProgress("Connecting to Google…");
    await googleReady();

    // Try the sign-in window even if the scripts were only just fetched.
    // Chrome opens it; Safari may refuse, because it stops counting the tap as
    // live once an await has gone to the network. Refusing to try would cost
    // everybody a second tap to spare Safari one, so it is attempted and the
    // refusal is what gets explained — by which time the scripts are cached
    // and the second tap goes straight through.
    const token = await driveSignIn();

    setProgress("");
    const docs = await pickSongs(token, openAt, browse);
    if (!docs.length) return; // cancelled, which is not a failure

    const songs = docs.filter((d) => !isFolder(d) && isPdf(d));

    // The same song can be picked twice; one entry is enough.
    const seen = new Set();
    const unique = songs.filter((s) => !seen.has(s.id) && seen.add(s.id));

    if (!unique.length) {
      driveProblem(
        docs.some(isFolder)
          ? "Choose one folder at a time, or select the songs inside it."
          : "Nothing in that selection was a PDF."
      );
      return;
    }

    // The folder they came out of names the set when Google will say what it
    // is called; otherwise the day does. The same answer says where next
    // Sunday's folder will turn up, so the picker can start there next time.
    setProgress("Naming the set…");
    const from = sharedParent(unique);
    const info = await driveFolderInfo(from, token);
    if (info?.parents?.[0]) remember(DRIVE_ROOT_KEY, info.parents[0]);
    const named = info?.name ?? todayName();

    const justStored = await adoptSet(
      unique.map((song) => ({
        name: song.name,
        bytes: () => driveDownload(song.id, token),
      })),
      named,
      { defer: true }
    );

    // Whether these songs are a Sunday depends on what arrives next.
    //
    // Google's picker decides for itself whether it will let somebody select
    // more than one thing at a time, and on a phone it often will not. So the
    // set is made once there are two songs to make it out of — one song is a
    // score, and turning every single pick into a Sunday of its own filled the
    // list with Sundays nobody meant.
    const collected = [...soFar, ...justStored.filter((id) => !soFar.includes(id))];
    let setId = addTo;
    if (collected.length > 1) {
      if (setId) await addToSet(setId, justStored);
      else setId = await rememberSet(named, collected);
    }
    await renderRecent(); // once, with the grouping already decided

    // Offer the next one rather than assuming that was all of them.
    if (from) {
      const count = collected.length === 1 ? "1 song" : `${collected.length} songs`;
      setProgress(`${named} — ${count}`, "done", {
        label: "Add more",
        run: () => openFromDrive({ addTo: setId, openAt: from, soFar: collected }),
      });
    }
  } catch (err) {
    console.warn("drive:", err);
    driveProblem(
      navigator.onLine
        ? `Could not open from Drive — ${err.message}`
        : "Opening from Drive needs a network. Scores already on the device still work."
    );
  }
}

/** The day, as a set is named: "Nov 23" — whatever order this locale puts it in. */
function todayName() {
  return new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

async function thumbLater(id, bytes) {
  try {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    await storeThumb(id, doc);
    doc.destroy();
  } catch (err) {
    console.warn("no thumbnail for a set member:", err.message);
  }
}

// ============================================================
// Being ready without a network
//
// A rehearsal room with no signal is a normal place to open a score, so
// "works offline" is a requirement here, not a nicety. Two things have to be
// true for it: the shell has to be in the cache, which the service worker
// precaches on install, and the face model has to be there too — and that one
// is 13MB, fetched separately, and easy to end up without.
//
// It is also the reason the model is not fetched on the landing screen any
// more. Someone opening the link to look at it should not pay 14MB before they
// have seen anything. But deferring a download is only safe if something
// guarantees it still happens before it is needed, so that guarantee is here,
// along with a plain answer to "will this work when I get there".
// ============================================================

const MODEL_FILES = [
  "./vendor/mediapipe/vision_bundle.js",
  "./vendor/mediapipe/face_landmarker.task",
  "./vendor/mediapipe/wasm/vision_wasm_internal.js",
  "./vendor/mediapipe/wasm/vision_wasm_internal.wasm",
];

// The model's own cache, whose name is fixed. The shell cache is bumped on
// every release; the model must survive that, so it does not live there.
const MODEL_CACHE = "autopage-model";

/** Is every piece of the gesture already on this device? */
async function modelCached() {
  if (!("caches" in window)) return false;
  try {
    const hits = await Promise.all(MODEL_FILES.map((f) => caches.match(new URL(f, location.href))));
    return hits.every(Boolean);
  } catch {
    return false;
  }
}

let prefetching = false;

/**
 * Pull the model down and keep it. Safe to call repeatedly — the network is
 * only touched for what is missing.
 */
async function prefetchModel(onProgress) {
  if (prefetching || !("caches" in window)) return;
  prefetching = true;
  try {
    const cache = await caches.open(MODEL_CACHE);
    let done = 0;
    for (const file of MODEL_FILES) {
      const url = new URL(file, location.href);
      if (!(await cache.match(url))) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${file}: ${res.status}`);
        await cache.put(url, res.clone());
      }
      onProgress?.(++done, MODEL_FILES.length);
    }
  } catch (err) {
    console.warn("offline prefetch incomplete:", err.message);
  } finally {
    prefetching = false;
    showOfflineState();
  }
}

async function showOfflineState() {
  const ready = await modelCached();
  showScreenState();
  el.offlineState.textContent = ready
    ? "Ready offline."
    : "Not saved for offline yet.";
  el.offlineBtn.hidden = ready;
}

on("offlineBtn", "click", async () => {
  el.offlineBtn.disabled = true;
  el.offlineBtn.textContent = "Downloading…";
  await prefetchModel((done, total) => {
    el.offlineBtn.textContent = `Downloading… ${done}/${total}`;
  });
  el.offlineBtn.disabled = false;
  el.offlineBtn.textContent = "Save for offline (13 MB)";
});

// ============================================================
// Getting in — the first sixty seconds
//
// Everything above assumes a score is already open. Nothing was, and the only
// way to change that was a file picker: land on the page, and to find out
// whether any of this works you first go hunting through iCloud Drive for a
// PDF. That is where people leave.
// ============================================================

const SAMPLE = "./fixtures/menuet-in-g.pdf";

async function loadSample() {
  showError("");
  el.sampleBtn.disabled = true;
  el.sampleBtn.textContent = "Loading…";
  setBusy(true);
  try {
    const res = await fetch(SAMPLE);
    if (!res.ok) throw new Error(`${res.status}`);
    const bytes = await res.arrayBuffer();
    const id = await scoreId(bytes);
    await rememberScore(id, bytes, "sample — Menuet in G", 1);
    await openScore(bytes, "sample — Menuet in G", 1, id);
  } catch (err) {
    showError(`Could not load the sample — ${err.message}`);
  } finally {
    setBusy(false);
    el.sampleBtn.disabled = false;
    el.sampleBtn.textContent = "Try it with a sample score";
  }
}

on("sampleBtn", "click", loadSample);
on("driveBtn", "click", openFromDrive);
on("panelDriveBtn", "click", openFromDrive);
on("driveToast", "click", () => setProgress("")); // read it, dismiss it
on("keyUp", "click", () => setKeyShift(transposeBy + 1));
on("keyDown", "click", () => setKeyShift(transposeBy - 1));
on("keyReset", "click", () => setKeyShift(0));
// A key changed by a hand that was not asking is the one bad outcome here,
// and the band is already the thing on screen saying it happened.
on("keyBand", "click", () => setKeyShift(0));
on("thumbsOn", "change", () => setThumbs(el.thumbsOn.checked));
on("naturalStepOn", "change", () => {
  naturalStep = el.naturalStepOn.checked;
  remember(NATURAL_STEP_KEY, naturalStep ? null : "0"); // on unless turned off
});
on("thumbsDownOn", "change", () => {
  thumbsDownOn = el.thumbsDownOn.checked;
  remember(THUMBS_DOWN_KEY, thumbsDownOn ? null : "0"); // on unless turned off
});
on("driveBtn", "pointerdown", warmGoogle);
on("panelDriveBtn", "pointerdown", warmGoogle);

// --- Installing ---
//
// Run from a browser tab this is a page someone has to find again. Run from the
// home screen it is the app it is meant to be: full screen, no address bar, and
// the score is what fills the iPad.

const INSTALL_DISMISSED = "autopage.installHidden";

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  window.navigator.standalone === true;

// iPadOS 13 and later report themselves as a Mac, so the platform string alone
// says the wrong thing on exactly the device this app is for. A Mac that
// reports touch points is an iPad.
const isApple = () =>
  /iP(hone|ad|od)/.test(navigator.platform) ||
  (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);

let installPrompt = null; // Chrome hands one over; Safari never does

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  showInstallHint();
  showPanelInstall();
});

/**
 * Offer the home screen — but not as the first thing anyone sees.
 *
 * It was on the landing screen from the first moment, competing with Open PDF.
 * Someone who has just scanned a code and does not yet know what this is was
 * being handed homework before they had seen the thing work, and the app runs
 * perfectly well from a tab, so the offer was never urgent enough to earn that
 * spot. From the second visit it is: coming back is the signal.
 *
 * The laptop case is different and shows at once, because there the code is
 * not a nag, it is the route to the device this is actually for.
 */
function showInstallHint() {
  if (isStandalone()) return; // already installed: nothing to offer
  try {
    if (localStorage.getItem(INSTALL_DISMISSED) === "1") return;
  } catch {}

  const canShare = typeof navigator.share === "function";
  // Scanning a code on the screen you are already holding is not a route
  // anywhere. On a laptop it is the shortest path to the iPad.
  const offerQr = !matchMedia("(pointer: coarse)").matches;

  if (installPrompt) {
    el.installText.textContent = "Install it and it opens full screen.";
    el.installBtn.hidden = false;
  } else if (offerQr) {
    el.installText.textContent = "Point your tablet's camera at this:";
  } else {
    // A touch device whose browser offers no install prompt — Safari always,
    // and anything else that does not implement one. The two steps are then the
    // entire mechanism, so they are drawn rather than described: a paragraph
    // about a button is worse than an arrow pointing at it.
    if (visits() < 2) return;
    el.installText.textContent = "Keep it on your home screen:";
    el.installSteps.hidden = false;
    // Safari puts Share in the top bar on an iPad and the bottom bar on a
    // phone, so the arrow has to know which one it is pointing at.
    const phone = Math.min(screen.width, screen.height) < 500;
    el.installArrow.textContent = isApple() && phone ? "↓" : "↑";
  }

  el.shareBtn.hidden = !canShare;
  el.installHint.hidden = false;
  if (offerQr) showQr();
}

/**
 * The same offer, parked in the settings where it can be found on purpose.
 *
 * Once a score is remembered the app opens straight into it, so the card on the
 * first screen stops being seen at all — which is precisely when someone has
 * used it enough to want it installed.
 */
function showPanelInstall() {
  if (isStandalone()) {
    el.panelInstallBtn.hidden = true;
    el.panelInstallHow.hidden = true;
    return;
  }
  el.panelInstallBtn.hidden = false;
}

on("panelInstallBtn", "click", async () => {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    el.panelInstallBtn.hidden = true;
    return;
  }
  const phone = Math.min(screen.width, screen.height) < 500;
  el.panelInstallHow.textContent = isApple()
    ? `Share button (${phone ? "bottom" : "top"} bar) → Add to Home Screen`
    : "Browser menu → Add to Home Screen";
  el.panelInstallHow.hidden = false;
});

/** How many times this browser has opened the app, this one included. */
const VISITS_KEY = "autopage.visits";

function visits() {
  try {
    return Number(localStorage.getItem(VISITS_KEY)) || 0;
  } catch {
    return 0;
  }
}

function countVisit() {
  try {
    localStorage.setItem(VISITS_KEY, String(Math.min(visits() + 1, 99)));
  } catch {}
}

async function showQr() {
  try {
    // Loaded on demand, like the face model: someone who never sees this hint
    // should not pay for an encoder they will not use.
    const { qrSvg } = await import("./qr.js");
    el.qrBox.innerHTML = qrSvg(location.href, { size: 148 });
    el.qrBox.hidden = false;
  } catch (err) {
    // A URL too long to encode, or a module that did not load. The written
    // instructions above it still stand on their own.
    console.warn("no QR:", err.message);
  }
}

on("installBtn", "click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  el.installHint.hidden = true;
});

on("shareBtn", "click", async () => {
  const url = location.href;
  try {
    await navigator.share({
      title: "AutoPage",
      text: "Hands-free page turning for PDF sheet music.",
      url,
    });
  } catch {
    // A cancelled share throws too, so this is not an error path — fall back to
    // the clipboard only if sharing is not there at all.
    if (typeof navigator.share !== "function") {
      try {
        await navigator.clipboard.writeText(url);
        el.shareBtn.textContent = "Link copied";
      } catch {}
    }
  }
});

on("installDismiss", "click", () => {
  el.installHint.hidden = true;
  try {
    localStorage.setItem(INSTALL_DISMISSED, "1");
  } catch {}
});

on("fileInput", "change", (e) => loadFiles(e.target.files));
// The one on the empty screen goes away with the empty screen, and on a tablet
// there is no dragging a file onto anything. Reopening the last score
// automatically would otherwise mean never being able to open a different one.
on("swapFileInput", "change", (e) => loadFiles(e.target.files));

on("score", "dragover", (e) => e.preventDefault());
on("score", "drop", (e) => {
  e.preventDefault();
  loadFiles(e.dataTransfer && e.dataTransfer.files);
});

// Named apart from the keyboard on purpose: a stray click on the tap zone and a
// stray keypress look identical in a log that calls both "manual", and telling
// them apart is the whole point of the log.
on("nextBtn", "click", () => {
  state.turnedBy = "tap zone";
  nextPage();
});
on("prevBtn", "click", () => {
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
    showOfflineState();
  } catch (err) {
    el.allowBtn.hidden = false;
    setCardMessage(`No camera — ${err.message}.\nTap the sides of the score to turn pages.`);
  }
  render();
}

on("allowBtn", "click", beginWatching);

on("calibrateBtn", "click", startCalibration);
on("cancelCalibBtn", "click", startCalibration); // a second press cancels

/**
 * Calibrate before there is a score, from the first screen.
 *
 * It belongs there: it is the thing to do once, before playing, and burying it
 * in a settings panel behind a score made it something you only find after the
 * gesture has already let you down. The camera is deferred until a score opens
 * now, so this has to start it first.
 */
on("startCalibrateBtn", "click", async () => {
  if (!landmarker) {
    el.startCalibrateBtn.disabled = true;
    el.startCalibrateBtn.textContent = "Starting camera…";
    await beginWatching();
    el.startCalibrateBtn.disabled = false;
    el.startCalibrateBtn.textContent = "Calibrate";
    if (!landmarker) return; // beginWatching has already said why
  }
  startCalibration();
});

for (const input of [el.modeTilt, el.modeWink]) {
  input.addEventListener("change", onModeChange);
}

function onModeChange() {
  gestureMode = el.modeWink.checked ? "wink" : "tilt";
  try {
    localStorage.setItem(MODE_KEY, gestureMode);
  } catch {}
  describeGesture();
  // The two are measured on different scales, so a calibration for one says
  // nothing about the other.
  el.calibStatus.textContent =
    calibration?.mode === gestureMode
      ? "Calibrated for this gesture."
      : "Not calibrated for this gesture.";
}

on("swapInput", "change", () => {
  swapEyes = el.swapInput.checked;
  try {
    localStorage.setItem(SWAP_KEY, swapEyes ? "1" : "0");
  } catch {}
});

on("holdInput", "change", () => {
  gestureHoldMs = Math.min(1500, Math.max(100, Number(el.holdInput.value) || 500));
  el.holdInput.value = String(gestureHoldMs);
  try {
    localStorage.setItem(HOLD_KEY, String(gestureHoldMs));
  } catch {}
});

function collapseSetup(collapsed) {
  el.setupToggle.setAttribute("aria-expanded", String(!collapsed));
  el.setupPanel.classList.toggle("collapsed", collapsed);
}

/**
 * Pick up a new version, from inside an app that has no address bar.
 *
 * Installed to the home screen there is no reload button and no way to ask for
 * one — the only route was to force quit the app from the switcher, which is
 * both obscure and the kind of thing people try once and give up on.
 *
 * A plain reload is nearly enough, because the worker fetches from the network
 * first and only falls back to the cache. The part it misses is the worker
 * script itself, which the browser re-checks on its own schedule rather than on
 * demand, so that is asked for explicitly first.
 */
on("reloadBtn", "click", async () => {
  el.reloadBtn.disabled = true;
  el.reloadBtn.textContent = "Checking…";
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    // update() resolves once the check has been made, not once a new worker is
    // ready. Reloading in between leaves the old one still in charge and the
    // press looking like it did nothing — so wait for the new one to finish
    // installing, with a bound, because there may not be one.
    if (reg?.installing) await workerReady(reg.installing, 8000);
  } catch (err) {
    console.warn("could not refresh the worker:", err.message);
  }
  location.reload();
});

function workerReady(worker, ms) {
  return new Promise((resolve) => {
    const done = () => {
      if (worker.state === "installed" || worker.state === "activated" || worker.state === "redundant") {
        worker.removeEventListener("statechange", done);
        resolve();
      }
    };
    worker.addEventListener("statechange", done);
    setTimeout(resolve, ms);
    done();
  });
}

on("setupToggle", "click", () => {
  collapseSetup(el.setupToggle.getAttribute("aria-expanded") === "true");
});

// Anywhere outside it closes it too.
//
// The header is the deliberate way and it is always on screen now, but a panel
// covering half a score wants an escape that does not require finding a
// particular ten pixels. Not while calibrating: the countdown lives in there,
// and the gesture being measured would dismiss its own instructions.
document.addEventListener("pointerdown", (e) => {
  if (calibrating) return;
  if (el.setupPanel.hidden || el.setupPanel.classList.contains("collapsed")) return;
  if (el.setupPanel.contains(e.target)) return;
  collapseSetup(true);
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

countVisit();
renderRecent();
loadCalibration();
loadHold();
showCalibrationState();
collapseSetup(true); // nothing but the score, until someone asks for more
render();
restoreLastScore().then(async (restored) => {
  // The camera — and the 13MB behind it — waits for a reason to exist. A score
  // being open is one. Being installed to the home screen is another: nobody
  // installs an app to look at it once, and it is exactly the case where the
  // next launch may have no network. Already having the model is the third,
  // since then it costs nothing.
  if (restored || isStandalone() || (await modelCached())) beginWatching();
  showOfflineState();

  showInstallHint();
  if (!restored && !("wakeLock" in navigator)) {
    showError(
      "This browser cannot keep the screen awake, so it will dim while you " +
        "play. Turn off Auto-Lock in Settings → Display & Brightness."
    );
  }
});
/**
 * Say so, when the page and the script disagree.
 *
 * Carrying on silently with a button missing is better than dying, but it is
 * not good: the thing somebody is reaching for is simply not there, and
 * nothing explains why. One reload fixes it, so say that.
 */
if (missingEls.length) {
  console.warn("this page is older than the app.js beside it; missing:", missingEls.join(", "));
  showError("This page is out of date — reload to finish updating.");
}

loadThumbs();

window.__autopageReady = true;

// Exposed for the headless test harness in tools/.
window.__autopage = {
  state, readPage, startGesture, stopGesture, winkDirection, eyeSignal,
  get holdFrames() { return holdFrames(); },
  get requiredVotes() { return requiredVotes(); },
  get holdWindow() { return holdWindow(); },
  processFrame,
  setMode(mode) {
    gestureMode = mode === "wink" ? "wink" : "tilt";
    if (el.modeTilt) el.modeTilt.checked = gestureMode === "tilt";
    if (el.modeWink) el.modeWink.checked = gestureMode === "wink";
    describeGesture();
  },
  get missingEls() { return missingEls; },
  // A thumb in front of a headless camera is not a thing that can be
  // arranged, and what is worth testing is the holding and the latching
  // rather than whether Google's model knows a thumb when it sees one.
  handSignal,
  setThumbs,
  get thumbsOn() { return thumbsOn; },
  get thumbUpSteps() { return thumbUpSteps(); },
  get keyShift() { return transposeBy; },
  get faceFrames() { return faceFrames; },
  get handReport() { return handReport; },
  get mode() { return gestureMode; },
  get peakHeld() { return peakHeld; },
  clearPeak() { peakHeld = 0; },
  get ready() { return landmarker !== null; },
  get threshold() { return asymThreshold(); },
  get calibration() { return calibration; },
  get scale() { return CALIBRATION_SCALE; },
};
