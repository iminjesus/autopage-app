# autopage-app

Hands-free automatic page turning for PDF sheet music, in the browser.

A replacement for a Bluetooth page-turner pedal — no hardware. The app listens
while you play and turns the page when you reach the end of the current one.
A face gesture is always available as a complement, for when the detector
misses or turns at the wrong moment.

**Status: automatic turning works, with no setup.** Open a score, give it the
tempo, press Start. The face gesture complement is still stubbed. See
[`docs/design.md`](docs/design.md) for the architecture and
[`docs/decisions.md`](docs/decisions.md) for why it is built this way rather
than the more obvious ways.

## The core idea

An engraved PDF is not a picture of a score. It is the instructions that drew
one — and those instructions are readable. Staff lines are long horizontal
strokes; barlines are vertical strokes exactly one staff tall. So the app opens
the file and **counts the measures on each page**, without recognising an image
and without being told anything.

Measures plus tempo give the length of every page, and that is enough to turn
on time. The estimate re-anchors at each turn, so error cannot accumulate from
one page to the next.

This is not optical music recognition. OMR exists because *scanned* scores are
pixels with no structure left. A PDF exported from LilyPond, MuseScore, Sibelius
or Finale still carries its geometry, and reading it is parsing, not inference.

Listening is a refinement on top, not the foundation. Each turn quietly records
how the end of that page sounded, so a second run through the same score can be
corrected by the music rather than the clock. Nobody is asked to rehearse.

## Design constraints

- **A missed turn is much better than a wrong turn.** Missing one costs a
  gesture; turning mid-phrase breaks the performance. Detection thresholds are
  biased hard toward not turning.
- **Nothing is required of the player before they start.** A setup step that
  has to be done per score is a page-turner pedal with extra ceremony.
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

1. Open the PDF — it reports the measures it found on each page.
2. Set the tempo, by typing it or tapping it.
3. Press **Start** and play.

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
