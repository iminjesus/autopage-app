// Moving chord symbols to another key.
//
// Pure arithmetic over note names, so this one needs no browser and runs in a
// blink. The cases that matter are not the obvious ones: a chart moved into a
// flat key must come back spelled with flats, because Eb written as D# is a
// chart nobody wants to read at speed, and a capital letter in the lyrics must
// not come back as a chord.
import { transposeChord, keyName, spelling, parseChord } from "../transpose.js";

let bad = 0;
const is = (got, want, what) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (wanted ${want})`}`);
};

// --- D to E, which is the request that started this ------------------------
const up2 = (c) => transposeChord(c, 2, spelling("D", 2));
is(up2("D"), "E", "D up a tone");
is(up2("A"), "B", "A up a tone");
is(up2("Bm"), "C#m", "Bm up a tone");
is(up2("D/F#"), "E/G#", "a slash chord moves both halves");
is(up2("Gmaj7"), "Amaj7", "the quality is carried over untouched");
is(up2("A7sus4"), "B7sus4", "and so is a suspension");
is(up2("G(sus4)"), "A(sus4)", "including one in brackets, as engravers write it");

// --- Spelling, which is the part that looks wrong if it is wrong -----------
const down1 = (c) => transposeChord(c, -1, spelling("E", -1));
is(down1("E"), "Eb", "a chart moved into Eb says Eb, not D#");
is(down1("A"), "Ab", "and Ab, not G#");
is(down1("C#m"), "Cm", "C#m down a semitone");

const up1 = (c) => transposeChord(c, 1, spelling("D", 1));
is(up1("D"), "Eb", "D up a semitone lands in Eb, not D#");
is(up1("B"), "C", "and B goes to C, not B#");

is(transposeChord("B", 2, false), "C#", "B up a tone wraps round the octave");
is(transposeChord("C", -1, true), "B", "and C down a semitone wraps the other way");

// --- The twelve keys, as a worship chart names them ------------------------
//
// C Db D Eb E F Gb G Ab A Bb B. There is no key of D# or F#, and this is the
// list a musician picks from in SongSelect, so it is the list that has to come
// out of here. Five keys take sharps and seven take flats; that is the key
// signature rather than a preference, and it settles the chords inside the
// chart as much as the name on the front.
const KEYS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
is(Array.from({ length: 12 }, (_, i) => keyName("C", i)).join(" "), KEYS.join(" "),
  "the twelve keys, up from C");
is(Array.from({ length: 12 }, (_, i) => keyName("C", i - 11)).join(" "),
  KEYS.map((_, i) => KEYS[(i + 1) % 12]).join(" "),
  "and the same twelve going down");

// And the twelve minor keys, which are not the major list with an m on the
// end. The same black key is Db as a major and C#m as a minor, because a
// minor key takes its accidentals from its relative major — Db major has five
// flats, C# minor has four sharps, and no musician writes Db minor.
const MINORS = ["Am", "Bbm", "Bm", "Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m"];
is(Array.from({ length: 12 }, (_, i) => keyName("Am", i)).join(" "), MINORS.join(" "),
  "the twelve minor keys, up from Am");
is(keyName("C", 1), "Db", "the same black key is Db as a major");
is(keyName("Am", 4), "C#m", "and C#m as a minor");

// The chords inside each key have to agree with the name on the front: D
// major takes F#m and F major takes Bb, and a musician notices that first.
const inKey = (n) => ["C", "Dm", "Em", "F", "G", "Am"]
  .map((c) => transposeChord(c, n, spelling("C", n))).join(" ");
is(inKey(2), "D Em F#m G A Bm", "D major is spelled with sharps");
is(inKey(5), "F Gm Am Bb C Dm", "F major is spelled with flats");
is(inKey(3), "Eb Fm Gm Ab Bb Cm", "and so is Eb");
is(inKey(1), "Db Ebm Fm Gb Ab Bbm", "and Db");
is(inKey(9), "A Bm C#m D E F#m", "A major is sharps");
is(inKey(11), "B C#m D#m E F# G#m", "and B");

// Inside a key is not the same question as naming one. There is no key of
// D#, but D#m is the right way to write the fifth chord of G# minor.
const inMinor = (n) => ["Am", "Dm", "Em"]
  .map((c) => transposeChord(c, n, spelling("Am", n))).join(" ");
is(inMinor(11), "G#m C#m D#m", "G# minor takes D#m, key or no key");
is(inMinor(6), "Ebm Abm Bbm", "and Eb minor takes flats throughout");

// --- Naming the key it ended up in -----------------------------------------
is(keyName("D", 2), "E", "the key is read off the first chord");
is(keyName("Em", 2), "F#m", "a minor chart stays minor");
is(keyName("Dm", -2), "Cm", "Dm down a tone");
is(keyName("Em", 1), "Fm", "a minor key is spelled from its relative major");
is(keyName("Fm", 2), "Gm", "and a minor chart keeps its own root");
is(keyName("What", 2), null, "a chart whose first text is not a chord has no key to name");

// --- Everything that is not a chord ----------------------------------------
//
// A lead sheet is mostly words, and several of them start with a capital
// letter that is also a note name. Touching one of those would be worse than
// not transposing at all.
for (const word of ["What", "blood", "Verse", "Bridge", "Chorus", "the", "2.Though", "Am-en", "Ending"]) {
  is(transposeChord(word, 2, false), null, `left alone: ${word}`);
}
// But the real ones still have to come through.
for (const chord of ["A", "Am", "F#m7", "Bb", "C/E", "Dm7", "G(sus4)", "Eø", "C°"]) {
  is(parseChord(chord) !== null, true, `read as a chord: ${chord}`);
}

// --- Moving by nothing changes nothing -------------------------------------
//
// Including the spelling. A chart opened and not yet transposed must look
// exactly as it was printed: finding that Bb has quietly become A# before
// anybody asked for anything is a bug whatever the theory says about the key.
for (const chord of ["D", "F#m7", "Bb/D", "Db", "A#m"]) {
  is(transposeChord(chord, 0, spelling("D", 0)), chord, `unmoved: ${chord}`);
  is(transposeChord(chord, 12, true), chord, `unmoved by a whole octave: ${chord}`);
}

console.log(bad ? `${bad} FAILED` : "chords land in the right key, spelled the way it is written");
process.exit(bad ? 1 : 0);
