// What watching for a hand costs the thing that turns the pages.
//
// The face model is already reading the camera thirty times a second, and
// that is the work this app exists to do. A second vision model on the same
// video could quietly halve it — and the symptom would be the gesture going
// vague, which is the complaint this app has already answered three times.
//
// So it is measured rather than assumed: the face loop's real rate, with the
// hand recogniser off and then on, against the same fake camera.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
const ctx = await b.newContext({ viewport: { width: 834, height: 1194 }, permissions: ["camera"] });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

/** Face frames actually processed per second, over a real five seconds. */
const faceRate = async (seconds = 5) => {
  const before = await p.evaluate(() => window.__autopage.faceFrames);
  const t0 = Date.now();
  await p.waitForTimeout(seconds * 1000);
  const after = await p.evaluate(() => window.__autopage.faceFrames);
  return (after - before) / ((Date.now() - t0) / 1000);
};

await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", `${new URL(".", import.meta.url).pathname}../fixtures/menuet-in-g.pdf`);
await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });
await p.evaluate(() => window.__autopage.startGesture());
await p.waitForFunction(() => document.getElementById("camPreview").readyState >= 2, null, { timeout: 30000 });
await p.waitForTimeout(1500); // let it settle

const alone = await faceRate();
console.log(`      face alone:     ${alone.toFixed(1)} fps`);

// Switch the hand on for real — model download and all.
const t0 = Date.now();
await p.evaluate(() => window.__autopage.setThumbs(true));
await p.waitForFunction(() => window.__autopage.thumbsOn, null, { timeout: 60000 });
await p.waitForTimeout(2500); // the recogniser warms up on its first frames
console.log(`      hand model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const together = await faceRate();
console.log(`      face with hand: ${together.toFixed(1)} fps`);

const lost = (alone - together) / alone;
check(together >= 20,
  `the face is still read often enough to turn pages: ${together.toFixed(1)} fps`);
check(lost < 0.35,
  `and watching for a hand costs it under a third of its rate: ${Math.round(lost * 100)}% lost`);

// And it really is running, not quietly failing and therefore costing nothing.
check(await p.evaluate(() => window.__autopage.thumbsOn), "with the hand recogniser actually on");

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
console.log(bad ? `${bad} FAILED` : "a hand on the camera does not cost the page turn");
process.exit(bad || errs.length ? 1 : 0);
