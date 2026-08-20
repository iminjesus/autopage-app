import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await page.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await page.waitForFunction(() => window.__autopage.state.sonorities.size === 4, { timeout: 20000 });

const out = await page.evaluate(() => {
  const S = window.__autopage.state;
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const fmt = (son) => son.map((s) => [...s.pcs].sort((a,b)=>a-b).map((p) => names[p]).join("+"));
  return {
    measures: [...S.measures.values()],
    counts: [...S.sonorities.values()].map((v) => v.length),
    page1: fmt(S.sonorities.get(1)).slice(0, 14),
    page1tail: fmt(S.sonorities.get(1)).slice(-6),
    page4tail: fmt(S.sonorities.get(4)).slice(-6),
    page2first: fmt(S.sonorities.get(2)).slice(0, 8),
  };
});
console.log("measures     :", JSON.stringify(out.measures));
console.log("sonorities/pg:", JSON.stringify(out.counts));
console.log("page1 first14:", JSON.stringify(out.page1));
console.log("page1 last 6 :", JSON.stringify(out.page1tail));
console.log("page4 last 6 :", JSON.stringify(out.page4tail));
console.log("page2 first8 :", JSON.stringify(out.page2first));
console.log("errors:", errs.length ? errs : "none");
await browser.close();
