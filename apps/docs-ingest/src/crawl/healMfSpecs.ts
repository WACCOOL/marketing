import type { SupabaseClient } from "@supabase/supabase-js";
import { MODERN_FORMS_SPEC_TEMPLATES, modernFormsPpid, modernFormsSpecUrl } from "@wac/shared";

/**
 * One-off heal (--heal-mf-specs) for the Modern Forms spec-sheet defect: an
 * early --reconcile-write run filled ~29 pdp_urls.spec_sheet_url values with
 * the PDP-path dispatcher form (`/product/<slug>?download=specsN`), which
 * answers HTML (not a PDF) to fetchers — so Step A folded them into
 * kb_documents and Step B failed every one with "not a PDF (dynamic endpoint
 * returned non-PDF)".
 *
 * For each bad row this pass:
 *  1. re-fetches the PDP with the WORKING fetch shape (honest app UA — the
 *     same route products-sync uses; browser-shaped UAs get 403),
 *  2. reads data-ppid (NOT always equal to the catalog sku — e.g. Fusion is
 *     sku 1379 / ppid 1539) and HEAD-probes the dynamic-specsheet templates
 *     for the one that actually answers a PDF,
 *  3. overwrites the bad spec_sheet_url with the verified URL (these rows
 *     were null before the bad heal, so gap-heal semantics are preserved;
 *     unresolvable rows revert to null so a later resolver pass can retry),
 *  4. repoints the corresponding failed kb_documents row at the fixed URL and
 *     requeues it (status='pending_extract', last_error null) — or supersedes
 *     it when a doc for the fixed URL already exists or nothing resolved —
 *     and keeps the product_documents links in step.
 *
 * Scoped STRICTLY to rows whose spec_sheet_url matches the bad form: safe to
 * run alongside other jobs; writes are per-row and guarded on the bad value.
 */

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "WAC-Marketing-App/1.0 (+thom mf spec heal; contact WAC IT)";

export interface HealMfDeps {
  fetchHtml?: (url: string) => Promise<string | null>;
  probePdf?: (url: string) => Promise<boolean>;
  log?: (m: string) => void;
}

export interface HealMfReport {
  scanned: number;
  healed: number;       // pdp_urls rows given a verified dynamic-specsheet URL
  cleared: number;      // pdp_urls rows reverted to null (nothing resolved)
  kbRequeued: number;   // failed kb rows repointed + status='pending_extract'
  kbSuperseded: number; // kb rows superseded (dup target or unresolvable)
  linksUpdated: number; // product_documents links repointed/removed
}

async function defaultFetchHtml(url: string): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      redirect: "follow",
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultProbePdf(url: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "HEAD",
      signal: ctl.signal,
      headers: { "user-agent": USER_AGENT, accept: "application/pdf,*/*" },
    });
    return r.ok && (r.headers.get("content-type") ?? "").toLowerCase().includes("application/pdf");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface BadRow {
  sku: string;
  url: string | null;
  spec_sheet_url: string;
}

export async function healMfSpecs(
  sb: SupabaseClient,
  deps: HealMfDeps,
  opts: { dryRun: boolean },
): Promise<HealMfReport> {
  const log = deps.log ?? ((m) => console.log(m));
  const fetchHtml = deps.fetchHtml ?? defaultFetchHtml;
  const probePdf = deps.probePdf ?? defaultProbePdf;
  const report: HealMfReport = {
    scanned: 0, healed: 0, cleared: 0, kbRequeued: 0, kbSuperseded: 0, linksUpdated: 0,
  };

  // The bad form ONLY: the correct dynamic-specsheet URLs also contain
  // download=specs, but never the /product/ path.
  const { data, error } = await sb
    .from("pdp_urls")
    .select("sku, url, spec_sheet_url")
    .like("spec_sheet_url", "%modernforms.com/product/%")
    .like("spec_sheet_url", "%download=specs%");
  if (error) throw new Error(`pdp_urls read failed: ${error.message}`);
  const bad = (data ?? []) as BadRow[];
  report.scanned = bad.length;
  log(`[heal-mf-specs] ${bad.length} pdp_urls rows carry the bad PDP-path form`);

  for (const row of bad) {
    // The row's OWN PDP is the ppid authority (the bad spec URL's slug can
    // disagree with the row's url — e.g. sku 1588 url=scepter, spec=cinderella).
    let pdpUrl = row.url;
    if (!pdpUrl) {
      try {
        const u = new URL(row.spec_sheet_url);
        pdpUrl = `${u.origin}${u.pathname.replace(/\/?$/, "/")}`;
      } catch {
        pdpUrl = null;
      }
    }
    const html = pdpUrl ? await fetchHtml(pdpUrl) : null;
    const ppid = modernFormsPpid(html);
    const harvested = Number(row.spec_sheet_url.match(/[?&]download=specs(\d+)/i)?.[1]);
    let fixed: string | null = null;
    if (ppid) {
      const order = [
        ...(Number.isFinite(harvested) ? [harvested] : []),
        ...MODERN_FORMS_SPEC_TEMPLATES,
      ];
      const seen = new Set<number>();
      for (const t of order) {
        if (seen.has(t)) continue;
        seen.add(t);
        const cand = modernFormsSpecUrl(ppid, t);
        if (await probePdf(cand)) {
          fixed = cand;
          break;
        }
      }
    }

    if (opts.dryRun) {
      log(`[heal-mf-specs] (dry-run) ${row.sku}: ${row.spec_sheet_url} -> ${fixed ?? "null (unresolved)"}`);
      if (fixed) report.healed++;
      else report.cleared++;
      continue;
    }

    // 1. pdp_urls: overwrite the bad value (guarded on it, so a concurrent
    //    writer that already changed the row is left alone).
    const upd = await sb
      .from("pdp_urls")
      .update({ spec_sheet_url: fixed })
      .eq("sku", row.sku)
      .eq("spec_sheet_url", row.spec_sheet_url);
    if (upd.error) throw new Error(`pdp_urls heal update failed (${row.sku}): ${upd.error.message}`);
    if (fixed) report.healed++;
    else report.cleared++;

    // 2. The failed kb_documents row keyed by the bad URL.
    const { data: kbRows, error: kbErr } = await sb
      .from("kb_documents")
      .select("id, status")
      .eq("source_system", "pdp_resolver")
      .eq("external_id", row.spec_sheet_url);
    if (kbErr) throw new Error(`kb_documents read failed: ${kbErr.message}`);
    const oldDoc = (kbRows ?? [])[0] as { id: string; status: string } | undefined;
    if (!oldDoc) {
      log(`[heal-mf-specs] ${row.sku}: pdp_urls fixed, no kb_documents row for the bad url`);
      continue;
    }

    if (!fixed) {
      // Nothing verifiable to requeue: retire the poisoned doc and drop its
      // product links so a future resolver pass + Step A can start clean.
      const sup = await sb.from("kb_documents").update({ status: "superseded" }).eq("id", oldDoc.id);
      if (sup.error) throw new Error(`kb_documents supersede failed: ${sup.error.message}`);
      report.kbSuperseded++;
      const del = await sb.from("product_documents").delete().eq("document_id", oldDoc.id);
      if (del.error) throw new Error(`product_documents delete failed: ${del.error.message}`);
      report.linksUpdated++;
      continue;
    }

    // Does a doc for the fixed URL already exist (e.g. written by products-sync
    // for a sibling sku sharing the sheet)?
    const { data: dupRows, error: dupErr } = await sb
      .from("kb_documents")
      .select("id")
      .eq("source_system", "pdp_resolver")
      .eq("external_id", fixed);
    if (dupErr) throw new Error(`kb_documents dup read failed: ${dupErr.message}`);
    const dup = (dupRows ?? [])[0] as { id: string } | undefined;

    if (dup) {
      // Supersede the bad doc and move its product links onto the existing one.
      const sup = await sb.from("kb_documents").update({ status: "superseded" }).eq("id", oldDoc.id);
      if (sup.error) throw new Error(`kb_documents supersede failed: ${sup.error.message}`);
      report.kbSuperseded++;
      const { data: links, error: linkErr } = await sb
        .from("product_documents")
        .select("product_sku, doc_type, label, scope")
        .eq("document_id", oldDoc.id);
      if (linkErr) throw new Error(`product_documents read failed: ${linkErr.message}`);
      for (const l of (links ?? []) as { product_sku: string; doc_type: string; label: string | null; scope: string }[]) {
        const ins = await sb
          .from("product_documents")
          .upsert([{ document_id: dup.id, product_sku: l.product_sku, doc_type: l.doc_type, label: l.label, url: fixed, scope: l.scope }], {
            onConflict: "document_id,product_sku",
          });
        if (ins.error) throw new Error(`product_documents upsert failed: ${ins.error.message}`);
        report.linksUpdated++;
      }
      const del = await sb.from("product_documents").delete().eq("document_id", oldDoc.id);
      if (del.error) throw new Error(`product_documents delete failed: ${del.error.message}`);
    } else {
      // Repoint the SAME doc row at the fixed URL and requeue it for Step B.
      const re = await sb
        .from("kb_documents")
        .update({ external_id: fixed, url: fixed, status: "pending_extract", last_error: null })
        .eq("id", oldDoc.id);
      if (re.error) throw new Error(`kb_documents requeue failed: ${re.error.message}`);
      report.kbRequeued++;
      const lu = await sb
        .from("product_documents")
        .update({ url: fixed })
        .eq("document_id", oldDoc.id);
      if (lu.error) throw new Error(`product_documents update failed: ${lu.error.message}`);
      report.linksUpdated++;
    }
    log(`[heal-mf-specs] ${row.sku}: ${row.spec_sheet_url} -> ${fixed}`);
  }

  log(
    `[heal-mf-specs] ${report.scanned} scanned: ${report.healed} healed, ${report.cleared} cleared (unresolved) | ` +
      `kb: ${report.kbRequeued} requeued, ${report.kbSuperseded} superseded | ${report.linksUpdated} links updated` +
      (opts.dryRun ? " (dry-run)" : ""),
  );
  return report;
}
