import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"] });
const p = await b.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
p.on("console", (m) => { if (m.type() === "error" && !m.text().includes("XNNPACK")) errs.push(m.text()); });
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.pageCount > 0);
// The camera starts itself now — there is no button to press. What this waits
// for is the frame loop having run at all, which is what the readout proves.
await p.waitForFunction(
  () => (document.getElementById("gestureAsym").textContent || "").length > 0,
  { timeout: 60000 }
);
await new Promise(r => setTimeout(r, 4000));
const text = await p.textContent("#gestureAsym");
console.log("readout after 4s of frames:", JSON.stringify(text));
console.log("contains 'Gesture error':", text.includes("Gesture error"));
console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
