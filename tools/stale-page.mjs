// An index.html a version behind the app.js beside it.
//
// This is a real state a device gets into, not a hypothetical. GitHub Pages
// sends a ten-minute max-age and there is no build step here to fingerprint
// filenames with, so a browser tab opened just after a deploy can hold the old
// page and the new script together. It used to be fatal: the bindings ran as
// `el.thing.addEventListener(...)` straight down the file, so one element the
// page did not have threw at the top level and took the whole module with it.
// Not the button — the gesture, the page turns, the chooser, all of it, with
// nothing on screen to say why.
//
// The page is built here by deleting elements from the real index.html rather
// than by checking out an old one, so this keeps testing the live file as it
// grows new elements.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { extname } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const app = join(here, "..");

// A copy of the app with some elements cut out of its page.
const dir = mkdtempSync(join(tmpdir(), "autopage-stale-"));
for (const f of ["app.js", "style.css", "qr.js", "manifest.json", "icon.svg", "index.html"]) {
  cpSync(join(app, f), join(dir, f));
}
cpSync(join(app, "vendor"), join(dir, "vendor"), { recursive: true });
cpSync(join(app, "fixtures"), join(dir, "fixtures"), { recursive: true });

// Whatever the newest additions to the page are. Deleting the most recently
// added ones is what an old page actually looks like.
const CUT = ["driveBtn", "panelDriveBtn", "driveStatus"];
let html = readFileSync(join(dir, "index.html"), "utf8");
for (const id of CUT) {
  const before = html;
  html = html.replace(new RegExp(`<([a-z]+)[^>]*\\bid="${id}"[\\s\\S]*?</\\1>`), "");
  if (html === before) throw new Error(`could not cut ${id} out of index.html`);
}
writeFileSync(join(dir, "index.html"), html);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".wasm": "application/wasm", ".task": "application/octet-stream", ".binarypb": "application/octet-stream" };
const server = createServer((req, res) => {
  const path = join(dir, decodeURIComponent(req.url.split("?")[0]));
  try {
    const body = readFileSync(path);
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("no");
  }
});
await new Promise((r) => server.listen(8126, r));

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
const p = await (await b.newContext({ viewport: { width: 834, height: 1194 } })).newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

await p.goto("http://localhost:8126/index.html", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);

check(errs.length === 0, `an older page throws nothing: ${JSON.stringify(errs)}`);
check(await p.evaluate(() => !!window.__autopage), "the app is still there at all");

const missing = await p.evaluate(() => window.__autopage?.missingEls ?? []);
check(CUT.every((id) => missing.includes(id)), `and knows what the page was missing: ${missing.join(", ")}`);

check(
  (await p.evaluate(() => {
    const e = document.getElementById("scoreError");
    return e.hidden ? "" : e.textContent;
  })).includes("out of date"),
  "it says the page is out of date rather than leaving a dead screen"
);

// The point of all of it: the thing the app is for still works.
await p.setInputFiles("#fileInput", join(app, "fixtures", "menuet-in-g.pdf"));
await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });
check(true, "a score still opens");

await p.keyboard.press("ArrowRight");
await p.waitForTimeout(400);
check((await p.evaluate(() => window.__autopage.state.page)) === 2, "and the pages still turn");

// The missing button is the only thing that is missing.
check(await p.locator("#fileInput").count() === 1 && (await p.locator("#driveBtn").count()) === 0,
  "a button the page does not have costs you that button, and nothing else");

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
server.close();
console.log(bad ? `${bad} FAILED` : "an out-of-date page still plays");
process.exit(bad || errs.length ? 1 : 0);
