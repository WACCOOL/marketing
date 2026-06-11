import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { writePsd } from "ag-psd";

const FETCH_TIMEOUT_MS = Number(process.env.MODEL_FETCH_TIMEOUT_MS ?? 120_000);

/** Download a remote model (.blend/.glb) to a local temp file for Blender. */
async function fetchModel(url: string, destDir: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`failed to fetch model ${url}: ${res.status}`);
  const ext = url.split("?")[0]?.toLowerCase().endsWith(".glb")
    ? ".glb"
    : ".blend";
  const dest = path.join(destDir, `model${ext}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/**
 * WAC render-worker (Phase 3 POC).
 *
 * A tiny HTTP service that shells out to a local Blender to render a product
 * fixture from a .blend onto a transparent background at a caller-supplied
 * camera pose. It is the self-hosted half of the "render real 3D, composite into
 * an AI room" pipeline: the generator calls `POST /render-fixture` and feeds the
 * returned transparent PNG into the existing scale/composite/harmonize engine.
 *
 * POC runs on a developer Mac against a locally-installed Blender 4.5 LTS; the
 * SAME service later deploys to the GPU box (only RENDER_WORKER_URL changes on
 * the generator side). It deliberately has zero npm dependencies.
 */

const PORT = Number(process.env.PORT ?? 8787);
// Path to the Blender executable. macOS default app bundle, overridable.
const BLENDER_BIN =
  process.env.BLENDER_BIN ||
  "/Applications/Blender.app/Contents/MacOS/Blender";
// Hard cap so a *stuck* render can't wedge the worker. Must comfortably exceed
// the slowest legitimate render — the Max quality tier (refractive caustics +
// ~1024 samples + hi-res) can take well over an hour on a CPU box (e.g. a
// MacBook) for a crystal fixture — so the default is deliberately generous and
// only fires on a genuine hang, not a healthy hero render. Raise RENDER_TIMEOUT_MS
// further if a legitimate Max render needs more than the default 60 minutes.
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 3_600_000);
// Where render.py lives, relative to this file at runtime (dist/ -> ../blender).
// Use fileURLToPath so spaces (e.g. the OneDrive path) are decoded, not %20.
const RENDER_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "blender",
  "render.py",
);
const COMPOSITE_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "blender",
  "composite.py",
);
const EXPORT_GLB_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "blender",
  "export_fixture.py",
);

interface Pose {
  azimuthDeg?: number;
  elevationDeg?: number;
  /** Roll about the camera's view axis (side-to-side tilt / lean), in degrees. */
  rollDeg?: number;
  fovDeg?: number;
  distanceFactor?: number;
  marginFactor?: number;
}

interface RenderRequest {
  /** Local path to the .blend (POC / same-host). */
  modelPath?: string;
  /** URL the worker fetches the model from (.blend/.glb) — used in production. */
  modelUrl?: string;
  /** SKU used to pick the fixture collection inside the .blend. */
  sku?: string;
  /** Reuse one of the file's tuned hero cameras (e.g. "Cam.001") instead of a pose. */
  cameraName?: string;
  pose?: Pose;
  width?: number;
  height?: number;
  /** "BLENDER_EEVEE_NEXT" (fast, default) or "CYCLES" (higher fidelity). */
  engine?: string;
  samples?: number;
  /** Enable the file's refractive caustics (the slow, glass/crystal sparkle). */
  highQuality?: boolean;
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Run Blender headless with render.py; resolve with the rendered PNG bytes. */
async function renderFixture(reqBody: RenderRequest): Promise<Buffer> {
  if (!reqBody.modelPath && !reqBody.modelUrl) {
    throw new Error("render request needs a modelPath or modelUrl");
  }
  if (!existsSync(BLENDER_BIN)) {
    throw new Error(
      `Blender not found at ${BLENDER_BIN}; set BLENDER_BIN to your Blender executable`,
    );
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "wac-render-"));
  const jobPath = path.join(dir, "job.json");
  const outPath = path.join(dir, "out.png");

  try {
    // Resolve the model to a local path: use modelPath as-is, else download.
    let modelPath = reqBody.modelPath;
    if (!modelPath && reqBody.modelUrl) {
      modelPath = await fetchModel(reqBody.modelUrl, dir);
    }
    if (!modelPath || !existsSync(modelPath)) {
      throw new Error(`model not found: ${modelPath ?? reqBody.modelUrl}`);
    }

    // Pass engine/samples through only when set so render.py keeps the file's
    // authored Cycles settings (tuned for the glass) by default.
    const job = {
      modelPath,
      sku: reqBody.sku,
      cameraName: reqBody.cameraName,
      pose: reqBody.pose ?? {},
      width: reqBody.width ?? 1024,
      height: reqBody.height ?? 1024,
      engine: reqBody.engine,
      samples: reqBody.samples,
      highQuality: reqBody.highQuality,
    };

    await writeFile(jobPath, JSON.stringify(job));
    await runBlender(RENDER_SCRIPT, modelPath, jobPath, outPath);
    if (!existsSync(outPath)) {
      throw new Error("Blender finished but produced no output image");
    }
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Serialize Blender so only ONE render runs at a time on this box. Concurrent
// GPU (Metal) renders can hang the whole machine, so every spawn goes through
// this single-slot queue regardless of which endpoint or client triggered it.
let blenderQueue: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = blenderQueue.then(fn, fn);
  blenderQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Runs Blender headless; resolves with the captured stdout+stderr on success. */
function runBlender(
  scriptPath: string,
  modelPath: string,
  jobPath: string,
  outPath: string,
): Promise<string> {
  return runExclusive(
    () =>
      new Promise<string>((resolve, reject) => {
    const args = [
      "-b",
      modelPath,
      "-P",
      scriptPath,
      "--",
      "--job",
      jobPath,
      "--out",
      outPath,
    ];
    const child = spawn(BLENDER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    const label = scriptPath.split("/").pop() ?? scriptPath;
    const startedAt = Date.now();

    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      // Surface key Blender lines (compute device, our [render]/[composite] tags)
      // to the worker console so they show up in `modal app logs` — otherwise the
      // chosen GPU/CPU device and per-stage timings are invisible on success.
      for (const line of s.split("\n")) {
        if (/compute=|\[render\.py\]|\[composite|\[export/.test(line)) {
          console.log(`[blender:${label}] ${line.trim()}`);
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Blender render timed out after ${RENDER_TIMEOUT_MS}ms`));
    }, RENDER_TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[worker] ${label} finished in ${secs}s (exit ${code})`);
      if (code === 0) return resolve(stdout + stderr);
      const tail = (stderr || stdout).split("\n").slice(-20).join("\n");
      reject(new Error(`Blender exited ${code}:\n${tail}`));
    });
      }),
  );
}

interface ExportGlbRequest {
  /** Local path to the .blend (POC / same-host). */
  modelPath?: string;
  /** URL the worker fetches the .blend from (production). */
  modelUrl?: string;
  /** SKU used to pick the fixture collection inside the .blend. */
  sku?: string;
}

/**
 * Export just the fixture from a .blend to a GLB for the web 3D viewer. Reuses
 * the serialized Blender queue (`runBlender`) so it never competes with a render.
 */
async function exportGlb(reqBody: ExportGlbRequest): Promise<Buffer> {
  if (!reqBody.modelPath && !reqBody.modelUrl) {
    throw new Error("export-glb request needs a modelPath or modelUrl");
  }
  if (!existsSync(BLENDER_BIN)) {
    throw new Error(`Blender not found at ${BLENDER_BIN}; set BLENDER_BIN`);
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "wac-glb-"));
  const jobPath = path.join(dir, "job.json");
  const outPath = path.join(dir, "fixture.glb");

  try {
    let modelPath = reqBody.modelPath;
    if (!modelPath && reqBody.modelUrl) {
      modelPath = await fetchModel(reqBody.modelUrl, dir);
    }
    if (!modelPath || !existsSync(modelPath)) {
      throw new Error(`model not found: ${modelPath ?? reqBody.modelUrl}`);
    }

    await writeFile(jobPath, JSON.stringify({ sku: reqBody.sku }));
    const log = await runBlender(EXPORT_GLB_SCRIPT, modelPath, jobPath, outPath);
    if (!existsSync(outPath)) {
      // Blender exited 0 but wrote no file. Usually the glTF exporter returned
      // CANCELLED (fixture-specific material/geometry it rejects) or
      // export_fixture.py found nothing to export. runBlender only surfaces
      // output on a NON-zero exit, so include the tail here or the reason is
      // lost behind a generic message.
      const tail = log
        .split("\n")
        .filter((l) => l.trim())
        .slice(-25)
        .join("\n");
      throw new Error(`Blender finished but produced no GLB:\n${tail}`);
    }
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Cam Solve room-match, computed client-side (see @wac/shared roomcalib). The
 * worker forwards it verbatim into the composite.py job; Blender builds a camera
 * from `camera.{right,up,forward,fovDeg}` (camera axes in a Z-up world frame) and
 * lights real ceiling/wall/floor planes instead of a camera-facing billboard.
 */
interface RoomGeometryPayload {
  imageAspect: number;
  /** Legacy line-tracing input (optional since the room-box flow replaced it). */
  axes?: Array<{
    axis: "horizontalA" | "horizontalB" | "vertical";
    lines: Array<{ a: { x: number; y: number }; b: { x: number; y: number } }>;
  }>;
  /** Room-box calibration (corner drag): the solved metric box. When present,
   * runComposite renders ALL fixtures in ONE Blender scene built from these
   * extents (floor z=0, camera at plan origin) instead of chaining. */
  box?: {
    corners?: Record<string, { x: number; y: number }>;
    ceilingHeightM?: number;
    assumedFovDeg?: number;
    solved: {
      mode: "one-point" | "two-point";
      fovDeg: number;
      cameraHeightM: number;
      box: { xMin: number; xMax: number; yBack: number; yFront: number; height: number };
    };
  };
  camera: {
    fovDeg: number;
    right: Vec3;
    up: Vec3;
    forward: Vec3;
    worldUp: Vec3;
  };
}

/** Mount-surface attachment inside a solved room box (true-scale placement). */
interface SurfacePayload {
  kind: "ceiling" | "wall-back" | "wall-left" | "wall-right" | "floor";
  u: number;
  v: number;
  scale: number;
  lightYawDeg: number;
}

/** One fixture in a (multi-fixture) composite — its model, photometry and placement. */
interface CompositeFixture {
  /** Local path to the .blend, or a URL the worker downloads. */
  modelPath?: string;
  modelUrl?: string;
  sku?: string;
  /** Manufacturer IES photometry for the fixture's light spill (path or URL). */
  iesPath?: string;
  iesUrl?: string;
  iesRotation?: [number, number, number];
  /** Mounting type ("ceiling" | "wall" | "floor" | "recessed") — orients the catcher. */
  mount?: string;
  pose?: Pose;
  cameraName?: string;
  /** Fixture height as a fraction of the frame (0..1). */
  coverage?: number;
  /** Screen position of the fixture center (0..1). */
  xPct?: number;
  yPct?: number;
  /** Fixture-brightness slider (0..100, 50 = calibrated) -> fixture's own glow. */
  brightness?: number;
  /** Light-output slider (0..100, 50 = calibrated) -> IES power / own lamps. */
  lightOutput?: number;
  /** Warmth of the fixture light (0..1). */
  warm?: number;
  /** Room-box relight sliders (0..200, 50 = the physical ratio): how strongly
   * the light-spots / shadows maps read on the photo. Scene-level — taken
   * from the FIRST fixture, like roomGeometry. */
  highlights?: number;
  shadows?: number;
  /** Mount-surface attachment inside a solved room box (true-scale placement). */
  surface?: SurfacePayload;
}

interface CompositeRequest extends CompositeFixture {
  /** Multi-fixture form: rendered back-to-front in list order, chained so each
   * fixture lights a plate that already carries the previous fixtures. When
   * absent, the legacy single-fixture fields on the request itself are used. */
  fixtures?: CompositeFixture[];
  /** The AI room plate the fixture(s) are composited into (local path or URL). */
  roomPath?: string;
  roomUrl?: string;
  /** Cam Solve room-match (matched camera + real ceiling/wall/floor planes). */
  roomGeometry?: RoomGeometryPayload;
  samples?: number;
  highQuality?: boolean;
  /** Final export emits layered PSD; preview skips it for speed. */
  layers?: boolean;
  /** Fast interactive render: low-res, low-sample, PNG only. */
  preview?: boolean;
  previewMaxPx?: number;
  /** Render at this multiple of target then downscale (crisp fixture AA). */
  supersample?: number;
  /** Final export: upscale the room so its long edge is at least this many px
   * (gives the fixture far more pixels). 0 disables. Default 4000. */
  finalLongEdge?: number;
  /** Room-box relight: how hard the highlight/shadow redistribution reads
   * (1 = physical ratio, <1 compresses toward the untouched photo). */
  relightStrength?: number;
}

/** Download a remote asset (room/ies) to a local temp file for Blender. */
async function fetchTo(url: string, dest: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/** A PNG file -> ag-psd ImageData (RGBA), resized to the canvas if needed. */
async function toImageData(file: string, width: number, height: number) {
  const { data, info } = await sharp(file)
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

/**
 * The fixture's own glow/glare as an additive layer: (full - base) per pixel,
 * carrying the full pass's alpha so it only adds over the fixture. Composited with
 * "linear dodge" over the base fixture it reconstructs the lit fixture; lowering
 * the layer's opacity dials the fixture's light (and the glare hotspot) down.
 */
async function glowImageData(
  full: string,
  base: string,
  width: number,
  height: number,
) {
  const f = await toImageData(full, width, height);
  const b = await toImageData(base, width, height);
  const out = new Uint8ClampedArray(f.data.length);
  for (let i = 0; i < f.data.length; i += 4) {
    out[i] = Math.max(0, (f.data[i] ?? 0) - (b.data[i] ?? 0));
    out[i + 1] = Math.max(0, (f.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0));
    out[i + 2] = Math.max(0, (f.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
    out[i + 3] = f.data[i + 3] ?? 0;
  }
  return { width: f.width, height: f.height, data: out };
}

// sRGB <-> linear for the relight math: the wall passes are Standard/sRGB
// encodings of linear scene light, and light ratios are only meaningful in
// LINEAR space.
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/**
 * Relight the room photo by the fixtures' effect, as TWO separately dialable
 * components (Davis's Photoshop model — a subtle lighten layer + a subtle
 * multiply layer):
 *
 *   gain = lit / base   (linear, per channel; both passes share the room's
 *                        base light, so untouched areas divide to exactly 1)
 *   H = max(gain, 1)    the LIGHT-SPOTS map (where fixtures throw light)
 *   S = min(gain, 1)    the SHADOWS map (where fixtures block base light)
 *   out = photo × H^highlights × S^shadows
 *
 * `highlights` / `shadows` are exponents from the editor sliders (1 = the
 * physical ratio, 0 = off, >1 amplified). Writes the final plate to `outPath`
 * and, when `shadowsOutPath` is given, a shadows-only plate (photo × S^σ) so
 * the PSD can carry "Shadows" and "Light + Shadow" as separate layers.
 */
async function relightPlate(
  photoPath: string,
  litPath: string,
  basePath: string,
  outPath: string,
  highlights = 1,
  shadows = 1,
  shadowsOutPath?: string,
): Promise<void> {
  const meta = await sharp(litPath).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error("relight: unreadable wall pass");
  // The gain map is low-frequency by nature (light gradients), but it is the
  // QUOTIENT of two renders — Cycles noise and denoiser splotches in the dark
  // base amplify into speckle/banding. A gentle blur of both passes before
  // dividing kills that; real shadow/highlight edges this soft survive fine.
  const blurSigma = Math.max(1.2, w / 500);
  const [photo, lit, ambient] = await Promise.all([
    sharp(photoPath).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer(),
    sharp(litPath).blur(blurSigma).removeAlpha().raw().toBuffer(),
    sharp(basePath).blur(blurSigma).removeAlpha().raw().toBuffer(),
  ]);
  const out = Buffer.alloc(photo.length);
  const shadowOut = shadowsOutPath ? Buffer.alloc(photo.length) : null;
  let maxGain = 0;
  let minGain = Infinity;
  for (let i = 0; i < out.length; i++) {
    const l = SRGB_TO_LINEAR[lit[i]!]!;
    const b = Math.max(SRGB_TO_LINEAR[ambient[i]!]!, 5e-4);
    const raw = Math.max(l / b, 0.1);
    // Soft knee on the highlight side — a hard cap clips pool edges into flat
    // blown patches (the "harsh" look). Saturates smoothly toward 4.
    const kneed = raw > 1 ? 1 + (raw - 1) / (1 + (raw - 1) / 3) : raw;
    const hGain = Math.pow(Math.max(kneed, 1), highlights);
    const sGain = Math.pow(Math.min(kneed, 1), shadows);
    if (kneed > maxGain) maxGain = kneed;
    if (kneed < minGain) minGain = kneed;
    const p = SRGB_TO_LINEAR[photo[i]!]!;
    out[i] = linearToSrgb(p * hGain * sGain);
    if (shadowOut) shadowOut[i] = linearToSrgb(p * sGain);
  }
  console.log(
    `[render-worker] relight: gain ${minGain.toFixed(2)}..${maxGain.toFixed(2)} ` +
      `(highlights ${highlights.toFixed(2)}, shadows ${shadows.toFixed(2)}, blur ${blurSigma.toFixed(1)})`,
  );
  await sharp(out, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(outPath);
  if (shadowOut && shadowsOutPath) {
    await sharp(shadowOut, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toFile(shadowsOutPath);
  }
}

/** One rendered fixture's PSD inputs: the hi-res cutout (+ optional unlit base). */
interface FixtureLayerFiles {
  label: string;
  fixture: string;
  base?: string;
}

/**
 * Build a layered PSD the design team can edit in Photoshop:
 *   - Background  (the AI room plate)
 *   - Light + Shadow (ALL fixtures' accumulated wall wash + contact shadows)
 *   - per fixture, bottom-to-top in list order:
 *       Fixture [i]       (the product, transparent cutout)
 *       Fixture [i] Glow  (additive self-light, when the base pass exists)
 * The flattened beauty is stored as the merged preview so the PSD opens looking
 * exactly like the final render. A single fixture keeps the exact layer names
 * the team's Photoshop workflow already expects (Fixture / Fixture Glow).
 */
async function assemblePsd(
  beauty: string,
  wall: string,
  room: string,
  fixtures: FixtureLayerFiles[],
  /** Room-box relight: a shadows-only plate, layered under "Light + Shadow"
   * so the team can dial shadows and light spots separately in Photoshop. */
  shadowsPlate?: string,
): Promise<Buffer> {
  const meta = await sharp(beauty).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const [bg, wallLayer, merged] = await Promise.all([
    toImageData(room, width, height),
    toImageData(wall, width, height),
    toImageData(beauty, width, height),
  ]);

  const children: Parameters<typeof writePsd>[0]["children"] = [
    { name: "Background", imageData: bg },
  ];
  if (shadowsPlate && existsSync(shadowsPlate)) {
    children.push({
      name: "Shadows",
      imageData: await toImageData(shadowsPlate, width, height),
    });
  }
  children.push({ name: "Light + Shadow", imageData: wallLayer });

  for (const f of fixtures) {
    // When the self-light-off pass exists, split the fixture into an unlit base +
    // an adjustable additive glow on top; otherwise fall back to one layer.
    if (f.base && existsSync(f.base)) {
      const [baseLayer, glow] = await Promise.all([
        toImageData(f.base, width, height),
        glowImageData(f.fixture, f.base, width, height),
      ]);
      children.push({ name: f.label, imageData: baseLayer });
      children.push({
        name: `${f.label} Glow`,
        imageData: glow,
        blendMode: "linear dodge",
      });
    } else {
      children.push({ name: f.label, imageData: await toImageData(f.fixture, width, height) });
    }
  }

  const psd = { width, height, imageData: merged, children };
  return Buffer.from(writePsd(psd));
}

interface CompositeArtifacts {
  png: Buffer;
  avif?: Buffer;
  psd?: Buffer;
}

/**
 * Render the fixture(s) into the room and produce the requested deliverables.
 *
 * Multi-fixture shots run as CHAINED single-fixture Blender renders (each
 * fixture's pose is its own orbit camera, so they cannot share one render):
 * fixture i renders against a plate that already carries fixtures 1..i-1.
 *  - preview: the plate is the previous beauty (fixture body baked in).
 *  - final (layers): the plate is the previous WALL pass (room + accumulated
 *    light/shadow, fixture bodies hidden) so each cutout stays a clean PSD
 *    layer; the bodies are composited at the end, hi-res, in list order.
 * Chaining is stable because composite.py pins the Standard/sRGB view transform,
 * so a plate re-renders as itself.
 */
async function runComposite(body: CompositeRequest): Promise<CompositeArtifacts> {
  // Legacy single-fixture requests carry the fixture fields on the body itself.
  const fixtures: CompositeFixture[] = body.fixtures?.length
    ? body.fixtures
    : [body];
  for (const f of fixtures) {
    if (!f.modelPath && !f.modelUrl) {
      throw new Error("composite request needs a modelPath or modelUrl per fixture");
    }
  }
  if (!body.roomPath && !body.roomUrl) {
    throw new Error("composite request needs a roomPath or roomUrl");
  }
  if (!existsSync(BLENDER_BIN)) {
    throw new Error(`Blender not found at ${BLENDER_BIN}; set BLENDER_BIN`);
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "wac-composite-"));

  try {
    let roomPath = body.roomPath;
    if (!roomPath && body.roomUrl) {
      roomPath = await fetchTo(body.roomUrl, path.join(dir, "room.png"));
    }
    if (!roomPath || !existsSync(roomPath)) {
      throw new Error(`room not found: ${roomPath ?? body.roomUrl}`);
    }

    const preview = body.preview ?? false;
    // Preview is a fast single render; final emits the layered PSD.
    const layers = preview ? false : body.layers ?? true;

    // The fixture only fills ~30% of the frame height, so on a 2K room it lands at
    // ~330px and falls apart when zoomed, even though the photographic room stays
    // sharp. The fix is OUTPUT RESOLUTION — but only the 3D fixture needs the extra
    // pixels (the room is a photo; its light/shadow are low-frequency). So for the
    // FINAL we render the fixture cutouts BIG (fixtureScale) while the wall/light
    // passes stay at room res, then compose the beauty here: the crisp hi-res
    // fixture over the upscaled wall — exactly the manual hi-res-cutout-on-
    // background workflow, at a fraction of an all-4K render's cost.
    // Computed ONCE from the original room so every fixture in the chain renders
    // its cutout at the same hi-res dimensions.
    let fixtureScale = 1;
    const composeBeauty = !preview && layers;
    if (!preview) {
      // Default to the CG team's 4000px final long edge so cloud finals match
      // the studio's render.st output resolution (override per-request).
      const target = Math.max(0, body.finalLongEdge ?? 4000);
      if (target > 0) {
        const rmeta = await sharp(roomPath).metadata();
        const long = Math.max(rmeta.width ?? 0, rmeta.height ?? 0);
        if (long > 0 && target > long) fixtureScale = target / long;
      }
    }

    // Two identical pendants share a .blend/.ies — download each URL once.
    const fetched = new Map<string, string>();
    const fetchOnce = async (url: string, kind: "model" | "ies", i: number) => {
      const hit = fetched.get(url);
      if (hit) return hit;
      const fdir = path.join(dir, `f${i}`);
      await mkdir(fdir, { recursive: true });
      const local =
        kind === "model"
          ? await fetchModel(url, fdir)
          : await fetchTo(url, path.join(fdir, "fixture.ies"));
      fetched.set(url, local);
      return local;
    };

    let plate = roomPath;
    let shadowsPlate: string | undefined;
    const rendered: Array<{ sku?: string; out: string; fixture: string; base?: string }> = [];

    // Room-box render: ONE Blender scene with the photo's solved camera, the
    // metric room geometry, and ALL fixtures — light from every fixture sums
    // physically in a single linear render (no chaining, no accumulated wash).
    const roomBox = body.roomGeometry?.box?.solved ? body.roomGeometry : undefined;
    if (roomBox) {
      const resolved = await Promise.all(
        fixtures.map(async (f, i) => {
          let modelPath = f.modelPath;
          if (!modelPath && f.modelUrl) modelPath = await fetchOnce(f.modelUrl, "model", i);
          if (!modelPath || !existsSync(modelPath)) {
            throw new Error(`model not found: ${modelPath ?? f.modelUrl}`);
          }
          let iesPath = f.iesPath;
          if (!iesPath && f.iesUrl) iesPath = await fetchOnce(f.iesUrl, "ies", i);
          return { ...f, modelPath, iesPath };
        }),
      );
      const outPath = path.join(dir, "shot.png");
      const jobPath = path.join(dir, "job.json");
      const job = {
        roomPath,
        roomGeometry: roomBox,
        fixtures: resolved.map((f) => ({
          modelPath: f.modelPath,
          sku: f.sku,
          iesPath: f.iesPath,
          mount: f.mount,
          surface: f.surface,
          xPct: f.xPct ?? 0.5,
          yPct: f.yPct ?? 0.5,
          coverage: f.coverage ?? 0.34,
          brightness: f.brightness ?? 50,
          lightOutput: f.lightOutput ?? 50,
          warm: f.warm ?? 0.45,
        })),
        samples: body.samples,
        highQuality: body.highQuality,
        layers,
        preview,
        previewMaxPx: body.previewMaxPx,
        supersample: body.supersample,
        fixtureScale,
        composeBeauty,
      };
      await writeFile(jobPath, JSON.stringify(job));
      await runBlender(COMPOSITE_SCRIPT, resolved[0]!.modelPath!, jobPath, outPath);

      // Relight the photo with the fixtures' light ratio (see relightPlate) —
      // the room-box path never renders a direct beauty.
      const wallLit = `${outPath.slice(0, -4)}_wall.png`;
      const wallBase = `${outPath.slice(0, -4)}_wallbase.png`;
      if (!existsSync(wallLit) || !existsSync(wallBase)) {
        throw new Error("Blender did not produce the room-box relight passes");
      }
      const relitPlate = path.join(dir, "plate.png");
      // The Highlights/Shadows sliders are scene-level (the relight is one
      // combined map for all fixtures) — they ride on the first fixture, like
      // roomGeometry. Slider 50 = the physical ratio; 0 = off; 100 ≈ 2.3×.
      // `relightStrength` remains a global calibration multiplier on both.
      const sliderExp = (v: number | undefined) => Math.pow((v ?? 50) / 50, 1.2);
      const calib = body.relightStrength ?? 1;
      shadowsPlate = path.join(dir, "plate-shadows.png");
      await relightPlate(
        roomPath, wallLit, wallBase, relitPlate,
        sliderExp(fixtures[0]?.highlights) * calib,
        sliderExp(fixtures[0]?.shadows) * calib,
        preview ? undefined : shadowsPlate,
      );

      const cutouts: typeof rendered = [];
      for (let i = 0; i < resolved.length; i++) {
        const fixturePath = `${outPath.slice(0, -4)}_fixture${i}.png`;
        const basePath = `${outPath.slice(0, -4)}_fixture${i}base.png`;
        if (!existsSync(fixturePath)) {
          throw new Error(`Blender did not produce the fixture ${i} cutout pass`);
        }
        cutouts.push({
          sku: resolved[i]!.sku,
          out: outPath,
          fixture: fixturePath,
          base: existsSync(basePath) ? basePath : undefined,
        });
      }
      if (preview) {
        // Preview beauty = cutouts straight over the relit plate (same res).
        await sharp(relitPlate)
          .composite(cutouts.map((r) => ({ input: r.fixture })))
          .png()
          .toFile(outPath);
        plate = outPath;
      } else {
        rendered.push(...cutouts);
        plate = relitPlate;
      }
    }

    // Legacy chain (no room box): one Blender render per fixture, each against
    // the plate that already carries the previous fixtures.
    for (let i = 0; !roomBox && i < fixtures.length; i++) {
      const f = fixtures[i]!;
      let modelPath = f.modelPath;
      if (!modelPath && f.modelUrl) modelPath = await fetchOnce(f.modelUrl, "model", i);
      if (!modelPath || !existsSync(modelPath)) {
        throw new Error(`model not found: ${modelPath ?? f.modelUrl}`);
      }
      let iesPath = f.iesPath;
      if (!iesPath && f.iesUrl) iesPath = await fetchOnce(f.iesUrl, "ies", i);

      const outPath = path.join(dir, `shot${i}.png`);
      const jobPath = path.join(dir, `job${i}.json`);
      const job = {
        modelPath,
        sku: f.sku,
        roomPath: plate,
        // The catcher's light-receptive layer picks up the WORLD ambient as
        // well as fixture light, so every chained pass would re-brighten the
        // plate by ~world*receive. Pass 0 keeps the default (that bake is the
        // accepted single-fixture look); later passes add no ambient drift.
        worldStrength: i === 0 ? undefined : 0,
        iesPath,
        iesRotation: f.iesRotation,
        mount: f.mount,
        roomGeometry: body.roomGeometry,
        pose: f.pose ?? {},
        cameraName: f.cameraName,
        coverage: f.coverage ?? 0.34,
        xPct: f.xPct ?? 0.5,
        yPct: f.yPct ?? 0.5,
        brightness: f.brightness ?? 50,
        lightOutput: f.lightOutput ?? 50,
        warm: f.warm ?? 0.45,
        samples: body.samples,
        highQuality: body.highQuality,
        layers,
        preview,
        previewMaxPx: body.previewMaxPx,
        supersample: body.supersample,
        fixtureScale,
        composeBeauty,
      };

      await writeFile(jobPath, JSON.stringify(job));
      await runBlender(COMPOSITE_SCRIPT, modelPath, jobPath, outPath);

      if (layers) {
        const wallPath = `${outPath.slice(0, -4)}_wall.png`;
        const fixturePath = `${outPath.slice(0, -4)}_fixture.png`;
        const basePath = `${outPath.slice(0, -4)}_fixturebase.png`;
        if (!existsSync(wallPath) || !existsSync(fixturePath)) {
          throw new Error("Blender did not produce the layer passes to compose");
        }
        rendered.push({
          sku: f.sku,
          out: outPath,
          fixture: fixturePath,
          base: existsSync(basePath) ? basePath : undefined,
        });
        plate = wallPath;
      } else {
        if (!existsSync(outPath)) {
          throw new Error("Blender finished but produced no composite image");
        }
        plate = outPath;
      }
    }

    // Compose the beauty from the layers when Blender skipped the dedicated
    // (expensive, full-frame) beauty pass: every hi-res fixture cutout over the
    // upscaled final wall plate, back-to-front in list order.
    let beautyPath = plate;
    if (composeBeauty) {
      beautyPath = path.join(dir, "shot.png");
      const first = rendered[0]!;
      const fmeta = await sharp(first.fixture).metadata();
      const hw = fmeta.width ?? 0;
      const hh = fmeta.height ?? 0;
      const wallHi = await sharp(plate)
        .resize(hw, hh, { fit: "fill", kernel: "lanczos3" })
        .toBuffer();
      await sharp(wallHi)
        .composite(rendered.map((r) => ({ input: r.fixture })))
        .png()
        .toFile(beautyPath);
    }
    if (!existsSync(beautyPath)) {
      throw new Error("Blender finished but produced no composite image");
    }

    const png = await sharp(beautyPath).png().toBuffer();
    // Preview returns PNG only; final adds AVIF + layered PSD.
    if (preview) {
      return { png };
    }
    const avif = await sharp(beautyPath).avif({ quality: 60, effort: 4 }).toBuffer();
    let psd: Buffer | undefined;
    if (layers && rendered.length) {
      // Single fixture keeps the historical "Fixture" layer name; multi-fixture
      // layers are numbered in list (z) order and tagged with their SKU.
      const layerFiles: FixtureLayerFiles[] = rendered.map((r, i) => ({
        label:
          rendered.length === 1
            ? "Fixture"
            : `Fixture ${i + 1}${r.sku ? ` — ${r.sku}` : ""}`,
        fixture: r.fixture,
        base: r.base,
      }));
      psd = await assemblePsd(beautyPath, plate, roomPath, layerFiles, shadowsPlate);
    }
    return { png, avif, psd };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/ping") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "POST" && url.pathname === "/render-fixture") {
      let body: RenderRequest | null;
      try {
        const raw = await parseBody(req);
        body = raw && typeof raw === "object" ? (raw as RenderRequest) : null;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      if (!body) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "render request needs a JSON body" }));
        return;
      }

      try {
        const png = await renderFixture(body);
        res.writeHead(200, { "content-type": "image/png" });
        res.end(png);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[render-worker] render failed:", message);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/export-glb") {
      let body: ExportGlbRequest | null;
      try {
        const raw = await parseBody(req);
        body = raw && typeof raw === "object" ? (raw as ExportGlbRequest) : null;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      if (!body) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "export-glb request needs a JSON body" }));
        return;
      }
      try {
        const glb = await exportGlb(body);
        res.writeHead(200, { "content-type": "model/gltf-binary" });
        res.end(glb);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[render-worker] export-glb failed:", message);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/composite") {
      let body: CompositeRequest | null;
      try {
        const raw = await parseBody(req);
        body = raw && typeof raw === "object" ? (raw as CompositeRequest) : null;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      if (!body) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "composite request needs a JSON body" }));
        return;
      }

      try {
        const art = await runComposite(body);
        // Return every format as a base64 manifest; the API decodes and uploads
        // to R2 (PNG + AVIF always, layered PSD on final exports).
        const out: Record<string, unknown> = {
          ok: true,
          png: art.png.toString("base64"),
        };
        if (art.avif) out.avif = art.avif.toString("base64");
        if (art.psd) out.psd = art.psd.toString("base64");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[render-worker] composite failed:", message);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: message }));
        } else {
          res.destroy();
        }
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  })();
});

// A single Max render can hold one request open for many minutes while Blender
// works. Node's default headersTimeout (60s) and requestTimeout (300s) only
// bound *receiving* a request, but disable them outright so nothing in the HTTP
// layer can sever a long render; the real cap is RENDER_TIMEOUT_MS on Blender.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

server.listen(PORT, () => {
  console.log(`[render-worker] listening on :${PORT}`);
  console.log(`[render-worker] BLENDER_BIN=${BLENDER_BIN}`);
  console.log(`[render-worker] render script=${RENDER_SCRIPT}`);
});
