"""Renders an .xlsx as a PNG preview, preserving the styling that matters
(header fill, bold white text, borders, alignment, column widths).

Used to check the export without opening Excel.
"""
import sys, os
import openpyxl
from PIL import Image, ImageDraw, ImageFont

SRC = sys.argv[1] if len(sys.argv) > 1 else "tools/.out/customers_test.xlsx"
OUT = sys.argv[2] if len(sys.argv) > 2 else "tools/.out/customers_preview.png"

wb = openpyxl.load_workbook(SRC)
ws = wb.active

SCALE = 1.6
PX_PER_CHAR = 7.2
ROW_H = 22
HEADER_H = 26
PAD = 18


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


F = font(11, True)
FB = font(11)

# column widths in "characters" -> pixels, like Excel
widths = []
for col in range(1, ws.max_column + 1):
    letter = openpyxl.utils.get_column_letter(col)
    w = ws.column_dimensions[letter].width or 10
    widths.append(int(w * PX_PER_CHAR * SCALE))

total_w = sum(widths) + PAD * 2
total_h = HEADER_H + (ws.max_row - 1) * ROW_H + PAD * 2

img = Image.new("RGB", (total_w, total_h), "white")
d = ImageDraw.Draw(img)

y = PAD
for r in range(1, ws.max_row + 1):
    x = PAD
    h = HEADER_H if r == 1 else ROW_H
    for c in range(1, ws.max_column + 1):
        cell = ws.cell(row=r, column=c)
        w = widths[c - 1]

        fill = None
        fg = cell.fill
        if fg is not None and fg.patternType == "solid" and fg.fgColor and fg.fgColor.rgb:
            rgb = str(fg.fgColor.rgb)
            if len(rgb) == 8:
                fill = "#" + rgb[2:]
        if fill:
            d.rectangle((x, y, x + w, y + h), fill=fill)

        if cell.border and cell.border.bottom and cell.border.bottom.style:
            d.line((x, y + h, x + w, y + h), fill=(200, 205, 212), width=1)

        text = "" if cell.value is None else str(cell.value)
        align = cell.alignment.horizontal if cell.alignment else None
        use_bold = bool(cell.font and cell.font.bold)
        colour = (16, 28, 43)
        if cell.font and cell.font.color and cell.font.color.rgb:
            crgb = str(cell.font.color.rgb)
            if len(crgb) == 8:
                colour = tuple(int(crgb[i:i + 2], 16) for i in (2, 4, 6))

        fnt = F if use_bold else FB
        if align == "center":
            tw = d.textlength(text, font=fnt)
            d.text((x + (w - tw) / 2, y + (h - 15) / 2), text, font=fnt, fill=colour)
        else:
            d.text((x + 6, y + (h - 15) / 2), text, font=fnt, fill=colour)
        x += w
    y += h

os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save(OUT, "PNG")
print(OUT)
