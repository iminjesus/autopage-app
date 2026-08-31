# autopage-app

Hands-free automatic page turning for PDF sheet music, in the browser.

A replacement for a Bluetooth page-turner pedal — no hardware. The app listens
while you play and turns the page when you reach the end of the current one.
A face gesture is always available as a complement, for when the detector
misses or turns at the wrong moment.

**Status: winking turns the pages.** Open a score and wink — right eye
forward, left eye back. The camera starts on its own; the browser asks once and
remembers. There is nothing to switch on and nothing to press, and nothing on
screen but the score.

Listening has been taken out for now. The audio matcher worked — it turned every
page of the fixture on the music, at the written tempo and 20% faster, and
refused a recording of the same rhythm with every pitch moved — but it is out
of the way while the gesture is the thing being used. It is in the history, and
so is the note reader that fed it: `git log` around "Read the notes off the
page".

## What still turns pages

- **Winking** — right eye forward, left eye back, held for about a third of a
  second. What separates a wink from glancing down at the keyboard is its
  shape, not its length, so the hold does not have to be tiring.
- **Arrow keys, PageUp/PageDown, space** — which is also what a Bluetooth
  page-turner pedal sends, so those work with no setup.
- **Tapping** the outer sixth of either side of the score.

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
2. Press **Start** and play. Nothing moves until it hears the first note.

There is no tempo to set. The first page it hears out gives the bar length, and
the turn itself comes from the music either way. Played against the fixture at
its written tempo, turns land at 9.8 / 21.5 / 33.4s; played 20% faster with
nothing reconfigured, at 8.3 / 18.2 / 28.0s. Every one of those was fired by
the audio, not the clock.

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
