import { chromium } from "playwright-core";

const b = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
p.on("console", (m) => { if (m.type() === "error" && !m.text().includes("XNNPACK")) errs.push(m.text()); });

await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });

// The camera has to come up with nothing switched on and nothing pressed.
await p.waitForFunction(() => window.__autopage.state, { timeout: 20000 });
await p.waitForFunction(() => !document.getElementById("holdField").hidden, { timeout: 60000 });
console.log("camera started unattended :", true);

await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.measures.size === 4);
await p.waitForTimeout(1500);

const vis = (sel) => p.locator(sel).isVisible();
const overlays = await p.evaluate(() =>
  [...document.querySelectorAll("main.app > *")]
    .filter((n) => n.offsetParent !== null && !n.classList.contains("score"))
    .map((n) => n.id || n.className)
);
console.log("idle: over the score      :", JSON.stringify(overlays));
console.log("idle: panel body open     :", await vis(".panel-body"));
console.log("idle: camera card shown   :", await vis("#watch"));
await p.screenshot({ path: "/tmp/quiet-idle.png" });

// Turning still works, and still says where each turn came from.
await p.keyboard.press("ArrowRight");
await p.waitForTimeout(300);
console.log("turn log                  :", JSON.stringify(await p.evaluate(() => window.__autopage.state.turnLog)));

// Calibration is only on screen once it is asked for.
await p.click("#setupToggle");
await p.waitForTimeout(200);
await p.click("#calibrateBtn");
await p.waitForTimeout(800);
console.log("calibrating: card shown   :", await vis("#watch"), "| preview:", await vis("#camPreview"));
console.log("calibrating: prompt       :", JSON.stringify((await p.textContent("#gestureStatus")).slice(0, 40)));
await p.screenshot({ path: "/tmp/quiet-calib.png" });

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
