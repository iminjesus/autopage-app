// Changing key with a thumb, mid-song.
//
// A set goes up a tone for the last chorus, and that happens with both hands
// busy and the Setup panel three taps away. A thumb to the camera is the one
// signal a player can give without stopping.
//
// It is held to a stricter standard than a page turn, because it costs more
// to get wrong: a page turned by mistake is turned back, while a key changed
// by mistake rewrites every chord on the stand mid-chorus. What is tested
// here is that strictness — the holding, the letting go, the undo — and not
// whether Google's model knows a thumb when it sees one. A thumb cannot be
// held up to a headless camera, so the readings are handed in directly.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "autopage-thumbs-"));
const chart = join(dir, "chart.pdf");
execFileSync("python3", [`${here}make-chart-pdf.py`, chart, "--tight"]);

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
const ctx = await b.newContext({ viewport: { width: 834, height: 1194 } });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

const HOLD = 600;
/** Feed readings in, at the rate the hand loop runs. */
const hand = (what, ms, score = 0.9) => p.evaluate(({ what, ms, score, HOLD }) => {
  const A = window.__autopage;
  const start = (window.__handClock = (window.__handClock ?? 0) + 2000);
  let fired = 0;
  for (let t = 0; t <= ms; t += 1000 / 6) {
    fired += A.handSignal(what ? { categoryName: what, score } : null, start + t);
  }
  window.__handClock = start + ms;
  return fired;
}, { what, ms, score, HOLD });
const shift = () => p.evaluate(() => window.__autopage.keyShift);
const band = () => p.evaluate(() => {
  const el = document.getElementById("keyBand");
  return el && !el.hidden ? el.textContent : "";
});

await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", chart);
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
await p.waitForTimeout(900);

// --- Off by default, and nothing fetched for it ----------------------------
check(!(await p.evaluate(() => window.__autopage.thumbsOn)),
  "the hand is not watched until somebody asks for it");
const asked = [];
await p.route("**/gesture_recognizer.task", (r) => { asked.push(1); r.continue(); });
await p.waitForTimeout(300);
check(asked.length === 0, "and the 8MB model is not fetched by a page that only wanted a PDF");

// Switched on in the test without the model: the decision is what is on trial.
await p.evaluate(() => { window.__autopage.thumbsTestOnly = true; });
await p.evaluate(() => { document.getElementById("thumbsOn").checked = true; });

// --- One thumb, one tone ---------------------------------------------------
//
// Lopsided on purpose: up for the last chorus is a tone almost every time, so
// asking for it twice would be asking twice for the only thing anybody wants.
check((await hand("Thumb_Up", HOLD + 200)) === 2, "a thumb held up counts once");
check((await shift()) === 2, `and raises the chords a tone — D to E: ${await shift()}`);

// --- Held, not repeated -----------------------------------------------------
//
// The reason for the latch. A thumb held up while somebody thinks about it
// would otherwise walk the key up a tone at a time.
check((await hand("Thumb_Up", 4000)) === 0, "holding it there does not keep going");
check((await shift()) === 2, `the key stayed where it was put: ${await shift()}`);

// --- Twice is a tone, which is what is actually asked for -------------------
await hand(null, 400);                       // hand down
check((await hand("Thumb_Up", HOLD + 200)) === 2, "a second thumb counts again");
check((await shift()) === 4, `and takes it another tone: ${await shift()}`);
check((await band()).includes("Chords in C"),
  `the screen says where it went: "${await band()}"`);

// --- Too brief is not a request --------------------------------------------
await hand(null, 400);
check((await hand("Thumb_Up", 300)) === 0, "a thumb that flashes past is not a request");
check((await shift()) === 4, "so the key does not move");

// --- Nor is a half-sure reading --------------------------------------------
await hand(null, 400);
check((await hand("Thumb_Up", HOLD + 400, 0.4)) === 0, "nor is a reading the model is unsure of");
check((await shift()) === 4, "and the key still does not move");

// --- Down, which is there in case ------------------------------------------
await hand(null, 400);
// Down is a semitone, not a tone: it is the rarer move and a smaller
// correction when it is wanted at all.
check((await hand("Thumb_Down", HOLD + 200)) === -1, "a thumb down lowers it");
check((await shift()) === 3, `by a semitone, not a tone: ${await shift()}`);

await p.evaluate(() => {
  document.getElementById("thumbsDownOn").checked = false;
  document.getElementById("thumbsDownOn").dispatchEvent(new Event("change", { bubbles: true }));
});
await hand(null, 400);
check((await hand("Thumb_Down", HOLD + 400)) === 0, "and is ignored when it is turned off");
check((await shift()) === 3, "leaving the key alone");

// --- The undo ---------------------------------------------------------------
//
// The one bad outcome is a key changed by a hand that was not asking. The
// band is already the thing on screen saying it happened, so it is also the
// way back.
check((await band()).includes("tap to undo"), `the band offers the way back: "${await band()}"`);
await p.click("#keyBand");
await p.waitForTimeout(700);
check((await shift()) === 0, "tapping it puts the chart back in its printed key");
check(!(await band()), "and the band goes with it");

// --- A score with no chords ------------------------------------------------
await p.setInputFiles("#fileInput", `${here}../fixtures/menuet-in-g.pdf`);
await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });
await p.waitForTimeout(900);
await hand(null, 400);
check((await hand("Thumb_Up", HOLD + 400)) === 0, "a thumb at a score with no chords changes nothing");
check((await shift()) === 0, "there being nothing to change");

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
console.log(bad ? `${bad} FAILED` : "a thumb moves the key, once, and can be taken back");
process.exit(bad || errs.length ? 1 : 0);
