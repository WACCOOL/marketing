# Blender headless fixture renderer (Phase 3 POC).
#
# Run by the render-worker service as:
#   blender -b <model.blend> -P render.py -- --job <job.json> --out <out.png>
#
# Renders ONLY the product fixture from a WAC studio .blend onto a transparent
# background, viewed from a caller-supplied camera pose. The fixture is isolated
# from the file's studio backdrop so the result can be composited into an AI room
# by the existing generator pipeline. Targets the Blender 4.5 (LTS) Python API.
#
# Fixture isolation strategy (flexible, not hard-coded to one file):
#   1. Prefer the top-level collection whose name matches the requested SKU
#      (e.g. "bwsw58618-bk").
#   2. Fallback: the largest top-level collection that isn't part of the rig
#      (Camera / Lights / Studio BG / Background / Set / Environment / Floor).
#   3. Always: hide every non-fixture MESH, keep lights + world for illumination,
#      set film transparent, and frame the fixture with our own pose camera
#      (the file's own camera is ignored).

import bpy
import sys
import json
import math
import re
from mathutils import Vector


# Top-level collections that are scene rig, never the product itself.
RIG_NAME_HINTS = (
    "camera",
    "cameras",
    "light",
    "lights",
    "lighting",
    "studio bg",
    "studio_bg",
    "background",
    "backdrop",
    "environment",
    "world",
    "set",
    "floor",
    "ground",
)


def parse_args():
    """Read the args after the `--` separator that Blender passes through."""
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("render.py: expected `-- --job <path> --out <path>`")
    extra = argv[argv.index("--") + 1 :]
    job_path = None
    out_path = None
    i = 0
    while i < len(extra):
        if extra[i] == "--job":
            job_path = extra[i + 1]
            i += 2
        elif extra[i] == "--out":
            out_path = extra[i + 1]
            i += 2
        else:
            i += 1
    if not job_path or not out_path:
        raise SystemExit("render.py: missing --job or --out")
    with open(job_path, "r") as f:
        return json.load(f), out_path


def normalize(name):
    """Lowercase, strip non-alphanumerics so 'bwsw58618-bk' ~= 'BWSW58618 BK'."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


def looks_like_rig(coll):
    n = coll.name.lower()
    return any(hint in n for hint in RIG_NAME_HINTS)


def mesh_objects_in(coll):
    """All MESH objects in a collection, recursively through child collections."""
    out = list(o for o in coll.all_objects if o.type == "MESH")
    return out


def make_lightcard(obj):
    """Hide a mesh from the CAMERA but keep it lighting + reflecting in the scene.

    WAC studio files light the product with emissive meshes (the `Studio_BG`
    backdrop / softbox cards). Simply hiding them (hide_render) removes that light
    and the glass/metal goes flat and gray. Instead we drop them from primary
    camera rays only (Cycles ray visibility): they no longer fill the plate (so
    `film_transparent` gives us alpha), but they STILL appear in reflections and
    backlight the crystal through refraction — preserving the CG look on a
    transparent background. EEVEE lacks this, so there we fall back to hiding.
    """
    try:
        obj.visible_camera = False
        obj.visible_shadow = False
    except AttributeError:
        obj.hide_render = True


def pick_fixture_collection(scene, sku):
    """Find the collection holding the product, by SKU match then heuristic."""
    top = list(scene.collection.children)

    # 1. Exact-ish SKU match on a top-level collection.
    if sku:
        target = normalize(sku)
        for coll in top:
            cn = normalize(coll.name)
            if cn == target or cn.startswith(target) or target.startswith(cn):
                if mesh_objects_in(coll):
                    return coll

    # 2. Largest non-rig collection that actually contains meshes.
    candidates = [
        c for c in top if not looks_like_rig(c) and mesh_objects_in(c)
    ]
    if candidates:
        candidates.sort(key=lambda c: len(mesh_objects_in(c)), reverse=True)
        return candidates[0]

    # 3. Last resort: any collection with meshes.
    for coll in top:
        if mesh_objects_in(coll):
            return coll
    return None


def world_bounding_box(objs):
    """Axis-aligned world-space bbox center + radius for a set of objects."""
    mins = Vector((math.inf, math.inf, math.inf))
    maxs = Vector((-math.inf, -math.inf, -math.inf))
    found = False
    for obj in objs:
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            mins.x, mins.y, mins.z = min(mins.x, world.x), min(mins.y, world.y), min(mins.z, world.z)
            maxs.x, maxs.y, maxs.z = max(maxs.x, world.x), max(maxs.y, world.y), max(maxs.z, world.z)
            found = True
    if not found:
        return Vector((0, 0, 0)), 1.0
    center = (mins + maxs) * 0.5
    radius = (maxs - center).length
    return center, max(radius, 1e-4)


def place_camera(scene, center, radius, pose):
    """Create + aim an orbit camera around the fixture from the given pose."""
    az = math.radians(pose.get("azimuthDeg", 0.0))
    el = math.radians(pose.get("elevationDeg", 0.0))
    fov_deg = pose.get("fovDeg", 35.0)
    margin = pose.get("marginFactor", 1.25)

    cam_data = bpy.data.cameras.new("wac_render_cam")
    cam_data.lens_unit = "FOV"
    cam_data.angle = math.radians(fov_deg)
    cam_obj = bpy.data.objects.new("wac_render_cam", cam_data)
    scene.collection.objects.link(cam_obj)

    # Distance so the bounding sphere fits the vertical/horizontal FOV, + margin.
    distance = (radius / math.sin(math.radians(fov_deg) * 0.5)) * margin
    distance *= pose.get("distanceFactor", 1.0)

    # Spherical -> Cartesian (Z up). az around Z, el above the XY plane.
    dir_vec = Vector(
        (
            math.cos(el) * math.sin(az),
            -math.cos(el) * math.cos(az),
            math.sin(el),
        )
    )
    cam_obj.location = center + dir_vec * distance

    # Aim at the fixture center.
    look = (center - cam_obj.location).normalized()
    cam_obj.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()

    scene.camera = cam_obj
    return cam_obj


def available_engines():
    """Engine ids this Blender build actually exposes (varies across versions)."""
    try:
        prop = bpy.types.RenderSettings.bl_rna.properties["engine"]
        return {item.identifier for item in prop.enum_items}
    except Exception:
        return set()


def resolve_engine(requested):
    """Pick a valid engine id: requested if present, else EEVEE (any naming), else Cycles.

    The EEVEE id has changed across releases ('BLENDER_EEVEE' pre-4.2,
    'BLENDER_EEVEE_NEXT' in 4.2-4.x, back to 'BLENDER_EEVEE' in newer builds),
    so we match against what this binary reports instead of hard-coding one.
    """
    engines = available_engines()
    # CYCLES is registered by an addon and is frequently ABSENT from the static
    # bl_rna enum reflection, so an `eng in engines` test wrongly rejects it and
    # falls through to EEVEE. Trust an explicit CYCLES request (assignment works
    # whenever the addon is enabled, which it is for these Cycles files).
    if requested == "CYCLES":
        return "CYCLES"
    candidates = [requested, "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"]
    for eng in candidates:
        if eng and (not engines or eng in engines):
            return eng
    return "CYCLES"


def enable_gpu(scene):
    """Switch Cycles to the machine's GPU. macOS = Metal; otherwise try CUDA/
    OptiX/HIP/oneAPI. Headless Blender defaults to CPU, which is why the studio
    render took ~30 min — the GPU brings it down to seconds. No-op if unavailable.
    """
    if scene.render.engine != "CYCLES":
        return "cpu (non-cycles)"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        chosen = None
        for backend in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                prefs.compute_device_type = backend
            except TypeError:
                continue
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type == backend]
            if gpus:
                chosen = backend
                for d in prefs.devices:
                    # Enable GPUs of this backend; keep CPU off to avoid stalls.
                    d.use = d.type == backend
                break
        if not chosen:
            return "cpu (no gpu found)"
        scene.cycles.device = "GPU"
        return f"gpu:{chosen}"
    except Exception as e:  # pragma: no cover - hardware/version dependent
        return f"cpu (gpu error: {e})"


def configure_render(scene, job):
    # Keep the file's authored engine (WAC studio files are Cycles, tuned for the
    # glass with high transmission bounces + caustics) unless the caller overrides.
    requested = job.get("engine") or scene.render.engine or "CYCLES"
    scene.render.engine = resolve_engine(requested)
    gpu_status = enable_gpu(scene)
    print(f"[render.py] compute={gpu_status}")

    # The VSE often holds a BAKED image strip that would replace our 3D render
    # (so the output never changes with the camera). Disable it. Leave the
    # compositor / view transform (AgX) exactly as authored — that grade is part
    # of the look.
    scene.render.use_sequencer = False

    scene.render.film_transparent = True
    scene.render.resolution_x = int(job.get("width", scene.render.resolution_x))
    scene.render.resolution_y = int(job.get("height", scene.render.resolution_y))
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"

    # `samples` may be missing OR explicitly None (the final-render path leaves it
    # unset so the highQuality default below applies) — `or 0` handles both.
    samples = int(job.get("samples") or 0)
    if scene.render.engine == "CYCLES":
        c = scene.cycles
        c.use_denoising = True
        if job.get("highQuality"):
            # Hero/catalog render: keep the file's gorgeous (slow) caustics.
            c.samples = samples or 200
        else:
            # Placement render (default): the fixture ends up <=~30% of the final
            # image, so refractive caustics (the ~30 min cost) aren't worth it.
            # Disable them but KEEP deep transmission bounces — that carries the
            # bright clear glow through the fluted crystal. ~30 min -> ~9 s on GPU.
            c.samples = samples or 96
            c.caustics_refractive = False
            c.caustics_reflective = True
            c.max_bounces = max(getattr(c, "max_bounces", 12), 24)
            c.transmission_bounces = max(getattr(c, "transmission_bounces", 12), 32)
    elif samples:
        try:
            scene.eevee.taa_render_samples = samples
        except AttributeError:
            pass


def main():
    job, out_path = parse_args()
    scene = bpy.context.scene

    fixture = pick_fixture_collection(scene, job.get("sku"))
    if fixture is None:
        raise SystemExit("render.py: could not locate a fixture collection")

    fixture_meshes = set(mesh_objects_in(fixture))

    # Isolate the product WITHOUT killing the lighting: every non-fixture mesh
    # (studio backdrop / softbox cards / floor) becomes an invisible lightcard —
    # gone from the plate (transparent bg) but still lighting + reflecting in the
    # fixture. Studio lights and the world HDRI are untouched.
    for obj in scene.objects:
        if obj.type == "MESH" and obj not in fixture_meshes:
            make_lightcard(obj)

    # Studio files bind a hero camera per frame via timeline markers, which
    # OVERRIDES scene.camera at render time. Clear them so our camera wins.
    scene.timeline_markers.clear()

    # Camera: either reuse one of the file's tuned hero cameras (cameraName) for
    # a catalog-perfect shot, or build our own orbit camera from a pose to match
    # an arbitrary scene angle.
    cam_name = job.get("cameraName")
    if (
        cam_name
        and cam_name in bpy.data.objects
        and bpy.data.objects[cam_name].type == "CAMERA"
    ):
        cam = bpy.data.objects[cam_name]
        scene.camera = cam
        center, radius = world_bounding_box(fixture_meshes)
    else:
        center, radius = world_bounding_box(fixture_meshes)
        cam = place_camera(scene, center, radius, job.get("pose", {}))

    configure_render(scene, job)

    scene.render.filepath = out_path
    print(f"[render.py] fixture='{fixture.name}' meshes={len(fixture_meshes)} "
          f"center={tuple(round(c, 3) for c in center)} radius={round(radius, 3)}")
    print(f"[render.py] active_cam='{scene.camera.name if scene.camera else None}' "
          f"cam_loc={tuple(round(c, 3) for c in cam.location)} engine={scene.render.engine} "
          f"samples={getattr(scene.cycles, 'samples', '?') if scene.render.engine=='CYCLES' else 'eevee'}")
    bpy.ops.render.render(write_still=True)
    print(f"[render.py] wrote {out_path}")


if __name__ == "__main__":
    main()
