// The chooser: recent sets, loose scores, and picking between them by sight.
//
// The store used to hold exactly one score under the key "last", then the last
// five. It holds *sets* now — a Sunday's worth of songs, opened together and
// kept together — beside a few scores opened one at a time. Scores are still
// keyed by a hash of their contents, which is what makes the same file opened
// twice one entry with one bookmark rather than two that disagree.
//
// Throwaway one-page PDFs, each with a different word on it, because the
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
const made = new Map();
const pdf = (name) => {
  if (!made.has(name)) {
    const path = join(dir, `${name}.pdf`);
    execFileSync("python3", [`${here}make-test-pdf.py`, name, path]);
    made.set(name, path);
  }
  return made.get(name);
};

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
const ctx = await b.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

const show = () => p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });

/** Open one score on its own — a loose one. */
const open = async (name) => {
  await p.setInputFiles("#fileInput", pdf(name));
  await p.waitForFunction((n) => window.__autopage.state.name === `${n}.pdf`, name, { timeout: 20000 });
  await p.waitForTimeout(500); // the thumbnail is taken after the page is up
};

/**
 * Every tile has its picture.
 *
 * The songs that were not opened are drawn in the background, so waiting a
 * fixed moment for them is a test that passes on a fast machine and fails on a
 * slow one. Wait for the thing itself.
 */
const everyTilePictured = () =>
  p.waitForFunction(
    () => {
      const tiles = [...document.querySelectorAll("#recent .recent-item")];
      return tiles.length > 0 && tiles.every((n) => n.querySelector("img"));
    },
    null,
    { timeout: 30000 }
  );

/** Open several at once — which is how a Sunday arrives. */
const openSet = async (names) => {
  // The app opens the first by name, not the first handed over.
  const first = [...names].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))[0];
  await p.setInputFiles("#fileInput", names.map(pdf));
  await p.waitForFunction((n) => window.__autopage.state.name === `${n}.pdf`, first, { timeout: 30000 });
  // The set record is written after the last song is stored, so the group can
  // appear a moment after the first song is on screen.
  await p.waitForFunction(
    (want) =>
      [...document.querySelectorAll("#recent > .recent-head")].some((h) => {
        const titles = [...(h.nextElementSibling?.querySelectorAll(".recent-item") ?? [])]
          .map((n) => n.title);
        return titles.length === want.length && want.every((t) => titles.includes(t));
      }),
    names.map((n) => `${n}.pdf`),
    { timeout: 30000 }
  );
  await everyTilePictured();
};

/** Every tile, in the order they are drawn, whichever group they sit in. */
const chooser = () =>
  p.evaluate(() =>
    [...document.querySelectorAll("#recent .recent-item")].map((n) => ({
      name: n.title,
      hasThumb: !!n.querySelector("img"),
      current: n.getAttribute("aria-current") === "true",
    }))
  );

/**
 * Wait for a removal to have been drawn.
 *
 * The undo line and the list are drawn in the same pass, so the line appearing
 * says the removal is on screen — without presuming what the list now says,
 * which is the thing being checked.
 */
const removalDrawn = () =>
  p.waitForFunction(() => !!document.querySelector("#recent .recent-undo"), null, { timeout: 15000 });

/** The chooser as it reads: a heading, then the tiles under it. */
const groups = () =>
  p.evaluate(() =>
    [...document.querySelectorAll("#recent > .recent-head")].map((head) => ({
      name: head.firstChild.textContent,
      count: head.querySelector(".recent-count").textContent,
      removable: !!head.querySelector(".recent-drop"),
      scores: [...(head.nextElementSibling?.querySelectorAll(".recent-item") ?? [])].map(
        (n) => n.title.replace(".pdf", "")
      ),
    }))
  );

await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });

// --- Loose scores ---------------------------------------------------------

// One score is not a choice.
await open("Alpha");
await show();
check(await p.locator("#recent").isHidden(), "one score: no chooser, because there is nothing to choose");

await open("Bravo");
await open("Charlie");
await show();
let list = await chooser();
check(list.length === 3, `three scores: ${list.map((x) => x.name).join(", ")}`);
check(list.every((x) => x.hasThumb), "each one shows its own first page");
check(list[0].name === "Charlie.pdf" && list[0].current, "the newest is first, and marked as the one you are in");
check((await groups()).length === 0, "no headings when there is nothing but loose scores");

// Seven opened, six kept.
for (const n of ["Delta", "Echo", "Foxtrot", "Golf"]) await open(n);
await show();
list = await chooser();
check(list.length === 6, `seven opened, six kept: ${list.map((x) => x.name.replace(".pdf", "")).join(", ")}`);
check(!list.some((x) => x.name === "Alpha.pdf"), "the oldest fell off the end");

// Choosing one opens it — and says so at once, rather than when it is ready.
//
// Reading a stored PDF back and laying out its first page is a second or two
// on a tablet. Every visible part of the answer used to be queued behind that,
// so the tap looked like it had missed. These are checked in the same tick as
// the click, before anything has been read.
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
await show();
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

await show();
await p.locator('.recent-item[title="Echo.pdf"] .recent-open').first().click();
await p.waitForFunction(() => window.__autopage.state.name === "Echo.pdf", { timeout: 15000 });
await show();
await p.locator('.recent-item[title="menuet-in-g.pdf"] .recent-open').first().click();
await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 15000 });
const backTo = await p.evaluate(() => window.__autopage.state.page);
check(backTo === deep, `each score keeps its own page (left on ${deep}, came back to ${backTo})`);

// And all of it survives a reload.
await p.reload({ waitUntil: "networkidle" });
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
await show();
await p.waitForTimeout(400);
const back = await chooser();
check(back.length === 6 && back.every((x) => x.hasThumb),
  `after a reload the six are still there with their pictures (${back.length})`);

// --- Forgetting one -------------------------------------------------------
await show();
const beforeRemove = (await chooser()).map((x) => x.name);
const openedBefore = await p.evaluate(() => window.__autopage.state.name);
// Not the one that is open, so that "did it also open it?" stays answerable.
const victim = beforeRemove.find((n) => n !== openedBefore) ?? beforeRemove[1];

// The minus must not also open the thing it is removing.
await p.locator(`.recent-item[title="${victim}"] .recent-remove`).first().click();
await removalDrawn();
const afterRemove = (await chooser()).map((x) => x.name);
check(!afterRemove.includes(victim) && afterRemove.length === beforeRemove.length - 1,
  `removing ${victim.replace(".pdf", "")} drops it: ${beforeRemove.length} -> ${afterRemove.length}`);
check((await p.evaluate(() => window.__autopage.state.name)) === openedBefore,
  "the minus removes without also opening it");

// And it can be taken back.
check(await p.locator(".recent-undo").first().isVisible(), "an undo is offered");
await p.locator(".recent-undo .linkish").first().click();
await p.waitForFunction((n) => [...document.querySelectorAll("#recent .recent-item")]
  .some((t) => t.title === n), victim, { timeout: 15000 }).catch(() => {});
const afterUndo = (await chooser()).map((x) => x.name);
check(afterUndo.includes(victim) && afterUndo.length === beforeRemove.length,
  `undo puts ${victim.replace(".pdf", "")} back (${afterUndo.length})`);

// Gone for good once the undo is: removed again, then reload.
await p.locator(`.recent-item[title="${victim}"] .recent-remove`).first().click();
await removalDrawn();
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(600);
await show();
await p.waitForTimeout(300);
check(!(await chooser()).map((x) => x.name).includes(victim),
  "after a reload it is still gone, and so is the undo");

// --- Sets -----------------------------------------------------------------
//
// Selecting a Sunday's songs together is what makes them a set. Everything
// below is about them staying one thing: named together, listed together,
// forgotten together, and pruned together.

const SUNDAY = ["03 Doxology", "01 Build My Life", "02 Goodness of God"];
await openSet(SUNDAY);
await show();
let g = await groups();
const sunday = g[0];
check(g.length >= 2 && sunday.scores.length === 3,
  `three picked at once make one group of three: ${JSON.stringify(g.map((x) => [x.name, x.scores.length]))}`);
check(sunday.name === new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" }),
  `the group is named for the day: "${sunday.name}"`);
check(sunday.count === "3 scores" && sunday.removable, "with a count, and a way to drop the whole thing");
check(sunday.scores.join(" | ") === "01 Build My Life | 02 Goodness of God | 03 Doxology",
  `in numbered order, not the order the picker handed them over: ${sunday.scores.join(" | ")}`);
check((await p.evaluate(() => window.__autopage.state.name)) === "01 Build My Life.pdf",
  "and the first of them is the one that opens");
check(g[1].name === "Other" && !g[1].removable,
  `the loose ones get a heading of their own once a set is above them: "${g[1].name}"`);
check((await chooser()).filter((x) => SUNDAY.some((n) => x.name === `${n}.pdf`)).every((x) => x.hasThumb),
  "every song in the set has its picture, not just the one that was opened");

// The same folder again is the same Sunday.
await openSet(SUNDAY);
await show();
g = await groups();
check(g.filter((x) => x.name === sunday.name).length === 1,
  `opening the same set again does not make a second group (${g.filter((x) => x.name === sunday.name).length})`);

// Dropping a Sunday drops all of it, and gives all of it back.
const looseBefore = (await groups()).find((x) => x.name === "Other")?.scores.length ?? 0;
await p.locator(".recent-head .recent-drop").first().click();
await removalDrawn();
check(!(await groups()).some((x) => x.name === sunday.name), "the minus on a heading takes the whole Sunday");
check(!(await chooser()).some((x) => SUNDAY.some((n) => x.name === `${n}.pdf`)),
  "its songs go with it, rather than being left behind as loose ones");
check((await p.locator(".recent-undo").first().textContent()).includes("(3)"),
  "the undo says how many it is holding");

await p.locator(".recent-undo .linkish").first().click();
await p.waitForFunction(
  (name) => [...document.querySelectorAll("#recent > .recent-head")]
    .some((h) => h.firstChild.textContent === name),
  sunday.name,
  { timeout: 15000 }
).catch(() => {});
g = await groups();
const restored = g.find((x) => x.name === sunday.name);
check(restored?.scores.length === 3, `undo brings the Sunday back whole (${restored?.scores.length ?? 0})`);
check((g.find((x) => x.name === "Other")?.scores.length ?? 0) === looseBefore,
  "and leaves the loose ones where they were");

// Five Sundays, four kept — and the one that goes, goes entirely.
//
// This is what pruning by score count got wrong: five scores is one Sunday, so
// every new set ate the one before it and left half a set behind.
// Named apart, because four sets made on one day all reading "Nov 21" tells
// you nothing about which is which.
const sundays = [
  ["A1 Here", "A2 Now"],
  ["B1 Holy", "B2 Forever"],
  ["C1 Great", "C2 Is"],
  ["D1 Thy", "D2 Faithfulness"],
];
for (const s of sundays) await openSet(s);
await show();
g = await groups();
const sets = g.filter((x) => x.name !== "Other");
check(sets.length === 4, `a fifth Sunday pushes the first one out: ${sets.length} sets kept`);
check(!sets.some((x) => x.name === sunday.name),
  `the oldest Sunday is the one that went: ${sets.map((x) => x.name).join(", ")}`);
check(!(await chooser()).some((x) => SUNDAY.some((n) => x.name === `${n}.pdf`)),
  "and its songs went with it, rather than being left behind as loose ones");
check(sets.every((x) => x.scores.length === 2), `and every kept Sunday is still whole: ${JSON.stringify(sets.map((x) => x.scores.length))}`);
check(new Set(sets.map((x) => x.name)).size === 4,
  `four sets on one day still read apart: ${sets.map((x) => x.name).join(", ")}`);

// Sets survive a reload too, as sets.
await p.reload({ waitUntil: "networkidle" });
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
await show();
await p.waitForTimeout(500);
const afterReload = (await groups()).filter((x) => x.name !== "Other");
check(afterReload.length === 4 && afterReload.every((x) => x.scores.length === 2),
  `after a reload the Sundays are still Sundays: ${JSON.stringify(afterReload.map((x) => [x.name, x.scores.length]))}`);

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
console.log(bad ? `${bad} FAILED` : "the chooser works");
process.exit(bad || errs.length ? 1 : 0);
