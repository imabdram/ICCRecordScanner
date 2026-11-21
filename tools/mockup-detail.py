"""Record detail, in both states:
   pending  -> can be edited and deleted (nothing on the server yet)
   uploaded -> can be edited, but NOT deleted from the phone (the office owns it)

Rendered side by side so the difference is visible at a glance.
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app-detail.png")

W, H = 520, 1040
BG = (244, 246, 248)
RED = (225, 25, 41)
INK = (16, 28, 43)
MUTED = (110, 122, 138)
LINE = (223, 228, 234)
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
F_BODY = font(18)
F_LABEL = font(12, True)
F_SMALL = font(14)
F_TINY = font(12)
F_HINT = font(13)
F_BTN = font(19, True)


def rounded(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def label(d, xy, text, f, fill=INK, anchor="la"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor)


def icon(d, name, cx, cy, size=16, color=INK, width=2):
    s = size / 2.0
    if name == "back":
        d.line((cx + s * 0.6, cy - s, cx - s * 0.4, cy), fill=color, width=width)
        d.line((cx - s * 0.4, cy, cx + s * 0.6, cy + s), fill=color, width=width)
    elif name == "scan":
        a = s * 0.8
        for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            d.line((cx + sx * a, cy + sy * a, cx + sx * a - sx * a * 0.55, cy + sy * a), fill=color, width=width)
            d.line((cx + sx * a, cy + sy * a, cx + sx * a, cy + sy * a - sy * a * 0.55), fill=color, width=width)
    elif name == "trash":
        d.line((cx - s * 0.8, cy - s * 0.5, cx + s * 0.8, cy - s * 0.5), fill=color, width=width)
        d.rectangle((cx - s * 0.55, cy - s * 0.4, cx + s * 0.55, cy + s * 0.8), outline=color, width=width)
        d.line((cx - s * 0.2, cy - s, cx + s * 0.2, cy - s), fill=color, width=width)


def draw_state(uploaded: bool) -> Image.Image:
    img = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(img)

    label(d, (22, 16), "9:41", F_LABEL, MUTED)
    label(d, (W - 22, 16), "100%", F_LABEL, MUTED, anchor="ra")

    d.rectangle((0, 44, W, 130), fill=WHITE)
    icon(d, "back", 42, 88, 20, INK)
    label(d, (76, 64), "Record", F_H, INK)
    label(d, (76, 98), "Uploaded to the office" if uploaded else "Saved on this phone", F_HINT, MUTED)
    d.line((0, 130, W, 130), fill=LINE, width=1)

    d.rectangle((0, 130, W, H), fill=BG)

    # status strip
    rounded(d, (24, 150, W - 24, 214), 14, fill=WHITE)
    d.ellipse((44, 168, 76, 200), fill=GREEN if uploaded else AMBER)
    label(d, (92, 162), "Uploaded" if uploaded else "Waiting to upload", F_BODY, INK)
    label(d, (92, 186),
          "Saved by the office; edit it there" if uploaded else "Will send automatically when online",
          F_TINY, MUTED)
    label(d, (W - 44, 172), "synced" if uploaded else "pending",
          F_TINY, GREEN if uploaded else (190, 130, 30), anchor="ra")

    def field(top, caption, value, icon_name=None):
        label(d, (30, top), caption, F_LABEL, MUTED)
        rounded(d, (30, top + 24, W - 30, top + 88), 14, fill=WHITE, outline=LINE)
        label(d, (48, top + 46), value, F_BODY, INK)
        if icon_name:
            icon(d, icon_name, W - 62, top + 56, 20, MUTED, 2)
        return top + 108

    y = 232
    y = field(y, "ICCID", "89252637990000001234", icon_name=None if uploaded else "scan")
    y = field(y, "CUSTOMER NAME", "Hodan Ali")
    y = field(y, "PRIMARY NUMBER", "615555001")
    y = field(y, "BACKUP NUMBER", "615555002")

    label(d, (30, y + 4), "Recorded", F_LABEL, MUTED)
    label(d, (140, y + 2), "Hodan Ali | 21 Nov 2026, 18:20", F_SMALL, INK)
    label(d, (30, y + 30), "Outlet", F_LABEL, MUTED)
    label(d, (140, y + 28), "Customer care Bosaso", F_SMALL, INK)

    ay = y + 76
    rounded(d, (30, ay, W - 30, ay + 68), 16, fill=RED)
    label(d, (W / 2, ay + 22), "Update", F_BTN, WHITE, anchor="ma")

    if not uploaded:
        # Delete exists only while the record is still local.
        rounded(d, (30, ay + 82, W - 30, ay + 150), 16, fill=WHITE, outline=(240, 205, 208))
        icon(d, "trash", W / 2 - 58, ay + 116, 17, RED)
        label(d, (W / 2 - 38, ay + 105), "Delete record", F_BTN, RED)
        label(d, (W / 2, ay + 172), "Only possible until it uploads.", F_HINT, MUTED, anchor="ma")
    else:
        label(d, (W / 2, ay + 96), "No delete: the office keeps this record.",
              F_HINT, MUTED, anchor="ma")

    label(d, (W / 2, H - 40),
          "Edits here update the office copy too." if uploaded and False else "",
          F_HINT, MUTED, anchor="ma")

    return img


def main():
    left = draw_state(uploaded=False)
    right = draw_state(uploaded=True)

    gap = 40
    canvas = Image.new("RGB", (W * 2 + gap + 40, H + 70), (236, 239, 243))
    d = ImageDraw.Draw(canvas)
    canvas.paste(left, (10, 50))
    canvas.paste(right, (W + gap + 10, 50))
    label(d, (10 + W / 2, 20), "1 - Before upload (delete available)", F_SMALL, INK, anchor="ma")
    label(d, (W + gap + 10 + W / 2, 20), "2 - After upload (no delete)", F_SMALL, INK, anchor="ma")
    canvas.save(OUT, "PNG")
    print(OUT)


if __name__ == "__main__":
    main()
