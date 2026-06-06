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
import type {
  CompositeResult,
  ImageGenAdapters,
  ModelRenderPose,
  PlacementAdjust,
} from "./ai/adapter.js";

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
  /** Local path (POC, same host as the worker). */
  modelPath?: string;
  /** Or a URL the worker fetches (production). */
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
 * Hardcoded POC fixture map (2 samples). Paths are local because the render
 * worker runs on the same machine for the POC; production swaps these for the
 * Monday.com/Lucid URLs (modelUrl/iesUrl) with no other changes.
 */
export const FIXTURE_MAP: Record<string, FixtureMeta> = {
  "bwsw58618-bk": {
    sku: "bwsw58618-bk",
    modelPath:
      "/Users/davis/Downloads/bwsw58618-bk_pro_scn010_lighting_v001.blend",
    iesPath: "/Users/davis/Downloads/BWSW58618-3000-120325_IES.IES",
    fixtureType: "wall sconce",
    mount: "wall",
    pose: { azimuthDeg: -8, elevationDeg: 2, fovDeg: 30 },
    coverage: 0.34,
  },
  "ma1012n-48o": {
    sku: "ma1012n-48o",
    modelPath:
      "/Users/davis/Downloads/11405375040_ma1012n-48o_pro_scn010_lighting_v002_pub.blend",
    // Decorative chandelier: no IES file — falls back to its own lamps for spill.
    fixtureType: "chandelier",
    mount: "ceiling",
    // A ceiling fixture is photographed from BELOW (camera at standing height,
    // fixture overhead), so look up into it — a catalog "from above" angle reads
    // as pasted-on when composited into a room.
    pose: { azimuthDeg: 0, elevationDeg: -18, fovDeg: 36 },
    coverage: 0.34,
  },
};

export function resolveFixture(sku: string): FixtureMeta {
  const meta = FIXTURE_MAP[sku.toLowerCase()];
  if (!meta) {
    throw new Error(
      `no 3D model mapped for SKU "${sku}" (POC supports: ${Object.keys(FIXTURE_MAP).join(", ")})`,
    );
  }
  return meta;
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
   * Use the straight-on 2D-layered render (the WYSIWYG 3D-viewer path) instead of
   * the in-Blender catcher composite (the fallback). The critic loop is only
   * meaningful for the old path, so callers set this with skipCritic.
   */
  straightOn?: boolean;
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
    brightness: over?.brightness ?? 25,
    lightOutput: over?.lightOutput ?? 25,
    warm: over?.warm ?? 0.45,
    pose: over?.pose ?? meta.pose,
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
  const meta = resolveFixture(input.sku);
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
 * Auto-place the fixture and let the AI critic correct it in a hidden loop. Each
 * round does a fast preview render, then the critic returns absolute corrections;
 * we stop on approval or after `maxIterations`. Without a critic (no Gemini key)
 * it does a single preview and returns it as approved.
 */
export async function autoPlace(
  input: AutoPlaceInput,
  adapters: ImageGenAdapters,
): Promise<AutoPlaceResult> {
  const meta = resolveFixture(input.sku);
  const compositor = adapters.compositor;
  if (!compositor) {
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
    // Always use the in-Blender catcher composite so the fixture actually emits
    // light into the room (IES spill / lamp glow, contact shadow) — the flat
    // straight-on layer (`layeredShot`) is placement-only and never looked lit.
    const r = await compositor.composite({
      preview: true,
      modelPath: meta.modelPath,
      modelUrl: meta.modelUrl,
      sku: meta.sku,
      iesPath: meta.iesPath,
      iesUrl: meta.iesUrl,
      roomUrl: input.roomUrl,
      roomPath: input.roomPath,
      pose: placement.pose,
      coverage: placement.coverage,
      xPct: placement.xPct,
      yPct: placement.yPct,
      brightness: placement.brightness,
      lightOutput: placement.lightOutput,
      warm: placement.warm,
    });
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
  const meta = resolveFixture(input.sku);
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
}

/**
 * Render the fixture straight-on and composite it onto the room as a positioned
 * 2D layer (the WYSIWYG path that matches the 3D viewer). Returns PNG always,
 * plus AVIF + a positioned layered PSD (Background / Fixture) on final exports.
 */
export async function layeredShot(
  meta: FixtureMeta,
  placement: Placement,
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

  // Render the fixture straight-on (camera at the fixture center). marginFactor is
  // small so the fixture nearly fills the render frame for maximum resolution; the
  // trim below removes the slack and the 2D scale sets the on-screen size.
  const renderPx = input.preview ? 900 : 1600;
  // A little slack so extreme tilts never clip the fixture; trim removes it.
  const pose: ModelRenderPose = { ...placement.pose, marginFactor: 1.15 };
  const rendered = await renderer.render({
    modelPath: meta.modelPath,
    modelUrl: meta.modelUrl,
    sku: meta.sku,
    pose,
    width: renderPx,
    height: renderPx,
    samples: input.preview ? 24 : input.samples,
    lightsOn: true,
  });

  // Tight-trim transparent margins so the fixture's own bbox drives sizing.
  let trimmed = await sharp(rendered).trim().png().toBuffer();
  let tmeta = await sharp(trimmed).metadata();
  let tw = tmeta.width ?? renderPx;
  let th = tmeta.height ?? renderPx;

  // The fixture's light slider scales its glow/exposure on the cutout (the old
  // path drove IES power; here it's a brightness multiplier on the rendered
  // fixture, 25 = neutral).
  const brightness = Math.min(2, Math.max(0.5, placement.brightness / 25));
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
  const beauty = await sharp(room)
    .composite([{ input: fixtureLayer, left: 0, top: 0 }])
    .png()
    .toBuffer();

  if (input.preview || !(input.layers ?? true)) {
    return { png: beauty };
  }

  const avif = await sharp(beauty).avif({ quality: 60, effort: 4 }).toBuffer();
  const [bg, fixtureData, merged] = await Promise.all([
    toImageData(room, RW, RH),
    toImageData(fixtureLayer, RW, RH),
    toImageData(beauty, RW, RH),
  ]);
  const psd = Buffer.from(
    writePsd({
      width: RW,
      height: RH,
      imageData: merged,
      children: [
        { name: "Background", imageData: bg },
        { name: "Fixture", imageData: fixtureData },
      ],
    }),
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
  const meta = resolveFixture(sku);
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
  sku: string;
  placement: Placement;
  samples?: number;
  highQuality?: boolean;
  /** Render at this multiple of target then downscale (crisp fixture AA). */
  supersample?: number;
  /** Upscale the room so its long edge is >= this many px (more fixture pixels). */
  finalLongEdge?: number;
  /** Use the straight-on 2D-layered render (WYSIWYG 3D-viewer path). */
  straightOn?: boolean;
}

/** Full-quality, layered final export (PNG + AVIF + PSD). */
export async function finalRender(
  input: FinalRenderInput,
  adapters: ImageGenAdapters,
): Promise<CompositeResult> {
  const meta = resolveFixture(input.sku);
  if (!input.roomUrl && !input.roomPath) {
    throw new Error("final render requires a roomUrl or roomPath");
  }
  const p = input.placement;
  const compositor = adapters.compositor;
  if (!compositor) {
    throw new Error(
      "3D app-shot requires a configured render-worker (set RENDER_WORKER_URL)",
    );
  }
  // The final export always runs the in-Blender catcher composite so the fixture
  // emits real light (IES spill / lamp glow + contact shadow) and reads as part
  // of the scene rather than a pasted-on layer.
  return compositor.composite({
    preview: false,
    layers: true,
    modelPath: meta.modelPath,
    modelUrl: meta.modelUrl,
    sku: meta.sku,
    iesPath: meta.iesPath,
    iesUrl: meta.iesUrl,
    roomUrl: input.roomUrl,
    roomPath: input.roomPath,
    pose: p.pose,
    coverage: p.coverage,
    xPct: p.xPct,
    yPct: p.yPct,
    brightness: p.brightness,
    lightOutput: p.lightOutput,
    warm: p.warm,
    samples: input.samples,
    highQuality: input.highQuality ?? true,
    // The fixture only fills ~30% of the frame, so the lever for a crisp,
    // zoom-proof fixture is OUTPUT RESOLUTION: the worker upscales the room to
    // finalLongEdge and renders the composite there, giving the fixture many
    // more pixels. At that high native res + high samples, extra supersampling
    // isn't worth its (large) render-time cost, so keep it off for the final.
    supersample: input.supersample ?? 1.0,
    finalLongEdge: input.finalLongEdge ?? 3840,
  });
}
