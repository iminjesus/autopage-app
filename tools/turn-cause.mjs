import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.templates.size >= 3);

await p.keyboard.press("ArrowRight");          // page 1 -> 2, by key
await p.waitForTimeout(300);
await p.mouse.click(40, 400);                  // left tap zone, page 2 -> 1
await p.waitForTimeout(300);
await p.keyboard.press("PageDown");            // 1 -> 2, by key
await p.waitForTimeout(300);

console.log("turn log :", JSON.stringify(await p.evaluate(() => window.__autopage.state.turnLog)));
console.log("diag     :", (await p.textContent("#diag")).split("\n").pop());
console.log("hud mode :", await p.textContent("#hudMode"));
await b.close();
