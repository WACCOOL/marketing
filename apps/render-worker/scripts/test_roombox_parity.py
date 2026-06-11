#!/usr/bin/env python3
"""TS<->Python parity check for the room-box surface math.

Runs the Python port (apps/render-worker/blender/roombox.py) against the same
hand-authored fixture table the vitest suite asserts
(packages/shared/src/roombox.fixtures.json). Run from anywhere:

    python3 apps/render-worker/scripts/test_roombox_parity.py
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(HERE, "..", "blender"))

import roombox  # noqa: E402

FIXTURES = os.path.join(REPO, "packages", "shared", "src", "roombox.fixtures.json")


def main():
    with open(FIXTURES) as f:
        cases = json.load(f)["cases"]
    failures = 0
    for c in cases:
        got = roombox.surface_to_world(c["box"], c["surface"], c["u"], c["v"])
        want = (c["world"]["x"], c["world"]["y"], c["world"]["z"])
        ok = all(abs(g - w) < 1e-9 for g, w in zip(got, want))
        status = "ok" if ok else "FAIL"
        if not ok:
            failures += 1
        print(f"[{status}] {c['surface']} u={c['u']} v={c['v']} -> {got} (want {want})")
    if failures:
        sys.exit(f"{failures}/{len(cases)} parity cases FAILED — roombox.py drifted from roombox.ts")
    print(f"all {len(cases)} parity cases match")


if __name__ == "__main__":
    main()
