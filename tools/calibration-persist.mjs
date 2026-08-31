import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext();
const p = await ctx.newPage();
const open = async () => {
  await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
  await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
  await p.waitForFunction(() => window.__autopage.state.pageCount > 0);
};
// The scale stamp comes from the app, not from a copy pasted in here. A test
// that hardcodes it stops testing anything the day the stamp is bumped — this
// one had been reporting "discarded" for every case, strong ones included.
let scale = null;
const save = (obj) =>
  p.evaluate((o) => localStorage.setItem("autopage.wink", JSON.stringify(o)), { scale, ...obj });
const state = () => p.evaluate(() => ({
  loaded: !!window.__autopage.calibration,
  stored: !!localStorage.getItem("autopage.wink"),
  mode: window.__autopage.calibration?.mode ?? null,
  status: document.getElementById("calibStatus").textContent.slice(0, 60),
}));

await open();
scale = await p.evaluate(() => window.__autopage.scale);

// A weak but genuine calibration — the kind the old load rule threw away.
await save({ threshold: 0.2, separation: 2.0, forwardSign: 1,
             rightLevel: 0.25, leftLevel: 0.22, noiseLevel: 0.1, savedAt: "2026-08-31" });
await open();
console.log("weak but valid   ->", JSON.stringify(await state()));

// Anything from the previous measurement scale must go, and say so.
await save({ scale: "eyelid-v0", threshold: 0.15, separation: 1.6, forwardSign: 1,
             rightLevel: 0.10, leftLevel: 0.14, noiseLevel: 0.06 });
await open();
console.log("old scale        ->", JSON.stringify(await state()));

// A strong one survives, obviously.
await save({ threshold: 0.42, separation: 6.1, forwardSign: 1,
             rightLevel: 0.81, leftLevel: 0.78, noiseLevel: 0.08, savedAt: "2026-08-31" });
await open();
console.log("strong           ->", JSON.stringify(await state()));

// A tilt calibration is a different shape entirely — an angle and a sign, no
// eyelid levels at all — and it has to survive the same trip.
await save({ mode: "tilt", threshold: 0.22, separation: 4.0,
             tilt: { limit: 0.22, forwardSign: -1, rightLevel: 0.44, leftLevel: 0.41, noiseLevel: 0.11 },
             savedAt: "2026-08-31" });
await open();
const tilt = await p.evaluate(() => ({
  ...({ loaded: !!window.__autopage.calibration }),
  mode: window.__autopage.calibration?.mode ?? null,
  limit: window.__autopage.calibration?.tilt?.limit ?? null,
  sign: window.__autopage.calibration?.tilt?.forwardSign ?? null,
}));
console.log("tilt             ->", JSON.stringify(tilt));
await b.close();
