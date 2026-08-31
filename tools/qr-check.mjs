// Does the vendored QR encoder produce something a camera reads?
//
// The first version of this compared the matrix against a reference encoder
// module for module, and that found three real bugs: a generator polynomial
// built in reverse, format bits laid down mirrored, and a rule-3 penalty that
// missed every pattern touching the edge of the symbol.
//
// It also reported failures that were not failures. Two well-regarded reference
// encoders disagree with each other on the same input — both decode correctly,
// they simply fill the padding differently — so matrix equality was never the
// property worth asserting. What matters is that a decoder reads back what went
// in, and that the mask chosen is the one the standard's penalty rules pick.
// Both of those are checked here, the second against segno, whose scores this
// now matches on every mask.
import { execFileSync } from "node:child_process";
import { encodeQr, __internals as internals } from "../qr.js";

const here = new URL(".", import.meta.url).pathname;

const roundTrip = (matrix) =>
  execFileSync("python3", [`${here}qr-decode.py`], {
    input: matrix.map((r) => r.join("")).join("\n"),
  })
    .toString()
    .trim()
    .replace(/^'|'$/g, "");

const SCORE = `
import sys
from segno.encoder import mask_scores
rows = [bytearray(int(c) for c in line) for line in sys.stdin.read().split('\\n')]
print(sum(mask_scores(rows, len(rows), len(rows))))
`;

const referenceScore = (matrix) =>
  Number(
    execFileSync("python3", ["-c", SCORE], {
      input: matrix.map((r) => r.join("")).join("\n"),
    }).toString()
  );

const cases = [
  "https://iminjesus.github.io/autopage-app/",
  "http://localhost:8123/index.html",
  "https://example.com",
  "https://a-rather-longer-host.example.org/some/path/that/keeps/going?q=1&r=2",
  "https://iminjesus.github.io/autopage-app/#tilt",
  "https://iminjesus.github.io/autopage-app/?utm=share&from=ipad&v=2026-09-01",
  "A",
  "https://x.example/a-link-long-enough-to-need-several-error-correction-blocks-abcdefghijklmnop",
];

let bad = 0;
for (const text of cases) {
  const mine = encodeQr(text);
  const back = roundTrip(mine);

  // Every mask, not just the chosen one: agreeing on the winner by luck while
  // scoring the rest differently is how a bad mask ships on the next URL.
  let scoreDiff = 0;
  for (let mask = 0; mask < 8; mask++) {
    const trial = encodeQr(text, { mask });
    if (internals.penalty(trial) !== referenceScore(trial)) scoreDiff++;
  }

  const ok = back === text && scoreDiff === 0;
  if (!ok) bad++;
  const label = (text.length > 38 ? text.slice(0, 35) + "…" : text).padEnd(39);
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label} ${mine.length}x${mine.length}  ` +
      `decoded ${back === text ? "identically" : `as "${back}"`}  ` +
      `${8 - scoreDiff}/8 mask scores agree`
  );
}
console.log(bad ? `${bad} of ${cases.length} FAILED` : `all ${cases.length} read back correctly`);
process.exit(bad ? 1 : 0);
