// Changing the key of an open score.
//
// The chord symbols move and the notes on the staff do not, which is the
// whole shape of the feature: what is in the PDF is "draw this shape here",
// not "this is a D", and a staff that is 95% transposed is worse than one
// nobody touched because somebody sings it. So the thing most worth testing
// is not the arithmetic — that is next door in transpose.mjs — but that the
// screen never stops saying which half moved.
//
// And that a page turn stays instant. The app pre-renders the pages either
// side of the one showing, so a turn is a blit; if transposing moved that
// work onto the turn itself, it would have cost the app the thing it is for.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "autopage-key-"));
const chart = join(dir, "chart.pdf");
execFileSync("python3", [`${here}make-chart-pdf.py`, chart, "--tight"]);
const plain = `${here}../fixtures/menuet-in-g.pdf`;

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
const ctx = await b.newContext({ viewport: { width: 834, height: 1194 } });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

const open = async (path) => {
  await p.setInputFiles("#fileInput", path);
  await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
  await p.waitForTimeout(800); // the chord scan is deliberately not awaited
};
const panel = async () => {
  if (await p.evaluate(() => document.getElementById("setupPanel").classList.contains("collapsed"))) {
    await p.click("#setupToggle");
    await p.waitForTimeout(250);
  }
};
const band = () => p.evaluate(() => {
  const el = document.getElementById("keyBand");
  return el && !el.hidden ? el.textContent : "";
});
const ink = () => p.evaluate(() => {
  const c = document.getElementById("scoreCanvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, Math.round(c.height * 0.3)).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) n++;
  return n;
});

await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });

// --- A score with no chords is not offered a key ---------------------------
await open(plain);
await panel();
check(await p.locator("#keyRow").isHidden(), "a score with no chord symbols is offered nothing");

// --- A chart is ------------------------------------------------------------
await open(chart);
await panel();
check(await p.locator("#keyRow").isVisible(), "a chord chart is");
check((await p.locator("#keyNow").textContent()) === "Ab",
  `and the key it is printed in is named: ${await p.locator("#keyNow").textContent()}`);
check(!(await band()), "nothing is claimed about the staff while nothing has moved");

const printed = await ink();
await p.click("#keyUp");
await p.waitForTimeout(900);
check((await p.locator("#keyNow").textContent()).startsWith("A ("),
  `up a semitone from Ab is A: ${await p.locator("#keyNow").textContent()}`);

const moved = await ink();
check(moved !== printed && moved < printed * 1.3,
  `the page is redrawn with the new chords and no rectangles: ${printed} -> ${moved}`);

// --- The warning, which is the point ---------------------------------------
check((await band()) === "Chords in A — staff still in Ab",
  `the screen says which half moved: "${await band()}"`);

await p.click("#keyReset");
await p.waitForTimeout(700);
check(!(await band()), "and stops saying it when it stops being true");
check(Math.abs((await ink()) - printed) < printed * 0.02,
  "the original key comes back exactly as printed");

// --- A turn stays a turn ---------------------------------------------------
//
// The reason the overlay happens inside the page cache rather than on the way
// to the screen. Measured against the same score in its own key.
const turnTime = async () => {
  await p.evaluate(() => { window.__autopage.state.page = 1; });
  await p.evaluate(() => window.__autopage.readPage && 0);
  await p.keyboard.press("ArrowRight");
  await p.waitForTimeout(700); // let the neighbour pre-render settle
  const t = await p.evaluate(async () => {
    const t0 = performance.now();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  });
  return t;
};
const plainTurn = await turnTime();
await p.click("#keyUp");
await p.waitForTimeout(1200);
const keyedTurn = await turnTime();
console.log(`      turn: ${plainTurn.toFixed(0)}ms printed, ${keyedTurn.toFixed(0)}ms transposed`);
check(keyedTurn < 120, `a turn in another key is still a blit (${keyedTurn.toFixed(0)}ms)`);

// --- The key belongs to the score ------------------------------------------
await open(plain);
await panel();
check(await p.locator("#keyRow").isHidden() && !(await band()),
  "the next score in the set starts where it was printed");

await open(chart);
await panel();
check((await p.locator("#keyNow").textContent()).startsWith("A ("),
  `and coming back to the chart comes back to its key: ${await p.locator("#keyNow").textContent()}`);
check((await band()).includes("staff still in Ab"), "warning and all");

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
console.log(bad ? `${bad} FAILED` : "the chords move, the staff does not, and the screen says so");
process.exit(bad || errs.length ? 1 : 0);
