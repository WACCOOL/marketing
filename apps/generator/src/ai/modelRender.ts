import http from "node:http";
import https from "node:https";
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
 *
 * TRANSPORT: these calls deliberately use node:http instead of global `fetch`.
 * The worker buffers a whole render and only sends the HTTP response when
 * Blender finishes, so a Max-tier render can leave the connection idle for many
 * minutes. Node's global fetch (undici) imposes a hidden ~5-minute
 * headersTimeout/bodyTimeout that fires before our AbortSignal and surfaces as a
 * bare "fetch failed" — and `setGlobalDispatcher` from the npm `undici` does not
 * affect the built-in fetch. node:http has no such default, so the only bound is
 * our explicit idle timeout below (a true hang guard, sized above the worker cap).
 */

interface WorkerResponse {
  ok: boolean;
  status: number;
  buffer: Buffer;
}

/**
 * POST to the render-worker over node:http with no hidden response timeout. The
 * `timeoutMs` is a socket-inactivity guard: while Blender renders, the socket is
 * idle, so this effectively bounds the total wait without undici's 5-min cap.
 */
function workerRequest(
  label: string,
  urlStr: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`${label}: invalid url ${urlStr}`));
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: init.method ?? "GET", headers: init.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, buffer: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`${label} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}
export interface ModelRenderConfig {
  /** Base URL of the render-worker, e.g. http://localhost:8787 */
  url: string;
  /** Per-render timeout; Blender renders can take a while at high res. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
// A final composite (layered PSD, full-res Cycles) can take well over an hour on
// a complex fixture at the High/Max tiers on a CPU box; a preview is fast. The
// final cap sits ABOVE the worker's own Blender hard-cap (default 60m) so the
// worker's clean "render timed out" surfaces instead of an opaque fetch abort.
// Env-overridable (keep RENDER_FINAL_TIMEOUT_MS > the worker's RENDER_TIMEOUT_MS).
export const RENDER_FINAL_TIMEOUT_MS = Number(
  process.env.RENDER_FINAL_TIMEOUT_MS ?? 3_900_000,
);
const COMPOSITE_FINAL_TIMEOUT_MS = RENDER_FINAL_TIMEOUT_MS;
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
      const res = await workerRequest(
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
          const body = JSON.parse(res.buffer.toString("utf8")) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          // keep the status code
        }
        throw new Error(`render-worker composite failed: ${detail}`);
      }
      const body = JSON.parse(res.buffer.toString("utf8")) as {
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
      const res = await workerRequest(
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
          const body = JSON.parse(res.buffer.toString("utf8")) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          // non-JSON error body; keep the status code
        }
        throw new Error(`render-worker render failed: ${detail}`);
      }

      if (res.buffer.byteLength === 0) {
        throw new Error("render-worker returned an empty image");
      }
      return res.buffer;
    },
    async exportGlb(req: ExportGlbRequest): Promise<Buffer> {
      const res = await workerRequest(
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
          const body = JSON.parse(res.buffer.toString("utf8")) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          // non-JSON error body; keep the status code
        }
        throw new Error(`render-worker export-glb failed: ${detail}`);
      }
      if (res.buffer.byteLength === 0) {
        throw new Error("render-worker returned an empty GLB");
      }
      return res.buffer;
    },
  };
}
