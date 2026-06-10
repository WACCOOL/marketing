#!/usr/bin/env python3
"""PPT deck builder (PRD §8).

Reads a build spec as JSON on STDIN (written by apps/generator/src/ppt.ts):

  {"templatePath": str, "layoutMap": {canonical: layoutName}, "outPath": str,
   "slides": [{"id": str, "layout": canonical,
               "fields": {"title"?, "subtitle"?, "bullets"?: [str], "body"?,
                          "body2"?, "images"?: [{"path", "width", "height",
                          "caption"?}], "table"?: {"headers", "rows"}}}]}

Opens the template, drops all its existing slides (masters/layouts/theme stay —
that's what keeps exports on-brand), then adds one slide per spec entry and
fills placeholders by classified type. When a mapped layout lacks a needed
placeholder we never error: a positioned textbox/picture is added at sensible
margins and a warning is appended to warnings[].

IMPORTANT: this script NEVER sets fonts, colors, or sizes on text — everything
inherits from the template.

Output: {"ok": true, "pptxPath": outPath, "warnings": [str]}
        or {"ok": false, "error": {"code": str, "message": str}} with exit 1.
"""

import json
import sys

from pptlib import build_layout_index, classify_placeholder, resolve_layout

# Fallback geometry (fractions of the slide) used when the mapped layout lacks
# a needed placeholder. Title across the top ~10%, content stacked below.
FALLBACK = {
    "title": (0.05, 0.03, 0.90, 0.10),
    "subtitle": (0.05, 0.14, 0.90, 0.08),
    "body": (0.05, 0.25, 0.90, 0.32),
    "body_lower": (0.05, 0.58, 0.90, 0.32),
    "picture": (0.10, 0.20, 0.80, 0.62),
    "table": (0.05, 0.25, 0.90, 0.60),
    "caption": (0.05, 0.90, 0.90, 0.08),
}


def fail(code, message):
    print(json.dumps({"ok": False, "error": {"code": code, "message": message}}))
    sys.exit(1)


def remove_all_slides(prs):
    """Drop every existing slide (sldIdLst entries + their rels)."""
    from pptx.oxml.ns import qn

    sld_id_lst = prs.slides._sldIdLst  # noqa: SLF001 — no public API for this
    for sld_id in list(sld_id_lst):
        prs.part.drop_rel(sld_id.get(qn("r:id")))
        sld_id_lst.remove(sld_id)


def bucket_placeholders(slide):
    """Slide placeholders grouped by classified type, in idx order."""
    buckets = {"title": [], "subtitle": [], "body": [], "picture": [], "table": []}
    for ph in slide.placeholders:
        kind = classify_placeholder(ph.placeholder_format)
        if kind in buckets:
            buckets[kind].append(ph)
    for phs in buckets.values():
        phs.sort(key=lambda p: p.placeholder_format.idx)
    return buckets


def set_text(text_frame, text):
    """Fill a text frame, one paragraph per line. Formatting is inherited."""
    lines = str(text).split("\n")
    text_frame.text = lines[0]
    for line in lines[1:]:
        text_frame.add_paragraph().text = line


def set_bullets(text_frame, bullets):
    """One level-0 paragraph per bullet; the template styles the bullets."""
    text_frame.text = str(bullets[0])
    text_frame.paragraphs[0].level = 0
    for bullet in bullets[1:]:
        para = text_frame.add_paragraph()
        para.text = str(bullet)
        para.level = 0


def add_textbox(slide, sw, sh, box, text, bullets=None):
    """Positioned-textbox fallback for a missing placeholder."""
    from pptx.util import Emu

    x, y, w, h = box
    shape = slide.shapes.add_textbox(
        Emu(int(sw * x)), Emu(int(sh * y)), Emu(int(sw * w)), Emu(int(sh * h))
    )
    tf = shape.text_frame
    tf.word_wrap = True
    if bullets is not None:
        set_bullets(tf, bullets)
    else:
        set_text(tf, text)
    return shape


def add_picture_fit(slide, image, sw, sh, box):
    """Positioned-picture fallback: fit inside the box, centered, no crop."""
    from pptx.util import Emu

    x, y, w, h = box
    box_w, box_h = sw * w, sh * h
    ar = image["width"] / max(image["height"], 1)
    if box_w / box_h > ar:
        draw_h, draw_w = box_h, box_h * ar
    else:
        draw_w, draw_h = box_w, box_w / ar
    left = sw * x + (box_w - draw_w) / 2
    top = sh * y + (box_h - draw_h) / 2
    return slide.shapes.add_picture(
        image["path"], Emu(int(left)), Emu(int(top)), Emu(int(draw_w)), Emu(int(draw_h))
    )


def add_picture_cover(slide, image, sw, sh):
    """image_full: scale to cover the whole slide, center, crop the overflow.

    The picture is stretched to the slide frame and the source overflow is
    removed via crop fractions, so the visible region keeps the image's aspect.
    """
    from pptx.util import Emu

    pic = slide.shapes.add_picture(image["path"], 0, 0, Emu(int(sw)), Emu(int(sh)))
    ar = image["width"] / max(image["height"], 1)
    sar = sw / sh
    if ar > sar:
        crop = (1 - sar / ar) / 2  # image is wider: trim left/right
        pic.crop_left = crop
        pic.crop_right = crop
    elif ar < sar:
        crop = (1 - ar / sar) / 2  # image is taller: trim top/bottom
        pic.crop_top = crop
        pic.crop_bottom = crop
    return pic


def fill_table_cells(table, headers, rows):
    """Header row + data rows. Cell text only — styling stays the template's."""
    for c, header in enumerate(headers):
        table.cell(0, c).text = str(header)
    for r, row in enumerate(rows, start=1):
        for c in range(len(headers)):
            table.cell(r, c).text = str(row[c]) if c < len(row) else ""


def add_slide_table(slide, spec_table, buckets, sw, sh, warn):
    """Table via the table placeholder, else a body placeholder's area, else
    fallback margins (with a warning)."""
    from pptx.util import Emu

    headers = spec_table["headers"]
    rows = spec_table.get("rows", [])
    n_rows, n_cols = len(rows) + 1, len(headers)

    if buckets["table"]:
        ph = buckets["table"].pop(0)
        graphic_frame = ph.insert_table(rows=n_rows, cols=n_cols)
        fill_table_cells(graphic_frame.table, headers, rows)
        return

    geom = None
    if buckets["body"]:
        ph = buckets["body"].pop(0)
        if ph.left is not None and ph.width is not None:
            geom = (ph.left, ph.top, ph.width, ph.height)
    if geom is None:
        warn("no table/body placeholder; placed table at default margins")
        x, y, w, h = FALLBACK["table"]
        geom = (Emu(int(sw * x)), Emu(int(sh * y)), Emu(int(sw * w)), Emu(int(sh * h)))
    graphic_frame = slide.shapes.add_table(n_rows, n_cols, *geom)
    fill_table_cells(graphic_frame.table, headers, rows)


def fill_slide(slide, spec_slide, sw, sh, warn):
    canonical = spec_slide["layout"]
    fields = spec_slide.get("fields", {})
    buckets = bucket_placeholders(slide)

    # --- text ---------------------------------------------------------------
    if fields.get("title"):
        if buckets["title"]:
            set_text(buckets["title"].pop(0).text_frame, fields["title"])
        else:
            warn("layout has no title placeholder; added a positioned textbox")
            add_textbox(slide, sw, sh, FALLBACK["title"], fields["title"])

    if fields.get("subtitle"):
        if buckets["subtitle"]:
            set_text(buckets["subtitle"].pop(0).text_frame, fields["subtitle"])
        elif buckets["body"]:
            # Common in non-title layouts: the subtitle area is a body placeholder.
            set_text(buckets["body"].pop(0).text_frame, fields["subtitle"])
        else:
            warn("layout has no subtitle placeholder; added a positioned textbox")
            add_textbox(slide, sw, sh, FALLBACK["subtitle"], fields["subtitle"])

    body_fallback_used = 0

    def fill_body(text=None, bullets=None, label="body"):
        nonlocal body_fallback_used
        if buckets["body"]:
            tf = buckets["body"].pop(0).text_frame
            if bullets is not None:
                set_bullets(tf, bullets)
            else:
                set_text(tf, text)
        else:
            warn(f"layout has no free body placeholder for {label}; added a positioned textbox")
            box = FALLBACK["body_lower"] if body_fallback_used else FALLBACK["body"]
            body_fallback_used += 1
            add_textbox(slide, sw, sh, box, text, bullets=bullets)

    if fields.get("bullets"):
        fill_body(bullets=fields["bullets"], label="bullets")
    if fields.get("body"):
        fill_body(text=fields["body"], label="body")
    if fields.get("body2"):
        fill_body(text=fields["body2"], label="body2")

    # --- images ---------------------------------------------------------------
    images = list(fields.get("images") or [])
    if images and canonical == "image_full":
        # Full-bleed cover crop for the first image; extras go through the
        # generic placeholder path below.
        image = images.pop(0)
        add_picture_cover(slide, image, sw, sh)
        if image.get("caption"):
            if buckets["body"]:
                set_text(buckets["body"].pop(0).text_frame, image["caption"])
            else:
                # By design (not a fallback warning): full-bleed layouts rarely
                # carry a caption placeholder.
                add_textbox(slide, sw, sh, FALLBACK["caption"], image["caption"])

    for image in images:
        ph = buckets["picture"].pop(0) if buckets["picture"] else None
        if ph is not None and hasattr(ph, "insert_picture"):
            ph.insert_picture(image["path"])
        else:
            warn("layout has no free picture placeholder; placed image at default margins")
            add_picture_fit(slide, image, sw, sh, FALLBACK["picture"])
        if image.get("caption"):
            if buckets["body"]:
                set_text(buckets["body"].pop(0).text_frame, image["caption"])
            else:
                warn("layout has no free placeholder for the image caption; added a positioned textbox")
                add_textbox(slide, sw, sh, FALLBACK["caption"], image["caption"])

    # --- table ----------------------------------------------------------------
    if fields.get("table") and fields["table"].get("headers"):
        add_slide_table(slide, fields["table"], buckets, sw, sh, warn)


def main():
    try:
        spec = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        fail("bad_spec", f"could not parse build spec JSON: {e}")
    for key in ("templatePath", "layoutMap", "outPath", "slides"):
        if key not in spec:
            fail("bad_spec", f"build spec is missing '{key}'")

    try:
        from pptx import Presentation

        prs = Presentation(spec["templatePath"])
    except Exception as e:  # noqa: BLE001
        fail("open_failed", f"could not open template: {e}")

    layout_index = build_layout_index(prs)
    layout_map = spec["layoutMap"]
    warnings = []

    try:
        remove_all_slides(prs)
        sw, sh = int(prs.slide_width), int(prs.slide_height)

        for spec_slide in spec["slides"]:
            canonical = spec_slide["layout"]
            layout_name = layout_map.get(canonical)
            if not layout_name:
                fail("layout_unmapped", f"no template mapping for layout '{canonical}'")
            layout = resolve_layout(layout_index, layout_name)
            if layout is None:
                fail(
                    "layout_not_found",
                    f"template has no slide layout named '{layout_name}' (mapped from '{canonical}')",
                )

            slide = prs.slides.add_slide(layout)
            fill_slide(
                slide,
                spec_slide,
                sw,
                sh,
                lambda msg, sid=spec_slide["id"]: warnings.append(f"slide {sid}: {msg}"),
            )

        prs.save(spec["outPath"])
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        fail("build_failed", f"deck build failed: {e}")

    print(json.dumps({"ok": True, "pptxPath": spec["outPath"], "warnings": warnings}))


if __name__ == "__main__":
    main()
