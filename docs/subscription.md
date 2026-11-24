# Charging churches, without becoming a service

Ten dollars a month, per church, for the part a church has and a person does
not: the week's folder arriving on its own.

## What is sold, and what is not

**Free, always:** opening PDFs off the device, the gesture, calibration, sets,
offline, the lot. This is what makes the app worth passing on, and a page
turner that asks for money before it will turn a page does not get passed on.
It is also most of the work.

**Paid:** opening a Sunday out of a shared Google Drive folder. That is the
part only a church has, it is the part that takes the weekly tedium away, and
the people who benefit are the people who would be paying.

The gate says both halves when it closes: *"Opening from Google Drive is the
part churches subscribe to. Everything else here stays free — open the PDFs
from this device."* A locked door that does not say what is still open reads
as the whole app being locked.

## How a licence works

A licence is a short signed string naming a church and a date:

    AP1.<payload>.<signature>        139 characters, ECDSA P-256

The app carries the **public** half of the signing key and checks the
signature itself. No server, no account, no login before the music.

**This is deliberate and it is not laziness.** The thing being sold is used in
a hall during a service. A subscription check that needs a connection fails at
exactly the worst moment — and "the wifi is down so your sheet music has
stopped working" is the kind of thing a church tells other churches about. An
expired licence may close a door. A flat wifi may not. There is a test for it.

It is forgeable by anyone willing to edit the app's own source, which is served
to them in plain text. That is accepted. The buyers are churches paying ten
dollars a month for something that saves their musicians real trouble, and the
cost of making this harder — accounts, a server, a login — would be paid by
every honest one of them, every Sunday.

## Running it

Make the signing key once and keep it. It is the only real secret in the app:
anyone holding it can mint licences.

    node tools/make-licence.mjs --new-keypair --key ~/autopage-signing.json

That prints a public key. Put it in `app.js` as `licencePublicKey` and the gate
turns on. **While it is empty, licensing is off and Drive is open to
everybody** — which is how the app shipped, and how it stays until this is
deliberately switched on.

Then, per church:

    node tools/make-licence.mjs --key ~/autopage-signing.json \
      --church "Grace Chapel" --months 12

It prints a link. Send the link; opening it on the iPad is the entire setup —
the key is read, stored, and taken back out of the address bar so it is not
passed around in a screenshot. Pasting the key into Setup is the fallback, not
the instruction.

Money arrives by transfer and a human sends the link. At one church that is
faster than any automation; at thirty it will not be, and that is the point to
automate it, not before.

## Why twelve months by default

Billing is monthly, the licence is not. A key that expires every month is a
chore every month for both sides over ten dollars. The expiry is what gets
shortened when a church stops paying — reissue a shorter one, or let it run
out.

There is no revocation: an offline check cannot be told to forget something.
Short expiries are the only lever, which is a real limitation and the price of
not having a server.

## What is deliberately not here yet

- **A trial.** Churches will want to see it work before paying. A fixed number
  of free Drive sets, or thirty days from first use, is the obvious shape. It
  is not built because the first few churches will be ones who are talked to
  directly, and a trial is a thing to add when selling stops being a
  conversation.
- **Automatic issuing.** Needs a server, which this does not have.
- **Per-device limits.** A licence is per church and shared by the team, which
  is what a church buying for its musicians means.
