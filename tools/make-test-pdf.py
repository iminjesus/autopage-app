#!/usr/bin/env python3
"""A one-page PDF with a word on it, written by hand.

Only for tests that need several *different* scores to choose between — the
chooser keys entries by content hash and shows the first page, so both have to
genuinely differ. LilyPond is not always installed and is far too much machinery
for "a page with a word on it".
"""
import sys


def build(label: str) -> bytes:
    content = (
        f"BT /F1 48 Tf 72 680 Td ({label}) Tj ET\n"
        "4 w 72 120 m 468 120 l S\n"
        "72 160 m 468 160 l S\n"
    ).encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 540 760] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
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
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{start}\n".encode()
        + b"%%EOF\n"
    )
    return bytes(out)


if __name__ == "__main__":
    label, path = sys.argv[1], sys.argv[2]
    with open(path, "wb") as f:
        f.write(build(label))
    print(path)
