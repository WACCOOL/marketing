# @wac/render-worker

Self-hosted Blender render service (Phase 3 POC of the 3D fixture pipeline).

It renders a product fixture from a WAC studio `.blend` onto a **transparent
background** at a caller-supplied camera pose, so the generator can composite the
real 3D fixture into an AI-generated room (replacing the flat-cutout + 2D-warp
approach).

- Dev: runs on your Mac against a local **Blender 4.5 LTS**.
- Production: the same service deploys to **Modal** on an NVIDIA **L40S** GPU
  (see [Deploy to Modal](#deploy-to-modal-production)); only `RENDER_WORKER_URL`
  changes on the generator side (it sits behind the `ModelRenderAdapter`).

## Prerequisites

- Node 22+, pnpm.
- Blender 4.5 LTS installed. Set `BLENDER_BIN` if it isn't at the macOS default
  `/Applications/Blender.app/Contents/MacOS/Blender`.

## Run

```bash
pnpm --filter @wac/render-worker dev
# -> [render-worker] listening on :8787
```

Environment:

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `8787` | HTTP port |
| `BLENDER_BIN` | macOS app bundle path | Path to the Blender executable |
| `RENDER_TIMEOUT_MS` | `3600000` | Per-render hard cap (60m; Max renders are slow on CPU — raise if needed) |

## API

### `POST /render-fixture`

```jsonc
{
  "modelPath": "/abs/path/to/fixture.blend", // local .blend (POC)
  "sku": "bwsw58618-bk",                       // picks the fixture collection
  "pose": {
    "azimuthDeg": 30,      // orbit around the fixture (0 = front)
    "elevationDeg": 10,    // camera height above the fixture
    "fovDeg": 35,
    "distanceFactor": 1.0, // dolly in/out (1 = auto-framed)
    "marginFactor": 1.25   // framing padding
  },
  "width": 1024,
  "height": 1024,
  "engine": "BLENDER_EEVEE_NEXT", // or "CYCLES" for higher fidelity
  "samples": 64
}
```

Returns `image/png` (RGBA, transparent background) on success, or
`{ ok: false, error }` with a 500 on failure.

`GET /ping` -> `ok`.

## Deploy to Modal (production)

The worker runs unchanged on [Modal](https://modal.com) inside a GPU container
with Blender pinned to **4.5.8 LTS** (matching the CG team's render.st builds).
Cycles auto-selects **OptiX** on the L40S via `enable_gpu()` in
`blender/render.py` — no script changes for the GPU. The container scales to
zero between bursts and autoscales for seasonal spikes, one render per GPU.

```bash
pip install modal
modal token new                                  # one-time auth

modal serve apps/render-worker/modal_app.py       # dev: hot-reload + temp URL
modal deploy apps/render-worker/modal_app.py       # production: stable URL
```

The deployed `*.modal.run` URL becomes `RENDER_WORKER_URL` for the API/generator
(see `apps/api/.dev.vars.example`).

Tunables live in [`modal_app.py`](./modal_app.py): `gpu` (default `L40S`),
`max_containers` (burst headroom), `min_containers` (set to `1` during busy
hours to skip cold starts on fast previews), and `BLENDER_VERSION`.

### Quality + cost gate (before cutover)

Confirm the Modal L40S/OptiX output matches the CG team's render.st reference
and check the per-render cost with the bundled benchmark. Run it from this
package (so `sharp` resolves):

```bash
cd apps/render-worker
node scripts/benchmark.mjs \
  --url https://<workspace>--wac-render-worker-worker.modal.run \
  --endpoint /composite \
  --job ./scripts/sample-job.json \
  --out /tmp/cloud.png \
  --ref /path/to/renderst-reference.png \
  --diff /tmp/diff.png
```

Edit `scripts/sample-job.json` to point `modelUrl`/`roomUrl` at the CG team's
reference assets (publicly fetchable URLs) and their settings (1000 spp,
`finalLongEdge: 4000`, `highQuality: true`). The script prints render time, an
estimated cost, and — with `--ref` — a mean/max pixel diff plus a difference
map. Since it's the same card + OptiX + Blender 4.5.8, expect a near-zero mean
diff; a larger diff points at a denoiser / view-transform / sample mismatch.

### Long renders & timeouts

Modal caps a single HTTP request at 150s and extends it via 303 redirects (~50
min ceiling). A 4000x4000 @ 1000spp final stays well under that on an L40S, and
the generator's `node:http` client follows the 303s automatically
(`apps/generator/src/ai/modelRender.ts`). The timeout ladder
(`RENDER_TIMEOUT_MS` -> `RENDER_FINAL_TIMEOUT_MS` -> `SHOT3D_CONTAINER_TIMEOUT_MS`)
stays as generous safety ceilings; GPU renders finish in minutes, so they rarely
matter, but keep each layer above the one below it.

## Fixture isolation

`blender/render.py` picks the product by:

1. the top-level collection whose name matches the `sku`
   (e.g. `bwsw58618-bk`), else
2. the largest non-rig top-level collection (ignores `Camera` / `Lights` /
   `Studio BG` / `Background` / `Set` / `Environment` / `Floor`).

It then hides every non-fixture mesh, keeps lights + world for illumination,
sets the film transparent, and frames the fixture with our own pose camera (the
file's built-in camera is ignored).
