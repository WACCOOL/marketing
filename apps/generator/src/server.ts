import http from "node:http";
import zlib from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AppImageParamsSchema, APPIMAGE_PARAMS_VERSION } from "@wac/shared";
import { composeAppImage } from "./composite.js";

/**
 * WAC generation Container (Phase 2c).
 *
 * A minimal HTTP service that the API Worker's queue consumer invokes. For
 * `appimage` it runs the deterministic scale + compositing engine (fetch scene +
 * Sales Layer CDN cutouts, size from dimensions_mm + scene scale, composite with
 * sharp); `ppt`/`layout` still emit the 2b placeholder until Phase 3. It uploads
 * the result to R2 over the S3 API, records the asset in Supabase, and flips the
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
  };
}

interface GenerateRequest {
  jobId: string;
  ownerId: string;
  tool: "appimage" | "ppt" | "layout";
  name: string;
  params: Record<string, unknown>;
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

/**
 * The deterministic App Image generator (Phase 2c): validate params against the
 * canonical contract, fetch the scene + cutouts, and composite at the computed
 * scale. Errors propagate to handleGenerate, which finalizes the job as failed.
 */
async function runAppImageGenerator(
  req: GenerateRequest,
): Promise<GenerationResult> {
  const parsed = AppImageParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid appimage params: ${detail}`);
  }
  const p = parsed.data;
  if (p.version !== APPIMAGE_PARAMS_VERSION) {
    throw new Error(`unsupported appimage params version: ${p.version}`);
  }

  const result = await composeAppImage({
    sceneUrl: p.sceneUrl,
    pxPerMm: p.scale.pxPerMm,
    scaleAdjust: p.scale.scaleAdjust,
    fixtures: p.fixtures.map((f) => ({
      cutoutUrl: f.cutoutUrl,
      dimensionsMm: f.dimensionsMm,
      anchor: f.anchor,
      xPct: f.xPct,
      yPct: f.yPct,
      widthBasis: f.widthBasis,
    })),
    output: p.output,
  });

  return {
    files: [
      {
        format: result.format,
        body: result.body,
        contentType: result.contentType,
      },
    ],
    metadata: {
      version: APPIMAGE_PARAMS_VERSION,
      generatedBy: "appimage",
      sceneUrl: p.sceneUrl,
      scale: p.scale,
      output: {
        format: result.format,
        width: result.width,
        height: result.height,
      },
      fixtures: result.placements,
    },
  };
}

function runGeneration(req: GenerateRequest): Promise<GenerationResult> {
  if (req.tool === "appimage") return runAppImageGenerator(req);
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
  const { data, error } = await sb
    .from("assets")
    .insert({
      owner_id: req.ownerId,
      tool: req.tool,
      name: req.name,
      org_visibility: "internal",
      tags: [`tool:${req.tool}`],
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
): Promise<void> {
  await markRunning(sb, req.jobId);

  // Generate first so the asset row can carry the real generation metadata
  // (computed scale, placements). A failure here surfaces before any DB writes
  // beyond the running transition.
  const generated = await runGeneration(req);
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
          await handleGenerate(parsed, config, sb, s3);
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
