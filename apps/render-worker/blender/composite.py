# In-Blender room compositing (Phase 3).
#
# Run by the render-worker as:
#   blender -b <fixture.blend> -P composite.py -- --job <job.json> --out <out.png>
#
# WHY this exists: a WAC fixture's crystal/glass only looks right when it has a
# real environment behind it to refract + reflect (a transparent cutout goes
# flat gray). So instead of cutting the fixture out and pasting it onto a room,
# we bring the ROOM into Blender as the backdrop and render the fixture against
# it. The crystal then refracts the actual room and is lit by it, and the render
# IS the final framed image for that fixture — no compositing artifacts.
#
# Pipeline:
#   1. Isolate the fixture (reuse render.py logic), keep its internal LED lamps.
#   2. Drop the studio backdrop/softboxes (the room replaces them).
#   3. Add a camera-parented backdrop plane, emissive with the room image, sized
#      to fill the frame -> shows as the background AND lights/refracts in glass.
#   4. Frame the fixture at the requested pose + coverage, optionally offset to a
#      screen position (xPct/yPct), and render full-frame on the GPU.

import bpy
import sys
import os
import json
import math
import zipfile
import tempfile
from mathutils import Vector, Matrix

sys.path.append(os.path.dirname(__file__))
import render as R  # reuse fixture isolation + camera + gpu helpers
import roombox as RB  # room-box surface math (port of @wac/shared roombox.ts)


def parse_args():
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("composite.py: expected `-- --job <path> --out <path>`")
    extra = argv[argv.index("--") + 1 :]
    job_path = out_path = None
    i = 0
    while i < len(extra):
        if extra[i] == "--job":
            job_path = extra[i + 1]; i += 2
        elif extra[i] == "--out":
            out_path = extra[i + 1]; i += 2
        else:
            i += 1
    if not job_path or not out_path:
        raise SystemExit("composite.py: missing --job or --out")
    with open(job_path) as f:
        return json.load(f), out_path


def frustum_half(cam, distance, aspect):
    """Half-width/height of the camera frustum at `distance` (cam.angle is the FOV
    along the larger sensor dimension; derive both from the render aspect)."""
    if aspect >= 1.0:
        hw = math.tan(cam.data.angle * 0.5) * distance
        hh = hw / aspect
    else:
        hh = math.tan(cam.data.angle * 0.5) * distance
        hw = hh * aspect
    return hw, hh


def make_catcher(scene, cam, room_path, distance, aspect, emit, receive):
    """The room photo on a camera-facing plane right behind the fixture, acting as
    BOTH the photographic background AND a real surface the fixture can light.

    The image is mapped with screen-space (Window) coordinates, so the plate fills
    the frame exactly regardless of the plane's depth/size. The shader adds two
    layers:
      - Emission(photo * emit): the baseline plate look (so the frame == the room).
      - Diffuse(photo * receive): a light-receptive layer so the fixture's lamps
        spill a real glow onto the surface and it can take a contact shadow.
    Placed just behind the fixture so the glow/shadow read as on the wall, not far
    away. (For a chandelier this same plane becomes the wall/ceiling backdrop; a
    downward catcher can be added for the table/floor pool.)
    """
    img = bpy.data.images.load(room_path)
    hw, hh = frustum_half(cam, distance, aspect)
    over = 1.08  # slight oversize so the plane always covers the frame edges

    mesh = bpy.data.meshes.new("wac_catcher")
    mesh.from_pydata(
        [(-hw * over, hh * over, 0), (hw * over, hh * over, 0),
         (hw * over, -hh * over, 0), (-hw * over, -hh * over, 0)],
        [], [(0, 1, 2, 3)],
    )
    mesh.update()
    plane = bpy.data.objects.new("wac_catcher", mesh)
    scene.collection.objects.link(plane)
    plane.parent = cam
    plane.location = (0.0, 0.0, -distance)

    mat = bpy.data.materials.new("wac_catcher_mat")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    coord = nt.nodes.new("ShaderNodeTexCoord")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.extension = "EXTEND"
    nt.links.new(coord.outputs["Window"], tex.inputs["Vector"])

    emis = nt.nodes.new("ShaderNodeEmission")
    emis.inputs["Strength"].default_value = emit
    nt.links.new(tex.outputs["Color"], emis.inputs["Color"])

    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    # Scale the diffuse albedo so the receive layer reads the room colour.
    mix = nt.nodes.new("ShaderNodeMixRGB")
    mix.blend_type = "MULTIPLY"
    mix.inputs["Fac"].default_value = 1.0
    mix.inputs["Color2"].default_value = (receive, receive, receive, 1.0)
    nt.links.new(tex.outputs["Color"], mix.inputs["Color1"])
    nt.links.new(mix.outputs["Color"], diff.inputs["Color"])

    add = nt.nodes.new("ShaderNodeAddShader")
    nt.links.new(emis.outputs["Emission"], add.inputs[0])
    nt.links.new(diff.outputs["BSDF"], add.inputs[1])
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(add.outputs["Shader"], out.inputs["Surface"])
    plane.data.materials.append(mat)
    return plane, img.size[0], img.size[1]


# Studio .blend files author their bulb/diffuser emission at very high HDR levels
# (tuned for a dark studio + distant camera). Dropped straight into a normally-lit
# AI room those blow out to pure white with a halo even when scaled to a few
# percent. So we CLAMP the authored emission to a sane ceiling first, then scale
# that by the slider curve (see slider_frac).
EMIT_CAP = 8.0

# The fixture's own LIGHT lamps are authored at studio-HDR energies too (hundreds
# of watts for a dark studio). Same treatment: clamp the authored energy to a sane
# ceiling, then scale by the slider curve. Job-overridable as `lampCap`.
LAMP_CAP = 50.0

# Brightness / lightOutput slider -> intensity fraction (1.0 == authored level).
# Sliders are 0..100 with 50 as the calibrated reference look. Squared response so
# the bottom half of the range covers the dim region the team actually exports in;
# NEUTRAL_FRAC anchors slider 50 to the old slider value of 1 (the setting the
# team exported at, now that the authored-lamp blowout is capped). Both constants
# are job-overridable (`lightGamma`, `lightNeutralFrac`) for calibration sweeps
# against a live worker without redeploying the image.
SLIDER_NEUTRAL = 50.0
SLIDER_GAMMA = 2.0
SLIDER_NEUTRAL_FRAC = 0.04

# Watts the IES light emits per 1.0 of intensity fraction (the old linear scale
# was `power = lightOutput` == 25 W at its neutral, i.e. 25 W per unit frac).
IES_REF_WATTS = 25.0


def slider_frac(value, neutral_frac=SLIDER_NEUTRAL_FRAC, gamma=SLIDER_GAMMA):
    """Map a 0..100 light slider to an intensity fraction of the authored level."""
    return neutral_frac * (max(0.0, value) / SLIDER_NEUTRAL) ** gamma


WARM_TARGET = (1.0, 0.82, 0.6)  # ~3000K amber


def _luma(c):
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def warm_color(base, warm):
    """Tint `base` toward WARM_TARGET, rescaled so the result keeps the base
    color's Rec.709 luma. The naive lerp brightened any light authored dimmer
    than the target (raising warmth visibly brightened the room); pinning luma
    makes warmth shift hue ONLY. Components may exceed 1.0 — fine for Blender
    light colors (color x energy is linear)."""
    w = max(0.0, min(1.0, warm))
    base = tuple(base[:3])
    if w <= 0.0:
        return base
    c = tuple(b * (1.0 - w) + t * w for b, t in zip(base, WARM_TARGET))
    lum = _luma(c)
    if lum <= 1e-6:
        return c
    s = _luma(base) / lum
    return tuple(ch * s for ch in c)


def boost_fixture_glow(fixture_objs, frac, cap=EMIT_CAP):
    """Set the fixture's emissive shaders — the visible glow of its bulbs /
    diffusers — to `min(authored, cap) * frac`. Clamping tames the studio
    HDR emission so low slider values read as a soft glow instead of a blown
    white blob. This is the user-facing "fixture brightness" control and is
    independent of how much light the fixture throws into the room."""
    frac = max(0.0, frac)
    mats = set()
    for obj in fixture_objs:
        if obj.type != "MESH":
            continue
        for slot in obj.material_slots:
            if slot.material and slot.material.use_nodes:
                mats.add(slot.material)
    for m in mats:
        for n in m.node_tree.nodes:
            if n.type == "EMISSION":
                try:
                    s = n.inputs["Strength"]
                    if s.default_value > 0:
                        s.default_value = min(s.default_value, cap) * frac
                except Exception:
                    pass
            elif n.type == "BSDF_PRINCIPLED":
                try:
                    es = n.inputs["Emission Strength"]
                    if es.default_value > 0:
                        es.default_value = min(es.default_value, cap) * frac
                except Exception:
                    pass


def boost_fixture_lamps(fixture_objs, frac, warm, cap=LAMP_CAP):
    """Set (and warm) the fixture's own LIGHT lamps to `min(authored, cap) *
    frac` — cap-and-set like boost_fixture_glow, because authored studio energies
    are HDR-hot and a multiply alone leaves low slider values blinding. With IES
    photometry the lamps are the visible LED glow (frac follows the brightness
    slider); without it they double as the room-spill source (frac follows the
    light-output slider). `warm` (0..1) tints toward a warm white."""
    frac = max(0.0, frac)
    for obj in fixture_objs:
        if obj.type != "LIGHT":
            continue
        obj.data.energy = min(obj.data.energy, cap) * frac
        if warm > 0:
            obj.data.color = warm_color(tuple(obj.data.color), warm)


def add_fallback_light(scene, location, watts, warm, soft=0.35):
    """A plain point light at the fixture for decoratives that ship WITHOUT IES
    photometry and (often) without real lamp objects — their bulbs are emissive
    meshes sealed inside shades, so almost no light escapes to the room. This gives
    the "light output" slider a real, controllable source that washes the
    surrounding wall and casts a soft contact shadow. `watts` is the lamp power."""
    data = bpy.data.lights.new("wac_fill", type="POINT")
    data.energy = max(0.0, watts)
    data.shadow_soft_size = soft  # soft-edged shadow, not a hard pinpoint
    data.color = warm_color((1.0, 1.0, 1.0), warm)
    obj = bpy.data.objects.new("wac_fill", data)
    scene.collection.objects.link(obj)
    obj.location = location
    return obj


def resolve_ies_file(path):
    """WAC ships IES photometry from Sales Layer as a CDN `.zip` (the worker
    downloaded it to `path` under a generic name). If `path` is a zip, extract the
    first `.ies` member to a temp file and return that; if it's already a raw
    `.ies`, return it unchanged; return None when no usable `.ies` is found (the
    caller then falls back to the fixture's own lamps + a synthetic fill)."""
    try:
        with open(path, "rb") as f:
            magic = f.read(2)
    except OSError:
        return None
    if magic != b"PK":  # not a zip — assume a raw .ies
        return path
    try:
        with zipfile.ZipFile(path) as zf:
            members = [n for n in zf.namelist() if n.lower().endswith(".ies")]
            if not members:
                print(f"[composite] IES zip has no .ies member: {zf.namelist()}")
                return None
            out_dir = tempfile.mkdtemp(prefix="wac_ies_")
            extracted = zf.extract(members[0], out_dir)
            print(f"[composite] extracted IES '{members[0]}' from zip")
            return extracted
    except (zipfile.BadZipFile, OSError) as e:
        print(f"[composite] IES zip extract failed: {e}")
        return None


def add_ies_light(scene, location, ies_path, power, rotation_euler, warm):
    """A real-photometry light: an IES Texture node drives the light's emission so
    the fixture throws its TRUE manufacturer distribution into the room (accurate
    wall wash / spill). `rotation_euler` orients the IES nadir; `power` scales it.
    """
    data = bpy.data.lights.new("wac_ies", type="POINT")
    data.use_nodes = True
    data.shadow_soft_size = 0.05
    nt = data.node_tree
    nt.nodes.clear()
    ies = nt.nodes.new("ShaderNodeTexIES")
    ies.mode = "EXTERNAL"
    ies.filepath = ies_path
    mult = nt.nodes.new("ShaderNodeMath")
    mult.operation = "MULTIPLY"
    mult.inputs[1].default_value = power
    nt.links.new(ies.outputs["Fac"], mult.inputs[0])
    emis = nt.nodes.new("ShaderNodeEmission")
    emis.inputs["Color"].default_value = (*warm_color((1.0, 1.0, 1.0), warm), 1.0)
    nt.links.new(mult.outputs["Value"], emis.inputs["Strength"])
    out = nt.nodes.new("ShaderNodeOutputLight")
    nt.links.new(emis.outputs["Emission"], out.inputs["Surface"])

    obj = bpy.data.objects.new("wac_ies", data)
    scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = rotation_euler
    return obj


def kill_fixture_selflight(fixture_objs):
    """Zero the fixture's OWN light (lamps + emissive diffusers) so a pass renders
    it lit only by the room. Differencing this against the normal pass isolates the
    fixture's glow/glare into an editable layer."""
    for obj in fixture_objs:
        if obj.type == "LIGHT":
            obj.data.energy = 0.0
    mats = set()
    for obj in fixture_objs:
        if obj.type != "MESH":
            continue
        for slot in obj.material_slots:
            if slot.material and slot.material.use_nodes:
                mats.add(slot.material)
    for m in mats:
        for n in m.node_tree.nodes:
            if n.type == "EMISSION":
                try:
                    n.inputs["Strength"].default_value = 0.0
                except Exception:
                    pass
            elif n.type == "BSDF_PRINCIPLED":
                try:
                    n.inputs["Emission Strength"].default_value = 0.0
                except Exception:
                    pass


def light_centroid(fixture_objs, fallback):
    """Average location of the fixture's own lamps (the LED emitters); used as the
    origin for the IES light. Falls back to the fixture center."""
    locs = [o.matrix_world.translation for o in fixture_objs if o.type == "LIGHT"]
    if not locs:
        return fallback
    acc = Vector((0, 0, 0))
    for l in locs:
        acc = acc + l
    return acc / len(locs)


# ---------------------------------------------------------------------------
# Cam Solve room-match (roomGeometry). When the caller supplies a calibrated room
# (camera + planes solved from the user's traced edges, see @wac/shared roomcalib),
# we replace the fixture-centric ORBIT camera + camera-facing billboard with a
# camera matched to the PHOTO and real, correctly-oriented ceiling/wall/floor
# planes. The fixture's lamps/IES then throw light + cast shadows onto the actual
# surfaces (right perspective + falloff + a real contact at the canopy) instead of
# a flat plate, so a hanging chandelier reads as anchored.
#
# Coordinate note: roomcalib emits the CAMERA AXES in a Z-up WORLD frame (room
# azimuth is a free gauge). Blender world is Z-up too, so we use those vectors
# directly: Blender camera local axes in world are X=right, Y=up, Z=-forward.
# ---------------------------------------------------------------------------


def _vec(d):
    return Vector((float(d["x"]), float(d["y"]), float(d["z"])))


def build_matched_camera(scene, basis, fov_deg, position):
    """Create a camera whose orientation matches the photo (from the solved
    basis) at `position`. Blender's camera looks down local -Z with +Y up, so the
    camera-to-world rotation has columns [right, up, -forward]."""
    right = _vec(basis["right"]).normalized()
    up = _vec(basis["up"]).normalized()
    forward = _vec(basis["forward"]).normalized()
    cam_data = bpy.data.cameras.new("wac_match_cam")
    cam_data.lens_unit = "FOV"
    cam_data.angle = math.radians(fov_deg)
    cam_obj = bpy.data.objects.new("wac_match_cam", cam_data)
    scene.collection.objects.link(cam_obj)
    rot = Matrix((
        (right.x, up.x, -forward.x),
        (right.y, up.y, -forward.y),
        (right.z, up.z, -forward.z),
    )).to_4x4()
    rot.translation = position
    cam_obj.matrix_world = rot
    scene.camera = cam_obj
    return cam_obj, right, up, forward


def make_oriented_catcher(scene, room_path, point, normal, size):
    """A world-oriented SHADOW-CATCHER plane sitting on a real room surface
    (ceiling/wall/floor). It is transparent to the photographic background but
    catches the fixture's shadow + light, compositing the result onto the plate.
    The room photo drives its diffuse albedo (window/screen mapped) so the caught
    bounce tints with the room. Cycles only."""
    n = normal.normalized()
    ref = Vector((0.0, 0.0, 1.0)) if abs(n.z) < 0.9 else Vector((1.0, 0.0, 0.0))
    u = ref.cross(n).normalized()
    v = n.cross(u).normalized()
    hs = size * 0.5
    verts = [
        point + (-u * hs) + (-v * hs),
        point + (u * hs) + (-v * hs),
        point + (u * hs) + (v * hs),
        point + (-u * hs) + (v * hs),
    ]
    mesh = bpy.data.meshes.new("wac_room_catcher")
    mesh.from_pydata([tuple(p) for p in verts], [], [(0, 1, 2, 3)])
    mesh.update()
    plane = bpy.data.objects.new("wac_room_catcher", mesh)
    scene.collection.objects.link(plane)

    img = bpy.data.images.load(room_path)
    mat = bpy.data.materials.new("wac_room_catcher_mat")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    coord = nt.nodes.new("ShaderNodeTexCoord")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.extension = "EXTEND"
    nt.links.new(coord.outputs["Window"], tex.inputs["Vector"])
    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    nt.links.new(tex.outputs["Color"], diff.inputs["Color"])
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(diff.outputs["BSDF"], out.inputs["Surface"])
    plane.data.materials.append(mat)
    try:
        plane.is_shadow_catcher = True
    except AttributeError:
        pass
    return plane


def setup_matched_room(scene, fixture_objs, fixture_meshes, center, radius,
                       coverage, x_pct, y_pct, room_geom, room_path, aspect,
                       mount, room_strength):
    """Matched-camera path: place a photo-matched camera, offset the fixture to
    (x_pct,y_pct), and build a real catcher plane on the fixture's mounting
    surface (ceiling for ceiling/recessed/flush, wall for wall, floor for floor).
    Returns (camera, placed_center, [planes]) mirroring the legacy path."""
    basis = room_geom["camera"]
    fov_deg = float(basis["fovDeg"])
    half_fov = math.radians(fov_deg) * 0.5
    forward = _vec(basis["forward"]).normalized()

    # Distance so the fixture's bounding sphere fills `coverage` of the frame.
    distance = (radius / max(math.sin(half_fov), 1e-3)) / max(coverage, 0.01)
    cam_pos = center - forward * distance
    cam, right, up, fwd = build_matched_camera(scene, basis, fov_deg, cam_pos)
    bpy.context.view_layer.update()

    # Screen placement: translate the fixture perpendicular to the view so its
    # center projects to (x_pct, y_pct) — same trick as the legacy path.
    depth = (center - cam.location).dot(fwd)
    if aspect >= 1.0:
        half_w = math.tan(half_fov) * depth
        half_h = half_w / aspect
    else:
        half_h = math.tan(half_fov) * depth
        half_w = half_h * aspect
    offset = right * ((x_pct - 0.5) * 2 * half_w) + up * ((0.5 - y_pct) * 2 * half_h)
    for o in fixture_objs:
        if o.parent is None or o.parent not in fixture_objs:
            o.location = o.location + offset
    placed_center = center + offset
    bpy.context.view_layer.update()

    # Fixture top (canopy) and bottom, in world Z, after the offset.
    zs = [
        (o.matrix_world @ Vector(c)).z
        for o in fixture_meshes
        for c in o.bound_box
    ]
    top_z = max(zs) if zs else placed_center.z + radius
    bottom_z = min(zs) if zs else placed_center.z - radius

    # Background: the room photo on a far, emissive-only billboard (receive=0) so
    # the frame still reads as the room; the oriented shadow-catcher modulates it.
    bg_distance = distance + radius * 8.0
    bg, _, _ = make_catcher(scene, cam, room_path, bg_distance, aspect,
                            room_strength, 0.0)

    size = max(distance * 4.0, radius * 20.0)
    m = (mount or "ceiling").lower()
    catcher = None
    if m == "wall":
        # Vertical plane just behind the fixture; normal faces the room/camera.
        flat = Vector((-forward.x, -forward.y, 0.0))
        normal = flat.normalized() if flat.length > 1e-4 else Vector((0.0, -1.0, 0.0))
        point = placed_center + forward * (radius * 0.6)
    elif m == "floor":
        normal = Vector((0.0, 0.0, 1.0))
        point = Vector((placed_center.x, placed_center.y, bottom_z))
        # A "floor" above the camera is a mis-mounted fixture (wrong registry
        # mount or a placement dragged high); the giant horizontal shadow-catcher
        # would veil the whole upper frame. Render without it instead.
        if bottom_z > cam_pos.z - 0.05:
            catcher = False
    else:  # ceiling / recessed / flush
        normal = Vector((0.0, 0.0, 1.0))  # horizontal ceiling, normal up
        point = Vector((placed_center.x, placed_center.y, top_z))
        # Same guard, mirrored: a "ceiling" below the camera (e.g. a wall sconce
        # whose registry says ceiling, placed at table height) puts the plane
        # under the lens and washes out everything below its horizon line.
        if top_z < cam_pos.z + 0.05:
            catcher = False
    if catcher is False:
        print(f"[composite] room-match: SKIPPED {m} catcher — plane at "
              f"z={point.z:.3f} vs camera z={cam_pos.z:.3f} is on the wrong "
              f"side (check the fixture's mount in the registry)")
        print(f"[composite] room-match: mount={m} fov={fov_deg:.1f} dist={distance:.2f} "
              f"canopy_z={top_z:.3f} planes=[bg]")
        return cam, placed_center, [bg]
    catcher = make_oriented_catcher(scene, room_path, point, normal, size)

    print(f"[composite] room-match: mount={m} fov={fov_deg:.1f} dist={distance:.2f} "
          f"canopy_z={top_z:.3f} planes=[bg,{m}]")
    return cam, placed_center, [bg, catcher]


# ---------------------------------------------------------------------------
# Room-box single-scene render (roomGeometry.box + fixtures[]).
#
# The corner-drag room match gives a METRIC room: solved camera height, wall
# positions and ceiling height in meters (floor z=0, camera at plan origin). So
# instead of chaining one render per fixture against an accumulating plate (the
# legacy multi-fixture path, whose re-emission stacked light into a wash), we
# build the actual room ONCE — five photo-mapped planes — append every
# fixture's .blend into the one scene, and render with the photo's camera. The
# fixtures' light then sums physically in a single linear render, falls off
# over real distances, and every IES points the way the real fixture does.
# ---------------------------------------------------------------------------

# Fixture yaw (about world Z) that turns its authored front toward the room for
# each mount wall: studio blends are authored facing -Y (the legacy orbit camera
# at azimuth 0 sits on -Y), which already faces a back-wall viewer.
SURFACE_BASE_YAW = {
    "ceiling": 0.0,
    "floor": 0.0,
    "wall-back": 0.0,
    "wall-left": math.pi / 2.0,
    "wall-right": -math.pi / 2.0,
}


def append_fixture(scene, blend_path, sku):
    """Append a fixture collection from another .blend into THIS scene (the
    multi-fixture room-box path; the first fixture is the opened file itself).
    Loads the library's collections, picks the fixture with the same heuristics
    as render.pick_fixture_collection, links ONLY that one. Name collisions
    auto-suffix (.001), so per-fixture material/lamp boosts stay independent."""
    with bpy.data.libraries.load(blend_path, link=False) as (data_from, data_to):
        data_to.collections = list(data_from.collections)
    cols = [c for c in data_to.collections if c is not None]
    if not cols:
        raise SystemExit(f"composite.py: no collections in {blend_path}")
    # Top-level = not a child of any other loaded collection (mirrors picking
    # from scene.collection.children in the single-fixture path).
    child_names = set()
    for c in cols:
        for ch in c.children_recursive:
            child_names.add(ch.name)
    tops = [c for c in cols if c.name not in child_names] or cols
    chosen = None
    if sku:
        t = R.normalize(sku)
        for c in tops:
            cn = R.normalize(c.name)
            if (cn == t or cn.startswith(t) or t.startswith(cn)) and R.mesh_objects_in(c):
                chosen = c
                break
    if chosen is None:
        cands = [c for c in tops if not R.looks_like_rig(c) and R.mesh_objects_in(c)]
        cands.sort(key=lambda c: len(R.mesh_objects_in(c)), reverse=True)
        chosen = cands[0] if cands else next(
            (c for c in tops if R.mesh_objects_in(c)), tops[0]
        )
    scene.collection.children.link(chosen)
    print(f"[composite] appended fixture collection '{chosen.name}' from {os.path.basename(blend_path)}")
    return set(chosen.all_objects)


def duplicate_fixture_group(scene, objs):
    """A second instance of an already-loaded fixture (two identical pendants
    share one downloaded .blend — and Blender refuses libraries.load on the
    currently-open file anyway). Object-level copies SHARE the heavy mesh data;
    lights and materials are copied (as per-object overrides) because the
    per-fixture slider boosts mutate them."""
    mapping = {}
    mat_map = {}
    new_objs = set()
    for o in objs:
        c = o.copy()
        if o.type == "LIGHT":
            c.data = o.data.copy()  # energy/color are set per fixture
        mapping[o] = c
        scene.collection.objects.link(c)
        new_objs.add(c)
    for o, c in mapping.items():
        if o.parent in mapping:
            c.parent = mapping[o.parent]
            c.matrix_parent_inverse = o.matrix_parent_inverse.copy()
    for o, c in mapping.items():
        if o.type != "MESH":
            continue
        for slot in c.material_slots:
            m = slot.material
            if m is None:
                continue
            if m not in mat_map:
                mat_map[m] = m.copy()
            slot.link = "OBJECT"  # override on the object; shared mesh data untouched
            slot.material = mat_map[m]
    print(f"[composite] duplicated fixture group ({len(new_objs)} objects, shared mesh data)")
    return new_objs


def make_room_plate(scene, img, name, verts, receive, emit):
    """One wall/floor/ceiling of the solved room box, split by ray type:

      - CAMERA rays see a pure-diffuse surface (photo albedo): the pixel value
        is purely RECEIVED light, so the worker's lit/base ratio keeps full
        sensitivity to fixture highlights and blocked-light shadows.
      - All OTHER rays (bounce, glossy, refraction) see the photo as EMISSION:
        the room LIGHTS ITSELF exactly the way the photo says it is lit. The
        ceiling's base light comes from the bright floor/windows (no more
        divide-by-near-zero burn up there), the fixture body is bathed in real
        room light instead of silhouetting black, and its glass refracts the
        actual photo.

    The worker multiplies the PHOTO by lit/base, so the photo (already
    properly exposed) only ever gets RELATIVE highlights and shadows."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(p) for p in verts], [], [(0, 1, 2, 3)])
    mesh.update()
    plane = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(plane)

    mat = bpy.data.materials.new(name + "_mat")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    coord = nt.nodes.new("ShaderNodeTexCoord")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.extension = "EXTEND"
    nt.links.new(coord.outputs["Window"], tex.inputs["Vector"])

    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    albedo = nt.nodes.new("ShaderNodeMixRGB")
    albedo.blend_type = "MULTIPLY"
    albedo.inputs["Fac"].default_value = 1.0
    albedo.inputs["Color2"].default_value = (receive, receive, receive, 1.0)
    nt.links.new(tex.outputs["Color"], albedo.inputs["Color1"])
    nt.links.new(albedo.outputs["Color"], diff.inputs["Color"])

    emis = nt.nodes.new("ShaderNodeEmission")
    emis.inputs["Strength"].default_value = emit
    nt.links.new(tex.outputs["Color"], emis.inputs["Color"])

    lp = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(emis.outputs["Emission"], mix.inputs[1])  # fac 0: non-camera rays
    nt.links.new(diff.outputs["BSDF"], mix.inputs[2])  # fac 1: camera rays
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    plane.data.materials.append(mat)
    return plane


def bbox_min_max(meshes):
    """World-space AABB (mins, maxs) of a set of mesh objects."""
    mins = Vector((math.inf, math.inf, math.inf))
    maxs = Vector((-math.inf, -math.inf, -math.inf))
    for o in meshes:
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            mins.x, mins.y, mins.z = min(mins.x, w.x), min(mins.y, w.y), min(mins.z, w.z)
            maxs.x, maxs.y, maxs.z = max(maxs.x, w.x), max(maxs.y, w.y), max(maxs.z, w.z)
    if mins.x == math.inf:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    return mins, maxs


def place_fixture_group(scene, objs, meshes, spec, boxd, basis, focal, aspect, cam_h):
    """Scale / spin / position one fixture onto its mount surface, true-to-scale
    (the .blend is authored in meters and the room box is metric). Transforms go
    through an Empty pivot at the fixture's bbox center so arbitrary hierarchies
    move as one. Returns (pivot, kind, yaw_radians)."""
    surface = spec.get("surface") or {}
    kind = surface.get("kind") or RB.surface_for_mount(spec.get("mount"))
    s = float(surface.get("scale", 1.0))
    yaw = math.radians(float(surface.get("lightYawDeg", 0.0))) + SURFACE_BASE_YAW.get(kind, 0.0)

    u, v = surface.get("u"), surface.get("v")
    if u is None or v is None:
        # Legacy placement (no surface): project the xPct/yPct screen position
        # through the solved camera onto the mount surface.
        hit = RB.raycast_surface(
            basis, focal, aspect, cam_h, boxd,
            float(spec.get("xPct", 0.5)), float(spec.get("yPct", 0.5)), kind,
        )
        u, v = hit if hit else (0.5, 0.5)
        u, v = min(1.0, max(0.0, u)), min(1.0, max(0.0, v))
    target = Vector(RB.surface_to_world(boxd, kind, float(u), float(v)))

    mins, maxs = bbox_min_max(meshes)
    center = (mins + maxs) * 0.5
    hx = (maxs.x - mins.x) * 0.5 * s
    hy = (maxs.y - mins.y) * 0.5 * s
    hz = (maxs.z - mins.z) * 0.5 * s
    # Half extents in world x/y after the yaw spin.
    c_, s_ = abs(math.cos(yaw)), abs(math.sin(yaw))
    rhx = c_ * hx + s_ * hy
    rhy = s_ * hx + c_ * hy
    # Anchor the mount face of the bbox to the surface point.
    off = Vector((0.0, 0.0, 0.0))
    if kind == "ceiling":
        off.z = -hz
    elif kind == "floor":
        off.z = hz
    elif kind == "wall-back":
        off.y = -rhy  # room is toward -Y from the back wall
    elif kind == "wall-left":
        off.x = rhx
    elif kind == "wall-right":
        off.x = -rhx

    pivot = bpy.data.objects.new("wac_fixture_pivot", None)
    scene.collection.objects.link(pivot)
    pivot.location = center
    bpy.context.view_layer.update()
    inv = pivot.matrix_world.inverted()
    for o in objs:
        if o.parent is None or o.parent not in objs:
            o.parent = pivot
            o.matrix_parent_inverse = inv.copy()
    pivot.scale = (s, s, s)
    pivot.rotation_euler = (0.0, 0.0, yaw)
    pivot.location = target + off
    bpy.context.view_layer.update()
    print(f"[composite] room-box fixture sku={spec.get('sku')} surf={kind} "
          f"u={float(u):.3f} v={float(v):.3f} scale={s:.2f} yaw={math.degrees(yaw):.0f} "
          f"at=({(target + off).x:.2f},{(target + off).y:.2f},{(target + off).z:.2f})")
    return pivot, kind, yaw


def suspend_fixture_selflight(fixture_objs):
    """Like kill_fixture_selflight, but reversible: zero the fixture's own lamps
    + emissive shaders and return what to restore — needed because the room-box
    path renders per-fixture base passes in ONE scene, where the OTHER fixtures'
    light must stay on for each pass."""
    saved = []
    for obj in fixture_objs:
        if obj.type == "LIGHT":
            saved.append((obj.data, "energy", obj.data.energy))
            obj.data.energy = 0.0
    mats = set()
    for obj in fixture_objs:
        if obj.type != "MESH":
            continue
        for slot in obj.material_slots:
            if slot.material and slot.material.use_nodes:
                mats.add(slot.material)
    for m in mats:
        for n in m.node_tree.nodes:
            if n.type == "EMISSION":
                try:
                    sock = n.inputs["Strength"]
                    saved.append((sock, "default_value", sock.default_value))
                    sock.default_value = 0.0
                except Exception:
                    pass
            elif n.type == "BSDF_PRINCIPLED":
                try:
                    sock = n.inputs["Emission Strength"]
                    if sock.default_value > 0:
                        saved.append((sock, "default_value", sock.default_value))
                        sock.default_value = 0.0
                except Exception:
                    pass
    return saved


def restore_fixture_selflight(saved):
    for ref, attr, val in saved:
        try:
            setattr(ref, attr, val)
        except Exception:
            pass


def run_room_box(scene, job, out_path):
    """The room-box single-scene composite (see the section comment above)."""
    specs = job["fixtures"]
    geom = job["roomGeometry"]
    solved = geom["box"]["solved"]
    boxd = solved["box"]
    cam_h = float(solved["cameraHeightM"])
    basis = geom["camera"]

    # --- fixture 0 = the opened .blend; isolate it from its studio rig --------
    fixture = R.pick_fixture_collection(scene, specs[0].get("sku"))
    if fixture is None:
        raise SystemExit("composite.py: could not locate a fixture collection")
    groups = [{
        "objs": set(fixture.all_objects),
        "meshes": set(R.mesh_objects_in(fixture)),
        "spec": specs[0],
    }]
    for obj in scene.objects:
        if obj.type == "MESH" and obj not in groups[0]["meshes"]:
            obj.hide_render = True  # studio backdrop/floor — replaced by the room
        if obj.type == "LIGHT" and obj not in groups[0]["objs"]:
            obj.hide_render = True  # studio softboxes — the room lights the shot
    scene.timeline_markers.clear()
    # The room LIGHTS ITSELF via the plates' indirect-only photo emission (see
    # make_room_plate) — that is the relight ratio's exposure baseline. The
    # world env is just a dim white floor so no denominator pixel can reach
    # true zero (a black base pixel would blow the ratio up).
    if scene.world is None:
        scene.world = bpy.data.worlds.new("wac_world")
    scene.world.use_nodes = True
    for n in scene.world.node_tree.nodes:
        if n.type == "BACKGROUND":
            n.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
            n.inputs["Strength"].default_value = float(job.get("worldStrength", 0.05))

    # --- append fixtures 1..N-1 into this scene -------------------------------
    # Fixtures sharing a .blend (identical pendants; the worker dedupes the
    # download) are duplicated from the loaded group instead of re-appended.
    by_path = {os.path.realpath(bpy.data.filepath): groups[0]["objs"]}
    for spec in specs[1:]:
        model_path = spec.get("modelPath")
        if not model_path or not os.path.exists(model_path):
            raise SystemExit(f"composite.py: fixture model not found: {model_path}")
        real = os.path.realpath(model_path)
        source = by_path.get(real)
        if source is not None:
            objs = duplicate_fixture_group(scene, source)
        else:
            objs = append_fixture(scene, model_path, spec.get("sku"))
            by_path[real] = objs
        groups.append({
            "objs": objs,
            "meshes": {o for o in objs if o.type == "MESH"},
            "spec": spec,
        })

    # --- room image / matched camera / room geometry --------------------------
    room_path = job.get("roomPath")
    if not room_path or not os.path.exists(room_path):
        raise SystemExit(f"composite.py: roomPath not found: {room_path}")
    probe = bpy.data.images.load(room_path)
    rw, rh = probe.size[0], probe.size[1]
    aspect = rw / rh

    fov_deg = float(basis["fovDeg"])
    cam, _, _, _ = build_matched_camera(scene, basis, fov_deg, Vector((0.0, 0.0, cam_h)))
    bpy.context.view_layer.update()

    img = bpy.data.images.load(room_path)
    x0, x1 = float(boxd["xMin"]), float(boxd["xMax"])
    yb, hgt = float(boxd["yBack"]), float(boxd["height"])
    # Extend the open (camera) side behind the lens so the floor/ceiling/walls
    # always cover the frustum bottom/top; oversize all seams a little. The
    # Window mapping makes the overlaps invisible (same screen pixel either way).
    yf = min(float(boxd["yFront"]), 0.0) - 2.0
    ov = 0.5
    recv = float(job.get("catcherReceive", 1.0))
    emit = float(job.get("roomEmit", 1.0))
    plates = [
        make_room_plate(scene, img, "wac_room_floor",
                        [(x0 - ov, yf, 0), (x1 + ov, yf, 0), (x1 + ov, yb + ov, 0), (x0 - ov, yb + ov, 0)],
                        recv, emit),
        make_room_plate(scene, img, "wac_room_ceiling",
                        [(x0 - ov, yf, hgt), (x1 + ov, yf, hgt), (x1 + ov, yb + ov, hgt), (x0 - ov, yb + ov, hgt)],
                        recv, emit),
        make_room_plate(scene, img, "wac_room_back",
                        [(x0 - ov, yb, -ov), (x1 + ov, yb, -ov), (x1 + ov, yb, hgt + ov), (x0 - ov, yb, hgt + ov)],
                        recv, emit),
        make_room_plate(scene, img, "wac_room_left",
                        [(x0, yf, -ov), (x0, yb + ov, -ov), (x0, yb + ov, hgt + ov), (x0, yf, hgt + ov)],
                        recv, emit),
        make_room_plate(scene, img, "wac_room_right",
                        [(x1, yf, -ov), (x1, yb + ov, -ov), (x1, yb + ov, hgt + ov), (x1, yf, hgt + ov)],
                        recv, emit),
    ]
    # Far emission-only backdrop: covers any frustum sliver past the box. It is
    # identical in the lit and base passes, so it divides out to ratio=1 there
    # (the photo passes through untouched).
    bg, _, _ = make_catcher(scene, cam, room_path, max(yb * 3.0, 8.0), aspect,
                            float(job.get("roomStrength", 1.0)), 0.0)
    plates.append(bg)

    # --- place each fixture + its light ----------------------------------------
    focal = RB.focal_from_fov(fov_deg, aspect)
    gamma = float(job.get("lightGamma", SLIDER_GAMMA))
    neutral_frac = float(job.get("lightNeutralFrac", SLIDER_NEUTRAL_FRAC))
    lamp_cap = float(job.get("lampCap", LAMP_CAP))
    emit_cap = float(job.get("emitCap", EMIT_CAP))
    for g in groups:
        spec = g["spec"]
        _, kind, yaw = place_fixture_group(
            scene, g["objs"], g["meshes"], spec, boxd, basis, focal, aspect, cam_h,
        )
        warm = float(spec.get("warm", 0.45))
        glow = slider_frac(float(spec.get("brightness", 50.0)), neutral_frac, gamma)
        lamp_boost = slider_frac(float(spec.get("lightOutput", 50.0)), neutral_frac, gamma)
        boost_fixture_glow(g["objs"], glow, emit_cap)

        center, _ = R.world_bounding_box(g["meshes"])
        ies_obj = None
        ies_used = False
        ies_path = spec.get("iesPath")
        if ies_path and os.path.exists(ies_path):
            ies_path = resolve_ies_file(ies_path)
        if ies_path and os.path.exists(ies_path):
            try:
                # Real surfaces all around: aim the IES nadir straight DOWN like
                # the real fixture (its lobes light ceiling/walls/floor naturally)
                # and spin it with the fixture.
                loc = light_centroid(g["objs"], center)
                power = lamp_boost * float(job.get("iesRefWatts", IES_REF_WATTS))
                ies_obj = add_ies_light(scene, loc, ies_path, power, (0.0, 0.0, yaw), warm)
                boost_fixture_lamps(g["objs"], glow, warm, lamp_cap)
                ies_used = True
                print(f"[composite] room-box IES sku={spec.get('sku')} power={power:.2f}W glow x{glow:.3f}")
            except Exception as e:
                print(f"[composite] IES setup failed ({e}); falling back to lamps")
        if not ies_used:
            boost_fixture_lamps(g["objs"], lamp_boost, warm, lamp_cap)
            watts = lamp_boost * float(job.get("fallbackWatts", 250.0))
            ies_obj = add_fallback_light(scene, light_centroid(g["objs"], center), watts, warm)
            print(f"[composite] room-box fill sku={spec.get('sku')} watts={watts:.1f} lamp x{lamp_boost:.3f}")
        g["light"] = ies_obj

    # --- render ---------------------------------------------------------------
    scene.render.film_transparent = False
    scene.render.engine = "CYCLES"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    try:
        # Many lights + glass in one scene: clamp indirect bounces to tame
        # fireflies without visibly dimming the wall wash.
        scene.cycles.sample_clamp_indirect = float(job.get("clampIndirect", 10.0))
    except Exception:
        pass

    preview = bool(job.get("preview"))
    base_w, base_h = rw, rh
    samples = job.get("samples")
    if preview:
        maxpx = int(job.get("previewMaxPx", 1100))
        sc = min(1.0, maxpx / float(max(rw, rh)))
        base_w = max(1, int(round(rw * sc)))
        base_h = max(1, int(round(rh * sc)))
        if samples is None:
            samples = 150

    ss = float(job.get("supersample", 1.0))
    fixture_scale = max(1.0, float(job.get("fixtureScale", 1.0)))
    compose = bool(job.get("composeBeauty"))
    hi_w = int(round(base_w * fixture_scale))
    hi_h = int(round(base_h * fixture_scale))

    def render_to(p, w, h, transparent, samples_override=None):
        render_w, render_h = (int(round(w * ss)), int(round(h * ss))) if ss > 1.0 else (w, h)
        R.configure_render(scene, {
            "engine": "CYCLES",
            "samples": samples if samples_override is None else samples_override,
            "highQuality": job.get("highQuality"),
            "width": render_w,
            "height": render_h,
            # Baked sRGB room photo on the plates — pin Standard/sRGB so the
            # plate renders back as itself (see the legacy path's note).
            "viewTransform": job.get("viewTransform", "Standard"),
            "displayDevice": job.get("displayDevice", "sRGB"),
        })
        scene.render.film_transparent = transparent
        scene.render.filepath = p
        bpy.ops.render.render(write_still=True)
        if ss > 1.0:
            try:
                im = bpy.data.images.load(p)
                im.scale(w, h)
                im.file_format = "PNG"
                im.save(filepath=p)
                bpy.data.images.remove(im)
            except Exception as e:
                print(f"[composite] supersample downscale failed: {e}")
        print(f"[composite] wrote {p} ({w}x{h})")

    print(f"[composite] ROOM-BOX scene: {len(groups)} fixture(s) room={rw}x{rh} "
          f"base={base_w}x{base_h} hi={hi_w}x{hi_h} preview={preview} compose={compose} "
          f"samples={samples} fov={fov_deg:.1f} camH={cam_h:.2f} "
          f"box=({x0:.2f}..{x1:.2f}, yBack={yb:.2f}, H={hgt:.2f})")

    # The room-box path NEVER renders a direct beauty: the worker relight-
    # composites the photo with the lit/base wall ratio and overlays the
    # fixture cutouts (preview and final alike).
    base, ext = os.path.splitext(out_path)

    # Light passes for the relight ratio, both @ room res (they're smooth,
    # low-frequency gradients, so previews get away with fewer samples):
    #   _wall      planes lit by ambient + every fixture (fixtures camera-hidden
    #              but still emitting light and casting shadows)
    #   _wallbase  planes lit by the ambient ALONE (fixtures fully absent)
    wall_samples = max(48, int(samples) // 3) if (preview and samples) else samples
    for g in groups:
        for o in g["meshes"]:
            o.visible_camera = False
    render_to(base + "_wall" + ext, base_w, base_h, False, wall_samples)
    unhide = []
    for g in groups:
        for o in list(g["objs"]) + ([g["light"]] if g["light"] is not None else []):
            if not o.hide_render:
                unhide.append(o)
                o.hide_render = True
    render_to(base + "_wallbase" + ext, base_w, base_h, False, wall_samples)
    for o in unhide:
        o.hide_render = False
    for g in groups:
        for o in g["meshes"]:
            o.visible_camera = True

    # Per-fixture hi-res cutout (+ self-light-off base for the PSD glow layer on
    # finals). Other fixtures stay camera-hidden but keep LIGHTING the scene —
    # cross-illumination is physically right and free in the shared scene.
    for i, g in enumerate(groups):
        for j, g2 in enumerate(groups):
            vis = j == i
            for o in g2["meshes"]:
                o.visible_camera = vis
        for c in plates:
            c.visible_camera = False
        render_to(base + f"_fixture{i}" + ext, hi_w, hi_h, transparent=True)
        if job.get("layers"):
            saved = suspend_fixture_selflight(g["objs"])
            if g["light"] is not None:
                g["light"].hide_render = True
            render_to(base + f"_fixture{i}base" + ext, hi_w, hi_h, transparent=True)
            restore_fixture_selflight(saved)
            if g["light"] is not None:
                g["light"].hide_render = False
    for g in groups:
        for o in g["meshes"]:
            o.visible_camera = True
    for c in plates:
        c.visible_camera = True
    print(f"[composite] room-box relight passes done (wall + wallbase + "
          f"{len(groups)}x fixture{' + base' if job.get('layers') else ''})")


def main():
    job, out_path = parse_args()
    scene = bpy.context.scene

    if job.get("fixtures") and (job.get("roomGeometry") or {}).get("box"):
        # Corner-drag room match: ONE scene, ALL fixtures, the photo's camera.
        run_room_box(scene, job, out_path)
        return

    # --- isolate fixture (keep its internal LED lamps for the glow) ---
    fixture = R.pick_fixture_collection(scene, job.get("sku"))
    if fixture is None:
        raise SystemExit("composite.py: could not locate a fixture collection")
    fixture_meshes = set(R.mesh_objects_in(fixture))
    fixture_objs = set(fixture.all_objects)

    for obj in scene.objects:
        if obj.type == "MESH" and obj not in fixture_meshes:
            obj.hide_render = True  # studio backdrop/floor — replaced by the room
        # The room is the only environment light; drop studio softbox lamps so it
        # drives the mood. The fixture's OWN lamps stay on (the LED glow).
        if obj.type == "LIGHT" and obj not in fixture_objs:
            obj.hide_render = True

    scene.timeline_markers.clear()

    # Neutral dark world so only the room plate + fixture lamps light the shot.
    if scene.world and scene.world.use_nodes:
        for n in scene.world.node_tree.nodes:
            if n.type == "BACKGROUND":
                n.inputs["Strength"].default_value = float(job.get("worldStrength", 0.15))

    # --- render size / aspect from the room image ---
    room_path = job.get("roomPath")
    if not room_path or not os.path.exists(room_path):
        raise SystemExit(f"composite.py: roomPath not found: {room_path}")
    probe = bpy.data.images.load(room_path)
    rw, rh = probe.size[0], probe.size[1]
    aspect = rw / rh

    # --- camera framing the fixture at the requested pose/coverage ---
    center, radius = R.world_bounding_box(fixture_meshes)
    coverage = float(job.get("coverage", 0.5))  # fixture size as fraction of frame
    x_pct = float(job.get("xPct", 0.5))
    y_pct = float(job.get("yPct", 0.5))
    room_geom = job.get("roomGeometry")

    if room_geom and room_geom.get("camera"):
        # Cam Solve room-match: a camera matched to the PHOTO + real ceiling/wall/
        # floor catcher planes, so the fixture's light/shadow land on the actual
        # surfaces with the photo's perspective (see setup_matched_room).
        cam, placed_center, catchers = setup_matched_room(
            scene, fixture_objs, fixture_meshes, center, radius,
            coverage, x_pct, y_pct, room_geom, room_path, aspect,
            job.get("mount"), float(job.get("roomStrength", 1.0)),
        )
    else:
        # Legacy path: fixture-centric ORBIT camera + a camera-facing room
        # billboard just behind the fixture (unchanged).
        pose = dict(job.get("pose", {}))
        # Coverage is the size control, so ALWAYS derive marginFactor from it
        # (force, not setdefault — the placement's pose may carry a stale
        # marginFactor that would otherwise pin the size and freeze the slider).
        pose["marginFactor"] = 1.0 / max(coverage, 0.01)
        cam = R.place_camera(scene, center, radius, pose)
        # place_camera sets cam.location/rotation, but matrix_world is only
        # recomputed on a depsgraph update. Without this, cam.matrix_world (and
        # thus `forward`/`depth` below) is STALE — depth comes out ~14x too small
        # and the xPct/yPct offset becomes negligible (fixture stuck near center).
        bpy.context.view_layer.update()

        # Screen placement: instead of shifting the lens (which would reveal the
        # backdrop edge), translate the FIXTURE perpendicular to the view so its
        # center projects to (xPct,yPct). The camera + backdrop stay centered.
        mw = cam.matrix_world.to_3x3()
        right = mw @ Vector((1, 0, 0))
        up = mw @ Vector((0, 1, 0))
        forward = mw @ Vector((0, 0, -1))
        depth = (center - cam.location).dot(forward)
        if aspect >= 1.0:
            half_w = math.tan(cam.data.angle * 0.5) * depth
            half_h = half_w / aspect
        else:
            half_h = math.tan(cam.data.angle * 0.5) * depth
            half_w = half_h * aspect
        offset = right * ((x_pct - 0.5) * 2 * half_w) + up * ((0.5 - y_pct) * 2 * half_h)
        for o in fixture_objs:
            if o.parent is None or o.parent not in fixture_objs:
                o.location = o.location + offset
        placed_center = center + offset
        # Refresh matrices so the moved fixture's world transforms are current.
        bpy.context.view_layer.update()

        # Catcher plane: the room photo on a light-receptive surface JUST behind
        # the fixture, so the fixture's spill + a contact shadow land on the wall
        # (not on a far plate). camera-projected, so it still fills the frame.
        forward = (cam.matrix_world.to_3x3() @ Vector((0, 0, -1))).normalized()
        # Push the catcher just past the back of the fixture along the view.
        back_depth = max(
            (corner - cam.location).dot(forward)
            for o in fixture_meshes
            for corner in (o.matrix_world @ Vector(c) for c in o.bound_box)
        )
        # Keep the billboard at least half a meter past the fixture: with it
        # only centimeters behind (radius*0.2 of a small sconce), inverse-square
        # turned even low light-output sliders into a blown hot spot on the
        # "wall" ("too bright at 12" report).
        wall_distance = back_depth + max(radius * 0.2, 0.5)
        print(f"[composite] cam_to_center={(cam.location-placed_center).length:.3f} "
              f"back_depth={back_depth:.3f} wall_distance={wall_distance:.3f}")
        catcher, _, _ = make_catcher(scene, cam, room_path, wall_distance, aspect,
                                     float(job.get("roomStrength", 1.0)),
                                     float(job.get("catcherReceive", 0.9)))
        catchers = [catcher]

    # Two INDEPENDENT user controls, both 0..100 sliders with 50 == the
    # calibrated reference look (see slider_frac for the curve):
    #   brightness  -> how bright the fixture's OWN diffusers/bulbs/lamps glow
    #   lightOutput -> how much real light it throws into the room
    warm = float(job.get("warm", 0.4))
    fixture_brightness = float(job.get("brightness", 50.0))
    light_output = float(job.get("lightOutput", 50.0))
    gamma = float(job.get("lightGamma", SLIDER_GAMMA))
    neutral_frac = float(job.get("lightNeutralFrac", SLIDER_NEUTRAL_FRAC))
    lamp_cap = float(job.get("lampCap", LAMP_CAP))
    emit_cap = float(job.get("emitCap", EMIT_CAP))
    glow = slider_frac(fixture_brightness, neutral_frac, gamma)
    lamp_boost = slider_frac(light_output, neutral_frac, gamma)
    boost_fixture_glow(fixture_objs, glow, emit_cap)

    ies_obj = None
    ies_used = False
    ies_path = job.get("iesPath")
    if ies_path and os.path.exists(ies_path):
        # WAC delivers IES as a .zip; unzip + extract the .ies (None → fallback).
        ies_path = resolve_ies_file(ies_path)
    if ies_path and os.path.exists(ies_path):
        # IES must NEVER break a render (this path is newly active for ~half the
        # catalog), so any failure here falls through to the lamp/fill fallback.
        try:
            ies_loc = light_centroid(fixture_objs, placed_center)
            rot = job.get("iesRotation")  # [x,y,z] radians; default depends on path
            if rot:
                rot_euler = (rot[0], rot[1], rot[2])
            elif room_geom:
                # Room-match: ceiling/floor are real surfaces, so aim the IES nadir
                # straight DOWN (world -Z) like the real fixture — its downward beam
                # lights the room and the upward lobes wash the actual ceiling.
                rot_euler = (0.0, 0.0, 0.0)
            else:
                # Legacy billboard: aim the IES nadir out of the wall toward the
                # camera so the side/forward lobes wash the (camera-facing) backdrop.
                rot_euler = (math.pi / 2.0, 0.0, 0.0)
            # The IES file carries the true distribution; `lightOutput` scales its
            # power. The fixture's own lamps are the visible LED glow here, so
            # they follow the BRIGHTNESS slider (cap-and-set — leaving them at
            # the authored studio-HDR energy blew the whole shot out no matter
            # how low the sliders went).
            power = float(job.get("iesPower", lamp_boost * IES_REF_WATTS))
            ies_obj = add_ies_light(scene, ies_loc, ies_path, power, rot_euler, warm)
            boost_fixture_lamps(fixture_objs, glow, warm, lamp_cap)
            ies_used = True
            print(f"[composite] IES spill power={power:.2f}W; glow x{glow:.3f}")
        except Exception as e:
            print(f"[composite] IES setup failed ({e}); falling back to lamps")
            ies_obj = None
            ies_used = False
    if not ies_used:
        # Decorative pieces (e.g. this chandelier) ship without photometry — and
        # often without real lamp objects (emissive bulb meshes inside shades). So
        # scale whatever lamps DO exist, and always add a synthetic point light at
        # the fixture so `lightOutput` reliably throws light into the room and casts
        # a soft shadow. `fallbackWatts` is the watts at frac 1.0 (authored level).
        boost_fixture_lamps(fixture_objs, lamp_boost, warm, lamp_cap)
        fill_loc = light_centroid(fixture_objs, placed_center)
        watts = lamp_boost * float(job.get("fallbackWatts", 250.0))
        add_fallback_light(scene, fill_loc, watts, warm)
        print(f"[composite] no/failed IES; fill={watts:.1f}W; lamp x{lamp_boost:.3f}; glow x{glow:.3f}")

    scene.render.film_transparent = False  # the room IS the background now
    scene.render.engine = "CYCLES"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"

    # Preview mode: the interactive AI/slider loop wants a responsive render, so
    # downscale to previewMaxPx and drop samples (still Cycles, so the glass + IES
    # wall wash read correctly). Final exports keep the file's full settings.
    preview = bool(job.get("preview"))
    base_w, base_h = rw, rh
    samples = job.get("samples")
    if preview:
        # The fixture is 3D geometry while the room is a sharp photo, so a low-res /
        # low-sample preview makes ONLY the fixture look soft & noisy ("lower
        # resolution than the rest"). Render at a healthy preview size + enough
        # samples that the denoiser doesn't smear the crystal/metal detail.
        maxpx = int(job.get("previewMaxPx", 1100))
        s = min(1.0, maxpx / float(max(rw, rh)))
        base_w = max(1, int(round(rw * s)))
        base_h = max(1, int(round(rh * s)))
        if samples is None:
            # CG team's preview sample budget (denoised), so the crystal/metal
            # detail reads correctly in the interactive slider loop.
            samples = 150

    # Supersample: render larger than the target then downscale each file, so the
    # fixture's geometry edges anti-alias crisply. 1.0 = off.
    ss = float(job.get("supersample", 1.0))
    # Fixture-only passes can render BIGGER than the room/light passes: only the 3D
    # fixture needs the extra pixels (the room is a photo, its light/shadow are
    # low-frequency), so we keep the cheap passes at the room size and pay the
    # hi-res cost SOLELY on the fixture. The worker then upscales the cheap layers
    # and overlays the crisp fixture — the manual hi-res-cutout-on-background
    # workflow. `composeBeauty` tells the worker to build the beauty from layers.
    fixture_scale = max(1.0, float(job.get("fixtureScale", 1.0)))
    compose = bool(job.get("composeBeauty"))
    hi_w = int(round(base_w * fixture_scale))
    hi_h = int(round(base_h * fixture_scale))

    def render_to(p, w, h, transparent):
        render_w, render_h = (int(round(w * ss)), int(round(h * ss))) if ss > 1.0 else (w, h)
        R.configure_render(scene, {
            "engine": "CYCLES",
            "samples": samples,
            "highQuality": job.get("highQuality"),
            "width": render_w,
            "height": render_h,
            # The background here is a BAKED sRGB room photo emitted onto the
            # catcher plane, not linear scene data. Pin Standard/sRGB so the plate
            # renders back as itself; AgX (the fixture .blend's authored transform,
            # now respected by render.configure_render) would re-tone-map and
            # darken/desaturate the room. Callers can still override per job.
            "viewTransform": job.get("viewTransform", "Standard"),
            "displayDevice": job.get("displayDevice", "sRGB"),
        })
        # configure_render forces film_transparent=True; re-apply per pass AFTER it.
        scene.render.film_transparent = transparent
        scene.render.filepath = p
        bpy.ops.render.render(write_still=True)
        if ss > 1.0:
            try:
                img = bpy.data.images.load(p)
                img.scale(w, h)
                img.file_format = "PNG"
                img.save(filepath=p)
                bpy.data.images.remove(img)
            except Exception as e:
                print(f"[composite] supersample downscale failed: {e}")
        print(f"[composite] wrote {p} ({w}x{h})")

    print(f"[composite] fixture='{fixture.name}' room={rw}x{rh} base={base_w}x{base_h} "
          f"hi={hi_w}x{hi_h} preview={preview} compose={compose} samples={samples} "
          f"coverage={coverage} room_match={bool(room_geom)} pos=({x_pct},{y_pct})")

    # Beauty: rendered directly EXCEPT when the worker will compose it from the
    # layers (the hi-res-fixture path), which skips this expensive full-frame pass.
    if not (job.get("layers") and compose):
        render_to(out_path, base_w, base_h, transparent=False)

    # Layered passes for the PSD. Wall (light + shadow, fixture hidden from camera
    # but still casting/lighting) stays at room resolution — it's low-frequency and
    # upscales invisibly. The fixture cutouts render at the hi-res `fixture_scale`.
    if job.get("layers"):
        base, ext = os.path.splitext(out_path)
        # Wall layer @ room res: fixture invisible to camera -> lit wall + shadow.
        for o in fixture_meshes:
            o.visible_camera = False
        render_to(base + "_wall" + ext, base_w, base_h, transparent=False)
        # Fixture layer @ hi-res: restore fixture, hide catcher(s), transparent film.
        for o in fixture_meshes:
            o.visible_camera = True
        for c in catchers:
            c.visible_camera = False
        render_to(base + "_fixture" + ext, hi_w, hi_h, transparent=True)
        # Fixture (self-light OFF) @ hi-res: lamps/emission + IES killed so it's lit
        # by the room only. The worker diffs it against the full fixture to build an
        # adjustable "Fixture Glow" layer.
        kill_fixture_selflight(fixture_objs)
        if ies_obj is not None:
            ies_obj.hide_render = True
        render_to(base + "_fixturebase" + ext, hi_w, hi_h, transparent=True)
        print("[composite] layers=on (wall + fixture + fixturebase written)")


if __name__ == "__main__":
    main()
