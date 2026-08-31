// Does the score come back, on the page it was left on?
//
// Reopening from storage is the one path a player will hit every single time
// and never think about, so it is also the one where a silent failure is worst:
// it looks exactly like the app having forgotten, with nothing to read.
import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await b.newContext(); // one origin, one storage, across reloads
const p = await ctx.newPage();

const open = async () => {
  await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
};
const loaded = () =>
  p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 10000 });
const shot = () =>
  p.evaluate(() => ({
    pages: window.__autopage.state.pageCount,
    page: window.__autopage.state.page,
    name: window.__autopage.state.name,
    canvas: !document.getElementById("scoreCanvas").hidden,
    empty: document.getElementById("scoreEmpty").hidden,
  }));

await open();
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await loaded();
console.log("picked            ->", JSON.stringify(await shot()));

await p.keyboard.press("ArrowRight");
await p.keyboard.press("ArrowRight");
await p.waitForTimeout(700); // the page write is debounced
console.log("after two turns   ->", JSON.stringify(await shot()));

await open();
await loaded();
const back = await shot();
console.log("after a reload    ->", JSON.stringify(back));
console.log(back.page === 3 ? "ok   came back on page 3" : `FAIL came back on page ${back.page}, wanted 3`);

// And a different score can still be opened once one is showing — the picker on
// the empty screen is gone by then, and a tablet has nothing to drag.
await p.evaluate(() => {
  document.getElementById("setupPanel").hidden = false;
  document.getElementById("setupToggle").setAttribute("aria-expanded", "true");
});
await p.setInputFiles("#swapFileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.page === 1, { timeout: 10000 });
console.log("ok   another score opens from the panel");

const awake = await p.evaluate(() => "wakeLock" in navigator);
console.log("wake lock API     ->", awake ? "present" : "absent (headless)");

// On a touch device with nothing chosen yet, the tilt is the gesture offered.
const touch = await b.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
const t = await touch.newPage();
await t.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
// The mode itself, not the sentence describing it — the wording of the help
// text is not the contract, and checking it made this fail on a rewrite that
// changed nothing about the behaviour.
const mode = await t.evaluate(() => window.__autopage.mode);
const coarse = await t.evaluate(() => matchMedia("(pointer: coarse)").matches);
console.log(`${mode === "tilt" ? "ok  " : "FAIL"} touch default   -> coarse:${coarse}  mode:${mode}`);
await touch.close();
await b.close();
