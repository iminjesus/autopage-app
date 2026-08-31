import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
         `--use-file-for-fake-audio-capture=${process.argv[3] || "/workspace/autopage-app/fixtures/menuet-in-g.wav"}%noloop`],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(e.message));

await page.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await page.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await page.waitForFunction(() => window.__autopage.state.measures.size === 4, { timeout: 20000 });

console.log("MEASURES:", JSON.stringify(await page.evaluate(() =>
  [...window.__autopage.state.measures.entries()])));
console.log("STATUS  :", await page.textContent("#setupStatus"));

const BPM = "n/a";
await page.fill("#leadInput", "1");  await page.dispatchEvent("#leadInput", "change");

const t0 = Date.now();
await page.click("#startBtn");
const turns = [];
let last = 1;
const poll = setInterval(async () => {
  try {
    const st = await page.evaluate(() => ({ p: window.__autopage.state.page, by: window.__autopage.state.turnedBy }));
    if (st.p !== last) { turns.push({ to: st.p, at: +((Date.now() - t0) / 1000).toFixed(1), by: st.by }); last = st.p; }
  } catch {}
}, 150);
await new Promise((r) => setTimeout(r, 40000));
clearInterval(poll);

console.log("TURNS   :", JSON.stringify(turns));
console.log(`BPM used : ${BPM} (true tempo is 120; music boundaries at 12/24/36s)`);

console.log("ERRORS  :", errors.length ? errors : "none");
await browser.close();
