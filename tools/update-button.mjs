// Can a home-screen app pick up a new version without being force quit?
//
// Installed to the home screen there is no address bar, so no reload button and
// no way to ask for one. The only route was the app switcher, which is obscure
// enough that in practice a new version simply never arrives.
//
// This serves the app from a directory it can edit between loads, so the
// "update" is a real one: change a file on the server, press the button, and
// see whether the running app is now the new one.
import { chromium } from "playwright-core";
import { executablePath } from "./browser.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".pdf": "application/pdf", ".png": "image/png",
  ".svg": "image/svg+xml", ".wasm": "application/wasm", ".task": "application/octet-stream",
};

let patchBuild = null; // when set, app.js is served with this build string
const server = createServer(async (req, res) => {
  const path = join(ROOT, normalize(decodeURI(req.url.split("?")[0])));
  try {
    let body = await readFile(path.endsWith("/") ? join(path, "index.html") : path);
    if (patchBuild && path.endsWith("app.js")) {
      body = Buffer.from(
        body.toString().replace(/const BUILD = "[^"]*";/, `const BUILD = "${patchBuild}";`)
      );
    }
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(8132, r));

const b = await chromium.launch({ executablePath });
// No address bar and no reload affordance of its own, the way the home screen
// runs it.
const ctx = await b.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
const p = await ctx.newPage();

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

await p.goto("http://localhost:8132/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", `${ROOT}fixtures/menuet-in-g.pdf`);
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
const buildOf = () => p.evaluate(() => (document.getElementById("diag").textContent.match(/build (\S+)/) || [])[1]);
const before = await buildOf();
console.log(`     running build ${before}`);

// Ship a new version while it is open.
patchBuild = "test-build-2";

await p.evaluate(() => { document.getElementById("setupPanel").classList.remove("collapsed"); });
check(await p.locator("#reloadBtn").isVisible(), "the update button is there to press");

await Promise.all([
  p.waitForNavigation({ waitUntil: "load", timeout: 30000 }),
  p.click("#reloadBtn"),
]);
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 20000 });
const after = await buildOf();
check(after === "test-build-2", `after pressing it, the running build is ${after} (was ${before})`);

// And the score it was on is still there — an update must not cost the session.
const state = await p.evaluate(() => ({ page: window.__autopage.state.page, pages: window.__autopage.state.pageCount }));
check(state.pages === 4, `the score survived the update: ${JSON.stringify(state)}`);

await b.close();
server.close();
console.log(bad ? `${bad} FAILED` : "a new version arrives without force quitting");
process.exit(bad ? 1 : 0);
