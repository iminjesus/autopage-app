// Licences: what a church pays for, and what stays free.
//
// The thing being sold is used in a hall during a service, so the check has to
// work with no network at all — an expired licence may close a door, a flat
// wifi may not. That is why it is a signature the device can verify rather
// than a question asked of a server, and it is the property most worth
// guarding here.
//
// The signing key is made fresh for the test. There is none in the repository
// and there must not be: the private half is the only real secret in the app.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";
import { webcrypto } from "node:crypto";

const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");

const pair = await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
const publicKey = b64(await webcrypto.subtle.exportKey("raw", pair.publicKey));
const other = await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);

const mint = async (church, until, key = pair.privateKey) => {
  const payload = new TextEncoder().encode(JSON.stringify({ c: church, e: until }));
  const signature = await webcrypto.subtle.sign(SIGN, key, payload);
  return `AP1.${b64(payload)}.${b64(signature)}`;
};

const dateIn = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const good = await mint("Grace Chapel", dateIn(300));
const expired = await mint("Grace Chapel", dateIn(-1));
const forged = await mint("Grace Chapel", dateIn(300), other.privateKey);
const tampered = (() => {
  // Same signature, a different church in the payload.
  const parts = good.split(".");
  const body = JSON.stringify({ c: "Somebody Else", e: dateIn(300) });
  return `${parts[0]}.${b64(new TextEncoder().encode(body))}.${parts[2]}`;
})();

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
const ctx = await b.newContext({ viewport: { width: 834, height: 1194 } });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

const switchOn = () => p.evaluate((k) => window.__autopage.useLicenceKey(k), publicKey);
const held = () => p.evaluate(() => window.__autopage.licence);
const allowed = () => p.evaluate(() => window.__autopage.driveAllowed());
const toast = () => p.evaluate(() => {
  const t = document.getElementById("driveToast");
  return t && !t.hidden ? t.textContent : "";
});

await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });

// --- Off by default ---------------------------------------------------------
//
// A build with no public key in it behaves exactly as every build before this
// one did. Switching licensing on is a deliberate act, not a default.
check(await allowed(), "with no key configured, Drive is open to everybody");
check(await p.locator("#licenceRow").isHidden(), "and there is nothing about licences on screen");

// --- Switched on ------------------------------------------------------------
await switchOn();
check(!(await allowed()), "once licensing is on, Drive is closed until there is a licence");

// A score first: the Setup panel is reached from a score, and the panel is
// where a locked door can be explained.
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });

// It says so where the button is, rather than only answering back when the
// button is pressed.
await p.click("#setupToggle");
await p.waitForTimeout(300);
check(await p.locator("#licenceRow").isVisible(), "the panel says the door is locked");
check(await p.locator("#licenceKey").isVisible(), "and offers somewhere to put the key");
await p.click("#setupToggle");

// The gate has to say what is free, not just what is not.
await p.evaluate(() => { document.getElementById("scoreEmpty").hidden = false; });
await p.locator("#driveBtn").click();
await p.waitForFunction(() => {
  const t = document.getElementById("driveToast");
  return t && !t.hidden && t.textContent.includes("subscribe");
}, null, { timeout: 15000 });
check((await toast()).includes("stays free"), `the gate says what is still free: "${await toast()}"`);

// And the score that is already open keeps working, because none of that is
// what was being sold.
await p.keyboard.press("ArrowRight");
await p.waitForTimeout(300);
check((await p.evaluate(() => window.__autopage.state.page)) === 2,
  "and the page still turns, which was never the thing being charged for");

// --- A licence that is good -------------------------------------------------
let read = await p.evaluate((k) => window.__autopage.enterLicence(k), good);
check(read.ok && (await allowed()), "a signed licence opens Drive");
await p.click("#setupToggle");
await p.waitForTimeout(300);
check(await p.locator("#licenceKey").isHidden(),
  "and the box to paste one into goes away once there is one");
check((await p.locator("#licenceState").textContent()).includes("Grace Chapel"),
  `the panel names the church it belongs to: "${await p.locator("#licenceState").textContent()}"`);
await p.click("#setupToggle");
check((await held())?.church === "Grace Chapel",
  `and the panel knows whose it is: ${JSON.stringify(await held())}`);

// It survives a reload, because a church should be set up once.
await p.reload({ waitUntil: "networkidle" });
await p.waitForFunction(() => window.__autopageReady, { timeout: 20000 });
await switchOn();
check(Boolean(await held()), "it is still there after a reload");

// --- Licences that are not --------------------------------------------------
for (const [name, key, why] of [
  ["one signed by somebody else", forged, "signature"],
  ["one with the church swapped out under the signature", tampered, "signature"],
  ["one that has run out", expired, "expired"],
  ["a line of nonsense", "not-a-licence", "shape"],
]) {
  await p.evaluate(() => localStorage.removeItem("autopage-licence"));
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForFunction(() => window.__autopageReady, { timeout: 20000 });
  await switchOn();
  read = await p.evaluate((k) => window.__autopage.enterLicence(k), key);
  check(!read.ok && read.why === why && !(await allowed()),
    `${name} is refused (${read.why})`);
}

// --- A link is the whole setup ----------------------------------------------
//
// Nobody should be talked through pasting a key into a settings panel. The
// link goes to the church, they open it on the iPad, and that is the install.
await p.goto(`http://localhost:8123/index.html?licence=${good}`, { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__autopageReady, { timeout: 20000 });
await switchOn();
check(Boolean(await held()) && (await allowed()), "opening a licence link sets it up");
check(!p.url().includes("licence="),
  `and the key is taken out of the address rather than screenshotted around: ${p.url()}`);

// --- With no network at all -------------------------------------------------
//
// The property worth more than the money: a service happens in a hall, and a
// subscription check that needs a connection fails at the worst moment.
await ctx.setOffline(true);
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForFunction(() => window.__autopageReady, { timeout: 30000 });
await switchOn();
check(Boolean(await held()) && (await allowed()),
  "a licence still checks out with the network off");
await ctx.setOffline(false);

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
console.log(bad ? `${bad} FAILED` : "licences hold, and only hold back the part that is sold");
process.exit(bad || errs.length ? 1 : 0);
