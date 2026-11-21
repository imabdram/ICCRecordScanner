"""What the user sees immediately AFTER saving a record: back on the scanner,
with a short confirmation toast (the form closes)."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app-saved.png")

W, H = 520, 1040
DARK = (12, 14, 18)
RED = (225, 25, 41)
INK = (16, 28, 43)
MUTED = (120, 128, 142)
WHITE = (255, 255, 255)
TEAL = (38, 166, 154)
GREEN = (52, 168, 83)


def font(size, bold=False):
    for name in (("segoeuib.ttf" if bold else "segoeui.ttf"),
                 ("arialbd.ttf" if bold else "arial.ttf")):
        path = os.path.join(r"C:\Windows\Fonts", name)
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


F_LABEL = font(12, True)
F_BODY = font(17)
F_TINY = font(13)
F_BTN = font(17, True)


def rounded(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def label(d, xy, text, f, fill=INK, anchor="la"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def icon(d, name, cx, cy, size=16, color=INK, width=2):
    s = size / 2.0
    if name == "menu":
        for i in (-1, 0, 1):
            d.line((cx - s, cy + i * size / 3.2, cx + s, cy + i * size / 3.2), fill=color, width=width)
    elif name == "scan":
        a = s * 0.8
        for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            d.line((cx + sx * a, cy + sy * a, cx + sx * a - sx * a * 0.55, cy + sy * a), fill=color, width=width)
            d.line((cx + sx * a, cy + sy * a, cx + sx * a, cy + sy * a - sy * a * 0.55), fill=color, width=width)
    elif name == "flash":
        d.polygon([(cx + s * 0.25, cy - s), (cx - s * 0.55, cy + s * 0.1),
                   (cx - s * 0.05, cy + s * 0.1), (cx - s * 0.25, cy + s),
                   (cx + s * 0.6, cy - s * 0.15), (cx + s * 0.05, cy - s * 0.15)], fill=color)
    elif name == "list":
        for i in (-1, 0, 1):
            y = cy + i * size / 3.2
            d.line((cx - s + 3, y, cx + s, y), fill=color, width=width)
            d.ellipse((cx - s - 1, y - 1.4, cx - s + 1.4, y + 1.4), fill=color)
    elif name == "check":
        d.line((cx - s * 0.7, cy, cx - s * 0.1, cy + s * 0.55), fill=color, width=width + 1)
        d.line((cx - s * 0.1, cy + s * 0.55, cx + s * 0.8, cy - s * 0.55), fill=color, width=width + 1)


def main():
    img = Image.new("RGB", (W, H), DARK)
    d = ImageDraw.Draw(img)

    label(d, (22, 16), "9:41", F_LABEL, (200, 205, 212))
    label(d, (W - 22, 16), "100%", F_LABEL, (200, 205, 212), anchor="ra")

    # top controls
    d.ellipse((28, 60, 88, 120), fill=(40, 44, 52))
    icon(d, "menu", 58, 90, 20, WHITE)
    d.ellipse((W - 88, 60, W - 28, 120), fill=(40, 44, 52))
    icon(d, "list", W - 58, 90, 18, (150, 158, 170))

    # scan frame
    wx, wy, ww, wh = 46, 300, W - 92, 170
    rounded(d, (wx, wy, wx + ww, wy + wh), 18, outline=(90, 96, 106), width=2)
    for cx, cy, dx, dy in ((wx, wy, 1, 1), (wx + ww, wy, -1, 1),
                           (wx, wy + wh, 1, -1), (wx + ww, wy + wh, -1, -1)):
        d.line((cx, cy, cx + 30 * dx, cy), fill=TEAL, width=6)
        d.line((cx, cy, cx, cy + 30 * dy), fill=TEAL, width=6)
    d.line((wx + 16, wy + wh / 2, wx + ww - 16, wy + wh / 2), fill=TEAL, width=2)

    label(d, (W / 2, wy + wh + 26), "Align the ICCID inside the frame", F_TINY, (170, 178, 190), anchor="ma")

    # flashlight
    fx, fy = W / 2, H - 170
    bw, bh = 230, 62
    rounded(d, (fx - bw / 2, fy - bh / 2, fx + bw / 2, fy + bh / 2), 16, fill=WHITE)
    icon(d, "flash", fx - 58, fy, 22, INK, 2)
    label(d, (fx - 36, fy - 11), "Flashlight", F_BTN, INK)

    # tab bar
    top = H - 96
    d.rectangle((0, top, W, H), fill=WHITE)
    label(d, (W / 4, top + 22), "", F_TINY)
    icon(d, "scan", W / 4, top + 26, 20, RED, 2)
    label(d, (W / 4, top + 44), "Scan", F_TINY, RED, anchor="ma")
    icon(d, "list", W * 3 / 4, top + 26, 20, MUTED, 2)
    label(d, (W * 3 / 4, top + 44), "Records", F_TINY, MUTED, anchor="ma")

    # saved toast
    tx0, ty0, tx1, ty1 = 26, H - 300, W - 26, H - 220
    rounded(d, (tx0, ty0, tx1, ty1), 16, fill=(22, 46, 32), outline=(44, 88, 58), width=1)
    d.ellipse((tx0 + 18, ty0 + 20, tx0 + 62, ty0 + 64), fill=GREEN)
    icon(d, "check", tx0 + 40, ty0 + 42, 20, WHITE, 3)
    label(d, (tx0 + 76, ty0 + 20), "Saved", F_BODY, WHITE)
    label(d, (tx0 + 76, ty0 + 42), "89252637990000001234", F_TINY, (160, 210, 175))
    rounded(d, (tx1 - 108, ty0 + 26, tx1 - 16, ty0 + 58), 9, fill=(38, 68, 46))
    label(d, (tx1 - 62, ty0 + 33), "pending", F_TINY, (245, 200, 110), anchor="ma")

    img.save(OUT, "PNG")
    print(OUT)


if __name__ == "__main__":
    main()
