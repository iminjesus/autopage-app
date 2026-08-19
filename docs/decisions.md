# Decisions

Why the obvious approaches were not taken. Each of these was considered and
rejected for a specific reason, not overlooked.

## Not optical music recognition

The intuitive design is: convert the PDF to a symbolic score, then follow the
performance against it. OMR (Audiveris, oemer) can do the conversion, but:

- Accuracy varies with engraving quality, and handwritten scores are poor.
- Errors need a correction UI, which is where most of the effort in such a
  project ends up going.
- OMR cannot run in the browser, so it forces a preprocessing service into the
  architecture and breaks the offline PWA model.
- An OMR error is not a one-time setup annoyance. A misrecognized measure
  becomes a spot that misaligns **every single time** that passage is played.

The rehearsal-template approach removes all of this. If the app ever needs to
work on a score sight-unseen, with no rehearsal pass, OMR comes back onto the
table — but only for the last few measures of each page, which would cut the
correction burden by an order of magnitude.

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

## Not a Bluetooth pedal

That is the thing being replaced. Pedal-style remotes send arrow keys, so the
app supports them anyway — it costs one keydown listener.
