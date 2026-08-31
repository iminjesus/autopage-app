# Decisions

Why the obvious approaches were not taken. Each of these was considered and
rejected for a specific reason, not overlooked.

## Reading the PDF, but not optical music recognition

These are not the same thing, and conflating them cost this project a design
iteration. OMR exists because a *scanned* score is pixels: the structure was
thrown away and has to be inferred back. A PDF exported from notation software
never lost it — staff lines, barlines and glyphs are still discrete drawing
operations with coordinates. Reading those is parsing, and it is exact.

Counting measures per page needs about eighty lines and no model. That is what
the app does, and it is why there is no setup step.

Full OMR remains rejected for scanned scores:

- Accuracy varies with engraving quality, and handwritten scores are poor.
- Errors need a correction UI, which is where most of the effort in such a
  project ends up going.
- OMR cannot run in the browser, so it forces a preprocessing service into the
  architecture and breaks the offline PWA model.
- An OMR error is not a one-time setup annoyance. A misrecognized measure
  becomes a spot that misaligns **every single time** that passage is played.

A scanned score therefore gets manual turning, and says so. Extending the
vector reader from barlines to noteheads is the path to knowing what each page
*sounds* like — which would let the audio matcher work on a score it has never
heard, with no run-through at all.

## Not general score following

Real-time audio-to-score alignment (online DTW, or an HMM) gives continuous
position. It is the right tool if you want to highlight the current measure.
For turning pages it is overkill: the app needs one binary decision per page.

It also fails in a specific way that matters. Online DTW searches a local band
around the current estimate, so it handles wrong notes and rubato well but
cannot follow a jump — especially a jump *backwards*, which is what happens
constantly while practicing. Recovering from that needs global re-localization,
which is a project of its own.

Restricting scope to performance sidesteps this entirely: performances run
start to finish, in order, at a stable tempo.

## Not staff or barline detection

Detecting staff systems by horizontal pixel projection, and barlines by
vertical runs within a system, is quite tractable on printed scores. It was the
plan while the goal was still "highlight the current measure."

Once the goal narrowed to "turn at the last measure," it became unnecessary.
The trigger is an audio event; the app never needs to know where anything is on
the page. The renderer just draws.

## Not metronome dead reckoning alone

Counting measures from tempo and time signature is nearly free, and it is used
here — but only to open a detection window, never to trigger a turn. Alone it
drifts: a player who breathes, holds a fermata, or eases into a phrase will be
seconds off by the end of a page. Seconds are fine for arming a window; they
are not fine for deciding when to turn.

## Not gesture as the primary control

A face gesture is a perfectly good pedal replacement on its own, and it is the
lower-risk build. It is the complement rather than the primary because the goal
is to not think about page turns at all. Gestures still require a deliberate
act at a musically inconvenient moment.

It stays always-live, bidirectional, and doubles as a resync — so the automatic
path can afford to be conservative.

## Not a rehearsal pass

The first working version asked the player to run the score once and tap at each
page end, which gave the matcher its templates. It worked, and it was wrong: a
per-score setup ritual is a pedal with extra steps, and the whole point was to
remove the pedal.

Reading the measures out of the PDF replaced it. The template capture survives,
but it now happens silently on every turn instead of being something to do.

## Not a tempo setting

There was a tempo field, and a tap-tempo button beside it. Both are gone.

Once the matcher drove the turns, the tempo only positioned the listening
window — and a test settled it: with the field left at 120 while the recording
played at 144, every turn still landed on the music. A control that can be 20%
wrong without changing the outcome is not a control, it is a chore.

The bar length is now measured instead. A page heard out from one turn to the
next spans its own length, so dividing by its measure count gives the tempo,
and the first page supplies it for the rest.

## Not a Bluetooth pedal

That is the thing being replaced. Pedal-style remotes send arrow keys, so the
app supports them anyway — it costs one keydown listener.
