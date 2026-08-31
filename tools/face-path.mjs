import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.measures.size === 4);

const run = (label, opts) =>
  p.evaluate(({ label, gapL: gL, gapR: gR, frames, yaw, hz, brow = 0, path = [], mode = "wink" }) => {
    let gapL = gL, gapR = gR;
    // The head's angle over time, as legs of [target radians, seconds] starting
    // from level. A step change was what the old cases used, and a head cannot
    // step — which mattered the moment the angle came down far enough that only
    // the speed of the movement separates a command from a lean. Every tilt
    // case below now travels the way a neck travels.
    const legs = path.map(([to, secs]) => [to, Math.max(1, Math.round(secs * 30))]);
    const rollAt = (t) => {
      let start = 0, from = 0;
      for (const [to, n] of legs) {
        if (t < start + n) return from + (to - from) * ((t - start + 1) / n);
        start += n;
        from = to;
      }
      return from;
    };
    window.__autopage.setMode(mode);
    const A = window.__autopage;
    const before = A.state.page;
    // A face, made of the eleven points the app actually reads.
    const face = (t, neutral = false) => {
      const turn = hz ? yaw * Math.sin(2 * Math.PI * hz * t / 30) : (yaw || 0);
      const roll = neutral ? 0 : rollAt(t);
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
    const total = legs.length ? legs.reduce((n, [, f]) => n + f, 0) : frames;
    for (let t = 0; t < 8; t++) A.processFrame(openFace(t), neutralShapes);
    for (let t = 0; t < total; t++) A.processFrame(face(t), shapes);
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
