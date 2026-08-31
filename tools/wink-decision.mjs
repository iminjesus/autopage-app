import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage();
await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__autopage?.winkDirection);

// openL / openR as the app reports them: lid gap over face height. These are
// the numbers a real face produced in the panel.
const cases = [
  ["eyes open",                 0.052, 0.054, 0],
  ["right eye winks",           0.049, 0.004, 1],
  ["left eye winks",            0.004, 0.049, -1],
  ["looking down, lids low",    0.008, 0.013, 0],
  ["coming back up",            0.010, 0.018, 0],
  ["right wink, narrower eyes", 0.032, 0.003, 1],
  ["right wink, tired eyes",    0.024, 0.003, 1],
];
const out = await p.evaluate((rows) => {
  const A = window.__autopage;
  return rows.map(([name, l, r, want]) => {
    const sum = l + r;
    const asym = (l - r) / sum;      // same form as eyeSignal
    const absDiff = Math.abs(l - r); // already in face heights
    const got = A.winkDirection(asym, absDiff);
    return { name, asym: +asym.toFixed(2), absDiff: +absDiff.toFixed(3), got, want, ok: got === want };
  });
}, cases);
for (const r of out) {
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(26)} diff ${String(r.asym).padStart(5)}  gap ${r.absDiff.toFixed(3)}  -> ${r.got} (want ${r.want})`);
}
console.log("threshold:", await p.evaluate(() => window.__autopage.threshold),
            " hold frames:", await p.evaluate(() => window.__autopage.holdFrames));
await b.close();
