"""Non-destructive PDF layout overlays, using visible-page model coordinates.

Copied from oxr-pdf-to-markdown/layout_pdf.py (local reference supplied by the
project owner). The worker supplies validated, bounded layout data
and an owned staging destination; no network access is performed here.

Only PyMuPDF and the standard library are required. All marks belong to one
optional-content group ("OXR Layout"); original page streams remain untouched.
"""
from __future__ import annotations

import math
import os
import re
import tempfile
import unicodedata
from numbers import Real
from pathlib import Path

import pymupdf


# Short, readable labels and consistent RGB colors, in legend order.
_STYLES = {
    "text": ("Text", (0.08, 0.32, 0.90)),
    "title": ("Title", (0.52, 0.18, 0.78)),
    "picture": ("Picture", (0.90, 0.12, 0.14)),
    "caption": ("Caption", (0.88, 0.28, 0.59)),
    "table": ("Table", (0.00, 0.58, 0.65)),
    "formula": ("Formula", (0.95, 0.43, 0.04)),
    "header": ("Header", (0.43, 0.43, 0.43)),
    "footer": ("Footer", (0.43, 0.43, 0.43)),
}
_ALIASES = {
    "figure": "picture", "image": "picture", "equation": "formula",
    "pageheader": "header", "pagefooter": "footer",
    "sectionheader": "title", "heading": "title", "paragraph": "text",
    "figurecaption": "caption", "tablecaption": "caption",
}
_GRAY = (0.43, 0.43, 0.43)
_EXTRA_LABELS = {
    "footnote": "Footnote", "stamp": "Stamp", "chemicalstructure": "Chem. Struct.",
    "codeblock": "Code Block", "chemicalequation": "Chem. Equation",
}
_INK = (0.12, 0.12, 0.12)


def _style(value):
    raw = value if isinstance(value, str) else "Unknown"
    key = re.sub(r"[\s_-]+", "", raw.casefold())
    key = _ALIASES.get(key, key)
    if key in _STYLES:
        label, color = _STYLES[key]
    elif key in _EXTRA_LABELS:
        label, color = _EXTRA_LABELS[key], _GRAY
    else:
        # Helvetica is deliberately used to avoid embedding a new font. Never
        # pass control characters, multiline labels or arbitrary Unicode to it.
        ascii_name = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode()
        ascii_name = re.sub(r"[^A-Za-z0-9 ._/-]", " ", ascii_name)
        ascii_name = " ".join(ascii_name.split())[:20]
        label, color = ("Unknown: " + ascii_name if ascii_name else "Unknown"), _GRAY
    return key, label, color


def _number(value, context):
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(f"{context}: expected a finite number")
    try:
        result = float(value)
    except (ValueError, OverflowError):
        raise ValueError(f"{context}: expected a finite number") from None
    if not math.isfinite(result):
        raise ValueError(f"{context}: expected a finite number")
    return result


def _validate(doc, pages):
    if not isinstance(pages, list):
        raise ValueError("pages must be a list covering every source page")
    by_number = {}
    for item in pages:
        if not isinstance(item, dict):
            raise ValueError("each page must be a dictionary")
        number = item.get("page_num")
        if isinstance(number, bool) or not isinstance(number, int):
            raise ValueError("page_num must be a global 0-based integer")
        if number < 0 or number >= len(doc):
            raise ValueError(f"page_num {number}: outside source page range")
        if number in by_number:
            raise ValueError(f"duplicate page_num {number}")
        by_number[number] = item
    missing = sorted(set(range(len(doc))) - by_number.keys())
    if missing:
        raise ValueError(f"missing page_num: {missing}; use blocks=[] for blank pages")

    validated = []
    for number in range(len(doc)):
        item = by_number[number]
        size = item.get("page_size")
        if not isinstance(size, dict):
            raise ValueError(f"page {number}: page_size must contain w and h")
        w = _number(size.get("w"), f"page {number} page_size.w")
        h = _number(size.get("h"), f"page {number} page_size.h")
        if w <= 0 or h <= 0:
            raise ValueError(f"page {number}: page_size must be positive")
        blocks = item.get("blocks")
        if not isinstance(blocks, list):
            raise ValueError(f"page {number}: blocks must be a list (possibly empty)")
        visible = doc[number].rect
        prepared = []
        for index, block in enumerate(blocks, 1):
            context = f"page {number} block {index} bbox"
            if not isinstance(block, dict):
                raise ValueError(f"{context}: block must be a dictionary")
            bbox = block.get("bbox")
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                raise ValueError(f"{context}: expected four finite numbers")
            x1, y1, x2, y2 = [_number(v, context) for v in bbox]
            if x1 >= x2 or y1 >= y2:
                raise ValueError(f"{context}: reversed or zero-size coordinates")
            x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
            if x1 >= x2 or y1 >= y2:
                raise ValueError(f"{context}: completely outside page_size")
            # Clip before scaling: even extreme but finite input cannot overflow.
            rect = pymupdf.Rect(x1 / w * visible.width, y1 / h * visible.height,
                                x2 / w * visible.width, y2 / h * visible.height)
            if rect.is_empty or rect.is_infinite:
                raise ValueError(f"{context}: degenerate rectangle after scaling")
            key, label, color = _style(block.get("type"))
            prepared.append((rect, key, f"[{index}] {label}", color))
        validated.append(prepared)
    return validated


def _boundary(rect, toward):
    center = (rect.tl + rect.br) / 2
    dx, dy = toward.x - center.x, toward.y - center.y
    tx = rect.width / (2 * abs(dx)) if dx else math.inf
    ty = rect.height / (2 * abs(dy)) if dy else math.inf
    scale = min(tx, ty)
    return center + pymupdf.Point(dx * scale, dy * scale)


def _arrow_points(first, second, visible):
    """Use perimeter intersections, never a center-to-center stroke.

    Intersecting / nested rectangles have no gap on the center ray. Route those
    around their common exterior, rather than drawing through their interiors.
    """
    if not first.intersects(second):
        a = _boundary(first, (second.tl + second.br) / 2)
        b = _boundary(second, (first.tl + first.br) / 2)
        return [a, b]
    union = first | second
    gaps = [visible.x1 - union.x1, union.x0, visible.y1 - union.y1, union.y0]
    side = max(range(4), key=gaps.__getitem__)
    gap = max(0, min(8, gaps[side] / 2))
    if side < 2:
        x = union.x1 + gap if side == 0 else union.x0 - gap
        a = pymupdf.Point(first.x1 if side == 0 else first.x0, first.y0 + first.height * .35)
        b = pymupdf.Point(second.x1 if side == 0 else second.x0, second.y0 + second.height * .65)
        return [a, pymupdf.Point(x, a.y), pymupdf.Point(x, b.y), b]
    y = union.y1 + gap if side == 2 else union.y0 - gap
    a = pymupdf.Point(first.x0 + first.width * .35, first.y1 if side == 2 else first.y0)
    b = pymupdf.Point(second.x0 + second.width * .65, second.y1 if side == 2 else second.y0)
    return [a, pymupdf.Point(a.x, y), pymupdf.Point(b.x, y), b]


def _draw_arrow(shape, points, matrix, oc, visible):
    points = [p for i, p in enumerate(points) if i == 0 or abs(p - points[i - 1]) > .01]
    if len(points) < 2:
        return
    for a, b in zip(points, points[1:]):
        shape.draw_line(a * matrix, b * matrix)
    end, previous = points[-1], points[-2]
    distance = abs(end - previous)
    direction = (end - previous) / distance
    length = min(4, distance * .45)
    normal = pymupdf.Point(-direction.y, direction.x)
    for sign in (-1, 1):
        wing = end - direction * length + normal * (sign * length * .5)
        wing = pymupdf.Point(min(visible.x1, max(0, wing.x)), min(visible.y1, max(0, wing.y)))
        shape.draw_line(wing * matrix, end * matrix)
    shape.finish(color=_INK, width=.7, stroke_opacity=.68, closePath=False, oc=oc)


def _label(shape, rect, text, color, visible, matrix, rotation, oc):
    size = min(6.5, visible.height / 8)
    width = pymupdf.get_text_length(text, fontsize=size) + 3
    if width > visible.width:
        size *= visible.width / width
        width = visible.width
    height = size * 1.4
    x = min(rect.x0, max(0, visible.width - width))
    # Prefer the narrow strip above the region, otherwise its upper edge.
    y = rect.y0 - height if rect.y0 >= height else rect.y0
    y = min(y, max(0, visible.height - height))
    background = pymupdf.Rect(x, y, x + width, y + height)
    shape.draw_rect(background * matrix)
    shape.finish(color=None, fill=(1, 1, 1), fill_opacity=.80, width=0, oc=oc)
    shape.insert_text(pymupdf.Point(x + 1, y + size * 1.08) * matrix,
                      text, fontsize=size, color=color, rotate=rotation, oc=oc)


def _legend(shape, visible, blocks, matrix, rotation, oc):
    # Fit even unusually small pages, and choose the least occupied corner.
    scale = min(1, visible.width / 150, visible.height / 40)
    width, height, margin = 144 * scale, 34 * scale, 3 * scale
    candidates = [pymupdf.Rect(x, y, x + width, y + height)
                  for x in (margin, visible.width - width - margin)
                  for y in (margin, visible.height - height - margin)]
    area = lambda r: sum((r & block[0]).get_area() for block in blocks)
    rect = min(candidates, key=area)
    shape.draw_rect(rect * matrix)
    shape.finish(color=_GRAY, fill=(1, 1, 1), width=.3,
                 fill_opacity=.86, stroke_opacity=.6, oc=oc)
    for i, (label, color) in enumerate(_STYLES.values()):
        x = rect.x0 + (3 + (i % 2) * 72) * scale
        y = rect.y0 + (6 + (i // 2) * 8) * scale
        shape.draw_line(pymupdf.Point(x, y - 1.5 * scale) * matrix,
                        pymupdf.Point(x + 7 * scale, y - 1.5 * scale) * matrix)
        shape.finish(color=color, width=.8, oc=oc, closePath=False)
        shape.insert_text(pymupdf.Point(x + 10 * scale, y) * matrix,
                          label, fontsize=5.5 * scale, color=color, rotate=rotation, oc=oc)


def _annotate(page, blocks, oc, arrows):
    visible = page.rect
    matrix = page.derotation_matrix
    rotation = page.rotation
    # PyMuPDF 1.28.2 uses an incorrect drawing transformation for paths on
    # rotated, offset CropBoxes (text behaves differently). Draw with /Rotate=0
    # temporarily, applying the saved derotation matrix explicitly to ALL marks.
    # Restore /Rotate before saving; text's rotate parameter keeps labels upright.
    page.set_rotation(0)
    try:
        shape = page.new_shape()
        if arrows:
            body = [r for r, key, _, _ in blocks if key not in ("header", "footer")]
            for first, second in zip(body, body[1:]):
                _draw_arrow(shape, _arrow_points(first, second, visible), matrix, oc, visible)
        for rect, _, label, color in blocks:
            shape.draw_rect(rect * matrix)
            shape.finish(color=color, width=.65, stroke_opacity=.85, closePath=False, oc=oc)
            _label(shape, rect, label, color, visible, matrix, rotation, oc)
        _legend(shape, visible, blocks, matrix, rotation, oc)
        shape.commit(overlay=True)
    finally:
        page.set_rotation(rotation)


def write_layout_pdf(source_path, output_path, pages, password=None, arrows=True):
    """Write an annotated copy; return its absolute :class:`pathlib.Path`.

    ``pages`` must cover every global 0-based source page exactly once (the list
    itself may be unordered). Each page has ``page_size={w,h}`` and ``blocks``;
    block ``bbox=[x1,y1,x2,y2]`` uses the visible, rotated page's model-pixel
    coordinates. Block array order, NOT ``idx`` or position, determines labels
    and arrows. Empty block arrays are valid. Partial out-of-bounds boxes are
    clipped; nonfinite, reversed, empty and wholly outside boxes raise ValueError.

    Preserves original pages, selectable text, images, rotation, CropBox and PDF
    encryption. The password is used only to authenticate encrypted input. Saves
    to a same-directory temporary PDF and atomically replaces output after save
    and fsync succeed. Input aliases (including hardlinks/symlinks) are rejected.
    The input is never saved or modified. All validation precedes output creation.
    """
    source = Path(source_path).expanduser().resolve()
    output = Path(output_path).expanduser().absolute()
    if (source == output.resolve() or
            (output.exists() and os.path.samefile(source, output))):
        raise ValueError("output_path must not overwrite the source PDF")
    temporary = None
    with pymupdf.open(source) as doc:
        if not doc.is_pdf:
            raise ValueError("source_path must be a PDF")
        if doc.needs_pass and not doc.authenticate(password or ""):
            raise ValueError("PDF password missing or incorrect")
        prepared = _validate(doc, pages)
        oc = doc.add_ocg("OXR Layout", on=True)
        for number, blocks in enumerate(prepared):
            _annotate(doc[number], blocks, oc, arrows)
        output.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd, temporary = tempfile.mkstemp(prefix=".oxr-layout-", suffix=".pdf", dir=output.parent)
            os.close(fd)
            doc.save(temporary, deflate=True, encryption=pymupdf.PDF_ENCRYPT_KEEP)
            with open(temporary, "rb") as handle:
                os.fsync(handle.fileno())
            os.replace(temporary, output)
            temporary = None
        finally:
            if temporary is not None:
                os.unlink(temporary)
    return output
