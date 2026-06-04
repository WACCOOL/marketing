import http from "node:http";
import zlib from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
} from "./composite.js";
import { buildHarmonizationMask } from "./mask.js";
import { fetchImageBuffer } from "./fetchImage.js";
import { makeImageGenAdapters, type ImageGenAdapters } from "./ai/adapter.js";

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
}

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
 * cutouts and composite at the computed scale. No AI.
 */
async function runComposite(p: AppImageParams): Promise<GenerationResult> {
  const result = await composeAppImage({
    sceneUrl: p.sceneUrl!,
    pxPerMm: p.scale!.pxPerMm,
    scaleAdjust: p.scale!.scaleAdjust,
    fixtures: mapFixtures(p),
    output: p.output,
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
 * Hybrid (Option C / `hybrid` mode): composite the real cutouts, build a halo
 * mask around each fixture (core preserved), let FLUX.1 Fill paint integrated
 * lighting in the halo, then optionally run a Gemini global lighting pass.
 */
async function runHybrid(
  p: AppImageParams,
  adapters: ImageGenAdapters,
): Promise<GenerationResult> {
  const inpainter = adapters.inpainter;
  if (!inpainter) {
    throw new Error(
      "hybrid mode requires a configured BFL API key (set BFL_API_KEY)",
    );
  }

  const { scene, fixtures } = await fetchSceneAndFixtures(
    p.sceneUrl!,
    mapFixtures(p),
  );
  const placed = await placeFixtures({
    scene,
    fixtures,
    pxPerMm: p.scale!.pxPerMm,
    scaleAdjust: p.scale!.scaleAdjust,
  });

  const mask = await buildHarmonizationMask({
    width: placed.width,
    height: placed.height,
    placements: placed.placements,
    dilationPx: p.harmonize.maskDilationPx,
  });

  const steps: string[] = [];
  let aiImage = await inpainter.inpaint({
    image: placed.base,
    mask,
    prompt: p.prompt!,
    steps: p.harmonize.steps,
    guidance: p.harmonize.guidance,
    seed: p.harmonize.seed,
  });
  steps.push(`inpaint:${inpainter.provider}`);

  if (p.harmonize.globalPass) {
    const harmonizer = adapters.harmonizer;
    if (!harmonizer) {
      throw new Error(
        "harmonize.globalPass requires a configured Gemini API key (set GEMINI_API_KEY)",
      );
    }
    aiImage = await harmonizer.harmonize({ image: aiImage, prompt: p.prompt! });
    steps.push(`harmonize:${harmonizer.provider}`);
  }

  const encoded = await encodeOutput(aiImage, p.output);
  return {
    files: [
      { format: encoded.format, body: encoded.body, contentType: encoded.contentType },
    ],
    metadata: {
      version: p.version,
      mode: "hybrid",
      generatedBy: steps.join(" -> "),
      productAccurate: true,
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

/**
 * Validate against the canonical contract, then dispatch by mode. Errors
 * propagate to handleGenerate, which finalizes the job as failed.
 */
async function runAppImageGenerator(
  req: GenerateRequest,
  adapters: ImageGenAdapters,
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
      return runHybrid(p, adapters);
    case "concept":
      return runConcept(p, adapters);
    case "composite":
    default:
      return runComposite(p);
  }
}

function runGeneration(
  req: GenerateRequest,
  adapters: ImageGenAdapters,
): Promise<GenerationResult> {
  if (req.tool === "appimage") return runAppImageGenerator(req, adapters);
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
  const generated = await runGeneration(req, adapters);
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

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    })();
  });

  server.listen(PORT, () => {
    console.log(`[generator] listening on :${PORT}`);
  });
}

main();
