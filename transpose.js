/**
 * Moving chord symbols to another key.
 *
 * Only the symbols. The notes on the staff stay exactly where they are, which
 * is honest about what this does: a singer asking for it a tone down wants the
 * chords the band reads, and on a lead sheet that is what the band is reading.
 * Anything that claimed to redraw the notation would be claiming far more.
 */

const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Which keys are written with flats. Not a preference — a chart in Eb that
// comes back saying D# is a chart nobody wants to read at speed.
const FLAT_KEYS = new Set([1, 3, 5, 8, 10]); // Db Eb F Ab Bb

/** A whole chord symbol and nothing else: no stray capital from the lyrics. */
export const CHORD_RE =
  /^([A-G])([#b♯♭]?)((?:maj|min|m|dim|aug|sus|add|°|ø|\+)?\d*(?:sus[24]|add\d+)?(?:\([^)]*\))?)(?:\/([A-G])([#b♯♭]?))?$/;

const semitone = (letter, accidental) => {
  const sharp = accidental === "#" || accidental === "♯";
  const flat = accidental === "b" || accidental === "♭";
  return (PITCH[letter] + (sharp ? 1 : 0) + (flat ? -1 : 0) + 12) % 12;
};

/** Pull a chord apart, or say it is not one. */
export function parseChord(text) {
  const m = CHORD_RE.exec(String(text ?? "").trim());
  if (!m) return null;
  const [, letter, accidental, quality, bassLetter, bassAccidental] = m;
  return {
    pitch: semitone(letter, accidental),
    quality: quality ?? "",
    bass: bassLetter ? semitone(bassLetter, bassAccidental) : null,
  };
}

const name = (pitch, flats) => (flats ? FLATS : SHARPS)[((pitch % 12) + 12) % 12];

/**
 * How the new key should be spelled.
 *
 * Taken from the first chord, because the first chord of a worship chart is
 * the key often enough to be worth more than asking. A minor first chord
 * points at its relative major, which is the key the accidentals belong to.
 */
export function spelling(firstChord, semitones) {
  const chord = parseChord(firstChord);
  if (!chord) return false;
  const minor = /^(m|min|ø|°|dim)/.test(chord.quality) && !/^maj/.test(chord.quality);
  const key = (chord.pitch + semitones + (minor ? 3 : 0) + 12) % 12;
  return FLAT_KEYS.has(key);
}

/** The same chord, that many semitones up. Returns null if it is not a chord. */
export function transposeChord(text, semitones, flats) {
  const chord = parseChord(text);
  if (!chord) return null;
  // A chart that has not moved must not be respelled. Opening one and finding
  // that Bb has quietly become A# before anybody asked for anything is a bug
  // whatever the theory says about the key.
  if (((semitones % 12) + 12) % 12 === 0) return String(text).trim();
  const root = name(chord.pitch + semitones, flats);
  const bass = chord.bass === null ? "" : `/${name(chord.bass + semitones, flats)}`;
  return `${root}${chord.quality}${bass}`;
}

/** What to call the key a chart has been moved to, for saying so on screen. */
export function keyName(firstChord, semitones) {
  const chord = parseChord(firstChord);
  if (!chord) return null;
  const flats = spelling(firstChord, semitones);
  const minor = /^(m|min)(?!aj)/.test(chord.quality);
  return `${name(chord.pitch + semitones, flats)}${minor ? "m" : ""}`;
}
