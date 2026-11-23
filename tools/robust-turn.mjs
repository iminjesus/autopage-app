// Does the same gesture always do the same thing?
//
// "It works, then suddenly it doesn't" is the only bug report that matters for
// a page turner. Somebody is playing in front of people; a turn that happens
// four times out of five is worse than one that never happens, because they
// have already stopped planning for it.
//
// Two things make the same movement land differently on different days, and
// neither is anything the player can see:
//
//   Frame rate. A camera that is keeping up and a camera that is struggling
//   are the same camera ten minutes apart — rendering a page, a warm iPad, any
//   other app. Every gate used to be counted in frames, so 30fps and 12fps
//   were different gestures.
//
//   Where the head rests. Nobody sits with their eyes exactly level, and a
//   music stand is never square to the player. If "tilted" is measured from
//   horizontal rather than from where this person's head actually sits, one
//   direction is easy and the other is impossible.
import { chromium } from "playwright-core";
import { executablePath, CAMERA_ARGS } from "./browser.mjs";
import { simulate } from "./face-sim.mjs";

const b = await chromium.launch({ executablePath, args: CAMERA_ARGS });
const p = await (await b.newContext({ viewport: { width: 834, height: 1194 } })).newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

let bad = 0;
const check = (ok, line) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };

await p.goto("http://localhost:8123/index.html", { waitUntil: "networkidle" });
await p.setInputFiles("#fileInput", "/workspace/autopage-app/fixtures/menuet-in-g.pdf");
await p.waitForFunction(() => window.__autopage.state.pageCount === 4, { timeout: 20000 });

const deg = (d) => (d * Math.PI) / 180;
const run = (opts) => p.evaluate(simulate, { gapL: 0.015, gapR: 0.015, mode: "tilt", frames: 0, ...opts });

// An ordinary tilt: over to 20 degrees in a third of a second, held for half a
// second, back up. Described in seconds, so every frame rate below is the same
// movement, not a faster or slower one.
const TILT = (sign, lean = 0) => [
  [deg(lean), 0.3],
  [deg(lean + sign * 20), 0.33],
  [deg(lean + sign * 20), 0.5],
  [deg(lean), 0.4],
];

// --- The same gesture, at every frame rate the iPad actually delivers -------
console.log("one gesture, five frame rates:");
const rates = [30, 24, 20, 15, 12, 8];
const got = [];
for (const fps of rates) {
  await p.evaluate(() => { window.__autopage.state.page = 2; });
  const r = await run({ fps, path: TILT(1) });
  got.push({ fps, turned: r.turned });
  console.log(`      ${String(fps).padStart(2)}fps -> ${r.turned ? "turned" : "nothing"}`);
}
check(got.every((x) => x.turned),
  `a 20 degree tilt turns the page at every frame rate (${got.filter((x) => x.turned).length}/${rates.length})`);

// --- And a movement that should not turn, still does not, at every rate -----
console.log("looking down at the fingerboard, five frame rates:");
const slow = [];
for (const fps of rates) {
  await p.evaluate(() => { window.__autopage.state.page = 2; });
  // Drifting over and back, the way a head moves while playing: far enough,
  // but nothing like a flick.
  const r = await run({ fps, path: [[0, 0.3], [deg(22), 2.2], [deg(22), 0.6], [0, 2.0]] });
  slow.push({ fps, turned: r.turned });
  console.log(`      ${String(fps).padStart(2)}fps -> ${r.turned ? "TURNED" : "nothing"}`);
}
check(slow.every((x) => !x.turned),
  `a slow lean never turns the page, at any frame rate (${slow.filter((x) => x.turned).length} false turns)`);

// --- A player whose head does not rest level -------------------------------
//
// The common case, not an edge case: a stand off to one side, a guitar strap,
// or simply how somebody sits. Measured from horizontal, a 7 degree resting
// lean makes one direction 7 degrees short and the other 7 degrees over.
console.log("a head that rests 7 degrees over:");
for (const [sign, way] of [[1, "one way"], [-1, "the other"]]) {
  await p.evaluate(() => { window.__autopage.state.page = 2; });
  // Four seconds of sitting at the lean first, which is what the app has to
  // notice. A player does not arrive at their resting angle mid-gesture.
  await p.evaluate(() => { window.__simClock = (window.__simClock ?? 0) + 60000; });
  const r = await run({ fps: 30, rest: deg(7), settleSecs: 4, path: TILT(sign, 7) });
  console.log(`      tilt ${way.padEnd(9)} -> ${r.turned ? `page ${r.from} to ${r.to}` : "nothing"}`);
  check(r.turned, `a tilt ${way} works for somebody who sits with a lean`);
}

// Both directions should cost the same effort, whoever is sitting there.
console.log("how far it has to go, from where the head rests:");
for (const lean of [0, 7, -7]) {
  // A clean slate between postures. Without it the previous group's resting
  // angle is still being forgotten while this group is measured, and the lag
  // reads as an asymmetry that is really the test's own leftovers.
  await p.evaluate(() => { window.__simClock = (window.__simClock ?? 0) + 60000; });
  const need = [];
  for (const sign of [1, -1]) {
    let found = null;
    for (let d = 8; d <= 30 && found === null; d += 2) {
      await p.evaluate(() => { window.__autopage.state.page = 2; });
      const r = await run({ fps: 30, rest: deg(lean), settleSecs: 4, path: [
        [deg(lean), 0.3], [deg(lean + sign * d), 0.33], [deg(lean + sign * d), 0.5], [deg(lean), 0.4],
      ] });
      if (r.turned) found = d;
    }
    need.push(found);
  }
  console.log(`      resting ${String(lean).padStart(3)}deg -> right needs ${need[0]}deg, left needs ${need[1]}deg`);
  check(need[0] !== null && need[1] !== null && Math.abs(need[0] - need[1]) <= 4,
    `at a ${lean} degree resting lean both directions cost about the same (${need[0]} vs ${need[1]})`);
}

// --- Shifting in the chair, mid-piece --------------------------------------
//
// The case the player experiences as "it just stopped working". They settle,
// it works; twenty minutes later they have leaned into the stand, and now the
// tilt away from the lean is ten degrees short of wherever level used to be.
// How long after moving does it come back?
console.log("after shifting posture by 10 degrees, tilting back the other way:");
for (const secs of [1, 2, 4, 8]) {
  await p.evaluate(() => { window.__simClock = (window.__simClock ?? 0) + 60000; });
  await p.evaluate(() => { window.__autopage.state.page = 2; });
  const r = await run({
    fps: 30, rest: 0, settleSecs: 3,
    // Settle level, move to a 10 degree lean, sit there, then tilt 20 degrees
    // the other way — which from a stale level looks like only 10.
    path: [[0, 0.5], [deg(10), 0.8], [deg(10), secs], [deg(-10), 0.33], [deg(-10), 0.5], [deg(10), 0.4]],
  });
  console.log(`      sat in the new posture ${secs}s -> ${r.turned ? "turned" : "nothing"}`);
  if (secs >= 4) check(r.turned, `level has followed the new posture after ${secs}s`);
}

// --- Things that are not a gesture -----------------------------------------
//
// False turns are the failure that ends a performance. Everything here is
// ordinary playing, and none of it may turn a page.
console.log("ordinary movements that must never turn a page:");
const quiet = [
  ["bobbing with the beat", { path: Array.from({ length: 12 }, (_, i) => [deg(i % 2 ? 7 : -7), 0.5]) }],
  // Harder: further over and twice as quick, which is what somebody playing
  // something loud actually does. This is the case that sets how low the gate
  // can go, so it is here to be failed if the gate goes too low.
  ["bobbing hard", { path: Array.from({ length: 16 }, (_, i) => [deg(i % 2 ? 9 : -9), 0.25]) }],
  ["a double take", { yaw: 0.7, path: [[0, 0.4], [deg(8), 0.3], [deg(-8), 0.3], [0, 0.5], [0, 1.0]] }],
  ["looking down at the hands", { squash: 0.72, path: [[0, 0.5], [deg(5), 1.2], [deg(5), 1.5], [0, 1.2]] }],
  ["turning to the congregation", { yaw: 0.9, hz: 0.5, path: [[0, 4]] }],
  ["a slow settle into the stand", { path: [[0, 0.5], [deg(18), 3.0], [deg(18), 2.0]] }],
  // At an ordinary speed. Snapped upright faster than that it does turn, and
  // it should: once somebody has sat at sixteen degrees long enough for that
  // to be where their head rests, whipping to level is the same movement as a
  // deliberate sixteen degree tilt, measured by anything. There is no signal
  // that separates them, so the rate gate is what decides, and a stretch is
  // slower than a flick.
  ["straightening up from a lean", { rest: deg(16), settleSecs: 4, path: [[deg(16), 0.4], [0, 1.0], [0, 1.0]] }],
];
for (const [what, opts] of quiet) {
  await p.evaluate(() => { window.__simClock = (window.__simClock ?? 0) + 60000; });
  await p.evaluate(() => { window.__autopage.state.page = 2; });
  const r = await run({ fps: 30, settleSecs: 2, ...opts });
  console.log(`      ${what.padEnd(28)} -> ${r.turned ? "TURNED" : "nothing"}`);
  check(!r.turned, `${what} does not turn the page`);
}

// --- How hard is it, really ------------------------------------------------
//
// The first complaint about this gesture was that it hurt. Whatever the gate
// is, it has to be reported rather than assumed, because the number that
// matters is degrees of neck, not radians in a constant.
console.log("the smallest flick that turns a page, by how fast it is:");
for (const secs of [0.25, 0.33, 0.5]) {
  await p.evaluate(() => { window.__simClock = (window.__simClock ?? 0) + 60000; });
  let found = null;
  for (let d = 6; d <= 30 && found === null; d += 1) {
    await p.evaluate(() => { window.__autopage.state.page = 2; });
    const r = await run({ fps: 30, settleSecs: 2,
      path: [[0, 0.3], [deg(d), secs], [deg(d), 0.5], [0, 0.4]] });
    if (r.turned) found = d;
  }
  console.log(`      over ${secs}s -> ${found === null ? "never" : found + " degrees"}`);
}

console.log("ERRORS:", errs.length ? errs : "none");
await b.close();
console.log(bad ? `${bad} FAILED` : "the same gesture always does the same thing");
process.exit(bad || errs.length ? 1 : 0);
