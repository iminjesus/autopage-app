# Design

## Problem

Turn the page of a PDF score at the right moment, hands-free, while the
musician is playing.

"The right moment" is early enough that the next page's opening bars are
readable before they have to be played, late enough that the current page is
still visible while it is being finished.

There is no lead-time setting. The rehearsal tap defines the turn point
directly: the player taps where they want the page to flip, and the template is
the music leading up to that instant. A number in a settings panel is a worse
way to express the same thing.

## What this is not

It is tempting to state the problem as *score following*: recognize the score,
track the performance against it, always know the current position. That is the
general solution and it is expensive:

1. Optical music recognition converts the PDF to a symbolic score (MusicXML).
   Accuracy varies by engraving quality, so it needs a correction UI, which is
   where most of the effort goes.
2. A real-time aligner matches incoming audio against that symbolic score,
   typically online DTW over chroma features or an HMM.

Both are avoidable here. Page turning needs one bit of information per page,
not a continuous position estimate. See `decisions.md`.

## Architecture

One flat, dependency-free static site, same as its sibling project `metronome-app`:
`index.html` + `style.css` + `app.js`, no build step. The names below are
sections of `app.js`, not separate modules.

```
 PDF ──▶ score-view ──────────────────────────────┐
                                                  ▼
 mic ──▶ audio-input ──▶ chroma ──▶ matcher ──▶ controller ──▶ turn
                                       ▲            ▲
                          templates ───┘            │
                          (store)                   │
                                                    │
 tempo/meter ─────────▶ arming ─────────────────────┤
                        (window)                    │
                                                    │
 camera ─────────────▶ gesture ─────────────────────┘
                        (fwd / back / resync)
```

### arming — coarse timing

The rehearsal pass measures how long each page actually ran. That measurement
is the estimate — better than deriving one from tempo and time signature,
because it already contains the player's pacing, any repeats, and the fact that
a last system is usually taken broadly. Open a detection window around it,
±3.5 seconds or ±15% of the page's length, whichever is wider, so a performance
taken off the rehearsal tempo still opens the window over the right music.

The estimate is deliberately weak. It does not need to be accurate, only
approximately right, because its job is to gate the matcher rather than to
trigger the turn. Two properties keep it good enough:

- Performance tempo is stable, so drift over one page (30–60s) stays within a
  few seconds.
- The estimate **resets at every page turn**, so error does not accumulate
  across the piece. Each page is an independent estimation problem.

Nothing here comes from analysing the PDF.

### matcher — audio confirmation

Inside the armed window only, match incoming chroma against the stored template
for this page using subsequence DTW. DTW is tempo-tolerant, so a performance
taken slower or faster than the rehearsal still matches.

Two details matter more than they look:

- **Templates span 2–3 measures, not one.** A single measure of, say, repeated
  tonic chords is not distinctive enough to locate against its neighbours.
  Longer context buys discriminative power.
- **The threshold is high, and the match must hold for several consecutive
  frames.** A page turn is an expensive mistake and a cheap omission.
- **Alignment cost is divided by path length, not template length.** Dividing
  by template length makes a compressed alignment cheap, and the detector fires
  early as a result.

Measured on a synthetic best case (the rehearsal and the performance are the
same recording), turns land 1.3–1.6s before the tapped point. The residual bias
is not a bug to chase: chroma cannot resolve time inside a held chord, and the
fixture ends each page on a dotted half. Precision is bounded by harmonic
rhythm, and for page turning, early is the safe direction anyway.

### gesture — the complement

Face landmark detection, running locally (no audio or video leaves the device).
Two gestures: forward and back.

The gesture choice is constrained by what does *not* occur naturally while
playing. Head nods and blinks are disqualified — musicians nod to the beat and
blink constantly. Workable candidates are a sustained eyebrow raise, a wink, or
a held head tilt, all requiring the pose to be held for 300–500ms to suppress
false positives.

A gesture does two things: it turns the page, and it **resyncs the timing
estimate** to the known position. Correcting once puts the automation back on
track rather than merely overriding it.

To keep battery and thermal cost down, inference can run only while the arming
window is open, rather than continuously.

### store

Per-score state, keyed by a hash of the PDF: page turn templates, measure
counts, tempo, and lead time. IndexedDB, so a rehearsed score is ready on the
next open.

## Failure behaviour

| Situation | Behaviour |
|---|---|
| Matcher misses | No turn. Player uses the forward gesture. Timing resyncs. |
| Matcher fires early | Player uses the back gesture. Timing resyncs. |
| Confidence low | Auto-turn disables itself; UI shows manual mode. |
| No rehearsal data for this score | Manual only, with an offer to rehearse. |
| Reached the last page | Detector stops arming; nothing left to turn to. |

Silent degradation to manual is always preferred over a confident wrong turn.

## Open questions

- False positive rate of the matcher on *real* recordings. The synthetic case
  passes, but rehearsal and performance being the same audio is the easiest
  possible test — it says nothing about a live performance matched against a
  rehearsal taken at a different tempo, dynamic, or room.
- Whether a repetitive piece defeats the matcher. The fixture was deliberately
  written non-repetitive; an eight-bar phrase played four times would make
  every page end sound alike, and only the arming window would separate them.
- Whether continuous scrolling is a better presentation than discrete page
  turns. Scrolling makes timing errors of a measure or two stop mattering, at
  the cost of departing from the printed page layout.
- Whether camera inference and microphone capture can run together on a phone
  without thermal throttling affecting audio.
