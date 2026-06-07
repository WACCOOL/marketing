import { fetchWithTimeout } from "./adapter.js";
import type {
  CompositeAdapter,
  CompositeRenderRequest,
  CompositeResult,
  ExportGlbRequest,
  ModelRenderAdapter,
  ModelRenderRequest,
} from "./adapter.js";

/**
 * Model-render adapter (Phase 3): calls the self-hosted render-worker
 * (`POST /render-fixture`) to render a real 3D fixture (.blend/.glb) onto a
 * transparent background at a caller-supplied camera pose. The returned PNG
 * becomes the fixture cutout, which then flows through the existing scale /
 * composite / harmonize pipeline unchanged.
 *
 * The worker runs locally for the POC and on the GPU box in production; only
 * RENDER_WORKER_URL changes here. Kept behind the adapter so the transport is
 * swappable (e.g. Modal) without touching the pipeline.
 */
export interface ModelRenderConfig {
  /** Base URL of the render-worker, e.g. http://localhost:8787 */
  url: string;
  /** Per-render timeout; Blender renders can take a while at high res. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
// A final composite (layered PSD, full-res Cycles) can take many minutes on a
// complex fixture at the High/Max tiers; a preview is fast. The final cap sits
// ABOVE the worker's own Blender hard-cap (900s) so the worker's clean "render
// timed out" surfaces instead of an opaque fetch abort.
const COMPOSITE_FINAL_TIMEOUT_MS = 960_000;
const COMPOSITE_PREVIEW_TIMEOUT_MS = 90_000;

export function makeModelRenderAdapter(
  config: ModelRenderConfig,
): ModelRenderAdapter & CompositeAdapter {
  const base = config.url.replace(/\/$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    provider: "render-worker",
    async composite(req: CompositeRenderRequest): Promise<CompositeResult> {
      const t =
        req.timeoutMs ??
        (req.preview ? COMPOSITE_PREVIEW_TIMEOUT_MS : COMPOSITE_FINAL_TIMEOUT_MS);
      const res = await fetchWithTimeout(
        "render-worker /composite",
        `${base}/composite`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelUrl: req.modelUrl,
            modelPath: req.modelPath,
            sku: req.sku,
            roomUrl: req.roomUrl,
            roomPath: req.roomPath,
            iesUrl: req.iesUrl,
            iesPath: req.iesPath,
            iesRotation: req.iesRotation,
            pose: req.pose,
            cameraName: req.cameraName,
            coverage: req.coverage,
            xPct: req.xPct,
            yPct: req.yPct,
            brightness: req.brightness,
            lightOutput: req.lightOutput,
            warm: req.warm,
            samples: req.samples,
            highQuality: req.highQuality,
            layers: req.layers,
            preview: req.preview,
            previewMaxPx: req.previewMaxPx,
            supersample: req.supersample,
            finalLongEdge: req.finalLongEdge,
          }),
        },
        t,
      );
      if (!res.ok) {
        let detail = `${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          // keep the status code
        }
        throw new Error(`render-worker composite failed: ${detail}`);
      }
      const body = (await res.json()) as {
        ok?: boolean;
        png?: string;
        avif?: string;
        psd?: string;
        error?: string;
      };
      if (!body.ok || !body.png) {
        throw new Error(`render-worker composite failed: ${body.error ?? "no image"}`);
      }
      return {
        png: Buffer.from(body.png, "base64"),
        avif: body.avif ? Buffer.from(body.avif, "base64") : undefined,
        psd: body.psd ? Buffer.from(body.psd, "base64") : undefined,
      };
    },
    async render(req: ModelRenderRequest): Promise<Buffer> {
      const res = await fetchWithTimeout(
        "render-worker /render-fixture",
        `${base}/render-fixture`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelUrl: req.modelUrl,
            modelPath: req.modelPath,
            sku: req.sku,
            pose: req.pose,
            width: req.width,
            height: req.height,
            engine: req.engine,
            samples: req.samples,
            highQuality: req.highQuality,
            lightsOn: req.lightsOn,
          }),
        },
        req.timeoutMs ?? timeoutMs,
      );

      if (!res.ok) {
        let detail = `${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          // non-JSON error body; keep the status code
        }
        throw new Error(`render-worker render failed: ${detail}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0) {
        throw new Error("render-worker returned an empty image");
      }
      return buf;
    },
    async exportGlb(req: ExportGlbRequest): Promise<Buffer> {
      const res = await fetchWithTimeout(
        "render-worker /export-glb",
        `${base}/export-glb`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelUrl: req.modelUrl,
            modelPath: req.modelPath,
            sku: req.sku,
          }),
        },
        timeoutMs,
      );
      if (!res.ok) {
        let detail = `${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          // non-JSON error body; keep the status code
        }
        throw new Error(`render-worker export-glb failed: ${detail}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0) {
        throw new Error("render-worker returned an empty GLB");
      }
      return buf;
    },
  };
}
