from PIL import Image, ImageDraw
from pathlib import Path

out = Path(__file__).resolve().parents[1] / "build"
size = 512
im = Image.new("RGBA", (size, size), "#111d32")
d = ImageDraw.Draw(im)
d.rounded_rectangle((0, 0, 511, 511), 112, fill="#111d32")
d.rounded_rectangle((104, 126, 354, 376), 44, fill="#283956")
d.rounded_rectangle((142, 92, 392, 342), 44, fill="#596be0")
d.ellipse((206, 156, 328, 278), fill="#eef1ff")
for line in [((267, 123), (267, 311)), ((173, 217), (361, 217)), ((201, 151), (333, 283)), ((333, 151), (201, 283))]:
    d.line(line, fill="#596be0", width=22)
im.save(out / "icon.png")
im.save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
