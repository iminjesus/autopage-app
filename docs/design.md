# Design

## Problem

Turn the page of a PDF score at the right moment, hands-free, while the
musician is playing.

"The right moment" is the start of the last measure of the page — early enough
that the next page's opening bars are readable before they have to be played,
late enough that the current page is still visible while it is being finished.
The exact lead time varies with tempo, so it is configurable in measures rather
than seconds.

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

Given tempo, time signature, and the measure count of the current page, produce
an estimate of when the last measure begins. Open a detection window around it,
roughly ±3–4 seconds.

The estimate is deliberately weak. It does not need to be accurate, only
approximately right, because its job is to gate the matcher rather than to
trigger the turn. Two properties keep it good enough:

- Performance tempo is stable, so drift over one page (30–60s) stays within a
  few seconds.
- The estimate **resets at every page turn**, so error does not accumulate
  across the piece. Each page is an independent estimation problem.

Measure counts per page come from the rehearsal pass, not from analysing the
PDF.

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

Silent degradation to manual is always preferred over a confident wrong turn.

## Open questions

- False positive rate of the matcher inside the window, on real recordings.
  This is the project's only real technical risk and should be measured before
  anything else is built.
- Detection latency versus measure duration at fast tempi — whether the lead
  time needs to extend to two measures.
- Whether continuous scrolling is a better presentation than discrete page
  turns. Scrolling makes timing errors of a measure or two stop mattering, at
  the cost of departing from the printed page layout.
- Whether camera inference and microphone capture can run together on a phone
  without thermal throttling affecting audio.
