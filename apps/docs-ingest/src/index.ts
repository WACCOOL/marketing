import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { chunkText, estimateTokens } from "./chunk.js";
import { embed, toVectorLiteral, type CfCreds } from "./embed.js";
import { extractPdf, type ClaudeCfg } from "./extract.js";

/**
 * Thom Bot document ingestion (Tier B) — the heavy, out-of-band pass that makes
 * spec sheets + manuals ANSWERABLE. Runs as a Node CLI in GitHub Actions (real
 * RAM, no Worker CPU ceiling), mirroring apps/products-sync.
 *
 * Two steps:
 *  A. Fold the re-derived spec-sheet URLs (pdp_urls.spec_sheet_url, written by
 *     products-sync) into kb_documents for products with no static Sales Layer
 *     spec sheet — the coverage gap. (Sales Layer manuals + static spec sheets
 *     already land in kb_documents via the saleslayer doc capture.)
 *  B. For every kb_documents row still `pending_extract`: fetch the PDF, extract
 *     text (born-digital layer, Claude-vision fallback for scanned/table pages),
 *     chunk, embed (Workers AI bge-m3), upsert kb_chunks, flip to `active`.
 *
 * Resumable by construction: the row `status` IS the checkpoint — a re-run picks
 * up whatever's still `pending_extract`, so a CI timeout just resumes next run.
 *
 * Flags: --dry-run (no writes; report), --limit N (process at most N docs),
 *        --skip-pdp (extract only, skip step A).
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CF_ACCOUNT_ID, CF_AI_TOKEN,
 *      ANTHROPIC_API_KEY (optional — enables the vision fallback),
 *      ANTHROPIC_PDF_MODEL (optional, default claude-haiku-4-5).
 */

const EXTRACT_BATCH = 50; // docs pulled per loop
const POOL = 4; // concurrent docs
const CHUNK_INSERT = 500;
const UPSERT = 300;
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "WAC-Marketing-App/1.0 (+thom doc ingest; contact WAC IT)";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

interface Args {
  dryRun: boolean;
  skipPdp: boolean;
  skipProducts: boolean;
  limit: number | null;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, skipPdp: false, skipProducts: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") a.dryRun = true;
    else if (argv[i] === "--skip-pdp") a.skipPdp = true;
    else if (argv[i] === "--skip-products") a.skipProducts = true;
    else if (argv[i] === "--limit") a.limit = Number(argv[++i]);
  }
  return a;
}

async function mapPool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// --- Step A: fold re-derived spec-sheet URLs into kb_documents --------------

async function syncPdpSpecSheets(sb: SupabaseClient, dryRun: boolean): Promise<number> {
  // SKUs that already have a spec sheet captured (Sales Layer static PDF) — we
  // only fill the gap, never duplicate.
  const covered = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("product_documents")
      .select("product_sku")
      .eq("doc_type", "spec_sheet")
      .range(from, from + 999);
    if (error) throw new Error(`product_documents read failed: ${error.message}`);
    for (const r of data ?? []) if (r.product_sku) covered.add(r.product_sku as string);
    if ((data?.length ?? 0) < 1000) break;
  }

  interface PdpRow {
    sku: string;
    brand: string | null;
    spec_sheet_url: string | null;
  }
  const candidates: PdpRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("pdp_urls")
      .select("sku, brand, spec_sheet_url")
      .not("spec_sheet_url", "is", null)
      .range(from, from + 999);
    if (error) throw new Error(`pdp_urls read failed: ${error.message}`);
    const rows = (data ?? []) as PdpRow[];
    for (const r of rows) {
      if (r.sku && r.spec_sheet_url && !covered.has(r.sku)) candidates.push(r);
    }
    if (rows.length < 1000) break;
  }
  if (!candidates.length) return 0;
  if (dryRun) {
    console.log(`[docs-ingest] (dry-run) would add ${candidates.length} re-derived spec sheets`);
    return candidates.length;
  }

  // Distinct docs keyed by URL (external_id).
  const byUrl = new Map<string, { url: string; brand: string | null }>();
  for (const c of candidates) if (!byUrl.has(c.spec_sheet_url!)) byUrl.set(c.spec_sheet_url!, { url: c.spec_sheet_url!, brand: c.brand });

  const idByUrl = new Map<string, string>();
  const docRows = [...byUrl.values()];
  for (let i = 0; i < docRows.length; i += UPSERT) {
    const chunk = docRows.slice(i, i + UPSERT).map((d) => ({
      source_system: "pdp_resolver",
      external_id: d.url,
      doc_type: "spec_sheet",
      scope: "public",
      brand: d.brand,
      url: d.url,
    }));
    const { data, error } = await sb
      .from("kb_documents")
      .upsert(chunk, { onConflict: "source_system,external_id" })
      .select("id, external_id");
    if (error) throw new Error(`kb_documents upsert failed: ${error.message}`);
    for (const r of data ?? []) idByUrl.set(r.external_id as string, r.id as string);
  }

  const seen = new Set<string>();
  const links: Record<string, unknown>[] = [];
  for (const c of candidates) {
    const document_id = idByUrl.get(c.spec_sheet_url!);
    if (!document_id) continue;
    const key = `${document_id}|${c.sku}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      document_id,
      product_sku: c.sku,
      doc_type: "spec_sheet",
      label: "Specification Sheet",
      url: c.spec_sheet_url,
      scope: "public",
    });
  }
  for (let i = 0; i < links.length; i += UPSERT) {
    const { error } = await sb
      .from("product_documents")
      .upsert(links.slice(i, i + UPSERT), { onConflict: "document_id,product_sku" });
    if (error) throw new Error(`product_documents upsert failed: ${error.message}`);
  }
  return byUrl.size;
}

// --- Step A2: backfill product embeddings -----------------------------------

/**
 * Embed the product catalog into products.embedding so product_semantic_search
 * actually does SEMANTIC matching (without this it silently runs lexical-only —
 * e.g. "outdoor track" wouldn't find products named "H Track / J2 Track").
 * Only fills NULLs, so it's a one-time backfill then near-zero each run. The
 * daily Sales Layer sync omits `embedding` from its upsert, so it preserves
 * these; new products come back NULL and get embedded on the next run.
 */
function productText(r: Record<string, unknown>): string {
  const parts: string[] = [];
  if (r.name) parts.push(String(r.name));
  if (r.brand) parts.push(`Brand: ${r.brand}`);
  if (r.category) parts.push(`Category: ${r.category}`);
  if (r.family) parts.push(`Family: ${r.family}`);
  const variants = Array.isArray(r.variants) ? (r.variants as Record<string, unknown>[]) : [];
  const descriptors = new Set<string>();
  for (const v of variants.slice(0, 12)) {
    for (const k of ["finish", "cct_desc", "beam_desc"]) {
      const val = v[k];
      if (typeof val === "string" && val.trim()) descriptors.add(val.trim());
    }
  }
  if (descriptors.size) parts.push([...descriptors].join(", "));
  return parts.join(". ").slice(0, 1000);
}

async function backfillProductEmbeddings(
  sb: SupabaseClient,
  cf: CfCreds,
  dryRun: boolean,
): Promise<number> {
  let total = 0;
  for (;;) {
    const { data, error } = await sb
      .from("products")
      .select("sku, name, brand, category, family, variants")
      .is("embedding", null)
      .limit(200);
    if (error) throw new Error(`products read failed: ${error.message}`);
    const rows = (data ?? []) as Record<string, unknown>[];
    if (!rows.length) break;
    if (dryRun) {
      console.log(`[docs-ingest] (dry-run) ${rows.length}+ products need embeddings`);
      return rows.length;
    }
    const vecs = await embed(cf, rows.map(productText));
    await mapPool(
      rows.map((r, i) => ({ sku: String(r.sku), vec: vecs[i]! })),
      8,
      async ({ sku, vec }) => {
        const { error: uErr } = await sb
          .from("products")
          .update({ embedding: toVectorLiteral(vec) })
          .eq("sku", sku);
        if (uErr) throw new Error(`product embedding update ${sku}: ${uErr.message}`);
      },
    );
    total += rows.length;
    console.log(`[docs-ingest] embedded ${total} products…`);
    if (rows.length < 200) break;
  }
  return total;
}

// --- Step B: extract + embed pending docs -----------------------------------

interface PendingDoc {
  id: string;
  url: string | null;
  scope: string;
  doc_type: string;
  brand: string | null;
}

function isPdf(bytes: Uint8Array): boolean {
  // %PDF magic — robust against dynamic endpoints that mislabel content-type.
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

async function fetchPdf(url: string): Promise<Uint8Array> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": USER_AGENT, accept: "application/pdf,*/*" },
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!isPdf(bytes)) throw new Error("not a PDF (dynamic endpoint returned non-PDF)");
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

interface Counts {
  active: number;
  failed: number;
  chunks: number;
}

async function processDoc(
  sb: SupabaseClient,
  doc: PendingDoc,
  cf: CfCreds,
  claude: ClaudeCfg | null,
  counts: Counts,
): Promise<void> {
  const fail = async (msg: string): Promise<void> => {
    counts.failed++;
    console.warn(`[docs-ingest] FAIL ${doc.id} ${doc.url}: ${msg}`);
    await sb
      .from("kb_documents")
      .update({ status: "failed", last_error: msg.slice(0, 500) })
      .eq("id", doc.id);
  };

  try {
    if (!doc.url) return await fail("no url");
    const bytes = await fetchPdf(doc.url);
    const { text, pages, method } = await extractPdf(bytes, claude);
    if (!text) return await fail("no extractable text");
    const chunks = chunkText(text);
    if (!chunks.length) return await fail("no chunks");

    const vecs = await embed(cf, chunks.map((c) => c.content));
    const rows = chunks.map((c, i) => ({
      document_id: doc.id,
      scope: doc.scope,
      doc_type: doc.doc_type,
      brand: doc.brand,
      chunk_index: c.index,
      page: null,
      content: c.content,
      token_count: estimateTokens(c.content),
      embedding: toVectorLiteral(vecs[i]!),
    }));

    // Clean re-embed: drop any prior chunks, then insert.
    const del = await sb.from("kb_chunks").delete().eq("document_id", doc.id);
    if (del.error) throw new Error(`kb_chunks delete: ${del.error.message}`);
    for (let i = 0; i < rows.length; i += CHUNK_INSERT) {
      const ins = await sb.from("kb_chunks").insert(rows.slice(i, i + CHUNK_INSERT));
      if (ins.error) throw new Error(`kb_chunks insert: ${ins.error.message}`);
    }
    const upd = await sb
      .from("kb_documents")
      .update({ status: "active", extracted_at: new Date().toISOString(), last_error: null })
      .eq("id", doc.id);
    if (upd.error) throw new Error(`kb_documents update: ${upd.error.message}`);

    counts.active++;
    counts.chunks += chunks.length;
    console.log(`[docs-ingest] ok ${doc.id} ${chunks.length} chunks (${pages}p, ${method})`);
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
  }
}

async function processPending(
  sb: SupabaseClient,
  cf: CfCreds,
  claude: ClaudeCfg | null,
  limit: number | null,
  dryRun: boolean,
): Promise<Counts> {
  const counts: Counts = { active: 0, failed: 0, chunks: 0 };
  let remaining = limit ?? Infinity;

  if (dryRun) {
    const { count, error } = await sb
      .from("kb_documents")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending_extract");
    if (error) throw new Error(`count failed: ${error.message}`);
    console.log(`[docs-ingest] (dry-run) ${count ?? 0} documents pending extraction`);
    return counts;
  }

  for (;;) {
    if (remaining <= 0) break;
    const take = Math.min(EXTRACT_BATCH, remaining);
    const { data, error } = await sb
      .from("kb_documents")
      .select("id, url, scope, doc_type, brand")
      .eq("status", "pending_extract")
      .order("created_at", { ascending: true })
      .limit(take);
    if (error) throw new Error(`pending read failed: ${error.message}`);
    const batch = (data ?? []) as PendingDoc[];
    if (!batch.length) break;
    await mapPool(batch, POOL, (d) => processDoc(sb, d, cf, claude, counts));
    remaining -= batch.length;
    // Guard against a stuck row that never leaves pending (shouldn't happen —
    // every path flips to active or failed — but never spin forever).
    if (batch.length < take) break;
  }
  return counts;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const cf: CfCreds = { accountId: env("CF_ACCOUNT_ID"), token: env("CF_AI_TOKEN") };
  const claude: ClaudeCfg | null = process.env.ANTHROPIC_API_KEY
    ? {
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.ANTHROPIC_PDF_MODEL || "claude-haiku-4-5",
      }
    : null;
  if (!claude) {
    console.warn("[docs-ingest] ANTHROPIC_API_KEY unset — no vision fallback for scanned/table PDFs");
  }

  if (!args.skipPdp) {
    const added = await syncPdpSpecSheets(sb, args.dryRun);
    console.log(`[docs-ingest] step A: ${added} re-derived spec sheets folded into the KB`);
  }
  if (!args.skipProducts) {
    const embedded = await backfillProductEmbeddings(sb, cf, args.dryRun);
    console.log(`[docs-ingest] step A2: ${embedded} product embeddings backfilled`);
  }
  const counts = await processPending(sb, cf, claude, args.limit, args.dryRun);
  console.log(
    `[docs-ingest] step B: ${counts.active} extracted (${counts.chunks} chunks), ${counts.failed} failed`,
  );
}

main().catch((e) => {
  console.error(`[docs-ingest] fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
