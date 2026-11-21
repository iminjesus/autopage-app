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

## Not a clock standing behind the matcher

The schedule used to turn the page when its window closed with no match, so a
missed detection would not strand the player. That is the wrong trade. A clock
knows how much time has passed while someone played; it has no idea *what* they
played. Under it, practising a different piece with the score open advances the
pages, and so does a room that merely sounds busy — both were reproduced.

Now a page whose ending the reader understood turns only when that ending is
heard. Missing a turn costs one tap. Turning on the wrong music costs the
performance, and quietly teaches the player that the thing cannot be trusted.

Pages the reader could not parse keep the old behaviour, because for those
there is nothing to match against and time is the only signal there is.

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

## The iPad is the target, so its constraints are the design

Everything here is a browser app, which makes "where does it run" feel like a
detail. It is not. On a stand, mid-piece, the player touches nothing — and that
is precisely the state an iPad interprets as "nobody is here", dims, and locks.
A page turner whose screen has gone dark is not a page turner, so the screen
wake lock is not a polish item; it is the first requirement, ahead of any
gesture. It is also not fire-and-forget: the system releases the lock on every
trip away from the app and hands back a dead handle, so it has to be asked for
again on return, and the panel reports whether it is actually held rather than
whether it was requested.

The rest follows from the same picture. The score is stored and reopened where
it was left, because picking a file out of iCloud Drive at the start of a piece
is the exact thing this app exists to avoid — and because that closes the loop,
a way to open a *different* score had to be added in the same change, since the
picker lived on an empty screen that would now never be seen. The tap zones stop
short of the home indicator, where a swipe leaves the app. And the tilt becomes
the default gesture on a touch device: at arm's length on a stand, an eyelid gap
is a handful of pixels and the angle between the eyes is almost unchanged.

## The landing screen was where people were being lost

A file picker was the only thing on it. To find out whether any of this works
you first had to go looking through iCloud Drive for a PDF, and a trip like that
is one most people do not come back from — the app was asking for commitment
before it had shown anything. So a four-page minuet ships with it and "Try it
with a sample score" is the first button: from a cold link to a working score
with a camera watching your face is now one tap.

The other half is that a browser tab is not the app. Run from the home screen it
is full screen, the score fills the iPad, and it is somewhere you can find
again. Safari has no install prompt to hook — `beforeinstallprompt` is Chrome's,
and on iOS nothing ever appears — so anyone who does not already know the Share
menu trick simply never installs. Writing the two steps out is the entire fix,
and it is the kind of thing that only looks unnecessary to someone who already
knows it.

A QR code carries the third case: the link arrives on a laptop and the iPad is
the device it is for. The encoder is vendored rather than fetched, like pdf.js
and for the same reason, and it is checked by decoding its own output rather
than by comparing pictures — two well-regarded reference encoders disagree with
each other on the same input and both are right, because the padding is free.
Comparing against one of them anyway did find three real bugs first: a generator
polynomial built in reverse, format bits laid down mirrored, and a penalty rule
that missed every pattern touching the edge of the symbol, which had the mask
chosen almost at random.

## Deferring the model was only safe once something guaranteed it arrived

A cold visit downloaded 14.11MB, of which 13.3 was the face model and its
runtime, because the camera started at boot. That is what the link cost to hand
to somebody — a blank screen and 14MB before they had seen anything, which is
the opposite of easy to distribute.

The obvious fix is to defer it, and the obvious fix is wrong on its own: a
rehearsal room with no signal is a normal place to open a score, and an app that
downloads its gesture lazily is an app whose gesture is missing exactly when it
matters. So the deferral only shipped alongside the guarantee. The model is
fetched the moment there is a reason to believe it will be wanted — a score
opened, or the app launched from the home screen, since nobody installs
something to look at it once — and the panel states which of the two conditions
holds rather than leaving it to be found out on a stand. Landing costs 0.50MB;
opening a score costs the rest.

The related discovery was that "offline" is not the hard case. A device with no
network fails fast and the cache answers. A wifi that is connected and going
nowhere leaves `fetch` hanging, and a network-first worker waits on it — twelve
files at two and a half seconds each, ten seconds of blank screen with someone
waiting to play. The network now loses to the disk after a grace period, and the
first timeout settles the verdict for the whole load rather than each file
re-learning it: 10.2s to 2.7s. None of this was visible from reading the code,
which is why `tools/offline.mjs` serves the app from a server it can tell to
stop answering — mocking it in the browser would have intercepted the requests
before the service worker ever saw them, which is the thing under test.

## A panel anchored to the bottom can push its own handle off the top

The settings panel grows upward from the bottom corner and had no ceiling. Fill
it the way a session fills it — the gesture description, the controls, the
twelve-line frame-by-frame dump of why the last page turned, the diagnostics —
and it grows past the top of the screen, taking its header with it. The header
is the only deliberate way to close it. Reported from an iPad as the panel
covering half the score with nothing to tap.

So it stops at the viewport and the body scrolls inside it, with the header
pinned. And below the viewport, at 72% of it, because filling the screen makes
"tap outside to close" an escape with nowhere to land — on a phone it reached
632px of 664. This is a score reader; the settings are what gives way. Tapping
outside closes it too, except while calibrating, where the countdown lives in
the panel and the gesture being measured would dismiss its own instructions.

Two things came out of fixing it. The screen wake lock was reported as `off` on
an iPad with a score open: one request when the score opens is not enough,
because the system takes the lock back on its own and does not give the handle
back. It is now re-requested on a touch, on returning to the app, and on a timer
while a score is open — and whether it is actually held is stated in words in
the panel rather than only in the diagnostics line, which is where things go to
not be noticed.

And the saved page number was being cleared as soon as the write was *started*
rather than when it landed. With the camera running that round trip can take
over a second, so swiping the app away right after a turn lost it. The flush on
the way out can now see a write still in flight.

## Tests should not know the build number of the browser

Every tool had the Chromium path written out down to `chromium-1194`. A new
container ships a different build and the entire suite goes red at once, for a
reason that has nothing to do with the app, on the day you most want to trust
it. `tools/browser.mjs` works it out instead, and the optional QR decoder is now
skipped with a note rather than failing when it is not installed.

Worth knowing about Playwright: `waitForFunction` with an async predicate
resolves on the Promise object, which is truthy, rather than awaiting it. A test
that polled IndexedDB that way reported a write as finished while the database
still said otherwise, and the failure landed three steps later where it looked
like a restore bug. Polling from the test process, where `evaluate` does await,
is the version that tells the truth.

## Fewer words on the screen than in the head

The interface had grown into an explanation of itself. The panel opened with a
five-line paragraph about what a tilt is and why it works, the calibration
result printed four thresholds and a sentence of interpretation, and the longest
thing in there was a twelve-line frame-by-frame dump of why the last page turned
— sitting above the controls, where it was the first thing anyone read.

All of that was true and most of it was written while debugging something. The
reasoning belongs here, in the repository; the screen gets the conclusion. The
tilt is now `Right 12° → forward · Left 12° → back · Flick it. A slow lean does
not count.` Calibration says `Calibrated. Good.` and puts its numbers in the
panel for the day they are needed. The frame dump moved down with the
diagnostics.

Two things moved rather than shrank. **Calibrate is on the first screen**, next
to Open PDF: it is the thing to do once before playing, and behind a settings
panel behind a score it was something you found only after the gesture had
already let you down. And beside it, in four words, whether one is already
saved — it always persisted, but that was visible only by opening the settings,
so the honest answer to "do I have to do this every time?" was yes as far as
anyone could tell.

Closed over a score, the panel is a gear and nothing else. A word floating on
the music is one more thing between the player and the only thing they are
looking at.

## A scan cannot install anything, so the card does the explaining

The wish was: scan a code, get an icon on the home screen, say nothing. On iOS
that does not exist. No web page can add itself to the home screen — there is no
API, `beforeinstallprompt` is Chrome's and Safari does not implement it, and a
QR code only ever opens a URL. The two taps are Apple's, and the only honest
options are to live with them or pay for the App Store.

So the work went into never having to say them. `share.html` is a card: the code
large, and beside it the two steps as a numbered picture with the actual Share
glyph, on a light background because a QR on a dark screen scans worse and this
is the one page meant for paper. It reads its own address from where it is
served, so there is no URL to keep in step by hand.

Inside the app the same offer moved off the arrival screen. It had been sitting
there from the first moment, competing with Open PDF — homework handed to
someone who does not yet know what this is, for a benefit (full screen, data
that Safari will not clear) they have no reason to want yet. It now waits for
the second visit, because coming back is the signal, and it lives permanently in
the Setup panel as well, since a returning player opens straight into their
score and never sees the first screen again.

The steps are drawn rather than described, and for any touch browser without an
install prompt rather than iOS alone: a paragraph about a button is worse than
an arrow pointing at it, and the arrow knows that Safari puts Share in the top
bar on an iPad and the bottom bar on a phone.

## A checkbox cannot say which one is the default

"Head tilt instead of wink", ticked, was the tilt — and it read as though the
wink were the normal state and the tilt an override you had switched on. An
unticked box always looks like the default, and the grammar said so too.

It is two named choices now, both visible, one of them lit: **Head tilt** (any
glasses) and **Wink** (no glasses). Nothing is phrased as instead-of anything.

The default is the tilt everywhere, not only on touch devices. The old rule gave
laptops the wink on the reasoning that a close-up face reads well either way,
which is true and beside the point: the app lives on a stand, the person setting
it up on a laptop is setting it up for that stand, and the tilt is the one that
survives glasses. The wink is a choice someone makes, not one they are handed.

## A phone showed three things an iPad never would

Reported from Android, from one screenshot: the panel's right-hand half off the
screen, type at roughly twice its size, "Open PDF" not reading as a button, and
the calibration instruction nowhere to be seen behind the camera preview.

The type was **Chrome's text inflation**. It enlarges text inside anything it
judges to be the main content of a page, independently of the CSS, and boxes
sized in pixels do not grow with it — so the panel's contents spilled out of a
320px card and the right-hand half went off screen. `text-size-adjust: 100%`
turns it off. The score is the content here and the panel is chrome; neither
wants a browser's opinion about reading size.

**"Open PDF" was right**, and adding a rim did not fix it: reported again,
unchanged. `#262b36` on the panel's `#171a21` is a contrast ratio of 1.23 — a
button on a desktop display indoors, nothing at all on a phone in daylight — and
a one-pixel rim at twelve per cent white does not rescue that. Opening a score
is the reason the panel gets opened most times, so it is the accent blue there
that it already was on the first screen, and the rest sit on a fill with a real
step in it.

The check that was supposed to catch this asked whether a button had *a*
background, and passed on the broken styling. It measures the contrast ratio
against the panel behind it now, and was confirmed to fail on the old colours
before the new ones went in — a check that has never been seen to fail is not
yet a check.

**The preview came before the prompt in the markup**, which on an iPad left
both visible and on a phone pushed the instruction for the step being measured
off the bottom of the card. The prompt is first now, and the preview is capped
at a quarter of the screen: you need to see your face once to know you are in
frame, and to read the prompt for the whole six seconds.

`tools/phone-fit.mjs` checks the consequences at three widths — nothing wider
than the screen, no sideways scroll, every button with a fill or a rim, and the
prompt on screen whenever the preview is. It cannot reproduce text inflation,
which is a browser heuristic rather than anything the page does.

## The camera card and the panel both wanted the same corner

The card floats at the top of the screen, because that is where the lens is.
The panel grows upward from the bottom corner. On an iPad they never meet. On a
phone the panel's top reached up behind the card — 73px of overlap at 412 wide,
117px at 360 — and the card is the higher layer, so the first thing it hid was
Open PDF, the button the panel is most often opened for.

Nothing in CSS can know how tall that card is: it depends on how the prompt
wraps and whether the preview is showing. So the app measures it and publishes
the lower edge as `--watch-bottom`, and the panel's ceiling is the smallest of
its three limits — the viewport, that edge, and 72%. A ResizeObserver keeps it
current, which is less work than finding every place the card changes size.

Checked by asking the question the report asked: does the card cover anything in
the panel. The check was put against the old layout first and reported `117px
over, hiding Open PDF` — the same thing the screenshot showed.

**That was not enough, and it was the wrong shape of fix.** Reported again, from
a phone with a browser's own bars taking a third of the screen, which is less
room than any measurement here had assumed. Arithmetic that has to come out
right on every device's chrome will eventually not, so the collision is gone
instead of being budgeted for: during calibration the panel folds to its gear
and the card carries the prompt, the preview and Cancel. That is the whole
interaction, in one place, at the top where the lens is — there is nothing left
underneath to cover. The card also sits 32px higher now, which was 44px of
allowance for a standalone iOS status bar that the safe-area inset already
handles.

## Five scores, chosen by looking at them

The store held exactly one score, under the key `last`. It holds five now,
each keyed by a **hash of its contents** rather than its filename — the same
piece arrives as `score.pdf` from three different places, and two copies of one
file should be one entry with one bookmark rather than two that disagree about
which page you are on. Anyone who already had the single-score shape has it
migrated on first load; making them find the file again would be a poor trade
for a tidier schema.

They are chosen by their own first page. A filename in a list is not a score
anyone recognises. The picture is taken once, when the score is opened, and
stored beside it — rendering five first pages at the moment the chooser is
drawn would mean parsing five PDFs on the screen whose whole job is to be quick.

The chooser appears in two places and hides itself when there is only one score,
because one score is not a choice. Two places because a remembered score opens
straight into itself, so the first screen stops being seen — the same reason
Add to Home Screen ended up in the panel as well.

Two tests had to change, and only one of them because the schema did. The other
claimed to check that "a different score can still be opened from the panel"
while handing it the same file back and asserting it landed on page 1. That
assertion stopped being true the day each score kept its own bookmark, which is
how it was noticed — it had never been testing what it said.
