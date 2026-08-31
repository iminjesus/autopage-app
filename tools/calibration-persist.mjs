import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"] });
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });

// Stand in for a completed calibration, on the eyelid-geometry scale.
await p.evaluate(() => localStorage.setItem("autopage.wink", JSON.stringify({
  threshold: 0.42, separation: 6.1, forwardSign: 1,
  rightLevel: 0.81, leftLevel: 0.78, noiseLevel: 0.08, savedAt: "2026-08-31",
})));
await p.evaluate(() => localStorage.setItem("autopage.winkHold", "60"));

await p.reload({ waitUntil: "networkidle" });
console.log("after reload  ->", JSON.stringify(await p.evaluate(() => ({
  calibration: window.__autopage.calibration,
  holdField: document.getElementById("holdInput").value,
}))));

// A second, fully independent page in the same browser profile.
const p2 = await ctx.newPage();
await p2.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
console.log("new tab       ->", JSON.stringify(await p2.evaluate(() => window.__autopage.calibration?.threshold)));

// And a calibration built from noise must be thrown away, not obeyed.
await p2.evaluate(() => localStorage.setItem("autopage.wink", JSON.stringify({
  threshold: 0.15, separation: 1.6, forwardSign: 1,
  rightLevel: 0.10, leftLevel: 0.14, noiseLevel: 0.06,
})));
await p2.reload({ waitUntil: "networkidle" });
console.log("noise-built   ->", JSON.stringify(await p2.evaluate(() => ({
  calibration: window.__autopage.calibration,
  stillStored: localStorage.getItem("autopage.wink"),
}))));
await b.close();
