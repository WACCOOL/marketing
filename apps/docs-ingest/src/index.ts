import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { chunkText, estimateTokens, resolveKbDocStatus, type KbDocStatusRow } from "@wac/shared";
import { DIMMING_REPORT_DOC_TYPE } from "@wac/shared/thom";
import { runDimming } from "./dimming.js";
import {
  articleContentHash,
  articleScope,
  buildArticleDocPayload,
  mapArticleBrand,
  parseBrandMap,
  ZENDESK_ARTICLE_DOC_TYPE,
  ZENDESK_SOURCE_SYSTEM,
} from "./articles.js";
import {
  ADMIN_UPLOAD_SOURCE,
  extractAdminUpload,
  TRUNCATION_WARNING,
} from "./adminUpload.js";
import { embed, toVectorLiteral, type CfCreds } from "./embed.js";
import { claudeVision, extractPdf, extractPdfPageTexts, type ClaudeCfg } from "./extract.js";
import { htmlToText } from "./html.js";
import { enabledSites } from "./crawl/sites.js";
import { webStoreFromEnv, type WebStore } from "./crawl/store.js";
import { crawlSite, extractWebDocText } from "./crawl/stepW.js";
import { healMfSpecs } from "./crawl/healMfSpecs.js";
import { reconcilePdp } from "./crawl/reconcilePdp.js";
import { redactTicketText } from "./redact.js";
import {
  ZendeskReader,
  zendeskCredsFromEnv,
  type ZendeskTicketComment,
  type ZendeskUser,
} from "./zendesk.js";

const ZENDESK_TICKET_DOC_TYPE = "zendesk_ticket";

/**
 * Assemble the REDACTED body for a ticket: subject + PUBLIC comment bodies,
 * concatenated, with requester/CC/author display names + emails/phones/
 * signatures stripped BEFORE it is returned (so only redacted text is ever
 * chunked/embedded). Reads nothing else; never persists the raw text.
 */
async function extractTicketText(
  zd: ZendeskReader,
  externalId: string,
): Promise<string> {
  const t = await zd.getTicket(externalId);
  if (!t) throw new Error("zendesk ticket gone");
  const { comments, users } = await zd.getTicketComments(externalId);

  // Names to redact: every side-loaded user (requester, submitter, CCs, comment
  // authors) — the ticket + comments users arrays cover all of them.
  const names = new Set<string>();
  const collect = (list: ZendeskUser[]) => {
    for (const u of list) if (u?.name) names.add(u.name);
  };
  collect(t.users);
  collect(users);

  const parts: string[] = [];
  if (t.ticket.subject) parts.push(t.ticket.subject);
  for (const c of comments as ZendeskTicketComment[]) {
    const raw = c.plain_body ?? (c.html_body ? htmlToText(c.html_body) : c.body ?? "");
    if (raw.trim()) parts.push(raw);
  }
  return redactTicketText(parts.join("\n\n"), [...names]);
}

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
 * Also (dark-launched behind THOM_ZENDESK_ARTICLES):
 *  C. Capture ZenDesk Help Center ARTICLES: list published articles, brand/scope
 *     tag them, upsert kb_documents (pending_extract), supersede unpublished
 *     ones. Step B then re-reads each article body from ZenDesk (HTML → text),
 *     chunks, embeds, and flips it to active — same plumbing as PDFs.
 *
 * Resumable by construction: the row `status` IS the checkpoint — a re-run picks
 * up whatever's still `pending_extract`, so a CI timeout just resumes next run.
 *
 * Flags: --dry-run (no writes; report), --limit N (process at most N docs),
 *        --skip-pdp (extract only, skip step A), --skip-products (skip A2),
 *        --skip-zendesk (skip step C), --heal-mf-specs (one-off Modern Forms
 *        spec-sheet heal ONLY — see crawl/healMfSpecs.ts).
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CF_ACCOUNT_ID, CF_AI_TOKEN,
 *      ANTHROPIC_API_KEY (optional — enables the vision fallback),
 *      ANTHROPIC_PDF_MODEL (optional, default claude-haiku-4-5),
 *      THOM_ZENDESK_ARTICLES (=1 to run step C), ZENDESK_SUBDOMAIN/EMAIL/
 *      API_TOKEN (Help Center read), ZENDESK_HC_LOCALE (default en-us),
 *      ZENDESK_HC_BRAND_MAP (JSON section/category id -> brand).
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
  skipZendesk: boolean;
  skipCrawl: boolean;
  limit: number | null;
  /** Max page FETCHES per site in Step W (discovery is unlimited). */
  crawlLimit: number | null;
  /** Fetch WordPress-brand PDPs for reconciliation evidence (wacarchitectural
   *  PDPs are always fetched — they are ingested content there). */
  harvestPdp: boolean;
  /** Ingest opt-in content types (wacarchitectural project case studies). */
  includeOptIn: boolean;
  /** Run the PDP reconciliation pass (plan E) over crawl_frontier evidence.
   *  Report-only unless --reconcile-write is ALSO passed (gap-only heals). */
  reconcilePdp: boolean;
  reconcileWrite: boolean;
  /** One-off Modern Forms spec-sheet heal: rewrite the bad PDP-path dispatcher
   *  heals to verified dynamic-specsheet URLs and requeue their failed kb rows
   *  (see crawl/healMfSpecs.ts). Runs ONLY the heal, then exits. */
  healMfSpecs: boolean;
  /** Requeue previously status='failed' rows to pending_extract before Step B,
   *  so a re-run retries them (e.g. after a burst of transient upstream 502s). */
  retryFailed: boolean;
  /** Dimming-chart structured extraction (dimming plan §B): runs ONLY the
   *  dimming step (unzip -> Claude forced-tool extraction -> verification gate
   *  -> product binding -> supersession sweep). */
  dimming: boolean;
  /** --dimming --sample N: process at most N units and print the verification
   *  report for Davis's gate (sample-then-STOP, plan §G.3). */
  sample: number | null;
}
function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false,
    skipPdp: false,
    skipProducts: false,
    skipZendesk: false,
    skipCrawl: false,
    limit: null,
    crawlLimit: null,
    harvestPdp: false,
    includeOptIn: false,
    reconcilePdp: false,
    reconcileWrite: false,
    healMfSpecs: false,
    retryFailed: false,
    dimming: false,
    sample: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") a.dryRun = true;
    else if (argv[i] === "--skip-pdp") a.skipPdp = true;
    else if (argv[i] === "--skip-products") a.skipProducts = true;
    else if (argv[i] === "--skip-zendesk") a.skipZendesk = true;
    else if (argv[i] === "--skip-crawl") a.skipCrawl = true;
    else if (argv[i] === "--harvest-pdp") a.harvestPdp = true;
    else if (argv[i] === "--include-optin") a.includeOptIn = true;
    else if (argv[i] === "--reconcile-pdp") a.reconcilePdp = true;
    else if (argv[i] === "--reconcile-write") a.reconcileWrite = true;
    else if (argv[i] === "--heal-mf-specs") a.healMfSpecs = true;
    else if (argv[i] === "--retry-failed") a.retryFailed = true;
    else if (argv[i] === "--dimming") a.dimming = true;
    else if (argv[i] === "--sample") a.sample = Number(argv[++i]);
    else if (argv[i] === "--limit") a.limit = Number(argv[++i]);
    else if (argv[i] === "--crawl-limit") a.crawlLimit = Number(argv[++i]);
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
      .neq("spec_sheet_url", "") // "" = resolver attempted, none found
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

// --- Step C: capture ZenDesk Help Center articles ---------------------------

/**
 * List published Help Center articles and project them into kb_documents so the
 * extraction pass (Step B) picks them up. Dark-launched behind
 * THOM_ZENDESK_ARTICLES; only runs when the reader is configured.
 *
 * Idempotency: article external_ids are STABLE ZenDesk ids, so the upsert's ON
 * CONFLICT UPDATE path must set `status` explicitly — a NEW, EDITED (changed
 * content_hash), or RE-PUBLISHED (previously superseded) article is requeued to
 * 'pending_extract' via resolveKbDocStatus, and an unchanged one keeps its
 * current status. An article we previously captured that is now draft / deleted
 * / unpublished (absent from the current published set) is flipped to
 * 'superseded' so kb_search (active only) can't retrieve it and Step B (pending
 * only) won't re-extract it.
 */
async function captureZendeskArticles(
  sb: SupabaseClient,
  reader: ZendeskReader,
  locale: string,
  brandMap: Map<string, string>,
  dryRun: boolean,
): Promise<{ published: number; superseded: number }> {
  const articles = await reader.listArticles({ locale });
  const published = articles.filter((a) => a.draft === false);
  const publishedIds = new Set(published.map((a) => String(a.id)));

  let withBrand = 0;
  let internalScope = 0;
  const enriched = published.map((a) => {
    const brand = mapArticleBrand(a, brandMap);
    if (brand) withBrand++;
    if (articleScope(a) === "internal") internalScope++;
    return { article: a, brand, hash: articleContentHash(a) };
  });

  if (dryRun) {
    console.log(
      `[docs-ingest] (dry-run) zendesk: ${articles.length} fetched, ${published.length} published ` +
        `(${withBrand} brand-mapped, ${internalScope} internal)`,
    );
    return { published: published.length, superseded: 0 };
  }

  // Every article row we've captured before, ANY status: (content_hash, status)
  // feed resolveKbDocStatus so edited/re-published articles get requeued, and
  // the non-superseded ids drive the supersede diff below.
  const existingByExtId = new Map<string, KbDocStatusRow>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("kb_documents")
      .select("external_id, content_hash, status")
      .eq("source_system", ZENDESK_SOURCE_SYSTEM)
      .eq("doc_type", ZENDESK_ARTICLE_DOC_TYPE)
      .range(from, from + 999);
    if (error) throw new Error(`kb_documents (zendesk) read failed: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows) {
      existingByExtId.set(String(r.external_id), {
        content_hash: (r.content_hash as string | null) ?? null,
        status: String(r.status),
      });
    }
    if (rows.length < 1000) break;
  }

  let requeued = 0;
  const docRows = enriched.map(({ article, brand, hash }) => {
    const existing = existingByExtId.get(String(article.id));
    const status = resolveKbDocStatus(existing, hash);
    if (existing && existing.status !== status) requeued++;
    return buildArticleDocPayload(article, brand, hash, status);
  });

  for (let i = 0; i < docRows.length; i += UPSERT) {
    const { error } = await sb
      .from("kb_documents")
      .upsert(docRows.slice(i, i + UPSERT), { onConflict: "source_system,external_id" });
    if (error) throw new Error(`kb_documents (zendesk) upsert failed: ${error.message}`);
  }

  const toSupersede = [...existingByExtId.entries()]
    .filter(([id, row]) => row.status !== "superseded" && !publishedIds.has(id))
    .map(([id]) => id);
  let superseded = 0;
  for (let i = 0; i < toSupersede.length; i += UPSERT) {
    const slice = toSupersede.slice(i, i + UPSERT);
    const { error } = await sb
      .from("kb_documents")
      .update({ status: "superseded" })
      .eq("source_system", ZENDESK_SOURCE_SYSTEM)
      .eq("doc_type", ZENDESK_ARTICLE_DOC_TYPE)
      .in("external_id", slice);
    if (error) throw new Error(`kb_documents (zendesk) supersede failed: ${error.message}`);
    superseded += slice.length;
  }

  console.log(
    `[docs-ingest] zendesk: ${articles.length} fetched, ${published.length} published upserted ` +
      `(${withBrand} brand-mapped, ${internalScope} internal), ${requeued} requeued, ${superseded} superseded`,
  );
  return { published: published.length, superseded };
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
  source_system: string;
  external_id: string;
  r2_key: string | null;
}

function isPdf(bytes: Uint8Array): boolean {
  // %PDF magic — robust against dynamic endpoints that mislabel content-type.
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

const FETCH_RETRIES = 4;

async function fetchPdfOnce(url: string): Promise<Uint8Array> {
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

/** Whether a fetch error is worth retrying: upstream 5xx/429 (the dynamic brand
 *  spec-sheet endpoints 502 under burst load) and transient network/abort
 *  errors. A 4xx or "not a PDF" is permanent — surface it immediately. */
function isTransientFetchError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  if (/^fetch (5\d\d|429)$/.test(m)) return true;
  return /terminated|aborted|network|socket|ECONN|EAI_AGAIN|ETIMEDOUT|fetch failed/i.test(m);
}

async function fetchPdf(url: string): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      return await fetchPdfOnce(url);
    } catch (e) {
      lastErr = e;
      if (!isTransientFetchError(e) || attempt === FETCH_RETRIES) throw e;
      // Exponential backoff + jitter; spreads retries so the brand CDN recovers.
      const wait = Math.min(20_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
  throw lastErr;
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
  zd: ZendeskReader | null,
  web: WebStore | null,
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
    // Marketing custom content (source_system='marketing_admin') has no PDF: its
    // authored markdown lives in marketing_content.body, keyed by external_id.
    // This is the docs-ingest fallback for the in-Worker on-save embed (which
    // leaves the row pending_extract if Workers AI throws). Everything else is a
    // PDF fetched from its url.
    let text = "";
    let pages = 1;
    let method = "marketing";
    // admin_upload rows are chunked page-aware in their branch (chunks carry a
    // real `page`); every other source fills `text` for the shared chunkText
    // path below (page: null).
    let prechunked: { index: number; content: string; page: number | null }[] | null = null;
    let truncationWarning: string | null = null;
    if (doc.source_system === ADMIN_UPLOAD_SOURCE) {
      // Admin-uploaded education PDF: read the bytes from R2 (no public url),
      // extract PER PAGE so chunks carry real page numbers, cap-raised chunking
      // with the truncation surfaced as a WARNING (status stays active).
      const res = await extractAdminUpload(doc.r2_key, {
        getObject: web ? (k) => web.getObject(k) : null,
        extractPages: extractPdfPageTexts,
        vision: claude ? (b) => claudeVision(b, claude) : null,
      });
      if (!res.ok) return await fail(res.error);
      prechunked = res.chunks;
      truncationWarning = res.truncated ? TRUNCATION_WARNING : null;
      pages = res.pageCount;
      method = res.method;
    } else if (doc.source_system === "marketing_admin") {
      const { data: mc, error: mcErr } = await sb
        .from("marketing_content")
        .select("body, status")
        .eq("id", doc.external_id)
        .maybeSingle();
      if (mcErr) return await fail(`marketing_content read: ${mcErr.message}`);
      if (!mc) return await fail("marketing_content row gone");
      if (mc.status !== "published") return await fail("marketing_content not published");
      text = String(mc.body ?? "");
    } else if (doc.doc_type === ZENDESK_ARTICLE_DOC_TYPE) {
      // ZenDesk Help Center article: re-read the (HTML) body from ZenDesk and
      // strip it to text. NOT a PDF, so it never routes through fetchPdf.
      if (!zd) return await fail("zendesk reader not configured");
      const article = await zd.getArticle(doc.external_id);
      if (!article) return await fail("zendesk article gone");
      text = htmlToText(article.body ?? "");
      method = "zendesk_article";
    } else if (doc.doc_type === ZENDESK_TICKET_DOC_TYPE) {
      // Internal support ticket: subject + PUBLIC comments, PII-REDACTED before
      // it ever becomes `text` (nothing unredacted reaches kb_chunks). The
      // pointer row is scope='internal', so its chunks inherit internal scope.
      if (!zd) return await fail("zendesk reader not configured");
      text = await extractTicketText(zd, doc.external_id);
      method = "zendesk_ticket";
    } else if (doc.source_system === "web_crawl") {
      // Crawled web page: Step W stored the ready chunkable text in R2; fall
      // back to refetch + re-extract when the object (or R2 itself) is absent.
      let t: string | null = null;
      if (web && doc.r2_key) t = await web.getText(doc.r2_key);
      if (!t) t = await extractWebDocText(doc.url ?? doc.external_id, doc.brand ?? "");
      if (!t) return await fail("web page unavailable (js_shell/soft404/fetch)");
      text = t;
      method = "web_crawl";
    } else {
      if (!doc.url) return await fail("no url");
      const bytes = await fetchPdf(doc.url);
      const extracted = await extractPdf(bytes, claude);
      text = extracted.text;
      pages = extracted.pages;
      method = extracted.method;
    }
    if (!prechunked && !text) return await fail("no extractable text");
    const chunks =
      prechunked ??
      chunkText(text).map((c) => ({ index: c.index, content: c.content, page: null as number | null }));
    if (!chunks.length) return await fail("no chunks");

    const vecs = await embed(cf, chunks.map((c) => c.content));
    const rows = chunks.map((c, i) => ({
      document_id: doc.id,
      scope: doc.scope,
      doc_type: doc.doc_type,
      brand: doc.brand,
      chunk_index: c.index,
      page: c.page,
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
    // Truncation (admin uploads hitting the chunk cap) rides in last_error with
    // a WARNING prefix so the admin UI can surface it — status stays active.
    const upd = await sb
      .from("kb_documents")
      .update({
        status: "active",
        extracted_at: new Date().toISOString(),
        last_error: truncationWarning,
      })
      .eq("id", doc.id);
    if (upd.error) throw new Error(`kb_documents update: ${upd.error.message}`);

    counts.active++;
    counts.chunks += chunks.length;
    console.log(
      `[docs-ingest] ok ${doc.id} ${chunks.length} chunks (${pages}p, ${method}` +
        `${truncationWarning ? ", TRUNCATED" : ""})`,
    );
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
  }
}

export async function processPending(
  sb: SupabaseClient,
  cf: CfCreds,
  claude: ClaudeCfg | null,
  zd: ZendeskReader | null,
  web: WebStore | null,
  limit: number | null,
  dryRun: boolean,
): Promise<Counts> {
  const counts: Counts = { active: 0, failed: 0, chunks: 0 };
  let remaining = limit ?? Infinity;

  // Dimming charts are STRUCTURED-EXTRACTION-ONLY (dimming plan DC7): the
  // .neq below keeps their pending rows out of the chunk/embed loop — landing
  // capture without this exclusion would text-extract and embed the mangled
  // grids on the next nightly run, the exact RAG poison the plan exists to
  // prevent. The `--dimming` step flips them to 'active' (zero chunks =
  // invisible to search_docs by construction).
  if (dryRun) {
    const { count, error } = await sb
      .from("kb_documents")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending_extract")
      .neq("doc_type", DIMMING_REPORT_DOC_TYPE);
    if (error) throw new Error(`count failed: ${error.message}`);
    console.log(`[docs-ingest] (dry-run) ${count ?? 0} documents pending extraction`);
    return counts;
  }

  for (;;) {
    if (remaining <= 0) break;
    const take = Math.min(EXTRACT_BATCH, remaining);
    const { data, error } = await sb
      .from("kb_documents")
      .select("id, url, scope, doc_type, brand, source_system, external_id, r2_key")
      .eq("status", "pending_extract")
      .neq("doc_type", DIMMING_REPORT_DOC_TYPE)
      .order("created_at", { ascending: true })
      .limit(take);
    if (error) throw new Error(`pending read failed: ${error.message}`);
    const batch = (data ?? []) as PendingDoc[];
    if (!batch.length) break;
    await mapPool(batch, POOL, (d) => processDoc(sb, d, cf, claude, zd, web, counts));
    remaining -= batch.length;
    // Guard against a stuck row that never leaves pending (shouldn't happen —
    // every path flips to active or failed — but never spin forever).
    if (batch.length < take) break;
  }
  return counts;
}

/** --retry-failed requeue. Dimming charts are excluded (DC7) — their failures
 *  belong to the `--dimming` step, never to the chunk/embed loop. Exported for
 *  the Step-B exclusion test. */
export async function requeueFailed(sb: SupabaseClient): Promise<number> {
  const { data, error } = await sb
    .from("kb_documents")
    .update({ status: "pending_extract" })
    .eq("status", "failed")
    .neq("doc_type", DIMMING_REPORT_DOC_TYPE)
    .select("id");
  if (error) throw new Error(`retry-failed requeue failed: ${error.message}`);
  console.log(`[docs-ingest] retry-failed: requeued ${data?.length ?? 0} previously-failed docs`);
  return data?.length ?? 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // --heal-mf-specs: one-off Modern Forms spec-sheet heal (bad PDP-path
  // dispatcher heals -> verified dynamic-specsheet URLs + kb requeue). Runs
  // ONLY the heal, then exits — needs no CF/Anthropic creds.
  if (args.healMfSpecs) {
    await healMfSpecs(sb, {}, { dryRun: args.dryRun });
    return;
  }
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

  // ZenDesk Help Center reader — used by Step C (capture) and Step B (article
  // body re-fetch). Built whenever the ZENDESK_* creds are present, independent
  // of the capture flag, so any zendesk_article rows already pending from a
  // prior run can still be extracted.
  const zdCreds = zendeskCredsFromEnv(process.env);
  const zd = zdCreds ? new ZendeskReader(zdCreds) : null;

  // R2 page cache for Step W / Step B (optional — see crawl/store.ts).
  const webStore = webStoreFromEnv(process.env);

  // --dimming: run ONLY the dimming-chart structured extraction (plan §B) —
  // unzip, forced-tool extraction, verification gate, product binding, and the
  // supersession sweep — then exit. Kept separate from the chunk/embed steps
  // so the gated `--dimming --sample 10` Actions run is exactly one thing.
  if (args.dimming) {
    await runDimming(sb, webStore, {
      dryRun: args.dryRun,
      sample: args.sample,
      apiKey: process.env.ANTHROPIC_API_KEY ?? null,
      model: process.env.ANTHROPIC_DIMMING_MODEL || undefined,
      verifierModel: process.env.ANTHROPIC_DIMMING_VERIFIER_MODEL || undefined,
      tiebreakModel: process.env.ANTHROPIC_DIMMING_TIEBREAK_MODEL || undefined,
    });
    return;
  }

  if (!args.skipPdp) {
    const added = await syncPdpSpecSheets(sb, args.dryRun);
    console.log(`[docs-ingest] step A: ${added} re-derived spec sheets folded into the KB`);
  }
  if (!args.skipProducts) {
    const embedded = await backfillProductEmbeddings(sb, cf, args.dryRun);
    console.log(`[docs-ingest] step A2: ${embedded} product embeddings backfilled`);
  }
  // Step C — ZenDesk Help Center article capture, dark-launched.
  if (!args.skipZendesk && process.env.THOM_ZENDESK_ARTICLES === "1") {
    if (!zd) {
      console.warn(
        "[docs-ingest] THOM_ZENDESK_ARTICLES=1 but ZENDESK_SUBDOMAIN/EMAIL/API_TOKEN unset — skipping article capture",
      );
    } else {
      const locale = process.env.ZENDESK_HC_LOCALE || "en-us";
      const brandMap = parseBrandMap(process.env.ZENDESK_HC_BRAND_MAP);
      const res = await captureZendeskArticles(sb, zd, locale, brandMap, args.dryRun);
      console.log(
        `[docs-ingest] step C: ${res.published} published articles captured, ${res.superseded} superseded`,
      );
    }
  }
  // Step W — website crawl capture, dark-launched behind THOM_WEB_CRAWL=1
  // with a THOM_CRAWL_SITES allowlist ("wacgroup,waclighting" | "all").
  if (!args.skipCrawl && process.env.THOM_WEB_CRAWL === "1") {
    const sites = enabledSites(process.env.THOM_CRAWL_SITES);
    if (!sites.length) {
      console.warn("[docs-ingest] THOM_WEB_CRAWL=1 but THOM_CRAWL_SITES is empty — skipping crawl");
    } else {
      if (!webStore) {
        console.warn("[docs-ingest] R2_* unset — crawled pages will not be cached (Step B refetches live)");
      }
      for (const site of sites) {
        const stats = await crawlSite(
          site,
          { sb, store: webStore },
          { dryRun: args.dryRun, limit: args.crawlLimit, harvestPdp: args.harvestPdp, includeOptIn: args.includeOptIn },
          () => new Date().toISOString(),
        );
        console.log(
          `[docs-ingest] step W (${stats.site}): ${stats.captured} captured, ${stats.unchanged} unchanged, ${stats.errors} errors`,
        );
      }
    }
  }
  // Step E — PDP reconciliation over the crawl's evidence (plan E). Report-only
  // unless --reconcile-write; wacarchitectural is excluded from writes either way.
  if (args.reconcilePdp) {
    await reconcilePdp(sb, { write: args.reconcileWrite && !args.dryRun });
  }
  // --retry-failed: requeue prior failures (e.g. transient upstream 502s) so
  // Step B picks them up again. Permanently-bad ones (empty/non-PDF) just
  // re-fail, which is harmless.
  if (args.retryFailed && !args.dryRun) {
    await requeueFailed(sb);
  }
  const counts = await processPending(sb, cf, claude, zd, webStore, args.limit, args.dryRun);
  console.log(
    `[docs-ingest] step B: ${counts.active} extracted (${counts.chunks} chunks), ${counts.failed} failed`,
  );
}

// Only run as a CLI — processPending/requeueFailed are imported by the Step-B
// exclusion test, and a bare import must never launch the pipeline.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`[docs-ingest] fatal: ${e instanceof Error ? e.stack : String(e)}`);
    process.exit(1);
  });
}
