/**
 * Licences, checked on the device.
 *
 * A licence is a short signed string naming a church and a date. The app
 * carries the public half of the signing key and checks the signature itself,
 * with no server and no network — which matters more here than it sounds:
 * the thing being sold is used in a hall during a service, and a subscription
 * check that needs a connection would fail at exactly the wrong moment. An
 * expired licence closes a door; a flat wifi must not.
 *
 * It is forgeable by anyone willing to patch the app's own source, which is
 * served to them in plain text. That is accepted. The buyers are churches
 * paying ten dollars a month for a thing that saves their musicians real
 * trouble, and the cost of making this harder — accounts, a server, a login
 * before the music — would be paid by every honest one of them.
 */

const PREFIX = "AP1.";
const SIGN = { name: "ECDSA", hash: "SHA-256" };
const CURVE = { name: "ECDSA", namedCurve: "P-256" };

const unb64 = (text) => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

/**
 * Read a licence, or say why not.
 *
 * @returns {Promise<{ok: true, church: string, until: string}
 *                  | {ok: false, why: "shape"|"signature"|"expired"}>}
 */
export async function readLicence(text, publicKeyB64, today = new Date()) {
  const parts = String(text ?? "").trim().split(".");
  if (parts.length !== 3 || `${parts[0]}.` !== PREFIX) return { ok: false, why: "shape" };

  let payload;
  let signature;
  let body;
  try {
    payload = unb64(parts[1]);
    signature = unb64(parts[2]);
    body = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { ok: false, why: "shape" };
  }
  if (!body?.c || !body?.e) return { ok: false, why: "shape" };

  let good = false;
  try {
    const key = await crypto.subtle.importKey("raw", unb64(publicKeyB64), CURVE, false, ["verify"]);
    good = await crypto.subtle.verify(SIGN, key, signature, payload);
  } catch {
    return { ok: false, why: "signature" };
  }
  if (!good) return { ok: false, why: "signature" };

  // Dates, not times. A licence that runs out partway through a Sunday
  // morning because of a time zone is a support call nobody needs.
  const stamp = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (stamp(today) > body.e) return { ok: false, why: "expired", church: body.c, until: body.e };

  return { ok: true, church: body.c, until: body.e };
}

/** What to say about a licence that will not do. */
export function licenceProblem(why) {
  if (why === "expired") return "That licence has run out.";
  if (why === "signature") return "That licence is not one of ours.";
  return "That does not look like a licence key.";
}
