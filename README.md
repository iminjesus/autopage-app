# autopage-app

Hands-free automatic page turning for PDF sheet music, in the browser.

A replacement for a Bluetooth page-turner pedal — no hardware. The app listens
while you play and turns the page when you reach the end of the current one.
A face gesture is always available as a complement, for when the detector
misses or turns at the wrong moment.

**Status: a face gesture turns the pages.** Open a score and use either one:

- **Wink** — right eye forward, left eye back. Needs the eyelids to be readable, so glasses off.
- **Head tilt** — flick your head right to go forward, left to go back. A small movement, done briskly. Works with glasses on or off.

The camera starts on its own; the browser asks once and remembers. There is
nothing to switch on and nothing to press, and nothing on screen but the score.

Listening has been taken out for now. The audio matcher worked — it turned every
page of the fixture on the music, at the written tempo and 20% faster, and
refused a recording of the same rhythm with every pitch moved — but it is out
of the way while the gesture is the thing being used. It is in the history, and
so is the note reader that fed it: `git log` around "Read the notes off the
page".

## What still turns pages

- **Winking** — right eye forward, left eye back, held for a fifth of a second. What separates a wink from glancing down at the keyboard is its
  shape, not its length, so the hold does not have to be tiring.
- **A head tilt** — right forward, left back. Flick it over about twelve degrees
  and hold a moment; what counts is that the movement arrives quickly, not that
  it goes far, so there is nothing to strain. A lean into a phrase drifts to the
  same angle too slowly to register, straightening up again never counts, and
  nodding to the beat is a different axis that is invisible to the measure. This
  is the one that works behind glasses, where a lens rim sits across the eyelid
  and no wink threshold reaches past it.
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

## On an iPad

This is where it is meant to live: a tablet on a stand, no hardware, nothing to
press.

1. **Publish it.** Settings → Pages → Deploy from a branch → `main` / root. No
   workflow file needed. It appears at `https://<user>.github.io/autopage-app/`.
   HTTPS is not a nicety here — `getUserMedia` refuses to run without it, so a
   plain `http://` address means no camera and no gesture at all.
2. **Open that address in Safari, then Share → Add to Home Screen.** Since iOS
   14.3 the camera works from a home-screen app, so there is no reason to leave
   it in a browser tab. The service worker keeps the shell offline, so a stand
   with no wifi on it is fine.
3. **Open a score once.** It is stored, and it reopens on the page it was left
   on. "Open another score" in the Setup panel changes it.

What the iPad specifically needs, and what the app does about it:

- **The screen must not sleep.** A player mid-piece touches nothing, and an iPad
  dims and locks in about two minutes — which would end the performance before
  the second page. The app holds a **screen wake lock** while a score is open
  and re-acquires it after every trip to the home screen, because the system
  drops it silently on the way out. Where the API is missing the app says so and
  points at Auto-Lock in Settings; the panel's diagnostics line reports `screen
  held` / `off` / `unsupported` so it is never a guess.
- **Portrait.** A page of music is taller than it is wide.
- **The tilt is the default on a touch device.** On a stand the face is 50-70cm
  away and small in frame, which is where the eyelid measure is weakest and the
  angle between the eyes is barely affected. The camera is asked for 720p rather
  than VGA for the same reason. Either gesture can still be chosen in Setup.
- **The tap zones stop short of the home indicator**, so reaching for the
  forward zone is not a coin toss between turning the page and leaving the app.

Where the lens sits does not matter much — newer iPads put it on the long edge,
older ones on the short edge, so a stand in portrait can leave the face off to
one side of the frame. Both measurements are ratios taken inside the face, so
being off-centre costs nothing. Distance is what costs.

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
