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

One flat, dependency-free static site, same as its sibling project
`metronome-app`: `index.html` + `style.css` + `app.js`, no build step. The names
below are sections of `app.js`, not separate modules.

```
 PDF ──▶ score reader ──▶ measures/page ──┐
     └─▶ score view                       ▼
                                     schedule ──▶ turn
                                          ▲         ▲
 mic ──▶ chroma ──▶ matcher ──────────────┘         │
                      ▲                             │
          templates ──┘ (captured on each turn)     │
                                                    │
 camera ─────────▶ gesture ─────────────────────────┘
                   (fwd / back / resync)
```

### score reader — measures per page

Walk the page's operator list, tracking the transform stack, and collect every
straight segment. Then:

- **Staff lines** are horizontal segments longer than a third of the page. Sort
  their y positions and take runs of five with even spacing; each run is a
  staff, and four times the spacing is the staff height.
- **Systems** are staves joined by a vertical stroke that bridges the gap
  between them. Guessing from the size of the gap does not work — it varies with
  whatever is engraved in it — but a barline that physically crosses the gap is
  unambiguous. Without this, a piano score counts every barline twice.
- **Barlines** are vertical strokes at least 0.9 staff tall, inside a system's
  band. Shorter ones are stems. Strokes within 0.15 staff of each other merge,
  so a repeat sign counts once, and anything sitting on the left edge of the
  staff lines is the rule that opens the system, which closes no measure.

Scanned scores have none of this geometry. They report no staves and fall back
to manual turning rather than guessing.

### schedule — when the page runs out

Measures times beats-per-bar times seconds-per-beat is the page's length. The
anchor resets at every turn, automatic or manual, so error cannot accumulate
across pages.

It counts **played** time, not wall time. Nothing starts until the first note is
heard, and the clock stops advancing whenever the instrument falls silent, so a
page cannot turn under a player who is sitting still — reading ahead, tuning, or
just not started yet. Playing is judged against the room's own noise floor
rather than an absolute level, and silence shorter than a second is treated as a
rest rather than a stop.

Without a microphone there is nothing to wait for, so the clock starts when
Start is pressed and the tempo has to be right. The app says so.

The lead is subtracted **once**. After turning a bar early the anchor already
sits a bar before the new page's first bar, so each later page is exactly its
own length; subtracting the lead again would put the app another bar behind the
music on every page.

### note reader — what the page should sound like

Glyph codes are meaningless across files: an embedded subset font numbers its
glyphs from zero, so the brace font's glyph 0 and the music font's notehead are
both U+0 and unrelated. Everything is therefore keyed on font *and* code, and
classified by geometry:

- **Noteheads** are a little over one staff space wide. Dots are half that,
  clefs several times it, accidentals just under. Width alone is too close to
  call, so a class must also vary vertically — clefs and key signatures never do.
- **Clefs** sit on their own reference line, which fixes the pitch of the staff's
  bottom line: treble on the G line, bass on the F line, alto on middle C.
- **Key signatures** always start on the same letter — sharps on F, flats on B.
  Reading the run's direction instead fails on a signature of one, where there
  is no direction to read.
- **Sonorities** are noteheads sharing an x. Durations are ignored on purpose:
  the matcher warps time, so the order of the harmonies is all it needs.

Verified against a score whose notes are known exactly: every pitch on the
first and last page matches the source the engraving was generated from.

### matcher — where the music actually is

The expected chroma for a page's ending comes from the page, so the first run
through a score is already guided by the music. The template ends `leadBars`
before the page does, because matching the final chord would fire the turn when
the page is already over.

Measured against the fixture: a page's template scores ~0.90 at that page's
ending and ~0.50 elsewhere. The threshold sits at 0.85.

The schedule holds the outside of the window. If nothing matches by the time it
closes, the page turns anyway — a missed match must not strand the player.

Two details matter more than they look:

- **Templates span several seconds, not one measure.** A single measure of
  repeated tonic chords is not distinctive enough to locate against neighbours.
- **Alignment cost is divided by path length, not template length.** Dividing by
  template length makes a compressed alignment cheap, and it fires early.

Precision is bounded by harmonic rhythm: chroma cannot resolve time inside a
held chord, so a page ending on a dotted half is locatable to about a second.
For a page turn, early is the safe direction anyway.

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
| Nobody is playing | Nothing turns. The clock has not started. |
| Player stops mid-piece | The clock stops with them and resumes on the next note. |
| Scanned score, no staves found | Manual turning, stated plainly. |
| Tempo set wrong | The match still fires on the music. Measured at 17% off, turns moved under 0.15s. |
| Matcher misses | The schedule still turns the page. |
| Matcher fires early | Player uses the back gesture. Timing re-anchors. |
| Reached the last page | Schedule stops; nothing left to turn to. |

Silent degradation to manual is always preferred over a confident wrong turn.

## Open questions

- Whether the reader survives real scores. It is verified on LilyPond output
  only. MuseScore, Sibelius and Finale each engrave differently, and pickup
  bars, multi-bar rests, repeats and cadenzas all break the assumption that a
  barline count equals a measure count.
- Whether the matcher survives real *sound*. The fixture audio is synthesised
  from the same notes the score reader recovers, which flatters the match. A
  piano in a room, with pedal and an uneven touch, is the real test.
- Repeats and da capos, which the reader cannot see and the matcher would
  follow into the wrong page.
- Dropping the tempo field entirely by estimating it from onsets.
- Whether a repetitive piece defeats the matcher. The fixture was deliberately
  written non-repetitive; an eight-bar phrase played four times would make
  every page end sound alike, and only the arming window would separate them.
- Whether continuous scrolling is a better presentation than discrete page
  turns. Scrolling makes timing errors of a measure or two stop mattering, at
  the cost of departing from the printed page layout.
- Whether camera inference and microphone capture can run together on a phone
  without thermal throttling affecting audio.
