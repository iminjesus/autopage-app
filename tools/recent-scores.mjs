// The last few scores, and choosing between them by looking at them.
//
// The store used to hold exactly one score under the key "last". It holds up to
// five now, keyed by a hash of their contents — which is what makes the same
// file opened twice one entry with one bookmark rather than two that disagree.
//
// Six throwaway one-page PDFs, each with a different word on it, because the
// entries have to genuinely differ: same contents means same id, and the
// thumbnails have to be distinguishable for the chooser to be worth anything.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "autopage-scores-"));
const NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];
const pdfs = Object.fromEntries(
  NAMES.map((n) => {
    const path = join(dir, `${n}.pdf`);
    execFileSync("python3", [`${here}make-test-pdf.py`, n, path]);
    return [n, path];
  })
);

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
const ctx = await b.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

const open = async (name) => {
  await p.setInputFiles("#fileInput", pdfs[name]);
  await p.waitForFunction((n) => window.__autopage.state.name === `${n}.pdf`, name, { timeout: 20000 });
  await p.waitForTimeout(500); // the thumbnail is taken after the page is up
};
const chooser = () =>
  p.evaluate(() =>
    [...document.querySelectorAll("#recent .recent-item")].map((n) => ({
      name: n.title,
      hasThumb: !!n.querySelector("img"),
      current: n.getAttribute("aria-current") === "true",
    }))
  );

await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });

// One score is not a choice.
await open("Alpha");
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
check(await p.locator("#recent").isHidden(), "one score: no chooser, because there is nothing to choose");

await open("Bravo");
await open("Charlie");
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
let list = await chooser();
check(list.length === 3, `three scores: ${list.map((x) => x.name).join(", ")}`);
check(list.every((x) => x.hasThumb), "each one shows its own first page");
check(list[0].name === "Charlie.pdf" && list[0].current, "the newest is first, and marked as the one you are in");

// Six opened, five kept.
await open("Delta");
await open("Echo");
await open("Foxtrot");
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
list = await chooser();
check(list.length === 5, `six opened, five kept: ${list.map((x) => x.name.replace(".pdf", "")).join(", ")}`);
check(!list.some((x) => x.name === "Alpha.pdf"), "the oldest fell off the end");

// Choosing one opens it — and says so at once, rather than when it is ready.
//
// Reading a stored PDF back and laying out its first page is a second or two
// on a tablet. Every visible part of the answer used to be queued behind that,
// so the tap looked like it had missed. These three are checked in the same
// tick as the click, before anything has been read.
const instant = await p.evaluate(() => {
  const tile = [...document.querySelectorAll("#recent .recent-item")]
    .find((n) => n.title === "Charlie.pdf");
  tile.querySelector(".recent-open").click();
  return {
    marked: tile.getAttribute("aria-current") === "true",
    collapsed: document.getElementById("setupPanel").classList.contains("collapsed"),
    bar: !document.getElementById("loading").hidden,
    dimmed: document.getElementById("score").classList.contains("busy"),
    loaded: window.__autopage.state.name === "Charlie.pdf", // must still be false
  };
});
check(instant.marked && instant.collapsed && instant.bar && instant.dimmed && !instant.loaded,
  `the tap is answered in the same frame: ${JSON.stringify(instant)}`);

await p.waitForFunction(() => window.__autopage.state.name === "Charlie.pdf", { timeout: 15000 });
check(true, "tapping a thumbnail opens that score");
await p.waitForTimeout(400);
check(await p.locator("#loading").isHidden() && !(await p.evaluate(() => document.getElementById("score").classList.contains("busy"))),
  "and the bar goes away when it is open");

// The same file twice is one entry, not two.
const before = (await chooser()).length;
await open("Charlie");
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
const after = await chooser();
check(after.length === before, `opening the same file again adds nothing (${before} -> ${after.length})`);

// A bookmark belongs to its score, and survives switching away and back.
//
// With the four-page fixture, not one of the one-page throwaways: "came back
// to page 1" is not evidence of anything when page 1 is the only page there is.
await p.setInputFiles("#fileInput", `${here}../fixtures/menuet-in-g.pdf`);
await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });
await p.waitForTimeout(500);
await p.keyboard.press("ArrowRight");
await p.keyboard.press("ArrowRight");
await p.waitForTimeout(900); // the page write is debounced
const deep = await p.evaluate(() => window.__autopage.state.page);
check(deep === 3, `turned the four-page score to page ${deep}`);

await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
await p.locator('.recent-item[title="Echo.pdf"] .recent-open').first().click();
await p.waitForFunction(() => window.__autopage.state.name === "Echo.pdf", { timeout: 15000 });
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
await p.locator('.recent-item[title="menuet-in-g.pdf"] .recent-open').first().click();
await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 15000 });
const backTo = await p.evaluate(() => window.__autopage.state.page);
check(backTo === deep, `each score keeps its own page (left on ${deep}, came back to ${backTo})`);

// And all of it survives a reload.
await p.reload({ waitUntil: "networkidle" });
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
await p.waitForTimeout(400);
const back = await chooser();
check(back.length === 5 && back.every((x) => x.hasThumb),
  `after a reload the five are still there with their pictures (${back.length})`);

// --- Forgetting one -------------------------------------------------------
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
const beforeRemove = (await chooser()).map((x) => x.name);
const openedBefore = await p.evaluate(() => window.__autopage.state.name);
// Not the one that is open, so that "did it also open it?" stays answerable.
const victim = beforeRemove.find((n) => n !== openedBefore) ?? beforeRemove[1];

// The minus must not also open the thing it is removing.
await p.locator(`.recent-item[title="${victim}"] .recent-remove`).first().click();
await p.waitForTimeout(400);
const afterRemove = (await chooser()).map((x) => x.name);
check(!afterRemove.includes(victim) && afterRemove.length === beforeRemove.length - 1,
  `removing ${victim.replace(".pdf", "")} drops it: ${beforeRemove.length} -> ${afterRemove.length}`);
check((await p.evaluate(() => window.__autopage.state.name)) === openedBefore,
  "the minus removes without also opening it");

// And it can be taken back.
check(await p.locator(".recent-undo").first().isVisible(), "an undo is offered");
await p.locator(".recent-undo .linkish").first().click();
await p.waitForTimeout(400);
const afterUndo = (await chooser()).map((x) => x.name);
check(afterUndo.includes(victim) && afterUndo.length === beforeRemove.length,
  `undo puts ${victim.replace(".pdf", "")} back (${afterUndo.length})`);

// Gone for good once the undo is: removed again, then reload.
await p.locator(`.recent-item[title="${victim}"] .recent-remove`).first().click();
await p.waitForTimeout(300);
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(600);
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
await p.waitForTimeout(300);
check(!(await chooser()).map((x) => x.name).includes(victim),
  "after a reload it is still gone, and so is the undo");

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
console.log(bad ? `${bad} FAILED` : "the chooser works");
process.exit(bad || errs.length ? 1 : 0);
