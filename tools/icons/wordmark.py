"""Writes the wordmark: the icon above "forkit" set in Space Grotesk Bold,
with the text converted to outlines so the SVG needs no fonts.

The layout copies the design artboard, measured in pixels there and scaled
so the icon's 200-unit viewBox matches its 240 px size.

    python3 wordmark.py ICON_SVG FONT OUTPUT_SVG
"""

import sys
import xml.etree.ElementTree as ET

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

TEXT = "forkit"
COLOR = "#c0caf5"
ICON_PX, GAP_PX, FONT_PX, TRACKING_EM = 240, 28, 44, -0.03
ICON_UNITS = 200

SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)


def main(icon_path: str, font_path: str, output_path: str) -> None:
    scale = ICON_UNITS / ICON_PX
    font_size, gap = FONT_PX * scale, GAP_PX * scale

    font = TTFont(font_path)
    units_per_em = font["head"].unitsPerEm
    glyph_set = font.getGlyphSet()
    glyph_scale = font_size / units_per_em
    tracking = TRACKING_EM * units_per_em

    # Shape with HarfBuzz so kerning matches what a browser draws.
    blob = hb.Blob.from_file_path(font_path)
    hb_font = hb.Font(hb.Face(blob))
    buffer = hb.Buffer()
    buffer.add_str(TEXT)
    buffer.guess_segment_properties()
    hb.shape(hb_font, buffer)
    glyph_order = font.getGlyphOrder()

    # CSS line-height "normal" puts the baseline one ascender, plus half the
    # line gap, below the top of the line box.
    hhea = font["hhea"]
    baseline = ICON_UNITS + gap + (hhea.lineGap / 2 + hhea.ascent) * glyph_scale

    # CSS letter-spacing follows every letter, including the last.
    advances = [pos.x_advance + tracking for pos in buffer.glyph_positions]
    text_width = sum(advances) * glyph_scale
    x = (ICON_UNITS - text_width) / 2

    path_pen = SVGPathPen(glyph_set)
    bounds_pen = BoundsPen(glyph_set)
    for info, pos, advance in zip(buffer.glyph_infos, buffer.glyph_positions, advances):
        name = glyph_order[info.codepoint]
        to_page = (glyph_scale, 0, 0, -glyph_scale, x + pos.x_offset * glyph_scale, baseline - pos.y_offset * glyph_scale)
        glyph_set[name].draw(TransformPen(path_pen, to_page))
        glyph_set[name].draw(TransformPen(bounds_pen, to_page))
        x += advance * glyph_scale

    left, _, right, bottom = bounds_pen.bounds
    view_left = min(0, left)
    view_width = max(ICON_UNITS, right) - view_left
    view_height = bottom

    icon = ET.parse(icon_path).getroot()
    svg = ET.Element(f"{{{SVG_NS}}}svg", {
        "width": f"{view_width:.2f}",
        "height": f"{view_height:.2f}",
        "viewBox": f"{view_left:.2f} 0 {view_width:.2f} {view_height:.2f}",
    })
    title = ET.SubElement(svg, f"{{{SVG_NS}}}title")
    title.text = "Forkit"
    mark = ET.SubElement(svg, f"{{{SVG_NS}}}g")
    for child in icon:
        if child.tag != f"{{{SVG_NS}}}title":
            mark.append(child)
    ET.SubElement(svg, f"{{{SVG_NS}}}path", {"fill": COLOR, "d": path_pen.getCommands()})
    ET.indent(svg)
    ET.ElementTree(svg).write(output_path, encoding="unicode")


if __name__ == "__main__":
    main(*sys.argv[1:])
