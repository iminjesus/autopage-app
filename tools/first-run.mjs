// The first sixty seconds, for someone who has never seen this before.
//
// Everything else in tools/ assumes a score is already open. This is the part
// where there isn't one, which is where people actually arrive — and where they
// leave, if the only thing on offer is a file picker pointed at an iCloud Drive
// that may not contain a single PDF.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
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
const decoded = execFileSync("python3", ["tools/qr-decode.py"], {
  input: grid.map((r) => r.join("")).join("\n"),
}).toString().trim().replace(/^'|'$/g, "");
const want = await p.evaluate(() => location.href);
console.log(`${decoded === want ? "ok  " : "FAIL"} the code on the page scans to ${decoded}`);

// --- A tablet: no QR, and the Add to Home Screen steps instead ---
const pad = await b.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
const t = await pad.newPage();
await t.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await t.waitForSelector("#installHint:not([hidden])", { timeout: 5000 });
console.log("ok   no QR on a touch device:", await t.isHidden("#qrBox"));

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

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
