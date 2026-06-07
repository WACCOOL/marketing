import type {
  AppShotPlacement,
  FixtureMount,
  RenderQuality,
  RenderStyle,
} from "@wac/shared";
import { api } from "./api.js";

/**
 * Client for the 3D app-shot pipeline (Phase D).
 *
 *   listFixtures   POC fixture catalog for the picker.
 *   composeShot    auto-place + hidden AI critic loop → approved preview + the
 *                  placement the sliders bind to (slow, runs a few renders).
 *   previewShot    one render of the EXACT slider placement, no AI (responsive).
 *   finalizeShot   enqueue the full-quality layered render as a library asset.
 *
 * The finalize result is polled via the shared jobs helpers; the asset's files
 * (png/avif/psd) download from /api/assets/:id/files/:format.
 */

export interface ShotFixture {
  sku: string;
  fixtureType: string;
  mount: FixtureMount;
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

export async function listFixtures(): Promise<ShotFixture[]> {
  const { fixtures } = await api<{ fixtures: ShotFixture[] }>(
    "/api/appshot/fixtures",
  );
  return fixtures;
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
  /** Use the straight-on 2D-layered render (the new 3D-viewer path). */
  straightOn?: boolean;
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
  /** Use the straight-on 2D-layered render (the new 3D-viewer path). */
  straightOn?: boolean;
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
