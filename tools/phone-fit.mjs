// Does anything spill off the side of a phone, and can the calibration prompt
// still be read while the camera preview is up?
//
// Both were reported from an Android phone: the panel's right-hand half was off
// screen with the type at roughly twice its size, and during calibration the
// preview filled the card and pushed the instruction for the step out of it.
//
// The type was Chrome's text inflation, which this cannot reproduce — it is a
// browser heuristic, switched off with text-size-adjust. What is checkable is
// the consequence: nothing wider than the screen, and the prompt on screen
// whenever the preview is.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

for (const [label, viewport] of [
  ["phone portrait", { width: 412, height: 915 }],
  ["small phone", { width: 360, height: 640 }],
  ["iPad portrait", { width: 834, height: 1194 }],
]) {
  const ctx = await b.newContext({ viewport, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
  await p.click("#sampleBtn");
  await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
  await p.waitForFunction(() => window.__autopage.ready === true, { timeout: 90000 });
  await p.click("#setupToggle");
  await p.waitForTimeout(400);

  // Nothing off the side, anywhere.
  const spill = await p.evaluate((w) =>
    [...document.querySelectorAll("body *")]
      .filter((n) => n.offsetParent !== null)
      .map((n) => ({ id: n.id || n.className, r: n.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && (x.r.right > w + 1 || x.r.left < -1))
      .map((x) => `${x.id} [${x.r.left.toFixed(0)}..${x.r.right.toFixed(0)}]`)
  , viewport.width);
  check(spill.length === 0, `${label}: nothing spills off the side${spill.length ? " — " + spill.join(", ") : ""}`);
  check(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
    `${label}: the page does not scroll sideways`);

  // Every button reads as one: a fill the eye can find against the panel.
  const flat = await p.evaluate(() =>
    [...document.querySelectorAll(".btn-secondary")]
      .filter((n) => n.offsetParent !== null)
      .filter((n) => {
        const s = getComputedStyle(n);
        return s.backgroundColor === "rgba(0, 0, 0, 0)" && s.borderTopWidth === "0px";
      })
      .map((n) => n.id || n.textContent.trim())
  );
  check(flat.length === 0, `${label}: every button looks like one${flat.length ? " — " + flat.join(", ") : ""}`);

  // And with the preview up, the prompt is still on screen.
  await p.click("#calibrateBtn");
  await p.waitForSelector("#camPreview:not([hidden])", { timeout: 10000 });
  await p.waitForTimeout(600);
  const seen = await p.evaluate((h) => {
    const prompt = document.getElementById("gestureStatus").getBoundingClientRect();
    const cam = document.getElementById("camPreview").getBoundingClientRect();
    const watch = document.getElementById("watch").getBoundingClientRect();
    return { promptBottom: prompt.bottom, camH: cam.height, watchH: watch.height, h };
  }, viewport.height);
  check(seen.promptBottom > 0 && seen.promptBottom < viewport.height,
    `${label}: the prompt stays on screen while calibrating (ends at ${seen.promptBottom.toFixed(0)} of ${viewport.height})`);
  check(seen.watchH <= viewport.height - 60,
    `${label}: the camera card fits (${seen.watchH.toFixed(0)}px card, ${seen.camH.toFixed(0)}px preview)`);

  await p.click("#calibrateBtn"); // cancel
  await ctx.close();
}

await b.close();
console.log(bad ? `${bad} FAILED` : "it fits on a phone");
process.exit(bad ? 1 : 0);
