import http from "node:http";
import zlib from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  AppImageParamsSchema,
  APPIMAGE_PARAMS_VERSIONS,
  type AppImageParams,
} from "@wac/shared";
import {
  composeAppImage,
  encodeOutput,
  fetchSceneAndFixtures,
  placeFixtures,
  type FixtureInput,
  type Placement,
  type PrepareCutout,
} from "./composite.js";
import { harmonizeFixtures } from "./harmonize.js";
import { fetchImageBuffer } from "./fetchImage.js";
import { makeImageGenAdapters, type ImageGenAdapters } from "./ai/adapter.js";
import { resolveCutout, type CutoutCache } from "./cutout.js";

/**
 * WAC generation Container (Phase 2d).
 *
 * A minimal HTTP service that the API Worker's queue consumer invokes. For
 * `appimage` it dispatches by `mode`: `composite` runs the deterministic scale +
 * compositing engine (2c); `hybrid` composites then harmonizes lighting via
 * FLUX.1 Fill (+ optional Gemini pass) behind the ImageGenerationAdapter; and
 * `concept` is pure-generative via Gemini (flagged not product-accurate).
 * `ppt`/`layout` still emit the 2b placeholder until Phase 3. It uploads the
 * result to R2 over the S3 API, records the asset in Supabase, and flips the
 * generation_jobs row to succeeded/failed.
 *
 * SHARED CONTRACT (keep in lockstep with apps/api/src/assets.ts):
 *   - R2 object key:   assets/{assetId}/{format}
 *   - assets columns:  owner_id, tool, name, org_visibility, tags,
 *                      metadata_json, parent_asset_id, version
 *   - asset_files:     asset_id, format, r2_key, bytes
 */

const PORT = Number(process.env.PORT ?? 8080);

interface Config {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Bucket: string;
  // Optional AI provider keys (Phase 2d). When unset, only `composite` mode
  // works; hybrid/concept jobs fail with a precise "not configured" error.
  bflApiKey?: string;
  geminiApiKey?: string;
  // Gemini model used for text-to-room scene generation. Defaults to a Gemini 3
  // image model because the user-facing size options go up to 4K, which 2.5
  // Flash Image cannot produce. Overridable via GEMINI_SCENE_MODEL.
  geminiSceneModel: string;
  // Gemini model used for segmentation-based background removal. Overridable via
  // GEMINI_SEGMENT_MODEL. When GEMINI_API_KEY is unset, opaque cutouts are
  // rejected (composite/hybrid require transparent fixtures).
  geminiSegmentModel?: string;
}

const DEFAULT_SCENE_MODEL = "gemini-3-pro-image";
// Scene generation (esp. 4K) can take well over the 30s per-provider default.
const SCENE_GEN_TIMEOUT_MS = 120_000;

function loadConfig(): Config {
  const required = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    R2_ENDPOINT: process.env.R2_ENDPOINT,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: process.env.R2_BUCKET,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(", ")}`);
  }
  return {
    supabaseUrl: required.SUPABASE_URL!,
    supabaseServiceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY!,
    r2Endpoint: required.R2_ENDPOINT!,
    r2AccessKeyId: required.R2_ACCESS_KEY_ID!,
    r2SecretAccessKey: required.R2_SECRET_ACCESS_KEY!,
    r2Bucket: required.R2_BUCKET!,
    bflApiKey: process.env.BFL_API_KEY || undefined,
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    geminiSceneModel: process.env.GEMINI_SCENE_MODEL || DEFAULT_SCENE_MODEL,
    geminiSegmentModel: process.env.GEMINI_SEGMENT_MODEL || undefined,
  };
}

interface GenerateRequest {
  jobId: string;
  ownerId: string;
  tool: "appimage" | "ppt" | "layout";
  name: string;
  params: Record<string, unknown>;
  /** Extra asset tags merged onto the base `tool:<tool>` tag (Phase 2e). */
  tags?: string[];
}

interface GeneratedFile {
  format: string;
  body: Buffer;
  contentType: string;
}

interface GenerationResult {
  files: GeneratedFile[];
  /** Merged into the asset's metadata_json for reproducibility. */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PNG encoder — produces a valid solid-color PNG with zero native deps. This is
// the 2b stub artifact; 2c swaps in real raster compositing (sharp/ImageMagick).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function makePlaceholderPng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const [r, g, b, a] = rgba;
  const rowLen = width * 4;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (rowLen + 1);
    raw[off] = 0; // filter type "none" per scanline
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Placeholder generator for tools whose real pipeline isn't built yet
 * (ppt/layout — Phase 3). Returns a recognizable WAC-slate PNG.
 */
function runStubGenerator(req: GenerateRequest): GenerationResult {
  const png = makePlaceholderPng(1200, 630, [30, 41, 59, 255]);
  return {
    files: [{ format: "png", body: png, contentType: "image/png" }],
    metadata: { generatedBy: "stub", params: req.params },
  };
}

function mapFixtures(p: AppImageParams): FixtureInput[] {
  return p.fixtures.map((f) => ({
    cutoutUrl: f.cutoutUrl,
    dimensionsMm: f.dimensionsMm,
    anchor: f.anchor,
    xPct: f.xPct,
    yPct: f.yPct,
    widthBasis: f.widthBasis,
    perspective: f.perspective,
  }));
}

/** Drop the heavy resized-cutout buffers before a placement goes into metadata. */
function toPlacementMeta(
  placements: { resizedCutout: Buffer }[],
): Placement[] {
  return placements.map(({ resizedCutout: _drop, ...rest }) => rest as Placement);
}

/**
 * Deterministic compositing (Phase 2c / `composite` mode): fetch the scene +
 * cutouts and composite at the computed scale. No AI (matting aside).
 */
async function runComposite(
  p: AppImageParams,
  prepareCutout?: PrepareCutout,
): Promise<GenerationResult> {
  const result = await composeAppImage({
    sceneUrl: p.sceneUrl!,
    pxPerMm: p.scale!.pxPerMm,
    scaleAdjust: p.scale!.scaleAdjust,
    fixtures: mapFixtures(p),
    output: p.output,
    prepareCutout,
  });
  return {
    files: [
      { format: result.format, body: result.body, contentType: result.contentType },
    ],
    metadata: {
      version: p.version,
      mode: "composite",
      generatedBy: "composite",
      productAccurate: true,
      sceneUrl: p.sceneUrl,
      scale: p.scale,
      output: { format: result.format, width: result.width, height: result.height },
      fixtures: result.placements,
    },
  };
}

/**
 * Build the geometry-locked relight instruction. The composite is image #1 and
 * the fixture cutout(s) are the reference images; the prompt forbids any shape
 * change and (optionally) turns the lamps on. Folds in the user's room/lighting
 * `prompt` as extra context when supplied.
 */
function buildRelightPrompt(p: AppImageParams): string {
  const context = p.prompt?.trim() ? ` Room/lighting context: ${p.prompt.trim()}.` : "";
  const lightsOn = p.harmonize.lightsOn
    ? " Turn the fixture's lamps ON: make the bulbs/shades emit a warm, natural " +
      "glow and cast soft, physically plausible light and shadows onto nearby " +
      "surfaces (ceiling, walls, floor) consistent with its position."
    : "";
  return (
    "The first image is a room with a real product fixture already composited at " +
    "the correct size and position. The remaining image(s) show the EXACT fixture " +
    "design. Relight only the fixture so its color temperature, brightness, " +
    "reflections and shadows match the room, and blend its edges naturally. " +
    "CRITICAL: preserve the fixture's exact shape, arm/element count, materials, " +
    "proportions, scale and position from the reference image(s); do not add, " +
    "remove, or redesign any part of it. Do not change the room's architecture, " +
    "furniture, or any other object." +
    lightsOn +
    context +
    " Output a single photorealistic image, no text or watermarks."
  );
}

/**
 * Hybrid (`hybrid` mode): place the REAL cutouts (optionally perspective-warped
 * via the deterministic engine), then harmonize — a classical, shape-preserving
 * color/tone transfer that matches each fixture's white balance, exposure, and
 * contrast to the surrounding room (cf. Photoshop's Harmonize). An optional
 * generative relight / lights-on pass (Gemini) can run last, with the cutouts
 * passed back as a design reference under a geometry-locked prompt.
 */
async function runHybrid(
  p: AppImageParams,
  adapters: ImageGenAdapters,
  prepareCutout?: PrepareCutout,
): Promise<GenerationResult> {
  const { scene, fixtures } = await fetchSceneAndFixtures(
    p.sceneUrl!,
    mapFixtures(p),
    prepareCutout,
  );
  const placed = await placeFixtures({
    scene,
    fixtures,
    pxPerMm: p.scale!.pxPerMm,
    scaleAdjust: p.scale!.scaleAdjust,
  });

  const steps: string[] = ["composite"];
  let image = placed.base;

  const wantsHarmonize =
    (p.harmonize.enabled && p.harmonize.strength > 0) || p.harmonize.shadowPx > 0;
  if (wantsHarmonize) {
    image = await harmonizeFixtures({
      base: placed.base,
      width: placed.width,
      height: placed.height,
      placements: placed.placements,
      strength: p.harmonize.enabled ? p.harmonize.strength : 0,
      shadowPx: p.harmonize.shadowPx,
    });
    steps.push("harmonize:color-transfer");
  }

  // Optional generative relight / lights-on pass (Gemini). Runs AFTER the
  // classical match. The placed cutouts are passed back as a design reference
  // with a geometry-locked prompt so the fixture's shape stays faithful.
  const wantsRelight = p.harmonize.aiRelight || p.harmonize.lightsOn;
  if (wantsRelight) {
    const relighter = adapters.relighter;
    if (!relighter) {
      throw new Error(
        "AI relight / lights-on requires a configured Gemini API key (set GEMINI_API_KEY)",
      );
    }
    const references = placed.placements
      .slice(0, 4)
      .map((pl) => pl.resizedCutout);
    image = await relighter.relight({
      image,
      references,
      prompt: buildRelightPrompt(p),
    });
    steps.push(p.harmonize.lightsOn ? "relight:lights-on" : "relight:fit");
  }

  const encoded = await encodeOutput(image, p.output);
  return {
    files: [
      { format: encoded.format, body: encoded.body, contentType: encoded.contentType },
    ],
    metadata: {
      version: p.version,
      mode: "hybrid",
      generatedBy: steps.join(" -> "),
      // Geometry is deterministic; a relight pass can alter fixture pixels, so
      // flag it so the library can label AI-touched images.
      productAccurate: true,
      aiRelit: wantsRelight,
      sceneUrl: p.sceneUrl,
      scale: p.scale,
      prompt: p.prompt,
      harmonize: p.harmonize,
      steps,
      output: { format: encoded.format, width: encoded.width, height: encoded.height },
      fixtures: toPlacementMeta(placed.placements),
    },
  };
}

/**
 * Concept (Option B / `concept` mode): pure generative scene from the prompt
 * (+ optional reference images). NOT product-accurate — flagged as such so the
 * UI / library can label it clearly.
 */
async function runConcept(
  p: AppImageParams,
  adapters: ImageGenAdapters,
): Promise<GenerationResult> {
  const generator = adapters.generator;
  if (!generator) {
    throw new Error(
      "concept mode requires a configured Gemini API key (set GEMINI_API_KEY)",
    );
  }

  const referenceImages: Buffer[] = [];
  for (const url of p.referenceImages) {
    const fetched = await fetchImageBuffer(url);
    referenceImages.push(fetched.buffer);
  }

  const aiImage = await generator.generate({
    prompt: p.prompt!,
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
  });

  const encoded = await encodeOutput(aiImage, p.output);
  return {
    files: [
      { format: encoded.format, body: encoded.body, contentType: encoded.contentType },
    ],
    metadata: {
      version: p.version,
      mode: "concept",
      generatedBy: `generate:${generator.provider}`,
      productAccurate: false,
      prompt: p.prompt,
      referenceCount: referenceImages.length,
      output: { format: encoded.format, width: encoded.width, height: encoded.height },
    },
  };
}

interface SceneGenRequest {
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  /** Hero-fixture context so the room is staged to showcase it (see below). */
  fixtureType?: string;
  mount?: "ceiling" | "wall" | "floor" | "recessed";
}

const MOUNT_SURFACE_PHRASE: Record<NonNullable<SceneGenRequest["mount"]>, string> = {
  ceiling: "the center of the ceiling",
  wall: "a clear, prominent wall area",
  floor: "an open area of the floor",
  recessed: "the ceiling",
};

/**
 * When the scene is being generated to SHOWCASE a specific fixture, augment the
 * user's room description so Gemini leaves clear, uncluttered space on the mount
 * surface and omits any pre-existing fixture there (so the real fixture we drop
 * in later isn't competing with a hallucinated one).
 */
function buildScenePrompt(req: SceneGenRequest): string {
  const base = req.prompt.trim();
  if (!req.fixtureType && !req.mount) return base;
  const thing = (req.fixtureType ?? "light fixture").trim();
  const surface = req.mount ?? "ceiling";
  const where = MOUNT_SURFACE_PHRASE[surface];
  return (
    `${base}. This is an empty interior staged to showcase a ${thing}. ` +
    `Leave clear, uncluttered, well-lit space at ${where} where the ${thing} ` +
    `will be added, and do not include any existing ${thing} or other light ` +
    `fixture in that spot. Photorealistic interior photograph, balanced natural ` +
    `lighting, no text or watermarks.`
  );
}

/** Sniff an image content-type from magic bytes; default to PNG. */
function sniffImageContentType(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return "image/png";
}

/**
 * Text-to-room scene generation. Produces an empty room from a prompt via the
 * Gemini generator (a Gemini 3 image model so 4K is available) and returns the
 * raw image bytes. The API Worker stores them in R2 and hands the URL back to
 * the user, who then composites real fixtures into the scene.
 */
async function generateScene(
  req: SceneGenRequest,
  config: Config,
  adapters: ImageGenAdapters,
): Promise<{ body: Buffer; contentType: string }> {
  const generator = adapters.generator;
  if (!generator) {
    throw new Error(
      "scene generation requires a configured Gemini API key (set GEMINI_API_KEY)",
    );
  }
  if (!req.prompt || !req.prompt.trim()) {
    throw new Error("scene generation requires a prompt");
  }

  const image = await generator.generate({
    prompt: buildScenePrompt(req),
    aspectRatio: req.aspectRatio,
    imageSize: req.imageSize,
    model: config.geminiSceneModel,
    timeoutMs: SCENE_GEN_TIMEOUT_MS,
  });
  return { body: image, contentType: sniffImageContentType(image) };
}

/**
 * Validate against the canonical contract, then dispatch by mode. Errors
 * propagate to handleGenerate, which finalizes the job as failed.
 */
async function runAppImageGenerator(
  req: GenerateRequest,
  adapters: ImageGenAdapters,
  prepareCutout?: PrepareCutout,
): Promise<GenerationResult> {
  const parsed = AppImageParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid appimage params: ${detail}`);
  }
  const p = parsed.data;
  if (!(APPIMAGE_PARAMS_VERSIONS as readonly string[]).includes(p.version)) {
    throw new Error(`unsupported appimage params version: ${p.version}`);
  }

  switch (p.mode) {
    case "hybrid":
      return runHybrid(p, adapters, prepareCutout);
    case "concept":
      return runConcept(p, adapters);
    case "composite":
    default:
      return runComposite(p, prepareCutout);
  }
}

function runGeneration(
  req: GenerateRequest,
  adapters: ImageGenAdapters,
  prepareCutout?: PrepareCutout,
): Promise<GenerationResult> {
  if (req.tool === "appimage")
    return runAppImageGenerator(req, adapters, prepareCutout);
  return Promise.resolve(runStubGenerator(req));
}

// ---------------------------------------------------------------------------
// Supabase + R2 helpers
// ---------------------------------------------------------------------------
async function markRunning(sb: SupabaseClient, jobId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await sb
    .from("generation_jobs")
    .update({ status: "running", started_at: now, updated_at: now })
    .eq("id", jobId);
  if (error) throw new Error(`mark running failed: ${error.message}`);
}

async function createAssetRow(
  sb: SupabaseClient,
  req: GenerateRequest,
  metadata: Record<string, unknown>,
): Promise<string> {
  // Base tag plus any caller-supplied tags (e.g. sku:/room: for app images),
  // de-duped so the asset's tag set stays clean.
  const tags = [...new Set([`tool:${req.tool}`, ...(req.tags ?? [])])];
  const { data, error } = await sb
    .from("assets")
    .insert({
      owner_id: req.ownerId,
      tool: req.tool,
      name: req.name,
      org_visibility: "internal",
      tags,
      metadata_json: { jobId: req.jobId, ...metadata },
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`assets insert failed: ${error?.message}`);
  }
  return (data as { id: string }).id;
}

async function uploadFile(
  s3: S3Client,
  bucket: string,
  assetId: string,
  file: GeneratedFile,
): Promise<{ format: string; key: string; bytes: number }> {
  const key = `assets/${assetId}/${file.format}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.body,
      ContentType: file.contentType,
    }),
  );
  return { format: file.format, key, bytes: file.body.byteLength };
}

async function recordAssetFile(
  sb: SupabaseClient,
  assetId: string,
  f: { format: string; key: string; bytes: number },
): Promise<void> {
  const { error } = await sb.from("asset_files").insert({
    asset_id: assetId,
    format: f.format,
    r2_key: f.key,
    bytes: f.bytes,
  });
  if (error) throw new Error(`asset_files insert failed: ${error.message}`);
}

async function markSucceeded(
  sb: SupabaseClient,
  jobId: string,
  assetId: string,
  files: { format: string; key: string; bytes: number }[],
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await sb
    .from("generation_jobs")
    .update({
      status: "succeeded",
      asset_id: assetId,
      result_json: { files },
      finished_at: now,
      updated_at: now,
    })
    .eq("id", jobId);
  if (error) throw new Error(`mark succeeded failed: ${error.message}`);
}

async function markFailed(
  sb: SupabaseClient,
  jobId: string,
  message: string,
): Promise<void> {
  const now = new Date().toISOString();
  // Best-effort: if even this write fails the consumer's retry path is the
  // backstop, so we just log.
  const { error } = await sb
    .from("generation_jobs")
    .update({ status: "failed", error: message, finished_at: now, updated_at: now })
    .eq("id", jobId);
  if (error) console.error(`[generator] mark failed errored: ${error.message}`);
}

/** R2-backed cache for matted cutouts (keyed by source URL hash). */
function makeR2CutoutCache(s3: S3Client, bucket: string): CutoutCache {
  return {
    async get(key: string): Promise<Buffer | null> {
      try {
        const out = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (!out.Body) return null;
        const bytes = await out.Body.transformToByteArray();
        return Buffer.from(bytes);
      } catch {
        // Cache miss (NoSuchKey) or transient read error: treat as no cache.
        return null;
      }
    },
    async put(key: string, body: Buffer, contentType: string): Promise<void> {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
  };
}

/**
 * Build the cutout-preparation hook: remove the background from opaque fixture
 * images (Gemini segmentation -> alpha) into transparent PNGs, caching results
 * in R2. It always returns a hook; when no segmenter is configured the hook
 * rejects opaque cutouts with an actionable error.
 */
function makePrepareCutout(
  config: Config,
  s3: S3Client,
  adapters: ImageGenAdapters,
): PrepareCutout {
  const cache = makeR2CutoutCache(s3, config.r2Bucket);
  return (sourceUrl, fetched) =>
    resolveCutout({ sourceUrl, fetched, segmenter: adapters.segmenter, cache });
}

async function handleGenerate(
  req: GenerateRequest,
  config: Config,
  sb: SupabaseClient,
  s3: S3Client,
  adapters: ImageGenAdapters,
): Promise<void> {
  await markRunning(sb, req.jobId);

  // Generate first so the asset row can carry the real generation metadata
  // (computed scale, placements). A failure here surfaces before any DB writes
  // beyond the running transition.
  const prepareCutout = makePrepareCutout(config, s3, adapters);
  const generated = await runGeneration(req, adapters, prepareCutout);
  const assetId = await createAssetRow(sb, req, generated.metadata);

  const uploaded: { format: string; key: string; bytes: number }[] = [];
  for (const file of generated.files) {
    const meta = await uploadFile(s3, config.r2Bucket, assetId, file);
    await recordAssetFile(sb, assetId, meta);
    uploaded.push(meta);
  }

  await markSucceeded(sb, req.jobId, assetId, uploaded);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
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

function parseGenerateRequest(body: unknown): GenerateRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (
    typeof b.jobId !== "string" ||
    typeof b.ownerId !== "string" ||
    typeof b.name !== "string" ||
    (b.tool !== "appimage" && b.tool !== "ppt" && b.tool !== "layout")
  ) {
    return null;
  }
  return {
    jobId: b.jobId,
    ownerId: b.ownerId,
    tool: b.tool,
    name: b.name,
    params:
      b.params && typeof b.params === "object"
        ? (b.params as Record<string, unknown>)
        : {},
    tags: Array.isArray(b.tags)
      ? b.tags.filter((t): t is string => typeof t === "string")
      : undefined,
  };
}

function main(): void {
  const config = loadConfig();
  const sb = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const s3 = new S3Client({
    region: "auto",
    endpoint: config.r2Endpoint,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });

  // Built once at startup from configured keys; unset providers leave slots
  // empty so hybrid/concept jobs fail with a precise "not configured" error.
  const adapters = makeImageGenAdapters({
    bflApiKey: config.bflApiKey,
    geminiApiKey: config.geminiApiKey,
    geminiSegmentModel: config.geminiSegmentModel,
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/ping") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }

      if (req.method === "POST" && url.pathname === "/generate") {
        let parsed: GenerateRequest | null;
        try {
          parsed = parseGenerateRequest(await readJsonBody(req));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
        if (!parsed) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid generate request" }));
          return;
        }

        try {
          await handleGenerate(parsed, config, sb, s3, adapters);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, jobId: parsed.jobId }));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[generator] job ${parsed.jobId} failed:`, message);
          await markFailed(sb, parsed.jobId, message);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: message }));
        }
        return;
      }

      // Synchronous scene generation: returns raw image bytes (no DB/R2 writes;
      // the API Worker persists the result). Distinct from /generate, which is
      // the async job path that creates a library asset.
      if (req.method === "POST" && url.pathname === "/generate-scene") {
        let body: SceneGenRequest | null;
        try {
          const raw = await readJsonBody(req);
          body =
            raw && typeof raw === "object"
              ? (raw as SceneGenRequest)
              : null;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
        if (!body || typeof body.prompt !== "string") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "scene request needs a prompt" }));
          return;
        }

        try {
          const { body: image, contentType } = await generateScene(
            body,
            config,
            adapters,
          );
          res.writeHead(200, { "content-type": contentType });
          res.end(image);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error("[generator] scene generation failed:", message);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: message }));
        }
        return;
      }

      // Vision-based perspective auto-fit: given a scene URL + mount, return a
      // keystone hint { vertical, horizontal }. The web client converts it to a
      // perspective warp and falls back to its positional heuristic on failure.
      if (req.method === "POST" && url.pathname === "/suggest-perspective") {
        let body: { sceneUrl?: string; mount?: string } | null;
        try {
          const raw = await readJsonBody(req);
          body = raw && typeof raw === "object" ? (raw as typeof body) : null;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
        if (!body || typeof body.sceneUrl !== "string") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "perspective request needs a sceneUrl" }));
          return;
        }
        try {
          const estimator = adapters.perspective;
          if (!estimator) {
            throw new Error(
              "perspective auto-fit requires a configured Gemini API key (set GEMINI_API_KEY)",
            );
          }
          const fetched = await fetchImageBuffer(body.sceneUrl);
          const hint = await estimator.estimatePerspective({
            image: fetched.buffer,
            mount: body.mount,
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(hint));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error("[generator] perspective estimate failed:", message);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: message }));
        }
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    })();
  });

  server.listen(PORT, () => {
    console.log(`[generator] listening on :${PORT}`);
  });
}

main();
