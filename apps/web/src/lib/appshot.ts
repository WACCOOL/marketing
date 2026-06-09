import type {
  AppShotPlacement,
  DimensionsMm,
  FixtureMount,
  RenderQuality,
  RenderStyle,
} from "@wac/shared";
import { normalizeFixtureKey } from "@wac/shared";
import { api } from "./api.js";

/**
 * Client for the 3D app-shot pipeline (Phase D).
 *
 *   listFixtures   browse the fixtures registry for the picker (search + page).
 *   composeShot    auto-place + hidden AI critic loop → approved preview + the
 *                  placement the sliders bind to (slow, runs a few renders).
 *   previewShot    one render of the EXACT slider placement, no AI (responsive).
 *   finalizeShot   enqueue the full-quality layered render as a library asset.
 *
 * The finalize result is polled via the shared jobs helpers; the asset's files
 * (png/avif/psd) download from /api/assets/:id/files/:format.
 */

/** One selectable .blend within a fixture (a scene, or the single default). */
export interface FixtureOption {
  /** Opaque identifier passed to compose/preview/cutout/glb/finalize. */
  fixtureKey: string;
  /** Scene number for `{sku}_scnNNN` files, else null. */
  scene: string | null;
  /** Human label, e.g. "Scene 010" or "Default". */
  label: string;
}

export interface ShotFixture {
  /** Base product SKU; a fixture's scene options share it. */
  sku: string;
  fixtureType: string;
  mount: FixtureMount;
  /** Product display name (falls back to the SKU when unmatched). */
  name?: string;
  /** Sales Layer brand, when the SKU matches a product. */
  brand?: string | null;
  /** Sales Layer category, when the SKU matches a product. */
  category?: string | null;
  /** Variant finish (e.g. "Aged Brass") — distinguishes finish-level fixtures. */
  finish?: string | null;
  /** Physical dimensions (mm) from the catalog, when matched. */
  dimensions?: DimensionsMm | null;
  /** Sales Layer thumbnail URL, when the SKU matches a product. */
  thumbnailUrl?: string | null;
  /** Selectable scene options; one entry for a single-.blend fixture. */
  options: FixtureOption[];
}

export interface ComposeResult {
  previewUrl: string;
  placement: AppShotPlacement;
  sku: string;
  sceneUrl: string;
  fixtureType?: string;
  mount?: FixtureMount;
  iterations?: number;
  approved?: boolean;
}

export interface PreviewResult {
  previewUrl: string;
  placement: AppShotPlacement;
}

/**
 * Boot the render worker ahead of time so the first Test/Final render skips the
 * cold-container boot. Fire-and-forget: call on editor mount and on a heartbeat
 * while the page is open. Never throws — a failed pre-warm just means the first
 * render pays the normal boot cost.
 */
export async function prewarmShot(): Promise<{ ok: boolean; warm?: boolean }> {
  try {
    return await api<{ ok: boolean; warm?: boolean }>("/api/appshot/prewarm", {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch {
    return { ok: false };
  }
}

/**
 * List fixtures for the picker. Browses the whole registry; pass `q` to search
 * (SKU / name / brand), `brand` to filter by the brand facet, and
 * `limit`/`offset` to paginate. Returns the page of fixtures, the total count,
 * and the distinct `brands` that have fixtures (for the brand filter).
 */
export async function listFixtures(opts?: {
  q?: string;
  brand?: string;
  limit?: number;
  offset?: number;
}): Promise<{ fixtures: ShotFixture[]; total: number; brands: string[] }> {
  const params = new URLSearchParams();
  if (opts?.q) params.set("q", opts.q);
  if (opts?.brand) params.set("brand", opts.brand);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.offset != null) params.set("offset", String(opts.offset));
  const qs = params.toString();
  const res = await api<{
    fixtures: ShotFixture[];
    total?: number;
    brands?: string[];
  }>(`/api/appshot/fixtures${qs ? `?${qs}` : ""}`);
  return {
    fixtures: res.fixtures,
    total: res.total ?? res.fixtures.length,
    brands: res.brands ?? [],
  };
}

export interface PlaceResult {
  placement: AppShotPlacement;
  fixtureType?: string;
  mount?: FixtureMount;
}

/**
 * Fast AI placement: reads the bare room (vision only, no render) and returns a
 * starting placement. The UI then renders the cutout once and lets the user
 * drag/scale instantly. Much faster than `composeShot` (which also renders).
 */
export async function placeShot(req: {
  sku: string;
  sceneUrl: string;
}): Promise<PlaceResult> {
  return api<PlaceResult>("/api/appshot/place", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function composeShot(req: {
  sku: string;
  sceneUrl: string;
  placement?: Partial<AppShotPlacement>;
  maxIterations?: number;
}): Promise<ComposeResult> {
  return api<ComposeResult>("/api/appshot/compose", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function previewShot(req: {
  sku: string;
  sceneUrl: string;
  placement: AppShotPlacement;
  /** Cam Solve render style (clean / cleanShadow / studio). */
  renderStyle?: RenderStyle;
  /** Quality tier (samples + caustics + resolution). */
  renderQuality?: RenderQuality;
}): Promise<PreviewResult> {
  return api<PreviewResult>("/api/appshot/preview", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export interface CutoutResult {
  /** Full-frame transparent fixture render to overlay on the scene. */
  cutoutUrl: string;
  /** Coverage the cutout was framed at; client scale = coverage / coverageRef. */
  coverageRef: number;
  width: number;
  height: number;
}

/**
 * Render a transparent fixture cutout for the instant drag/scale overlay. Call
 * once per camera pose; positioning + sizing afterwards is pure client-side.
 * `width`/`height` should carry the SCENE aspect so the projection matches the
 * eventual Test/Final render.
 */
export async function cutoutShot(req: {
  sku: string;
  pose?: AppShotPlacement["pose"];
  coverageRef?: number;
  width?: number;
  height?: number;
}): Promise<CutoutResult> {
  return api<CutoutResult>("/api/appshot/cutout", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/**
 * Public URL for a fixture's cached render thumbnail (the clean transparent
 * cutout from the last time it was rendered). 404s until one exists, so use it
 * as an <img> with an onError fallback to the 3D form / placeholder.
 */
export function fixtureThumbUrl(fixtureKey: string): string {
  // normalizeFixtureKey matches the key cacheFixtureThumb / the bake CLI write,
  // and is URL-safe (^[a-z0-9_-]+$), so no encoding is needed.
  return `/api/appshot/thumb-file/${normalizeFixtureKey(fixtureKey)}.png`;
}

/**
 * Get a public GLB URL for the fixture's 3D viewer (the new model-viewer
 * placement path). The API exports it from the .blend once per SKU and caches it
 * in R2, so this is fast after the first call.
 */
export async function glbShot(req: { sku: string }): Promise<{ url: string }> {
  return api<{ url: string }>("/api/appshot/glb", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function finalizeShot(req: {
  sku: string;
  sceneUrl: string;
  placement: AppShotPlacement;
  name?: string;
  /** Cam Solve render style (clean / cleanShadow / studio). */
  renderStyle?: RenderStyle;
  /** Quality tier (samples + caustics + resolution). */
  renderQuality?: RenderQuality;
}): Promise<{ jobId: string; status: string }> {
  return api("/api/appshot/finalize", {
    method: "POST",
    body: JSON.stringify(req),
  });
}
