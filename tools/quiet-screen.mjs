import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"] });
const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.measures.size === 4);
await p.waitForTimeout(2500);

const vis = async (sel) => await p.locator(sel).isVisible();
console.log("idle: watch card visible:", await vis("#watch"),
            "| panel body visible:", await vis(".panel-body"),
            "| live numbers visible:", await vis("#gestureAsym"));
await p.screenshot({ path: "/tmp/quiet-idle.png" });

await p.click("#setupToggle");            // open the panel
await p.waitForTimeout(200);
await p.click("#calibrateBtn");
await p.waitForTimeout(800);
console.log("calibrating: watch card visible:", await vis("#watch"),
            "| preview visible:", await vis("#camPreview"),
            "| prompt:", JSON.stringify((await p.textContent("#gestureStatus")).slice(0, 40)));
await p.screenshot({ path: "/tmp/quiet-calib.png" });
console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
