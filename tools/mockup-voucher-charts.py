"""Three ways to show 'how much per day this month', for comparison."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app-voucher-charts.png")

PANEL_W, PANEL_H = 460, 470
GAP = 30
BG = (244, 246, 248)
RED = (225, 25, 41)
RED_SOFT = (232, 145, 152)
INK = (16, 28, 43)
MUTED = (110, 122, 138)
LINE = (232, 236, 242)
WHITE = (255, 255, 255)


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


def label(d, xy, text, f, fill=INK, anchor="la"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def rounded(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


# 23 days of data; 0 = nothing that day
DATA = [0, 8, 12, 0, 6, 18, 24, 10, 0, 14, 6, 20, 4, 9, 0, 12, 16, 8, 22, 6, 10, 14, 26]
TODAY = 23
MONTH_DAYS = 30
TOTAL = sum(DATA)


def panel(img, x, y, title, subtitle):
    d = ImageDraw.Draw(img)
    rounded(d, (x, y, x + PANEL_W, y + PANEL_H), 18, fill=WHITE)
    label(d, (x + 18, y + 16), title, F_T, INK)
    label(d, (x + 18, y + 40), subtitle, F_S, MUTED)
    return x, y


# ------------------------------------------------------------------ A: bars
def bars(img, x, y):
    d = ImageDraw.Draw(img)
    panel(img, x, y, "A - Bars", "compact, compares days")

    left, right = x + 18, x + PANEL_W - 18
    top = y + 74
    plot_h = 150
    base = top + plot_h
    slot = (right - left) / MONTH_DAYS
    bar_w = slot * 0.6
    vmax = max(DATA)

    for frac in (0, 0.5, 1):
        gy = base - plot_h * frac
        d.line((left, gy, right, gy), fill=LINE, width=1)

    for i in range(MONTH_DAYS):
        day = i + 1
        val = DATA[i] if i < len(DATA) else 0
        bx = left + i * slot + (slot - bar_w) / 2
        h = (val / vmax) * (plot_h - 4) if val else 0
        colour = RED if day == TODAY else (RED_SOFT if val else (238, 241, 245))
        if h == 0:
            d.line((bx, base - 2, bx + bar_w, base - 2), fill=colour, width=3)
        else:
            rounded(d, (bx, base - h, bx + bar_w, base), 3, fill=colour)

    for i in range(0, MONTH_DAYS, 5):
        label(d, (left + i * slot + slot / 2, base + 8), str(i + 1), F_XS, MUTED, anchor="ma")
    label(d, (left, top - 14), f"max ${vmax}", F_XS, MUTED)
    label(d, (x + 18, y + PANEL_H - 34), f"month total ${TOTAL}.00", F_B, RED)


# ------------------------------------------------------------- B: calendar
def calendar(img, x, y):
    d = ImageDraw.Draw(img)
    panel(img, x, y, "B - Calendar heatmap", "see gaps and rhythm at a glance")

    left = x + 18
    top = y + 74
    cols, cell_w, cell_h, gap = 7, 56, 54, 6

    for c in range(cols):
        label(d, (left + c * (cell_w + gap) + cell_w / 2, top - 12),
              ["M", "T", "W", "T", "F", "S", "S"][c], F_XS, MUTED, anchor="ma")

    vmax = max(DATA)
    for i in range(MONTH_DAYS):
        day = i + 1
        row, col = divmod(i, 7)
        val = DATA[i] if i < len(DATA) else 0
        bx = left + col * (cell_w + gap)
        by = top + row * (cell_h + gap)

        if val == 0:
            fill = (246, 248, 250)
        else:
            # intensity by amount; today always full red
            frac = 0.25 + 0.75 * (val / vmax)
            fill = RED if day == TODAY else (
                int(255 - frac * 26), int(255 - frac * 150), int(255 - frac * 150))
        rounded(d, (bx, by, bx + cell_w, by + cell_h), 8, fill=fill)

        ink = WHITE if (day == TODAY or val > vmax * 0.55) else INK
        label(d, (bx + 7, by + 6), str(day), F_XS, ink)
        if val:
            label(d, (bx + 7, by + 26), f"${val}", F_B, ink)

    label(d, (x + 18, y + PANEL_H - 34), "darker = more that day; empty = no voucher", F_S, MUTED)


# ------------------------------------------------------------------ C: list
def rows(img, x, y):
    d = ImageDraw.Draw(img)
    panel(img, x, y, "C - Ranked days", "exact numbers, easiest to read")

    left = x + 18
    top = y + 74
    ranked = sorted(
        [(i + 1, v) for i, v in enumerate(DATA) if v > 0],
        key=lambda t: -t[1],
    )[:8]
    vmax = ranked[0][1]

    for n, (day, val) in enumerate(ranked):
        ry = top + n * 34
        is_today = day == TODAY
        label(d, (left, ry), f"{day} Nov", F_B, RED if is_today else INK)
        bar_left = left + 62
        bar_max = 230
        w = bar_max * (val / vmax)
        rounded(d, (bar_left, ry + 3, bar_left + w, ry + 15), 6,
                fill=RED if is_today else RED_SOFT)
        label(d, (x + PANEL_W - 18, ry), f"${val}.00", F_B, INK, anchor="ra")

    label(d, (x + 18, y + PANEL_H - 34), "top days only; the rest would scroll", F_S, MUTED)


def main():
    canvas = Image.new("RGB", (PANEL_W * 3 + GAP * 4, PANEL_H + 90), (236, 239, 243))
    d = ImageDraw.Draw(canvas)
    label(d, (GAP, 22), "E-voucher: three ways to show the month", font(18, True), INK)

    bars(canvas, GAP, 60)
    calendar(canvas, GAP * 2 + PANEL_W, 60)
    rows(canvas, GAP * 3 + PANEL_W * 2, 60)

    canvas.save(OUT, "PNG")
    print(OUT)


if __name__ == "__main__":
    main()
