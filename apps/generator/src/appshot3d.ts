/**
 * 3D app-shot orchestration (Phase 3 / Phase B).
 *
 * Ties the pieces of the in-Blender app-shot pipeline together:
 *   1. resolve the fixture's 3D model + IES + type/mount from its SKU,
 *   2. auto-place it in the room and let an AI critic correct the placement in a
 *      hidden loop (fast preview renders) until it's approved,
 *   3. on user finalize, render the full-quality layered export.
 *
 * The SKU lookup is hardcoded for the POC (two sample fixtures). In production it
 * comes from Monday.com / Lucid (model + IES URLs), so the rest of this module is
 * written against URLs-or-paths and won't change when that lookup is wired in.
 */

import sharp from "sharp";
import { writePsd } from "ag-psd";
import type { RenderQuality, RenderStyle, RoomGeometry } from "@wac/shared";
import type {
  CompositeResult,
  ImageGenAdapters,
  ModelRenderPose,
  PlacementAdjust,
} from "./ai/adapter.js";
import { RENDER_FINAL_TIMEOUT_MS } from "./ai/modelRender.js";

export type Mount = "ceiling" | "wall" | "floor" | "recessed";

/** Load the room plate bytes (URL or local path) for the room-analysis vision call. */
async function fetchRoomBuffer(room: RoomRef): Promise<Buffer> {
  if (room.roomUrl) {
    const res = await fetch(room.roomUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`failed to fetch room ${room.roomUrl}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (room.roomPath) {
    const { readFile } = await import("node:fs/promises");
    return readFile(room.roomPath);
  }
  throw new Error("no room reference to analyze");
}

export interface FixtureMeta {
  sku: string;
  /** Local path (worker-local file; rarely used now that the .blend is in R2). */
  modelPath?: string;
  /** Presigned R2 URL the worker fetches (the registry-backed default). */
  modelUrl?: string;
  /** Manufacturer IES photometry — omitted for decorative pieces that lack it. */
  iesPath?: string;
  iesUrl?: string;
  fixtureType: string;
  mount: Mount;
  /** Default camera pose + framing for this fixture. */
  pose: ModelRenderPose;
  /** Default fixture height as a fraction of the frame. */
  coverage: number;
}

/**
 * Resolves a SKU to its 3D model + metadata. The concrete implementation
 * (registry-backed, presigning the `.blend` from R2 + deriving mount/type/pose)
 * is injected at startup by the generator server, which owns the Supabase + S3
 * clients. Kept behind a setter so this module has no DB/R2 dependency.
 */
export type FixtureResolver = (sku: string) => Promise<FixtureMeta>;

let activeResolver: FixtureResolver | null = null;

/** Install the fixture resolver (called once at server startup). */
export function setFixtureResolver(resolver: FixtureResolver): void {
  activeResolver = resolver;
}

export async function resolveFixture(sku: string): Promise<FixtureMeta> {
  if (!activeResolver) {
    throw new Error(
      "fixture resolver not configured (generator missing Supabase/R2 wiring)",
    );
  }
  return activeResolver(sku);
}

export interface Placement {
  xPct: number;
  yPct: number;
  coverage: number;
  /** Fixture brightness: how bright the fixture's own diffusers/bulbs glow. */
  brightness: number;
  /** Light output: real light thrown into the room (IES power / own lamps). */
  lightOutput: number;
  warm: number;
  pose: ModelRenderPose;
  /** Cam Solve room-match: when set, the render matches the photo's camera and
   * lights the real ceiling/wall/floor instead of the orbit camera + billboard.
   * Scene-level + constant — the AI critic never adjusts it. */
  roomGeometry?: RoomGeometry;
}

export interface RoomRef {
  roomUrl?: string;
  roomPath?: string;
}

export interface AutoPlaceInput extends RoomRef {
  sku: string;
  /** Optional starting overrides (else fixture defaults). */
  placement?: Partial<Placement>;
  /** Max AI correction rounds before handing to the user (default 3). */
  maxIterations?: number;
  /**
   * Skip the AI critic entirely: render the given placement exactly once and
   * return it. Used by the responsive slider preview path, where the user's
   * manual placement must never be second-guessed by the critic.
   */
  skipCritic?: boolean;
  /**
   * Cam Solve render style. `studio` (default) uses the in-Blender catcher
   * composite; `clean`/`cleanShadow` use the flat layered cutout (alpha
   * preserved), with `cleanShadow` adding a soft drop shadow.
   */
  renderStyle?: RenderStyle;
  /** Quality tier (samples + caustics + resolution). Defaults to standard. */
  renderQuality?: RenderQuality;
}

export interface AutoPlaceResult {
  previewPng: Buffer;
  placement: Placement;
  sku: string;
  fixtureType: string;
  mount: Mount;
  iterations: number;
  approved: boolean;
  /** Internal critic notes (not surfaced to the user). */
  notes: string[];
}

/** A sensible default vertical position by mount (sconce mid-upper, chandelier upper). */
function defaultYPct(mount: Mount): number {
  return mount === "ceiling" ? 0.32 : 0.42;
}

function startingPlacement(meta: FixtureMeta, over?: Partial<Placement>): Placement {
  return {
    xPct: over?.xPct ?? 0.5,
    yPct: over?.yPct ?? defaultYPct(meta.mount),
    coverage: over?.coverage ?? meta.coverage,
    brightness: over?.brightness ?? 50,
    lightOutput: over?.lightOutput ?? 50,
    warm: over?.warm ?? 0.45,
    pose: over?.pose ?? meta.pose,
    roomGeometry: over?.roomGeometry,
  };
}

function applyAdjust(p: Placement, a?: PlacementAdjust): Placement {
  if (!a) return p;
  return {
    ...p,
    xPct: a.xPct ?? p.xPct,
    yPct: a.yPct ?? p.yPct,
    coverage: a.coverage ?? p.coverage,
    brightness: a.brightness ?? p.brightness,
  };
}

/**
 * Pick a starting placement for the fixture by reading the BARE room with a
 * single vision call (no Blender render) — fast enough to run before the
 * interactive editor opens. Falls back to sensible defaults when there's no
 * critic, no analyzeRoom support, or the caller passed an explicit placement.
 * Appends human-readable notes (not surfaced to the user) when `notes` is given.
 */
export async function planPlacement(
  input: AutoPlaceInput,
  adapters: ImageGenAdapters,
  notes?: string[],
): Promise<Placement> {
  const meta = await resolveFixture(input.sku);
  let placement = startingPlacement(meta, input.placement);
  const analyzer = adapters.placementCritic;
  if (analyzer?.analyzeRoom && !input.placement) {
    try {
      const roomImage = await fetchRoomBuffer(input);
      const hint = await analyzer.analyzeRoom({
        image: roomImage,
        fixtureType: meta.fixtureType,
        mount: meta.mount,
      });
      if (hint) {
        placement = {
          ...placement,
          xPct: hint.xPct,
          yPct: hint.yPct,
          coverage: hint.coverage ?? placement.coverage,
        };
        notes?.push(`room analysis: ${hint.reason ?? "(no reason)"}`);
      }
    } catch (e) {
      notes?.push(`room analysis skipped: ${e instanceof Error ? e.message : e}`);
    }
  }
  return placement;
}

/**
 * Concrete render settings for a quality tier. These are the three knobs that
 * trade time for quality: `samples` (Cycles noise), `highQuality` (refractive
 * caustics — the crystal/glass sparkle, the big time cost), and resolution
 * (`renderPx` = the square fixture render for the clean cutout; `finalLongEdge`
 * = the upscale target for the studio composite).
 */
interface QualityProfile {
  samples: number;
  highQuality: boolean;
  renderPx: number;
  finalLongEdge: number;
}

/**
 * Map a quality tier to concrete render settings. Previews stay deliberately
 * cheap (they're thrown away every slider tweak) but scale a little with the
 * tier so the test render roughly previews the final look; finals open the taps.
 * `standard` reproduces the pipeline's previous fixed defaults, so an omitted
 * tier is a no-op for existing callers.
 */
export function qualityProfile(
  quality: RenderQuality | undefined,
  preview: boolean,
): QualityProfile {
  const tier = quality ?? "standard";
  if (preview) {
    switch (tier) {
      case "draft":
        return { samples: 16, highQuality: false, renderPx: 700, finalLongEdge: 1280 };
      case "high":
        return { samples: 48, highQuality: false, renderPx: 1100, finalLongEdge: 2048 };
      case "max":
        // Previews stay caustics-off even at Max: caustics are the big time cost
        // and a preview is just a fast look-check (the final still renders them).
        return { samples: 64, highQuality: false, renderPx: 1280, finalLongEdge: 2560 };
      case "standard":
      default:
        return { samples: 24, highQuality: false, renderPx: 900, finalLongEdge: 1600 };
    }
  }
  switch (tier) {
    case "draft":
      return { samples: 64, highQuality: false, renderPx: 1200, finalLongEdge: 1920 };
    case "high":
      return { samples: 512, highQuality: true, renderPx: 2600, finalLongEdge: 4096 };
    case "max":
      return { samples: 1024, highQuality: true, renderPx: 3600, finalLongEdge: 5120 };
    case "standard":
    default:
      return { samples: 200, highQuality: true, renderPx: 1600, finalLongEdge: 3840 };
  }
}

/** One fixture of a shot, resolved and placed. Rendered back-to-front in list order. */
export interface ShotFixtureEntry {
  meta: FixtureMeta;
  placement: Placement;
}

/**
 * Render the placed fixture(s) onto their background, choosing the pipeline by
 * render style. `studio` uses the in-Blender catcher composite (real light spill
 * + contact shadow on the backdrop); `clean`/`cleanShadow` use the flat layered
 * cutout (fixture only, alpha preserved), with `cleanShadow` adding a soft drop
 * shadow. Shared by the preview (autoPlace/previewShotChain) and final
 * (finalRender) paths.
 *
 * The quality tier resolves to concrete samples/caustics/resolution here; any
 * explicit override on `opts` wins so callers can still force a specific value.
 */
async function renderShotImage(
  entries: ShotFixtureEntry[],
  opts: {
    preview: boolean;
    layers?: boolean;
    renderStyle?: RenderStyle;
    renderQuality?: RenderQuality;
    roomUrl?: string;
    roomPath?: string;
    samples?: number;
    highQuality?: boolean;
    supersample?: number;
    finalLongEdge?: number;
  },
  adapters: ImageGenAdapters,
): Promise<CompositeResult> {
  if (!entries.length) {
    throw new Error("shot render needs at least one fixture");
  }
  const style = opts.renderStyle ?? "studio";
  const profile = qualityProfile(opts.renderQuality, opts.preview);
  const samples = opts.samples ?? profile.samples;
  const highQuality = opts.highQuality ?? profile.highQuality;
  const finalLongEdge = opts.finalLongEdge ?? profile.finalLongEdge;
  if (style === "clean" || style === "cleanShadow") {
    return layeredShot(
      entries,
      {
        roomUrl: opts.roomUrl,
        roomPath: opts.roomPath,
        preview: opts.preview,
        layers: opts.layers,
        samples,
        highQuality,
        renderPx: profile.renderPx,
        dropShadow: style === "cleanShadow",
      },
      adapters,
    );
  }
  // studio: in-Blender catcher composite (the fixture emits real light into the
  // backdrop and casts a contact shadow).
  const compositor = adapters.compositor;
  if (!compositor) {
    throw new Error(
      "3D app-shot requires a configured render-worker (set RENDER_WORKER_URL)",
    );
  }
  // roomGeometry is scene-level (Cam Solve) — every fixture carries the same
  // one. It is SINGLE-FIXTURE ONLY: its oriented planes are Cycles shadow
  // catchers whose ratio-based compositing is not idempotent, so re-rendering
  // the chained plate through them once per fixture compounds into a washed-out
  // veil (observed: a 3-fixture final blown out with near-zero fixture light).
  // Multi-fixture shots fall back to the legacy camera-facing catcher, which is
  // plain emission+diffuse and stable under chaining.
  const roomGeometry =
    entries.length === 1 ? entries[0]!.placement.roomGeometry : undefined;
  if (entries.length > 1 && entries[0]!.placement.roomGeometry) {
    console.warn(
      "[appshot3d] multi-fixture shot: dropping Cam Solve room-match (single-fixture only)",
    );
  }
  const shared = {
    preview: opts.preview,
    layers: opts.layers,
    roomUrl: opts.roomUrl,
    roomPath: opts.roomPath,
    roomGeometry,
    samples,
    highQuality,
    supersample: opts.supersample,
    finalLongEdge,
  };
  if (entries.length === 1) {
    // Keep the legacy single-fixture wire shape so an older render-worker keeps
    // working for everything that exists today during a rollout.
    const { meta, placement } = entries[0]!;
    return compositor.composite({
      ...shared,
      modelPath: meta.modelPath,
      modelUrl: meta.modelUrl,
      sku: meta.sku,
      iesPath: meta.iesPath,
      iesUrl: meta.iesUrl,
      mount: meta.mount,
      pose: placement.pose,
      coverage: placement.coverage,
      xPct: placement.xPct,
      yPct: placement.yPct,
      brightness: placement.brightness,
      lightOutput: placement.lightOutput,
      warm: placement.warm,
    });
  }
  return compositor.composite({
    ...shared,
    fixtures: entries.map(({ meta, placement }) => ({
      modelPath: meta.modelPath,
      modelUrl: meta.modelUrl,
      sku: meta.sku,
      iesPath: meta.iesPath,
      iesUrl: meta.iesUrl,
      mount: meta.mount,
      pose: placement.pose,
      coverage: placement.coverage,
      xPct: placement.xPct,
      yPct: placement.yPct,
      brightness: placement.brightness,
      lightOutput: placement.lightOutput,
      warm: placement.warm,
    })),
  });
}

/**
 * Auto-place the fixture and let the AI critic correct it in a hidden loop. Each
 * round does a fast preview render, then the critic returns absolute corrections;
 * we stop on approval or after `maxIterations`. Without a critic (no Gemini key)
 * it does a single preview and returns it as approved.
 */
export async function autoPlace(
  input: AutoPlaceInput,
  adapters: ImageGenAdapters,
): Promise<AutoPlaceResult> {
  const meta = await resolveFixture(input.sku);
  const style = input.renderStyle ?? "studio";
  // The clean/cleanShadow styles render via the layered cutout (modelRenderer),
  // so they don't need the catcher compositor — only studio does.
  if (style === "studio" && !adapters.compositor) {
    throw new Error(
      "3D app-shot requires a configured render-worker (set RENDER_WORKER_URL)",
    );
  }
  if (!input.roomUrl && !input.roomPath) {
    throw new Error("auto-place requires a roomUrl or roomPath");
  }
  // The slider preview path renders the exact placement once, so the critic is
  // suppressed there even when a Gemini key is configured.
  const critic = input.skipCritic ? undefined : adapters.placementCritic;
  const maxIterations = input.skipCritic ? 1 : Math.max(1, input.maxIterations ?? 3);

  // Smart start: read the BARE room (vision only, no render) so the fixture
  // begins at the natural mount spot before the critic loop fine-tunes it.
  const notes: string[] = [];
  const plan = await planPlacement(input, adapters, notes);
  let placement = plan;

  let previewPng: Buffer | undefined;
  let approved = false;
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations++;
    // studio: in-Blender catcher composite so the fixture actually emits light
    // into the backdrop (IES spill / lamp glow, contact shadow). clean styles:
    // flat layered cutout (alpha preserved), optionally with a soft drop shadow.
    const r = await renderShotImage(
      [{ meta, placement }],
      {
        preview: true,
        renderStyle: style,
        renderQuality: input.renderQuality,
        roomUrl: input.roomUrl,
        roomPath: input.roomPath,
      },
      adapters,
    );
    previewPng = r.png;

    if (!critic) {
      approved = true;
      notes.push("no critic configured; single preview");
      break;
    }
    const critique = await critic.critiquePlacement({
      image: previewPng,
      fixtureType: meta.fixtureType,
      mount: meta.mount,
      current: {
        xPct: placement.xPct,
        yPct: placement.yPct,
        coverage: placement.coverage,
        brightness: placement.brightness,
      },
    });
    notes.push(critique.reason ?? "(no reason)");
    if (critique.approved) {
      approved = true;
      placement = applyAdjust(placement, critique.adjust);
      break;
    }
    placement = applyAdjust(placement, critique.adjust);
  }

  return {
    previewPng: previewPng!,
    placement,
    sku: meta.sku,
    fixtureType: meta.fixtureType,
    mount: meta.mount,
    iterations,
    approved,
    notes,
  };
}

/** A placed fixture by SKU — the wire shape of multi-fixture preview/final inputs. */
export interface ShotFixturePlacement {
  sku: string;
  placement: Placement;
}

export interface PreviewShotInput extends RoomRef {
  fixtures: ShotFixturePlacement[];
  renderStyle?: RenderStyle;
  renderQuality?: RenderQuality;
}

/**
 * One preview render of EXACT multi-fixture placements (no AI critic — the
 * slider loop's placements are never second-guessed). The worker chains one
 * render per fixture, back-to-front in list order.
 */
export async function previewShotChain(
  input: PreviewShotInput,
  adapters: ImageGenAdapters,
): Promise<{ previewPng: Buffer }> {
  if (!input.roomUrl && !input.roomPath) {
    throw new Error("preview requires a roomUrl or roomPath");
  }
  const entries: ShotFixtureEntry[] = await Promise.all(
    input.fixtures.map(async (f) => ({
      meta: await resolveFixture(f.sku),
      placement: f.placement,
    })),
  );
  const r = await renderShotImage(
    entries,
    {
      preview: true,
      renderStyle: input.renderStyle,
      renderQuality: input.renderQuality,
      roomUrl: input.roomUrl,
      roomPath: input.roomPath,
    },
    adapters,
  );
  return { previewPng: r.png };
}

export interface CutoutInput {
  sku: string;
  /** Camera pose (azimuth/elevation/fov). marginFactor is derived from coverageRef. */
  pose?: ModelRenderPose;
  /**
   * Reference coverage the cutout is framed at (fixture height fraction). The
   * client overlays the full-frame cutout and scales it by coverage/coverageRef,
   * which — because we frame with the SAME camera math as composite.py — maps
   * exactly back to a composite coverage. Defaults to 0.5.
   */
  coverageRef?: number;
  /** Output size; pass the SCENE's aspect so the projection matches the composite. */
  width?: number;
  height?: number;
  samples?: number;
  engine?: string;
}

export interface CutoutResult {
  png: Buffer;
  coverageRef: number;
  width: number;
  height: number;
}

/**
 * Render JUST the fixture to a full-frame transparent PNG for the interactive
 * drag/scale overlay. Framed centered at `coverageRef` using the same bounding-
 * sphere + marginFactor math as the in-Blender composite, and at the scene's
 * aspect ratio, so the browser can position/scale it with a pure CSS transform
 * that maps 1:1 onto composite's xPct/yPct/coverage for the Test/Final render.
 */
export async function renderCutout(
  input: CutoutInput,
  adapters: ImageGenAdapters,
): Promise<CutoutResult> {
  const meta = await resolveFixture(input.sku);
  const renderer = adapters.modelRenderer;
  if (!renderer) {
    throw new Error(
      "3D app-shot requires a configured render-worker (set RENDER_WORKER_URL)",
    );
  }
  const coverageRef = Math.min(0.95, Math.max(0.05, input.coverageRef ?? 0.5));
  const width = input.width ?? 1024;
  const height = input.height ?? 1024;
  const basePose = input.pose ?? meta.pose;
  const pose: ModelRenderPose = { ...basePose, marginFactor: 1 / coverageRef };
  // The cutout is an INTERACTIVE placement overlay, not a final render. Cap it
  // to low-sample Cycles so a heavy hero .blend (e.g. the chandelier, whose
  // authored settings take minutes) renders in a couple seconds and can never
  // peg the machine. Full fidelity comes from the Test/Final render.
  const png = await renderer.render({
    modelPath: meta.modelPath,
    modelUrl: meta.modelUrl,
    sku: meta.sku,
    pose,
    width,
    height,
    samples: input.samples ?? 24,
    engine: input.engine,
    lightsOn: true,
  });
  return { png, coverageRef, width, height };
}

// ---------------------------------------------------------------------------
// Straight-on layered render (3D-viewer placement path).
//
// To make the Blender render match the live <model-viewer> placement EXACTLY (no
// "jump" on Test render), the fixture is rendered straight-on (camera aimed at
// the fixture's own center, NEVER pushed off-axis) and then composited onto the
// room as a 2D layer at the viewer's screen position/size. This mirrors how the
// design team works in Photoshop (a fixture cutout placed over a room) while the
// pixels themselves are a real Cycles render. The older in-Blender composite
// (composite.py, physical light spill on a catcher plane) stays available as the
// fallback path.
//
// Size convention (kept in lockstep with the web ModelViewerCanvas): the fixture
// is "contain"-fit into a SQUARE box whose side is `coverage` of the room HEIGHT,
// centered at (xPct, yPct). FRAME_MARGIN matches model-viewer's default framing
// padding so the live viewer and the render agree on size.
// ---------------------------------------------------------------------------

/** Fraction of the placement box the fixture fills — matches model-viewer framing. */
const FRAME_MARGIN = 0.9;

interface VisibleRect {
  srcLeft: number;
  srcTop: number;
  cw: number;
  ch: number;
  destLeft: number;
  destTop: number;
}

/** Intersection of a placed overlay with the canvas, as crop + paste coords. */
function visibleRect(
  left: number,
  top: number,
  w: number,
  h: number,
  canvasW: number,
  canvasH: number,
): VisibleRect | null {
  const x0 = Math.max(0, Math.round(left));
  const y0 = Math.max(0, Math.round(top));
  const x1 = Math.min(canvasW, Math.round(left + w));
  const y1 = Math.min(canvasH, Math.round(top + h));
  if (x1 <= x0 || y1 <= y0) return null;
  const srcLeft = Math.min(w - 1, Math.max(0, x0 - Math.round(left)));
  const srcTop = Math.min(h - 1, Math.max(0, y0 - Math.round(top)));
  return {
    srcLeft,
    srcTop,
    cw: Math.min(w - srcLeft, x1 - x0),
    ch: Math.min(h - srcTop, y1 - y0),
    destLeft: x0,
    destTop: y0,
  };
}

/** Build a full-canvas (room-sized) transparent layer with the fixture placed. */
async function fixtureLayerOnCanvas(
  fixture: Buffer,
  fw: number,
  fh: number,
  left: number,
  top: number,
  canvasW: number,
  canvasH: number,
): Promise<Buffer> {
  const base = sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  const vr = visibleRect(left, top, fw, fh, canvasW, canvasH);
  if (!vr) return base.png().toBuffer();
  const cropped = await sharp(fixture)
    .extract({ left: vr.srcLeft, top: vr.srcTop, width: vr.cw, height: vr.ch })
    .png()
    .toBuffer();
  return base
    .composite([{ input: cropped, left: vr.destLeft, top: vr.destTop }])
    .png()
    .toBuffer();
}

/** A PNG buffer -> ag-psd ImageData (RGBA) at the given canvas size. */
async function toImageData(buf: Buffer, width: number, height: number) {
  const { data, info } = await sharp(buf)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

export interface LayeredShotInput extends RoomRef {
  preview: boolean;
  layers?: boolean;
  samples?: number;
  highQuality?: boolean;
  /** Square size the fixture is rendered at before trim + 2D scale. Higher =
   * crisper, zoom-proof cutout (the resolution lever for clean styles). */
  renderPx?: number;
  /** Add a soft, alpha-preserving drop shadow under the fixture (cleanShadow). */
  dropShadow?: boolean;
}

/**
 * Build a soft drop-shadow buffer from a placed fixture: take the fixture's
 * alpha as a silhouette, pad it so the blur isn't clipped, blur + dim it, and
 * tint it black. Returns the shadow PNG plus the padding it added so the caller
 * can offset it correctly under the fixture.
 */
async function buildShadow(
  scaled: Buffer,
  fh: number,
): Promise<{ buf: Buffer; pad: number; offX: number; offY: number }> {
  const blurR = Math.max(4, Math.round(fh * 0.05));
  const pad = Math.ceil(blurR * 3);
  // The shadow's opacity peak (0..255 alpha scaler).
  const opacity = 0.42;
  const padded = await sharp(scaled)
    .ensureAlpha()
    .extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();
  const pmeta = await sharp(padded).metadata();
  const pw = pmeta.width ?? 0;
  const ph = pmeta.height ?? 0;
  // Blurred, dimmed silhouette from the alpha channel -> the shadow's alpha mask.
  const mask = await sharp(padded)
    .extractChannel("alpha")
    .blur(blurR)
    .linear(opacity, 0)
    .toBuffer();
  // Black RGB with the blurred mask as alpha.
  const buf = await sharp({
    create: { width: pw, height: ph, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .joinChannel(mask)
    .png()
    .toBuffer();
  return { buf, pad, offX: Math.round(fh * 0.03), offY: Math.round(fh * 0.05) };
}

/**
 * Render each fixture straight-on and composite them onto the room as positioned
 * 2D layers (the WYSIWYG path that matches the 3D viewer), back-to-front in list
 * order. Returns PNG always, plus AVIF + a positioned layered PSD on final
 * exports (a single fixture keeps the historical Background / Shadow / Fixture
 * layer names).
 */
export async function layeredShot(
  entries: ShotFixtureEntry[],
  input: LayeredShotInput,
  adapters: ImageGenAdapters,
): Promise<CompositeResult> {
  const renderer = adapters.modelRenderer;
  if (!renderer) {
    throw new Error(
      "3D app-shot requires a configured render-worker (set RENDER_WORKER_URL)",
    );
  }
  const room = await fetchRoomBuffer(input);
  const rmeta = await sharp(room).metadata();
  const RW = rmeta.width ?? 1024;
  const RH = rmeta.height ?? 576;

  const placed: Array<{ fixtureLayer: Buffer; shadowLayer: Buffer | null }> = [];
  for (const { meta, placement } of entries) {
    // Render the fixture straight-on (camera at the fixture center). marginFactor
    // is small so the fixture nearly fills the render frame for maximum
    // resolution; the trim below removes the slack and the 2D scale sets the
    // on-screen size.
    const renderPx = input.renderPx ?? (input.preview ? 900 : 1600);
    // A little slack so extreme tilts never clip the fixture; trim removes it.
    const pose: ModelRenderPose = { ...placement.pose, marginFactor: 1.15 };
    const rendered = await renderer.render({
      modelPath: meta.modelPath,
      modelUrl: meta.modelUrl,
      sku: meta.sku,
      pose,
      width: renderPx,
      height: renderPx,
      samples: input.samples,
      highQuality: input.highQuality,
      lightsOn: true,
      // A final at the High/Max tiers (caustics on, hi-res, many samples) can take
      // well over an hour on a crystal fixture on a CPU box; previews stay fast and
      // bounded. The preview cap must clear a COLD Modal container (boot + OptiX
      // kernel compile + 300MB .blend load before pixels) and Modal's 150s
      // single-request cap, so it sits at several minutes. The final cap sits above
      // the worker's Blender hard-cap so the worker's clean timeout surfaces.
      timeoutMs: input.preview ? 300_000 : RENDER_FINAL_TIMEOUT_MS,
    });

    // Tight-trim transparent margins so the fixture's own bbox drives sizing.
    let trimmed = await sharp(rendered).trim().png().toBuffer();
    const tmeta = await sharp(trimmed).metadata();
    const tw = tmeta.width ?? renderPx;
    const th = tmeta.height ?? renderPx;

    // The fixture's light slider scales its glow/exposure on the cutout (the old
    // path drove IES power; here it's a brightness multiplier on the rendered
    // fixture). 50 = neutral with a squared response, matching composite.py's
    // slider curve so clean styles track the studio style.
    const brightness = Math.min(2, Math.max(0.5, (placement.brightness / 50) ** 2));
    if (Math.abs(brightness - 1) > 0.01) {
      trimmed = await sharp(trimmed).modulate({ brightness }).png().toBuffer();
    }

    // Contain-fit into a square box of side = coverage * room height (matches the
    // model-viewer element box), then center at (xPct, yPct).
    const boxSide = Math.max(8, placement.coverage * RH * FRAME_MARGIN);
    const scale = Math.min(boxSide / tw, boxSide / th);
    const fw = Math.max(2, Math.round(tw * scale));
    const fh = Math.max(2, Math.round(th * scale));
    const scaled = await sharp(trimmed).resize(fw, fh, { fit: "fill" }).png().toBuffer();
    const left = placement.xPct * RW - fw / 2;
    const top = placement.yPct * RH - fh / 2;

    const fixtureLayer = await fixtureLayerOnCanvas(scaled, fw, fh, left, top, RW, RH);

    // Optional soft drop shadow, laid down UNDER the fixture (its own full-canvas
    // layer so it can be a separate PSD layer and stays alpha-preserving).
    let shadowLayer: Buffer | null = null;
    if (input.dropShadow) {
      const sh = await buildShadow(scaled, fh);
      const sm = await sharp(sh.buf).metadata();
      shadowLayer = await fixtureLayerOnCanvas(
        sh.buf,
        sm.width ?? fw,
        sm.height ?? fh,
        left - sh.pad + sh.offX,
        top - sh.pad + sh.offY,
        RW,
        RH,
      );
    }
    placed.push({ fixtureLayer, shadowLayer });
  }

  const overlays = placed.flatMap((p) =>
    p.shadowLayer
      ? [
          { input: p.shadowLayer, left: 0, top: 0 },
          { input: p.fixtureLayer, left: 0, top: 0 },
        ]
      : [{ input: p.fixtureLayer, left: 0, top: 0 }],
  );
  const beauty = await sharp(room).composite(overlays).png().toBuffer();

  if (input.preview || !(input.layers ?? true)) {
    return { png: beauty };
  }

  const avif = await sharp(beauty).avif({ quality: 60, effort: 4 }).toBuffer();
  const [bg, merged] = await Promise.all([
    toImageData(room, RW, RH),
    toImageData(beauty, RW, RH),
  ]);
  const children: Parameters<typeof writePsd>[0]["children"] = [
    { name: "Background", imageData: bg },
  ];
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i]!;
    const sku = entries[i]!.meta.sku;
    const suffix = placed.length === 1 ? "" : ` ${i + 1} — ${sku}`;
    if (p.shadowLayer) {
      children.push({
        name: `Shadow${suffix}`,
        imageData: await toImageData(p.shadowLayer, RW, RH),
      });
    }
    children.push({
      name: `Fixture${suffix}`,
      imageData: await toImageData(p.fixtureLayer, RW, RH),
    });
  }
  const psd = Buffer.from(
    writePsd({ width: RW, height: RH, imageData: merged, children }),
  );
  return { png: beauty, avif, psd };
}

/**
 * Export the fixture (no studio rig / lamps) to a GLB for the web 3D viewer.
 * Resolves the SKU's .blend and delegates to the render-worker exporter.
 */
export async function exportFixtureGlb(
  sku: string,
  adapters: ImageGenAdapters,
): Promise<Buffer> {
  const meta = await resolveFixture(sku);
  const renderer = adapters.modelRenderer;
  if (!renderer) {
    throw new Error(
      "3D app-shot requires a configured render-worker (set RENDER_WORKER_URL)",
    );
  }
  return renderer.exportGlb({
    modelPath: meta.modelPath,
    modelUrl: meta.modelUrl,
    sku: meta.sku,
  });
}

export interface FinalRenderInput extends RoomRef {
  /** Legacy single-fixture shape. */
  sku?: string;
  placement?: Placement;
  /** Multi-fixture shape: rendered back-to-front in list order. */
  fixtures?: ShotFixturePlacement[];
  samples?: number;
  highQuality?: boolean;
  /** Render at this multiple of target then downscale (crisp fixture AA). */
  supersample?: number;
  /** Upscale the room so its long edge is >= this many px (more fixture pixels). */
  finalLongEdge?: number;
  /**
   * Cam Solve render style. `studio` (default) runs the in-Blender catcher
   * composite; `clean`/`cleanShadow` run the flat layered cutout (alpha
   * preserved), with `cleanShadow` adding a soft drop shadow.
   */
  renderStyle?: RenderStyle;
  /** Quality tier (samples + caustics + resolution). Defaults to standard. */
  renderQuality?: RenderQuality;
}

/** Full-quality, layered final export (PNG + AVIF + PSD). */
export async function finalRender(
  input: FinalRenderInput,
  adapters: ImageGenAdapters,
): Promise<CompositeResult> {
  const list: ShotFixturePlacement[] = input.fixtures?.length
    ? input.fixtures
    : input.sku && input.placement
      ? [{ sku: input.sku, placement: input.placement }]
      : [];
  if (!list.length) {
    throw new Error("final render needs fixtures[] or a sku + placement");
  }
  if (!input.roomUrl && !input.roomPath) {
    throw new Error("final render requires a roomUrl or roomPath");
  }
  const entries: ShotFixtureEntry[] = await Promise.all(
    list.map(async (f) => ({
      meta: await resolveFixture(f.sku),
      placement: f.placement,
    })),
  );
  // The studio style runs the in-Blender catcher composite so the fixture emits
  // real light (IES spill / lamp glow + contact shadow) and reads as part of the
  // scene; the clean styles run the flat layered cutout and preserve alpha (the
  // lever for a crisp fixture there is finalLongEdge inside the composite path).
  return renderShotImage(
    entries,
    {
      preview: false,
      layers: true,
      renderStyle: input.renderStyle,
      // The quality tier drives samples + caustics + resolution; explicit
      // samples/highQuality/finalLongEdge below still override it when set.
      renderQuality: input.renderQuality,
      roomUrl: input.roomUrl,
      roomPath: input.roomPath,
      samples: input.samples,
      highQuality: input.highQuality,
      // The fixture only fills ~30% of the frame, so the lever for a crisp,
      // zoom-proof fixture is OUTPUT RESOLUTION: the worker upscales the room to
      // finalLongEdge and renders the composite there. At that high native res +
      // high samples, extra supersampling isn't worth its (large) cost.
      supersample: input.supersample ?? 1.0,
      finalLongEdge: input.finalLongEdge,
    },
    adapters,
  );
}
