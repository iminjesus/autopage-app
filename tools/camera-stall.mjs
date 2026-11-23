// A camera that stops, and an app that notices.
//
// The gesture loop used to begin `if (readyState < 2) return` and nothing
// else, so a video element that had been paused left the gesture dead with no
// sign of it anywhere: the score sits there, tilting your head does nothing,
// and that is indistinguishable from the gesture being broken. Android pauses
// media freely after a full screen overlay, a sign-in window, or a trip to
// another app — all three of which the Drive flow now involves.
//
// Chromium's fake camera is a real MediaStream, so the two ways this happens
// can both be produced here: the element paused, and the track ended.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
const ctx = await b.newContext({
  viewport: { width: 834, height: 1194 },
  permissions: ["camera"],
});
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

const toast = () => p.evaluate(() => {
  const t = document.getElementById("driveToast");
  return t && !t.hidden ? t.textContent : "";
});
const running = () => p.evaluate(() => {
  const v = document.getElementById("camPreview");
  return { paused: v.paused, ready: v.readyState, live: !!v.srcObject };
});

await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });

// The camera, actually running.
await p.evaluate(() => window.__autopage.startGesture());
await p.waitForFunction(() => document.getElementById("camPreview").readyState >= 2, null, { timeout: 30000 });
await p.waitForTimeout(600);
check((await running()).ready >= 2, "the camera is delivering frames to start with");
check(!(await toast()), "and nothing is being complained about");

// --- Paused behind our back -------------------------------------------------
//
// What a full screen overlay does on a phone. The element is fine, it is just
// not playing, and nothing will ever start it again on its own.
await p.evaluate(() => document.getElementById("camPreview").pause());
await p.waitForTimeout(400);
check((await running()).paused, "the video can be paused out from under the gesture");

await p.waitForFunction(() => !document.getElementById("camPreview").paused, null, { timeout: 15000 })
  .then(() => check(true, "and the app starts it again by itself"))
  .catch(() => check(false, "and the app starts it again by itself"));

await p.waitForTimeout(800);
check((await running()).ready >= 2, "frames are arriving again");

// --- The track ended --------------------------------------------------------
//
// What another app taking the camera does. The element cannot be resumed;
// the stream has to be asked for again.
await p.evaluate(() => {
  const v = document.getElementById("camPreview");
  v.srcObject.getTracks().forEach((t) => t.stop());
});
await p.waitForTimeout(400);

await p.waitForFunction(() => {
  const v = document.getElementById("camPreview");
  const track = v.srcObject?.getVideoTracks?.()[0];
  return v.readyState >= 2 && track && track.readyState === "live";
}, null, { timeout: 20000 })
  .then(() => check(true, "a camera taken away is asked for again"))
  .catch(() => check(false, "a camera taken away is asked for again"));

await p.waitForTimeout(600);
check(!(await toast()), `and once it is back, nothing is left on screen about it: "${await toast()}"`);

// --- It still turns pages ---------------------------------------------------
//
// The point of all of it. A recovered camera that does not drive the gesture
// is the same failure wearing a different face.
const turned = await p.evaluate(async () => {
  const A = window.__autopage;
  A.setMode("tilt");
  A.state.page = 2;
  const before = A.state.page;
  const pt = (x, y) => ({ x, y, z: 0 });
  const face = (roll) => {
    const half = 0.06, cx = 0.5, cy = 0.32;
    const L = { x: cx + half * Math.cos(roll), y: cy + half * Math.sin(roll) };
    const R = { x: cx - half * Math.cos(roll), y: cy - half * Math.sin(roll) };
    const m = [];
    m[10] = pt(0.5, 0.2); m[152] = pt(0.5, 0.5); m[1] = pt(0.5, 0.36);
    m[386] = pt(L.x, L.y - 0.0075); m[374] = pt(L.x, L.y + 0.0075);
    m[159] = pt(R.x, R.y - 0.0075); m[145] = pt(R.x, R.y + 0.0075);
    m[33] = pt(R.x - 0.02 * Math.cos(roll), R.y - 0.02 * Math.sin(roll));
    m[263] = pt(L.x + 0.02 * Math.cos(roll), L.y + 0.02 * Math.sin(roll));
    return m;
  };
  const shapes = [{ categoryName: "eyeBlinkLeft", score: 0 }, { categoryName: "eyeBlinkRight", score: 0 }];
  const t0 = performance.now() + 100000; // past anything the real camera did
  const at = (i) => t0 + i * (1000 / 30);
  let i = 0;
  for (let n = 0; n < 30; n++) A.processFrame(face(0), shapes, at(i++));        // sitting still
  for (let n = 0; n < 10; n++) A.processFrame(face((0.35 * n) / 9), shapes, at(i++)); // over
  for (let n = 0; n < 20; n++) A.processFrame(face(0.35), shapes, at(i++));     // held
  return { before, after: A.state.page };
});
check(turned.after !== turned.before,
  `and a tilt still turns the page afterwards: ${turned.before} -> ${turned.after}`);

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
console.log(bad ? `${bad} FAILED` : "a camera that stops is noticed and restarted");
process.exit(bad || errs.length ? 1 : 0);
