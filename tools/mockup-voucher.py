"""Mockup of the e-voucher UI: the drawer entry and the sheet it opens."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app-voucher.png")

W, H = 520, 1040
BG = (244, 246, 248)
RED = (225, 25, 41)
INK = (16, 28, 43)
MUTED = (110, 122, 138)
LINE = (223, 228, 234)
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


F_H = font(24, True)
F_BIG = font(30, True)
F_BODY = font(16)
F_LABEL = font(11, True)
F_SMALL = font(13)
F_TINY = font(11)


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
    elif name == "list":
        for i in (-1, 0, 1):
            y = cy + i * size / 3.2
            d.line((cx - s + 3, y, cx + s, y), fill=color, width=width)
            d.ellipse((cx - s - 1, y - 1.4, cx - s + 1.4, y + 1.4), fill=color)
    elif name == "cash":
        rounded(d, (cx - s, cy - s * 0.62, cx + s, cy + s * 0.62), 3, outline=color, width=width)
        d.line((cx - s * 0.45, cy, cx + s * 0.45, cy), fill=color, width=width)
    elif name == "sync":
        d.arc((cx - s, cy - s, cx + s, cy + s), 30, 320, fill=color, width=width)
    elif name == "gear":
        d.ellipse((cx - s * 0.5, cy - s * 0.5, cx + s * 0.5, cy + s * 0.5), outline=color, width=width)
        d.ellipse((cx - 1.8, cy - 1.8, cx + 1.8, cy + 1.8), fill=color)
    elif name == "logout":
        d.line((cx - s, cy - s, cx - s, cy + s), fill=color, width=width)
        d.line((cx - s, cy, cx + s, cy), fill=color, width=width)
        d.line((cx + s * 0.25, cy - s * 0.5, cx + s, cy), fill=color, width=width)
        d.line((cx + s * 0.25, cy + s * 0.5, cx + s, cy), fill=color, width=width)
    elif name == "refresh":
        d.arc((cx - s, cy - s, cx + s, cy + s), 40, 320, fill=color, width=width)


def phone(d, x, y, title):
    rounded(d, (x, y, x + W, y + H), 30, fill=WHITE, outline=(210, 216, 224), width=2)
    rounded(d, (x + W // 2 - 42, y + 10, x + W // 2 + 42, y + 22), 6, fill=(232, 236, 241))
    label(d, (x + W / 2, y + H + 16), title, F_SMALL, MUTED, anchor="ma")
    return (x, y + 30, x + W, y + H)


def status(d, x0, y0):
    label(d, (x0 + 22, y0 + 12), "9:41", F_TINY, MUTED)
    label(d, (x0 + W - 22, y0 + 12), "100%", F_TINY, MUTED, anchor="ra")


# ---------------------------------------------------------------- drawer
def draw_drawer(img, x, y):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = phone(d, x, y, "1 - Side menu (new E-voucher entry)")
    d.rectangle((x0, y0, x1, y1), fill=(235, 238, 242))
    d.rectangle((x0, y0, x0 + 340, y1), fill=WHITE)
    status(d, x0, y0)

    d.ellipse((x0 + 24, y0 + 58, x0 + 80, y0 + 114), fill=RED)
    label(d, (x0 + 52, y0 + 72), "YG", F_BODY, WHITE, anchor="ma")
    label(d, (x0 + 94, y0 + 60), "Yacquub Gelle", F_H, INK)
    label(d, (x0 + 94, y0 + 88), "TEAM LEADER", F_LABEL, MUTED)
    label(d, (x0 + 94, y0 + 106), "Alla-aamin Qardho", F_TINY, MUTED)

    y2 = y0 + 132
    rounded(d, (x0 + 18, y2, x0 + 322, y2 + 118), 12, fill=(248, 249, 251))
    for i, (k, v) in enumerate([("Zone", "Zone 2"), ("Region", "Bari Region"),
                                ("Outlet", "Alla-aamin Qardho"), ("Team leader", "-")]):
        label(d, (x0 + 32, y2 + 12 + i * 26), k, F_TINY, MUTED)
        label(d, (x0 + 118, y2 + 12 + i * 26), v, F_SMALL, INK)

    nav = y0 + 278
    for glyph, name in (("scan", "Scan"), ("list", "Records")):
        icon(d, glyph, x0 + 38, nav + 8, 16, MUTED)
        label(d, (x0 + 60, nav), name, F_BODY, INK)
        nav += 46

    d.line((x0 + 18, nav + 4, x0 + 322, nav + 4), fill=LINE, width=1)
    nav += 20

    # the new row
    rounded(d, (x0 + 12, nav - 8, x0 + 328, nav + 36), 10, fill=(253, 236, 238))
    icon(d, "cash", x0 + 38, nav + 14, 17, RED)
    label(d, (x0 + 60, nav + 2), "E-voucher", F_BODY, RED)
    label(d, (x0 + 60, nav + 20), "Today  $26.00", F_TINY, (170, 60, 70))
    nav += 48

    for glyph, name, trailing in (("sync", "Sync now", "3 pending"),
                                  ("gear", "Settings", None),
                                  ("logout", "Sign out", None)):
        icon(d, glyph, x0 + 38, nav + 8, 16, MUTED)
        label(d, (x0 + 60, nav), name, F_BODY, INK)
        if trailing:
            rounded(d, (x0 + 240, nav - 2, x0 + 320, nav + 22), 8, fill=(243, 246, 249))
            label(d, (x0 + 280, nav + 3), trailing, F_TINY, MUTED, anchor="ma")
        nav += 46


# ---------------------------------------------------------------- sheet
def draw_sheet(img, x, y):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = phone(d, x, y, "2 - E-voucher sheet (month chart added)")

    # dimmed background behind the sheet
    d.rectangle((x0, y0, x1, y1), fill=(232, 235, 240))
    d.rectangle((x0, y0, x1, y0 + 96), fill=WHITE)
    status(d, x0, y0)
    label(d, (x0 + 22, y0 + 52), "Records", F_H, INK)
    label(d, (x0 + 22, y0 + 78), "5 records | 2 pending", F_TINY, MUTED)

    # sheet -- taller now, so the chart fits without a second screen
    top = y0 + 140
    rounded(d, (x0 + 10, top, x1 - 10, y1 - 8), 22, fill=WHITE)
    rounded(d, (x0 + W / 2 - 22, top + 10, x0 + W / 2 + 22, top + 16), 3, fill=(214, 220, 228))

    label(d, (x0 + 26, top + 30), "E-voucher", F_H, INK)
    label(d, (x0 + 26, top + 58), "From SMS - sender 913", F_TINY, MUTED)

    # two totals
    cy = top + 84
    for i, (cap, amount, sub, accent) in enumerate([
            ("TODAY", "$26.00", "4 vouchers", RED),
            ("THIS MONTH", "$214.50", "31 vouchers", INK)]):
        bx = x0 + 26 + i * 224
        rounded(d, (bx, cy, bx + 208, cy + 84), 14, fill=(248, 249, 251))
        label(d, (bx + 14, cy + 10), cap, F_LABEL, MUTED)
        label(d, (bx + 14, cy + 28), amount, F_BIG, accent)
        label(d, (bx + 14, cy + 64), sub, F_TINY, MUTED)

    # ---- month chart -------------------------------------------------------
    chart_top = cy + 104
    label(d, (x0 + 26, chart_top), "NOVEMBER BY DAY", F_LABEL, MUTED)
    label(d, (x1 - 26, chart_top), "tap a bar to see that day", F_TINY, MUTED, anchor="ra")

    plot_top = chart_top + 24
    plot_h = 96
    plot_left = x0 + 26
    plot_right = x1 - 26
    baseline = plot_top + plot_h

    # horizontal guide lines
    for frac in (0.0, 0.5, 1.0):
        gy = baseline - plot_h * frac
        d.line((plot_left, gy, plot_right, gy), fill=(238, 241, 245), width=1)
    label(d, (plot_left - 4, plot_top - 2), "$30", F_TINY, (170, 176, 186), anchor="ra") if plot_left - 4 > x0 else None

    # one bar per day (1..23 of the month), today highlighted
    days = [0, 8, 12, 0, 6, 18, 24, 10, 0, 14, 6, 20, 4, 9, 0, 12, 16, 8, 22, 6, 10, 14, 26]
    today_day = 23
    n = 30                      # days in the month, so the axis stays stable
    slot = (plot_right - plot_left) / n
    bar_w = slot * 0.62
    vmax = max(days) or 1

    for i in range(n):
        day = i + 1
        val = days[i] if i < len(days) else 0
        bx = plot_left + i * slot + (slot - bar_w) / 2
        hgt = (val / vmax) * (plot_h - 6) if val else 0
        if day == today_day:
            colour = RED
        elif val:
            colour = (225, 25, 41) if False else (232, 145, 152)
        else:
            colour = (236, 239, 244)
        if hgt == 0:
            d.line((bx, baseline - 2, bx + bar_w, baseline - 2), fill=colour, width=3)
        else:
            rounded(d, (bx, baseline - hgt, bx + bar_w, baseline), 3, fill=colour)

    # day labels every 5 days
    for i in range(0, n, 5):
        cx = plot_left + i * slot + slot / 2
        label(d, (cx, baseline + 8), str(i + 1), F_TINY, MUTED, anchor="ma")
    label(d, (plot_left + (today_day - 1) * slot + slot / 2, baseline + 8),
          str(today_day), F_TINY, RED, anchor="ma")

    # ---- today's messages --------------------------------------------------
    ly = baseline + 34
    label(d, (x0 + 26, ly), "TODAY'S MESSAGES", F_LABEL, MUTED)
    ly += 20
    for t, amt in (("19:34", "+$10.00"), ("18:46", "+$6.00"), ("13:02", "+$5.00")):
        label(d, (x0 + 26, ly), t, F_SMALL, MUTED)
        label(d, (x0 + 92, ly - 2), "Airtime from 252710000040", F_SMALL, INK)
        label(d, (x1 - 26, ly - 2), amt, F_BODY, GREEN, anchor="ra")
        d.line((x0 + 26, ly + 20, x1 - 26, ly + 20), fill=(238, 241, 245), width=1)
        ly += 32

    # footer
    rounded(d, (x0 + 26, y1 - 86, x0 + 250, y1 - 44), 12, fill=(248, 249, 251))
    label(d, (x0 + 42, y1 - 74), "Last checked 19:02", F_TINY, MUTED)
    icon(d, "refresh", x1 - 74, y1 - 65, 15, RED)
    label(d, (x1 - 58, y1 - 73), "Refresh", F_SMALL, RED)


def main():
    gap = 40
    canvas = Image.new("RGB", (W * 2 + gap + 40, H + 70), (236, 239, 243))
    d = ImageDraw.Draw(canvas)
    draw_drawer(canvas, 10, 50)
    draw_sheet(canvas, W + gap + 10, 50)
    label(d, (10 + W / 2, 20), "Drawer: E-voucher with today's total", F_SMALL, INK, anchor="ma")
    label(d, (W + gap + 10 + W / 2, 20), "Sheet: today + this month, with the messages counted", F_SMALL, INK, anchor="ma")
    canvas.save(OUT, "PNG")
    print(OUT)


if __name__ == "__main__":
    main()
