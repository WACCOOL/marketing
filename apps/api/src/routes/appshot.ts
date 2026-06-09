import { Hono } from "hono";
import {
  APPIMAGE_PARAMS_VERSION,
  AppShotComposeRequestSchema,
  AppShotFinalizeRequestSchema,
  AppShotPreviewRequestSchema,
  deriveFixtureKind,
  type DimensionsMm,
  type FixtureMount,
} from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { generatorFetch } from "../generatorClient.js";
import { createGenerationJob } from "../generation.js";
import { normalizeAssetUrl, publicOrigin } from "../publicUrl.js";
import { userSupabase } from "../supabase.js";

/**
 * 3D app-shot API (Phase C).
 *
 * The web UI flow:
 *   1. GET  /fixtures            browse the fixtures registry (search + page).
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
// These bound the API -> generator call. The generator in turn waits on the Modal
// worker, which on a COLD container pays boot + OptiX kernel compile + a 300MB
// .blend load before rendering (easily 3-4 min), so keep generous headroom or the
// API aborts a render that Modal is still (successfully) running. Compose can do
// several critic-loop renders, but the container stays warm across them so only
// the first is cold.
const COMPOSE_TIMEOUT_MS = 420_000;
const PREVIEW_TIMEOUT_MS = 360_000;

// The picker lists fixtures from the registry, so cap a page and how many rows
// we scan to group. Defaults keep the first load light while the catalog grows.
const FIXTURES_PAGE_DEFAULT = 60;
const FIXTURES_PAGE_MAX = 200;
const FIXTURES_SCAN_MAX = 5000;

interface FixtureRegistryRow {
  fixture_key: string;
  sku: string;
  scene: string | null;
  mount: string | null;
  fixture_type: string | null;
}

/** Subset of a catalog variant needed to distinguish finish-level fixtures. */
interface ProductVariantRow {
  sku?: string | null;
  name?: string | null;
  finish?: string | null;
  dimensions_mm?: DimensionsMm | null;
  image_urls?: string[] | null;
}

interface ProductKindRow {
  sku: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  primary_image_url: string | null;
  dimensions_mm: DimensionsMm | null;
  variants?: ProductVariantRow[] | null;
  /** Space-joined variant SKUs; fixtures are often variant-level, not the base. */
  variant_search?: string | null;
}

const PRODUCT_JOIN_COLS =
  "sku, name, brand, category, primary_image_url, dimensions_mm, variants, variant_search";

/** PostgREST caps `.in()` / `.or()` lists; chunk to stay under URL limits. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Resolve a catalog product for each fixture SKU, keyed by the (lowercased)
 * fixture SKU. Two passes: a direct SKU match, then a separator-insensitive
 * `variant_search` fallback for variant-level fixture SKUs (e.g. catalog
 * `BL234608-BV/BK` filed as `bl234608-bv-bk`). Queries are chunked so a large
 * catalog page never blows the PostgREST query-string limit.
 */
async function resolveProducts(
  sb: ReturnType<typeof userSupabase>,
  skus: string[],
): Promise<Map<string, ProductKindRow>> {
  const out = new Map<string, ProductKindRow>();
  if (skus.length === 0) return out;

  const candidates = [...new Set([...skus, ...skus.map((s) => s.toUpperCase())])];
  const byProductSku = new Map<string, ProductKindRow>();
  for (const part of chunk(candidates, 150)) {
    const { data } = await sb.from("products").select(PRODUCT_JOIN_COLS).in("sku", part);
    for (const p of (data ?? []) as ProductKindRow[]) {
      byProductSku.set(p.sku.toLowerCase(), p);
    }
  }
  for (const s of skus) {
    const hit = byProductSku.get(s.toLowerCase());
    if (hit) out.set(s.toLowerCase(), hit);
  }

  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const stemOf = (s: string) => (s.match(/^[a-z0-9]+/i)?.[0] ?? s).toUpperCase();
  const missing = skus.filter((s) => !out.has(s.toLowerCase()));
  if (missing.length === 0) return out;

  const stems = [...new Set(missing.map(stemOf))];
  const tokenized: Array<{ row: ProductKindRow; tokens: Set<string> }> = [];
  for (const part of chunk(stems, 60)) {
    const orFilter = part
      .map((st) => `variant_search.ilike.*${st.replace(/[\\%_]/g, (ch) => `\\${ch}`)}*`)
      .join(",");
    const { data } = await sb
      .from("products")
      .select(PRODUCT_JOIN_COLS)
      .or(orFilter)
      .limit(FIXTURES_SCAN_MAX);
    for (const p of (data ?? []) as ProductKindRow[]) {
      tokenized.push({
        row: p,
        tokens: new Set((p.variant_search ?? "").split(/\s+/).map(norm)),
      });
    }
  }
  for (const s of missing) {
    const key = norm(s);
    const match = tokenized.find((t) => t.tokens.has(key));
    if (match) out.set(s.toLowerCase(), match.row);
  }
  return out;
}

/** One selectable .blend within a fixture (a scene, or the single default). */
interface FixtureOption {
  fixtureKey: string;
  scene: string | null;
  label: string;
}

interface FixtureGroup {
  sku: string;
  mount: string | null;
  fixtureType: string | null;
  options: FixtureOption[];
}

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

/**
 * Cache a fixture's render as its shared picker thumbnail, keyed by fixture_key
 * so every user's picker shows the same "this is what the .blend looks like"
 * preview. Best-effort: a failed cache never breaks the render it piggybacks on.
 * The cutout (clean transparent fixture) is the ideal source — it's the form,
 * with no room clutter. Served back by GET /thumb-file/:file.
 */
async function cacheFixtureThumb(
  c: import("hono").Context<AppBindings>,
  fixtureKey: string,
  base64: string,
): Promise<void> {
  const key = fixtureKey.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!key) return;
  try {
    await c.env.ASSETS_BUCKET.put(`appshot/thumb/${key}.png`, base64ToBytes(base64), {
      httpMetadata: { contentType: "image/png" },
    });
  } catch {
    // best-effort only
  }
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

/** A fully display-ready fixture: registry group + joined catalog metadata. */
interface EnrichedFixture {
  sku: string;
  name: string;
  brand: string | null;
  category: string | null;
  dimensions: DimensionsMm | null;
  thumbnailUrl: string | null;
  /** Variant finish (e.g. "Aged Brass") — the distinguishing trait between
   *  finish-level fixtures that otherwise share a name/image/dimensions. */
  finish: string | null;
  fixtureType: string;
  mount: FixtureMount;
  options: FixtureOption[];
  /** Precomputed lowercase haystack for free-text search. */
  search: string;
}

const normSku = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Does a dimensions object carry any actual measurement? */
function hasDims(d: DimensionsMm | null | undefined): d is DimensionsMm {
  return Boolean(d && (d.width || d.height || d.depth || d.diameter || d.length));
}

// The fixtures + catalog join is identical for every active user (both tables
// are non-user catalog data behind the same is_active() RLS) and changes only
// on a bulk upload / Sales Layer sync, so cache the enriched list briefly. This
// turns search/brand keystrokes into instant in-memory filters instead of
// re-scanning the 4k-row catalog (~4s) on every call.
const CATALOG_TTL_MS = 120_000;
let catalogCache: {
  at: number;
  fixtures: EnrichedFixture[];
  brands: string[];
} | null = null;

async function loadFixtureCatalog(
  sb: ReturnType<typeof userSupabase>,
): Promise<{ fixtures: EnrichedFixture[]; brands: string[] }> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache;
  }

  const { data, error } = await sb
    .from("fixtures")
    .select("fixture_key, sku, scene, mount, fixture_type")
    .order("sku", { ascending: true })
    .order("scene", { ascending: true, nullsFirst: true })
    .limit(FIXTURES_SCAN_MAX);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as FixtureRegistryRow[];

  // Group rows by base SKU, preserving the ordered scene options.
  const groups = new Map<string, FixtureGroup>();
  for (const r of rows) {
    let g = groups.get(r.sku);
    if (!g) {
      g = { sku: r.sku, mount: r.mount, fixtureType: r.fixture_type, options: [] };
      groups.set(r.sku, g);
    }
    g.options.push({
      fixtureKey: r.fixture_key,
      scene: r.scene,
      label: r.scene ? `Scene ${r.scene}` : "Default",
    });
  }
  const allGroups = [...groups.values()];

  const products = await resolveProducts(
    sb,
    allGroups.map((g) => g.sku),
  );

  const fixtures: EnrichedFixture[] = allGroups.map((g) => {
    const product = products.get(g.sku.toLowerCase());
    const derived = deriveFixtureKind(product?.category, product?.name);
    const mount = (g.mount as FixtureMount | null) ?? derived.mount;
    const fixtureType = g.fixtureType ?? derived.fixtureType;
    const name = product?.name ?? g.sku;

    // A fixture SKU is usually a specific finish/variant (e.g. fm-50437-ab vs
    // fm-50437-an). Pull THAT variant's finish + image so two finishes of the
    // same product are visibly distinct instead of identical product-level art.
    const variant = (product?.variants ?? []).find(
      (v) => v.sku && normSku(v.sku) === normSku(g.sku),
    );
    const variantImg = variant?.image_urls?.[0] ?? null;

    return {
      sku: g.sku,
      name,
      brand: product?.brand ?? null,
      category: product?.category ?? null,
      dimensions: hasDims(variant?.dimensions_mm)
        ? variant!.dimensions_mm!
        : (product?.dimensions_mm ?? null),
      thumbnailUrl: variantImg ?? product?.primary_image_url ?? null,
      finish: variant?.finish ?? null,
      fixtureType,
      mount,
      options: g.options,
      search: [
        g.sku,
        ...g.options.map((o) => o.fixtureKey),
        name,
        product?.brand ?? "",
        variant?.finish ?? "",
      ]
        .join(" ")
        .toLowerCase(),
    };
  });

  const brands = [
    ...new Set(fixtures.map((f) => f.brand).filter((b): b is string => Boolean(b))),
  ].sort((a, b) => a.localeCompare(b));

  catalogCache = { at: Date.now(), fixtures, brands };
  return catalogCache;
}

/**
 * List fixtures from the registry for the picker. Browses every `.blend`
 * mirrored to R2, grouped by base SKU so a fixture's `_scnNNN` scene variants
 * appear as selectable options under one entry. Joins the products catalog for
 * display (name, brand, dimensions, thumbnail) and derives mount/type — so the
 * picker reads like the Products browser. Supports `?q=` search (SKU /
 * fixture_key / name / brand), `?brand=` facet, and `?limit`/`?offset`
 * pagination over the grouped fixtures; also returns the distinct `brands` that
 * have fixtures so the UI can render the brand filter. Shared by the 3D
 * App-Shot and Cam Solve pickers.
 */
appShotRoutes.get("/fixtures", requireAuth, async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));

  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const brandFilter = (c.req.query("brand") ?? "").trim();
  const limit = Math.min(
    FIXTURES_PAGE_MAX,
    Math.max(1, Number(c.req.query("limit")) || FIXTURES_PAGE_DEFAULT),
  );
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);

  let catalog: { fixtures: EnrichedFixture[]; brands: string[] };
  try {
    catalog = await loadFixtureCatalog(sb);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `failed to list fixtures: ${msg}` }, 500);
  }

  const filtered = catalog.fixtures.filter((f) => {
    if (brandFilter && f.brand !== brandFilter) return false;
    if (q && !f.search.includes(q)) return false;
    return true;
  });

  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit).map((f) => ({
    sku: f.sku,
    name: f.name,
    brand: f.brand,
    category: f.category,
    dimensions: f.dimensions,
    thumbnailUrl: f.thumbnailUrl,
    finish: f.finish,
    fixtureType: f.fixtureType,
    mount: f.mount,
    options: f.options,
  }));

  return c.json({ fixtures: page, total, limit, offset, brands: catalog.brands });
});

// Boot the (Modal) render worker ahead of time so the first Test/Final render
// skips the cold container boot. The web editor calls this on mount and on a
// heartbeat while open; the worker stays warm for its scaledown window, then
// scales to zero on its own. A cold boot can take ~30s, so allow generous
// headroom — but this never blocks the UI (fired in the background).
const PREWARM_TIMEOUT_MS = 100_000;

appShotRoutes.post("/prewarm", requireAuth, async (c) => {
  if (!c.env.RENDER_WORKER_URL) {
    return c.json({ ok: false, warm: false, reason: "no render worker configured" });
  }
  const user = c.get("user");
  try {
    const res = await generatorFetch(c.env, `shot:${user.id}`, "/prewarm-3d", {
      method: "POST",
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
    });
    if (!res.ok) return c.json({ ok: false, warm: false, status: res.status });
    return c.json((await res.json()) as Record<string, unknown>);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, warm: false, error: msg });
  }
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
      body: JSON.stringify({
        sku: raw.sku,
        roomUrl: normalizeAssetUrl(c, raw.sceneUrl),
      }),
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
  // Piggyback the clean transparent cutout as this fixture's shared picker
  // thumbnail so browsing it later shows the actual form (not just the SKU).
  await cacheFixtureThumb(c, raw.sku, out.png);
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
 * Public read for a fixture's cached render thumbnail (404s until a cutout has
 * been rendered for it). No auth: the picker loads it as an <img>, and the key
 * space is the (non-secret) fixture_key catalog. A short cache lets a freshly
 * rendered fixture's thumbnail refresh without a hard reload.
 */
appShotRoutes.get("/thumb-file/:file", async (c) => {
  const file = c.req.param("file");
  if (!/^[a-z0-9_-]+\.png$/.test(file)) {
    return c.json({ error: "not found" }, 404);
  }
  const obj = await c.env.ASSETS_BUCKET.get(`appshot/thumb/${file}`);
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=300",
    },
  });
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
      roomUrl: normalizeAssetUrl(c, parsed.data.sceneUrl),
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
      roomUrl: normalizeAssetUrl(c, parsed.data.sceneUrl),
      placement: parsed.data.placement,
      skipCritic: true,
      maxIterations: 1,
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
      sceneUrl: normalizeAssetUrl(c, parsed.data.sceneUrl),
      placement: parsed.data.placement,
      // Caustics/samples/resolution come from the quality tier (defaults to
      // `standard`, which keeps the previous "high quality" behavior).
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
