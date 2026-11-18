import { chromium } from "playwright-core";
import { executablePath } from "./browser.mjs";
import { simulate } from "./face-sim.mjs";
const b = await chromium.launch({ executablePath });
const p = await b.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.measures.size === 4);

const run = (label, opts) =>
  p.evaluate(simulate, opts).then((r) => ({ label, ...r }));

const open = 0.015, shut = 0.001;
const cases = [
  ["eyes open for 2s",            { gapL: open, gapR: open, frames: 60 }, false],
  ["right eye winks 0.6s",        { gapL: open, gapR: shut, frames: 18 }, true],
  ["right eye winks 0.1s",        { gapL: open, gapR: shut, frames: 3 },  false],
  ["right eye winks 0.2s",        { gapL: open, gapR: shut, frames: 6 },  true],
  ["right eye winks 0.35s",       { gapL: open, gapR: shut, frames: 11 }, true],
  ["left eye winks 0.6s",         { gapL: shut, gapR: open, frames: 18 }, true],
  ["looking down, lids low 2s",   { gapL: 0.0024, gapR: 0.0039, frames: 60 }, false],
  ["head shake 2s",               { gapL: open, gapR: open, frames: 60, yaw: 1.0, hz: 1 }, false],
  ["wink that only half shuts",   { gapL: open, gapR: 0.006, frames: 18 }, true],
  // One eye reading worse than the other is what a lens rim or a side light
  // does, and it is how "one direction works and the other never does" starts.
  ["weak-reading eye winks 0.8s", { gapL: open, gapR: 0.007, frames: 24 }, true],
  ["other eye winks 0.8s",        { gapL: 0.001, gapR: open, frames: 24 }, true],
];
for (const [label, opts, want] of cases) {
  await p.evaluate(() => { window.__autopage.state.page = 2; });
  await p.waitForTimeout(700); // the fire cooldown is wall-clock, and the
                               // frames below are pushed through in a tight loop
  const r = await run(label, opts);
  console.log(`${r.turned === want ? "ok  " : "FAIL"} ${label.padEnd(28)} ${r.from}->${r.to}  (want ${want ? "a turn" : "no turn"})`);
}
console.log("--- the head tilt: right is forward, left is back");
// Positive roll drops the player's LEFT eye — a tilt to their left, which is
// back. Negative roll is a tilt to their right: forward. Paths are legs of
// [radians, seconds], so `[[-0.21, 0.3], [-0.21, 0.5]]` reads "flick 12 degrees
// right over a third of a second, then hold it there for half a second".
// Fourteen degrees — just past the twelve the app asks for, which is the whole
// point: the gesture has to work at barely more than the threshold. The old
// rule only fired if you were still accelerating through it, so in practice it
// took twenty-five, and that is what hurt.
const R = 0.24, L = -0.24;
const tiltCases = [
  ["head level 2s",           { path: [[0, 2]] }, 2],
  // The gesture as asked for: a flick to the threshold and a stop. Nothing here
  // goes past twelve degrees, because having to go past it is the complaint.
  ["flick right 14deg, hold, release", { path: [[L, 0.3], [L, 0.3], [0, 0.3], [0, 0.5]] }, 3],
  ["flick left 14deg, hold, release",  { path: [[R, 0.3], [R, 0.3], [0, 0.3], [0, 0.5]] }, 1],
  // The hold is what makes it deliberate. Touching the angle on the way past,
  // with no dwell at all, is not the gesture.
  ["flick right and let go at once",   { path: [[L, 0.3], [0, 0.2], [0, 0.6]] }, 2],
  // Short of the angle, however fast.
  ["flick to 8deg only",      { path: [[-0.14, 0.3], [-0.14, 0.6]] }, 2],
  // Far enough, but drifted there.
  ["drift to 20deg over 1.5s", { path: [[-0.35, 1.5], [-0.35, 0.5]] }, 2],
  ["expressive lean 25deg over 2.5s", { path: [[0.44, 2.5]] }, 2],
  ["settle into a 14deg lean, hold 2s", { path: [[0.24, 1.0], [0.24, 2.0]] }, 2],
  ["settle into a 10deg lean, hold 2s", { path: [[0.17, 1.0], [0.17, 2.0]] }, 2],
  // Straightening up is quick, and it passes back through every angle it came
  // up through. It must not read as a tilt the other way, or as another one the
  // same way.
  ["straighten up from a 20deg lean", { path: [[0.35, 1.5], [0, 0.3], [0, 0.7]] }, 2],
  ["straighten up fast from a flick",  { path: [[L, 0.3], [L, 0.3], [0, 0.2], [0, 0.9]] }, 3],
  // Holding a tilt must turn one page, not a page every cooldown.
  ["flick right and hold 3s", { path: [[L, 0.3], [L, 3.0]] }, 3],
  ["raised eyebrows do nothing", { path: [[0, 2]], brow: 0.9 }, 2],
  ["winking in tilt mode",    { path: [[0, 1]], gapR: shut }, 2],
];
for (const [label, opts, want] of tiltCases) {
  await p.evaluate(() => { window.__autopage.state.page = 2; });
  await p.waitForTimeout(700);
  const r = await run(label, { gapL: open, gapR: open, frames: 60, mode: "tilt", ...opts });
  const how = want === 3 ? "forward" : want === 1 ? "back" : "no turn";
  console.log(`${r.to === want ? "ok  " : "FAIL"} ${label.padEnd(36)} ${r.from}->${r.to}  (want ${how})`);
}
await p.evaluate(() => window.__autopage.setMode("wink"));
console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
