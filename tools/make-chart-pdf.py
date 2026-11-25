#!/usr/bin/env python3
"""A chord chart with real text in it, for the transposition probe.

Not a pretty one — it only has to be the shape the probe has to read: chord
symbols as their own text runs, sitting above a line of lyrics, with the
positions that an overlay would have to land on. A scanned chart has none of
that, which is exactly the difference being measured.
"""
import sys

# Chords packed as tightly as a real hymn sheet packs them. The spacing is
# the point: with neighbours this close, a patch that picks its colour from a
# single pixel beside the box lands on the next chord's ink and paints the
# gap black.
TIGHT = [
    (("Ab", 72), ("Db", 118), ("Ab/C", 162), ("Ab", 230), ("Ab/C", 272), ("Db/F", 334)),
    (("Guide", 72), ("me", 118), ("O", 162), ("Thou", 230), ("great", 272), ("Je", 334)),
    (("Ab", 72), ("Db/F", 112), ("Db", 168), ("Bbm7", 212), ("Ab/Eb", 268), ("Eb7", 330)),
    (("Pil-", 72), ("grim", 112), ("through", 168), ("this", 212), ("bar", 268), ("ren", 330)),
]

LINES = [
    (("C", 72), ("Am", 180), ("F", 300), ("G", 420)),
    (("What", 72), ("can", 150), ("wash", 215), ("a-", 300), ("way", 350), ("my", 420), ("sin", 470)),
    (("F", 72), ("C/E", 180), ("Dm7", 300), ("G(sus4)", 420)),
    (("Noth-", 72), ("ing", 150), ("but", 215), ("the", 300), ("blood", 350), ("of", 430), ("Je-sus", 470)),
    (("Bb", 72), ("F#m", 180), ("Gmaj7", 300), ("A7", 420)),
]


def build(rows=None, step=36) -> bytes:
    parts = []
    y = 700
    for row in (rows if rows is not None else LINES):
        size = 13 if row[0][0][0].isupper() and len(row[0][0]) <= 7 else 11
        for text, x in row:
            parts.append(f"BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET")
        y -= step
    content = ("\n".join(parts) + "\n").encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 540 760] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    start = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n"
    ).encode()
    return bytes(out)


if __name__ == "__main__":
    tight = "--tight" in sys.argv
    # A real hymn sheet stacks chord row on lyric row with almost nothing
    # between them, which is what puts a lyric's descender exactly where a
    # patch looks for the colour of the paper.
    open(sys.argv[1], "wb").write(build(TIGHT if tight else None, 17 if tight else 36))
