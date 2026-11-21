// Does the score come back, on the page it was left on?
//
// Reopening from storage is the one path a player will hit every single time
// and never think about, so it is also the one where a silent failure is worst:
// it looks exactly like the app having forgotten, with nothing to read.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executablePath } from "./browser.mjs";
const b = await chromium.launch({ executablePath });
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

// And a different score can still be opened once one is showing — the picker
// on the empty screen is gone by then, and a tablet has nothing to drag.
//
// A genuinely different one. This handed it the same file back and asserted it
// landed on page 1, which stopped being true the day each score started
// keeping its own bookmark — and it had never been testing what it said.
const other = join(mkdtempSync(join(tmpdir(), "autopage-other-")), "Other.pdf");
execFileSync("python3", [new URL("./make-test-pdf.py", import.meta.url).pathname, "Other", other]);

await p.evaluate(() => {
  document.getElementById("setupPanel").hidden = false;
  document.getElementById("setupToggle").setAttribute("aria-expanded", "true");
});
await p.setInputFiles("#swapFileInput", other);
await p.waitForFunction(() => window.__autopage.state.name === "Other.pdf", { timeout: 10000 });
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
const lit = await t.isChecked("#modeTilt");
console.log(`${mode === "tilt" && lit ? "ok  " : "FAIL"} the tilt is the default, and shown as the one that is on (mode:${mode}, lit:${lit})`);
await touch.close();

// What a stored preference does to that default.
//
// Worth pinning because the two are easy to confuse from the outside: a device
// that has had the wink chosen on it opens on the wink, which looks exactly
// like the default being wrong. A saved choice is meant to win — it is the
// answer to "do I have to set this every time?" — so the only thing to get
// right is that nothing else does.
for (const [stored, want] of [
  [null, "tilt"],     // nothing chosen yet
  ["tilt", "tilt"],
  ["wink", "wink"],   // a real choice, and it sticks
  ["brow", "tilt"],   // what the tilt used to be called
  ["nonsense", "tilt"],
]) {
  const ctx2 = await b.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
  const q = await ctx2.newPage();
  await q.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
  if (stored !== null) {
    await q.evaluate((s) => localStorage.setItem("autopage.gestureMode", s), stored);
    await q.reload({ waitUntil: "networkidle" });
  }
  await q.waitForTimeout(300);
  const got = await q.evaluate(() => window.__autopage.mode);
  const shown = await q.isChecked(got === "wink" ? "#modeWink" : "#modeTilt");
  console.log(
    `${got === want && shown ? "ok  " : "FAIL"} stored ${String(stored).padEnd(9)} -> ${got.padEnd(5)} (wanted ${want}, shown as on: ${shown})`
  );
  await ctx2.close();
}
await b.close();
