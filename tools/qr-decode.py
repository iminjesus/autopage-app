import sys, numpy as np, cv2

def decode(rows):
    n = len(rows)
    scale, quiet = 8, 4
    size = (n + quiet * 2) * scale
    img = np.full((size, size), 255, np.uint8)
    for r in range(n):
        for c in range(n):
            if rows[r][c]:
                y, x = (r + quiet) * scale, (c + quiet) * scale
                img[y:y+scale, x:x+scale] = 0
    d = cv2.QRCodeDetector()
    text, pts, _ = d.detectAndDecode(img)
    return text

rows = [[int(ch) for ch in line] for line in sys.stdin.read().strip().split("\n")]
print(repr(decode(rows)))
