import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.pageCount > 0);
console.log("no calibration, camera off ->", (await p.textContent("#gestureStatus")).trim());

await p.evaluate(() => localStorage.setItem("autopage.wink", JSON.stringify({
  threshold: 0.42, separation: 6.1, forwardSign: 1,
  rightLevel: 0.81, leftLevel: 0.78, noiseLevel: 0.08, savedAt: "2026-08-31",
})));
await p.reload({ waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.pageCount > 0);
console.log("calibrated,   camera off ->", (await p.textContent("#gestureStatus")).trim());
console.log("visible without camera   ->", !(await p.getAttribute("#gestureStatus", "hidden") !== null));
await b.close();
