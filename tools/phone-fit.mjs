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

  // Every button reads as one — measured against what it sits on, not assumed.
  //
  // The first version of this asked whether the button had *a* background, and
  // passed happily on a fill six per cent lighter than the panel behind it,
  // which is invisible on a phone in daylight. It asks for a real step now:
  // either a contrast ratio the eye can find, or a rim it can trace.
  const weak = await p.evaluate(() => {
    const lum = (css) => {
      const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map(Number);
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const panel = lum(getComputedStyle(document.getElementById("setupPanel")).backgroundColor);
    return [...document.querySelectorAll(".btn")]
      .filter((n) => n.offsetParent !== null)
      .map((n) => {
        const s = getComputedStyle(n);
        const ratio = (Math.max(lum(s.backgroundColor), panel) + 0.05) /
                      (Math.min(lum(s.backgroundColor), panel) + 0.05);
        const rim = parseFloat(s.borderTopWidth) > 0 &&
                    (s.borderTopColor.match(/[\d.]+/g)?.[3] ?? 1) >= 0.12;
        return { what: n.id || n.textContent.trim().split("\n")[0], ratio: +ratio.toFixed(2), rim };
      })
      .filter((x) => x.ratio < 1.3 && !x.rim);
  });
  check(weak.length === 0,
    `${label}: every button stands off the panel${weak.length ? " — " + weak.map((w) => `${w.what} x${w.ratio}`).join(", ") : ""}`);

  // Calibrating is its own moment: the card holds the prompt, your face and
  // the way out, and the panel is folded away rather than half-covered.
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

  // The card floats above the panel. On an iPad they never meet; on a phone
  // the panel's top reached up behind it and the first thing it hid was the
  // button you most often open the panel for.
  const clash = await p.evaluate(() => {
    const w = document.getElementById("watch").getBoundingClientRect();
    const panel = document.getElementById("setupPanel").getBoundingClientRect();
    const hidden = [...document.querySelectorAll("#setupPanel .btn, #setupPanel .field")]
      .filter((n) => n.offsetParent !== null)
      .filter((n) => n.getBoundingClientRect().top < w.bottom)
      .map((n) => n.id || n.textContent.trim().split("\n")[0].slice(0, 20));
    return { overlap: Math.max(0, w.bottom - panel.top), hidden };
  });
  check(clash.overlap === 0 && clash.hidden.length === 0,
    `${label}: the camera card covers nothing in the panel` +
      (clash.overlap ? ` — ${clash.overlap.toFixed(0)}px over, hiding ${clash.hidden.join(", ") || "nothing named"}` : ""));

  // And the way out is in the card, where the eye already is.
  const escape = await p.evaluate(() => {
    const b = document.getElementById("cancelCalibBtn");
    const r = b.getBoundingClientRect();
    return { shown: !b.hidden, bottom: r.bottom, folded: document.getElementById("setupPanel").classList.contains("collapsed") };
  });
  check(escape.shown && escape.bottom < viewport.height && escape.folded,
    `${label}: Cancel is in the card and the panel is folded away ` +
      `(shown ${escape.shown}, ends at ${escape.bottom.toFixed(0)}, folded ${escape.folded})`);

  // Cancel from the card — the panel's own button is folded away by now,
  // which is the point.
  await p.click("#cancelCalibBtn");
  await p.waitForTimeout(200);
  check(await p.locator("#cancelCalibBtn").isHidden(), `${label}: Cancel ends the calibration`);
  await ctx.close();
}

await b.close();
console.log(bad ? `${bad} FAILED` : "it fits on a phone");
process.exit(bad ? 1 : 0);
