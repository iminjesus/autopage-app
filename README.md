# autopage-app

Hands-free automatic page turning for PDF sheet music, in the browser.

A replacement for a Bluetooth page-turner pedal — no hardware. The app listens
while you play and turns the page when you reach the end of the current one.
A face gesture is always available as a complement, for when the detector
misses or turns at the wrong moment.

**Status: automatic turning works.** Rehearse once, then Perform and the pages
turn themselves. Verified end to end in headless Chromium against a synthetic
recording — all three turns fired, 1.3–1.6s before the tapped point. The face
gesture complement is still stubbed, and templates live in memory rather than
IndexedDB, so they are lost on reload. See
[`docs/design.md`](docs/design.md) for the architecture and
[`docs/decisions.md`](docs/decisions.md) for why it is built this way rather
than the more obvious ways.

## The core idea

The naive framing — "recognize the score and follow the performance" — is a
months-long project (optical music recognition, then real-time audio-to-score
alignment). This app deliberately does not do that.

For page turning you do not need to know *where* the player is at every moment.
You need one binary decision per page: **has the player reached the last
measure yet?** That reduction is what makes the project tractable.

Two cheap signals combine to answer it:

- **Coarse timing arms the detector.** Tempo and time signature give a rough
  estimate of when the last measure arrives. It only has to be right within a
  few seconds, and the estimate resets on every page turn, so error never
  accumulates.
- **Audio confirms the moment.** Inside that window — and only inside it — a
  short template matcher listens for the last measures of the page.

Coarse timing alone drifts. The matcher alone would fire on false positives
across the whole page. Together each covers the other's weakness.

## Where the templates come from

You rehearse before you perform. The app uses that.

On a rehearsal pass you tap at each point where you want the page to turn. The
app stores the chroma features of the few seconds leading up to each tap. In
performance it matches against those templates.

This means **no optical music recognition anywhere in the pipeline.** The PDF
is only ever drawn to the screen — the app never needs to know where the
measures are, what the notes are, or how the score is structured.

## Design constraints

- **A missed turn is much better than a wrong turn.** Missing one costs a
  gesture; turning mid-phrase breaks the performance. Detection thresholds are
  biased hard toward not turning.
- **The gesture complement is bidirectional and always live.** Back matters more
  than forward — it is the recovery path when the app turns early. A gesture
  also resyncs the timing estimate, so correcting once puts automation back on
  track instead of merely overriding it.
- **Degradation is visible.** When confidence drops the app stops turning by
  itself and says so, rather than guessing.

## Scope

Built for **performance**, not practice. Performance runs start to finish at a
stable tempo, which is what the timing estimate assumes. Practice — stopping,
repeating a passage, jumping backwards — breaks that assumption and is out of
scope for now.

## Trying it

`fixtures/menuet-in-g.pdf` is a four-page score to test with. Run
`python3 tools/make_fixture.py --audio-only` to generate `menuet-in-g.wav`
alongside it — the same music as audio, so you can play it into the microphone
and watch the pages turn. It is written in the style of the Petzold minuet
rather than transcribed from it, and deliberately non-repetitive: an eight-bar
phrase played four times would make every page end sound identical, which is
the one thing the matcher cannot resolve.

1. Open the PDF.
2. **Rehearse** — play, and tap **Mark turn** at each page end.
3. **Perform** — play again; the pages turn themselves.

## Running it

Static site, no dependencies, no build step — same shape as its sibling project
`metronome-app`. Serve it and open in a browser:

```bash
python3 -m http.server 8000
```

On Windows use `python` rather than `python3` — `python3` is a Microsoft Store
alias stub that exits immediately.

Microphone and camera need `https` or `http://localhost`.

pdf.js is vendored under `vendor/` (Apache 2.0) rather than loaded from a CDN,
so the app keeps working offline once installed.
