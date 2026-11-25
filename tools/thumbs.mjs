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

// Read from the app rather than written down here, so the two cannot drift.
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
// Read from the app rather than written down here, so the two cannot drift.
const HOLD = await p.evaluate(() => window.__autopage.thumbHoldMs);
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

// --- It says what it is seeing ---------------------------------------------
//
// A gesture nobody can watch failing is a gesture nobody can report. The
// first thing this feature produced was "I ticked the box and nothing
// happens", which is unanswerable without a readout.
const report = () => p.evaluate(() => window.__autopage.handReport);
const diagLine = () => p.evaluate(() => {
  const t = document.getElementById("gestureAsym").textContent;
  return t.split("\n").find((l) => l.startsWith("hand")) ?? "";
});
await hand(null, 200);
check((await report()) === "no hand", `it says when there is no hand: "${await report()}"`);
await hand("Thumb_Up", 160);
check((await report()).includes("Thumb_Up 0.90"), `and what it saw: "${await report()}"`);
check((await report()).includes("holding") || (await report()).includes("held"),
  "and that it is waiting for it to be held");
await hand(null, 200);
// Long enough for a second reading at six a second, short of the hold.
await hand("Thumb_Up", HOLD - 200);
check(new RegExp(`held \\d+/${HOLD}ms`).test(await report()),
  `with how far through: "${await report()}"`);
await hand(null, 200);
await hand("Thumb_Up", 160, 0.4);
check((await report()).includes("needs 0.7"),
  `a reading too weak to act on says so rather than nothing: "${await report()}"`);
await hand(null, 300);
await p.evaluate(() => { window.__autopage.handSignal(null, 0); });

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
check((await report()).includes("put your hand down"),
  `and says why nothing more is happening: "${await report()}"`);
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

// --- And the line is there before it is switched on ------------------------
//
// An empty space answered two different questions — "you have not turned
// this on" and "you turned it on and it is broken" — and the second is the
// one somebody is looking at the panel to ask.
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.evaluate(() => localStorage.removeItem("autopage-thumbs"));
await p.reload({ waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", chart);
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
await p.evaluate(() => window.__autopage.startGesture());
await p.waitForFunction(() => document.getElementById("camPreview").readyState >= 2, null, { timeout: 30000 });
await p.waitForTimeout(1500);
check((await diagLine()).includes("tick"),
  `a chart with chords says how to switch it on: "${await diagLine()}"`);

await p.setInputFiles("#fileInput", `${here}../fixtures/menuet-in-g.pdf`);
await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });
await p.waitForTimeout(1500);
check((await diagLine()).includes("no chord symbols"),
  `and a score without them says why there is nothing to switch on: "${await diagLine()}"`);

// --- The ladder up stays on keys a band can read ---------------------------
//
// Up a tone from E is F#, six sharps, and from B is C#, seven. Those are the
// two places the scale has its own semitone, so a thumb follows the scale
// instead of the interval and the ladder reads C D E F G A B.
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", chart);
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
await p.waitForTimeout(900);
if (await p.evaluate(() => document.getElementById("setupPanel").classList.contains("collapsed"))) {
  await p.click("#setupToggle");
  await p.waitForTimeout(300);
}
await p.evaluate(() => { document.getElementById("thumbsOn").checked = true; });

// The name on its own: "Eb (+3)" starts with "E", which is how the first
// version of this test stopped on Eb and reported that E goes up a tone.
const keyNow = async () => (await p.locator("#keyNow").textContent()).split(" ")[0];
const toKey = async (name) => {
  for (let i = 0; i < 24 && (await keyNow()) !== name; i++) {
    await p.click("#keyUp");
    await p.waitForTimeout(110);
  }
  return (await keyNow()) === name;
};
const steps = () => p.evaluate(() => window.__autopage.thumbUpSteps);

// One clock, going forwards. Two of them, or one that restarts, puts the hold
// in the future and nothing ever counts.
let clock = 0;
const thumb = async () => {
  await p.evaluate((t) => window.__autopage.handSignal(null, t), (clock += 400));
  await p.evaluate((t) => {
    const A = window.__autopage;
    for (let n = 0; n <= 900; n += 160) {
      A.handSignal({ categoryName: "Thumb_Up", score: 0.9 }, t + n);
    }
  }, (clock += 400));
  clock += 1200;
  await p.waitForTimeout(250);
};

check(await toKey("C"), "from a chart put into C");
check((await steps()) === 2, `a thumb is a tone: ${await steps()}`);
check(await toKey("E"), "and in E");
check((await steps()) === 1, `it is a semitone, so E goes to F and not F#: ${await steps()}`);
check(await toKey("B"), "and in B");
check((await steps()) === 1, `the same, so B goes to C and not C#: ${await steps()}`);
check(await toKey("F"), "and back on an ordinary key");
check((await steps()) === 2, `a tone again: ${await steps()}`);

// Walk it, and read the ladder off.
await p.click("#keyReset");
await p.waitForTimeout(200);
await toKey("C");
const ladder = [await keyNow()];
for (let i = 0; i < 6; i++) {
  await thumb();
  ladder.push(await keyNow());
}
check(ladder.join(" ") === "C D E F G A B",
  `six thumbs from C walk the keys a band can read: ${ladder.join(" ")}`);

// Turned off, it is a tone everywhere.
await p.evaluate(() => {
  const box = document.getElementById("naturalStepOn");
  box.checked = false;
  box.dispatchEvent(new Event("change", { bubbles: true }));
});
await p.click("#keyReset");
await p.waitForTimeout(200);
await toKey("E");
check((await steps()) === 2, `switched off, E goes up a tone like anything else: ${await steps()}`);
await thumb();
check((await keyNow()) === "Gb", `which lands on Gb: ${await keyNow()}`);

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
console.log(bad ? `${bad} FAILED` : "a thumb moves the key, once, and can be taken back");
process.exit(bad || errs.length ? 1 : 0);
