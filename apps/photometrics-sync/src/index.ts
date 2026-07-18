import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { unzipSync } from "fflate";
import { parseAndBuild } from "./metrics.js";
import { pickRepresentative } from "./match.js";
import { stripNul } from "./pg.js";

/**
 * Thom Bot — IES photometrics precompute (mirrors apps/docs-ingest).
 *
 * Runs as a Node CLI in GitHub Actions (real RAM, no Worker CPU ceiling).
 *
 *  1. Worklist: every product with a non-null ies_url, skipping SKUs already
 *     represented in product_photometrics (idempotent — a re-run only does new
 *     SKUs).
 *  2. Per UNIQUE ies_url (fetch cached across SKUs sharing a family zip): fetch
 *     bytes; a PK\x03\x04 magic ⇒ unzip and take every inner *.ies; otherwise a
 *     single raw .ies.
 *  3. Per inner file: sha256(raw bytes) → content_hash. Reuse an existing
 *     ies_metrics row for that hash, else parse + compute the metric bundle and
 *     upsert one. Inner-file bytes are decoded UTF-8-fatal → gb18030 fallback so
 *     EVERFINE [LUMCAT]/[LUMINAIRE] Chinese keyword text survives.
 *  4. Upsert one product_photometrics row per (product_sku, ies_metrics_id),
 *     flagging exactly ONE is_representative per SKU via the filename matcher.
 *
 * Flags: --dry-run (no writes; report), --limit N (process at most N SKUs).
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "WAC-Marketing-App/1.0 (+thom photometrics; contact WAC IT)";
const PARSER_VERSION = 1;
const UPSERT = 300;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

interface Args {
  dryRun: boolean;
  limit: number | null;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") a.dryRun = true;
    else if (argv[i] === "--limit") a.limit = Number(argv[++i]);
  }
  return a;
}

/** UTF-8 first, GB18030 fallback — ported from WIES zipCache.decodeIesBytes.
 *  The numeric photometric block is ASCII either way; this only matters for the
 *  EVERFINE Chinese keyword text in [LUMCAT]/[LUMINAIRE]. */
function decodeIesBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PK_MAGIC = [0x50, 0x4b, 0x03, 0x04];
function isZip(bytes: Uint8Array): boolean {
  return PK_MAGIC.every((b, i) => bytes[i] === b);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** One inner IES file pulled from a url (raw file or zip entry). */
interface InnerFile {
  filename: string;
  bytes: Uint8Array;
}

/** Expand a fetched url payload into its inner IES file(s). */
function extractInnerFiles(url: string, payload: Uint8Array): InnerFile[] {
  if (isZip(payload)) {
    const entries = unzipSync(payload, {
      filter: (f) => /\.ies$/i.test(f.name),
    });
    return Object.entries(entries).map(([name, bytes]) => ({
      filename: name.split("/").pop() || name,
      bytes,
    }));
  }
  const filename = decodeURIComponent(url.split(/[?#]/)[0] ?? url).split("/").pop() || url;
  return [{ filename, bytes: payload }];
}

interface ProductRow {
  sku: string;
  ies_url: string;
}

/** Strip a `#innerPath` fragment so distinct SKUs pointing at the same family
 *  bundle collapse to one fetch (the fragment isn't sent to the server anyway,
 *  and we enumerate ALL inner files regardless). */
function baseUrl(iesUrl: string): string {
  return iesUrl.split("#")[0] ?? iesUrl;
}

async function loadWorklist(sb: SupabaseClient): Promise<ProductRow[]> {
  const rows: ProductRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("products")
      .select("sku, ies_url")
      .not("ies_url", "is", null)
      .neq("ies_url", "")
      .range(from, from + 999);
    if (error) throw new Error(`products read failed: ${error.message}`);
    const batch = (data ?? []) as ProductRow[];
    for (const r of batch) if (r.sku && r.ies_url) rows.push(r);
    if (batch.length < 1000) break;
  }
  return rows;
}

/** SKUs already represented in product_photometrics — skipped (idempotent). */
async function loadCoveredSkus(sb: SupabaseClient): Promise<Set<string>> {
  const covered = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("product_photometrics")
      .select("product_sku")
      .range(from, from + 999);
    if (error) throw new Error(`product_photometrics read failed: ${error.message}`);
    const batch = data ?? [];
    for (const r of batch) if (r.product_sku) covered.add(r.product_sku as string);
    if (batch.length < 1000) break;
  }
  return covered;
}

/** Resolve (reuse-or-create) an ies_metrics row for a content hash, returning
 *  its id. Reuses only rows that already have a non-null metrics bundle. */
async function upsertIesMetrics(
  sb: SupabaseClient,
  contentHash: string,
  inner: InnerFile,
  sourceZipUrl: string | null,
): Promise<string> {
  const existing = await sb
    .from("ies_metrics")
    .select("id, metrics")
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (existing.error) throw new Error(`ies_metrics read: ${existing.error.message}`);
  if (existing.data?.id && existing.data.metrics) return existing.data.id as string;

  const { metrics, warnings } = parseAndBuild(decodeIesBytes(inner.bytes), inner.filename);
  const { data, error } = await sb
    .from("ies_metrics")
    .upsert(
      // stripNul: keyword text / warning messages / zip filenames can carry a
      // U+0000 that Postgres refuses ("unsupported Unicode escape sequence").
      stripNul({
        content_hash: contentHash,
        inner_filename: inner.filename,
        source_zip_url: sourceZipUrl,
        metrics,
        warnings,
        parser_version: PARSER_VERSION,
        updated_at: new Date().toISOString(),
      }),
      { onConflict: "content_hash" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`ies_metrics upsert: ${error.message}`);
  return data.id as string;
}

interface Counts {
  skus: number;
  urls: number;
  innerFiles: number;
  metricsRows: number;
  linkRows: number;
  failedUrls: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const worklist = await loadWorklist(sb);
  const covered = await loadCoveredSkus(sb);
  let pending = worklist.filter((r) => !covered.has(r.sku));
  if (args.limit != null) pending = pending.slice(0, args.limit);

  // Group pending SKUs by the base ies_url so a shared family bundle is fetched
  // + parsed exactly once.
  const skusByUrl = new Map<string, ProductRow[]>();
  for (const r of pending) {
    const key = baseUrl(r.ies_url);
    const list = skusByUrl.get(key);
    if (list) list.push(r);
    else skusByUrl.set(key, [r]);
  }

  const counts: Counts = {
    skus: pending.length,
    urls: skusByUrl.size,
    innerFiles: 0,
    metricsRows: 0,
    linkRows: 0,
    failedUrls: 0,
  };

  if (args.dryRun) {
    console.log(
      `[photometrics-sync] (dry-run) ${worklist.length} products with ies_url, ` +
        `${covered.size} SKUs already covered, ${pending.length} pending across ` +
        `${skusByUrl.size} unique bundles`,
    );
    return;
  }

  const links: Record<string, unknown>[] = [];

  for (const [url, skus] of skusByUrl) {
    let inners: InnerFile[];
    try {
      const payload = await fetchBytes(url);
      inners = extractInnerFiles(url, payload);
    } catch (e) {
      counts.failedUrls++;
      console.warn(`[photometrics-sync] FAIL fetch ${url}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!inners.length) {
      counts.failedUrls++;
      console.warn(`[photometrics-sync] no .ies entries in ${url}`);
      continue;
    }
    counts.innerFiles += inners.length;

    // Resolve one ies_metrics id per inner file (deduped by content hash).
    const isZipBundle = inners.length > 1;
    const metricIds: string[] = [];
    for (const inner of inners) {
      const hash = sha256(inner.bytes);
      const id = await upsertIesMetrics(sb, hash, inner, isZipBundle ? url : null);
      metricIds.push(id);
      counts.metricsRows++;
    }

    // Link every SKU sharing this bundle to every inner optic, flagging exactly
    // one representative per SKU via the filename matcher.
    const filenames = inners.map((i) => i.filename);
    for (const { sku, ies_url } of skus) {
      const pick = pickRepresentative(sku, filenames);
      for (let i = 0; i < metricIds.length; i++) {
        links.push({
          product_sku: sku,
          ies_metrics_id: metricIds[i],
          ies_url,
          is_representative: i === pick.index,
          match_confidence: pick.scores[i] ?? 0,
          scope: "public",
        });
      }
      counts.linkRows += metricIds.length;
    }
  }

  for (let i = 0; i < links.length; i += UPSERT) {
    const { error } = await sb
      .from("product_photometrics")
      .upsert(links.slice(i, i + UPSERT), { onConflict: "product_sku,ies_metrics_id" });
    if (error) throw new Error(`product_photometrics upsert failed: ${error.message}`);
  }

  console.log(
    `[photometrics-sync] ${counts.skus} SKUs / ${counts.urls} bundles → ` +
      `${counts.innerFiles} inner files, ${counts.metricsRows} metrics rows, ` +
      `${counts.linkRows} links (${counts.failedUrls} bundle fetch failures)`,
  );
}

main().catch((e) => {
  console.error(`[photometrics-sync] fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
