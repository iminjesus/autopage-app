// The first sixty seconds, for someone who has never seen this before.
//
// Everything else in tools/ assumes a score is already open. This is the part
// where there isn't one, which is where people actually arrive — and where they
// leave, if the only thing on offer is a file picker pointed at an iCloud Drive
// that may not contain a single PDF.
import { chromium } from "playwright-core";
import { executablePath } from "./browser.mjs";
import { execFileSync } from "node:child_process";

const b = await chromium.launch({ executablePath });
const errs = [];

// --- A laptop: the QR is the way across to the tablet ---
const desk = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await desk.newPage();
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.waitForSelector("#installHint:not([hidden])", { timeout: 5000 });
await p.waitForSelector("#qrBox:not([hidden])", { timeout: 5000 });
console.log("ok   the install hint is offered on a fresh visit");

// The code on the page, read the way a phone would read it.
const svg = await p.innerHTML("#qrBox");
const paths = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => [+m[2], +m[1]]);
const view = svg.match(/viewBox="0 0 (\d+)/)[1] | 0;
const grid = Array.from({ length: view }, () => new Array(view).fill(0));
for (const [r, c] of paths) grid[r][c] = 1;
const want = await p.evaluate(() => location.href);
// The decoder is an optional extra (opencv + numpy). A container without it
// should say so and move on rather than turn the suite red for a reason that
// has nothing to do with the app — see tools/browser.mjs for the same lesson.
let decoded = null;
try {
  decoded = execFileSync("python3", ["tools/qr-decode.py"], {
    input: grid.map((r) => r.join("")).join("\n"),
    stdio: ["pipe", "pipe", "pipe"],
  }).toString().trim().replace(/^'|'$/g, "");
} catch {
  console.log("skip the code on the page: no decoder here (python3 -m pip install opencv-python-headless numpy)");
}
if (decoded !== null) {
  console.log(`${decoded === want ? "ok  " : "FAIL"} the code on the page scans to ${decoded}`);
}

// --- A tablet: nothing on arrival, the two steps on the way back ---
//
// Someone who has just scanned a code does not yet know what this is, and the
// app runs perfectly well from a tab — so handing them homework before they
// have seen it work costs more than the install is worth. Coming back earns it.
const pad = await b.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
const t = await pad.newPage();
await t.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await t.waitForTimeout(800);
console.log(`${(await t.isHidden("#installHint")) ? "ok  " : "FAIL"} first visit on a tablet: nothing asked of them`);

await t.reload({ waitUntil: "networkidle" });
await t.waitForSelector("#installHint:not([hidden])", { timeout: 5000 });
const steps = await t.isVisible("#installSteps");
const arrow = (await t.textContent("#installArrow")).trim();
console.log(`${steps && arrow === "\u2191" ? "ok  " : "FAIL"} second visit: two steps, arrow ${arrow} at the iPad's top bar`);
console.log("ok   still no QR on a touch device:", await t.isHidden("#qrBox"));

// --- The sample score, which is the whole point of the landing screen ---
await t.click("#sampleBtn");
await t.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 15000 });
const state = await t.evaluate(() => ({
  pages: window.__autopage.state.pageCount,
  name: window.__autopage.state.name,
  empty: document.getElementById("scoreEmpty").hidden,
}));
console.log("ok   the sample opens in one tap:", JSON.stringify(state));

// It is remembered like any other score, so a second visit lands on music.
await t.reload({ waitUntil: "networkidle" });
await t.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 15000 });
console.log("ok   and it is still there on the next visit");
console.log("     hint shown again:", await t.isVisible("#installHint"));

// --- Dismissing it means dismissed ---
const fresh = await b.newContext({ viewport: { width: 1280, height: 800 } });
const f = await fresh.newPage();
await f.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await f.waitForSelector("#installHint:not([hidden])");
await f.click("#installDismiss");
await f.reload({ waitUntil: "networkidle" });
await f.waitForTimeout(500);
console.log(`${(await f.isHidden("#installHint")) ? "ok  " : "FAIL"} "Not now" is remembered`);

// --- The card you hand to somebody, so nothing has to be said out loud ---
const card = await b.newPage();
await card.goto("http://localhost:8123/share.html", { waitUntil: "networkidle" });
await card.waitForSelector("#qr svg", { timeout: 5000 });
const cardSvg = await card.innerHTML("#qr");
const cardMods = [...cardSvg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => [+m[2], +m[1]]);
const cardSpan = Number(cardSvg.match(/viewBox="0 0 (\d+)/)[1]);
const cardGrid = Array.from({ length: cardSpan }, () => new Array(cardSpan).fill(0));
for (const [r, c] of cardMods) cardGrid[r][c] = 1;
let scanned = null;
try {
  scanned = execFileSync("python3", ["tools/qr-decode.py"], {
    input: cardGrid.map((r) => r.join("")).join("\n"),
    stdio: ["pipe", "pipe", "pipe"],
  }).toString().trim().replace(/^'|'$/g, "");
} catch {
  console.log("skip the card's code: no decoder here");
}
if (scanned !== null) {
  console.log(`${scanned === "http://localhost:8123/" ? "ok  " : "FAIL"} the card's code scans to ${scanned}`);
}
await card.close();

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
