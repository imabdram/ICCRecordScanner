"""Three more ways: trend, weekly summary, cumulative pace."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app-voucher-charts2.png")

PANEL_W, PANEL_H = 460, 470
GAP = 30
RED = (225, 25, 41)
RED_SOFT = (232, 145, 152)
INK = (16, 28, 43)
MUTED = (110, 122, 138)
LINE = (232, 236, 242)
WHITE = (255, 255, 255)
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


F_T = font(16, True)
F_L = font(10, True)
F_B = font(12)
F_S = font(10)
F_XS = font(9)
F_BIG = font(24, True)


def label(d, xy, text, f, fill=INK, anchor="la"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def rounded(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


DATA = [0, 8, 12, 0, 6, 18, 24, 10, 0, 14, 6, 20, 4, 9, 0, 12, 16, 8, 22, 6, 10, 14, 26]
TODAY = 23
MONTH_DAYS = 30
TOTAL = sum(DATA)


def panel(img, x, y, title, subtitle):
    d = ImageDraw.Draw(img)
    rounded(d, (x, y, x + PANEL_W, y + PANEL_H), 18, fill=WHITE)
    label(d, (x + 18, y + 16), title, F_T, INK)
    label(d, (x + 18, y + 40), subtitle, F_S, MUTED)


def plot_frame(d, x, top, h):
    left, right = x + 34, x + PANEL_W - 18
    base = top + h
    for frac in (0, 0.5, 1):
        gy = base - h * frac
        d.line((left, gy, right, gy), fill=LINE, width=1)
    label(d, (left, top - 4), "$30", F_XS, MUTED, anchor="rs")
    label(d, (left, base + 8), "1", F_XS, MUTED, anchor="ma")
    label(d, (right, base + 8), str(MONTH_DAYS), F_XS, MUTED, anchor="ma")
    return left, right, base


# ------------------------------------------------------------------ D: trend
def trend(img, x, y):
    d = ImageDraw.Draw(img)
    panel(img, x, y, "D - Daily trend", "shape of the month, one line")

    top = y + 74
    h = 150
    left, right, base = plot_frame(d, x, top, h)
    slot = (right - left) / (MONTH_DAYS - 1)
    vmax = 30

    pts = []
    for i in range(MONTH_DAYS):
        val = DATA[i] if i < len(DATA) else 0
        px = left + i * slot
        py = base - (val / vmax) * h
        pts.append((px, py, val, i + 1))

    # area under the line
    poly = [(left, base)] + [(px, py) for px, py, _, _ in pts] + [(right, base)]
    d.polygon(poly, fill=(252, 228, 231))
    d.line([(px, py) for px, py, _, _ in pts], fill=RED, width=2)

    for px, py, val, day in pts:
        if day == TODAY:
            d.ellipse((px - 5, py - 5, px + 5, py + 5), fill=RED, outline=WHITE, width=2)
        elif val:
            d.ellipse((px - 2.5, py - 2.5, px + 2.5, py + 2.5), fill=RED_SOFT)

    label(d, (x + 18, y + PANEL_H - 58), f"month total ${TOTAL}.00", F_B, INK)
    label(d, (x + 18, y + PANEL_H - 34), "today marked in solid red", F_S, MUTED)


# ----------------------------------------------------------------- E: weekly
def weekly(img, x, y):
    d = ImageDraw.Draw(img)
    panel(img, x, y, "E - By week", "coarser, good for a month view")

    weeks = []
    for w in range(0, MONTH_DAYS, 7):
        chunk = DATA[w:w + 7]
        weeks.append((w + 1, min(w + 7, MONTH_DAYS), sum(chunk)))

    top = y + 78
    left, right = x + 18, x + PANEL_W - 18
    bar_h = 26
    vmax = max(v for _, _, v in weeks) or 1

    for i, (d1, d2, val) in enumerate(weeks):
        wy = top + i * 54
        label(d, (left, wy), f"{d1}-{d2}", F_B, INK)
        label(d, (right, wy), f"${val}.00", F_B, INK, anchor="ra")
        track_w = right - left - 72
        rounded(d, (left + 46, wy + 20, left + 46 + track_w, wy + 20 + bar_h), 6, fill=(245, 247, 250))
        w = track_w * (val / vmax)
        rounded(d, (left + 46, wy + 20, left + 46 + w, wy + 20 + bar_h), 6,
                fill=RED if i == len(weeks) - 1 else RED_SOFT)

    best = max(weeks, key=lambda t: t[2])
    label(d, (x + 18, y + PANEL_H - 58), f"best week: {best[0]}-{best[1]} (${best[2]}.00)", F_B, INK)
    label(d, (x + 18, y + PANEL_H - 34), "the current week is still filling up", F_S, MUTED)


# ------------------------------------------------------------ F: cumulative
def cumulative(img, x, y):
    d = ImageDraw.Draw(img)
    panel(img, x, y, "F - Running total", "pace: am I ahead or behind?")

    top = y + 74
    h = 150
    left = x + 34
    right = x + PANEL_W - 18
    base = top + h

    for frac in (0, 0.5, 1):
        gy = base - h * frac
        d.line((left, gy, right, gy), fill=LINE, width=1)
    label(d, (left, top - 4), f"${TOTAL}", F_XS, MUTED, anchor="rs")
    label(d, (left, base + 8), "1", F_XS, MUTED, anchor="ma")
    label(d, (right, base + 8), str(TODAY), F_XS, MUTED, anchor="ma")

    slot = (right - left) / (TODAY - 1)
    running, pts = 0, []
    for i in range(TODAY):
        running += DATA[i] if i < len(DATA) else 0
        px = left + i * slot
        py = base - (running / TOTAL) * h
        pts.append((px, py))

    poly = [(left, base)] + pts + [(right, base)]
    d.polygon(poly, fill=(252, 228, 231))
    d.line(pts, fill=RED, width=2)

    # straight "even pace" reference
    d.line((left, top, right, base), fill=MUTED, width=1)
    label(d, (right - 4, top + 2), "even pace", F_XS, MUTED, anchor="ra")

    d.ellipse((pts[-1][0] - 5, pts[-1][1] - 5, pts[-1][0] + 5, pts[-1][1] + 5),
              fill=RED, outline=WHITE, width=2)

    label(d, (x + 18, y + PANEL_H - 58), f"${TOTAL}.00 by day {TODAY}", F_B, INK)
    label(d, (x + 18, y + PANEL_H - 34), "above the line = ahead of even pace", F_S, MUTED)


def main():
    canvas = Image.new("RGB", (PANEL_W * 3 + GAP * 4, PANEL_H + 90), (236, 239, 243))
    d = ImageDraw.Draw(canvas)
    label(d, (GAP, 22), "E-voucher: three more options", font(18, True), INK)

    trend(canvas, GAP, 60)
    weekly(canvas, GAP * 2 + PANEL_W, 60)
    cumulative(canvas, GAP * 3 + PANEL_W * 2, 60)

    canvas.save(OUT, "PNG")
    print(OUT)


if __name__ == "__main__":
    main()
