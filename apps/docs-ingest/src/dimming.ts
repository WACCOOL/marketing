// =============================================================================
// Dimming-chart structured extraction (`--dimming [--sample N]`) — the plan §B
// engine (docs/thom-dimming-compat-plan.md v2, ledger DC1–DC15):
//
//  0. Derived-URL fallback capture (plan §A.4): products whose `zmatdimrep` is
//     set (≠ N/A/"0") but whose dim_report FILE field never delivered a URL get
//     the verified brand-site URL derived + HEAD-probed (the MF spec-sheet
//     HEAD-probe idiom) and inserted as source_system='derived_url'. Runs HERE
//     (Node CLI) rather than in the Worker sync so ~600 first-run HEAD probes
//     never ride the Worker subrequest budget.
//  1. Unit fan-out: each captured dimming kb doc is fetched; `PK\x03\x04` ->
//     unzip in-process (fflate), keep *.pdf entries (skip-and-log the rest);
//     one extraction UNIT per distinct sha256 — byte-identical entries dedupe
//     to one unit carrying every path in zip_entry_path[] (DC4).
//  2. Per-unit Claude vision extraction with a FORCED tool call whose input
//     schema is the output contract (never free text), model recorded (DC11).
//  3. Code-side derivation: mode qualifier parsed + stripped FIRST (DC2),
//     conservative status derivation (DC1 — null low end can NEVER become
//     tested_compatible), slash-expansion (DC8), unknown-vocabulary collection
//     for Davis's review.
//  4. Stratified verification gate (DC5): >=1 row per section per page, the
//     question carries the mode qualifier and asks section membership +
//     per-section row counts; haiku verifier by default; mismatch ->
//     needs_review (rows stay invisible to the tools' status='active' filter).
//  5. Product binding at extraction time, pattern-primary (DC4): `field` links
//     only for loose single PDFs; overlap audit (2+ units, different families
//     -> held for review); links rewritten per product per run.
//  6. Supersession sweep (DC6): units whose source doc is no longer current ->
//     status='superseded'; their links die.
//
// Pure pieces are exported for tests; the golden fixture test runs the
// parse/derivation layers unconditionally and live Claude only when creds
// exist (extract.ts idiom).
// =============================================================================

import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_DIMMING_EXTRACTION_MODEL,
  DEFAULT_DIMMING_VERIFIER_MODEL,
  DIMMING_EXTRACTION_TOOL,
  DIMMING_EXTRACTION_VERSION,
  DIMMING_REPORT_DOC_TYPE,
  deriveRowStatus,
  extractedDimmingReportSchema,
  normalizeDimmerModel,
  normalizeHyphens,
  normalizeRelatedModels,
  parseModeQualifier,
  patternToLike,
  phaseFromSectionHeader,
  pickVerificationSamples,
  reportCodeFromEntryPath,
  skuMatchesLikes,
  verifyExtraction,
  type DimmingModeQualifier,
  type DimmingPhaseType,
  type DimmingRowStatus,
  type ExtractedDimmingReport,
  type VerifiableRow,
  type VerifierAnswer,
  type VerifierSectionCount,
} from "@wac/shared/thom";
import type { WebStore } from "./crawl/store.js";

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "WAC-Marketing-App/1.0 (+thom dimming ingest; contact WAC IT)";
const UPSERT = 300;

// -----------------------------------------------------------------------------
// Pure helpers (exported for tests)
// -----------------------------------------------------------------------------

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isZipMagic(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function isPdfMagic(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

export interface ExtractionUnit {
  contentHash: string;
  bytes: Uint8Array;
  /** All zip entry paths whose bytes hashed identically; null for loose PDFs. */
  zipEntryPaths: string[] | null;
}

/**
 * Fan a captured file out to extraction units (plan §A.3): a zip yields one
 * unit per DISTINCT pdf-entry hash (byte-identical entries dedupe, keeping all
 * their paths — DC4); a loose PDF is a single unit. Non-PDF zip entries are
 * skipped and reported in `skipped`. Throws on bytes that are neither.
 */
export function unitsFromBytes(bytes: Uint8Array): { units: ExtractionUnit[]; skipped: string[] } {
  if (isPdfMagic(bytes)) {
    return { units: [{ contentHash: sha256Hex(bytes), bytes, zipEntryPaths: null }], skipped: [] };
  }
  if (!isZipMagic(bytes)) throw new Error("not a PDF or zip");
  const entries = unzipSync(bytes);
  const byHash = new Map<string, ExtractionUnit>();
  const skipped: string[] = [];
  for (const [path, data] of Object.entries(entries)) {
    if (path.endsWith("/") || data.length === 0) continue; // directory entries
    if (!/\.pdf$/i.test(path)) {
      skipped.push(path);
      continue;
    }
    const hash = sha256Hex(data);
    const existing = byHash.get(hash);
    if (existing) existing.zipEntryPaths!.push(path);
    else byHash.set(hash, { contentHash: hash, bytes: data, zipEntryPaths: [path] });
  }
  return { units: [...byHash.values()], skipped };
}

/** Valid zmatdimrep filename: set, and neither the N/A marker nor the junk
 *  literal "0" (audit: 37 junk "0" values in the cache). */
export function validZmatdimrep(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s === "0" || /^n\/?a$/i.test(s)) return null;
  return s;
}

/** The verified brand-site fallback URL for a dim_report filename (§A.4). */
export function derivedDimReportUrl(filename: string): string {
  return `https://waclighting.com/storage/waclighting-images/dim_report/${encodeURIComponent(filename)}`;
}

export interface AppliedRow {
  page: number;
  section_header: string;
  manufacturer: string;
  dimmer_series: string | null;
  dimmer_model: string;
  mode_qualifier: DimmingModeQualifier | null;
  dimmer_model_norm: string;
  related_dimmer_models: string[];
  related_dimmer_models_norm: string[];
  phase_type: DimmingPhaseType;
  test_voltage: string;
  low_end_pct: number | null;
  status: DimmingRowStatus;
  comments: string;
}

export interface AppliedExtraction {
  report: {
    report_code: string | null;
    report_code_derived: boolean;
    product_family: string;
    skus_tested: string[];
    related_model_patterns: string[];
    related_model_likes: string[];
    control_types: string[];
    test_voltage_range: string | null;
    test_notes: string | null;
  };
  rows: AppliedRow[];
  /** Distinct comment strings that drove a null-low-end classification OUTSIDE
   *  the known vocabulary — printed in the run report for Davis (DC1). */
  unknownVocabulary: string[];
  /** Rows where the model's phase_type disagreed with the code-side section
   *  header re-derivation (informational; the section header wins). */
  phaseDisagreements: string[];
}

/**
 * The pure derivation layer over a validated extraction (runs unconditionally
 * in the golden test): qualifier parse + strip FIRST (DC2), normalization,
 * slash-expansion (DC8), conservative status derivation (DC1), pattern-like
 * building (U+2010 fix + uppercase + '*'->'%'), filename-derived report code
 * when the body carries none (DC9).
 */
export function applyExtraction(
  extracted: ExtractedDimmingReport,
  entryPath: string | null,
): AppliedExtraction {
  const unknownVocab = new Set<string>();
  const phaseDisagreements: string[] = [];
  const rows: AppliedRow[] = extracted.rows.map((r) => {
    const { qualifier } = parseModeQualifier(r.dimmer_model);
    const seriesQualifier = r.dimmer_series ? parseModeQualifier(r.dimmer_series).qualifier : null;
    const norm = normalizeDimmerModel(r.dimmer_model);
    const { status, unknownVocabulary } = deriveRowStatus(r.low_end_pct, r.comments);
    if (unknownVocabulary && r.comments.trim()) unknownVocab.add(r.comments.trim());
    // Section membership is code-derived from the verbatim header (the model's
    // enum is kept only as a cross-check signal).
    const sectionPhase = phaseFromSectionHeader(r.section_header);
    if (sectionPhase !== r.phase_type) {
      phaseDisagreements.push(
        `${r.dimmer_model} p.${r.page}: model said ${r.phase_type}, section header "${r.section_header}" derives ${sectionPhase}`,
      );
    }
    return {
      page: r.page,
      section_header: r.section_header,
      manufacturer: r.manufacturer.trim(),
      dimmer_series: r.dimmer_series?.trim() || null,
      dimmer_model: normalizeHyphens(r.dimmer_model).trim(),
      mode_qualifier: qualifier ?? seriesQualifier,
      dimmer_model_norm: norm,
      related_dimmer_models: r.related_dimmer_models.map((m) => normalizeHyphens(m).trim()).filter((m) => m && m !== "-"),
      related_dimmer_models_norm: normalizeRelatedModels(r.related_dimmer_models),
      phase_type: sectionPhase,
      test_voltage: r.test_voltage.trim(),
      low_end_pct: r.low_end_pct,
      status,
      comments: r.comments.trim(),
    };
  });

  const bodyCode = extracted.report_code?.trim() || null;
  const derivedCode = !bodyCode && entryPath ? reportCodeFromEntryPath(entryPath) : null;
  return {
    report: {
      report_code: bodyCode ?? derivedCode,
      report_code_derived: !bodyCode && !!derivedCode,
      product_family: extracted.product_family.trim(),
      skus_tested: extracted.skus_tested.map((s) => normalizeHyphens(s).trim()).filter(Boolean),
      related_model_patterns: extracted.related_model_patterns
        .map((p) => normalizeHyphens(p).trim())
        .filter(Boolean),
      related_model_likes: extracted.related_model_patterns.map(patternToLike).filter(Boolean),
      control_types: extracted.control_types.map((c) => c.trim()).filter(Boolean),
      test_voltage_range: extracted.test_voltage_range?.trim() || null,
      test_notes: extracted.test_notes?.trim() || null,
    },
    rows,
    unknownVocabulary: [...unknownVocab],
    phaseDisagreements,
  };
}

// --- supersession sweep (DC6) ------------------------------------------------

export interface DimmingDocMeta {
  id: string;
  url: string | null;
  source_system: string;
  status: string;
  updated_at: string;
}

/** Days after which an un-retouched sales_layer/derived_url dimming doc is
 *  considered dropped by capture (the daily sync upsert touches every
 *  currently-referenced doc's updated_at via the kb_documents touch trigger). */
export const DIMMING_STALE_DAYS = 7;

/**
 * Which captured dimming docs are NO LONGER CURRENT (DC6)? Two signals:
 *  (a) same-URL replacement — a changed Sales Layer file keeps its filename
 *      (same url) but gets a new hash-keyed kb row; only the newest row per
 *      url is current, every older one is superseded;
 *  (b) staleness — the daily capture upsert touches every currently-referenced
 *      doc, so a doc whose updated_at lags the freshest doc of its source
 *      system by > staleDays was dropped from every product's field value.
 * Already-superseded rows pass through (idempotent). Pure for tests.
 */
export function computeSupersededDocIds(
  docs: readonly DimmingDocMeta[],
  staleDays: number = DIMMING_STALE_DAYS,
): Set<string> {
  const out = new Set<string>();
  for (const d of docs) if (d.status === "superseded") out.add(d.id);

  // (a) newest-per-url wins (within capture-driven source systems).
  const byUrl = new Map<string, DimmingDocMeta[]>();
  for (const d of docs) {
    if (!d.url || d.status === "superseded") continue;
    const list = byUrl.get(d.url) ?? [];
    list.push(d);
    byUrl.set(d.url, list);
  }
  for (const list of byUrl.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    for (const older of sorted.slice(1)) out.add(older.id);
  }

  // (b) staleness vs the freshest doc of the same source system.
  const maxBySource = new Map<string, number>();
  for (const d of docs) {
    if (d.status === "superseded") continue;
    const t = new Date(d.updated_at).getTime();
    maxBySource.set(d.source_system, Math.max(maxBySource.get(d.source_system) ?? 0, t));
  }
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  for (const d of docs) {
    if (d.status === "superseded" || out.has(d.id)) continue;
    if (d.source_system === "admin_upload") continue; // admin uploads retire explicitly
    const max = maxBySource.get(d.source_system) ?? 0;
    if (max > 0 && max - new Date(d.updated_at).getTime() > staleMs) out.add(d.id);
  }
  return out;
}

// --- product binding (DC4, pattern-primary) ----------------------------------

export interface BindableReport {
  id: string;
  product_family: string | null;
  skus_tested: string[];
  related_model_likes: string[];
  /** Loose single PDF (zip_entry_path null) — the only shape where file
   *  identity = unit identity and `field` links are permitted. */
  loosePdf: boolean;
  kb_document_id: string | null;
}

export interface BindableProduct {
  sku: string;
  /** Space-joined variant SKUs (products.variant_search). */
  variant_search: string | null;
}

export interface PatternBinding {
  report_id: string;
  product_sku: string;
  link_kind: "field" | "pattern";
}

export interface BindingResult {
  links: PatternBinding[];
  /** SKUs matched by patterns from 2+ units with DIFFERENT product_family
   *  values — their link rows are HELD for review (DC4 overlap audit). */
  overlaps: { sku: string; families: string[] }[];
}

/** Pattern-primary product binding (pure): a product binds to a unit when its
 *  SKU (or any variant SKU) matches the unit's related_model_likes or exactly
 *  matches a tested SKU. Overlapping multi-family matches are held. */
export function buildPatternBindings(
  reports: readonly BindableReport[],
  products: readonly BindableProduct[],
): BindingResult {
  const links: PatternBinding[] = [];
  const matchesBySku = new Map<string, Set<string>>(); // sku -> report ids
  const familyByReport = new Map<string, string>();
  for (const r of reports) familyByReport.set(r.id, (r.product_family ?? "").trim().toLowerCase());

  for (const p of products) {
    const candidates = [p.sku, ...(p.variant_search ? p.variant_search.split(/\s+/) : [])].filter(
      Boolean,
    );
    for (const r of reports) {
      const tested = new Set(r.skus_tested.map((s) => s.toUpperCase()));
      const hit = candidates.some(
        (c) => skuMatchesLikes(c, r.related_model_likes) || tested.has(c.toUpperCase()),
      );
      if (!hit) continue;
      const set = matchesBySku.get(p.sku) ?? new Set<string>();
      set.add(r.id);
      matchesBySku.set(p.sku, set);
    }
  }

  const overlaps: { sku: string; families: string[] }[] = [];
  for (const [sku, reportIds] of matchesBySku) {
    const families = [...new Set([...reportIds].map((id) => familyByReport.get(id) ?? ""))];
    if (reportIds.size >= 2 && families.filter(Boolean).length > 1) {
      overlaps.push({ sku, families });
      continue; // held for review — no pattern links written
    }
    for (const id of reportIds) links.push({ report_id: id, product_sku: sku, link_kind: "pattern" });
  }
  return { links, overlaps };
}

// -----------------------------------------------------------------------------
// Claude calls (forced tool)
// -----------------------------------------------------------------------------

interface ClaudeToolCallCfg {
  apiKey: string;
  model: string;
}

async function claudeForcedTool(
  cfg: ClaudeToolCallCfg,
  pdfBytes: Uint8Array,
  tool: { name: string; description: string; input_schema: unknown },
  prompt: string,
  maxTokens: number,
): Promise<unknown> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: Buffer.from(pdfBytes).toString("base64"),
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { content?: { type: string; name?: string; input?: unknown }[] };
  const toolUse = (data.content ?? []).find((b) => b.type === "tool_use" && b.name === tool.name);
  if (!toolUse?.input) throw new Error("no forced tool_use block in response");
  return toolUse.input;
}

export async function extractDimmingUnit(
  cfg: ClaudeToolCallCfg,
  bytes: Uint8Array,
): Promise<ExtractedDimmingReport> {
  const input = await claudeForcedTool(
    cfg,
    bytes,
    DIMMING_EXTRACTION_TOOL as unknown as { name: string; description: string; input_schema: unknown },
    "Extract this WAC dimming-compatibility chart. Record EVERY printed data row exactly as it " +
      "appears, including the page it is on and the section header band it sits under (sections " +
      "like 'Adaptive Phase Dimmers', 'Reverse Phase Dimmers (ELV)', 'Forward Phase Dimmers " +
      "(TRIAC)', '0-10V Dimmers' — a row's section is the band ABOVE it, and a '(ELV)'/'(TRIAC)' " +
      "parenthetical in a model cell is part of that cell, NOT a section). Keep model numbers, " +
      "voltages, low-end percentages and comments verbatim; N/A low end is null. Do not skip, " +
      "merge, or invent rows. The layout varies by generation — do not assume one template.",
    16000,
  );
  return extractedDimmingReportSchema.parse(input);
}

const VERIFIER_TOOL = {
  name: "answer_verification",
  description: "Answer spot-check questions about this dimming chart by reading it directly.",
  input_schema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            low_end_pct: { type: ["number", "null"] },
            comments: { type: "string" },
            section_header: { type: "string" },
          },
          required: ["index", "low_end_pct", "comments", "section_header"],
        },
      },
      section_counts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page: { type: "integer" },
            section_header: { type: "string" },
            row_count: { type: "integer" },
          },
          required: ["page", "section_header", "row_count"],
        },
      },
    },
    required: ["answers", "section_counts"],
  },
} as const;

export function verifierPrompt(samples: readonly VerifiableRow[]): string {
  const questions = samples
    .map((s, i) => {
      const qual = s.mode_qualifier ? ` (${s.mode_qualifier.toUpperCase()})` : "";
      return `${i}. For the row for ${s.manufacturer} model ${parseModeQualifier(s.dimmer_model).text}${qual} tested at ${s.test_voltage}V: what is the Measured Low End percentage (null if N/A), what is the Comments cell (empty string if blank), and under WHICH section header band does that row appear?`;
    })
    .join("\n");
  return (
    "Answer these spot-check questions by reading the chart directly. A '(ELV)' or '(TRIAC)' " +
    "qualifier in a question refers to the parenthetical printed in that row's model/series cell " +
    "(two rows can share a model number and differ only by that qualifier).\n" +
    questions +
    "\nAlso report section_counts: for EVERY section header band on EVERY page (including 'Cont.' " +
    "bands), the page number and how many data rows sit under it on that page."
  );
}

interface VerifierOutput {
  answers: VerifierAnswer[];
  section_counts: VerifierSectionCount[];
}

// -----------------------------------------------------------------------------
// Fetch helpers
// -----------------------------------------------------------------------------

async function fetchBytes(url: string): Promise<Uint8Array> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": USER_AGENT, accept: "application/pdf,application/zip,*/*" },
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** HEAD-probe a derived URL (MF spec-sheet idiom, PR #208): 200 + a non-HTML
 *  content type. The brand site soft-404s some zips with HTML — reject those. */
async function headProbe(url: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  try {
    const r = await fetch(url, {
      method: "HEAD",
      signal: ctl.signal,
      headers: { "user-agent": USER_AGENT },
      redirect: "follow",
    });
    if (!r.ok) return false;
    const ct = (r.headers.get("content-type") ?? "").toLowerCase();
    return !ct.includes("text/html");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// The run
// -----------------------------------------------------------------------------

export interface RunDimmingOptions {
  dryRun: boolean;
  sample: number | null;
  apiKey: string | null;
  model?: string;
  verifierModel?: string;
}

interface KbDimDoc {
  id: string;
  url: string | null;
  r2_key: string | null;
  source_system: string;
  status: string;
  brand: string | null;
  updated_at: string;
}

async function pageAll<T>(
  fetchPage: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999);
    if (error) throw new Error(`${label} read failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/** Step 0 — derived-URL fallback capture (§A.4). Failures logged, never fatal. */
async function captureDerivedUrls(sb: SupabaseClient, dryRun: boolean): Promise<number> {
  interface ProdRow {
    sku: string;
    name: string | null;
    brand: string | null;
    zmatdimrep: string | null;
  }
  const prods = await pageAll<ProdRow>(
    (from, to) =>
      sb
        .from("products")
        .select("sku, name, brand, zmatdimrep:raw_json->>zmatdimrep")
        .range(from, to) as never,
    "products",
  );
  const covered = new Set<string>();
  const links = await pageAll<{ product_sku: string }>(
    (from, to) =>
      sb
        .from("product_documents")
        .select("product_sku")
        .eq("doc_type", DIMMING_REPORT_DOC_TYPE)
        .range(from, to) as never,
    "product_documents",
  );
  for (const l of links) covered.add(l.product_sku);

  const candidates = prods
    .map((p) => ({ ...p, filename: validZmatdimrep(p.zmatdimrep) }))
    .filter((p) => p.filename && !covered.has(p.sku));
  if (!candidates.length) return 0;
  if (dryRun) {
    console.log(`[dimming] (dry-run) ${candidates.length} products need a derived dim_report URL probe`);
    return 0;
  }

  let added = 0;
  const byUrl = new Map<string, { url: string; brand: string | null; title: string; skus: string[] }>();
  for (const c of candidates) {
    const url = derivedDimReportUrl(c.filename!);
    const entry = byUrl.get(url) ?? {
      url,
      brand: c.brand,
      title: `${c.name ?? c.sku} — Dimming Compatibility Report`,
      skus: [],
    };
    entry.skus.push(c.sku);
    byUrl.set(url, entry);
  }
  for (const entry of byUrl.values()) {
    try {
      if (!(await headProbe(entry.url))) {
        console.log(`[dimming] derived URL probe failed (skip): ${entry.url}`);
        continue;
      }
      const { data, error } = await sb
        .from("kb_documents")
        .upsert(
          {
            source_system: "derived_url",
            external_id: entry.url,
            doc_type: DIMMING_REPORT_DOC_TYPE,
            scope: "public",
            brand: entry.brand,
            title: entry.title,
            url: entry.url,
          },
          { onConflict: "source_system,external_id" },
        )
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      const docId = (data as { id: string }).id;
      const linkRows = entry.skus.map((sku) => ({
        document_id: docId,
        product_sku: sku,
        doc_type: DIMMING_REPORT_DOC_TYPE,
        label: "Dimming Compatibility Report",
        url: entry.url,
        scope: "public",
      }));
      for (let i = 0; i < linkRows.length; i += UPSERT) {
        const { error: lerr } = await sb
          .from("product_documents")
          .upsert(linkRows.slice(i, i + UPSERT), { onConflict: "document_id,product_sku" });
        if (lerr) throw new Error(lerr.message);
      }
      added++;
    } catch (e) {
      console.warn(`[dimming] derived URL capture failed (non-fatal) ${entry.url}: ${String(e).slice(0, 200)}`);
    }
  }
  return added;
}

export async function runDimming(
  sb: SupabaseClient,
  web: WebStore | null,
  opts: RunDimmingOptions,
): Promise<void> {
  const model = opts.model || DEFAULT_DIMMING_EXTRACTION_MODEL;
  const verifierModel = opts.verifierModel || DEFAULT_DIMMING_VERIFIER_MODEL;
  const report: string[] = [];
  const unknownVocab = new Set<string>();

  // Step 0 — derived-URL fallback capture. Skipped on --sample runs (the gate
  // run is about extraction quality, not acquisition breadth).
  if (opts.sample === null) {
    const derived = await captureDerivedUrls(sb, opts.dryRun);
    console.log(`[dimming] derived-URL capture: ${derived} docs added`);
  }

  // Step 1 — the captured dimming docs.
  const docs = await pageAll<KbDimDoc>(
    (from, to) =>
      sb
        .from("kb_documents")
        .select("id, url, r2_key, source_system, status, brand, updated_at")
        .eq("doc_type", DIMMING_REPORT_DOC_TYPE)
        .range(from, to) as never,
    "kb_documents(dimming)",
  );
  console.log(`[dimming] ${docs.length} captured dimming docs`);

  // Supersession sweep input runs over ALL docs; extraction only over current.
  const supersededDocIds = computeSupersededDocIds(docs);
  const currentDocs = docs.filter((d) => !supersededDocIds.has(d.id) && d.status !== "failed");

  if (opts.dryRun) {
    console.log(
      `[dimming] (dry-run) ${currentDocs.length} current docs would be scanned; ` +
        `${supersededDocIds.size} docs would sweep to superseded`,
    );
    return;
  }

  // Existing units by hash (skip already-current ones).
  interface UnitRow {
    id: string;
    content_hash: string;
    status: string;
    extraction_version: number;
  }
  const existingUnits = await pageAll<UnitRow>(
    (from, to) =>
      sb
        .from("dimming_reports")
        .select("id, content_hash, status, extraction_version")
        .range(from, to) as never,
    "dimming_reports",
  );
  const unitByHash = new Map(existingUnits.map((u) => [u.content_hash, u]));

  const cfg: ClaudeToolCallCfg | null = opts.apiKey ? { apiKey: opts.apiKey, model } : null;
  const verifierCfg: ClaudeToolCallCfg | null = opts.apiKey
    ? { apiKey: opts.apiKey, model: verifierModel }
    : null;
  if (!cfg) {
    console.warn("[dimming] ANTHROPIC_API_KEY unset — units discovered but not extracted");
  }

  const syncedAt = new Date().toISOString();
  let processed = 0;
  let active = 0;
  let needsReview = 0;
  let failed = 0;
  let skippedCurrent = 0;

  const budget = opts.sample ?? Infinity;

  for (const doc of currentDocs) {
    if (processed >= budget) break;
    let bytes: Uint8Array | null = null;
    try {
      if (doc.r2_key && web) bytes = (await web.getObject(doc.r2_key))?.bytes ?? null;
      if (!bytes && doc.url) bytes = await fetchBytes(doc.url);
      if (!bytes) throw new Error("no bytes (no url and no R2 object)");
    } catch (e) {
      failed++;
      await sb
        .from("kb_documents")
        .update({ status: "failed", last_error: `dimming fetch: ${String(e).slice(0, 400)}` })
        .eq("id", doc.id);
      continue;
    }

    let fanout: { units: ExtractionUnit[]; skipped: string[] };
    try {
      fanout = unitsFromBytes(bytes);
    } catch (e) {
      failed++;
      await sb
        .from("kb_documents")
        .update({ status: "failed", last_error: `dimming fan-out: ${String(e).slice(0, 400)}` })
        .eq("id", doc.id);
      continue;
    }
    for (const s of fanout.skipped) report.push(`skipped non-PDF zip entry: ${s} (${doc.url})`);

    let docFullyProcessed = true;
    for (const unit of fanout.units) {
      if (processed >= budget) {
        docFullyProcessed = false;
        break;
      }
      const existing = unitByHash.get(unit.contentHash);
      const isCurrent =
        existing &&
        (existing.status === "active" || existing.status === "needs_review") &&
        existing.extraction_version >= DIMMING_EXTRACTION_VERSION;
      if (isCurrent) {
        skippedCurrent++;
        // Keep provenance fresh (paths/doc pointer/synced_at) without re-extracting.
        await sb
          .from("dimming_reports")
          .update({
            kb_document_id: doc.id,
            source_url: doc.url,
            zip_entry_path: unit.zipEntryPaths,
            synced_at: syncedAt,
          })
          .eq("content_hash", unit.contentHash);
        continue;
      }
      if (!cfg || !verifierCfg) {
        docFullyProcessed = false;
        continue;
      }
      processed++;
      const entryPath = unit.zipEntryPaths?.[0] ?? null;
      try {
        // ---- extraction (forced tool) + code-side derivation ---------------
        const extracted = await extractDimmingUnit(cfg, unit.bytes);
        const applied = applyExtraction(extracted, entryPath ?? unitFileName(doc.url));
        for (const v of applied.unknownVocabulary) unknownVocab.add(v);
        for (const d of applied.phaseDisagreements) {
          report.push(`phase cross-check (${unit.contentHash.slice(0, 12)}): ${d}`);
        }

        // ---- transactional-ish rewrite: upsert unit, delete rows, insert ---
        const { data: repRow, error: repErr } = await sb
          .from("dimming_reports")
          .upsert(
            {
              kb_document_id: doc.id,
              source_url: doc.url,
              zip_entry_path: unit.zipEntryPaths,
              content_hash: unit.contentHash,
              ...applied.report,
              extraction_version: DIMMING_EXTRACTION_VERSION,
              model,
              status: "pending",
              verified_at: null,
              last_error: null,
              synced_at: syncedAt,
            },
            { onConflict: "content_hash" },
          )
          .select("id")
          .single();
        if (repErr) throw new Error(`dimming_reports upsert: ${repErr.message}`);
        const reportId = (repRow as { id: string }).id;

        const del = await sb.from("dimming_compat_rows").delete().eq("report_id", reportId);
        if (del.error) throw new Error(`rows delete: ${del.error.message}`);
        const rowPayload = applied.rows.map((r) => ({
          report_id: reportId,
          manufacturer: r.manufacturer,
          dimmer_series: r.dimmer_series,
          dimmer_model: r.dimmer_model,
          mode_qualifier: r.mode_qualifier,
          dimmer_model_norm: r.dimmer_model_norm,
          related_dimmer_models: r.related_dimmer_models,
          related_dimmer_models_norm: r.related_dimmer_models_norm,
          phase_type: r.phase_type,
          test_voltage: r.test_voltage,
          low_end_pct: r.low_end_pct,
          status: r.status,
          comments: r.comments,
          extraction_version: DIMMING_EXTRACTION_VERSION,
        }));
        for (let i = 0; i < rowPayload.length; i += UPSERT) {
          const ins = await sb.from("dimming_compat_rows").insert(rowPayload.slice(i, i + UPSERT));
          if (ins.error) throw new Error(`rows insert: ${ins.error.message}`);
        }

        // ---- stratified verification gate (DC5) ----------------------------
        const verifiable: VerifiableRow[] = applied.rows.map((r) => ({
          page: r.page,
          section_header: r.section_header,
          phase_type: r.phase_type,
          manufacturer: r.manufacturer,
          dimmer_model: r.dimmer_model,
          mode_qualifier: r.mode_qualifier,
          dimmer_model_norm: r.dimmer_model_norm,
          test_voltage: r.test_voltage,
          low_end_pct: r.low_end_pct,
          comments: r.comments,
        }));
        const sections = pickVerificationSamples(verifiable);
        const samples = sections.filter((s) => s.sample).map((s) => s.sample!);
        const verifierRaw = (await claudeForcedTool(
          verifierCfg,
          unit.bytes,
          VERIFIER_TOOL as unknown as { name: string; description: string; input_schema: unknown },
          verifierPrompt(samples),
          6000,
        )) as VerifierOutput;
        const verdict = verifyExtraction(
          sections,
          verifierRaw.answers ?? [],
          verifierRaw.section_counts ?? [],
        );

        const unitLabel = entryPath ?? doc.url ?? unit.contentHash.slice(0, 12);
        if (verdict.ok) {
          active++;
          await sb
            .from("dimming_reports")
            .update({ status: "active", verified_at: new Date().toISOString(), last_error: null })
            .eq("id", reportId);
          report.push(
            `PASS ${unitLabel}: ${applied.rows.length} rows, ${samples.length} cells verified across ${sections.length} sections`,
          );
        } else {
          needsReview++;
          await sb
            .from("dimming_reports")
            .update({ status: "needs_review", last_error: verdict.mismatches.join("; ").slice(0, 900) })
            .eq("id", reportId);
          report.push(
            `NEEDS_REVIEW ${unitLabel}: ${applied.rows.length} rows; mismatches: ${verdict.mismatches.join(" | ")}`,
          );
        }
      } catch (e) {
        failed++;
        docFullyProcessed = false;
        const msg = String(e instanceof Error ? e.message : e).slice(0, 400);
        report.push(`FAIL ${entryPath ?? doc.url}: ${msg}`);
        await sb
          .from("dimming_reports")
          .upsert(
            {
              kb_document_id: doc.id,
              source_url: doc.url,
              zip_entry_path: unit.zipEntryPaths,
              content_hash: unit.contentHash,
              extraction_version: DIMMING_EXTRACTION_VERSION,
              model,
              status: "failed",
              last_error: msg,
              synced_at: syncedAt,
            },
            { onConflict: "content_hash" },
          );
      }
    }

    // Flip the kb row to 'active' once its units are extracted (DC7 — active
    // with zero chunks is invisible to search_docs by construction; no row
    // sits pending_extract forever polluting --dry-run counts).
    if (docFullyProcessed && doc.status === "pending_extract") {
      await sb
        .from("kb_documents")
        .update({ status: "active", extracted_at: new Date().toISOString(), last_error: null })
        .eq("id", doc.id);
    }
  }

  // Step 5 — product binding, pattern-primary, links rewritten per product.
  const bindable = await pageAll<{
    id: string;
    product_family: string | null;
    skus_tested: string[];
    related_model_likes: string[];
    zip_entry_path: string[] | null;
    kb_document_id: string | null;
  }>(
    (from, to) =>
      sb
        .from("dimming_reports")
        .select("id, product_family, skus_tested, related_model_likes, zip_entry_path, kb_document_id")
        .eq("status", "active")
        .range(from, to) as never,
    "dimming_reports(active)",
  );
  const products = await pageAll<BindableProduct>(
    (from, to) => sb.from("products").select("sku, variant_search").range(from, to) as never,
    "products",
  );
  const { links, overlaps } = buildPatternBindings(
    bindable.map((b) => ({
      id: b.id,
      product_family: b.product_family,
      skus_tested: b.skus_tested ?? [],
      related_model_likes: b.related_model_likes ?? [],
      loosePdf: b.zip_entry_path === null,
      kb_document_id: b.kb_document_id,
    })),
    products,
  );
  for (const o of overlaps) {
    report.push(`OVERLAP AUDIT (links held): ${o.sku} matched by units of families [${o.families.join(", ")}]`);
  }

  // Field links: ONLY loose single-PDF units (file identity = unit identity).
  const looseByDoc = new Map<string, string>(); // kb_document_id -> report_id
  for (const b of bindable) {
    if (b.zip_entry_path === null && b.kb_document_id) looseByDoc.set(b.kb_document_id, b.id);
  }
  if (looseByDoc.size) {
    const fieldLinks = await pageAll<{ document_id: string; product_sku: string }>(
      (from, to) =>
        sb
          .from("product_documents")
          .select("document_id, product_sku")
          .eq("doc_type", DIMMING_REPORT_DOC_TYPE)
          .in("document_id", [...looseByDoc.keys()])
          .range(from, to) as never,
      "product_documents(dimming)",
    );
    for (const fl of fieldLinks) {
      const reportId = looseByDoc.get(fl.document_id);
      if (reportId) links.push({ report_id: reportId, product_sku: fl.product_sku, link_kind: "field" });
    }
  }

  // Rewrite links per product: delete every product's rows, insert the fresh
  // set; products that no longer match anything lose their stale links too.
  const freshByProduct = new Map<string, PatternBinding[]>();
  for (const l of links) {
    const list = freshByProduct.get(l.product_sku) ?? [];
    list.push(l);
    freshByProduct.set(l.product_sku, list);
  }
  const existingLinkSkus = await pageAll<{ product_sku: string }>(
    (from, to) => sb.from("dimming_report_products").select("product_sku").range(from, to) as never,
    "dimming_report_products",
  );
  const touchSkus = [...new Set([...freshByProduct.keys(), ...existingLinkSkus.map((l) => l.product_sku)])];
  for (let i = 0; i < touchSkus.length; i += UPSERT) {
    const slice = touchSkus.slice(i, i + UPSERT);
    const del = await sb.from("dimming_report_products").delete().in("product_sku", slice);
    if (del.error) throw new Error(`link delete: ${del.error.message}`);
  }
  const linkRows = links.map((l) => ({ ...l }));
  const dedup = new Map(linkRows.map((l) => [`${l.report_id}|${l.product_sku}|${l.link_kind}`, l]));
  const dedupRows = [...dedup.values()];
  for (let i = 0; i < dedupRows.length; i += UPSERT) {
    const ins = await sb.from("dimming_report_products").insert(dedupRows.slice(i, i + UPSERT));
    if (ins.error) throw new Error(`link insert: ${ins.error.message}`);
  }

  // Step 6 — supersession sweep (DC6): retire units of no-longer-current docs.
  if (supersededDocIds.size) {
    const ids = [...supersededDocIds];
    for (let i = 0; i < ids.length; i += UPSERT) {
      const slice = ids.slice(i, i + UPSERT);
      const upd = await sb
        .from("dimming_reports")
        .update({ status: "superseded" })
        .in("kb_document_id", slice)
        .neq("status", "superseded");
      if (upd.error) throw new Error(`supersede units: ${upd.error.message}`);
      const kbUpd = await sb
        .from("kb_documents")
        .update({ status: "superseded" })
        .in("id", slice)
        .neq("status", "superseded");
      if (kbUpd.error) throw new Error(`supersede docs: ${kbUpd.error.message}`);
    }
    // Their links die with them.
    const deadReports = await pageAll<{ id: string }>(
      (from, to) =>
        sb.from("dimming_reports").select("id").eq("status", "superseded").range(from, to) as never,
      "dimming_reports(superseded)",
    );
    const deadIds = deadReports.map((r) => r.id);
    for (let i = 0; i < deadIds.length; i += UPSERT) {
      await sb.from("dimming_report_products").delete().in("report_id", deadIds.slice(i, i + UPSERT));
    }
  }

  // ---- the human-readable run report (plan §B.2/§G.3) ------------------------
  console.log("\n[dimming] ================ RUN REPORT ================");
  console.log(
    `[dimming] units: ${processed} processed (${active} active, ${needsReview} needs_review, ` +
      `${failed} failed), ${skippedCurrent} already current; model=${model} verifier=${verifierModel}`,
  );
  console.log(`[dimming] links: ${dedupRows.length} written; overlaps held: ${overlaps.length}`);
  console.log(`[dimming] supersession sweep: ${supersededDocIds.size} source docs retired`);
  for (const line of report) console.log(`[dimming] ${line}`);
  if (unknownVocab.size) {
    console.log(
      "[dimming] UNMATCHED COMMENT VOCABULARY (review before activation — DC1):",
    );
    for (const v of unknownVocab) console.log(`[dimming]   "${v}"`);
  } else {
    console.log("[dimming] no unmatched comment vocabulary");
  }
  if (opts.sample !== null) {
    console.log(
      `[dimming] SAMPLE RUN (--sample ${opts.sample}) — STOP: review this report (incl. the ` +
        "unmatched vocabulary and overlap flags) and get explicit approval before the full run.",
    );
  }
}

function unitFileName(url: string | null): string | null {
  if (!url) return null;
  try {
    const path = new URL(url).pathname;
    const base = decodeURIComponent(path.split("/").pop() ?? "");
    return base || null;
  } catch {
    return null;
  }
}
