// How much does a low music stand cost each gesture?
//
// A guitarist's score sits well below their face: the iPad looks up at them and
// they look down at it. Both pitch the face away from the lens, and in the
// image that reads as the face squashed vertically — by cos of the angle
// between them, roughly. 1.0 is head-on; 0.7 is about 45 degrees.
//
// The two measures sit on different axes, so they do not pay the same price:
//
//   a lid gap is a vertical distance   -> shrinks by the squash, directly
//   a roll is an angle                 -> flattens: tan(seen) = squash x tan(real)
//
// This sweeps both and prints where each stops working, uncalibrated. The
// calibrated case is the interesting one, because calibration measures through
// whatever angle the camera is actually at.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";
import { simulate } from "./face-sim.mjs";

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
const ctx = await b.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", new URL("../fixtures/menuet-in-g.pdf", import.meta.url).pathname);
await p.waitForFunction(() => window.__autopage.state.measures.size === 4, { timeout: 30000 });

const DEG = Math.PI / 180;
const run = async (opts) => {
  await p.evaluate(() => { window.__autopage.state.page = 2; });
  await p.waitForTimeout(700); // the fire cooldown is wall-clock
  return p.evaluate(simulate, opts);
};

const SQUASH = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5];
const ANGLES = [10, 14, 18, 25, 35];

console.log("--- head tilt, uncalibrated (threshold 12°). Smallest flick that still turns:");
for (const squash of SQUASH) {
  const row = [];
  let smallest = null;
  for (const deg of ANGLES) {
    const r = await run({
      gapL: 0.015, gapR: 0.015, mode: "tilt", squash,
      path: [[-deg * DEG, 0.3], [-deg * DEG, 0.3], [0, 0.3], [0, 0.4]],
    });
    const ok = r.to === 3;
    row.push(`${deg}°${ok ? "+" : "-"}`);
    if (ok && smallest === null) smallest = deg;
  }
  const apparent = (deg) => Math.round(Math.atan(squash * Math.tan(deg * DEG)) / DEG);
  console.log(
    `  squash ${squash.toFixed(2)}  ${row.join(" ")}   -> needs ${smallest ?? ">35"}°` +
      (smallest ? ` (reads as ${apparent(smallest)}°)` : "")
  );
}

console.log("\n--- wink, uncalibrated. A lid gap of 0.015 of face height, squashed:");
for (const squash of SQUASH) {
  const r = await run({ gapL: 0.015, gapR: 0.001, frames: 24, mode: "wink", squash });
  const gap = (0.015 * squash).toFixed(4);
  console.log(`  squash ${squash.toFixed(2)}  open lid reads ${gap}  -> ${r.to === 3 ? "turns" : "NOTHING"}`);
}

console.log("\n--- head tilt, calibrated at that angle (both gates learned from it):");
for (const squash of [1.0, 0.7, 0.5]) {
  // What calibration would store: the player flicks ~20° over a third of a
  // second, and the app records what it saw through this camera, not what the
  // neck did. Sway is seen through the same camera and shrinks with it, which
  // is why the floors come from the sway and not from a constant.
  const seen = Math.atan(squash * Math.tan(20 * DEG));
  const sway = 0.08 * squash;
  const limit = Math.min(0.3, Math.max(0.07, sway * 2, seen * 0.4));
  const rate = Math.min(0.14, Math.max(0.04, 0.02 * squash * 1.5, seen * 0.5));
  await p.evaluate(({ limit, rate, sway }) => {
    const A = window.__autopage;
    localStorage.setItem("autopage.wink", JSON.stringify({
      scale: A.scale, mode: "tilt", threshold: limit, separation: 4,
      tilt: { limit, rate, forwardSign: -1, rightLevel: 0.44, leftLevel: 0.41, noiseLevel: sway },
      savedAt: "2026-11-18",
    }));
  }, { limit, rate, sway });
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForFunction(() => window.__autopage.state.measures.size === 4, { timeout: 30000 });

  let smallest = null;
  const row = [];
  for (const deg of ANGLES) {
    const r = await run({
      gapL: 0.015, gapR: 0.015, mode: "tilt", squash,
      path: [[-deg * DEG, 0.3], [-deg * DEG, 0.3], [0, 0.3], [0, 0.4]],
    });
    const ok = r.to === 3;
    row.push(`${deg}°${ok ? "+" : "-"}`);
    if (ok && smallest === null) smallest = deg;
  }
  console.log(
    `  squash ${squash.toFixed(2)}  limit ${(limit / DEG).toFixed(0)}° at ${(rate / DEG).toFixed(0)}°/0.3s  ` +
      `${row.join(" ")}   -> needs ${smallest ?? ">35"}°`
  );
}

// --- and the half that matters more: does the lower bar let posture through?
//
// Lowering both gates is only safe because sway and leaning are seen through
// the same camera and flattened by the same factor, so the ratio between a
// flick and a lean survives. That is an argument; this is the check.
console.log("\n--- calibrated at a steep angle, the things that must NOT turn:");
const NOISE = [
  ["settle into a 14° lean over 1s, hold 2s", [[0.24, 1.0], [0.24, 2.0]]],
  ["settle into a 20° lean over 1.5s", [[0.35, 1.5], [0.35, 1.0]]],
  ["expressive lean to 25° over 2.5s", [[0.44, 2.5]]],
  ["straighten up from a 20° lean", [[0.35, 1.5], [0, 0.3], [0, 0.7]]],
  ["sway ±6° at 0.5Hz", [[0.1, 1], [-0.1, 2], [0.1, 2], [-0.1, 2]]],
  ["head level 2s", [[0, 2]]],
];
let leaks = 0;
for (const squash of [0.7, 0.5]) {
  const seen = Math.atan(squash * Math.tan(20 * DEG));
  const sway = 0.08 * squash;
  const limit = Math.min(0.3, Math.max(0.07, sway * 2, seen * 0.4));
  const rate = Math.min(0.14, Math.max(0.04, 0.02 * squash * 1.5, seen * 0.5));
  await p.evaluate(({ limit, rate, sway }) => {
    const A = window.__autopage;
    localStorage.setItem("autopage.wink", JSON.stringify({
      scale: A.scale, mode: "tilt", threshold: limit, separation: 4,
      tilt: { limit, rate, forwardSign: -1, rightLevel: 0.44, leftLevel: 0.41, noiseLevel: sway },
      savedAt: "2026-11-18",
    }));
  }, { limit, rate, sway });
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForFunction(() => window.__autopage.state.measures.size === 4, { timeout: 30000 });

  for (const [label, path] of NOISE) {
    const r = await run({ gapL: 0.015, gapR: 0.015, mode: "tilt", squash, path });
    const quiet = r.to === 2;
    if (!quiet) leaks++;
    console.log(`  ${quiet ? "ok  " : "LEAK"} squash ${squash.toFixed(2)}  ${label.padEnd(40)} ${r.from}->${r.to}`);
  }
}
console.log(leaks ? `\n${leaks} LEAKED` : "\nnothing leaks through the lowered gates");

await b.close();
process.exit(leaks ? 1 : 0);
