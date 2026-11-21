"""A single, larger rendering of the 'New record' screen (the form after a scan).

Standalone on purpose: the 5-up mockup is small on screen, and this screen is the
one that matters most day to day.
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app-entry.png")

W, H = 520, 1040
BG = (244, 246, 248)
RED = (225, 25, 41)
INK = (16, 28, 43)
MUTED = (110, 122, 138)
LINE = (223, 228, 234)
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


F_H = font(26, True)
F_BODY = font(18)
F_LABEL = font(12, True)
F_HINT = font(13)
F_BTN = font(19, True)


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
        d.line((cx - a * 0.4, cy, cx + a * 0.4, cy), fill=color, width=width)
    elif name == "download":
        d.line((cx, cy - s, cx, cy + s * 0.35), fill=color, width=width)
        d.line((cx - s * 0.5, cy - s * 0.15, cx, cy + s * 0.4), fill=color, width=width)
        d.line((cx + s * 0.5, cy - s * 0.15, cx, cy + s * 0.4), fill=color, width=width)
        d.line((cx - s, cy + s, cx + s, cy + s), fill=color, width=width)


def main():
    img = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(img)

    # status bar
    d.rectangle((0, 0, W, 44), fill=WHITE)
    label(d, (22, 16), "9:41", F_LABEL, MUTED)
    label(d, (W - 22, 16), "100%", F_LABEL, MUTED, anchor="ra")

    # app bar
    d.rectangle((0, 44, W, 130), fill=WHITE)
    icon(d, "menu", 44, 88, 20, INK)
    label(d, (76, 72), "New record", F_H, INK)
    label(d, (76, 102), "Fill the details, then save", F_HINT, MUTED)
    d.line((0, 130, W, 130), fill=LINE, width=1)

    d.rectangle((0, 130, W, H), fill=BG)

    def field(top, caption, value, hint=None, icon_name=None, focus=False):
        label(d, (30, top), caption, F_LABEL, MUTED)
        box = (30, top + 24, W - 30, top + 88)
        rounded(d, box, 14, fill=WHITE, outline=RED if focus else LINE, width=2 if focus else 1)
        label(d, (48, top + 46), value, F_BODY, INK)
        if icon_name:
            icon(d, icon_name, W - 62, top + 56, 20, MUTED, 2)
        if hint:
            label(d, (30, top + 96), hint, F_HINT, MUTED)
            return top + 128
        return top + 108

    y = 168
    y = field(y, "ICCID", "89252637990000001234",
              hint="Wrong digit? Edit it, or tap the icon to scan again",
              icon_name="scan", focus=True)
    y = field(y, "CUSTOMER NAME", "Hodan Ali")
    y = field(y, "PRIMARY NUMBER", "615555001")
    y = field(y, "BACKUP NUMBER", "615555002")

    # Save
    rounded(d, (30, y + 10, W - 30, y + 78), 16, fill=RED)
    label(d, (W / 2, y + 32), "Save record", F_BTN, WHITE, anchor="ma")

    # Save and scan another
    rounded(d, (30, y + 92, W - 30, y + 160), 16, fill=WHITE, outline=LINE)
    label(d, (W / 2, y + 114), "Save and scan another", F_BTN, INK, anchor="ma")

    label(d, (W / 2, H - 62), "Saved on the phone first. Uploaded when online.", F_HINT, MUTED, anchor="ma")
    label(d, (W / 2, H - 40), "ICCID must be 18-22 digits and not already recorded.", F_HINT, MUTED, anchor="ma")

    img.save(OUT, "PNG")
    print(OUT)


if __name__ == "__main__":
    main()
