/* Offline cache for the app shell. Bump CACHE to ship an update. */
const CACHE = "autopage-v11";

// The face model lives in its own cache, and that name never changes.
//
// It is 13MB and it is fetched by the page rather than precached here, so a
// shell update must not throw it away — going from "ready for the rehearsal
// room" back to "needs a network" because a stylesheet changed would be the
// worst possible way to lose it. The activate sweep below leaves this alone.
const MODEL_CACHE = "autopage-model";
const MODEL = /\/vendor\/mediapipe\//;

const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./qr.js",
  "./manifest.json",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./fixtures/menuet-in-g.pdf",
  "./vendor/pdf.js",
  "./vendor/pdf.worker.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE && k !== MODEL_CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Latest when there is a network, instant when there is not — and, the case
 * that actually bites, instant when there is a network that goes nowhere.
 *
 * "Offline" is not a state a device reports honestly. A rehearsal room with a
 * wifi that no longer routes, or a captive portal waiting for a login nobody is
 * going to give it, leaves fetch() hanging rather than failing, and a plain
 * network-first worker sits there with a blank screen while someone is trying
 * to start playing. So the network gets a short head start and then loses to
 * whatever is already on the device.
 *
 * The head start only applies when there is something to fall back to. With no
 * cached copy there is nothing to be gained by giving up early — that is the
 * first download of the 13MB model, and it is allowed to take as long as it
 * takes.
 */
const NETWORK_GRACE_MS = 2500;

// One verdict for the whole page load, not one per file.
//
// Paying the grace period on every request meant a dead wifi cost two and a
// half seconds times a dozen files — ten seconds of blank screen with someone
// waiting to start playing, which is not meaningfully better than not working.
// The first request to time out has already established what the network is;
// the rest of the load takes its word for it and comes straight off the disk.
// A request that does come back clears the verdict at once, so a network that
// recovers is picked up on the next thing fetched rather than after a wait.
const DEAD_FOR_MS = 10000;
let deadUntil = 0;

async function respond(request) {
  const cached = await caches.match(request);

  const network = fetch(request).then((res) => {
    if (res && res.ok) {
      deadUntil = 0;
      const copy = res.clone();
      const target = MODEL.test(request.url) ? MODEL_CACHE : CACHE;
      caches.open(target).then((c) => c.put(request, copy)).catch(() => {});
    }
    return res;
  });

  if (!cached) {
    return network.catch(() =>
      request.mode === "navigate" ? caches.match("./index.html") : Response.error()
    );
  }

  // Already known to be going nowhere: serve from the disk now and let the
  // refetch settle whenever it settles.
  if (Date.now() < deadUntil) {
    network.catch(() => {});
    return cached;
  }

  return Promise.race([
    network.catch(() => cached),
    wait(NETWORK_GRACE_MS).then(() => {
      deadUntil = Date.now() + DEAD_FOR_MS;
      return cached;
    }),
  ]);
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(respond(e.request));
});
