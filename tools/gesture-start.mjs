// Starting the camera, when starting it does not work the first time.
//
// "Sometimes the gesture does nothing when I open it, and closing and
// reopening fixes it" is the report this answers, and reopening fixing it is
// the clue: the module was left in a state no later attempt could get out of.
//
// A camera can fail to open for reasons that have nothing to do with the app
// — another tab or another application still holding it, a permission
// answered late, a model fetch that lost the network for a second. The first
// attempt cannot be made infallible. What can be made true is that the second
// attempt is possible, and that it happens without anybody asking.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";

const here = new URL(".", import.meta.url).pathname;
const score = `${here}../fixtures/menuet-in-g.pdf`;

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });

/** A page whose camera refuses the first `failures` times it is asked. */
async function pageWithFlakyCamera(failures, errorName = "NotReadableError") {
  const ctx = await b.newContext({ viewport: { width: 834, height: 1194 }, permissions: ["camera"] });
  const p = await ctx.newPage();
  await p.addInitScript(({ failures, errorName }) => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__camCalls = 0;
    navigator.mediaDevices.getUserMedia = (opts) => {
      window.__camCalls++;
      if (window.__camCalls <= failures) {
        const err = new Error("Could not start video source");
        err.name = errorName;
        return Promise.reject(err);
      }
      return real(opts);
    };
  }, { failures, errorName });
  return p;
}

const running = (p) => p.evaluate(() => window.__autopage.running);
const diag = (p) => p.evaluate(() => document.getElementById("gestureAsym").textContent);

// --- The camera is busy the first time --------------------------------------
{
  const p = await pageWithFlakyCamera(1);
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
  await p.setInputFiles("#fileInput", score);
  await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });
  await p.waitForTimeout(3000);

  check(!(await running(p)), "a camera that refuses leaves the gesture not running");
  check((await diag(p)).includes("not running"),
    "and the panel says so rather than looking the same as working");

  // Nobody has to do anything. This is the whole point.
  await p.waitForFunction(() => window.__autopage.running, null, { timeout: 30000 })
    .then(() => check(true, "it starts itself on a later attempt, with nothing asked of anybody"))
    .catch(() => check(false, "it starts itself on a later attempt, with nothing asked of anybody"));

  const before = await p.evaluate(() => window.__autopage.faceFrames);
  await p.waitForTimeout(2000);
  check((await p.evaluate(() => window.__autopage.faceFrames)) > before,
    "and the frames really are being read");
  check(errs.length === 0, `with nothing thrown along the way: ${JSON.stringify(errs)}`);
  await p.context().close();
}

// --- A model left behind by a failed start ----------------------------------
//
// The bug exactly: the face model was built before the camera was asked for,
// so a camera failure left it in place with no timer. Every later attempt saw
// it, decided the gesture was already running, and returned reporting success.
{
  const p = await pageWithFlakyCamera(1);
  await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
  await p.setInputFiles("#fileInput", score);
  await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });
  await p.waitForTimeout(2500);

  // Ask again by hand, the way the Allow button does.
  await p.evaluate(() => window.__autopage.startGesture().catch(() => {}));
  await p.waitForFunction(() => window.__autopage.running, null, { timeout: 30000 })
    .then(() => check(true, "asking again after a failure actually tries again"))
    .catch(() => check(false, "asking again after a failure actually tries again"));
  await p.context().close();
}

// --- Two callers at once ----------------------------------------------------
//
// The model takes about a second to build, and anything that asked again
// inside that second used to pass the same empty check: two models, two
// streams, two intervals, one of each ever stopped.
{
  const p = await pageWithFlakyCamera(0);
  await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
  await p.setInputFiles("#fileInput", score);
  await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });
  await p.evaluate(() => {
    const A = window.__autopage;
    return Promise.all([A.startGesture(), A.startGesture(), A.startGesture()]).catch(() => {});
  });
  await p.waitForFunction(() => window.__autopage.running, null, { timeout: 30000 });
  await p.waitForTimeout(1500);
  const calls = await p.evaluate(() => window.__camCalls);
  check(calls === 1, `three callers at once open one camera, not three: ${calls}`);

  // One interval, not three: three would read the face at ninety a second.
  const before = await p.evaluate(() => window.__autopage.faceFrames);
  await p.waitForTimeout(3000);
  const rate = ((await p.evaluate(() => window.__autopage.faceFrames)) - before) / 3;
  check(rate < 45, `and one loop reading it, not three: ${rate.toFixed(0)} fps`);
  await p.context().close();
}

// --- Somebody said no -------------------------------------------------------
//
// A refusal is an answer, not a transient. Retrying it every few seconds
// would be worse than not working.
{
  const p = await pageWithFlakyCamera(99, "NotAllowedError");
  await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
  await p.setInputFiles("#fileInput", score);
  await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });
  await p.waitForTimeout(9000);
  const calls = await p.evaluate(() => window.__camCalls);
  check(calls === 1, `a refusal is asked once and not again: ${calls} attempts`);
  check((await diag(p)).includes("tap Allow"), "and the panel says how to change that answer");
  await p.context().close();
}

await b.close();
console.log(bad ? `${bad} FAILED` : "the gesture starts, or keeps trying until it does");
process.exit(bad ? 1 : 0);
