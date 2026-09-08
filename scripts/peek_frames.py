"""Extracts a contact sheet of frames from a generated clip so the output can
actually be inspected instead of guessed at."""

import sys
import os
import av
from PIL import Image, ImageDraw

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else "frames.png"
cols = 4

container = av.open(src)
stream = container.streams.video[0]
frames = [f.to_image() for f in container.decode(stream)]
container.close()

if not frames:
    print("NO FRAMES DECODED")
    raise SystemExit(1)

w, h = frames[0].size
n = len(frames)
print(f"frames={n} size={w}x{h}")

# pick up to 8 evenly spaced frames
idxs = [round(i * (n - 1) / 7) for i in range(8)] if n >= 8 else list(range(n))
idxs = sorted(set(idxs))
pick = [(i, frames[i]) for i in idxs]

rows = (len(pick) + cols - 1) // cols
sheet = Image.new("RGB", (cols * w, rows * (h + 16)), (20, 20, 24))
d = ImageDraw.Draw(sheet)
for k, (i, fr) in enumerate(pick):
    x = (k % cols) * w
    y = (k // cols) * (h + 16)
    sheet.paste(fr, (x, y + 16))
    d.text((x + 4, y + 3), f"frame {i}", fill=(220, 220, 220))
sheet.save(out)
print("wrote", out, sheet.size)

# crude statistics: is there any real structure, and does anything move?
import statistics
def stats(im):
    g = im.convert("L")
    px = list(g.getdata())
    return statistics.mean(px), statistics.pstdev(px)

for i, fr in pick:
    m, sd = stats(fr)
    print(f"  frame {i:3d}  mean={m:6.1f}  stddev={sd:5.1f}")

# frame-to-frame difference tells us whether it is animating or static noise
diffs = []
for a, b in zip(frames, frames[1:]):
    pa, pb = list(a.convert("L").getdata()), list(b.convert("L").getdata())
    diffs.append(sum(abs(x - y) for x, y in zip(pa, pb)) / len(pa))
if diffs:
    print(f"mean abs frame-to-frame change: {statistics.mean(diffs):.2f} (0 = frozen)")
