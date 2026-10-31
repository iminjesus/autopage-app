// Where Chromium is, worked out rather than written down.
//
// Every tool in here had the path spelled out, down to the build number —
// /opt/pw-browsers/chromium-1194/... — and a new container ships a different
// one. That turns the whole suite red at once, for a reason that has nothing to
// do with the app, on the day you most want to trust it.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["/opt/pw-browsers", "/root/.cache/ms-playwright"];

function find() {
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    const builds = readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      // Highest build number wins, so a container with two keeps the newer.
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const build of builds) {
      for (const rel of ["chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const path = join(root, build, rel);
        if (existsSync(path)) return path;
      }
    }
  }
  for (const path of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(path)) return path;
  }
  throw new Error("no Chromium found — looked in " + ROOTS.join(", "));
}

export const executablePath = find();

/** The flags a test needs to get past a camera permission prompt. */
export const CAMERA_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
];
