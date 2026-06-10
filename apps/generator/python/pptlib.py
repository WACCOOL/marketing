"""Shared python-pptx helpers for the PPT Generator (PRD §8).

Used by introspect.py (template introspection for the admin mapping UI) and
build_deck.py (deck assembly). Stdlib + python-pptx only.
"""

from pptx.enum.shapes import PP_PLACEHOLDER


def classify_placeholder(ph_format):
    """Bucket a placeholder into the canonical types the deck engine fills.

    Returns one of: "title", "subtitle", "body", "picture", "table", "other".
    """
    t = ph_format.type
    if t in (PP_PLACEHOLDER.CENTER_TITLE, PP_PLACEHOLDER.TITLE):
        return "title"
    if t == PP_PLACEHOLDER.SUBTITLE:
        return "subtitle"
    if t in (PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT, PP_PLACEHOLDER.VERTICAL_BODY):
        return "body"
    if t == PP_PLACEHOLDER.PICTURE:
        return "picture"
    if t == PP_PLACEHOLDER.TABLE:
        return "table"
    return "other"


def build_layout_index(prs):
    """Name -> slide layout across ALL slide masters of a Presentation.

    Later masters do NOT shadow earlier names: the first layout registered
    under a name wins, so a deck always resolves to a deterministic layout.
    """
    index = {}
    for master in prs.slide_masters:
        for layout in master.slide_layouts:
            name = layout.name or ""
            if name and name not in index:
                index[name] = layout
    return index


def resolve_layout(index, name):
    """Resolve a layout by exact name, else case-insensitively. None if absent."""
    if name in index:
        return index[name]
    lowered = name.lower()
    for key, layout in index.items():
        if key.lower() == lowered:
            return layout
    return None
