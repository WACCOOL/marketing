"""Modal deployment of the WAC Blender render-worker.

Runs the EXISTING Node HTTP worker (`apps/render-worker/src/server.ts`)
unchanged inside a GPU container with Blender 4.5.8 LTS, served through Modal's
`web_server`. Cycles auto-selects OptiX on the L40S via `enable_gpu()` in
`blender/render.py` — no Blender script changes are needed for the GPU.

The container scales to zero between bursts and autoscales for seasonal spikes.
Each container handles one render at a time (`@modal.concurrent(max_inputs=1)`),
so concurrent jobs fan out across containers instead of fighting over a GPU.

Setup (one time):
    pip install modal
    modal token new            # authenticates this machine to your workspace

Develop / smoke-test (hot-reloads, gives a temporary URL):
    modal serve apps/render-worker/modal_app.py

Deploy (stable URL):
    modal deploy apps/render-worker/modal_app.py

The deployed web URL is what you set as RENDER_WORKER_URL for the API/generator
(see apps/api/.dev.vars.example). The worker exposes GET /ping, POST
/render-fixture, POST /composite, POST /export-glb.

NOTE ON LONG RENDERS: Modal caps a single HTTP request at 150s and extends it
via 303 redirects (~50 min ceiling). 4000x4000 @ 1000spp finals stay well under
that on an L40S, but the CALLER must follow the 303 redirect — the generator's
node:http client does (see apps/generator/src/ai/modelRender.ts).
"""

from pathlib import Path

import modal

# Pin Blender to the exact version the CG team renders with on render.st, so the
# cloud output matches theirs. Bump here (and redeploy) to upgrade.
BLENDER_VERSION = "4.5.8"
BLENDER_MAJOR_MINOR = ".".join(BLENDER_VERSION.split(".")[:2])  # -> "4.5"
BLENDER_URL = (
    f"https://download.blender.org/release/Blender{BLENDER_MAJOR_MINOR}/"
    f"blender-{BLENDER_VERSION}-linux-x64.tar.xz"
)

# The worker listens here; Modal proxies the public URL to this port.
WORKER_PORT = 8787

# This file lives inside the worker package, so its directory IS the worker.
WORKER_DIR = Path(__file__).parent

image = (
    # CUDA runtime base: Modal injects the NVIDIA driver at runtime, and Blender
    # ships its own Cycles/OptiX libraries, so the runtime image is enough.
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-runtime-ubuntu22.04", add_python="3.11"
    )
    .apt_install(
        "curl",
        "ca-certificates",
        "xz-utils",
        # Shared libraries headless Blender links against on a minimal image.
        "libxrender1",
        "libxxf86vm1",
        "libxfixes3",
        "libxi6",
        "libxkbcommon0",
        "libsm6",
        "libgl1",
        "libglu1-mesa",
        "libxrandr2",
        "libxinerama1",
        "libegl1",
    )
    # Blender 4.5.8 LTS -> /opt/blender/blender
    .run_commands(
        f"curl -fsSL '{BLENDER_URL}' -o /tmp/blender.tar.xz",
        "mkdir -p /opt/blender",
        "tar -xf /tmp/blender.tar.xz -C /opt/blender --strip-components=1",
        "rm /tmp/blender.tar.xz",
        "/opt/blender/blender --version",
    )
    # Node 22 (matches the worker's esbuild target) for the HTTP service.
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
    )
    # Copy the worker sources and build them in-image (esbuild bundle + the
    # linux-x64 sharp native binary). copy=True so the build step below can run
    # against the copied files; ignore host artifacts so we never ship a
    # mac-native node_modules/dist.
    .add_local_dir(
        WORKER_DIR,
        "/app",
        copy=True,
        ignore=["node_modules", "dist", "modal_app.py", "*.pyc", "__pycache__"],
    )
    .run_commands("cd /app && npm install && npm run build")
    .env(
        {
            "BLENDER_BIN": "/opt/blender/blender",
            "PORT": str(WORKER_PORT),
            # Generous Blender hard-cap; GPU finals are minutes, so this only
            # ever fires on a genuine hang.
            "RENDER_TIMEOUT_MS": "3600000",
            # Pin Blender's cache (compiled Cycles/OptiX kernels) under a path we
            # mount as a persistent Volume, so the expensive one-time OptiX kernel
            # COMPILE is reused across cold containers instead of recompiling on
            # every `blender -b` invocation (the bulk of the cold-render time).
            "HOME": "/root",
            "XDG_CACHE_HOME": "/root/.cache",
        }
    )
)

app = modal.App("wac-render-worker", image=image)

# Fixture .blend assets live on a persistent Volume mounted at /fixtures, so the
# worker reads them straight off disk (no per-render download of the ~300MB+
# studio files, and nothing to expire like a presigned URL). Upload with:
#   modal volume put wac-fixtures /local/path.blend /<sku>.blend
FIXTURES_VOLUME = modal.Volume.from_name("wac-fixtures", create_if_missing=True)

# Persists Blender's compiled Cycles/OptiX kernel cache (~/.cache/cycles) across
# containers. The first render ever compiles the OptiX kernels (slow, minutes on a
# complex glass scene); every later render -- even on a fresh cold container --
# reuses the cached kernels and skips that compile.
CYCLES_CACHE_VOLUME = modal.Volume.from_name(
    "wac-cycles-cache", create_if_missing=True
)


@app.function(
    gpu="L40S",  # 48GB Ada: OptiX + headroom for 4000x4000 supersampled passes
    timeout=3600,  # max wall-clock per container run (separate from the web cap)
    scaledown_window=600,  # stay warm 10 min after a render so a working session reuses the container
    min_containers=0,  # scale to zero between bursts (no idle cost)
    max_containers=10,  # seasonal-burst headroom; raise if finals queue up
    volumes={
        "/fixtures": FIXTURES_VOLUME,  # studio .blend fixtures (read off disk)
        "/root/.cache": CYCLES_CACHE_VOLUME,  # persisted OptiX kernel cache
    },
)
@modal.concurrent(max_inputs=1)  # one render per container -> bursts fan out, not contend
@modal.web_server(WORKER_PORT, startup_timeout=120)
def worker():
    """Launch the unchanged Node worker; Modal proxies the public URL to it."""
    import subprocess

    subprocess.Popen(["node", "/app/dist/server.js"])
