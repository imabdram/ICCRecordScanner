"""Login page design preview: desktop + mobile. Uses the supplied Amtel logo."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "login-design-preview.png")
LOGO = os.path.join(HERE, "amtel-logo.png")

RED = (227, 6, 19)
NAVY = (16, 42, 84)
INK = (17, 24, 39)
MUTED = (110, 119, 134)
LINE = (226, 232, 240)
WHITE = (255, 255, 255)
BG = (246, 247, 250)


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


F_H1 = font(26, True)
F_H2 = font(19, True)
F_B = font(15)
F_S = font(13)
F_XS = font(11.5)
F_LBL = font(11, True)
F_BTN = font(15, True)


def label(d, xy, text, f, fill=INK, anchor="la"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def trim_white(im, tol=246):
    """Crop the flat white margin around the logo, keeping its proportions."""
    px = im.convert("RGB").load()
    w, h = im.size
    left, right, top, bottom = w, 0, h, 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r < tol or g < tol or b < tol:
                left = min(left, x); right = max(right, x)
                top = min(top, y); bottom = max(bottom, y)
    return im.crop((left, top, right + 1, bottom + 1))


def shadow(img, box, radius, blur=18, alpha=26):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle(box, radius=radius, fill=(15, 23, 42, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    img.alpha_composite(layer)


def load_logo(width):
    logo = trim_white(Image.open(LOGO).convert("RGB"))
    ratio = width / logo.width
    return logo.resize((width, int(logo.height * ratio)), Image.LANCZOS)


# ------------------------------------------------------------------ desktop
W, H = 1600, 880
img = Image.new("RGBA", (W, H), BG + (255,))
d = ImageDraw.Draw(img)

# soft background accents (red + navy curves, kept subtle)
acc = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ad = ImageDraw.Draw(acc)
ad.ellipse((-320, H - 340, 420, H + 300), fill=(227, 6, 19, 18))
ad.ellipse((W - 520, -300, W + 240, 300), fill=(16, 42, 84, 16))
ad.ellipse((W - 260, H - 200, W + 300, H + 260), fill=(227, 6, 19, 10))
acc = acc.filter(ImageFilter.GaussianBlur(42))
img.alpha_composite(acc)

# thin arc lines, office-style
arc = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ard = ImageDraw.Draw(arc)
ard.arc((-180, H - 300, 520, H + 200), 200, 340, fill=(227, 6, 19, 60), width=3)
ard.arc((W - 460, -160, W + 160, 320), 20, 160, fill=(16, 42, 84, 45), width=3)
img.alpha_composite(arc)

# brand top-left
logo_big = load_logo(150)
img.alpha_composite(logo_big.convert("RGBA"), (64, 54))
label(d, (64, 54 + logo_big.height + 10), "Always closer you", F_S, MUTED)

# card
cw, ch = 430, 566
cx, cy = 150, (H - ch) // 2 - 6
shadow(img, (cx, cy + 10, cx + cw, cy + ch + 10), 22)
d.rounded_rectangle((cx, cy, cx + cw, cy + ch), radius=22, fill=WHITE, outline=(237, 240, 245))

pad = 40
logo_card = load_logo(132)
img.alpha_composite(logo_card.convert("RGBA"), (cx + pad, cy + 38))

label(d, (cx + pad, cy + 40 + logo_card.height + 16), "SIM Management System", F_H1)
label(d, (cx + pad, cy + 40 + logo_card.height + 56),
      "Sign in to the Bari Region operations console.", F_S, MUTED)

y = cy + 40 + logo_card.height + 96

# username
label(d, (cx + pad, y), "USERNAME", F_LBL, MUTED)
y += 18
d.rounded_rectangle((cx + pad, y, cx + cw - pad, y + 46), radius=11, fill=(250, 251, 253), outline=LINE)
label(d, (cx + pad + 14, y + 14), "your.username", F_B, (150, 158, 170))
y += 62

# password
label(d, (cx + pad, y), "PASSWORD", F_LBL, MUTED)
y += 18
d.rounded_rectangle((cx + pad, y, cx + cw - pad, y + 46), radius=11, fill=(250, 251, 253), outline=LINE)
label(d, (cx + pad + 14, y + 14), "••••••••••", F_B, INK)
# eye toggle
ex, ey = cx + cw - pad - 26, y + 23
d.arc((ex - 10, ey - 6, ex + 10, ey + 6), 200, 340, fill=MUTED, width=2)
d.arc((ex - 10, ey - 6, ex + 10, ey + 6), 20, 160, fill=MUTED, width=2)
d.ellipse((ex - 3, ey - 3, ex + 3, ey + 3), fill=MUTED)

y += 66
# button
d.rounded_rectangle((cx + pad, y, cx + cw - pad, y + 48), radius=12, fill=RED)
label(d, (cx + cw / 2, y + 15), "Sign in", F_BTN, WHITE, anchor="ma")

y += 70
# security notice
box_h = 92
d.rounded_rectangle((cx + pad, y, cx + cw - pad, y + box_h), radius=11, fill=(250, 246, 246), outline=(246, 228, 230))
label(d, (cx + pad + 14, y + 12), "SECURITY NOTICE", F_LBL, (150, 40, 48))
notice = ("Accounts are created by an administrator. If you have forgotten "
          "your password, ask them to set a new one — there is no reset email.")
words = notice.split()
lines, cur = [], ""
for wd in words:
    probe = (cur + " " + wd).strip()
    if d.textlength(probe, font=F_XS) > (cw - pad * 2 - 28):
        lines.append(cur); cur = wd
    else:
        cur = probe
lines.append(cur)
for i, line in enumerate(lines):
    label(d, (cx + pad + 14, y + 34 + i * 18), line, F_XS, (108, 84, 88))

label(d, (cx + cw / 2, cy + ch - 26), "Amtel · Bari Region", F_XS, (166, 173, 184), anchor="ma")

# ------------------------------------------------------------------- mobile
MW, MH = 390, 780
mx = W - MW - 150
my = (H - MH) // 2
shadow(img, (mx, my + 8, mx + MW, my + MH + 8), 26)
d.rounded_rectangle((mx, my, mx + MW, my + MH), radius=26, fill=WHITE, outline=(232, 236, 242))
label(d, (mx + MW - 60, my - 26), "mobile", F_S, MUTED)

logo_m = load_logo(104)
img.alpha_composite(logo_m.convert("RGBA"), (mx + (MW - logo_m.width) // 2, my + 52))
label(d, (mx + MW / 2, my + 52 + logo_m.height + 8), "Always closer you", F_XS, MUTED, anchor="ma")

ty = my + 52 + logo_m.height + 48
label(d, (mx + 26, ty), "SIM Management System", F_H2, )
label(d, (mx + 26, ty + 26), "Sign in to the Bari Region console.", F_XS, MUTED)

ty += 62
label(d, (mx + 26, ty), "USERNAME", F_LBL, MUTED)
ty += 18
d.rounded_rectangle((mx + 26, ty, mx + MW - 26, ty + 44), radius=11, fill=(250, 251, 253), outline=LINE)
label(d, (mx + 40, ty + 13), "your.username", F_S, (150, 158, 170))
ty += 60
label(d, (mx + 26, ty), "PASSWORD", F_LBL, MUTED)
ty += 18
d.rounded_rectangle((mx + 26, ty, mx + MW - 26, ty + 44), radius=11, fill=(250, 251, 253), outline=LINE)
label(d, (mx + 40, ty + 13), "••••••••••", F_S, INK)
ty += 64
d.rounded_rectangle((mx + 26, ty, mx + MW - 26, ty + 46), radius=12, fill=RED)
label(d, (mx + MW / 2, ty + 14), "Sign in", F_BTN, WHITE, anchor="ma")

ty += 68
d.rounded_rectangle((mx + 26, ty, mx + MW - 26, ty + 108), radius=11, fill=(250, 246, 246), outline=(246, 228, 230))
label(d, (mx + 40, ty + 12), "SECURITY NOTICE", F_LBL, (150, 40, 48))
mwords = notice.split()
mlines, cur = [], ""
for wd in mwords:
    probe = (cur + " " + wd).strip()
    if d.textlength(probe, font=F_XS) > (MW - 80):
        mlines.append(cur); cur = wd
    else:
        cur = probe
mlines.append(cur)
for i, line in enumerate(mlines):
    label(d, (mx + 40, ty + 34 + i * 17), line, F_XS, (108, 84, 88))

img.convert("RGB").save(OUT, "PNG")
print(OUT)
