import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.pageCount > 0);

await p.keyboard.press("ArrowRight");          // page 1 -> 2, by key
await p.waitForTimeout(300);
await p.mouse.click(40, 400);                  // left tap zone, page 2 -> 1
await p.waitForTimeout(300);
await p.keyboard.press("PageDown");            // 1 -> 2, by key
await p.waitForTimeout(300);

console.log("turn log :", JSON.stringify(await p.evaluate(() => window.__autopage.state.turnLog)));
console.log("diag     :", (await p.textContent("#diag")).split("\n").pop());
// The HUD is gone — nothing sits over the score now but the score. What is
// worth checking in its place is that the gesture the panel describes is the
// gesture the app is in.
console.log("help     :", (await p.textContent("#gestureHelp")).split("\n")[0].trim());
// Clicked rather than checked: the control only unhides once a camera has
// started, and this run has no camera at all.
await p.evaluate(() => {
  const box = document.getElementById("modeInput");
  box.checked = true;
  box.dispatchEvent(new Event("change"));
});
console.log("help     :", (await p.textContent("#gestureHelp")).split("\n")[0].trim());
await b.close();
