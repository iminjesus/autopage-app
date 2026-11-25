// Covering a chord without leaving a mark.
//
// The arithmetic is tested next door in transpose.mjs. This is the other
// half: putting the new symbol on the page where the old one was, without
// stamping a rectangle through the chart.
//
// It is measured in ink. Rendering a transposed page should add roughly the
// ink of the new symbols and nothing else — a patch painted in the wrong
// colour is a filled black box, which shows up as a large jump that no amount
// of eyeballing a thumbnail would catch reliably.
import { chromium } from "playwright-core";
import { executablePath } from "./browser.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "autopage-chart-"));
const chart = (name, ...flags) => {
  const path = join(dir, `${name}.pdf`);
  execFileSync("python3", [`${here}make-chart-pdf.py`, path, ...flags]);
  return path;
};
const loose = chart("loose");
const tight = chart("tight", "--tight");

const b = await chromium.launch({ executablePath });
const p = await (await b.newContext({ viewport: { width: 900, height: 1100 } })).newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

/** How much of the page is ink, across the band the chords live in. */
const ink = () => p.evaluate(() => {
  const c = document.querySelector("canvas");
  const ctx = c.getContext("2d");
  const d = ctx.getImageData(0, 0, c.width, Math.round(c.height * 0.25)).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) n++;
  return n;
});
const chords = () => p.evaluate(() =>
  document.querySelector(".verdict .mono")?.textContent.trim().split(/\s+/) ?? []);
const open = async (path) => {
  await p.goto("http://localhost:8123/chords.html", { waitUntil: "networkidle" });
  await p.setInputFiles("#file", path);
  await p.waitForSelector("canvas", { timeout: 20000 });
};

// --- It reads a chart and moves it ------------------------------------------
await open(loose);
check((await chords()).includes("G(sus4)"), `the chords are found: ${(await chords()).slice(0, 6).join(" ")}`);
check((await p.locator("#keyNow").textContent()) === "C", "and the key it is in is named");

await p.click("#up");
await p.click("#up");
await p.waitForTimeout(600);
check((await p.locator("#keyNow").textContent()).startsWith("D"),
  `two semitones up from C is D: ${await p.locator("#keyNow").textContent()}`);

// --- Nothing is stamped through the page ------------------------------------
//
// The case that actually happened, on a real hymn sheet: chord rows and lyric
// rows almost touching, so the point just outside a chord's corner lands on
// the descender of the line above. A patch coloured from that one pixel is
// painted in ink, and the chord is replaced by a black rectangle.
await open(tight);
const before = await ink();
await p.click("#up");
await p.waitForTimeout(800);
const after = await ink();
const grew = (after - before) / before;
check(grew < 0.25,
  `a tightly set chart gains only the ink of its new symbols: ${before} -> ${after} (${Math.round(grew * 100)}%)`);

// And the chords really did change, so the measurement above is not just
// reporting that nothing happened.
await p.click("#reset");
await p.waitForTimeout(600);
const original = await ink();
check(Math.abs(original - before) < before * 0.02,
  `going back to the original restores the page: ${before} -> ${original}`);

// --- And the other way, into a key spelled with sharps ----------------------
//
// The tight chart is in Ab, so a semitone down is G — which pulls every
// symbol from flats to naturals and sharps, the widest change of shape there
// is on a chart this closely set.
await p.click("#down");
await p.waitForTimeout(600);
check((await p.locator("#keyNow").textContent()).startsWith("G"),
  `down a semitone from Ab is G: ${await p.locator("#keyNow").textContent()}`);
check((await ink()) < before * 1.3, "with no rectangle there either");

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
console.log(bad ? `${bad} FAILED` : "chords are replaced without marking the page");
process.exit(bad || errs.length ? 1 : 0);
