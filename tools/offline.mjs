// Does it work in a room with no signal?
//
// That is a normal place to open a score, so this is a requirement rather than
// a nicety — and it is the one thing reading the code cannot establish, because
// it depends on a service worker, two caches, and a 13MB model that is fetched
// separately and easy to end up without.
//
// Four conditions, in the order they bite:
//   1. a cold visit that only looks — must not have paid for the model
//   2. opening a score — must pull everything down and say so
//   3. no network at all — the plane-mode case
//   4. a network that hangs — the rehearsal-room wifi that no longer routes.
//      This is the worse one, because fetch() neither succeeds nor fails, and a
//      plain network-first worker waits on it with a blank screen.
//
// It serves the app itself rather than borrowing the dev server, because
// condition 4 needs a server that can be told to stop answering — and mocking
// it in the browser would intercept the requests before the service worker ever
// saw them, which is precisely the thing under test.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".pdf": "application/pdf",
  ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm",
  ".task": "application/octet-stream",
};

let mode = "normal"; // "normal" | "hang"
const server = createServer(async (req, res) => {
  if (mode === "hang") return; // connected, and going nowhere
  const path = join(ROOT, normalize(decodeURI(req.url.split("?")[0])));
  try {
    const body = await readFile(path.endsWith("/") ? join(path, "index.html") : path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(8131, r));
const URL_BASE = "http://localhost:8131";

const b = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

const bytesOf = (page) => {
  let total = 0;
  page.on("response", async (r) => {
    try { total += (await r.body()).length; } catch {}
  });
  return () => total / 1e6;
};

let bad = 0;
const check = (ok, line) => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
};

// --- 1. A cold visit that only looks -----------------------------------------
const browsing = await b.newContext();
const look = await browsing.newPage();
const looked = bytesOf(look);
await look.goto(`${URL_BASE}/index.html`, { waitUntil: "networkidle" });
await look.waitForTimeout(4000);
check(looked() < 2, `the landing screen alone costs ${looked().toFixed(2)} MB (want under 2)`);
await browsing.close();

// --- 2. Opening a score pulls everything down and says so --------------------
const ctx = await b.newContext();
const p = await ctx.newPage();
const got = bytesOf(p);
await p.goto(`${URL_BASE}/index.html`, { waitUntil: "networkidle" });
await p.click("#sampleBtn");
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
await p.waitForFunction(() => window.__autopage.ready === true, { timeout: 90000 });
console.log(`ok   opening a score fetched ${got().toFixed(2)} MB and the gesture is live`);

await p.waitForFunction(
  () => document.getElementById("offlineState").textContent.startsWith("Ready offline"),
  { timeout: 30000 }
);
check(true, `it reports: "${(await p.textContent("#offlineState")).slice(0, 52)}…"`);

await p.keyboard.press("ArrowRight");
await p.waitForTimeout(700);

// --- 3. Plane mode -----------------------------------------------------------
await ctx.setOffline(true);
await p.reload({ waitUntil: "load" });
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
await p.waitForFunction(() => window.__autopage.ready === true, { timeout: 60000 });
const offline = await p.evaluate(() => ({
  page: window.__autopage.state.page,
  pages: window.__autopage.state.pageCount,
  camera: window.__autopage.ready,
}));
check(offline.pages === 4 && offline.page === 2 && offline.camera,
  `network off: the score is back on the page it was left on — ${JSON.stringify(offline)}`);

// Loaded is not the same as working: make it actually decide.
const turned = await p.evaluate(() => {
  const A = window.__autopage;
  A.setMode("wink");
  const before = A.state.page;
  const pt = (x, y) => ({ x, y, z: 0 });
  const face = (gapL, gapR) => {
    const m = [];
    m[10] = pt(0.5, 0.2); m[152] = pt(0.5, 0.5); m[1] = pt(0.5, 0.36);
    m[386] = pt(0.56, 0.32 - gapL / 2); m[374] = pt(0.56, 0.32 + gapL / 2);
    m[159] = pt(0.44, 0.32 - gapR / 2); m[145] = pt(0.44, 0.32 + gapR / 2);
    m[33] = pt(0.42, 0.32); m[263] = pt(0.58, 0.32);
    return m;
  };
  const shapes = [{ categoryName: "eyeBlinkLeft", score: 0 }, { categoryName: "eyeBlinkRight", score: 0 }];
  for (let t = 0; t < 8; t++) A.processFrame(face(0.015, 0.015), shapes);
  for (let t = 0; t < 20; t++) A.processFrame(face(0.015, 0.001), shapes);
  return { before, after: A.state.page };
});
check(turned.after > turned.before, `a wink still turns the page offline: ${turned.before}->${turned.after}`);

// --- 4. A wifi that never answers --------------------------------------------
await ctx.setOffline(false);
mode = "hang";
const started = Date.now();
await p.reload({ waitUntil: "commit" });
await p.waitForFunction(() => window.__autopage?.state.pageCount > 0, { timeout: 30000 });
const secs = (Date.now() - started) / 1000;
check(secs < 15, `wifi connected but answering nothing: score up in ${secs.toFixed(1)}s (want under 15)`);

await b.close();
server.close();
console.log(bad ? `${bad} FAILED` : "offline holds up in every condition");
process.exit(bad ? 1 : 0);
