import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.measures.size === 4);

const run = (label, opts) =>
  p.evaluate(({ label, gapL: gL, gapR: gR, frames, yaw, hz }) => {
    let gapL = gL, gapR = gR;
    const A = window.__autopage;
    const before = A.state.page;
    // A face, made of the eleven points the app actually reads.
    const face = (t) => {
      const turn = hz ? yaw * Math.sin(2 * Math.PI * hz * t / 30) : (yaw || 0);
      const L = { x: 0.56 + turn * 0.05, y: 0.32 };
      const R = { x: 0.44 + turn * 0.05, y: 0.32 };
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
      m[33] = pt(R.x - 0.02, R.y);
      return m;
    };
    const shapes = [{ categoryName: "eyeBlinkLeft", score: 0 }, { categoryName: "eyeBlinkRight", score: 0 }];
    // Eyes open first: a wink only counts once the eye has reopened since the
    // last one, so a test that jumps straight from wink to wink blocks itself.
    const openFace = (t) => { const save = [gapL, gapR]; gapL = gapR = 0.015;
      const f = face(t); [gapL, gapR] = save; return f; };
    for (let t = 0; t < 8; t++) A.processFrame(openFace(t), shapes);
    for (let t = 0; t < frames; t++) A.processFrame(face(t), shapes);
    return { label, from: before, to: A.state.page, turned: A.state.page !== before };
  }, { label, ...opts });

const open = 0.015, shut = 0.001;
const cases = [
  ["eyes open for 2s",            { gapL: open, gapR: open, frames: 60 }, false],
  ["right eye winks 0.6s",        { gapL: open, gapR: shut, frames: 18 }, true],
  ["right eye winks 0.2s",        { gapL: open, gapR: shut, frames: 6 },  false],
  ["left eye winks 0.6s",         { gapL: shut, gapR: open, frames: 18 }, true],
  ["looking down, lids low 2s",   { gapL: 0.0024, gapR: 0.0039, frames: 60 }, false],
  ["head shake 2s",               { gapL: open, gapR: open, frames: 60, yaw: 1.0, hz: 1 }, false],
  ["wink that only half shuts",   { gapL: open, gapR: 0.006, frames: 18 }, true],
];
for (const [label, opts, want] of cases) {
  await p.evaluate(() => { window.__autopage.state.page = 2; });
  await p.waitForTimeout(700); // the fire cooldown is wall-clock, and the
                               // frames below are pushed through in a tight loop
  const r = await run(label, opts);
  console.log(`${r.turned === want ? "ok  " : "FAIL"} ${label.padEnd(28)} ${r.from}->${r.to}  (want ${want ? "a turn" : "no turn"})`);
}
console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
