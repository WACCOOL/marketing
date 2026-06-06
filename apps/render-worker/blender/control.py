# Control render: the file EXACTLY as authored (native hero camera via the
# frame-1 marker, full studio lighting, Studio_BG visible, no isolation), with
# only the baked VSE strip disabled so we see the real 3D render. Used to
# benchmark our isolated render against the CG team's look.
import bpy
import time


def enable_gpu(scene):
    if scene.render.engine != "CYCLES":
        return "cpu"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue
        prefs.get_devices()
        if [d for d in prefs.devices if d.type == backend]:
            for d in prefs.devices:
                d.use = d.type == backend
            scene.cycles.device = "GPU"
            return f"gpu:{backend}"
    return "cpu (no gpu)"


s = bpy.context.scene
s.render.use_sequencer = False
s.frame_set(1)  # marker F_01 binds Cam.001
status = enable_gpu(s)
s.cycles.samples = 96
s.cycles.use_denoising = True
# Refractive caustics are the real cost. Disable them, but KEEP deep transmission
# bounces — that's what carries the bright clear glow through the fluted crystal.
s.cycles.caustics_refractive = False
s.cycles.caustics_reflective = True
s.cycles.max_bounces = 24
s.cycles.transmission_bounces = 32
s.render.resolution_percentage = 100
s.render.resolution_x = 700
s.render.resolution_y = 900
s.render.image_settings.file_format = "PNG"
s.render.filepath = "/tmp/control.png"
print(f"[control] cam={s.camera.name if s.camera else None} engine={s.render.engine} "
      f"compute={status} samples={s.cycles.samples} res={s.render.resolution_x}x{s.render.resolution_y}")
t0 = time.time()
bpy.ops.render.render(write_still=True)
print(f"[control] wrote /tmp/control.png in {time.time()-t0:.1f}s")
