"""Recommended filter bar: search + cascading Zone/Area/Outlet + active chips."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voucher-filters.png")

W, H = 1480, 430
BG = (247, 248, 250)
WHITE = (255, 255, 255)
INK = (16, 28, 43)
MUTED = (110, 122, 138)
LINE = (226, 231, 237)
RED = (225, 25, 41)


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


F_T = font(19, True)
F_L = font(10, True)
F_B = font(13)
F_S = font(11)
F_XS = font(10)
F_CHIP = font(11, True)


def label(d, xy, text, f, fill=INK, anchor="la"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def box(d, rect, r=10, fill=WHITE, outline=LINE, width=1):
    d.rounded_rectangle(rect, radius=r, fill=fill, outline=outline, width=width)


def caret(d, x, y, colour=MUTED):
    d.line((x - 4, y - 1, x, y + 3), fill=colour, width=2)
    d.line((x, y + 3, x + 4, y - 1), fill=colour, width=2)


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

label(d, (28, 20), "E-vouchers", F_T)
label(d, (28, 46), "Airtime per rep · click a rep, then a day", F_S, MUTED)
label(d, (W - 28, 24), "Team Leader", F_S, MUTED, anchor="ra")

# ---- search ----------------------------------------------------------------
y = 78
box(d, (28, y, 300, y + 40), 10)
label(d, (44, y + 13), "Search name or phone…", F_S, MUTED)

# ---- cascading selects ------------------------------------------------------
fields = [("ZONE", "All zones", 320), ("AREA", "All areas", 510), ("OUTLET", "All outlets", 700)]
for caption, value, x in fields:
    label(d, (x, y - 16), caption, F_L, MUTED)
    box(d, (x, y, x + 176, y + 40), 10)
    label(d, (x + 14, y + 13), value, F_S, INK)
    caret(d, x + 158, y + 20)

label(d, (900, y - 16), "", F_L, MUTED)
box(d, (900, y, 1032, y + 40), 10, fill=WHITE)
label(d, (966, y + 13), "Reset filters", F_S, INK, anchor="ma")

# ---- active chips -----------------------------------------------------------
cy = y + 62
label(d, (28, cy + 4), "Showing", F_XS, MUTED)
x = 84
for text in ("Zone 2", "Bari Region", "Alla-aamin Qardho"):
    w = F_CHIP.getlength(text) + 40
    box(d, (x, cy, x + w, cy + 26), 13, fill=(253, 236, 238), outline=(250, 214, 218))
    label(d, (x + 12, cy + 6), text, F_CHIP, (176, 42, 52))
    label(d, (x + w - 18, cy + 5), "×", F_S, (176, 42, 52))
    x += w + 8
label(d, (x + 10, cy + 6), "12 of 26 reps", F_XS, MUTED)

# ---- table ------------------------------------------------------------------
ty = cy + 48
box(d, (28, ty, W - 28, H - 24), 12, fill=WHITE)
cols = [(46, "Sales rep"), (420, "Number"), (560, "Outlet"), (760, "Region"),
        (960, "Today"), (1080, "This month"), (1210, "Last sync")]
for cx, name in cols:
    label(d, (cx, ty + 14), name.upper(), F_L, MUTED)

rows = [
    ("▾ Abdirahman A.", "0717102026", "Alla-aamin Qardho", "Bari", "$15.00", "$546.91", "today", True),
    ("    24 Nov", "1 voucher(s)", "", "", "", "$15.00", "", False),
    ("    23 Nov", "3 voucher(s)", "", "", "", "$30.00", "", False),
    ("▸ Hodan Ali", "0612345678", "Customer care B.", "Bari", "$26.00", "$245.00", "today", True),
    ("▸ Muse Khalid", "0901234567", "Galkacyo HQ", "Mudug", "$0.00", "$0.00", "never", True),
]
ry = ty + 40
for name, num, outlet, region, today, month, sync, strong in rows:
    if name.strip().startswith(("24", "23")):
        label(d, (46, ry), name, F_S, MUTED)
        label(d, (420, ry), num, F_S, MUTED)
        label(d, (1080, ry), month, F_S, INK, anchor="ra")
    else:
        label(d, (46, ry), name, F_B, INK)
        label(d, (420, ry), num, F_S, MUTED)
        label(d, (560, ry), outlet, F_S, INK)
        label(d, (760, ry), region, F_S, INK)
        label(d, (1010, ry), today, F_S, INK, anchor="ra")
        label(d, (1170, ry), month, F_B, INK, anchor="ra")
        if sync:
            tone = (31, 122, 61) if sync == "today" else (179, 38, 30)
            bg = (234, 246, 238) if sync == "today" else (253, 236, 238)
            box(d, (1250, ry - 4, 1350, ry + 18), 10, fill=bg, outline=bg)
            label(d, (1300, ry + 1), sync, F_XS, tone, anchor="ma")
    d.line((46, ry + 26, W - 60, ry + 26), fill=(240, 243, 247), width=1)
    ry += 34

# footer totals
d.line((46, ry + 2, W - 60, ry + 2), fill=(203, 210, 219), width=2)
label(d, (46, ry + 12), "TOTAL (12 reps)", F_B, INK)
label(d, (1010, ry + 12), "$41.00", F_S, INK, anchor="ra")
label(d, (1170, ry + 12), "$791.91", F_B, INK, anchor="ra")
label(d, (1250, ry + 12), "2 not syncing", F_XS, (179, 38, 30))

img.save(OUT, "PNG")
print(OUT)
