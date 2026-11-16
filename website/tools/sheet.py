# Contact sheet for review: python tools/sheet.py out.jpg cols cellw a.png b.png ...
import sys
from pathlib import Path
from PIL import Image

out, cols, cellw, *names = sys.argv[1:]
cols, cellw = int(cols), int(cellw)
shots = Path(__file__).parent.parent / ".shots"
cells = []
for name in names:
    im = Image.open(shots / name).convert("RGB")
    cells.append(im.resize((cellw, round(im.height * cellw / im.width)), Image.LANCZOS))
rows = [cells[k : k + cols] for k in range(0, len(cells), cols)]
gap = 6
width = cols * cellw + (cols - 1) * gap
height = sum(max(c.height for c in row) for row in rows) + (len(rows) - 1) * gap
sheet = Image.new("RGB", (width, height), (128, 128, 128))
y = 0
for row in rows:
    for k, cell in enumerate(row):
        sheet.paste(cell, (k * (cellw + gap), y))
    y += max(c.height for c in row) + gap
sheet.save(shots / out, quality=64)
print(out, sheet.size)
