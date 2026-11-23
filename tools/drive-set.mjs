// Opening a Sunday out of Google Drive.
//
// The sign-in itself cannot be exercised here — it needs a real Google account
// in a real browser — so Google's two scripts are served as stubs and the Drive
// REST calls are answered by this file. Everything on *our* side is the real
// thing: the scripts are really loaded on demand, the picker's answer really
// goes through folder listing, download, hashing, the store and the chooser.
//
// What this is mainly guarding is the part that is easy to get wrong and
// invisible when it is: that a Sunday from Drive lands as a *set*, named after
// the folder it came from, and that the app still opens with no network when
// nobody has asked for Drive at all.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "autopage-drive-"));
const bytesOf = (name) => {
  const path = join(dir, `${name}.pdf`);
  execFileSync("python3", [`${here}make-test-pdf.py`, name, path]);
  return readFileSync(path);
};

const LIBRARY = {
  "f-build": { name: "01 Build My Life.pdf", body: bytesOf("Build") },
  "f-good": { name: "02 Goodness of God.pdf", body: bytesOf("Goodness") },
  "f-king": { name: "03 King of Kings.pdf", body: bytesOf("King") },
  "f-doxo": { name: "04 Doxology.pdf", body: bytesOf("Doxology") },
};

const GSI_STUB = `
  window.google = window.google || {};
  window.google.accounts = { oauth2: { initTokenClient: (cfg) => ({
    requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: "test-token" }), 0),
  }) } };
  window.__gsiLoads = (window.__gsiLoads || 0) + 1;
`;

const GAPI_STUB = `
  window.gapi = { load: (_name, arg) => {
    window.google = window.google || {};
    window.google.picker = {
      ViewId: { DOCS: "docs" },
      Action: { PICKED: "picked", CANCEL: "cancel" },
      Feature: { MULTISELECT_ENABLED: "multi" },
      DocsView: function () {
        // Cleared here, where a view is built, and not in the builder — the
        // builder is constructed after setParent has already been called.
        window.__openedAt = null;
        this.setMimeTypes = () => this;
        this.setIncludeFolders = () => this;
        this.setSelectFolderEnabled = (on) => { window.__folderPicking = on; return this; };
        this.setParent = (id) => { window.__openedAt = id; return this; };
      },
      PickerBuilder: function () {
        let cb;
        this.setDeveloperKey = () => this;
        this.setOAuthToken = (t) => { window.__sawToken = t; return this; };
        this.setAppId = (a) => { window.__sawAppId = a; return this; };
        this.addView = () => this;
        this.enableFeature = () => this;
        this.setCallback = (f) => { cb = f; return this; };
        this.setTitle = (t) => { window.__sawTitle = t; return this; };
        this.build = () => ({ setVisible: () => setTimeout(() => {
          // A queue, because choosing a folder opens the picker again and the
          // second opening has to be able to answer differently.
          const queued = (window.__answers && window.__answers.length)
            ? window.__answers.shift()
            : window.__answer;
          (window.__opened = window.__opened || []).push(window.__openedAt ?? null);
          cb(queued);
        }, 0) });
      },
    };
    (arg && arg.callback ? arg.callback : arg)();
  } };
  window.__gapiLoads = (window.__gapiLoads || 0) + 1;
`;

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
const ctx = await b.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

// Google's side of the wire, in full.
const hits = [];
let listingAnswer = { status: 200, files: [] };
// What Drive will say about each folder. A folder missing from here is one it
// refuses to describe, which is the case the app has to survive.
let FOLDERS = {};

await p.route("**://accounts.google.com/gsi/client*", (r) => {
  hits.push("gsi");
  r.fulfill({ status: 200, contentType: "text/javascript", body: GSI_STUB });
});
await p.route("**://apis.google.com/js/api.js*", (r) => {
  hits.push("gapi");
  r.fulfill({ status: 200, contentType: "text/javascript", body: GAPI_STUB });
});
await p.route("**://www.googleapis.com/drive/v3/files**", (r) => {
  const url = new URL(r.request().url());
  const media = url.searchParams.get("alt") === "media";
  if (media) {
    const id = url.pathname.split("/").pop();
    hits.push(`get:${id}`);
    const file = LIBRARY[id];
    if (!file) return r.fulfill({ status: 404, body: "no" });
    return r.fulfill({ status: 200, contentType: "application/pdf", body: file.body });
  }
  const single = url.pathname.match(/\/files\/([^/]+)$/);
  if (single) {
    const id = single[1];
    hits.push(`meta:${id}`);
    const known = FOLDERS[id];
    if (!known) {
      return r.fulfill({ status: 403, contentType: "application/json", body: '{"error":{"message":"no"}}' });
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(known) });
  }
  hits.push("list");
  if (listingAnswer.status !== 200) {
    return r.fulfill({ status: listingAnswer.status, contentType: "application/json", body: '{"error":{"message":"no"}}' });
  }
  r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ files: listingAnswer.files.map((id) => ({ id, name: LIBRARY[id].name })) }),
  });
});

const groups = () =>
  p.evaluate(() =>
    [...document.querySelectorAll("#recent > .recent-head")].map((head) => ({
      name: head.firstChild.textContent,
      scores: [...(head.nextElementSibling?.querySelectorAll(".recent-item") ?? [])]
        .map((n) => n.title.replace(".pdf", "")),
    }))
  );
const errorText = () => p.evaluate(() => {
  const note = document.getElementById("driveToast");
  if (note && !note.hidden) return note.textContent;
  const e = document.getElementById("scoreError");
  return e.hidden ? "" : e.textContent;
});
const answer = (docs) => p.evaluate((d) => {
  window.__answer = { action: "picked", docs: d };
  window.__answers = [];
}, docs);

/** Successive answers, for a run that goes into a folder before picking. */
const answerEach = (steps) => p.evaluate((list) => {
  window.__answers = list.map((docs) => ({ action: "picked", docs }));
  window.__answer = { action: "cancel" };
  window.__opened = [];
}, steps);

/**
 * Ask for Drive the way somebody would, from wherever they are.
 *
 * With a score open the first screen is gone, so the way in is the one in the
 * Setup panel — the same reason the chooser is in both places.
 */
const askForDrive = async () => {
  if (await p.locator("#driveBtn").isVisible()) return p.locator("#driveBtn").click();
  if (await p.evaluate(() => document.getElementById("setupPanel").classList.contains("collapsed"))) {
    await p.click("#setupToggle");
  }
  await p.locator("#panelDriveBtn").click();
};
const pdf = (id, parentId) => ({ id, name: LIBRARY[id].name, mimeType: "application/pdf", parentId });
const folder = (id, name) => ({ id, name, mimeType: "application/vnd.google-apps.folder" });

// Folder names here are deliberately not dates. A folder called "Nov 23" is
// exactly what a church would have, and it is also what the app calls a set it
// had to name itself — so on one day a year the test would have been checking
// that it had found the wrong group.

await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });

// --- The offline promise is not quietly broken -----------------------------
//
// Two scripts from a third party in the startup path would undo the whole
// point of the app: on a dead wifi they do not fail, they hang.
await p.waitForTimeout(600);
check(hits.length === 0, `nothing is asked of Google until somebody asks for Drive (${JSON.stringify(hits)})`);
check(await p.locator("#driveBtn").isVisible(), "the way in is on the first screen");

// --- Picking the songs themselves ------------------------------------------
await answer([pdf("f-king"), pdf("f-build"), pdf("f-good")]);
await askForDrive();
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 30000 });
await p.waitForFunction(
  () => document.querySelectorAll("#recent .recent-item").length >= 3, null, { timeout: 30000 }
);
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });

check(hits.includes("gsi") && hits.includes("gapi"), "Google's scripts are fetched, once Drive is asked for");

// Fetched on the way down of the tap, so that the sign-in window is opened
// while the browser still counts the tap as happening. Safari stops counting
// after an await that goes to the network, and a blocked window looks exactly
// like a button that does nothing.
const order = hits.indexOf("gsi");
check(order >= 0 && order < hits.findIndex((h) => h.startsWith("get:")),
  "and before anything is asked of Drive itself");
check((await p.evaluate(() => window.__sawToken)) === "test-token", "the picker is handed the signed-in token");
check((await p.evaluate(() => window.__sawAppId)) === "239071426944",
  `and the project number, so drive.file can hand files over: ${await p.evaluate(() => window.__sawAppId)}`);

let g = await groups();
check(g.length === 1 && g[0].scores.length === 3,
  `three songs from Drive are one set: ${JSON.stringify(g.map((x) => [x.name, x.scores.length]))}`);
check(g[0].scores.join(" | ") === "01 Build My Life | 02 Goodness of God | 03 King of Kings",
  `in numbered order, not the order Drive listed them: ${g[0].scores.join(" | ")}`);
check(g[0].name === new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" }),
  `named for the day, there being no folder to name it after: "${g[0].name}"`);
check((await p.evaluate(() => window.__folderPicking)) === true,
  "folders stay selectable, because a folder that cannot be tapped cannot be entered either");
check((await p.evaluate(() => window.__sawTitle ?? "")).includes("then its songs"),
  `and the picker says what the folder is for: "${await p.evaluate(() => window.__sawTitle)}"`);
check((await p.evaluate(() => window.__autopage.state.name)) === "01 Build My Life.pdf",
  "and the first song is the one that opens");
check(["f-build", "f-good", "f-king"].every((id) => hits.includes(`get:${id}`)),
  "every song was actually downloaded");

// Downloaded once, then it belongs to the device.
//
// This is the part that matters in a service: the wifi can go away and the
// songs are still there, because they went into the same store as a score
// opened off the iPad.
const storedNow = hits.filter((h) => h.startsWith("get:")).length;
await p.reload({ waitUntil: "networkidle" });
await p.waitForFunction(() => window.__autopage.state.pageCount > 0, { timeout: 30000 });
check(hits.filter((h) => h.startsWith("get:")).length === storedNow,
  "reopening asks Drive for nothing — the songs are on the device now");

// --- Songs out of one Sunday's folder --------------------------------------
//
// The path that actually works. The folder cannot be selected, so the player
// goes into it and picks the songs — and the set is still named for the
// Sunday, because the one thing worth asking Drive about the folder is what it
// is called.
FOLDERS = { "dir-nov29": { name: "Nov 29", parents: ["dir-worship"] }, "dir-worship": { id: "dir-worship" } };
await p.evaluate(() => { window.__simClock = 0; });
await answer([pdf("f-doxo", "dir-nov29"), pdf("f-build", "dir-nov29")]);
await askForDrive();
await p.waitForFunction(
  () => [...document.querySelectorAll("#recent > .recent-head")]
    .some((h) => h.firstChild.textContent === "Nov 29"),
  null, { timeout: 30000 }
);
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
const nov29 = (await groups()).find((x) => x.name === "Nov 29");
check(nov29?.scores.length === 2,
  `songs picked out of one folder are that folder's set (${nov29?.scores.length ?? 0})`);
check(hits.includes("meta:dir-nov29"), "which took one question about the folder, and no listing of it");

// Next week's folder appears beside this one, so that is where the picker
// should start — the hunt through a shared drive is the part that is annoying
// every single week.
check((await p.evaluate(() => localStorage.getItem("autopage-drive-root"))) === "dir-worship",
  "and the folder the Sundays live in is remembered for next time");

// And when Drive will not say what the folder is called, the day does.
FOLDERS = { "dir-worship": { id: "dir-worship" } };
await p.evaluate(() => { window.__autopage.state.page = 1; });
await answer([pdf("f-king", "dir-quiet"), pdf("f-good", "dir-quiet")]);
await askForDrive();
await p.waitForTimeout(3000);
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
const today = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" });
check((await groups()).some((x) => x.name === today || x.name.startsWith(today)),
  `a folder Drive will not name falls back to the day: ${JSON.stringify((await groups()).map((x) => x.name))}`);
check((await p.evaluate(() => window.__openedAt)) === "dir-worship",
  `and this time the picker opened in the shared folder: ${await p.evaluate(() => window.__openedAt)}`);

// A remembered folder that has been moved, renamed away or unshared must not
// leave the picker opening on an empty view with no way to tell why.
FOLDERS = {};
await p.evaluate(() => { window.__autopage.state.page = 1; });
await answer([pdf("f-build", "dir-gone")]);
await askForDrive();
await p.waitForTimeout(3000);
check((await p.evaluate(() => window.__openedAt)) === null,
  "a folder that is no longer reachable is not used as the picker's starting point");
check((await p.evaluate(() => localStorage.getItem("autopage-drive-root"))) === null,
  "and is forgotten rather than retried every week");

// --- Choosing a folder means "go in there" ---------------------------------
//
// The whole point. drive.file will not list a folder, but Google's own picker
// will happily show it — so a chosen folder reopens the picker inside it, and
// the player picks the songs there. Folders stay selectable because a folder
// that cannot be tapped cannot be entered either: the picker only walks into
// an unselectable folder on a double tap, which on a phone is nothing at all.
FOLDERS = { "dir-dec6": { name: "Dec 6", parents: ["dir-worship"] }, "dir-worship": { id: "dir-worship" } };
await p.evaluate(() => { window.__autopage.state.page = 1; });
await answerEach([
  [folder("dir-dec6", "Dec 6")],                           // tapped the folder
  [pdf("f-king", "dir-dec6"), pdf("f-doxo", "dir-dec6")],  // then its songs
]);
await askForDrive();
await p.waitForFunction(
  () => [...document.querySelectorAll("#recent > .recent-head")]
    .some((h) => h.firstChild.textContent === "Dec 6"),
  null, { timeout: 30000 }
);
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
const dec6 = (await groups()).find((x) => x.name === "Dec 6");
check(dec6?.scores.length === 2, `choosing a folder gets you into it (${dec6?.scores.length ?? 0} songs)`);
check((await p.evaluate(() => window.__opened))?.[1] === "dir-dec6",
  `and the second opening was inside that folder: ${JSON.stringify(await p.evaluate(() => window.__opened))}`);

// --- Several folders at once is not a direction -----------------------------
//
// Going into one folder is an instruction. Going into three is not, and
// drive.file will not list any of them, so say what to do rather than guess.
FOLDERS = {};
await p.evaluate(() => { window.__autopage.state.page = 1; });
await answer([folder("dir-a", "Nov 1"), folder("dir-b", "Nov 8")]);
await askForDrive();
await p.waitForFunction(() => {
  const t = document.getElementById("driveToast");
  return t && !t.hidden && t.textContent.includes("one folder at a time");
}, null, { timeout: 30000 });
const said = await errorText();
check(said.includes("select the songs inside it"), `it says what to do instead: "${said}"`);

// And says it where it can be read. With a score open the first screen is
// gone, so a message written only there is the same as no message at all —
// which is exactly how "I pressed Select and nothing happened" happens.
const note = p.locator("#driveToast");
check(await note.isVisible(),
  "the problem is visible over the score, whatever is open and whatever is collapsed");
check((await note.getAttribute("class")).includes("is-problem"),
  "and reads as a problem rather than as progress");
check(!(await groups()).some((x) => x.name === "Nov 1"), "and no empty Sunday is left behind");

// Not once, in any of it.
//
// Listing a folder is the single thing drive.file refuses, and the whole
// design is arranged around never needing to: Google's own picker shows the
// player what is in there, which never needed permission at all.
check(!hits.includes("list"), `Drive is never asked to list a folder (${hits.filter((h) => h === "list").length})`);

// Cancelling is not a failure.
await p.evaluate(() => { window.__answer = { action: "cancel" }; });
await askForDrive();
await p.waitForTimeout(1200);
check(!(await errorText()), "backing out of the picker says nothing at all");

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
console.log(bad ? `${bad} FAILED` : "a Sunday comes out of Drive as a set");
process.exit(bad || errs.length ? 1 : 0);
