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

Measures times bar length is the page's length, and the bar length is measured,
not entered. A page heard out from one early turn to the next spans exactly its
own length, so its duration divided by its measures is the bar length. Until a
page has been timed the window covers most of the page instead of pretending to
know where the ending is; afterwards it tightens to a couple of bars.

The anchor resets at every turn, automatic or manual, so error cannot
accumulate across pages.

It counts **played** time, not wall time. Nothing starts until the first note is
heard, and the clock stops advancing whenever the instrument falls silent, so a
page cannot turn under a player who is sitting still.

Playing is judged by whether the sound has pitch, not by how loud it is. Every
level-based gate eventually decides that a quiet room's own floor is a
performance — that is what a first attempt did. Broadband noise spreads evenly
across the twelve pitch classes, so its chroma is flat: measured at 0.40 for
hiss and hum against 0.94 for played notes, where a perfectly flat vector is
0.29. The threshold sits at 0.55.

Random noise lands on one pitch class often enough to clear any threshold for a
single frame, so a note must hold for three frames — 300ms — to count. A played
note lasts far longer than that; a spike in hiss does not.

Silence shorter than a second is a rest, not a stop — but only after something
has actually sounded, or the grace period itself starts the clock in an empty
room.

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

Measured against the fixture: a page's template scores ~0.88 at that page's
ending, ~0.50 typically and ~0.70 at worst elsewhere. The threshold sits at 0.8
and the match must hold two frames.

Those two numbers were tuned from a failure, not guessed. At three frames and
0.85 the detector missed pages outright when the performance ran 20% off the
window's expectation: the peak is only a couple of frames wide, and a longer
confident run simply is not there to be found.

**Hearing the page's ending is the only thing that turns it.** A clock cannot
tell this piece from a different one, so letting it turn on time alone means any
playing at all advances the score — including the wrong piece, and including a
room that merely sounds busy. Measured: a recording with identical rhythm and
every pitch moved a semitone turns nothing at all.

Pages the reader could not parse have no such test, and those alone fall back to
turning on time.

Two details matter more than they look:

- **Templates span several seconds, not one measure.** A single measure of
  repeated tonic chords is not distinctive enough to locate against neighbours.
- **Alignment cost is divided by path length, not template length.** Dividing by
  template length makes a compressed alignment cheap, and it fires early.

Precision is bounded by harmonic rhythm: chroma cannot resolve time inside a
held chord, so a page ending on a dotted half is locatable to about a second.
For a page turn, early is the safe direction anyway.

### what the player sees

The page number, the mode, and a dot that appears while the detector is
listening for this page's ending. That is all.

There was a countdown — "3 bars left" — and it was worse than useless. A number
ticking down in the corner is something to watch, and the one thing a player
must not be doing mid-piece is watching the app. It also described the schedule,
which is no longer what turns the page, so it invited exactly the wrong mental
model. Bars remaining is now diagnostics, in the panel, out of the way.

### gesture — winking to turn

A normal blink is symmetric; a wink is not. So the signal is the *difference*
between the eyes, never how shut either one is.

That difference is measured from **eyelid geometry**, not from the model's
blink scores. The blink scores were the first attempt and they do not resolve
which eye is closing: on a real face, winking moved both scores up together and
the difference peaked at 0.09 while each score reached 0.5. No threshold
survives a signal that small, and several rounds were spent tuning against it.
The lid landmarks have no such ambiguity — the gap between the lids over the
width of the eye is a distance, near 0.3 open and near 0.05 shut, and one eye's
gap closing while the other's does not is unambiguous. What counts as open is
learned per eye rather than assumed, since it varies with the person, the
camera and the glasses. That is what makes it survive
the conditions that break absolute measures — glasses reflecting the screen,
stage lighting, someone squinting at a hard passage — because all of those
affect both eyes together and cancel out of a difference.

Right eye forward, left eye back. Back matters at least as much: it is the
recovery path when a page turns at the wrong moment.

A wink fires once. Holding it a beat too long is the most natural thing in the
world, and a gesture that repeats every cooldown while the eye stays shut would
turn several pages for one wink — so the eye has to open again before the next
one counts.

The threshold sat halfway between blink noise and a full wink, which a quick
wink never reaches because the eye does not fully close. A third of the way up
still clears blink noise by two and a half times, and the asymmetry is what does
the rejecting anyway — the height of the bar was never doing that work.

How long the wink must be held is a **setting**, not a constant. Two rounds of
guessing at it from outside — 400ms, then 150ms — both came back too slow from
the only place that can judge it, which is someone's actual face. Sampling runs
at 30fps so the required length can go as low as two frames, and two frames is
kept as the floor so a single glitched frame can never turn a page. The default
is 70ms, which lands on that floor.

Head nods and plain blinks are disqualified outright — musicians do both
constantly. The gesture must be something that does not occur while playing,
and a unilateral eye closure is almost always deliberate.

**A head shake is separable from a wink, and not by tuning.** Shaking sweeps the
yaw back and forth; a wink does not move the head at all. So the veto is on yaw
*travel* within 150ms, which has nothing to do with how long or how hard the
wink is — making the gesture easier to trigger costs nothing here, where every
threshold change would have traded one problem for the other.

Swept against simulated shakes from 0.8 to 2Hz and playing sway up to 0.5Hz:
0.12 inter-eye widths is the only value that vetoes every shake and no sway.
Sway travels slowly enough that little of it lands inside the window; a shake is
mostly travel.

**Slow drift is still unsolved.** Turning the head hides part of one eye from the
camera and the model reports that as the eye closing, so the difference rises
with nobody having winked, and ordinary swaying turns pages.

Two corrections were tried and both were removed. Ignoring frames while the head
moved would have made the gesture unusable — a musician moves constantly.
Subtracting a slow baseline was tuned against simulated head turns and simulated
winks, and against a real face it absorbed the wink along with the movement:
the net signal sat at 0.00 while a wink was in progress.

The common fault is that both were designed against a guess at the signal
rather than the signal. What is in place now is instrumentation — held peaks
for each eye and the difference, plus head yaw and per-frame motion, none of
which gate anything. The next attempt gets built from what those show.

The threshold sat halfway between blink noise and a full wink, which a quick
wink never reaches because the eye does not fully close. A third of the way up
still clears blink noise by two and a half times, and the asymmetry is what does
the rejecting anyway — the height of the bar was never doing that work.

How long the wink must be held is a **setting**, not a constant. Two rounds of
guessing at it from outside — 400ms, then 150ms — both came back too slow from
the only place that can judge it, which is someone's actual face. Sampling runs
at 30fps so the required length can go as low as two frames, and two frames is
kept as the floor so a single glitched frame can never turn a page. The default
is 70ms, which lands on that floor.

Head nods and plain blinks are disqualified outright — musicians do both
constantly. The gesture must be something that does not occur while playing,
and a unilateral eye closure is almost always deliberate.

**Movement is subtracted, not refused.** Turning the head hides part of one eye
from the camera and the model reports that as the eye closing, so the difference
rises with nobody having winked — which had ordinary swaying turning pages. The
first fix was to ignore frames while the head moved, and that was wrong: a
musician moves constantly, and a gesture that only works while sitting rigidly
is not a gesture. What actually separates the two is speed. A head turn drifts
over a second or more; a wink is a spike. So the difference has a slow baseline
tracked and subtracted from it, and only what the baseline cannot follow counts.
The baseline freezes while a candidate is in progress so it cannot chase the
gesture it exists to reveal.

Swept against simulated turns, sway at two rates, and winks from 80 to 160ms:
with a 0.3s baseline, a head turn nets 0.12 and sway nets 0.22 against a
threshold of 0.39, while the weakest wink tested nets 0.55. The remaining pose
limits only exclude a head turned right away from the score.

Face landmarks run locally: no video leaves the device, and nothing is fetched
from a network. The runtime and model are 13MB, so they are imported only when
the gesture is switched on — someone who never uses it never pays for it.
Inference runs at 12 frames a second, which is ample for a 400ms hold and a
fraction of the cost of running at video rate.

### calibration — the part that is not optional

Thresholds cannot be constants. What a wink looks like through one person's
glasses under their lighting is not what it looks like through another's, and
the only honest way to know whether this works for someone is to measure it on
their face and show them the number.

It is done once. The result is stored in the browser and survives reloads, new
tabs and restarts — verified, not assumed. It is per browser and per origin, so
serving the app on a different port is a different store, and a private window
forgets it on close. A calibration whose wink levels look like noise is
discarded on load rather than obeyed, which also clears anything saved by the
blink-score version, whose numbers mean nothing on the eyelid scale.

Three phases: blink normally, wink right and hold, wink left and hold. Normal
blinking establishes the asymmetry this has to clear — the noise floor — and
the winks establish the signal. The result is reported as a separation ratio,
and below about 1.5 the app says plainly that it is not reliable here and points
at the pedal, the tap zones and the arrow keys instead of pretending.

Two things the calibration got wrong on its first run against a real face, both
of which made a perfectly good wink look like no wink at all:

- The left-eye level was negated twice, so a clean left wink came back as a
  large *negative* number and the smaller of the two levels — which is what
  decides the verdict — became meaningless.
- The level was read at the 90th percentile of a six-second phase. Against a
  synthetic hold of a known 0.85, half a second of winking reads 0.08 there,
  because nine tenths of the window is the pauses between winks. The mean of
  the top tenth reads 0.75 and holds up as the hold lengthens.

Which sign means which eye is no longer assumed either. Cameras mirror, front
and rear cameras differ, and the model's "left" is the subject's left rather
than the viewer's — three chances to have it backwards. Calibration records
which way each wink actually moved the difference and stores that.

The live readout now shows both eyes separately, because "the model cannot see
my wink" and "the threshold is wrong" are different problems that looked
identical from a single number.

**Still unverified end to end.** There is no camera and no face in the
environment this was written in. The pipeline is confirmed to load from local
files, initialise, process frames, and correctly report no face when there is
none. Whether a wink clears a blink through a given pair of glasses is what the
calibration screen exists to answer, on the user's own face.

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
| Performance faster or slower than written | The match fires on the music. Measured 20% fast, every turn still came from audio. |
| Matcher misses on a readable page | Nothing turns. The player uses a gesture or a tap. |
| Page the reader could not parse | Falls back to turning on time. |
| A different piece is played | Nothing turns; the match never rises. |
| Room is noisy but nobody is playing | Nothing turns, and the clock never starts. |
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
- Whether the first page is safe with its wide window. Until a page has been
  timed the detector listens across most of the page, which is the one stretch
  where a false positive has room to happen.
- Whether a repetitive piece defeats the matcher. The fixture was deliberately
  written non-repetitive; an eight-bar phrase played four times would make
  every page end sound alike, and only the arming window would separate them.
- Whether continuous scrolling is a better presentation than discrete page
  turns. Scrolling makes timing errors of a measure or two stop mattering, at
  the cost of departing from the printed page layout.
- Whether camera inference and microphone capture can run together on a phone
  without thermal throttling affecting audio.
