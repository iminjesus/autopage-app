import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.measures.size === 4);

const run = (label, opts) =>
  p.evaluate(({ label, gapL: gL, gapR: gR, frames, yaw, hz, brow = 0, roll: r0 = 0, rise = 0, mode = "wink" }) => {
    let gapL = gL, gapR = gR;
    window.__autopage.setMode(mode);
    const A = window.__autopage;
    const before = A.state.page;
    // A face, made of the eleven points the app actually reads.
    const face = (t, neutral = false) => {
      const turn = hz ? yaw * Math.sin(2 * Math.PI * hz * t / 30) : (yaw || 0);
      const roll = neutral ? 0 : rise ? r0 * Math.min(1, t / (30 * rise)) : r0;
      // roll is in radians: the eye line rotates, everything else follows.
      const half = 0.06, cx = 0.5 + turn * 0.05, cy = 0.32;
      const L = { x: cx + half * Math.cos(roll), y: cy + half * Math.sin(roll) };
      const R = { x: cx - half * Math.cos(roll), y: cy - half * Math.sin(roll) };
      const pt = (x, y) => ({ x, y, z: 0 });
      const m = [];
      m[10] = pt(0.5, 0.20);            // forehead
      m[152] = pt(0.5, 0.50);           // chin  -> face height 0.30
      m[1] = pt(0.5 + turn * 0.06, 0.36); // nose
      m[386] = pt(L.x, L.y - gapL / 2);
      m[374] = pt(L.x, L.y + gapL / 2);
      m[362] = pt(L.x - 0.02, L.y);
      m[263] = pt(L.x + 0.02, L.y);
      m[159] = pt(R.x, R.y - gapR / 2);
      m[145] = pt(R.x, R.y + gapR / 2);
      m[133] = pt(R.x + 0.02, R.y);
      m[33] = pt(R.x - 0.02 * Math.cos(roll), R.y - 0.02 * Math.sin(roll));
      m[263] = pt(L.x + 0.02 * Math.cos(roll), L.y + 0.02 * Math.sin(roll));
      return m;
    };
    const shapes = [
      { categoryName: "eyeBlinkLeft", score: 0 },
      { categoryName: "eyeBlinkRight", score: 0 },
      { categoryName: "browInnerUp", score: brow > 0 ? brow : 0 },
      { categoryName: "browDownLeft", score: brow < 0 ? -brow : 0 },
      { categoryName: "browDownRight", score: brow < 0 ? -brow : 0 },
    ];
    // A neutral face first: a gesture only counts once it has been released
    // since the last one, so a test that runs them back to back blocks itself.
    const neutralShapes = [
      { categoryName: "eyeBlinkLeft", score: 0 },
      { categoryName: "eyeBlinkRight", score: 0 },
      { categoryName: "browInnerUp", score: 0 },
      { categoryName: "browDownLeft", score: 0 },
      { categoryName: "browDownRight", score: 0 },
    ];
    // Neutral means neutral in every channel — lids open, brows still, head
    // level. Leaving any of them set holds the previous gesture down and the
    // next one never counts as released.
    const openFace = (t) => {
      const save = [gapL, gapR];
      gapL = gapR = 0.015;
      const f = face(t, true);
      [gapL, gapR] = save;
      return f;
    };
    for (let t = 0; t < 8; t++) A.processFrame(openFace(t), neutralShapes);
    for (let t = 0; t < frames; t++) A.processFrame(face(t), shapes);
    return { label, from: before, to: A.state.page, turned: A.state.page !== before };
  }, { label, ...opts });

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
// Positive roll here drops the player's LEFT eye, which is a tilt to their
// left, which is back. Negative roll is a tilt to their right: forward.
const tiltCases = [
  ["head level 2s",              { gapL: open, gapR: open, frames: 60, roll: 0,     mode: "tilt" }, 2],
  ["tilt right 20deg 0.4s",      { gapL: open, gapR: open, frames: 12, roll: -0.35, mode: "tilt" }, 3],
  ["tilt left 20deg 0.4s",       { gapL: open, gapR: open, frames: 12, roll: 0.35,  mode: "tilt" }, 1],
  ["tilt right 0.1s",            { gapL: open, gapR: open, frames: 3,  roll: -0.35, mode: "tilt" }, 2],
  ["lean 7deg for 2s",           { gapL: open, gapR: open, frames: 60, roll: 0.12,  mode: "tilt" }, 2],
  ["lean 10deg for 2s",          { gapL: open, gapR: open, frames: 60, roll: 0.17,  mode: "tilt" }, 2],
  ["lean 14deg for 2s",          { gapL: open, gapR: open, frames: 60, roll: 0.24,  mode: "tilt" }, 2],
  // Expression reaches the same angle, but it drifts there.
  ["expressive lean 20deg over 1.5s", { gapL: open, gapR: open, frames: 90,  roll: 0.35, rise: 1.5, mode: "tilt" }, 2],
  ["expressive lean 25deg over 2.5s", { gapL: open, gapR: open, frames: 120, roll: 0.44, rise: 2.5, mode: "tilt" }, 2],
  ["deliberate tilt right over 0.3s", { gapL: open, gapR: open, frames: 30, roll: -0.35, rise: 0.3, mode: "tilt" }, 3],
  ["deliberate tilt left over 0.3s",  { gapL: open, gapR: open, frames: 30, roll: 0.35,  rise: 0.3, mode: "tilt" }, 1],
  ["raised eyebrows do nothing", { gapL: open, gapR: open, frames: 60, brow: 0.9,   mode: "tilt" }, 2],
  ["winking in tilt mode",       { gapL: open, gapR: shut, frames: 30, roll: 0,     mode: "tilt" }, 2],
];
for (const [label, opts, want] of tiltCases) {
  await p.evaluate(() => { window.__autopage.state.page = 2; });
  await p.waitForTimeout(700);
  const r = await run(label, opts);
  const how = want === 3 ? "forward" : want === 1 ? "back" : "no turn";
  console.log(`${r.to === want ? "ok  " : "FAIL"} ${label.padEnd(34)} ${r.from}->${r.to}  (want ${how})`);
}
await p.evaluate(() => window.__autopage.setMode("wink"));
console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
