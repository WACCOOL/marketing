# @wac/render-worker

Self-hosted Blender render service (Phase 3 POC of the 3D fixture pipeline).

It renders a product fixture from a WAC studio `.blend` onto a **transparent
background** at a caller-supplied camera pose, so the generator can composite the
real 3D fixture into an AI-generated room (replacing the flat-cutout + 2D-warp
approach).

- POC: runs on your Mac against a local **Blender 4.5 LTS**.
- Production: the same service deploys to the GPU box; only `RENDER_WORKER_URL`
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

## Fixture isolation

`blender/render.py` picks the product by:

1. the top-level collection whose name matches the `sku`
   (e.g. `bwsw58618-bk`), else
2. the largest non-rig top-level collection (ignores `Camera` / `Lights` /
   `Studio BG` / `Background` / `Set` / `Environment` / `Floor`).

It then hides every non-fixture mesh, keeps lights + world for illumination,
sets the film transparent, and frames the fixture with our own pose camera (the
file's built-in camera is ignored).
