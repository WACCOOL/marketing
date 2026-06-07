import { Hono } from "hono";
import {
  APPIMAGE_PARAMS_VERSION,
  AppShotComposeRequestSchema,
  AppShotFinalizeRequestSchema,
  AppShotPreviewRequestSchema,
} from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { generatorFetch } from "../generatorClient.js";
import { createGenerationJob } from "../generation.js";
import { publicOrigin } from "../publicUrl.js";
import { userSupabase } from "../supabase.js";

/**
 * 3D app-shot API (Phase C).
 *
 * The web UI flow:
 *   1. GET  /fixtures            list the POC fixtures the picker can choose.
 *   2. POST /compose             auto-place + hidden AI critic loop → preview URL
 *                                + the placement the sliders bind to.
 *   3. POST /preview             one render of the EXACT slider placement (no AI)
 *                                → preview URL. Drives the responsive live loop.
 *   4. POST /finalize            enqueue a full-quality layered render as a
 *                                library asset (PNG + AVIF + PSD); UI polls
 *                                /api/jobs/:id then downloads via /api/assets.
 *
 * compose/preview are synchronous proxies to the generation Container (the
 * Container in turn calls the Blender render-worker). finalize is async because a
 * full-quality layered render can take minutes on large .blend files — far longer
 * than a single HTTP request should hold open.
 */
export const appShotRoutes = new Hono<AppBindings>();

// Auto-place runs a few preview renders + Gemini critiques; a single preview is
// faster but still pays Blender's per-call cost. Give both generous headroom.
const COMPOSE_TIMEOUT_MS = 180_000;
const PREVIEW_TIMEOUT_MS = 120_000;

/**
 * POC fixture catalog (mirrors the generator's hardcoded FIXTURE_MAP). The web
 * picker reads this; production will swap it for the Monday.com / Lucid lookup.
 */
const POC_FIXTURES = [
  { sku: "bwsw58618-bk", fixtureType: "wall sconce", mount: "wall" },
  { sku: "ma1012n-48o", fixtureType: "chandelier", mount: "ceiling" },
] as const;

interface ComposeContainerResponse {
  ok?: boolean;
  error?: string;
  previewPng?: string;
  placement?: unknown;
  sku?: string;
  fixtureType?: string;
  mount?: string;
  iterations?: number;
  approved?: boolean;
}

/** Decode a base64 string into raw bytes without depending on node Buffer. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decode a base64 preview, store it under uploads/, and return its public URL. */
async function storePreview(
  c: import("hono").Context<AppBindings>,
  userId: string,
  base64: string,
): Promise<string> {
  const bytes = base64ToBytes(base64);
  const file = `${crypto.randomUUID()}.png`;
  const key = `uploads/${userId}/${file}`;
  await c.env.ASSETS_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: "image/png" },
  });
  return `${publicOrigin(c)}/api/uploads/${userId}/${file}`;
}

/** Read a Container JSON error body into a single message string. */
async function containerError(res: Response, fallback: string): Promise<string> {
  const detail = await res.text().catch(() => "");
  try {
    const j = JSON.parse(detail) as { error?: string };
    if (j.error) return j.error;
  } catch {
    // not JSON — fall through
  }
  return detail || fallback;
}

/** The two compose-style endpoints share the same Container proxy shape. */
async function composeProxy(
  c: import("hono").Context<AppBindings>,
  userId: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<ComposeContainerResponse | { __error: string; status: number }> {
  let res: Response;
  try {
    res = await generatorFetch(c.env, `shot:${userId}`, "/compose-3d", {
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { __error: `render failed: ${msg}`, status: 502 };
  }
  if (!res.ok) {
    return { __error: await containerError(res, `render failed (${res.status})`), status: 502 };
  }
  return (await res.json()) as ComposeContainerResponse;
}

appShotRoutes.get("/fixtures", requireAuth, (c) => {
  return c.json({ fixtures: POC_FIXTURES });
});

// Room analysis is a single vision call; the cutout is one fast Blender render.
const PLACE_TIMEOUT_MS = 45_000;
const CUTOUT_TIMEOUT_MS = 120_000;

interface PlaceContainerResponse {
  ok?: boolean;
  error?: string;
  placement?: unknown;
  fixtureType?: string;
  mount?: string;
}

/**
 * Fast AI placement: read the bare room (vision only, no render) and return the
 * starting placement + fixture meta. The web UI then renders the cutout once and
 * lets the user drag/scale instantly.
 */
appShotRoutes.post("/place", requireAuth, async (c) => {
  if (!c.env.RENDER_WORKER_URL) {
    return c.json(
      { error: "3D app-shots are not configured (set RENDER_WORKER_URL)" },
      400,
    );
  }
  const raw = (await c.req.json().catch(() => null)) as {
    sku?: unknown;
    sceneUrl?: unknown;
  } | null;
  if (!raw || typeof raw.sku !== "string" || typeof raw.sceneUrl !== "string") {
    return c.json({ error: "place needs a sku and sceneUrl" }, 400);
  }
  const user = c.get("user");
  let res: Response;
  try {
    res = await generatorFetch(c.env, `shot:${user.id}`, "/autoplace-3d", {
      method: "POST",
      body: JSON.stringify({ sku: raw.sku, roomUrl: raw.sceneUrl }),
      signal: AbortSignal.timeout(PLACE_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `placement failed: ${msg}` }, 502);
  }
  if (!res.ok) {
    return c.json({ error: await containerError(res, `placement failed (${res.status})`) }, 502);
  }
  const out = (await res.json()) as PlaceContainerResponse;
  if (!out.ok || !out.placement) {
    return c.json({ error: out.error ?? "placement returned nothing" }, 502);
  }
  return c.json({
    placement: out.placement,
    fixtureType: out.fixtureType,
    mount: out.mount,
  });
});

interface CutoutContainerResponse {
  ok?: boolean;
  error?: string;
  png?: string;
  coverageRef?: number;
  width?: number;
  height?: number;
}

/**
 * Render a transparent, full-frame fixture cutout for the interactive overlay.
 * One render per camera pose; the web UI then positions + scales it client-side
 * (instant), and those transforms map 1:1 onto the composite's xPct/yPct/coverage
 * for the Test/Final render.
 */
appShotRoutes.post("/cutout", requireAuth, async (c) => {
  if (!c.env.RENDER_WORKER_URL) {
    return c.json(
      { error: "3D app-shots are not configured (set RENDER_WORKER_URL)" },
      400,
    );
  }
  const raw = (await c.req.json().catch(() => null)) as {
    sku?: unknown;
    pose?: unknown;
    coverageRef?: unknown;
    width?: unknown;
    height?: unknown;
  } | null;
  if (!raw || typeof raw.sku !== "string") {
    return c.json({ error: "cutout needs a sku" }, 400);
  }

  const user = c.get("user");
  let res: Response;
  try {
    res = await generatorFetch(c.env, `shot:${user.id}`, "/cutout-3d", {
      method: "POST",
      body: JSON.stringify({
        sku: raw.sku,
        pose: raw.pose,
        coverageRef: typeof raw.coverageRef === "number" ? raw.coverageRef : undefined,
        width: typeof raw.width === "number" ? raw.width : undefined,
        height: typeof raw.height === "number" ? raw.height : undefined,
      }),
      signal: AbortSignal.timeout(CUTOUT_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `cutout render failed: ${msg}` }, 502);
  }
  if (!res.ok) {
    return c.json({ error: await containerError(res, `cutout failed (${res.status})`) }, 502);
  }
  const out = (await res.json()) as CutoutContainerResponse;
  if (!out.ok || !out.png) {
    return c.json({ error: out.error ?? "cutout returned no image" }, 502);
  }
  const cutoutUrl = await storePreview(c, user.id, out.png);
  return c.json({
    cutoutUrl,
    coverageRef: out.coverageRef ?? 0.5,
    width: out.width ?? 0,
    height: out.height ?? 0,
  });
});

// Exporting a fixture GLB is a one-time Blender export per SKU (then R2-cached).
const GLB_TIMEOUT_MS = 180_000;

/**
 * Fixture GLB for the web 3D viewer. Cached per SKU in R2 (generate-once); the
 * GLB is product geometry, not user data, so it's shared across users. Returns a
 * public URL that <model-viewer> can fetch directly.
 */
appShotRoutes.post("/glb", requireAuth, async (c) => {
  if (!c.env.RENDER_WORKER_URL) {
    return c.json(
      { error: "3D app-shots are not configured (set RENDER_WORKER_URL)" },
      400,
    );
  }
  const raw = (await c.req.json().catch(() => null)) as { sku?: unknown } | null;
  if (!raw || typeof raw.sku !== "string") {
    return c.json({ error: "glb needs a sku" }, 400);
  }
  const sku = raw.sku.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!sku) return c.json({ error: "invalid sku" }, 400);

  const key = `appshot/glb/${sku}.glb`;
  // Relative URL on purpose: <model-viewer> fetches this from the browser, so a
  // same-origin path works both in prod and in local dev (through the Vite
  // proxy). An absolute publicOrigin URL points at the prod host in local dev
  // and can't be loaded from localhost.
  const fileUrl = `/api/appshot/glb-file/${sku}.glb`;

  // Cached? Serve the existing object's URL without re-exporting.
  const existing = await c.env.ASSETS_BUCKET.head(key).catch(() => null);
  if (existing) return c.json({ url: fileUrl });

  const user = c.get("user");
  let res: Response;
  try {
    res = await generatorFetch(c.env, `shot:${user.id}`, "/glb-3d", {
      method: "POST",
      body: JSON.stringify({ sku }),
      signal: AbortSignal.timeout(GLB_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `glb export failed: ${msg}` }, 502);
  }
  if (!res.ok) {
    return c.json(
      { error: await containerError(res, `glb export failed (${res.status})`) },
      502,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) {
    return c.json({ error: "glb export returned no data" }, 502);
  }
  await c.env.ASSETS_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: "model/gltf-binary" },
  });
  return c.json({ url: fileUrl });
});

/**
 * Public read for a cached fixture GLB. No auth: <model-viewer> fetches it
 * directly from the browser, and the key space is the (non-secret) SKU catalog.
 */
appShotRoutes.get("/glb-file/:file", async (c) => {
  const file = c.req.param("file");
  if (!/^[a-z0-9_-]+\.glb$/.test(file)) {
    return c.json({ error: "not found" }, 404);
  }
  const obj = await c.env.ASSETS_BUCKET.get(`appshot/glb/${file}`);
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": "model/gltf-binary",
      "cache-control": "public, max-age=86400",
    },
  });
});

/**
 * Auto-place: the generator places the fixture and runs the hidden AI critic
 * loop, returning an approved preview + the placement params for the sliders.
 */
appShotRoutes.post("/compose", requireAuth, async (c) => {
  if (!c.env.RENDER_WORKER_URL) {
    return c.json(
      { error: "3D app-shots are not configured (set RENDER_WORKER_URL)" },
      400,
    );
  }
  const parsed = AppShotComposeRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }

  const user = c.get("user");
  const out = await composeProxy(
    c,
    user.id,
    {
      sku: parsed.data.sku,
      roomUrl: parsed.data.sceneUrl,
      placement: parsed.data.placement,
      maxIterations: parsed.data.maxIterations,
    },
    COMPOSE_TIMEOUT_MS,
  );
  if ("__error" in out) return c.json({ error: out.__error }, out.status as 502);
  if (!out.previewPng) {
    return c.json({ error: "render returned no preview" }, 502);
  }

  const previewUrl = await storePreview(c, user.id, out.previewPng);
  return c.json({
    previewUrl,
    placement: out.placement,
    sku: out.sku ?? parsed.data.sku,
    sceneUrl: parsed.data.sceneUrl,
    fixtureType: out.fixtureType,
    mount: out.mount,
    iterations: out.iterations,
    approved: out.approved,
  });
});

/**
 * Single preview render of the EXACT slider placement, with NO AI critic, for
 * the responsive live-preview loop while the user tweaks sliders.
 */
appShotRoutes.post("/preview", requireAuth, async (c) => {
  if (!c.env.RENDER_WORKER_URL) {
    return c.json(
      { error: "3D app-shots are not configured (set RENDER_WORKER_URL)" },
      400,
    );
  }
  const parsed = AppShotPreviewRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }

  const user = c.get("user");
  const out = await composeProxy(
    c,
    user.id,
    {
      sku: parsed.data.sku,
      roomUrl: parsed.data.sceneUrl,
      placement: parsed.data.placement,
      skipCritic: true,
      maxIterations: 1,
      straightOn: parsed.data.straightOn,
      renderStyle: parsed.data.renderStyle,
      renderQuality: parsed.data.renderQuality,
    },
    PREVIEW_TIMEOUT_MS,
  );
  if ("__error" in out) return c.json({ error: out.__error }, out.status as 502);
  if (!out.previewPng) {
    return c.json({ error: "render returned no preview" }, 502);
  }

  const previewUrl = await storePreview(c, user.id, out.previewPng);
  return c.json({ previewUrl, placement: out.placement ?? parsed.data.placement });
});

/**
 * Finalize: enqueue a `shot3d` generation job that renders the full-quality
 * layered export and saves it as a library asset. Returns a jobId the UI polls
 * via /api/jobs/:id; the resulting asset carries the placement in its metadata
 * so the user can reopen and re-render later.
 */
appShotRoutes.post("/finalize", requireAuth, async (c) => {
  if (!c.env.RENDER_WORKER_URL) {
    return c.json(
      { error: "3D app-shots are not configured (set RENDER_WORKER_URL)" },
      400,
    );
  }
  const parsed = AppShotFinalizeRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }

  const user = c.get("user");
  const sb = userSupabase(c.env, c.get("jwt"));

  const params: Record<string, unknown> = {
    version: APPIMAGE_PARAMS_VERSION,
    mode: "shot3d",
    shot: {
      sku: parsed.data.sku,
      sceneUrl: parsed.data.sceneUrl,
      placement: parsed.data.placement,
      // Caustics/samples/resolution come from the quality tier (defaults to
      // `standard`, which keeps the previous "high quality" behavior).
      straightOn: parsed.data.straightOn,
      renderStyle: parsed.data.renderStyle,
      renderQuality: parsed.data.renderQuality,
    },
  };

  const res = await createGenerationJob(c.env, sb, {
    ownerId: user.id,
    tool: "appimage",
    name: parsed.data.name ?? `${parsed.data.sku} app shot`,
    params,
    tags: [`sku:${parsed.data.sku}`, "shot3d"],
  });
  if (!res.ok) return c.json({ error: res.error }, 500);

  return c.json({ jobId: res.row.id, status: res.row.status }, 202);
});
