# Blender headless fixture -> GLB exporter (3D-viewer placement path).
#
# Run by the render-worker service as:
#   blender -b <model.blend> -P export_fixture.py -- --job <job.json> --out <out.glb>
#
# Exports ONLY the product fixture (no studio rig, no inner lamp emitters) to a
# GLB so the web <model-viewer> can show the real 3D fixture for interactive
# placement. The fixture collection is picked the SAME way render.py picks it
# (SKU match, then heuristic) so the GLB and the Blender render agree on what the
# "fixture" is. Material node-groups (crystal/metal) are translated to Principled
# BSDFs the glTF exporter understands. Ported from the WAC Group Website's
# _tools/export_fixture.py (material logic) with render.py's collection picker.

import bpy
import sys
import json
import math
import re

# Sub-collections inside the fixture collection that should NOT be exported
# (the LED emitters / lamp rig that render.py also strips).
EXCLUDE_SUBCOLLECTIONS = {"lights"}

# Object types worth exporting as geometry.
RENDERABLE_TYPES = {"MESH", "CURVE", "SURFACE", "FONT", "META"}

# Top-level collections that are scene rig, never the product itself
# (mirrors render.py's RIG_NAME_HINTS).
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
    """Read the args after the `--` separator (matches render.py's contract)."""
    argv = sys.argv
    if "--" not in argv:
        raise SystemExit("export_fixture.py: expected `-- --job <path> --out <path>`")
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
        raise SystemExit("export_fixture.py: missing --job or --out")
    with open(job_path, "r") as f:
        return json.load(f), out_path


def normalize(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def looks_like_rig(coll):
    n = coll.name.lower()
    return any(hint in n for hint in RIG_NAME_HINTS)


def mesh_objects_in(coll):
    return list(o for o in coll.all_objects if o.type == "MESH")


def pick_fixture_collection(scene, sku):
    """Find the collection holding the product, by SKU match then heuristic.

    Identical strategy to render.py's pick_fixture_collection so the exported GLB
    is the same fixture the render isolates.
    """
    top = list(scene.collection.children)

    if sku:
        target = normalize(sku)
        for coll in top:
            cn = normalize(coll.name)
            if cn == target or cn.startswith(target) or target.startswith(cn):
                if mesh_objects_in(coll):
                    return coll

    candidates = [c for c in top if not looks_like_rig(c) and mesh_objects_in(c)]
    if candidates:
        candidates.sort(key=lambda c: len(mesh_objects_in(c)), reverse=True)
        return candidates[0]

    for coll in top:
        if mesh_objects_in(coll):
            return coll
    return None


def kelvin_to_rgb(kelvin):
    """Approximate a black-body color (Tanner Helland) normalized to 0..1."""
    t = max(1000.0, min(40000.0, kelvin)) / 100.0
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
    else:
        r = 329.698727446 * ((t - 60) ** -0.1332047592)
        g = 288.1221695283 * ((t - 60) ** -0.0755148492)
    if t >= 66:
        b = 255.0
    elif t <= 19:
        b = 0.0
    else:
        b = 138.5177312231 * math.log(t - 10) - 305.0447927307

    def clamp01(v):
        return max(0.0, min(1.0, v / 255.0))

    return (clamp01(r), clamp01(g), clamp01(b))


def materialize_for_gltf(materials):
    """Replace shader node-groups / Metallic BSDF surfaces with a Principled
    BSDF the glTF exporter understands, derived from the group's own exposed
    inputs. Blender's glTF exporter only translates a Principled BSDF wired
    directly to the material output; anything else exports as flat white metal.
    """
    color_keys = ("Base Color", "Metal Color", "Crystal Color", "Color")

    for mat in materials:
        if not mat.use_nodes or mat.node_tree is None:
            continue
        nt = mat.node_tree
        out = next((n for n in nt.nodes
                    if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
        if out is None or not out.inputs["Surface"].links:
            continue
        surf = out.inputs["Surface"].links[0].from_node
        if surf.type == "BSDF_PRINCIPLED":
            continue  # already exporter-friendly

        group_name = (surf.node_tree.name if surf.type == "GROUP" and surf.node_tree else "").upper()
        is_crystal_group = any(k in group_name for k in ("CRYSTAL", "GLASS", "OPTIC"))
        if is_crystal_group:
            bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
            bsdf.inputs["Base Color"].default_value = (0.95, 0.96, 1.0, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.03
            bsdf.inputs["Metallic"].default_value = 0.0
            if "IOR" in bsdf.inputs:
                bsdf.inputs["IOR"].default_value = 1.45
            if "Transmission Weight" in bsdf.inputs:
                bsdf.inputs["Transmission Weight"].default_value = 0.9
            nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
            print(f"  Materialized '{mat.name}': crystal/glass (group '{surf.node_tree.name}')")
            continue

        inputs = {i.name: i for i in surf.inputs}

        def value(name):
            i = inputs.get(name)
            if i is not None and not i.links and hasattr(i, "default_value"):
                return i.default_value
            return None

        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")

        base = next((value(k) for k in color_keys if value(k) is not None), None)
        if base is not None:
            bsdf.inputs["Base Color"].default_value = (base[0], base[1], base[2], 1.0)

        rough = value("Roughness")
        if rough is not None and not hasattr(rough, "__len__"):
            rough = float(rough)
            rough = 0.5 if rough > 1.0 else max(0.0, rough)
        else:
            rough = 0.5
        bsdf.inputs["Roughness"].default_value = rough

        metalic = value("Metalic")
        if metalic is None:
            metalic = value("Metallic")
        if surf.type == "BSDF_METALLIC":
            metallic = 1.0
        elif metalic is not None and not hasattr(metalic, "__len__"):
            metallic = max(0.0, min(1.0, float(metalic)))
        else:
            brightest = max(base[:3]) if base is not None else 0.8
            metallic = 1.0 if brightest < 0.5 else 0.0

        ior = value("IOR")
        if ior is not None and not hasattr(ior, "__len__"):
            try:
                bsdf.inputs["IOR"].default_value = float(ior)
            except (TypeError, ValueError):
                pass

        emission_strength = value("Emission Strength")
        is_glass = value("Crystal Color") is not None and emission_strength is None

        if emission_strength is not None:
            kelvin = value("Light Temperature") or value("Color Temperature") or 4000.0
            col = kelvin_to_rgb(float(kelvin))
            bsdf.inputs["Emission Color"].default_value = (col[0], col[1], col[2], 1.0)
            bsdf.inputs["Emission Strength"].default_value = 2.0
            bsdf.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1.0)
            metallic = 0.0

        if is_glass:
            if "Transmission Weight" in bsdf.inputs:
                bsdf.inputs["Transmission Weight"].default_value = 1.0
            bsdf.inputs["Roughness"].default_value = min(0.1, rough)
            metallic = 0.0

        bsdf.inputs["Metallic"].default_value = metallic
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        print(f"  Materialized '{mat.name}'")


def find_upstream(socket, node_types, max_depth=10):
    frontier = [(l.from_node, 0) for l in socket.links]
    seen = set()
    while frontier:
        node, depth = frontier.pop(0)
        if node.as_pointer() in seen or depth > max_depth:
            continue
        seen.add(node.as_pointer())
        if node.type in node_types:
            return node
        for inp in node.inputs:
            for link in inp.links:
                frontier.append((link.from_node, depth + 1))
    return None


def neutralize_desaturated_metals(materials):
    """Flatten a strongly-desaturating Hue/Sat node feeding Base Color to a neutral
    silver so the real-time model isn't warm/brass when the render is silver."""
    for mat in materials:
        if not mat.use_nodes or mat.node_tree is None:
            continue
        nt = mat.node_tree
        out = next((n for n in nt.nodes
                    if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
        if out is None or not out.inputs["Surface"].links:
            continue
        surf = out.inputs["Surface"].links[0].from_node
        if surf.type != "BSDF_PRINCIPLED":
            continue
        bc = surf.inputs.get("Base Color")
        if bc is None or not bc.links:
            continue
        hue = find_upstream(bc, {"HUE_SAT"})
        if hue is None:
            continue
        sat_in = hue.inputs.get("Saturation")
        val_in = hue.inputs.get("Value")
        sat = sat_in.default_value if sat_in and not sat_in.links else 1.0
        val = val_in.default_value if val_in and not val_in.links else 1.0
        if sat > 0.2:
            continue
        for link in list(bc.links):
            nt.links.remove(link)
        level = max(0.4, min(0.65, 0.4 * float(val)))
        bc.default_value = (level, level * 1.01, level * 1.03, 1.0)
        print(f"  Neutralized metal '{mat.name}'")


def downscale_textures(max_px):
    """Shrink embedded images so the GLB (a lightweight placement proxy) doesn't
    carry 4K product textures — those alone can balloon the file to 100MB+."""
    for img in list(bpy.data.images):
        try:
            w, h = img.size
            if not img.has_data or w == 0 or h == 0 or max(w, h) <= max_px:
                continue
            s = max_px / float(max(w, h))
            img.scale(max(1, int(w * s)), max(1, int(h * s)))
            print(f"  Downscaled image '{img.name}' {w}x{h} -> {img.size[0]}x{img.size[1]}")
        except Exception as e:
            print(f"  tex downscale skip '{img.name}': {e}")


def decimate_heavy_meshes(objs, ratio, min_polys):
    """Add a Collapse decimate modifier to high-poly meshes (the crystal arrays are
    millions of tris). The GLB is only used to position/orbit the fixture, so a
    decimated proxy is fine — the final render still uses the real .blend."""
    if ratio >= 1.0:
        return
    for o in objs:
        if o.type != "MESH" or len(o.data.polygons) < min_polys:
            continue
        m = o.modifiers.new("wac_decimate", "DECIMATE")
        m.decimate_type = "COLLAPSE"
        m.ratio = ratio


def gather_objects(coll, excluded):
    """Recursively collect objects, skipping excluded sub-collections."""
    objects = list(coll.objects)
    for child in coll.children:
        if child.name.lower() in excluded:
            print(f"  Skipping sub-collection: '{child.name}'")
            continue
        objects.extend(gather_objects(child, excluded))
    return objects


def main():
    job, out_path = parse_args()
    scene = bpy.context.scene
    sku = job.get("sku")

    fixture = pick_fixture_collection(scene, sku)
    if fixture is None:
        raise SystemExit("export_fixture.py: could not locate a fixture collection")
    print(f"export_fixture: fixture collection = '{fixture.name}'")

    bpy.ops.object.select_all(action="DESELECT")

    selected = []
    for obj in gather_objects(fixture, EXCLUDE_SUBCOLLECTIONS):
        if obj.type not in RENDERABLE_TYPES:
            continue
        obj.hide_viewport = False
        obj.hide_render = False
        try:
            obj.hide_set(False)
        except RuntimeError:
            pass
        try:
            obj.select_set(True)
        except RuntimeError:
            print(f"  Warning: could not select '{obj.name}'")
            continue
        selected.append(obj)

    if not selected:
        raise SystemExit(f"export_fixture.py: no renderable objects in '{fixture.name}'")

    bpy.context.view_layer.objects.active = selected[0]

    mats = {slot.material for obj in selected for slot in obj.material_slots if slot.material}
    print("Translating materials for glTF...")
    materialize_for_gltf(mats)
    neutralize_desaturated_metals(mats)

    # Keep the proxy small: it's only for interactive placement, not final pixels.
    downscale_textures(int(job.get("maxTexture", 1024)))
    decimate_heavy_meshes(
        selected,
        float(job.get("decimateRatio", 0.25)),
        int(job.get("decimateMinPolys", 2000)),
    )

    print(f"Exporting {len(selected)} object(s) -> {out_path}")
    export_kwargs = dict(
        filepath=out_path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_materials="EXPORT",
        export_extras=False,
    )
    # Draco geometry compression (huge win for the crystal arrays). Guarded so an
    # older Blender without these kwargs still exports (just larger).
    if job.get("draco", True):
        export_kwargs.update(
            export_draco_mesh_compression_enable=True,
            export_draco_mesh_compression_level=6,
            export_draco_position_quantization=12,
            export_draco_normal_quantization=10,
            export_draco_texcoord_quantization=12,
        )
    try:
        bpy.ops.export_scene.gltf(**export_kwargs)
    except TypeError as e:
        print(f"  Draco kwargs unsupported ({e}); retrying without compression")
        for k in list(export_kwargs):
            if k.startswith("export_draco"):
                export_kwargs.pop(k)
        bpy.ops.export_scene.gltf(**export_kwargs)
    print("export_fixture: done.")


if __name__ == "__main__":
    main()
