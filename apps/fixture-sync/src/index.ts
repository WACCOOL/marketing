import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  HeadObjectCommand,
  S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { deriveFixtureKind, type FixtureMount } from "@wac/shared";
import { bakeThumbnails, type BakeFixture } from "./thumbBaker.js";

/**
 * One-shot bulk uploader for the scalable fixture pipeline (Phase 1).
 *
 * Recursively scans a LucidLink mount of studio `.blend` files, mirrors each one
 * to R2 (preserving the year/brand subfolder structure in the object key), and
 * upserts a SKU-keyed row into the Supabase `fixtures` registry. The web app's
 * resolver then presigns `model_key` so ANY mirrored fixture renders on demand.
 *
 * This is intentionally a one-shot CLI: the continuous LucidLink->R2 watcher
 * (which will live on a separate always-on host) is a later phase. Re-runs are
 * idempotent — unchanged files (same byte size) are skipped — so the ~1TB
 * backfill can run over multiple sessions.
 *
 * Env (same names the generator uses):
 *   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   fixture-sync [--source <dir>] [--dry-run] [--sku <substr>] [--concurrency <n>]
 */

const DEFAULT_SOURCE = "/Volumes/graphix-working/team/3d_files/";
const R2_PREFIX = "fixtures";

interface Args {
  source: string;
  dryRun: boolean;
  skuFilter?: string;
  concurrency: number;
  /** After uploading, bake a picker thumbnail for any fixture missing one. */
  bakeThumbs: boolean;
  /** Skip the .blend scan/upload entirely and only bake missing thumbnails. */
  bakeOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    source: DEFAULT_SOURCE,
    dryRun: false,
    concurrency: 4,
    bakeThumbs: false,
    bakeOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--source":
        args.source = argv[++i] ?? args.source;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--sku":
        args.skuFilter = (argv[++i] ?? "").toLowerCase() || undefined;
        break;
      case "--concurrency":
        args.concurrency = Math.max(1, Number(argv[++i]) || 4);
        break;
      case "--bake-thumbs":
        args.bakeThumbs = true;
        break;
      case "--bake-only":
        args.bakeOnly = true;
        args.bakeThumbs = true;
        break;
      case "--help":
      case "-h":
        printUsageAndExit(0);
        break;
      default:
        if (a?.startsWith("--")) {
          console.error(`unknown flag: ${a}`);
          printUsageAndExit(1);
        }
    }
  }
  return args;
}

function printUsageAndExit(code: number): never {
  console.log(
    "Usage: fixture-sync [--source <dir>] [--dry-run] [--sku <substr>] " +
      "[--concurrency <n>] [--bake-thumbs] [--bake-only]",
  );
  process.exit(code);
}

interface Config {
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Bucket: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  /** Deployed API origin for the GLB-export trigger (thumbnail bake only). */
  apiBaseUrl?: string;
  /** ADMIN_API_TOKEN for the GLB-export trigger (thumbnail bake only). */
  adminToken?: string;
}

function loadConfig(): Config {
  const required = {
    R2_ENDPOINT: process.env.R2_ENDPOINT,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: process.env.R2_BUCKET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(", ")}`);
  }
  return {
    r2Endpoint: required.R2_ENDPOINT!,
    r2AccessKeyId: required.R2_ACCESS_KEY_ID!,
    r2SecretAccessKey: required.R2_SECRET_ACCESS_KEY!,
    r2Bucket: required.R2_BUCKET!,
    supabaseUrl: required.SUPABASE_URL!,
    supabaseServiceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY!,
    // Optional — only needed for --bake-thumbs / --bake-only.
    apiBaseUrl: (process.env.API_BASE_URL ?? process.env.PUBLIC_BASE_URL)
      ?.trim()
      .replace(/\/+$/, ""),
    adminToken: process.env.ADMIN_API_TOKEN,
  };
}

interface ScannedFile {
  absPath: string;
  /** Path relative to the scan root, used to build the R2 key. */
  relPath: string;
  bytes: number;
  mtimeMs: number;
}

/** Recursively collect every *.blend under `root`. */
async function scanBlendFiles(root: string): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      console.warn(`skip unreadable dir ${dir}: ${(e as Error).message}`);
      return;
    }
    for (const entry of entries) {
      // Ignore hidden + macOS metadata files (LucidLink/Finder noise).
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && /\.blend$/i.test(entry.name)) {
        const st = await stat(full);
        out.push({
          absPath: full,
          relPath: path.relative(root, full),
          bytes: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    }
  }
  await walk(root);
  return out;
}

interface ParsedName {
  /** Unique per-.blend identifier (the lowercased filename stem). */
  fixtureKey: string;
  /** Base product SKU for catalog lookup (scene/version suffix stripped). */
  sku: string;
  /** Scene number when the file is `{sku}_scn{NNN}.blend`, else null. */
  scene: string | null;
  version: number | null;
  isPub: boolean;
}

/**
 * Derive identifiers from a .blend filename. Two conventions coexist:
 *   - `{sku}.blend`             -> fixtureKey = sku = the stem.
 *   - `{sku}_scn{NNN}.blend`    -> fixtureKey = the stem (kept unique), sku =
 *                                  the part before `_scn`, scene = NNN. The same
 *                                  fixture's scenes share a base SKU and become
 *                                  selectable options in the picker.
 * `_v{NNN}` versions and a trailing `_pub` flag are also recognized.
 * Best-effort — refine as new naming variants appear.
 */
function parseFixtureName(filename: string): ParsedName {
  const stem = filename.replace(/\.blend$/i, "");
  const fixtureKey = stem.toLowerCase();
  let work = fixtureKey;
  const isPub = /_pub$/.test(work);
  if (isPub) work = work.replace(/_pub$/, "");
  const vMatch = work.match(/_v(\d{1,4})\b/);
  const version = vMatch ? Number(vMatch[1]) : null;
  const sceneMatch = work.match(/_scn(\d{1,4})\b/);
  const scene = sceneMatch ? sceneMatch[1]! : null;
  // Base SKU: drop the scene + version suffixes.
  const sku = work.replace(/_scn\d{1,4}\b/, "").replace(/_v\d{1,4}.*$/, "");
  return { fixtureKey, sku, scene, version, isPub };
}

interface Candidate extends ScannedFile, ParsedName {
  /** R2 object key (mirrors the source-relative path). */
  r2Key: string;
}

/**
 * Build one upload candidate per .blend (keyed by fixtureKey). A given
 * fixtureKey should be unique across the tree; if the same stem turns up in two
 * folders, keep the most recently modified and warn.
 */
function buildCandidates(files: ScannedFile[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const f of files) {
    const parsed = parseFixtureName(path.basename(f.absPath));
    if (!parsed.sku || !parsed.fixtureKey) continue;
    const r2Key = `${R2_PREFIX}/${f.relPath.split(path.sep).join("/")}`;
    const cand: Candidate = { ...f, ...parsed, r2Key };
    const prev = byKey.get(parsed.fixtureKey);
    if (!prev) {
      byKey.set(parsed.fixtureKey, cand);
    } else if (cand.mtimeMs > prev.mtimeMs) {
      console.warn(
        `duplicate fixture_key "${parsed.fixtureKey}": keeping newer ${cand.absPath}`,
      );
      byKey.set(parsed.fixtureKey, cand);
    } else {
      console.warn(
        `duplicate fixture_key "${parsed.fixtureKey}": keeping ${prev.absPath}, ignoring ${cand.absPath}`,
      );
    }
  }
  return [...byKey.values()];
}

interface RegistryRow {
  fixture_key: string;
  model_bytes: number | null;
  source_path: string | null;
}

/** Load the existing registry (fixture_key -> row) so we skip unchanged files. */
async function loadRegistry(sb: SupabaseClient): Promise<Map<string, RegistryRow>> {
  const map = new Map<string, RegistryRow>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb
      .from("fixtures")
      .select("fixture_key, model_bytes, source_path")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`load registry failed: ${error.message}`);
    const rows = (data ?? []) as RegistryRow[];
    for (const r of rows) map.set(r.fixture_key, r);
    if (rows.length < pageSize) break;
  }
  return map;
}

interface FixtureMetaRow {
  fixture_key: string;
  sku: string;
  mount: string | null;
}

/**
 * Load every registered fixture with the mount used to frame its thumbnail.
 * The registry's `mount` is usually null (the generator derives it at render
 * time), so we mirror that derivation here: join the products catalog by SKU
 * and run `deriveFixtureKind` (the same helper the API uses), defaulting to
 * "ceiling" when the SKU isn't matched.
 */
async function loadBakeFixtures(
  sb: SupabaseClient,
  skuFilter?: string,
): Promise<BakeFixture[]> {
  const rows: FixtureMetaRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb
      .from("fixtures")
      .select("fixture_key, sku, mount")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`load fixtures failed: ${error.message}`);
    const page = (data ?? []) as FixtureMetaRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  const filtered = skuFilter
    ? rows.filter(
        (r) =>
          r.sku.toLowerCase().includes(skuFilter) ||
          r.fixture_key.toLowerCase().includes(skuFilter),
      )
    : rows;

  // Derive missing mounts from the products catalog, like the API resolver.
  const needKind = filtered.filter((r) => !r.mount);
  const kinds = await loadProductKinds(
    sb,
    [...new Set(needKind.map((r) => r.sku.toLowerCase()))],
  );

  return filtered.map((r) => {
    const mount =
      (r.mount as FixtureMount | null) ??
      kinds.get(r.sku.toLowerCase())?.mount ??
      deriveFixtureKind(null, null).mount;
    return { fixtureKey: r.fixture_key, mount };
  });
}

/** Look up mount/type for a set of SKUs via the products catalog (batched). */
async function loadProductKinds(
  sb: SupabaseClient,
  skus: string[],
): Promise<Map<string, { mount: FixtureMount }>> {
  const out = new Map<string, { mount: FixtureMount }>();
  const batch = 200;
  for (let i = 0; i < skus.length; i += batch) {
    const chunk = skus.slice(i, i + batch);
    const { data, error } = await sb
      .from("products")
      .select("sku, category, name")
      .in("sku", chunk);
    if (error) throw new Error(`load products failed: ${error.message}`);
    for (const p of (data ?? []) as {
      sku: string;
      category: string | null;
      name: string | null;
    }[]) {
      const kind = deriveFixtureKind(p.category, p.name);
      out.set(p.sku.toLowerCase(), { mount: kind.mount });
    }
  }
  return out;
}

/** HEAD the R2 object; return its byte size, or null if it doesn't exist. */
async function r2ObjectBytes(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<number | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ContentLength ?? null;
  } catch (e) {
    const code = (e as S3ServiceException).name;
    if (code === "NotFound" || code === "NoSuchKey") return null;
    throw e;
  }
}

interface UploadResult {
  etag: string | null;
  bytes: number;
}

/** Stream the .blend to R2 with a multipart upload (handles the ~300MB files). */
async function uploadBlend(
  s3: S3Client,
  bucket: string,
  cand: Candidate,
): Promise<UploadResult> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: cand.r2Key,
      Body: createReadStream(cand.absPath),
      ContentType: "application/octet-stream",
    },
    // ~16MB parts; queue a few in flight for throughput on big files.
    partSize: 16 * 1024 * 1024,
    queueSize: 4,
  });
  const res = await upload.done();
  const etag = (res as { ETag?: string }).ETag?.replaceAll('"', "") ?? null;
  return { etag, bytes: cand.bytes };
}

async function upsertRegistry(
  sb: SupabaseClient,
  cand: Candidate,
  upload: UploadResult,
): Promise<void> {
  const { error } = await sb.from("fixtures").upsert(
    {
      fixture_key: cand.fixtureKey,
      sku: cand.sku,
      scene: cand.scene,
      model_key: cand.r2Key,
      model_etag: upload.etag,
      model_bytes: upload.bytes,
      source_path: cand.absPath,
      source_version: cand.version,
      is_pub: cand.isPub,
      ingested_at: new Date().toISOString(),
    },
    { onConflict: "fixture_key" },
  );
  if (error) {
    throw new Error(`registry upsert failed for ${cand.fixtureKey}: ${error.message}`);
  }
}

interface Stats {
  uploaded: number;
  skipped: number;
  failed: number;
}

/**
 * Decide whether a candidate's bytes already match what's recorded/stored, in
 * which case we skip the (expensive) upload. Falls back to a HEAD on R2 when the
 * registry has no row yet (so a half-finished prior run isn't re-uploaded).
 */
async function isUnchanged(
  s3: S3Client,
  bucket: string,
  cand: Candidate,
  registry: Map<string, RegistryRow>,
): Promise<boolean> {
  const row = registry.get(cand.fixtureKey);
  if (row && row.model_bytes === cand.bytes && row.source_path === cand.absPath) {
    return true;
  }
  if (!row) {
    const bytes = await r2ObjectBytes(s3, bucket, cand.r2Key);
    if (bytes === cand.bytes) return true;
  }
  return false;
}

/** Run an async worker over items with a bounded concurrency pool. */
async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  const s3 = new S3Client({
    region: "auto",
    endpoint: config.r2Endpoint,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });
  const sb = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let hadFailure = false;
  if (!args.bakeOnly) {
    hadFailure = (await syncBlends(args, config, s3, sb)) || hadFailure;
  }
  if (args.bakeThumbs) {
    hadFailure = (await bakeThumbsPhase(args, config, s3, sb)) || hadFailure;
  }
  if (hadFailure) process.exitCode = 1;
}

/** Scan the source tree and mirror new/changed .blends to R2 + the registry. */
async function syncBlends(
  args: Args,
  config: Config,
  s3: S3Client,
  sb: SupabaseClient,
): Promise<boolean> {
  console.log(`[fixture-sync] scanning ${args.source} ...`);
  const scanned = await scanBlendFiles(args.source);
  if (scanned.length === 0) {
    console.log("[fixture-sync] no .blend files found — nothing to do");
    return false;
  }

  let candidates = buildCandidates(scanned);
  if (args.skuFilter) {
    const f = args.skuFilter;
    candidates = candidates.filter(
      (c) => c.sku.includes(f) || c.fixtureKey.includes(f),
    );
  }
  candidates.sort((a, b) => a.fixtureKey.localeCompare(b.fixtureKey));
  const skuCount = new Set(candidates.map((c) => c.sku)).size;
  console.log(
    `[fixture-sync] ${scanned.length} .blend files -> ${candidates.length} fixtures ` +
      `(${skuCount} unique SKUs)` +
      (args.skuFilter ? ` (filtered by "${args.skuFilter}")` : ""),
  );

  // The registry is only used to skip unchanged files; a dry-run doesn't need it
  // (and shouldn't require the DB / latest migration to preview the plan).
  const registry = args.dryRun
    ? new Map<string, RegistryRow>()
    : await loadRegistry(sb);
  const stats: Stats = { uploaded: 0, skipped: 0, failed: 0 };

  await pool(candidates, args.concurrency, async (cand) => {
    try {
      if (await isUnchanged(s3, config.r2Bucket, cand, registry)) {
        stats.skipped++;
        console.log(`  skip   ${cand.fixtureKey} (${mb(cand.bytes)}, unchanged)`);
        return;
      }
      if (args.dryRun) {
        stats.uploaded++;
        console.log(`  WOULD  ${cand.fixtureKey} -> ${cand.r2Key} (${mb(cand.bytes)})`);
        return;
      }
      const upload = await uploadBlend(s3, config.r2Bucket, cand);
      await upsertRegistry(sb, cand, upload);
      stats.uploaded++;
      console.log(`  up     ${cand.fixtureKey} -> ${cand.r2Key} (${mb(cand.bytes)})`);
    } catch (e) {
      stats.failed++;
      console.error(`  FAIL   ${cand.fixtureKey}: ${(e as Error).message}`);
    }
  });

  console.log(
    `[fixture-sync] done — ${stats.uploaded} ${args.dryRun ? "would upload" : "uploaded"}, ` +
      `${stats.skipped} skipped, ${stats.failed} failed`,
  );
  return stats.failed > 0;
}

/**
 * Bake a picker thumbnail (GLB → PNG, headless) for every in-scope fixture that
 * doesn't already have one. Run after a normal sync to cover newly-added
 * fixtures, or `--bake-only` to backfill the whole registry.
 */
async function bakeThumbsPhase(
  args: Args,
  config: Config,
  s3: S3Client,
  sb: SupabaseClient,
): Promise<boolean> {
  if (args.dryRun) {
    console.log("[bake] dry-run: skipping thumbnail bake");
    return false;
  }
  if (!config.apiBaseUrl || !config.adminToken) {
    throw new Error(
      "thumbnail bake needs API_BASE_URL (or PUBLIC_BASE_URL) and ADMIN_API_TOKEN",
    );
  }
  console.log("[bake] loading fixtures…");
  const fixtures = await loadBakeFixtures(sb, args.skuFilter);
  console.log(`[bake] ${fixtures.length} fixtures in scope`);
  const stats = await bakeThumbnails(
    {
      s3,
      bucket: config.r2Bucket,
      apiBaseUrl: config.apiBaseUrl,
      adminToken: config.adminToken,
      concurrency: args.concurrency,
    },
    fixtures,
  );
  console.log(
    `[bake] done — ${stats.baked} baked, ${stats.skipped} skipped, ${stats.failed} failed`,
  );
  return stats.failed > 0;
}

main().catch((e) => {
  console.error(`[fixture-sync] fatal: ${(e as Error).message}`);
  process.exit(1);
});
