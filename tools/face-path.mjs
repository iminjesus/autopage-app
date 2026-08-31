import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.measures.size === 4);

const run = (label, opts) =>
  p.evaluate(({ label, gapL: gL, gapR: gR, frames, yaw, hz, brow = 0, roll: r0 = 0, mode = "wink" }) => {
    let gapL = gL, gapR = gR, roll = r0;
    window.__autopage.setMode(mode);
    const A = window.__autopage;
    const before = A.state.page;
    // A face, made of the eleven points the app actually reads.
    const face = (t) => {
      const turn = hz ? yaw * Math.sin(2 * Math.PI * hz * t / 30) : (yaw || 0);
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
      const save = [gapL, gapR, roll];
      gapL = gapR = 0.015;
      roll = 0;
      const f = face(t);
      [gapL, gapR, roll] = save;
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
console.log("--- eyebrows, for faces the eyelids do not work on");
const browCases = [
  ["relaxed face 2s",      { gapL: open, gapR: open, frames: 60, brow: 0.0,  mode: "brow" }, false],
  ["brows raised 0.4s",    { gapL: open, gapR: open, frames: 12, brow: 0.7,  mode: "brow" }, true],
  ["brows raised 0.1s",    { gapL: open, gapR: open, frames: 3,  brow: 0.7,  mode: "brow" }, false],
  ["head tilt 20deg 0.4s", { gapL: open, gapR: open, frames: 12, roll: 0.35, mode: "brow" }, true],
  ["head tilt the other way", { gapL: open, gapR: open, frames: 12, roll: -0.35, mode: "brow" }, true],
  ["lean 7deg for 2s",     { gapL: open, gapR: open, frames: 60, roll: 0.12, mode: "brow" }, false],
  ["lean 10deg for 2s",    { gapL: open, gapR: open, frames: 60, roll: 0.17, mode: "brow" }, false],
  ["lean 14deg for 2s",    { gapL: open, gapR: open, frames: 60, roll: 0.24, mode: "brow" }, false],
  ["slight brow movement", { gapL: open, gapR: open, frames: 60, brow: 0.2,  mode: "brow" }, false],
  ["winking in brow mode", { gapL: open, gapR: shut, frames: 30, brow: 0.0,  mode: "brow" }, false],
];
for (const [label, opts, want] of browCases) {
  await p.evaluate(() => { window.__autopage.state.page = 2; });
  await p.waitForTimeout(700);
  const r = await run(label, opts);
  console.log(`${r.turned === want ? "ok  " : "FAIL"} ${label.padEnd(28)} ${r.from}->${r.to}  (want ${want ? "a turn" : "no turn"})`);
}
await p.evaluate(() => window.__autopage.setMode("wink"));
console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
