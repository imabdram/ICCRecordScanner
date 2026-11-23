"""Final e-voucher interface: drawer entry, the sheet, and the permission prompt."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app-voucher-final.png")

W, H = 460, 900
GAP = 34
BG = (236, 239, 243)
RED = (225, 25, 41)
RED_SOFT = (232, 145, 152)
INK = (16, 28, 43)
MUTED = (110, 122, 138)
LINE = (238, 241, 245)
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


F_H = font(21, True)
F_BIG = font(25, True)
F_BODY = font(14)
F_LABEL = font(9, True)
F_SMALL = font(11)
F_TINY = font(9)
F_T = font(14, True)


def label(d, xy, text, f, fill=INK, anchor="la"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def rounded(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def icon(d, name, cx, cy, size=15, color=INK, width=2):
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
        rounded(d, (cx - s, cy - s * 0.6, cx + s, cy + s * 0.6), 3, outline=color, width=width)
        d.line((cx - s * 0.4, cy, cx + s * 0.4, cy), fill=color, width=width)
    elif name == "sync":
        d.arc((cx - s, cy - s, cx + s, cy + s), 30, 320, fill=color, width=width)
    elif name == "gear":
        d.ellipse((cx - s * 0.5, cy - s * 0.5, cx + s * 0.5, cy + s * 0.5), outline=color, width=width)
        d.ellipse((cx - 1.6, cy - 1.6, cx + 1.6, cy + 1.6), fill=color)
    elif name == "logout":
        d.line((cx - s, cy - s, cx - s, cy + s), fill=color, width=width)
        d.line((cx - s, cy, cx + s, cy), fill=color, width=width)
        d.line((cx + s * 0.25, cy - s * 0.5, cx + s, cy), fill=color, width=width)
        d.line((cx + s * 0.25, cy + s * 0.5, cx + s, cy), fill=color, width=width)
    elif name == "refresh":
        d.arc((cx - s, cy - s, cx + s, cy + s), 40, 320, fill=color, width=width)
    elif name == "sms":
        rounded(d, (cx - s, cy - s * 0.7, cx + s, cy + s * 0.7), 4, outline=color, width=width)


def phone(d, x, y, title):
    rounded(d, (x, y, x + W, y + H), 26, fill=WHITE, outline=(210, 216, 224), width=2)
    rounded(d, (x + W // 2 - 36, y + 8, x + W // 2 + 36, y + 18), 5, fill=(232, 236, 241))
    label(d, (x + W / 2, y + H + 14), title, F_SMALL, MUTED, anchor="ma")
    return (x, y + 26, x + W, y + H)


def status(d, x0, y0):
    label(d, (x0 + 18, y0 + 10), "9:41", F_TINY, MUTED)
    label(d, (x0 + W - 18, y0 + 10), "100%", F_TINY, MUTED, anchor="ra")


DATA = [0, 8, 12, 0, 6, 18, 24, 10, 0, 14, 6, 20, 4, 9, 0, 12, 16, 8, 22, 6, 10, 14, 26]
TODAY = 23
MONTH_DAYS = 30


# ------------------------------------------------------------- 1. drawer
def drawer(img, x, y):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = phone(d, x, y, "1 - Side menu")
    d.rectangle((x0, y0, x1, y1), fill=(235, 238, 242))
    d.rectangle((x0, y0, x0 + 310, y1), fill=WHITE)
    status(d, x0, y0)

    d.ellipse((x0 + 22, y0 + 52, x0 + 74, y0 + 104), fill=RED)
    label(d, (x0 + 48, y0 + 64), "YG", F_BODY, WHITE, anchor="ma")
    label(d, (x0 + 86, y0 + 54), "Yacquub Gelle", F_H, INK)
    label(d, (x0 + 86, y0 + 82), "TEAM LEADER", F_LABEL, MUTED)
    label(d, (x0 + 86, y0 + 98), "Alla-aamin Qardho", F_TINY, MUTED)

    y2 = y0 + 122
    rounded(d, (x0 + 16, y2, x0 + 294, y2 + 112), 12, fill=(248, 249, 251))
    for i, (k, v) in enumerate([("Zone", "Zone 2"), ("Region", "Bari Region"),
                                ("Outlet", "Alla-aamin Qardho"), ("Team leader", "-")]):
        label(d, (x0 + 30, y2 + 10 + i * 25), k, F_TINY, MUTED)
        label(d, (x0 + 108, y2 + 10 + i * 25), v, F_SMALL, INK)

    nav = y0 + 258
    for glyph, name in (("scan", "Scan"), ("list", "Records")):
        icon(d, glyph, x0 + 34, nav + 7, 15, MUTED)
        label(d, (x0 + 54, nav), name, F_BODY, INK)
        nav += 42

    d.line((x0 + 16, nav + 2, x0 + 294, nav + 2), fill=LINE, width=1)
    nav += 16

    rounded(d, (x0 + 10, nav - 8, x0 + 300, nav + 34), 10, fill=(253, 236, 238))
    icon(d, "cash", x0 + 34, nav + 12, 16, RED)
    label(d, (x0 + 54, nav), "E-voucher", F_BODY, RED)
    label(d, (x0 + 54, nav + 18), "Today  $26.00", F_TINY, (170, 60, 70))
    nav += 46

    for glyph, name, trailing in (("sync", "Sync now", "3 pending"),
                                  ("gear", "Settings", None),
                                  ("logout", "Sign out", None)):
        icon(d, glyph, x0 + 34, nav + 7, 15, MUTED)
        label(d, (x0 + 54, nav), name, F_BODY, INK)
        if trailing:
            rounded(d, (x0 + 216, nav - 2, x0 + 292, nav + 20), 8, fill=(243, 246, 249))
            label(d, (x0 + 254, nav + 2), trailing, F_TINY, MUTED, anchor="ma")
        nav += 42


# -------------------------------------------------------------- 2. sheet
def sheet(img, x, y):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = phone(d, x, y, "2 - E-voucher (bar chart)")
    d.rectangle((x0, y0, x1, y1), fill=(232, 235, 240))
    d.rectangle((x0, y0, x1, y0 + 84), fill=WHITE)
    status(d, x0, y0)
    label(d, (x0 + 20, y0 + 44), "Records", F_H, INK)
    label(d, (x0 + 20, y0 + 70), "5 records | 2 pending", F_TINY, MUTED)

    top = y0 + 128
    rounded(d, (x0 + 8, top, x1 - 8, y1 - 6), 20, fill=WHITE)
    rounded(d, (x0 + W / 2 - 20, top + 9, x0 + W / 2 + 20, top + 14), 3, fill=(214, 220, 228))

    label(d, (x0 + 24, top + 26), "E-voucher", F_H, INK)
    label(d, (x0 + 24, top + 52), "From SMS - sender 913", F_TINY, MUTED)
    label(d, (x1 - 24, top + 34), "November", F_SMALL, MUTED, anchor="ra")

    cy = top + 74
    for i, (cap, amount, sub, accent) in enumerate([
            ("TODAY", "$26.00", "3 vouchers", RED),
            ("THIS MONTH", "$245.00", "15 vouchers", INK)]):
        bx = x0 + 24 + i * 200
        rounded(d, (bx, cy, bx + 186, cy + 74), 12, fill=(248, 249, 251))
        label(d, (bx + 12, cy + 8), cap, F_LABEL, MUTED)
        label(d, (bx + 12, cy + 24), amount, F_BIG, accent)
        label(d, (bx + 12, cy + 56), sub, F_TINY, MUTED)

    # bars
    chart_top = cy + 96
    label(d, (x0 + 24, chart_top), "NOVEMBER BY DAY", F_LABEL, MUTED)
    left, right = x0 + 24, x1 - 24
    ph = 110
    base = chart_top + 26 + ph
    for frac in (0, 0.5, 1):
        d.line((left, base - ph * frac, right, base - ph * frac), fill=LINE, width=1)

    slot = (right - left) / MONTH_DAYS
    bar_w = slot * 0.62
    vmax = max(DATA)
    for i in range(MONTH_DAYS):
        day = i + 1
        val = DATA[i] if i < len(DATA) else 0
        bx = left + i * slot + (slot - bar_w) / 2
        h = (val / vmax) * (ph - 4) if val else 0
        colour = RED if day == TODAY else (RED_SOFT if val else (240, 243, 247))
        if h == 0:
            d.line((bx, base - 2, bx + bar_w, base - 2), fill=colour, width=3)
        else:
            rounded(d, (bx, base - h, bx + bar_w, base), 3, fill=colour)

    for i in range(0, MONTH_DAYS, 5):
        label(d, (left + i * slot + slot / 2, base + 6), str(i + 1), F_TINY, MUTED, anchor="ma")
    label(d, (left + (TODAY - 1) * slot + slot / 2, base + 6), str(TODAY), F_TINY, RED, anchor="ma")

    # today's messages
    ly = base + 30
    label(d, (x0 + 24, ly), "TODAY'S MESSAGES", F_LABEL, MUTED)
    ly += 18
    for t, amt in (("19:34", "+$10.00"), ("18:46", "+$6.00"), ("13:02", "+$5.00")):
        label(d, (x0 + 24, ly), t, F_SMALL, MUTED)
        label(d, (x0 + 80, ly - 1), "Airtime from 252710000040", F_SMALL, INK)
        label(d, (x1 - 24, ly - 1), amt, F_BODY, GREEN, anchor="ra")
        d.line((x0 + 24, ly + 18, x1 - 24, ly + 18), fill=LINE, width=1)
        ly += 30

    rounded(d, (x0 + 24, y1 - 76, x0 + 220, y1 - 38), 11, fill=(248, 249, 251))
    label(d, (x0 + 38, y1 - 66), "Last checked 19:02", F_TINY, MUTED)
    icon(d, "refresh", x1 - 62, y1 - 58, 14, RED)
    label(d, (x1 - 48, y1 - 66), "Refresh", F_SMALL, RED)


# ------------------------------------------------------- 3. permission
def permission(img, x, y):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = phone(d, x, y, "3 - First open: permission")
    d.rectangle((x0, y0, x1, y1), fill=(20, 22, 28))
    d.rectangle((x0, y0, x1, y1), fill=(232, 235, 240, 255))
    d.rectangle((x0, y0, x1, y1), fill=(214, 218, 226))

    # dialog
    dw, dh = 360, 380
    dx, dy = x0 + (W - dw) / 2, y0 + 200
    rounded(d, (dx, dy, dx + dw, dy + dh), 20, fill=WHITE)

    d.ellipse((dx + dw / 2 - 26, dy + 26, dx + dw / 2 + 26, dy + 78), fill=(253, 236, 238))
    icon(d, "sms", dx + dw / 2, dy + 52, 22, RED, 2)

    label(d, (dx + dw / 2, dy + 96), "Read 913 messages?", F_T, INK, anchor="ma")
    label(d, (dx + 30, dy + 132), "The app totals your e-voucher airtime", F_SMALL, MUTED)
    label(d, (dx + 30, dy + 150), "from the 913 messages on this phone.", F_SMALL, MUTED)
    label(d, (dx + 30, dy + 176), "Only messages from 913 are read, and", F_SMALL, MUTED)
    label(d, (dx + 30, dy + 194), "nothing is sent anywhere.", F_SMALL, MUTED)

    rounded(d, (dx + 30, dy + 226, dx + dw - 30, dy + 272), 12, fill=RED)
    label(d, (dx + dw / 2, dy + 240), "Allow", F_BODY, WHITE, anchor="ma")

    rounded(d, (dx + 30, dy + 284, dx + dw - 30, dy + 330), 12, fill=WHITE, outline=(226, 230, 235))
    label(d, (dx + dw / 2, dy + 298), "Not now", F_BODY, INK, anchor="ma")

    label(d, (dx + dw / 2, dy + dh + 16), "Asked only once, when you first open it", F_TINY, MUTED, anchor="ma")


def main():
    canvas = Image.new("RGB", (W * 3 + GAP * 4, H + 80), BG)
    d = ImageDraw.Draw(canvas)
    label(d, (GAP, 18), "E-voucher - final interface", font(15, True), INK)

    drawer(canvas, GAP, 50)
    sheet(canvas, GAP * 2 + W, 50)
    permission(canvas, GAP * 3 + W * 2, 50)

    canvas.save(OUT, "PNG")
    print(OUT)


if __name__ == "__main__":
    main()
