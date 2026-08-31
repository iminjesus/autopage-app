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

> **Note.** The audio matcher, the schedule and the tempo measurement described
> below are not in the app at the moment. They worked — the measurements are
> real — but the gesture is what is being used, so they were taken out rather
> than left running. This section stays as the record of what was built and
> what it measured.

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

### every turn says where it came from

Three explanations for turning on head movement have been wrong in a row, each
of them plausible, and the reports that followed were necessarily vague — a page
had changed and there was no way to know which path changed it. So no path is
anonymous any more. Every turn is logged with its cause and the time: the audio
matcher, the schedule, a wink, a key, or the tap zones, which cover the outer
sixth of each side of the score and until now turned pages as silently as a
misread wink did.

A wink-fired turn also prints the nine frames leading up to it — both eyes, the
difference, head yaw and yaw swing — so a turn nobody asked for explains itself
after the fact, without anyone having to catch it happening.

### what the player sees

The score and a Setup chip in the corner. That is all.

There is no page counter over the music either. The score carries its own page
numbers, and a second one floating on top of it is one more thing between the
player and the only thing they are looking at.

Everything else is off screen until it is asked for. Calibration is not a thing
that happens each session — it is done once, and it belongs behind the chip with
the settings and the diagnostics. Live numbers over the score are for debugging
a detector, and reading them is not what anyone opened the app to do.

The one exception is the calibration prompts themselves, which appear at the
top edge while calibrating and nowhere else. That position is not decoration:
the camera is up there, and a prompt in the bottom corner asks the player to
look away from the lens at the moment the gesture is being measured.

An earlier version put a countdown over the score — "3 bars left" — and it was
worse than useless. A number
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
The lid landmarks have no such ambiguity — the gap between the lids is a
distance, and one eye's gap closing while the other's does not is unambiguous.
What counts as open is learned per eye rather than assumed, since it varies with
the person, the camera and the glasses.

**The eyes are measured against each other, not against a remembered value.**
The two eyes share a head: same distance from the camera, same angle, same
light. A ratio between them cancels every one of those, and none of it has to be
modelled, tracked, or corrected for.

Two earlier versions did try to model it. Dividing the lid gap by the eye's own
width failed under yaw, which foreshortens horizontal distances and not vertical
ones. Comparing each eye against a learned open-value for that eye failed
differently and worse: a learned reference can be wrong, and this one tracked the
largest gap seen with a twenty-second decay, so anything that briefly widened an
eye pinned its reference high and afterwards a perfectly open eye read as
closing. A reference 30% high reports 0.23 of asymmetry from two equally open
eyes — against a threshold that had to be low enough for a quick wink. Moving
the head sideways registered both eyes as 0.56 and 0.78 closed at once, which no
wink can do, and that is the shape of a reference problem rather than an eye one.

The ratio is `(gapR - gapL) / (gapR + gapL)`: zero when the eyes match however
open they are, near ±1 when one shuts. Face size cancels out of it entirely.

**A ratio alone is not enough, because a ratio between two small numbers is
noise.** Looking down at the keyboard lowers both lids, so both gaps shrink
together and a difference that means nothing becomes a large ratio: gaps of
0.008 and 0.013 read as 0.24, and 0.010 against 0.018 reads as 0.29, against a
threshold that has to be low enough for a real wink. Glancing down and back was
turning pages on exactly that. So the gap between the eyes must also be large
outright — a wink has one eye shut and the other wide, while the look-down cases
are all under 0.008. Both tests have to pass.

**Neither figure is a constant.** A first version fixed the gap at 0.02 of a
face height, taken from one set of numbers, and it stopped the gesture working
entirely: whether the winking eye reads as fully shut depends on the face, the
camera and the glasses, and on a face where it does not, no wink ever reaches
that. Calibration now measures the gap a wink actually produces and sets the
gate to a fraction of it. The uncalibrated defaults are chosen for the harder
case: a wink that only half closes scores 0.43 on the ratio, and a default of
0.45 rejected precisely that.

The hold counts votes over a window rather than demanding an unbroken run.
Demanding every frame is fine over two of them and impossible over fifteen —
landmark tracking drops a frame here and there, and at half a second that meant
never firing at all, which is how a working gesture stopped working the moment
the hold was lengthened. Three quarters of the window has to agree, so the
tolerance scales with the window instead of staying at "one dropped frame".

**Duration is the weakest of the three tests, so it carries the least.** It went
to 70ms when missed winks were the complaint, then to half a second when false
turns were, and half a second is genuinely tiresome to hold mid-piece. Neither
extreme was the answer, because duration was being asked to do work that shape
does better: the gap gate and the per-direction thresholds reject a look down
and a half-lidded eye on what they look like, not on how long they last. With
those carrying the load the hold sits at 200ms, settled by trying it rather than
reasoning about it: that is where it stops being noticeable while still being
longer than an accident. It fires after about 130ms of agreement, and it remains
a setting.

### testing the part with a face in it

A headless browser's fake camera contains a rolling pattern, not a face, so
everything past "is there a face" — the eye measure, both thresholds, the vote
counting, the turn — never ran in any test. Three changes in a row shipped
broken through that gap, each one reported as "it worked before and now nothing
happens".

`tools/face-path.mjs` closes it by feeding the pipeline landmarks it makes up:
the eleven points the app actually reads, arranged as a face, with lid gaps and
head angles set per case. It covers a held wink on each eye, a wink too short to
count, a wink that only half closes, a look down with both lids low, a head
shake, and two seconds of nothing. It found the half-closed wink being rejected
and, in its own first run, two mistakes in itself.

### eyebrows, when the eyelids cannot be read

Behind glasses the eyelid measure runs out. A lens rim sits exactly where the
lid contour is and reflections wash out the lower lid, so the landmarks it
depends on are obstructed rather than merely noisy — no threshold reaches past
that, and calibrating with the glasses on only makes it intermittent.

Brows are above the lenses. They are unobstructed, high contrast, and they do
not move on their own while playing. Raising them turns forward.

Frowning does not work for going back, and for the same reason winking does not:
the frame sits exactly where the brow travels down to, and the score for it is
the weaker half of the pair to begin with. Going back is a **head tilt** — the
angle of the line between the eyes, which is geometry with no lens anywhere
near it.

A tilt has to be deliberate to count, and angle alone does not establish that.
Players move their heads constantly — nodding to the beat, leaning into a
phrase — and expression reaches the same angles a command does.

Nodding is free: it is pitch, and pitch does not change the angle between the
eyes at all, so it is invisible to this measure. Leaning sideways is not free,
and is separated by **speed**. A lean for expression drifts in over a second or
more; a tilt meant as a command arrives in about a third of one. Measured
against both, inside a 300ms window: an expressive lean to 20 degrees over 1.5s
moves 3.6 degrees, one to 25 degrees over 2.5s moves 2.7, and a deliberate tilt
to 20 degrees moves 11 to 18. The requirement is seventeen degrees of angle and
eight degrees of change within 300ms, and both have to hold.

The test pins all of it: leans of seven, ten and fourteen degrees held for two
seconds turn nothing, expressive leans to twenty and twenty-five degrees turn
nothing, and a deliberate tilt over 0.3s turns back.

This one uses the model's expression scores rather than geometry, and that is
consistent rather than contradictory: the scores failed for winking because they
could not resolve *which* eye was closing. Both brows move together, so there is
nothing to resolve — it is the case the scores are good at, and there is no
reference to learn or drift.

Which gesture is in use is a setting, and a calibration belongs to the gesture
it was measured on: the panel says so rather than applying wink numbers to brows.

### calibration — the part that is not optional

Thresholds cannot be constants. What a wink looks like through one person's
glasses under their lighting is not what it looks like through another's, and
the only honest way to know whether this works for someone is to measure it on
their face and show them the number.

It is done once. The result is stored in the browser and survives reloads, new
tabs and restarts — verified, not assumed. It is per browser and per origin, so
serving the app on a different port is a different store, and a private window
forgets it on close. Exactly one rule decides whether a calibration is usable, and it runs when the
calibration is made. A second, stricter rule on the load path meant a result
could be accepted, shown as saved, and then silently thrown away on the next
load — which is indistinguishable from calibration not persisting at all, and
was reported as exactly that. Load now only checks that a calibration came from
the current measurement scale, and says so when it discards one that did not.

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
