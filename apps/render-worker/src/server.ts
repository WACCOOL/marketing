import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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

function runBlender(
  scriptPath: string,
  modelPath: string,
  jobPath: string,
  outPath: string,
): Promise<void> {
  return runExclusive(
    () =>
      new Promise<void>((resolve, reject) => {
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
      if (code === 0) return resolve();
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
    await runBlender(EXPORT_GLB_SCRIPT, modelPath, jobPath, outPath);
    if (!existsSync(outPath)) {
      throw new Error("Blender finished but produced no GLB");
    }
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface CompositeRequest {
  /** Local path to the .blend, or a URL the worker downloads. */
  modelPath?: string;
  modelUrl?: string;
  sku?: string;
  /** The AI room plate the fixture is composited into (local path or URL). */
  roomPath?: string;
  roomUrl?: string;
  /** Manufacturer IES photometry for the fixture's light spill (path or URL). */
  iesPath?: string;
  iesUrl?: string;
  iesRotation?: [number, number, number];
  pose?: Pose;
  cameraName?: string;
  /** Fixture height as a fraction of the frame (0..1). */
  coverage?: number;
  /** Screen position of the fixture center (0..1). */
  xPct?: number;
  yPct?: number;
  /** Fixture-brightness slider (0..200, 25 = neutral) -> fixture's own glow. */
  brightness?: number;
  /** Light-output slider (0..200, 25 = neutral) -> IES power / own lamps. */
  lightOutput?: number;
  /** Warmth of the fixture light (0..1). */
  warm?: number;
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

/**
 * Build a layered PSD the design team can edit in Photoshop:
 *   - Background  (the AI room plate)
 *   - Light + Shadow (the fixture's wall wash + contact shadow)
 *   - Fixture     (the product, transparent cutout, on top)
 * The flattened beauty is stored as the merged preview so the PSD opens looking
 * exactly like the final render.
 */
async function assemblePsd(
  beauty: string,
  wall: string,
  fixture: string,
  room: string,
  fixtureBase?: string,
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
    { name: "Light + Shadow", imageData: wallLayer },
  ];

  // When the self-light-off pass exists, split the fixture into an unlit base + an
  // adjustable additive "Fixture Glow" on top; otherwise fall back to one layer.
  if (fixtureBase && existsSync(fixtureBase)) {
    const [baseLayer, glow] = await Promise.all([
      toImageData(fixtureBase, width, height),
      glowImageData(fixture, fixtureBase, width, height),
    ]);
    children.push({ name: "Fixture", imageData: baseLayer });
    children.push({
      name: "Fixture Glow",
      imageData: glow,
      blendMode: "linear dodge",
    });
  } else {
    const fixtureLayer = await toImageData(fixture, width, height);
    children.push({ name: "Fixture", imageData: fixtureLayer });
  }

  const psd = { width, height, imageData: merged, children };
  return Buffer.from(writePsd(psd));
}

interface CompositeArtifacts {
  png: Buffer;
  avif?: Buffer;
  psd?: Buffer;
}

/** Render the fixture into the room and produce the requested deliverables. */
async function runComposite(body: CompositeRequest): Promise<CompositeArtifacts> {
  if (!body.modelPath && !body.modelUrl) {
    throw new Error("composite request needs a modelPath or modelUrl");
  }
  if (!body.roomPath && !body.roomUrl) {
    throw new Error("composite request needs a roomPath or roomUrl");
  }
  if (!existsSync(BLENDER_BIN)) {
    throw new Error(`Blender not found at ${BLENDER_BIN}; set BLENDER_BIN`);
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "wac-composite-"));
  const jobPath = path.join(dir, "job.json");
  const outPath = path.join(dir, "shot.png");
  const wallPath = path.join(dir, "shot_wall.png");
  const fixturePath = path.join(dir, "shot_fixture.png");
  const fixtureBasePath = path.join(dir, "shot_fixturebase.png");

  try {
    let modelPath = body.modelPath;
    if (!modelPath && body.modelUrl) {
      modelPath = await fetchModel(body.modelUrl, dir);
    }
    if (!modelPath || !existsSync(modelPath)) {
      throw new Error(`model not found: ${modelPath ?? body.modelUrl}`);
    }

    let roomPath = body.roomPath;
    if (!roomPath && body.roomUrl) {
      roomPath = await fetchTo(body.roomUrl, path.join(dir, "room.png"));
    }
    if (!roomPath || !existsSync(roomPath)) {
      throw new Error(`room not found: ${roomPath ?? body.roomUrl}`);
    }

    let iesPath = body.iesPath;
    if (!iesPath && body.iesUrl) {
      iesPath = await fetchTo(body.iesUrl, path.join(dir, "fixture.ies"));
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

    const job = {
      modelPath,
      sku: body.sku,
      roomPath,
      iesPath,
      iesRotation: body.iesRotation,
      pose: body.pose ?? {},
      cameraName: body.cameraName,
      coverage: body.coverage ?? 0.34,
      xPct: body.xPct ?? 0.5,
      yPct: body.yPct ?? 0.5,
      brightness: body.brightness ?? 25,
      lightOutput: body.lightOutput ?? 25,
      warm: body.warm ?? 0.45,
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

    // Compose the beauty from the layers when Blender skipped the dedicated
    // (expensive, full-frame) beauty pass: hi-res fixture over the upscaled wall.
    if (composeBeauty) {
      if (!existsSync(wallPath) || !existsSync(fixturePath)) {
        throw new Error("Blender did not produce the layer passes to compose");
      }
      const fmeta = await sharp(fixturePath).metadata();
      const hw = fmeta.width ?? 0;
      const hh = fmeta.height ?? 0;
      const wallHi = await sharp(wallPath)
        .resize(hw, hh, { fit: "fill", kernel: "lanczos3" })
        .toBuffer();
      await sharp(wallHi)
        .composite([{ input: fixturePath }])
        .png()
        .toFile(outPath);
    }
    if (!existsSync(outPath)) {
      throw new Error("Blender finished but produced no composite image");
    }

    const png = await sharp(outPath).png().toBuffer();
    // Preview returns PNG only; final adds AVIF + layered PSD.
    if (preview) {
      return { png };
    }
    const avif = await sharp(outPath).avif({ quality: 60, effort: 4 }).toBuffer();
    let psd: Buffer | undefined;
    if (layers && existsSync(wallPath) && existsSync(fixturePath)) {
      psd = await assemblePsd(
        outPath,
        wallPath,
        fixturePath,
        roomPath,
        existsSync(fixtureBasePath) ? fixtureBasePath : undefined,
      );
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
