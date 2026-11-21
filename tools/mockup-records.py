"""Records tab, reorganised as a timeline: day headers, a continuous rail,
and a time marker per entry. Easier to scan than a flat list of cards."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app-records.png")

W, H = 520, 1040
BG = (244, 246, 248)
RED = (225, 25, 41)
INK = (16, 28, 43)
MUTED = (110, 122, 138)
LINE = (223, 228, 234)
RAIL = (214, 220, 228)
WHITE = (255, 255, 255)
GREEN = (52, 168, 83)
AMBER = (240, 173, 78)


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


F_H = font(26, True)
F_DAY = font(15, True)
F_BODY = font(17)
F_SMALL = font(14)
F_LABEL = font(12, True)
F_TINY = font(12)
F_HINT = font(13)


def rounded(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def label(d, xy, text, f, fill=INK, anchor="la"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def icon(d, name, cx, cy, size=16, color=INK, width=2):
    s = size / 2.0
    if name == "menu":
        for i in (-1, 0, 1):
            d.line((cx - s, cy + i * size / 3.2, cx + s, cy + i * size / 3.2), fill=color, width=width)
    elif name == "download":
        d.line((cx, cy - s, cx, cy + s * 0.35), fill=color, width=width)
        d.line((cx - s * 0.5, cy - s * 0.15, cx, cy + s * 0.4), fill=color, width=width)
        d.line((cx + s * 0.5, cy - s * 0.15, cx, cy + s * 0.4), fill=color, width=width)
        d.line((cx - s, cy + s, cx + s, cy + s), fill=color, width=width)
    elif name == "search":
        r = s * 0.6
        d.ellipse((cx - r - 2, cy - r - 2, cx + r - 2, cy + r - 2), outline=color, width=width)
        d.line((cx + r - 2, cy + r - 2, cx + s, cy + s), fill=color, width=width)
    elif name == "list":
        for i in (-1, 0, 1):
            y = cy + i * size / 3.2
            d.line((cx - s + 3, y, cx + s, y), fill=color, width=width)
            d.ellipse((cx - s - 1, y - 1.4, cx - s + 1.4, y + 1.4), fill=color)
    elif name == "scan":
        a = s * 0.8
        for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            d.line((cx + sx * a, cy + sy * a, cx + sx * a - sx * a * 0.55, cy + sy * a), fill=color, width=width)
            d.line((cx + sx * a, cy + sy * a, cx + sx * a, cy + sy * a - sy * a * 0.55), fill=color, width=width)


RAIL_X = 74          # the vertical timeline
CARD_X0 = 96         # cards start right of the rail
ROW_H = 100
CARD_H = 86
TIME_W = 44


def day_header(d, y, title, count):
    """Day separators: label + a rule that spans the row."""
    label(d, (24, y), title, F_DAY, INK)
    right = f"{count} SIM" + ("" if count == 1 else "s")
    label(d, (W - 24, y + 2), right, F_TINY, MUTED, anchor="ra")
    d.line((24, y + 28, W - 24, y + 28), fill=LINE, width=1)
    return y + 44


def entry(d, y, time, name, iccid, uploaded, first=False, last=False, primary="", backup=""):
    # time, left of the rail
    label(d, (RAIL_X - 16, y + 18), time, F_TINY, MUTED, anchor="ra")

    # rail
    top = y - 14 if not first else y + 18
    bottom = y + ROW_H if not last else y + 18
    d.line((RAIL_X, top, RAIL_X, bottom), fill=RAIL, width=3)
    # node
    colour = GREEN if uploaded else AMBER
    d.ellipse((RAIL_X - 6, y + 12, RAIL_X + 6, y + 24), fill=WHITE)
    d.ellipse((RAIL_X - 5, y + 13, RAIL_X + 5, y + 23), fill=colour)

    # card
    rounded(d, (CARD_X0, y, W - 20, y + CARD_H), 12, fill=WHITE)
    label(d, (CARD_X0 + 16, y + 12), name, F_BODY, INK)
    label(d, (CARD_X0 + 16, y + 34), iccid, F_SMALL, MUTED)
    label(d, (CARD_X0 + 16, y + 56), primary + "  |  " + backup, F_TINY, (150, 156, 168))
    if uploaded:
        d.ellipse((W - 42, y + 34, W - 28, y + 48), fill=GREEN)
    else:
        rounded(d, (W - 96, y + 28, W - 30, y + 56), 9, fill=(255, 247, 230))
        d.ellipse((W - 88, y + 37, W - 80, y + 45), fill=AMBER)
        label(d, (W - 74, y + 33), "pending", F_TINY, (190, 130, 30))
    return y + ROW_H


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    label(d, (22, 16), "9:41", F_LABEL, MUTED)
    label(d, (W - 22, 16), "100%", F_LABEL, MUTED, anchor="ra")

    d.rectangle((0, 44, W, 134), fill=WHITE)
    icon(d, "menu", 44, 90, 20, INK)
    label(d, (76, 66), "Records", F_H, INK)
    label(d, (76, 102), "12 records | 2 pending", F_HINT, MUTED)
    icon(d, "download", W - 44, 90, 20, MUTED)

    rounded(d, (24, 150, W - 24, 202), 12, fill=WHITE, outline=LINE)
    icon(d, "search", 52, 176, 16, MUTED)
    label(d, (74, 166), "Search name or ICCID", F_SMALL, MUTED)

    y = 220
    y = day_header(d, y, "Today - 21 Nov", 3)
    y = entry(d, y, "18:24", "Hodan Ali", "89252637990000001234", False, first=True, primary="615555001", backup="615555002")
    y = entry(d, y, "14:02", "Ali Abdi", "89252637990000001111", True, primary="615555003", backup="615555004")
    y = entry(d, y, "09:15", "Hodan Ali", "89252637990000009999", True, last=True, primary="615555005", backup="615555006")

    y += 10
    y = day_header(d, y, "Yesterday - 20 Nov", 2)
    y = entry(d, y, "16:40", "Abdi Yusuf", "89252637990000002222", True, first=True, primary="615555007", backup="615555008")
    y = entry(d, y, "11:05", "Hodan Ali", "89252637990000003333", True, last=True, primary="615555009", backup="615555010")



    # fade / footer


    # tab bar
    top = H - 96
    d.rectangle((0, top, W, H), fill=WHITE)
    d.line((0, top, W, top), fill=LINE, width=1)
    icon(d, "scan", W / 4, top + 26, 20, MUTED, 2)
    label(d, (W / 4, top + 44), "Scan", F_TINY, MUTED, anchor="ma")
    icon(d, "list", W * 3 / 4, top + 26, 20, RED, 2)
    label(d, (W * 3 / 4, top + 44), "Records", F_TINY, RED, anchor="ma")

    img.save(OUT, "PNG")
    print(OUT)


if __name__ == "__main__":
    main()


