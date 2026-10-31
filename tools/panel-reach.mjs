// Can the settings panel always be closed?
//
// It is anchored to the bottom and grows upward, so a long body pushed its own
// header off the top of the screen — and the header is the only deliberate way
// to close it. On an iPad that left it covering half the score with nothing to
// tap. The content that did it is real: the gesture description, the controls,
// a twelve-line frame-by-frame dump of why the last page turned, and the
// diagnostics. So this fills the panel the way a session fills it and then
// checks the header is still on screen and still works.
import { chromium } from "playwright-core";
import { executablePath } from "./browser.mjs";

const b = await chromium.launch({
  executablePath,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

let bad = 0;
const check = (ok, line) => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
};

for (const [label, viewport] of [
  ["iPad portrait", { width: 834, height: 1194 }],
  ["iPad landscape", { width: 1194, height: 834 }],
  ["small phone", { width: 390, height: 664 }],
]) {
  const ctx = await b.newContext({ viewport, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
  await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
  await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });

  // Fill it the way a session fills it: a turn report is the longest thing in
  // there and it is written on every gesture-driven turn.
  await p.evaluate(() => {
    document.getElementById("calibStatus").textContent =
      "Turned by tilt forward. The frames before it:\n" +
      Array.from({ length: 12 }, (_, i) =>
        `  ${(384 + i * 0.04).toFixed(2)}s openL0.037 openR0.054 diff-0.18 yaw+0.48 swing0.13 TURNED`
      ).join("\n");
    document.getElementById("screenState").hidden = false;
    document.getElementById("screenState").textContent =
      "The screen is not being held awake and may dim. Tap the score once; " +
      "if it stays like this, turn off Auto-Lock in Settings › Display & Brightness.";
  });

  await p.click("#setupToggle"); // open it
  await p.waitForTimeout(250);

  const box = await p.locator(".panel-head").boundingBox();
  const panel = await p.locator("#setupPanel").boundingBox();
  const onScreen = box && box.y >= 0 && box.y + box.height <= viewport.height;
  check(onScreen, `${label}: the header stays on screen (y=${box?.y.toFixed(0)}, panel ${panel?.height.toFixed(0)}px of ${viewport.height})`);
  check(panel.height <= viewport.height, `${label}: the panel fits the viewport`);

  // And it still closes by tapping it.
  await p.click("#setupToggle");
  await p.waitForTimeout(250);
  check(await p.locator("#setupPanel").evaluate((n) => n.classList.contains("collapsed")),
    `${label}: tapping the header closes it`);

  // Tapping the score closes it too.
  await p.click("#setupToggle");
  await p.waitForTimeout(200);
  // Somewhere genuinely outside it — above the panel, not the middle of the
  // viewport, which on a small screen is inside the panel.
  const open = await p.locator("#setupPanel").boundingBox();
  check(open.y > 40, `${label}: there is score left to tap (${open.y.toFixed(0)}px above the panel)`);
  await p.mouse.click(Math.round(viewport.width / 2), Math.round(open.y / 2));
  await p.waitForTimeout(200);
  check(await p.locator("#setupPanel").evaluate((n) => n.classList.contains("collapsed")),
    `${label}: tapping outside closes it`);

  await ctx.close();
}

await b.close();
console.log(bad ? `${bad} FAILED` : "the panel can always be closed");
process.exit(bad ? 1 : 0);
