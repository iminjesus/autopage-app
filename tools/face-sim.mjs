/**
 * The synthetic face both the regression suite and the experiments drive.
 *
 * It runs inside the page, so it closes over nothing: Playwright serialises it
 * and hands it the options. Shared rather than copied because the two callers
 * drifting apart would make an experiment's numbers mean something different
 * from the test's.
 */
export function simulate({
  gapL: gL,
  gapR: gR,
  frames,
  yaw,
  hz,
  brow = 0,
  path = [],
  mode = "wink",
  // Frames per second to replay at. The path is given in seconds, so this
  // changes only how finely it is sampled — the same physical gesture, seen
  // by a camera that is keeping up or struggling.
  fps = 30,
  // Where this player's head rests, in radians. Not everybody's eyes are
  // level, and the settling frames before the gesture are spent here — which
  // is how the app gets to see where "still" is for this person.
  rest = 0,
  settleSecs = 1,
  // Vertical compression of the whole face, about its centre.
  //
  // This is what a low music stand does. The camera sits below the player and
  // looks up, and the player looks down at the score; both pitch the face away
  // from the lens, and in the image that reads as the face being squashed
  // vertically. 1 is head-on, 0.7 is roughly 45 degrees between the two.
  //
  // It matters because the two measures live on different axes. A lid gap is a
  // vertical distance and shrinks with it directly. A roll is an angle, and
  // compression flattens it: tan(apparent) = squash x tan(real).
  squash = 1,
}) {
  let gapL = gL, gapR = gR;
  const legs = path.map(([to, secs]) => [to, Math.max(1, Math.round(secs * fps))]);
  // One clock across every call, not a fresh one each time. Replays that each
  // restarted at zero sent the frame clock backwards, which parked the turn
  // cooldown in the future and quietly stopped the next replay from turning
  // anything — a test that reported a broken gesture because of its own clock.
  const base = (window.__simClock ?? 0) + 2000;
  const at = (t) => base + t * (1000 / fps);
  const rollAt = (t) => {
    let start = 0, from = 0;
    for (const [to, n] of legs) {
      if (t < start + n) return from + (to - from) * ((t - start + 1) / n);
      start += n;
      from = to;
    }
    return from;
  };

  window.__autopage.setMode(mode);
  const A = window.__autopage;
  const before = A.state.page;

  const FACE_MID = 0.35; // halfway between forehead and chin

  // A face, made of the eleven points the app actually reads.
  const face = (t, neutral = false) => {
    const turn = hz ? yaw * Math.sin((2 * Math.PI * hz * t) / fps) : yaw || 0;
    const roll = neutral ? rest : rollAt(t);
    const half = 0.06, cx = 0.5 + turn * 0.05, cy = 0.32;
    const L = { x: cx + half * Math.cos(roll), y: cy + half * Math.sin(roll) };
    const R = { x: cx - half * Math.cos(roll), y: cy - half * Math.sin(roll) };
    const pt = (x, y) => ({ x, y: FACE_MID + (y - FACE_MID) * squash, z: 0 });
    const m = [];
    m[10] = pt(0.5, 0.2);                 // forehead
    m[152] = pt(0.5, 0.5);                // chin -> face height 0.30
    m[1] = pt(0.5 + turn * 0.06, 0.36);   // nose
    m[386] = pt(L.x, L.y - gapL / 2);
    m[374] = pt(L.x, L.y + gapL / 2);
    m[362] = pt(L.x - 0.02, L.y);
    m[159] = pt(R.x, R.y - gapR / 2);
    m[145] = pt(R.x, R.y + gapR / 2);
    m[133] = pt(R.x + 0.02, R.y);
    m[33] = pt(R.x - 0.02 * Math.cos(roll), R.y - 0.02 * Math.sin(roll));
    m[263] = pt(L.x + 0.02 * Math.cos(roll), L.y + 0.02 * Math.sin(roll));
    return m;
  };

  const shapes = [
    { categoryName: "eyeBlinkLeft", score: 0 },
    { categoryName: "eyeBlinkRight", score: 0 },
    { categoryName: "browInnerUp", score: brow > 0 ? brow : 0 },
    { categoryName: "browDownLeft", score: brow < 0 ? -brow : 0 },
    { categoryName: "browDownRight", score: brow < 0 ? -brow : 0 },
  ];
  const neutralShapes = shapes.map((s) => ({ categoryName: s.categoryName, score: 0 }));

  // Neutral means neutral in every channel — lids open, brows still, head
  // level. Leaving any of them set holds the previous gesture down and the next
  // one never counts as released.
  const openFace = (t) => {
    const save = [gapL, gapR];
    gapL = gapR = 0.015;
    const f = face(t, true);
    [gapL, gapR] = save;
    return f;
  };

  const total = legs.length ? legs.reduce((n, [, f]) => n + f, 0) : frames;
  window.__simClock = at(Math.max(1, Math.round(fps * settleSecs)) + total);
  // A second of sitting still first: long enough for the app to see where this
  // player's head rests, which is what every angle below is measured from.
  const settle = Math.max(1, Math.round(fps * settleSecs));
  for (let t = 0; t < settle; t++) A.processFrame(openFace(t), neutralShapes, at(t));
  for (let t = 0; t < total; t++) A.processFrame(face(t), shapes, at(settle + t));
  return { from: before, to: A.state.page, turned: A.state.page !== before };
}
