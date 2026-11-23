"""Simplest form: every day of the month, 1..end, with that day's total."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app-voucher-days.png")

W, H = 520, 1040
RED = (225, 25, 41)
INK = (16, 28, 43)
MUTED = (110, 122, 138)
LINE = (238, 241, 245)
WHITE = (255, 255, 255)
BG = (236, 239, 243)


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


F_H = font(22, True)
F_BIG = font(26, True)
F_BODY = font(15)
F_LABEL = font(10, True)
F_SMALL = font(12)
F_TINY = font(10)


def label(d, xy, text, f, fill=INK, anchor="la"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def rounded(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def icon(d, name, cx, cy, size=14, color=INK, width=2):
    s = size / 2.0
    if name == "refresh":
        d.arc((cx - s, cy - s, cx + s, cy + s), 40, 320, fill=color, width=width)


# 23 days so far, rest of the month is zero / not yet
DATA = [0, 8, 12, 0, 6, 18, 24, 10, 0, 14, 6, 20, 4, 9, 0, 12, 16, 8, 22, 6, 10, 14, 26]
TODAY = 23
MONTH_DAYS = 30
TOTAL = sum(DATA)
VOUCHERS = 15


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # dimmed page behind the full-height sheet
    d.rectangle((0, 0, W, H), fill=BG)
    label(d, (22, 16), "9:41", F_TINY, MUTED)
    label(d, (W - 22, 16), "100%", F_TINY, MUTED, anchor="ra")

    top = 46
    rounded(d, (10, top, W - 10, H - 10), 22, fill=WHITE)
    rounded(d, (W / 2 - 22, top + 10, W / 2 + 22, top + 16), 3, fill=(214, 220, 228))

    # header
    label(d, (30, top + 34), "E-voucher", F_H, INK)
    label(d, (30, top + 62), "From SMS - sender 913", F_TINY, MUTED)
    label(d, (W - 30, top + 40), "November 2026", F_SMALL, MUTED, anchor="ra")

    # totals
    cy = top + 86
    for i, (cap, amount, sub, accent) in enumerate([
            ("TODAY", f"${DATA[TODAY - 1]}.00", "3 vouchers", RED),
            ("THIS MONTH", f"${TOTAL}.00", f"{VOUCHERS} vouchers", INK)]):
        bx = 30 + i * 232
        rounded(d, (bx, cy, bx + 216, cy + 82), 14, fill=(248, 249, 251))
        label(d, (bx + 14, cy + 10), cap, F_LABEL, MUTED)
        label(d, (bx + 14, cy + 28), amount, F_BIG, accent)
        label(d, (bx + 14, cy + 62), sub, F_TINY, MUTED)

    # ---- every day of the month, two columns -------------------------------
    label(d, (30, cy + 104), "EVERY DAY", F_LABEL, MUTED)

    list_top = cy + 124
    row_h = 30
    half = MONTH_DAYS // 2          # 15 rows per column
    col_w = 216

    for i in range(MONTH_DAYS):
        day = i + 1
        col = 0 if i < half else 1
        row = i if col == 0 else i - half
        bx = 30 + col * 232
        ry = list_top + row * row_h

        amount = DATA[i] if i < len(DATA) else 0
        is_today = day == TODAY
        future = day > TODAY

        # today's row gets a soft red pill so it is findable instantly
        if is_today:
            rounded(d, (bx - 6, ry - 3, bx + col_w + 6, ry + row_h - 7), 8, fill=(253, 236, 238))

        day_colour = RED if is_today else (MUTED if future else INK)
        amt_colour = RED if is_today else (MUTED if (future or amount == 0) else INK)

        label(d, (bx + 4, ry), f"{day}", F_BODY, day_colour)
        label(d, (bx + 34, ry + 1), "Nov", F_TINY, MUTED)
        text = "$0.00" if amount == 0 else f"${amount}.00"
        label(d, (bx + col_w - 4, ry), text, F_BODY, amt_colour, anchor="ra")

        if not future:
            d.line((bx + 4, ry + row_h - 8, bx + col_w - 4, ry + row_h - 8), fill=LINE, width=1)

    # footer
    fy = H - 96
    rounded(d, (30, fy, 250, fy + 44), 12, fill=(248, 249, 251))
    label(d, (46, fy + 12), "Last checked 19:02", F_TINY, MUTED)
    icon(d, "refresh", W - 78, fy + 22, 15, RED)
    label(d, (W - 60, fy + 13), "Refresh", F_SMALL, RED)

    img.save(OUT, "PNG")
    print(OUT)


if __name__ == "__main__":
    main()
