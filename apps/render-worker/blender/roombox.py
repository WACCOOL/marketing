# Room-box surface math — Python port of packages/shared/src/roombox.ts
# (surfaceToWorld / pixel rays / surface raycast). The TS file is the source of
# truth; both implementations are pinned to the same numeric fixtures in
# packages/shared/src/roombox.fixtures.json (TS: roombox.test.ts, Python:
# apps/render-worker/scripts/test_roombox_parity.py). Pure math, no bpy — it
# must import outside Blender for the parity check.
#
# Conventions (mirroring the TS): Z-up world, floor z=0, ceiling z=height,
# camera at (0, 0, cameraHeightM). +X along the back wall toward screen-right,
# +Y room depth away from the camera (back wall at y=yBack>0). Image points are
# normalized 0..1 with y down; focal is in image-height-fraction units.

import math


def surface_to_world(box, kind, u, v):
    """Surface-local (u, v) in 0..1 -> (x, y, z) world meters.

    `box` is the solved extents dict: xMin, xMax, yBack, yFront, height.
    Axes per surface (must match the TS surfaceToWorld exactly):
      ceiling/floor:   u = +X (left->right), v = +Y (front->back)
      wall-back:       u = +X (left->right), v = +Z (floor->ceiling)
      wall-left/right: u = +Y (front->back), v = +Z (floor->ceiling)
    """
    x_min = float(box["xMin"])
    x_max = float(box["xMax"])
    y_back = float(box["yBack"])
    y_front = float(box["yFront"])
    h = float(box["height"])
    x = x_min + u * (x_max - x_min)
    along = u if kind in ("wall-left", "wall-right") else v
    y = y_front + along * (y_back - y_front)
    if kind == "ceiling":
        return (x, y, h)
    if kind == "floor":
        return (x, y, 0.0)
    if kind == "wall-back":
        return (x, y_back, v * h)
    if kind == "wall-left":
        return (x_min, y, v * h)
    if kind == "wall-right":
        return (x_max, y, v * h)
    raise ValueError(f"unknown surface kind: {kind}")


def focal_from_fov(fov_deg, aspect):
    """FOV along the larger image dimension -> focal in image-height units."""
    half_larger = aspect / 2.0 if aspect >= 1.0 else 0.5
    return half_larger / math.tan(math.radians(fov_deg) / 2.0)


def pixel_ray(camera_basis, focal, aspect, x, y):
    """World-space ray direction from the camera through a normalized image
    point. `camera_basis` is the solved camera dict: right/up/forward, each
    {x,y,z} in world coords. Camera frame is x-right / y-DOWN / z-forward."""
    u = (x - 0.5) * aspect
    v = y - 0.5
    r = camera_basis["right"]
    up = camera_basis["up"]
    f = camera_basis["forward"]
    return (
        r["x"] * u - up["x"] * v + f["x"] * focal,
        r["y"] * u - up["y"] * v + f["y"] * focal,
        r["z"] * u - up["z"] * v + f["z"] * focal,
    )


def raycast_surface(camera_basis, focal, aspect, camera_height, box, x, y, kind):
    """Normalized image point -> surface-local (u, v), or None when the pixel
    ray misses the surface (parallel or behind the camera). Unclamped."""
    x_min = float(box["xMin"])
    x_max = float(box["xMax"])
    y_back = float(box["yBack"])
    y_front = float(box["yFront"])
    h = float(box["height"])
    ox, oy, oz = 0.0, 0.0, float(camera_height)
    rx, ry, rz = pixel_ray(camera_basis, focal, aspect, x, y)

    if kind in ("ceiling", "floor"):
        if abs(rz) < 1e-9:
            return None
        t = ((h if kind == "ceiling" else 0.0) - oz) / rz
    elif kind == "wall-back":
        if abs(ry) < 1e-9:
            return None
        t = (y_back - oy) / ry
    elif kind in ("wall-left", "wall-right"):
        if abs(rx) < 1e-9:
            return None
        t = ((x_min if kind == "wall-left" else x_max) - ox) / rx
    else:
        raise ValueError(f"unknown surface kind: {kind}")
    if t <= 1e-6:
        return None
    px, py, pz = ox + rx * t, oy + ry * t, oz + rz * t

    w = max(x_max - x_min, 1e-6)
    d = max(y_back - y_front, 1e-6)
    if kind in ("ceiling", "floor"):
        return ((px - x_min) / w, (py - y_front) / d)
    if kind == "wall-back":
        return ((px - x_min) / w, pz / h)
    return ((py - y_front) / d, pz / h)


def surface_for_mount(mount):
    """Fixture mount kind -> default room surface (mirrors TS surfaceForMount)."""
    m = (mount or "ceiling").lower()
    if m == "wall":
        return "wall-back"
    if m == "floor":
        return "floor"
    return "ceiling"  # ceiling / recessed / flush
