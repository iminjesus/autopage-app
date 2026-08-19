import { chromium } from "playwright-core";

const AUDIO = "/tmp/two-pass.wav";
const PASS = 49.0;          // seconds of one pass through the piece
const MARKS = [12, 24, 36]; // where the rehearsal taps land, in pass time

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${AUDIO}%noloop`,
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(e.message));

await page.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await page.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await page.waitForFunction(() => document.getElementById("hudPage").textContent === "1 / 4");

const t0 = Date.now();
const at = (s) => new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - Date.now())));

// ---- rehearsal pass ----
await page.click("#rehearseBtn");
for (const m of MARKS) {
  await at(m);
  await page.click("#markBtn");
}
const rehearsed = await page.evaluate(() => ({
  templates: [...window.__autopage.state.templates.keys()],
  durations: [...window.__autopage.state.pageDurations.entries()].map(([k, v]) => [k, +v.toFixed(1)]),
  status: document.getElementById("setupStatus").textContent,
}));

// ---- performance pass: starts when the second copy begins ----
await at(PASS + 2.0);
await page.click("#performBtn");
const perfStart = Date.now();

const turns = [];
let last = 1;
const poll = setInterval(async () => {
  try {
    const s = await page.evaluate(() => ({
      p: window.__autopage.state.page,
      c: +window.__autopage.state.confidence.toFixed(2),
      a: window.__autopage.state.armed,
    }));
    if (s.p !== last) {
      turns.push({ to: s.p, at: +((Date.now() - perfStart) / 1000).toFixed(1), conf: s.c });
      last = s.p;
    }
  } catch {}
}, 200);

await new Promise((r) => setTimeout(r, 46000));
clearInterval(poll);

console.log("REHEARSED:", JSON.stringify(rehearsed));
console.log("TURNS    :", JSON.stringify(turns));
console.log("EXPECTED : turn to 2 near 12s, 3 near 24s, 4 near 36s");
console.log("FINAL    :", await page.textContent("#hudPage"), "|", await page.textContent("#setupStatus"));
console.log("ERRORS   :", errors.length ? errors : "none");
await browser.close();
