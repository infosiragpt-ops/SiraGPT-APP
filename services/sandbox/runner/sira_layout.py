"""Measured layout helpers for the offline document sandbox.

These are measurements, not a substitute for rendering the final Office file.
Fonts are supplied explicitly; text is never silently truncated or substituted.
All third-party imports are lazy so capability discovery needs only Python.
"""
from __future__ import annotations

import math
import threading
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

_PDF_LOCK = threading.Lock()
_PT_TO_MM = 25.4 / 72


def _positive(value, name, maximum=100000):
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite positive number")
    result = float(value)
    if not math.isfinite(result) or not 0 < result <= maximum:
        raise ValueError(f"{name} must be positive and <= {maximum}")
    return result


def mm_to_emu(value):
    """Round a millimetre coordinate to the nearest integer Office EMU."""
    if isinstance(value, bool):
        raise ValueError("invalid millimetre coordinate")
    number = Decimal(str(value))
    if not number.is_finite() or abs(number) > 100000:
        raise ValueError("invalid millimetre coordinate")
    return int((number * 36000).to_integral_value(rounding=ROUND_HALF_UP))


def emu_to_mm(value):
    if isinstance(value, bool) or not isinstance(value, int) or abs(value) > 3600000000:
        raise ValueError("EMU coordinate must be a bounded integer")
    return float(Decimal(value) / 36000)


def _font_bytes(font_path):
    path = Path(font_path)
    if not path.is_file() or not 0 < path.stat().st_size <= 32 * 1024 * 1024:
        raise ValueError("font must be a regular file of at most 32 MiB")
    return path.read_bytes()


def _text(value):
    if not isinstance(value, str) or len(value) > 10000:
        raise ValueError("text must be a string of at most 10000 characters")
    if any(ord(ch) < 32 and ch != '\n' for ch in value):
        raise ValueError("only explicit newlines are supported; expand tabs first")
    return value


def font_coverage(font_path, text):
    """List missing Unicode characters without choosing a replacement font."""
    from fontTools.ttLib import TTFont
    import io
    text = _text(text)
    with TTFont(io.BytesIO(_font_bytes(font_path)), lazy=False) as font:
        cmap = font.getBestCmap() or {}
        # Newlines are layout, not glyphs. Other characters remain explicit:
        # even variation selectors must be reviewed instead of silently hidden.
        missing = sorted({ch for ch in text if ch != '\n' and ord(ch) not in cmap})
        return {"complete": not missing, "missing": missing,
                "glyph_count": len(font.getGlyphOrder()), "units_per_em": font['head'].unitsPerEm}


def measure_text(font_path, text, size_pt=12, *, direction=None, language=None, line_spacing=1.2):
    """Shape explicit lines; return advances and ink bounds in pt and mm.

    No automatic wrapping, fallback font or full paragraph bidi algorithm is
    applied. Split mixed-direction paragraphs into runs before calling this.
    Empty lines reserve one line of font height and have zero horizontal advance.
    """
    import uharfbuzz as hb
    text = _text(text)
    size = _positive(size_pt, 'size_pt', 1000)
    spacing = _positive(line_spacing, 'line_spacing', 10)
    if direction not in (None, 'ltr', 'rtl'):
        raise ValueError("direction must be ltr or rtl")
    if language is not None and (not isinstance(language, str) or len(language) > 64):
        raise ValueError("invalid language")
    coverage = font_coverage(font_path, text)
    face = hb.Face(_font_bytes(font_path))
    font = hb.Font(face)
    font.scale = (face.upem, face.upem)
    hb.ot_font_set_funcs(font)
    factor = size / face.upem
    extents = font.get_font_extents('ltr')
    if extents is None:
        raise ValueError("font does not provide horizontal metrics")
    metric_height = (extents.ascender - extents.descender) * factor
    line_height = max(size * spacing, metric_height)
    lines = []
    missing_glyphs = 0
    top, bottom = 0.0, 0.0
    for line_index, line in enumerate(text.split('\n')):
        buf = hb.Buffer()
        buf.add_str(line)
        buf.guess_segment_properties()
        if direction:
            buf.direction = direction
        if language:
            buf.language = language
        hb.shape(font, buf)
        pen = left = right = 0.0
        baseline = -line_index * line_height
        top = max(top, baseline + extents.ascender * factor)
        bottom = min(bottom, baseline + extents.descender * factor)
        # HarfBuzz represents an empty buffer with None, not empty arrays.
        infos = buf.glyph_infos or []
        positions = buf.glyph_positions or []
        for info, position in zip(infos, positions):
            missing_glyphs += int(info.codepoint == 0)
            ink = font.get_glyph_extents(info.codepoint)
            if ink is not None:
                x = pen + (position.x_offset + ink.x_bearing) * factor
                left = min(left, x, x + ink.width * factor)
                right = max(right, x, x + ink.width * factor)
                y = baseline + (position.y_offset + ink.y_bearing) * factor
                top = max(top, y, y + ink.height * factor)
                bottom = min(bottom, y, y + ink.height * factor)
            pen += position.x_advance * factor
        left, right = min(left, pen), max(right, pen)
        lines.append({"advance_pt": abs(pen), "width_pt": right - left,
                      "left_pt": left, "right_pt": right, "glyphs": len(infos)})
    width = max(line['width_pt'] for line in lines)
    height = top - bottom
    return {"width_pt": width, "height_pt": height,
            "width_mm": width * _PT_TO_MM, "height_mm": height * _PT_TO_MM,
            "size_pt": size, "lines": lines, "missing": coverage['missing'],
            "missing_glyphs": missing_glyphs, "complete": coverage['complete'] and missing_glyphs == 0,
            "requires_final_render": True}


def fit_text(font_path, text, width_mm, height_mm, *, min_pt=8, max_pt=32, **options):
    """Fit supplied explicit lines into a box without dropping text.

    Selects 0.01 pt steps; returns fits=False if the minimum size or font
    coverage is insufficient. The caller decides whether to reflow the text.
    """
    width = _positive(width_mm, 'width_mm')
    height = _positive(height_mm, 'height_mm')
    minimum = _positive(min_pt, 'min_pt', 1000)
    maximum = _positive(max_pt, 'max_pt', 1000)
    if minimum > maximum:
        raise ValueError("min_pt must be <= max_pt")
    metrics = measure_text(font_path, text, 1, **options)
    if not metrics['complete']:
        return {"fits": False, "reason": "missing_glyphs", "size_pt": None, "metrics": metrics}
    best = min(maximum, width / metrics['width_mm'] if metrics['width_mm'] else maximum,
               height / metrics['height_mm'])
    best = math.floor(best * 100) / 100
    if best < minimum:
        return {"fits": False, "reason": "minimum_size_exceeds_box", "size_pt": None,
                "metrics": measure_text(font_path, text, minimum, **options)}
    result = measure_text(font_path, text, best, **options)
    fits = result['width_mm'] <= width + 1e-7 and result['height_mm'] <= height + 1e-7
    return {"fits": fits, "reason": None if fits else "measurement_exceeds_box",
            "size_pt": best if fits else None, "metrics": result}


def color_contrast(foreground, background):
    """WCAG 2.1 luminance contrast for opaque, in-gamut sRGB colours."""
    from coloraide import Color
    colors = [Color(value).convert('srgb') for value in (foreground, background)]
    for color in colors:
        if color.alpha() != 1 or not color.in_gamut('srgb') or any(not math.isfinite(x) for x in color.coords()):
            raise ValueError("provide opaque sRGB colours; composite transparency explicitly")
    ratio = colors[0].contrast(colors[1], method='wcag21')
    return {"ratio": ratio, "normal_text_aa": ratio >= 4.5, "large_text_aa": ratio >= 3,
            "normal_text_aaa": ratio >= 7, "method": "wcag21"}


def pdf_text_geometry(path, page_index=0, *, max_chars=20000):
    """Read character boxes with a renderer independent of Office writers.

    Coordinates are the unrotated PDF canvas (left,bottom,right,top), not
    screenshot pixels. Rotation and the visible page box are reported. PDFs
    with non-default UserUnit are rejected instead of inventing mm positions.
    Image-only pages explicitly report text_missing and need OCR separately.
    PDFium indices may address UTF-16 code units; index_count records how many
    units form each Unicode character. Unmapped or malformed text is rejected.
    """
    from pypdf import PdfReader
    import pypdfium2 as pdfium
    if isinstance(page_index, bool) or not isinstance(page_index, int) or page_index < 0:
        raise ValueError("page_index must be a non-negative integer")
    if isinstance(max_chars, bool) or not isinstance(max_chars, int) or not 1 <= max_chars <= 100000:
        raise ValueError("max_chars must be between 1 and 100000")
    source = Path(path)
    if not source.is_file() or source.stat().st_size > 128 * 1024 * 1024:
        raise ValueError("PDF must be a regular file of at most 128 MiB")
    reader = PdfReader(source)
    if reader.is_encrypted:
        raise ValueError("decrypt a copy using the supplied password before measurement")
    if page_index >= len(reader.pages):
        raise ValueError("page_index out of range")
    if float(reader.pages[page_index].get('/UserUnit', 1)) != 1:
        raise ValueError("non-default PDF UserUnit requires explicit normalization")
    with _PDF_LOCK, pdfium.PdfDocument(source) as document:
        page = document[page_index]
        textpage = page.get_textpage()
        count = textpage.count_chars()
        if count > max_chars:
            raise ValueError("character limit exceeded; no partial verification was returned")
        characters = []
        index = 0
        while index < count:
            codepoint = pdfium.raw.FPDFText_GetUnicode(textpage, index)
            index_count = 1
            box = list(textpage.get_charbox(index))
            if 0xD800 <= codepoint <= 0xDBFF:
                if index + 1 >= count:
                    raise ValueError("PDF text contains an unpaired UTF-16 surrogate")
                low = pdfium.raw.FPDFText_GetUnicode(textpage, index + 1)
                if not 0xDC00 <= low <= 0xDFFF:
                    raise ValueError("PDF text contains an unpaired UTF-16 surrogate")
                codepoint = 0x10000 + ((codepoint - 0xD800) << 10) + low - 0xDC00
                following = list(textpage.get_charbox(index + 1))
                box = [min(box[0], following[0]), min(box[1], following[1]),
                       max(box[2], following[2]), max(box[3], following[3])]
                index_count = 2
            elif 0xDC00 <= codepoint <= 0xDFFF:
                raise ValueError("PDF text contains an unpaired UTF-16 surrogate")
            elif not 0 < codepoint <= 0x10FFFF:
                raise ValueError("PDF text contains an unmapped or invalid Unicode character")
            characters.append({"index": index, "index_count": index_count, "text": chr(codepoint),
                               "box_pt": box, "box_mm": [value * _PT_TO_MM for value in box]})
            index += index_count
        return {"page_index": page_index, "rotation": page.get_rotation(),
                "coordinate_system": "unrotated_pdf_canvas_left_bottom_right_top",
                "visible_box_pt": list(page.get_bbox()), "characters": characters,
                "text_missing": count == 0, "complete": True}
