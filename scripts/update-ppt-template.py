#!/usr/bin/env python3
"""Add the extended canonical layouts to a WAC .pptx template.

One-off OOXML surgery used to bring WAC-Group-PPT-Template.pptx up to the full
deck-builder vocabulary (packages/shared/src/ppt.ts): clones the template's own
"Title and Content" / "Two Content" layouts into Agenda, Quote, Chart, Diagram,
Process, Video and "Title, Content and Image", and adds a subtitle placeholder
to Section Header. Cloning existing layouts (rather than authoring from
scratch) keeps every new layout on the template's master/theme so fonts and
colors stay on-brand.

Usage: python3 scripts/update-ppt-template.py <template.pptx>
Rewrites the file in place; verify with apps/generator/python/introspect.py.
"""

import copy
import re
import shutil
import sys
import zipfile

from lxml import etree

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
LAYOUT_CT = (
    "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"
)
LAYOUT_REL_TYPE = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
)
MASTER_RELS_XML = (
    "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" '
    'Target="../slideMasters/slideMaster1.xml"/></Relationships>'
)


def q(tag: str) -> str:
    pfx, local = tag.split(":")
    return f"{{{NS[pfx]}}}{local}"


def parse(data: bytes) -> etree._Element:
    return etree.fromstring(data)


def serialize(root: etree._Element) -> bytes:
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def layout_name(root: etree._Element) -> str:
    return root.find(q("p:cSld"), NS).get("name")


def find_placeholders(root: etree._Element):
    """[(sp, ph)] for every placeholder shape in document order."""
    out = []
    for sp in root.iter(q("p:sp")):
        ph = sp.find(f"{q('p:nvSpPr')}/{q('p:nvPr')}/{q('p:ph')}")
        if ph is not None:
            out.append((sp, ph))
    return out


def set_geom(sp: etree._Element, x: int, y: int, w: int, h: int) -> None:
    xfrm = sp.find(f"{q('p:spPr')}/{q('a:xfrm')}")
    off, ext = xfrm.find(q("a:off")), xfrm.find(q("a:ext"))
    off.set("x", str(x))
    off.set("y", str(y))
    ext.set("cx", str(w))
    ext.set("cy", str(h))


def set_prompt_text(sp: etree._Element, text: str) -> None:
    for t in sp.iter(q("a:t")):
        t.text = text


def rename(root: etree._Element, name: str) -> etree._Element:
    root.find(q("p:cSld"), NS).set("name", name)
    return root


def to_picture(sp: etree._Element, ph: etree._Element, name: str) -> None:
    ph.set("type", "pic")
    sp.find(f"{q('p:nvSpPr')}/{q('p:cNvPr')}").set("name", name)
    set_prompt_text(sp, "Click to add image")


def make_quote(root: etree._Element) -> etree._Element:
    """Two Content -> Quote: drop the title; big centered quote + attribution."""
    rename(root, "Quote")
    sp_tree = root.find(f"{q('p:cSld')}/{q('p:spTree')}")
    phs = find_placeholders(root)
    for sp, ph in phs:
        if ph.get("type") == "title":
            sp_tree.remove(sp)
    bodies = [(sp, ph) for sp, ph in find_placeholders(root) if ph.get("type") != "title"]
    quote_sp, _ = bodies[0]
    attr_sp, _ = bodies[1]

    set_geom(quote_sp, 1219200, 2114550, 9753600, 2286000)
    quote_sp.find(f"{q('p:nvSpPr')}/{q('p:cNvPr')}").set("name", "Quote 1")
    set_prompt_text(quote_sp, "Click to edit quote")
    style_body(quote_sp, anchor="ctr", algn="ctr", sz="3200", italic=True)

    set_geom(attr_sp, 6705600, 4629150, 4267200, 571500)
    attr_sp.find(f"{q('p:nvSpPr')}/{q('p:cNvPr')}").set("name", "Attribution 2")
    set_prompt_text(attr_sp, "Click to edit attribution")
    style_body(attr_sp, algn="r", sz="1600")
    return root


def style_body(sp, anchor=None, algn=None, sz=None, italic=False, fill=None):
    """Layout-level list styling (buNone + size/alignment). This is template
    authoring — the build engine itself never sets fonts."""
    tx = sp.find(q("p:txBody"))
    if anchor is not None:
        tx.find(q("a:bodyPr")).set("anchor", anchor)
    lst = tx.find(q("a:lstStyle"))
    for child in list(lst):
        lst.remove(child)
    lvl = etree.SubElement(lst, q("a:lvl1pPr"))
    if algn is not None:
        lvl.set("algn", algn)
    lvl.set("marL", "0")
    lvl.set("indent", "0")
    etree.SubElement(lvl, q("a:buNone"))
    rpr = etree.SubElement(lvl, q("a:defRPr"))
    if sz is not None:
        rpr.set("sz", sz)
    if italic:
        rpr.set("i", "1")
    if fill is not None:
        solid = etree.SubElement(rpr, q("a:solidFill"))
        etree.SubElement(solid, q("a:srgbClr")).set("val", fill)


def make_video(root: etree._Element) -> etree._Element:
    """Title and Content -> Video: the content area becomes a 16:9 picture
    placeholder the builder drops the movie frame onto."""
    rename(root, "Video")
    for sp, ph in find_placeholders(root):
        if ph.get("type") == "body":
            to_picture(sp, ph, "Media Placeholder 2")
            set_prompt_text(sp, "Click to add media")
            set_geom(sp, 1828800, 1600200, 8534400, 4800600)
    return root


def make_title_content_image(root: etree._Element) -> etree._Element:
    """Two Content -> Title, Content and Image: right column becomes a picture."""
    rename(root, "Title, Content and Image")
    bodies = [(sp, ph) for sp, ph in find_placeholders(root) if ph.get("type") == "body"]
    sp, ph = bodies[-1]
    to_picture(sp, ph, "Picture Placeholder 3")
    return root


def fix_section_header(root: etree._Element) -> etree._Element:
    """Give Section Header a subtitle body placeholder below its title (white
    text — the layout is dark)."""
    if any(ph.get("type") == "body" for _, ph in find_placeholders(root)):
        return root  # already fixed
    sp_tree = root.find(f"{q('p:cSld')}/{q('p:spTree')}")
    title_sp = next(sp for sp, ph in find_placeholders(root) if ph.get("type") == "title")
    sub = copy.deepcopy(title_sp)
    sub.find(f"{q('p:nvSpPr')}/{q('p:cNvPr')}").set("id", "9")
    sub.find(f"{q('p:nvSpPr')}/{q('p:cNvPr')}").set("name", "Subtitle 2")
    ph = sub.find(f"{q('p:nvSpPr')}/{q('p:nvPr')}/{q('p:ph')}")
    ph.set("type", "body")
    ph.set("idx", "1")
    set_geom(sub, 548640, 5715000, 11094720, 571500)
    sub.find(f"{q('p:txBody')}/{q('a:bodyPr')}").set("anchor", "t")
    set_prompt_text(sub, "Click to edit subtitle")
    style_body(sub, sz="1600", fill="FFFFFF")
    sp_tree.append(sub)
    return root


def main(path: str) -> None:
    zin = zipfile.ZipFile(path)
    entries = {i.filename: zin.read(i.filename) for i in zin.infolist()}
    zin.close()

    layouts = {}
    for fn, data in entries.items():
        if re.fullmatch(r"ppt/slideLayouts/slideLayout\d+\.xml", fn):
            layouts[layout_name(parse(data))] = fn

    existing = set(layouts)
    base_tc = entries[layouts["Title and Content"]]
    base_two = entries[layouts["Two Content"]]

    new_layouts = [
        ("Agenda", rename(parse(base_tc), "Agenda")),
        ("Quote", make_quote(parse(base_two))),
        ("Chart", rename(parse(base_tc), "Chart")),
        ("Diagram", rename(parse(base_tc), "Diagram")),
        ("Process", rename(parse(base_tc), "Process")),
        ("Video", make_video(parse(base_tc))),
        ("Title, Content and Image", make_title_content_image(parse(base_two))),
    ]
    new_layouts = [(n, r) for n, r in new_layouts if n not in existing]

    # Fix Section Header in place.
    sh_fn = layouts["Section Header"]
    entries[sh_fn] = serialize(fix_section_header(parse(entries[sh_fn])))

    # Wire each new layout into the package: part + rels + content-type +
    # master relationship + sldLayoutIdLst entry.
    ct = parse(entries["[Content_Types].xml"])
    master = parse(entries["ppt/slideMasters/slideMaster1.xml"])
    master_rels = parse(entries["ppt/slideMasters/_rels/slideMaster1.xml.rels"])

    next_n = max(
        int(re.search(r"slideLayout(\d+)\.xml", fn).group(1)) for fn in layouts.values()
    )
    id_lst = master.find(q("p:sldLayoutIdLst"))
    next_layout_id = max(int(e.get("id")) for e in id_lst) + 1
    next_rid = (
        max(int(rel.get("Id")[3:]) for rel in master_rels.iter(q("rel:Relationship"))) + 1
    )

    for name, root in new_layouts:
        next_n += 1
        fn = f"ppt/slideLayouts/slideLayout{next_n}.xml"
        entries[fn] = serialize(root)
        entries[f"ppt/slideLayouts/_rels/slideLayout{next_n}.xml.rels"] = (
            MASTER_RELS_XML.encode()
        )
        ov = etree.SubElement(ct, q("ct:Override"))
        ov.set("PartName", f"/{fn}")
        ov.set("ContentType", LAYOUT_CT)
        rel = etree.SubElement(master_rels, q("rel:Relationship"))
        rel.set("Id", f"rId{next_rid}")
        rel.set("Type", LAYOUT_REL_TYPE)
        rel.set("Target", f"../slideLayouts/slideLayout{next_n}.xml")
        sld = etree.SubElement(id_lst, q("p:sldLayoutId"))
        sld.set("id", str(next_layout_id))
        sld.set(q("r:id"), f"rId{next_rid}")
        next_layout_id += 1
        next_rid += 1
        print(f"added layout: {name} -> {fn}")

    entries["[Content_Types].xml"] = serialize(ct)
    entries["ppt/slideMasters/slideMaster1.xml"] = serialize(master)
    entries["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = serialize(master_rels)

    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for fn, data in entries.items():
            zout.writestr(fn, data)
    shutil.move(tmp, path)
    print(f"updated {path}: +{len(new_layouts)} layouts, Section Header subtitle fixed")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: update-ppt-template.py <template.pptx>")
    main(sys.argv[1])
