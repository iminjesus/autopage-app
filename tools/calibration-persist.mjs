import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext();
const p = await ctx.newPage();
const open = async () => {
  await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
  await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
  await p.waitForFunction(() => window.__autopage.state.templates.size >= 3);
};
const save = (obj) => p.evaluate((o) => localStorage.setItem("autopage.wink", JSON.stringify(o)), obj);
const state = () => p.evaluate(() => ({
  loaded: !!window.__autopage.calibration,
  stored: !!localStorage.getItem("autopage.wink"),
  status: document.getElementById("gestureStatus").textContent.slice(0, 60),
}));

await open();

// A weak but genuine calibration — the kind the old load rule threw away.
await save({ scale: "eyelid-v1", threshold: 0.2, separation: 2.0, forwardSign: 1,
             rightLevel: 0.25, leftLevel: 0.22, noiseLevel: 0.1, savedAt: "2026-08-31" });
await open();
console.log("weak but valid   ->", JSON.stringify(await state()));

// Anything from the previous measurement scale must go, and say so.
await save({ threshold: 0.15, separation: 1.6, forwardSign: 1,
             rightLevel: 0.10, leftLevel: 0.14, noiseLevel: 0.06 });
await open();
console.log("old scale        ->", JSON.stringify(await state()));

// A strong one survives, obviously.
await save({ scale: "eyelid-v1", threshold: 0.42, separation: 6.1, forwardSign: 1,
             rightLevel: 0.81, leftLevel: 0.78, noiseLevel: 0.08, savedAt: "2026-08-31" });
await open();
console.log("strong           ->", JSON.stringify(await state()));
await b.close();
