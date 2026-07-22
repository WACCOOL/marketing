import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { codeFromAssetUrl, modernFormsSpecUrl } from "@wac/shared";
import { htmlToText } from "../html.js";

/**
 * Page extraction — HTML in, retrieval-ready text + metadata + PDP evidence
 * out. Pure (no network), so every audited hazard has a fixture test:
 *
 *  - Readability over the FULL BODY, never gated on <main>/[role=main] —
 *    wacgroup's twentytwentyone theme has no <main> and splits content across
 *    multiple <article> blocks; when Readability comes back empty/short we
 *    fall back to a nav/footer-stripped body text.
 *  - og:* tags: FIRST occurrence wins — wacgroup emits a second
 *    homepage-describing og block; last-wins corrupts per-page titles.
 *  - og:description is NEVER used for the summary (on wacgroup it is one
 *    static sitewide tagline on every page) — the summary is the first real
 *    paragraph of the extracted main text.
 *  - Breadcrumb: Yoast JSON-LD BreadcrumbList primary, visible fallback;
 *    pure-numeric segments (modernforms "8500") are dropped from the header.
 *  - Region availability (wacarchitectural): stamped as a header line — NA
 *    and INT specs are DISTINCT (Davis), so region attribution rides every
 *    chunk of the doc.
 */

export interface ExtractedPage {
  title: string | null;
  canonicalUrl: string | null;
  breadcrumb: string[];
  /** ISO date string when the page declares one (JSON-LD dateModified,
   *  article:modified_time, article:published_time). */
  publishedAt: string | null;
  /** Main content as plain text (no header). */
  text: string;
  /** First real paragraph — used as the summary line, NEVER og:description. */
  summary: string | null;
  /** True when the body looks like an empty JS shell. */
  jsShell: boolean;
  /** True when a 200 page is actually a soft 404 ("Not Found | ..."). */
  soft404: boolean;
  evidence: PdpEvidence;
}

export interface PdpEvidence {
  /** Model-code candidates harvested from asset filenames + slug + title. */
  modelCodes: string[];
  /** data-ppid when present (Modern Forms / WordPress PDPs). */
  ppid: string | null;
  /** First discovered spec-sheet URL (static _SPSHT.pdf href preferred,
   *  ?download=specs dispatcher second — emitted as the dynamic-specsheet
   *  form on modernforms, whose PDP-path dispatcher is non-PDF to fetchers). */
  specSheetUrl: string | null;
  /** Schonbek: "{Family} | {PPID} | {SubBrand} | ..." title parse. */
  schonbek: { family: string | null; ppid: string | null } | null;
}

const MIN_MAIN_TEXT = 80; // chars below which we suspect a shell/soft-404

// --- metadata helpers -------------------------------------------------------

/** FIRST occurrence of an og/meta property (see wacgroup dual-block hazard). */
export function firstMeta(html: string, property: string): string | null {
  const esc = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${esc}["'][^>]*>`,
    "i",
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const content = tag.match(/content\s*=\s*["']([^"']*)["']/i);
  return content ? content[1]!.trim() || null : null;
}

export function firstCanonical(html: string): string | null {
  const tag = html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]*>/i)?.[0];
  if (!tag) return null;
  const href = tag.match(/href\s*=\s*["']([^"']+)["']/i);
  return href ? href[1]!.trim() : null;
}

function pageTitle(html: string): string | null {
  const og = firstMeta(html, "og:title");
  if (og) return og;
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? htmlToText(t[1]!).trim() || null : null;
}

interface JsonLdNode { [k: string]: unknown }

function jsonLdBlocks(html: string): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  for (const m of html.matchAll(
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed = JSON.parse(m[1]!.trim()) as unknown;
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const n of nodes) {
        if (n && typeof n === "object") {
          const graph = (n as JsonLdNode)["@graph"];
          if (Array.isArray(graph)) out.push(...(graph as JsonLdNode[]));
          else out.push(n as JsonLdNode);
        }
      }
    } catch {
      // malformed JSON-LD is common; skip the block
    }
  }
  return out;
}

/** Yoast JSON-LD BreadcrumbList primary; pure-numeric segments dropped. */
export function extractBreadcrumb(html: string): string[] {
  for (const node of jsonLdBlocks(html)) {
    if (node["@type"] !== "BreadcrumbList") continue;
    const items = node.itemListElement;
    if (!Array.isArray(items)) continue;
    const names = items
      .map((it) => {
        const el = it as JsonLdNode;
        const name = el.name ?? (el.item as JsonLdNode | undefined)?.name;
        return typeof name === "string" ? name.trim() : null;
      })
      .filter((n): n is string => !!n)
      .filter((n) => !/^\d+$/.test(n)); // numeric guard (modernforms "8500")
    if (names.length) return names;
  }
  // Visible fallback: prefer per-anchor segments (crumbs are inline links, so
  // htmlToText alone would run them together on one line).
  const vis = html.match(/<(?:nav|div|ol|ul)[^>]+class\s*=\s*["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/(?:nav|div|ol|ul)>/i);
  if (vis) {
    const inner = vis[1]!;
    const anchors = [...inner.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => htmlToText(m[1]!).trim())
      .filter((s) => s && !/^\d+$/.test(s));
    if (anchors.length) return anchors;
    return htmlToText(inner)
      .split(/\n|[>»]/)
      .map((s) => s.trim())
      .filter((s) => s && !/^[>»/|]$/.test(s) && !/^\d+$/.test(s));
  }
  return [];
}

export function extractPublishedAt(html: string): string | null {
  for (const node of jsonLdBlocks(html)) {
    for (const key of ["dateModified", "datePublished"]) {
      const v = node[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return (
    firstMeta(html, "article:modified_time") ??
    firstMeta(html, "article:published_time")
  );
}

// --- main-content extraction ------------------------------------------------

const STRIP_BLOCKS_RE =
  /<(script|style|noscript|template|svg|iframe|form|nav|header|footer|aside)[\s>][\s\S]*?<\/\1>/gi;

function strippedBodyText(html: string): string {
  const body = html.match(/<body[\s>][\s\S]*<\/body>/i)?.[0] ?? html;
  let cleaned = body;
  for (let i = 0; i < 3; i++) cleaned = cleaned.replace(STRIP_BLOCKS_RE, " ");
  return htmlToText(cleaned).trim();
}

function readabilityText(html: string, url: string): string | null {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document as never, { charThreshold: 100 }).parse();
    if (!article?.textContent) return null;
    const text = article.textContent.replace(/\n{3,}/g, "\n\n").trim();
    return text || null;
  } catch {
    return null;
  }
}

// --- PDP evidence harvest ---------------------------------------------------

const SPSHT_HREF_RE = /(?:src|href)\s*=\s*["']([^"']+_SPSHT\.pdf)["']/i;
const DOWNLOAD_SPECS_RE = /[?&]download=specs[a-z0-9]+/i;
const DATA_PPID_RE = /data-ppid\s*=\s*["'](\d+)["']/;
/** Model-code-shaped token: letters+digits with hyphens, e.g. FR-W1801, A2RU-447-27. */
const CODE_TOKEN_RE = /\b[A-Z][A-Z0-9]{0,5}-[A-Z0-9][A-Z0-9-]{2,}\b/g;

function harvestEvidence(html: string, pageUrl: string, siteKey: string): PdpEvidence {
  const codes = new Set<string>();

  // Asset filenames are the strongest signal (same vocabulary as the WIES
  // resolver's deriveModelCodes): image/IES/pdf srcs + hrefs.
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+\.(?:png|jpe?g|webp|pdf|zip|ies))["']/gi)) {
    const code = codeFromAssetUrl(m[1]!);
    // Codes with a hyphen + digit look like real model codes; bare words don't.
    if (code && /[-]/.test(code) && /\d/.test(code)) codes.add(code);
  }

  // Title-embedded codes (aiSpire order numbers, wacarchitectural model rows).
  const title = pageTitle(html);
  if (title) {
    for (const m of title.toUpperCase().matchAll(CODE_TOKEN_RE)) codes.add(m[0]);
  }

  // Schonbek: static PDP HTML has ~zero asset hrefs — the code lives in the
  // "{Family} | {PPID} | {SubBrand} | ..." title (PPID present ~60% of pages).
  let schonbek: PdpEvidence["schonbek"] = null;
  if (siteKey === "schonbek" && title) {
    const parts = title.split("|").map((s) => s.trim()).filter(Boolean);
    const family = parts[0] || null;
    const ppidPart = parts.find((p) => /^\d{3,6}[A-Z]*$/.test(p)) ?? null;
    schonbek = { family, ppid: ppidPart };
  }

  const ppid = html.match(DATA_PPID_RE)?.[1] ?? null;

  // Spec sheet: static _SPSHT.pdf href first (resolved against the page —
  // waclighting's are site-relative /storage/ paths), dispatcher second.
  let specSheetUrl: string | null = null;
  const spsht = html.match(SPSHT_HREF_RE)?.[1];
  if (spsht) {
    try {
      specSheetUrl = new URL(spsht, pageUrl).toString();
    } catch {
      specSheetUrl = null;
    }
  }
  if (!specSheetUrl) {
    const dl = html.match(DOWNLOAD_SPECS_RE)?.[0];
    if (dl) {
      if (siteKey === "modernforms") {
        // Modern Forms' PDP-path dispatcher answers HTML (not a PDF) to
        // fetchers — the WORKING route is the dynamic-specsheet endpoint keyed
        // on data-ppid (same as products-sync resolveModernFormsSpecSheet).
        // The page's own template index is a hint only (the true index needs a
        // live probe — see the reconciler's heal-time probe); no ppid → no URL.
        const t = Number(dl.match(/download=specs(\d+)/i)?.[1]);
        specSheetUrl = ppid ? modernFormsSpecUrl(ppid, Number.isFinite(t) ? t : 5) : null;
      } else {
        try {
          const u = new URL(pageUrl);
          specSheetUrl = `${u.origin}${u.pathname}${dl.replace(/^&/, "?")}`;
        } catch {
          specSheetUrl = null;
        }
      }
    }
  }

  return { modelCodes: [...codes], ppid, specSheetUrl, schonbek };
}

// --- assembly ---------------------------------------------------------------

export interface ExtractOptions {
  siteKey: string;
  brand: string;
  region?: "na" | "int" | null;
}

const REGION_AVAILABILITY: Record<string, string> = {
  na: "Availability: North America and the Caribbean only.",
  int: "Availability: international (rest of world), not available in China.",
};

export function extractPage(html: string, pageUrl: string, opts: ExtractOptions): ExtractedPage {
  const title = pageTitle(html);
  const soft404 = !!title && /^not found\b/i.test(title);

  let text = readabilityText(html, pageUrl) ?? "";
  // The wacgroup hazard: content split across multiple <article> blocks makes
  // Readability latch onto ONE of them. When the nav/footer-stripped body is
  // substantially longer than Readability's pick, the body is the truth.
  const fallback = strippedBodyText(html);
  if (text.length < MIN_MAIN_TEXT || fallback.length > text.length * 1.5) {
    if (fallback.length > text.length) text = fallback;
  }
  const jsShell = text.length < MIN_MAIN_TEXT;

  const paragraphs = text.split(/\n+/).map((s) => s.trim()).filter((s) => s.length >= 40);
  const summary = paragraphs[0]?.slice(0, 300) ?? null;

  return {
    title,
    canonicalUrl: firstCanonical(html),
    breadcrumb: extractBreadcrumb(html),
    publishedAt: extractPublishedAt(html),
    text,
    summary,
    jsShell,
    soft404,
    evidence: harvestEvidence(html, pageUrl, opts.siteKey),
  };
}

/**
 * The text that actually gets chunked: brand/title/breadcrumb/summary header
 * (plus the region-availability line on region-split catalogs), then the main
 * text. Section C's `"{brand} — {title}\n{breadcrumb}\n{summary}\n{Published}"`
 * shape — every chunk of the doc inherits this grounding.
 */
export function chunkableText(page: ExtractedPage, opts: ExtractOptions): string {
  const lines: string[] = [];
  lines.push(`${opts.brand} — ${page.title ?? "(untitled)"}`);
  if (page.breadcrumb.length) lines.push(page.breadcrumb.join(" > "));
  if (opts.region && REGION_AVAILABILITY[opts.region]) lines.push(REGION_AVAILABILITY[opts.region]!);
  if (page.summary) lines.push(page.summary);
  if (page.publishedAt) lines.push(`Published: ${page.publishedAt}`);
  return `${lines.join("\n")}\n\n${page.text}`;
}
