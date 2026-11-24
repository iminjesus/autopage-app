#!/usr/bin/env node
// Mint a licence for a church.
//
// A licence is a short signed string. The app carries the public half of the
// key and checks the signature itself, so a church that has paid keeps working
// in a hall with no signal — which is the whole point of the app and would be
// a strange thing to give up in order to collect ten dollars.
//
// Nothing here talks to anything. Money arrives by transfer, this prints a
// link, and the link is sent to whoever asked. That is the entire system until
// there are enough churches for it to be worth more than that.
//
//   Make a signing key, once, and keep it:
//     node tools/make-licence.mjs --new-keypair --key ~/autopage-signing.json
//
//   Then for each church:
//     node tools/make-licence.mjs --key ~/autopage-signing.json \
//       --church "Grace Chapel" --months 12
//
// The private key must never go in this repository. It is the one secret in
// the whole app: anyone holding it can mint licences.
import { webcrypto } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64 = (text) => new Uint8Array(Buffer.from(text, "base64url"));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] ?? true;
};
const has = (name) => args.includes(`--${name}`);

const keyPath = flag("key");
if (!keyPath || keyPath === true) {
  console.error("--key <path to the signing key file> is required");
  process.exit(2);
}

if (has("new-keypair")) {
  const pair = await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const privateKey = await webcrypto.subtle.exportKey("pkcs8", pair.privateKey);
  const publicKey = await webcrypto.subtle.exportKey("raw", pair.publicKey);
  writeFileSync(keyPath, JSON.stringify({ private: b64(privateKey), public: b64(publicKey) }, null, 2));
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* best effort; the warning below is the real protection */
  }
  console.log(`Signing key written to ${keyPath}. Keep it. Do not commit it.`);
  console.log("\nPut this in app.js as LICENCE_PUBLIC_KEY:\n");
  console.log(`  "${b64(publicKey)}"\n`);
  process.exit(0);
}

const church = flag("church");
if (!church || church === true) {
  console.error('--church "Name of the church" is required');
  process.exit(2);
}

// Paid monthly, issued for longer: a key that expires every month is a chore
// every month, for both sides, over ten dollars. Twelve by default, and the
// expiry is what gets shortened if a church stops paying.
const months = Number(flag("months") ?? 12);
const until = flag("until");
const expiry = until && until !== true ? new Date(`${until}T23:59:59Z`) : monthsFromNow(months);
if (Number.isNaN(expiry.getTime())) {
  console.error("--until wants a date like 2027-01-31");
  process.exit(2);
}

function monthsFromNow(n) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + n);
  d.setUTCHours(23, 59, 59, 0);
  return d;
}

const stored = JSON.parse(readFileSync(keyPath, "utf8"));
const privateKey = await webcrypto.subtle.importKey(
  "pkcs8", unb64(stored.private), ALG, false, ["sign"]
);

const payload = new TextEncoder().encode(
  JSON.stringify({ c: church, e: expiry.toISOString().slice(0, 10) })
);
const signature = await webcrypto.subtle.sign(SIGN, privateKey, payload);
const licence = `AP1.${b64(payload)}.${b64(signature)}`;

const site = flag("site") || "https://iminjesus.github.io/autopage-app/";
console.log(`\n${church} — good until ${expiry.toISOString().slice(0, 10)}\n`);
console.log("Send them this link. Opening it on the iPad is the whole setup:\n");
console.log(`  ${site}?licence=${licence}\n`);
console.log("Or the key on its own, to paste into Setup:\n");
console.log(`  ${licence}\n`);
