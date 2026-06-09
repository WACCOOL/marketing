import { POSE_DEFAULTS, type FixtureMount } from "@wac/shared";
import { FixtureScene } from "./lib/fixtureScene.js";

/**
 * Offscreen render harness for baking fixture picker thumbnails offline (see
 * apps/fixture-sync). Playwright loads this single-file page, hands it a GLB as
 * base64, and reads back a PNG data URL — reusing `FixtureScene` so the baked
 * still matches the live editor's framing exactly (same pose math, lighting,
 * Draco decode). NOT part of the SPA: built standalone to `dist-harness/` via
 * `vite.harness.config.ts`, so it never ships to production.
 *
 * The frame uses the fixture's mount default pose at the same coverage the
 * old per-tile `Glb3dThumb` used, so the cheap pre-baked thumbnail looks like
 * the 3D form preview it replaces.
 */
declare global {
  interface Window {
    /** Set once the render function is installed (Playwright waits on this). */
    __thumbHarnessReady?: boolean;
    /** Render a GLB (base64) to a square PNG data URL at the mount's pose. */
    renderFixtureThumb?: (
      glbBase64: string,
      mount: FixtureMount,
      size: number,
    ) => Promise<string>;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

window.renderFixtureThumb = async (glbBase64, mount, size) => {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  // preserveDrawingBuffer so toDataURL() can read the frame after render.
  const scene = new FixtureScene(canvas, { preserveDrawingBuffer: true });
  scene.setSize(size, size);

  const blob = new Blob([base64ToBytes(glbBase64).buffer as ArrayBuffer], {
    type: "model/gltf-binary",
  });
  const url = URL.createObjectURL(blob);
  try {
    const dims = await scene.loadModel(url);
    if (!dims) throw new Error("GLB failed to load");
    const pose = POSE_DEFAULTS[mount];
    scene.update({
      pose: {
        azimuthDeg: pose.azimuthDeg,
        elevationDeg: pose.elevationDeg,
        fovDeg: pose.fovDeg,
        distanceFactor: 1,
      },
      coverage: 0.82,
      xPct: 0.5,
      yPct: 0.5,
      aspect: 1,
    });
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
    scene.dispose();
  }
};

window.__thumbHarnessReady = true;
