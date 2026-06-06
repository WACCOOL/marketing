# Dev utility: dump a WAC studio .blend's lighting / material / camera / render
# setup so we understand how the CG team achieves their look (and what our
# fixture-isolation must preserve). Run:
#   blender -b <file.blend> -P introspect.py
import bpy

scene = bpy.context.scene
r = scene.render

print("\n=== RENDER ===")
print("engine:", r.engine)
print("use_compositing:", r.use_compositing, "use_sequencer:", r.use_sequencer,
      "use_nodes(scene):", scene.use_nodes)
print("film_transparent:", r.film_transparent)
print("resolution:", r.resolution_x, "x", r.resolution_y, "@", r.resolution_percentage)
try:
    vs = scene.view_settings
    print("view_transform:", vs.view_transform, "look:", vs.look,
          "exposure:", round(vs.exposure, 3), "gamma:", round(vs.gamma, 3))
except Exception as e:
    print("view_settings err:", e)

if hasattr(scene, "cycles"):
    c = scene.cycles
    print("\n=== CYCLES ===")
    for a in ("samples", "preview_samples", "use_denoising", "max_bounces",
              "diffuse_bounces", "glossy_bounces", "transmission_bounces",
              "transparent_max_bounces", "volume_bounces", "caustics_reflective",
              "caustics_refractive"):
        print(" ", a, "=", getattr(c, a, "<n/a>"))

print("\n=== WORLD ===")
w = scene.world
if w:
    print("world:", w.name, "use_nodes:", w.use_nodes)
    if w.use_nodes:
        for n in w.node_tree.nodes:
            extra = ""
            if n.type == "TEX_ENVIRONMENT":
                extra = f" image={getattr(n.image,'name',None)}"
            if n.type == "BACKGROUND":
                col = n.inputs["Color"].default_value
                strength = n.inputs["Strength"].default_value
                extra = f" color=({col[0]:.2f},{col[1]:.2f},{col[2]:.2f}) strength={strength:.2f}"
            print("   node:", n.type, n.name, extra)

print("\n=== COMPOSITOR ===")
try:
    tree = getattr(scene, "node_tree", None) or getattr(scene, "compositing_node_group", None)
    if tree:
        for n in tree.nodes:
            print("   cnode:", n.type, n.name)
    else:
        print("   (no compositor tree)")
except Exception as e:
    print("   compositor err:", e)

print("\n=== COLLECTIONS (top-level) ===")
def count(coll):
    return sum(1 for o in coll.all_objects)
for ch in scene.collection.children:
    types = {}
    for o in ch.all_objects:
        types[o.type] = types.get(o.type, 0) + 1
    print(f"   {ch.name!r}: {types}")

print("\n=== LIGHTS ===")
for o in bpy.data.objects:
    if o.type == "LIGHT":
        d = o.data
        print(f"   {o.name!r} type={d.type} energy={getattr(d,'energy',0)} "
              f"loc=({o.location.x:.2f},{o.location.y:.2f},{o.location.z:.2f}) "
              f"hide_render={o.hide_render}")

print("\n=== EMISSIVE MESHES (softboxes / lightcards) ===")
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    emis = False
    for slot in o.material_slots:
        m = slot.material
        if not m or not m.use_nodes:
            continue
        for n in m.node_tree.nodes:
            if n.type == "EMISSION":
                emis = True
            if n.type == "BSDF_PRINCIPLED":
                try:
                    if n.inputs["Emission Strength"].default_value > 0:
                        emis = True
                except Exception:
                    pass
    if emis:
        print(f"   {o.name!r} loc=({o.location.x:.2f},{o.location.y:.2f},{o.location.z:.2f}) "
              f"hide_render={o.hide_render}")

print("\n=== FIXTURE MATERIALS (transmission/glass?) ===")
seen = set()
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    for slot in o.material_slots:
        m = slot.material
        if not m or m.name in seen or not m.use_nodes:
            continue
        seen.add(m.name)
        for n in m.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                def gv(key):
                    try:
                        return round(float(n.inputs[key].default_value), 3)
                    except Exception:
                        return "<lnk/na>"
                print(f"   mat={m.name!r} transmission={gv('Transmission Weight')} "
                      f"roughness={gv('Roughness')} metallic={gv('Metallic')} ior={gv('IOR')}")
            if n.type == "BSDF_GLASS":
                print(f"   mat={m.name!r} GLASS roughness="
                      f"{round(float(n.inputs['Roughness'].default_value),3)}")

print("\n=== CAMERAS ===")
for o in bpy.data.objects:
    if o.type == "CAMERA":
        print(f"   {o.name!r} loc=({o.location.x:.2f},{o.location.y:.2f},{o.location.z:.2f}) "
              f"lens={o.data.lens:.1f}mm sensor={o.data.sensor_width:.1f}")
print("\n=== MARKERS ===")
for m in scene.timeline_markers:
    print(f"   {m.name!r} frame={m.frame} camera={getattr(m.camera,'name',None)}")
print("\n[introspect] done")
