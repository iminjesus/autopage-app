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

### Changing the key

A chart with chord symbols in it gets a **Key** control in the Setup panel.
The chord symbols move; the notes on the staff do not, and a band across the
foot of the score says so — *Chords in Bb — staff still in Ab* — for as long
as it is true. The band reads the chords, so the chords are what moves; the
notation in the PDF is shapes at positions rather than pitches, and a staff
that is 95% transposed is worse than one nobody touched.

The key belongs to the score, so the next song in the set starts where it was
printed. Scores with no chord symbols never see the control.

A band appears over the score for a few seconds when the key moves, saying
where it went, and tapping it puts the chart back. It does not stay: a warning
left on screen through a whole service is clutter, and clutter is what gets a
feature turned off. What stays is the control, which says the key and says
in words that only the chords moved.

**Thumbs up raises the key a tone**, for the last chorus with both hands busy.
From E and from B it raises a semitone instead — E to F, B to C — because up
a tone from those lands in F# and C#, six and seven sharps, which is not a
chart anybody hands a band on a Sunday. Thumbing up from C therefore walks
C D E F G A B. It can be switched off.
Hold it for about a second; put your hand down before the next one. Thumbs
down lowers it by a *semitone*, and can be switched off — the lopsidedness is
deliberate, because up is a tone almost every time and down is the rarer,
smaller correction. The band says where the key went and puts it back if you tap it.

It is off until you turn it on, and only offered on a chart that has chords.
Turning it on fetches an 8MB hand model once, which then belongs to the
device like the face one. It reads the camera six times a second against the
face model's thirty: measured at 22fps for the face with it running, against
29fps without, which is well inside what the page turn needs.

If the camera is paused or taken by something else, the app notices within a
couple of seconds and starts it again — and says so if it cannot.

A tilt is measured from **where your head rests**, not from level — the app
watches where you sit and follows it, so a stand off to one side or a shift in
the chair does not make one direction harder than the other. About **10 degrees,
held briefly**, in either direction. Every gate is in milliseconds rather than
frames, so a busy iPad dropping to 12fps turns pages the same as one at 30.

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
   with no wifi on it is fine. The app says this itself on a first visit, with
   the two steps written out, because Safari offers no install prompt of its own
   and nothing otherwise appears.
3. **Open a PDF, or press "try a sample score".** A four-page minuet is bundled,
   so there is nothing to find before you can see whether the gesture works on
   your face. **Calibrate** is on the same screen, with a line under it saying
   whether one is already saved — it is kept on the device and only needs doing
   once.

**Select a Sunday's songs together** and they are kept together, as a set named
for the day — "Nov 21", in the order they are numbered. Open one score on its
own and it sits under "Other". The last four sets are kept, and six loose
scores beside them; both the first screen and the Setup panel show every score
as its own first page to choose between.

A **−** in the corner of a thumbnail forgets that one, and the **−** beside a
set's name forgets the whole Sunday — either way with a few seconds to undo it.
Each score keeps its own page, so coming back to one comes back to where you
left it, and a song that appears in two Sundays is still one entry with one
bookmark. A score is identified by its contents rather than its filename: the
same piece arriving as "score.pdf" from three different places is one entry,
not three that disagree.

### Publishing the Google sign-in

The consent screen starts in **Testing**, where only people added under *Test
users* can sign in — everyone else gets `Error 403: access_denied`, which says
the app "has not completed the Google verification process". That wording is
about the publishing status, not about the scope.

- **To let somebody in today:** add their Google address under *Test users*.
  The cap is 100.
**It is published.** Status *In production*, which took filling in the Branding
page — app name, support email, the home page and `privacy.html`, and
`iminjesus.github.io` as the authorized domain — and pressing *Publish app*.

Two things that were expected to be in the way were not. `github.io` is
rejected as an authorized domain, being a public suffix nobody can prove they
own, but **`iminjesus.github.io` is accepted**, so no custom domain is needed.
And `drive.file` being non-sensitive meant no scope review and no security
assessment. No Search Console verification was asked for either.

The **OAuth user cap** on that page does not apply here: it counts users
granting *unapproved sensitive or restricted* scopes, and this app asks for
neither.

Do not upload an app logo. That triggers brand verification, which is a
separate review measured in weeks, and nothing needs it.

### Opening a Sunday out of Google Drive

**Google Drive** on the first screen, or **Open from Google Drive** in the
Setup panel. Sign in, **go into the Sunday's folder and select the songs**, and
they arrive as one set, named after the folder they came out of.

After the first time, the picker **opens inside the folder the Sundays live
in**, so next week's is already on screen rather than somewhere down a shared
drive. It is checked before it is used: a folder that has been moved or
unshared is forgotten rather than opening the picker on an empty view.

**Choosing a folder means "go in there."** Under `drive.file` Google hands over
a selected folder and nothing inside it — tried against a real shared drive,
and refused — so the app reopens the picker *inside* the folder instead, and
the songs are chosen there. Listing a folder is the thing that is refused;
showing it to somebody in Google's own picker never needed permission at all,
and the app never asks Drive to list anything.

The folder's *name* is asked for, which is one question Drive usually will
answer; if it will not, the set is named for the day.

**The picker reopens after every song.** Google's picker will not multi-select
on a phone, so tapping a song sends you straight back into the same folder for
the next one — two taps a song, and **closing the picker is what says you are
finished**. Its title keeps the count and says so.

Afterwards the toast says what the Sunday has — "Nov 29 — 3 songs" — with
**Add more**, for coming back to it later. One song is still just a score; the
Sunday is made once there are two to make it out of.

The only permission asked for is **`drive.file`** — the songs you hand over in
the picker, and nothing else in the drive. It is a non-sensitive scope, so
there is no Google review and no security assessment behind it.

Once the songs are downloaded they belong to the device: they go into the same
store as a score opened off the iPad, so **a wifi that dies mid-service costs
nothing**. Google's scripts are only fetched when somebody asks for Drive, and
never at startup, so the offline path is untouched by any of this. The sign-in
token is held in memory and is gone on reload.

Opening it on a laptop shows a QR code instead: point the iPad's camera at it
and carry on there.

### Handing it to somebody

`share.html` is a card with the code on it, one line on how to use the app, and
the two install steps drawn below — scan, then Share → Add to Home Screen. Print
it, or hold up the screen. It reads the address from wherever it is served, so
there is no URL to keep in step by hand, and "Card to share" in the Setup panel
opens it.

It exists because **iOS cannot do the thing you actually want**, which is for a
scan to put an icon on the home screen. No web page can install itself there:
there is no API, `beforeinstallprompt` is Chrome's and Safari does not implement
it, and a QR code only opens a URL. The two steps are unavoidable, so the aim is
that nobody has to be *told* them out loud.

Inside the app the same offer waits for the second visit. Someone who has just
scanned a code does not yet know what this is, the app runs perfectly well from
a tab, and handing a stranger homework before they have seen it work costs more
than the install is worth. Coming back is the signal. "Add to Home Screen" also
sits in the Setup panel for good, since a returning player opens straight into
their score and never sees the first screen again.

### Picking up a new version

A home-screen app has no address bar, so it has no reload button and no way to
ask for one — the only route is to force quit it from the app switcher, which is
obscure enough that in practice a new version never arrives. **"Check for an
update"** in the Setup panel does it from inside: it asks for a fresh service
worker and reloads. The build string on the diagnostics line says which version
is running, so there is something to compare against.

The score and the page you were on survive it.

### Working with no signal

A rehearsal room with no signal is a normal place to open a score, so this is a
requirement, not a nicety. Three things have to be on the device: the app shell,
the score, and the 13MB face model behind the gesture.

The shell is precached by the service worker on install. The score lives in
IndexedDB from the moment it is opened. The model is the one that needs care —
it is deliberately **not** fetched on the landing screen, because someone
opening the link to look at it should not pay 14MB before seeing anything, and
that made the link too expensive to hand to anyone. It is fetched the moment
there is a reason: a score being opened, or the app running from the home
screen, which is the case where the next launch may have no network at all.
"Save for offline" in the Setup panel does it on demand, and the panel says
plainly which state you are in rather than leaving it to be discovered at the
worst moment.

Then there is the condition that actually bites, which is not "offline". A wifi
that is connected but no longer routes, or a captive portal waiting for a login
nobody will give it, leaves `fetch` hanging rather than failing — a plain
network-first worker sits on that with a blank screen. So the network gets two
and a half seconds and then loses to whatever is already on the device, and the
first request to time out settles it for the rest of the load instead of each
file paying separately. That one change took a dead-wifi start from 10.2s to
2.7s; `tools/offline.mjs` measures it, along with plane mode and a cold visit.

One thing worth knowing: Safari clears unused site data after about a week, and
a home-screen app is not subject to that. Another reason to add it rather than
leave it in a tab.

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
