import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { classify, type Classification } from "./classify.js";
import { EMPTY_ROBOTS, isAllowed, looksLikeRobots, parseRobots, type RobotsRules } from "./robots.js";
import { parseSitemap, sitemapBasename } from "./sitemap.js";
import type { SiteConfig } from "./sites.js";
import { canonicalizeUrl, extractLinks, type CanonicalUrl } from "./url.js";
import { chunkableText, extractPage } from "./extractPage.js";
import type { WebStore } from "./store.js";

/**
 * Step W — the website crawl capture pass (ratified plan section A).
 *
 * Discover (sitemaps, or seeded BFS for the one sitemap-less host) → classify
 * → fetch politely (honest UA, per-host serial, max(robots Crawl-delay, site
 * floor), conditional GET) → extract → hash normalized text → store to R2 →
 * upsert kb_documents (status='pending_extract' ONLY for new/changed content —
 * set EXPLICITLY, never left to the insert default) + crawl_frontier evidence.
 *
 * Step B (processDoc in index.ts) then chunks/embeds whatever is pending, so
 * a CI timeout resumes exactly like every other docs-ingest source.
 */

const USER_AGENT = "WAC-Marketing-App/1.0 (+thom web crawl; contact WAC IT)";
const FETCH_TIMEOUT_MS = 30_000;
const UPSERT = 300;

export interface CrawlDeps {
  sb: SupabaseClient;
  store: WebStore | null;
  fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface CrawlOptions {
  dryRun: boolean;
  /** Max page fetches per site per run (discovery is unlimited). */
  limit: number | null;
  /** Fetch WordPress-brand PDPs for reconciliation evidence (wacarchitectural
   *  PDPs are always fetched — they are ingested content there). */
  harvestPdp: boolean;
  /** Ingest opt-in content types (wacarchitectural project case studies). */
  includeOptIn: boolean;
}

export interface SiteCrawlStats {
  site: string;
  discovered: number;
  fetched: number;
  captured: number;   // kb_documents rows newly pending
  unchanged: number;
  skipped: number;
  errors: number;
  botBlocked: number;
  superseded: number;
}

interface FetchResult {
  status: number;
  body: string | null;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  cfRay: boolean;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function fetchPage(
  url: string,
  cond: { etag: string | null; lastModified: string | null },
  fetchImpl: typeof fetch,
): Promise<FetchResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };
    if (cond.etag) headers["if-none-match"] = cond.etag;
    if (cond.lastModified) headers["if-modified-since"] = cond.lastModified;
    const r = await fetchImpl(url, { signal: ctl.signal, headers, redirect: "follow" });
    return {
      status: r.status,
      body: r.status === 304 ? null : await r.text(),
      etag: r.headers.get("etag"),
      lastModified: r.headers.get("last-modified"),
      contentType: r.headers.get("content-type"),
      cfRay: r.headers.has("cf-ray"),
    };
  } catch (e) {
    return { status: 0, body: null, etag: null, lastModified: null, contentType: null, cfRay: false };
  } finally {
    clearTimeout(timer);
  }
}

async function loadRobots(site: SiteConfig, fetchImpl: typeof fetch): Promise<RobotsRules> {
  const r = await fetchPage(`https://${site.host}/robots.txt`, { etag: null, lastModified: null }, fetchImpl);
  if (r.status !== 200 || !r.body || !looksLikeRobots(r.body, r.contentType)) return EMPTY_ROBOTS;
  return parseRobots(r.body);
}

interface Discovered {
  c: CanonicalUrl;
  cls: Classification;
  provenance: string | null;
  lastmod: string | null;
}

/** Sitemap discovery: robots Sitemap: directives ∪ the MANDATORY /sitemap.xml
 *  fallback (aispire declares none), recursing indexes, skipping per-site
 *  excluded files. */
async function discoverFromSitemaps(
  site: SiteConfig,
  robots: RobotsRules,
  fetchImpl: typeof fetch,
  log: (m: string) => void,
): Promise<Discovered[]> {
  const roots = new Set<string>(robots.sitemaps);
  roots.add(`https://${site.host}/sitemap.xml`);
  const seenFiles = new Set<string>();
  const queue = [...roots];
  const out = new Map<string, Discovered>();

  while (queue.length) {
    const smUrl = queue.shift()!;
    const base = sitemapBasename(smUrl);
    if (seenFiles.has(base)) continue;
    seenFiles.add(base);
    if (site.sitemapSkip?.some((re) => re.test(base))) continue;
    const r = await fetchPage(smUrl, { etag: null, lastModified: null }, fetchImpl);
    if (r.status !== 200 || !r.body) continue;
    const parsed = parseSitemap(r.body, r.contentType);
    if (parsed.kind === "invalid") continue;
    if (parsed.kind === "index") {
      for (const s of parsed.sitemaps) queue.push(s.loc);
      continue;
    }
    for (const u of parsed.urls) {
      const c = canonicalizeUrl(u.loc);
      if (!c || c.siteKey !== site.key) continue;
      if (out.has(c.url)) continue;
      out.set(c.url, { c, cls: classify(site.key, c.path, base), provenance: base, lastmod: u.lastmod });
    }
  }
  log(`[crawl:${site.key}] sitemap discovery: ${out.size} urls from ${seenFiles.size} files`);
  return [...out.values()];
}

interface FrontierRow {
  url: string;
  host: string;
  site: string;
  doc_type_guess: string | null;
  status: string;
  http_status?: number | null;
  etag?: string | null;
  last_modified?: string | null;
  content_hash?: string | null;
  depth?: number;
  last_crawled_at?: string | null;
  region?: string | null;
  discovered_slug?: string | null;
  discovered_spec_sheet_url?: string | null;
  model_codes?: string[] | null;
  published_at?: string | null;
}

function guessOf(cls: Classification): string | null {
  switch (cls.kind) {
    case "content": return cls.docType;
    case "product": return "web_product";
    case "listing": return "web_category";
    case "skip": return `skip:${cls.reason}`;
    case "junk": return null;
  }
}

function slugFromPath(path: string): string | null {
  const m = path.match(/^\/product\/([a-z0-9][a-z0-9-]*)$/);
  return m ? m[1]! : null;
}

/** One site, end to end. Serial per host with the politeness delay. */
export async function crawlSite(
  site: SiteConfig,
  deps: CrawlDeps,
  opts: CrawlOptions,
  iso: () => string,
): Promise<SiteCrawlStats> {
  const log = deps.log ?? ((m) => console.log(m));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stats: SiteCrawlStats = {
    site: site.key, discovered: 0, fetched: 0, captured: 0,
    unchanged: 0, skipped: 0, errors: 0, botBlocked: 0, superseded: 0,
  };

  const robots = await loadRobots(site, fetchImpl);
  const delayMs = Math.max((robots.crawlDelaySec ?? 0) * 1000, site.minDelayMs);

  // Prior frontier state (conditional GET + change detection).
  const prior = new Map<string, { etag: string | null; last_modified: string | null; content_hash: string | null }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await deps.sb
      .from("crawl_frontier")
      .select("url, etag, last_modified, content_hash")
      .eq("site", site.key)
      .range(from, from + 999);
    if (error) throw new Error(`crawl_frontier read failed: ${error.message}`);
    for (const r of data ?? []) prior.set(r.url as string, r as never);
    if ((data?.length ?? 0) < 1000) break;
  }
  // Existing kb hashes for this site's docs (change detection for capture).
  const kbHash = new Map<string, string | null>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await deps.sb
      .from("kb_documents")
      .select("external_id, content_hash")
      .eq("source_system", "web_crawl")
      .like("external_id", `https://${site.host}/%`)
      .range(from, from + 999);
    if (error) throw new Error(`kb_documents read failed: ${error.message}`);
    for (const r of data ?? []) kbHash.set(r.external_id as string, (r.content_hash as string) ?? null);
    if ((data?.length ?? 0) < 1000) break;
  }

  // --- discovery ---
  const queue: Discovered[] = [];
  const enqueued = new Set<string>();
  const enqueue = (d: Discovered) => {
    if (enqueued.has(d.c.url)) return;
    enqueued.add(d.c.url);
    queue.push(d);
  };
  if (site.discovery === "sitemap") {
    for (const d of await discoverFromSitemaps(site, robots, fetchImpl, log)) enqueue(d);
  } else {
    for (const seed of site.seeds ?? []) {
      const c = canonicalizeUrl(`https://${site.host}${seed}`);
      if (c) enqueue({ c, cls: classify(site.key, c.path), provenance: null, lastmod: null });
    }
  }

  // --- process ---
  const frontierRows: FrontierRow[] = [];
  const kbRows: Record<string, unknown>[] = [];
  let fetches = 0;

  const shouldFetch = (cls: Classification): boolean => {
    switch (cls.kind) {
      case "content": return !cls.optIn || opts.includeOptIn;
      case "listing": return true; // BFS traversal (seeded site only)
      case "product": return cls.ingest || opts.harvestPdp;
      default: return false;
    }
  };

  for (let i = 0; i < queue.length; i++) {
    const { c, cls, provenance, lastmod } = queue[i]!;
    stats.discovered++;
    const base: FrontierRow = {
      url: c.url, host: c.host, site: site.key,
      doc_type_guess: guessOf(cls), status: "discovered",
      region: "region" in cls ? (cls.region ?? null) : null,
      discovered_slug: slugFromPath(c.path),
    };
    if (cls.kind === "junk") continue;
    if (cls.kind === "skip") {
      stats.skipped++;
      frontierRows.push({ ...base, status: "skipped" });
      continue;
    }
    if (!shouldFetch(cls)) {
      // Recorded (slug evidence comes free from the URL) but not fetched.
      frontierRows.push(base);
      continue;
    }
    if (!isAllowed(robots, c.path)) {
      stats.skipped++;
      frontierRows.push({ ...base, status: "skipped", doc_type_guess: "skip:robots_disallow" });
      continue;
    }
    if (opts.limit != null && fetches >= opts.limit) {
      frontierRows.push(base);
      continue;
    }
    if (opts.dryRun) {
      fetches++;
      stats.fetched++;
      continue;
    }

    const cond = prior.get(c.url) ?? { etag: null, last_modified: null, content_hash: null };
    if (fetches > 0) await sleep(delayMs);
    fetches++;
    const res = await fetchPage(c.url, { etag: cond.etag, lastModified: cond.last_modified }, fetchImpl);
    stats.fetched++;

    if (res.status === 304) {
      stats.unchanged++;
      frontierRows.push({ ...base, status: "fetched", http_status: 304, etag: cond.etag, last_modified: cond.last_modified, content_hash: cond.content_hash, last_crawled_at: iso() });
      continue;
    }
    if (res.status === 404 || res.status === 410) {
      stats.superseded++;
      frontierRows.push({ ...base, status: "superseded", http_status: res.status, last_crawled_at: iso() });
      if (kbHash.has(c.url)) {
        await deps.sb.from("kb_documents").update({ status: "superseded" })
          .eq("source_system", "web_crawl").eq("external_id", c.url);
      }
      continue;
    }
    if (res.status === 403 && res.cfRay) {
      // Cloudflare Bot Management block against a page that serves an honest
      // UA fine — transient/ops issue, NOT a permanent failure.
      stats.botBlocked++;
      frontierRows.push({ ...base, status: "error", http_status: 403, doc_type_guess: "error:bot_block", last_crawled_at: iso() });
      continue;
    }
    if (res.status !== 200 || res.body == null) {
      stats.errors++;
      frontierRows.push({ ...base, status: "error", http_status: res.status || null, last_crawled_at: iso() });
      continue;
    }

    const region = "region" in cls ? (cls.region ?? null) : null;
    const page = extractPage(res.body, c.url, { siteKey: site.key, brand: site.brand, region });

    // BFS link discovery from every fetched page on the seeded site.
    if (site.discovery === "seeded-bfs") {
      for (const link of extractLinks(res.body, c.url)) {
        if (link.siteKey !== site.key) continue;
        enqueue({ c: link, cls: classify(site.key, link.path), provenance: null, lastmod: null });
      }
    }

    // Evidence lands on the frontier row regardless of kind. The Modern Forms
    // data-ppid and the Schonbek title parse (family + export PPID like 1302E)
    // fold into model_codes so the reconciler sees ONE evidence vocabulary;
    // the Schonbek family name doubles as a family-resolution hint.
    const evidenceCodes = new Set(page.evidence.modelCodes);
    if (page.evidence.ppid) evidenceCodes.add(page.evidence.ppid);
    if (page.evidence.schonbek?.ppid) evidenceCodes.add(page.evidence.schonbek.ppid);
    if (page.evidence.schonbek?.family) evidenceCodes.add(page.evidence.schonbek.family.toUpperCase());
    const evidence: Partial<FrontierRow> = {
      model_codes: evidenceCodes.size ? [...evidenceCodes] : null,
      discovered_spec_sheet_url: page.evidence.specSheetUrl,
      published_at: page.publishedAt,
    };

    if (page.soft404) {
      stats.superseded++;
      frontierRows.push({ ...base, ...evidence, status: "superseded", http_status: 200, doc_type_guess: "skip:soft-404", last_crawled_at: iso() });
      continue;
    }

    const ingestable = cls.kind === "content" || (cls.kind === "product" && cls.ingest);
    if (!ingestable) {
      frontierRows.push({ ...base, ...evidence, status: "fetched", http_status: 200, etag: res.etag, last_modified: res.lastModified, last_crawled_at: iso() });
      continue;
    }
    if (page.jsShell) {
      stats.errors++;
      frontierRows.push({ ...base, ...evidence, status: "error", http_status: 200, doc_type_guess: "error:js_shell", last_crawled_at: iso() });
      continue;
    }

    const docType = cls.kind === "content" ? cls.docType : "web_product";
    const authority = cls.kind === "content" ? cls.authority : 0.8;
    const text = chunkableText(page, { siteKey: site.key, brand: site.brand, region });
    const hash = sha256(text);

    if (kbHash.get(c.url) === hash) {
      stats.unchanged++;
      frontierRows.push({ ...base, ...evidence, status: "fetched", http_status: 200, etag: res.etag, last_modified: res.lastModified, content_hash: hash, last_crawled_at: iso() });
      continue;
    }

    let r2Key: string | null = null;
    if (deps.store) {
      try {
        r2Key = await deps.store.putPage(site.key, hash, res.body, text);
      } catch (e) {
        log(`[crawl:${site.key}] R2 put failed for ${c.url}: ${e instanceof Error ? e.message : e}`);
      }
    }

    kbRows.push({
      source_system: "web_crawl",
      external_id: c.url,
      doc_type: docType,
      scope: "public",
      brand: site.brand,
      url: c.url,
      title: page.title,
      content_hash: hash,
      authority,
      r2_key: r2Key,
      // EXPLICIT: new AND changed docs must re-extract (an upsert's insert
      // default only covers brand-new rows).
      status: "pending_extract",
    });
    stats.captured++;
    frontierRows.push({ ...base, ...evidence, status: "fetched", http_status: 200, etag: res.etag, last_modified: res.lastModified, content_hash: hash, last_crawled_at: iso() });
  }

  // --- persist ---
  if (!opts.dryRun) {
    for (let i = 0; i < kbRows.length; i += UPSERT) {
      const { error } = await deps.sb.from("kb_documents")
        .upsert(kbRows.slice(i, i + UPSERT), { onConflict: "source_system,external_id" });
      if (error) throw new Error(`kb_documents (web_crawl) upsert failed: ${error.message}`);
    }
    for (let i = 0; i < frontierRows.length; i += UPSERT) {
      const { error } = await deps.sb.from("crawl_frontier")
        .upsert(frontierRows.slice(i, i + UPSERT), { onConflict: "url" });
      if (error) throw new Error(`crawl_frontier upsert failed: ${error.message}`);
    }
  }

  log(
    `[crawl:${site.key}] ${stats.discovered} discovered, ${stats.fetched} fetched, ` +
    `${stats.captured} captured, ${stats.unchanged} unchanged, ${stats.skipped} skipped, ` +
    `${stats.errors} errors (${stats.botBlocked} bot-blocked), ${stats.superseded} superseded` +
    (opts.dryRun ? " (dry-run)" : ""),
  );
  return stats;
}

/** Step B helper: rebuild the chunkable text for a web_crawl doc when its R2
 *  object is unavailable — refetch the live page and re-extract. */
export async function extractWebDocText(
  url: string,
  brand: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const c = canonicalizeUrl(url);
  if (!c || !c.siteKey) return null;
  const res = await fetchPage(url, { etag: null, lastModified: null }, fetchImpl);
  if (res.status !== 200 || !res.body) return null;
  const cls = classify(c.siteKey, c.path);
  const region = "region" in cls ? (cls.region ?? null) : null;
  const page = extractPage(res.body, url, { siteKey: c.siteKey, brand, region });
  if (page.jsShell || page.soft404) return null;
  return chunkableText(page, { siteKey: c.siteKey, brand, region });
}
