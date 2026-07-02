import {
  SHOWROOM_DEAL_PROPERTY_DEFS,
  SHOWROOM_DEFAULT_TAB,
  SHOWROOM_ORDER_KEY_PROP,
  SHOWROOM_SHEETS,
  accountForms,
  parseShowroomRows,
  showroomDealProperties,
  type ShowroomOrder,
  type ShowroomSheet,
} from "@wac/shared";
import type { Env } from "./env.js";
import { notifySevere } from "./alerts.js";
import { fetchSheetValues, getGoogleSheetsToken, googleSheetsConfigured } from "./googleSheets.js";
import { PATHS, REP_OBJECT, batchAssociate, hs } from "./hubspotPush.js";

/**
 * Showroom PO Orders sync: the rep-agency Google Sheets (registry in
 * @wac/shared showroom/registry.ts) -> HubSpot deals. Every deal is Closed Won
 * in the Universal Pipeline, owned by Kalin Scott, upserted by the unique
 * showroom_order_key so re-runs and row edits update instead of duplicate,
 * and associated to the showroom's Company via account_number_. Runs from the
 * half-hourly cron (gated on SHOWROOM_SYNC_ENABLED) and the manual admin
 * route (routes/showroomOrders.ts), which adds dryRun/force/agency filters.
 */

const BATCH_SIZE = 100;
const INTER_BATCH_MS = 250;
const COMPANY_TO_DEAL_ASSOC = 6; // HUBSPOT_DEFINED company->deal

/** KV (SYNC_STATE) keys: per-sheet content marker + the last run summary. */
const MARKER_PREFIX = "showroom-sync:";
const LAST_RUN_KEY = "showroom-sync:last-run";

export interface ShowroomCompanyMiss {
  agencyKey: string;
  accountNumber: string;
  dealname: string;
  orderKey: string;
}

export interface ShowroomAgencySummary {
  agencyKey: string;
  agencyName: string;
  rows: number;
  skippedUnchanged: boolean;
  created: number;
  updated: number;
  companyMatched: number;
  /** Orders whose matched company carries a sales_rep_code (-> deal sales_group). */
  repCodeMatched: number;
  /** Companies auto-created from sheet name + account # (dry run: would-create). */
  companiesCreated: number;
  companyMisses: ShowroomCompanyMiss[];
  warnings: string[];
  errors: string[];
}

export interface ShowroomSyncSummary {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  ok: boolean;
  agencies: ShowroomAgencySummary[];
}

export interface ShowroomSyncOptions {
  dryRun?: boolean;
  /** Restrict to these registry agencyKeys (unknown keys error). */
  agencyKeys?: string[];
  /** Ignore the per-sheet unchanged markers and re-push everything. */
  force?: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Idempotently create the custom deal properties this sync owns (incl. the
 * unique showroom_order_key the batch upsert keys on — upsert REQUIRES the
 * idProperty to be hasUniqueValue). Checked once per worker lifetime.
 */
let propertiesEnsured = false;
export async function ensureShowroomDealProperties(
  token: string,
  signal: AbortSignal,
): Promise<void> {
  if (propertiesEnsured) return;
  const existing = await hs(token, "GET", "/crm/v3/properties/deals", undefined, signal);
  if (!existing.ok) {
    throw new Error(`deal properties list failed (${existing.status}): needs crm.schemas.deals.read`);
  }
  const have = new Set(
    ((existing.data?.results ?? []) as { name: string }[]).map((p) => p.name),
  );
  for (const def of SHOWROOM_DEAL_PROPERTY_DEFS) {
    if (have.has(def.name)) continue;
    const res = await hs(
      token,
      "POST",
      "/crm/v3/properties/deals",
      {
        name: def.name,
        label: def.label,
        type: "string",
        fieldType: "text",
        groupName: "dealinformation",
        hasUniqueValue: def.hasUniqueValue === true,
      },
      signal,
    );
    if (!res.ok) {
      throw new Error(
        `creating deal property ${def.name} failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)} — needs crm.schemas.deals.write`,
      );
    }
    console.log(`[showroom-sync] created deal property ${def.name}`);
  }
  propertiesEnsured = true;
}

/**
 * Upsert one agency's orders in batches of 100 keyed on showroom_order_key.
 * Returns dealId-by-orderKey plus created/updated counts; a failing batch is
 * retried row-by-row so one bad row can't sink its 99 neighbors.
 */
async function upsertOrders(
  token: string,
  orders: ShowroomOrder[],
  buildProps: (o: ShowroomOrder) => Record<string, string>,
  signal: AbortSignal,
  errors: string[],
): Promise<{ dealIdByKey: Map<string, string>; created: number; updated: number }> {
  const dealIdByKey = new Map<string, string>();
  let created = 0;
  let updated = 0;

  const record = (results: unknown[]) => {
    for (const r of results as { id?: string; new?: boolean; properties?: Record<string, string> }[]) {
      const key = r.properties?.[SHOWROOM_ORDER_KEY_PROP];
      if (r.id && key) dealIdByKey.set(key, String(r.id));
      if (r.new) created++;
      else updated++;
    }
  };

  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    const slice = orders.slice(i, i + BATCH_SIZE);
    const inputs = slice.map((o) => ({
      idProperty: SHOWROOM_ORDER_KEY_PROP,
      id: o.orderKey,
      properties: buildProps(o),
    }));
    const res = await hs(token, "POST", PATHS.dealUpsert, { inputs }, signal);
    if (res.ok) {
      record(res.data?.results ?? []);
    } else {
      // Batch-level failure (usually one row's validation error) — retry
      // individually so the rest of the batch still lands.
      for (const input of inputs) {
        const single = await hs(token, "POST", PATHS.dealUpsert, { inputs: [input] }, signal);
        if (single.ok) {
          record(single.data?.results ?? []);
        } else {
          errors.push(
            `upsert ${input.id} failed (${single.status}): ${JSON.stringify(single.data?.message ?? single.data).slice(0, 200)}`,
          );
        }
      }
    }
    if (i + BATCH_SIZE < orders.length) await delay(INTER_BATCH_MS);
  }
  return { dealIdByKey, created, updated };
}

interface CompanyHit {
  id: string;
  /** The company's `sales_rep_code` — written to the deal's `sales_group`. */
  repCode: string;
}

async function lookupCompanyByAccount(
  token: string,
  accountNumber: string,
  signal: AbortSignal,
): Promise<CompanyHit | null> {
  const path =
    `${PATHS.companyLookup}${encodeURIComponent(accountNumber)}` +
    `?idProperty=account_number_&properties=sales_rep_code`;
  const res = await hs(token, "GET", path, undefined, signal);
  if (res.status === 404 || !res.data?.id) return null;
  if (!res.ok) throw new Error(`company lookup ${accountNumber} failed (${res.status})`);
  return {
    id: String(res.data.id),
    repCode: String(res.data.properties?.sales_rep_code ?? "").trim().toUpperCase(),
  };
}

/** Resolve each distinct account number to a Company (accountForms cascade). */
async function resolveCompanies(
  token: string,
  orders: ShowroomOrder[],
  signal: AbortSignal,
): Promise<Map<string, CompanyHit | null>> {
  const byAccount = new Map<string, CompanyHit | null>();
  for (const order of orders) {
    const acct = order.accountNumber;
    if (!acct || byAccount.has(acct)) continue;
    let hit: CompanyHit | null = null;
    for (const form of accountForms(acct)) {
      hit = await lookupCompanyByAccount(token, form, signal);
      if (hit) break;
    }
    byAccount.set(acct, hit);
  }
  return byAccount;
}

/**
 * Create companies for account numbers HubSpot doesn't know (the sheets carry
 * both the showroom's name and account number). Batch upsert keyed on
 * account_number_ (idempotent — a concurrent create just updates the name),
 * named "{Account Name} #{ACCT}" to match the portal's convention for
 * SAP-imported dealers. Created companies are merged into the resolution map
 * so the deal association + summary treat them as matched (repCode empty —
 * the sheets don't carry one).
 */
async function createMissingCompanies(
  token: string,
  orders: ShowroomOrder[],
  companies: Map<string, CompanyHit | null>,
  signal: AbortSignal,
  errors: string[],
): Promise<number> {
  const toCreate = new Map<string, string>(); // account number -> showroom name
  for (const o of orders) {
    if (!o.accountNumber || companies.get(o.accountNumber)) continue;
    if (!o.accountName) continue; // nothing to name it with — stays a miss
    if (!toCreate.has(o.accountNumber)) toCreate.set(o.accountNumber, o.accountName);
  }
  let created = 0;
  const entries = [...toCreate.entries()];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const slice = entries.slice(i, i + BATCH_SIZE);
    const res = await hs(
      token,
      "POST",
      PATHS.companyUpsert,
      {
        inputs: slice.map(([acct, name]) => ({
          idProperty: "account_number_",
          id: acct,
          properties: { account_number_: acct, name: `${name} #${acct}` },
        })),
      },
      signal,
    );
    if (!res.ok) {
      errors.push(
        `company create batch failed (${res.status}): ${JSON.stringify(res.data?.message ?? res.data).slice(0, 200)}`,
      );
      continue;
    }
    for (const r of (res.data?.results ?? []) as {
      id?: string;
      new?: boolean;
      properties?: { account_number_?: string };
    }[]) {
      const acct = String(r.properties?.account_number_ ?? "").trim();
      if (acct && r.id) {
        companies.set(acct, { id: String(r.id), repCode: "" });
        if (r.new) {
          created++;
          console.log(`[showroom-sync] created company ${acct} (${toCreate.get(acct)})`);
        }
      }
    }
  }
  return created;
}

/* --------------------------- rep-code association --------------------------- */

/**
 * The deal -> Rep Code (2-41537429) association types: the unlabeled base pair
 * PLUS the "Current" label (the portal labels rep-code associations
 * Current/Previous/Inactive). Both must be sent together — creating with only
 * the labeled type returns 201 but attaches nothing (verified live 2026-07-02).
 * Resolved once per worker lifetime; null = unavailable -> rep-code
 * association skips, everything else still syncs.
 */
interface AssocTypeRef {
  typeId: number;
  category: "HUBSPOT_DEFINED" | "USER_DEFINED";
}
let dealRepCodeTypes: AssocTypeRef[] | null | undefined;
async function getDealRepCodeAssocTypes(
  token: string,
  signal: AbortSignal,
): Promise<AssocTypeRef[] | null> {
  if (dealRepCodeTypes !== undefined) return dealRepCodeTypes;
  const res = await hs(token, "GET", `/crm/v4/associations/0-3/${REP_OBJECT}/labels`, undefined, signal);
  const all = ((res.ok ? res.data?.results : null) ?? []) as {
    typeId?: number;
    label?: string | null;
    category?: string;
  }[];
  const ref = (t: { typeId?: number; category?: string }): AssocTypeRef => ({
    typeId: Number(t.typeId),
    category: t.category === "HUBSPOT_DEFINED" ? "HUBSPOT_DEFINED" : "USER_DEFINED",
  });
  const unlabeled = all.find((t) => t.typeId != null && t.label == null);
  const current = all.find((t) => String(t.label ?? "").trim().toLowerCase() === "current");
  const picked = [unlabeled, current].filter((t) => t != null).map(ref);
  dealRepCodeTypes = picked.length ? picked : null;
  if (!dealRepCodeTypes) {
    console.warn(`[showroom-sync] no deal<->rep-code association types found (${res.status}) — skipping`);
  }
  return dealRepCodeTypes;
}

/** Associate deals to Rep Code objects (base + "Current" label), verifying results. */
async function associateRepCodes(
  token: string,
  pairs: { dealId: string; repCodeId: string }[],
  signal: AbortSignal,
  warnings: string[],
): Promise<void> {
  const types = await getDealRepCodeAssocTypes(token, signal);
  if (!types) return;
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const slice = pairs.slice(i, i + BATCH_SIZE);
    const res = await hs(
      token,
      "POST",
      `/crm/v4/associations/0-3/${REP_OBJECT}/batch/create`,
      {
        inputs: slice.map((p) => ({
          types: types.map((t) => ({ associationCategory: t.category, associationTypeId: t.typeId })),
          from: { id: p.dealId },
          to: { id: p.repCodeId },
        })),
      },
      signal,
    );
    const createdCount = ((res.ok ? res.data?.results : null) ?? []).length;
    // A 201 with an empty results array is a silent no-op (seen live) — surface it.
    if (!res.ok || createdCount < slice.length) {
      warnings.push(
        `rep-code association batch: expected ${slice.length}, created ${createdCount} (status ${res.status})`,
      );
    }
  }
}

/** Resolve rep codes ("DDM") to Rep Code object ids, cached per worker lifetime. */
const repCodeObjectIdCache = new Map<string, string | null>();
async function resolveRepCodeObjectIds(
  token: string,
  codes: Iterable<string>,
  signal: AbortSignal,
): Promise<Map<string, string | null>> {
  const missing = [...new Set(codes)].filter((c) => c && !repCodeObjectIdCache.has(c));
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const slice = missing.slice(i, i + BATCH_SIZE);
    const res = await hs(
      token,
      "POST",
      `/crm/v3/objects/${REP_OBJECT}/batch/read`,
      { idProperty: "rep_code", properties: ["rep_code"], inputs: slice.map((id) => ({ id })) },
      signal,
    );
    const found = new Map<string, string>();
    for (const r of ((res.ok ? res.data?.results : null) ?? []) as {
      id?: string;
      properties?: { rep_code?: string };
    }[]) {
      const code = String(r.properties?.rep_code ?? "").trim().toUpperCase();
      if (code && r.id) found.set(code, String(r.id));
    }
    for (const code of slice) repCodeObjectIdCache.set(code, found.get(code) ?? null);
  }
  return repCodeObjectIdCache;
}

async function syncSheet(
  env: Env,
  sheet: ShowroomSheet,
  token: { google: string; hubspot: string },
  opts: ShowroomSyncOptions,
  signal: AbortSignal,
): Promise<ShowroomAgencySummary> {
  const summary: ShowroomAgencySummary = {
    agencyKey: sheet.agencyKey,
    agencyName: sheet.agencyName,
    rows: 0,
    skippedUnchanged: false,
    created: 0,
    updated: 0,
    companyMatched: 0,
    repCodeMatched: 0,
    companiesCreated: 0,
    companyMisses: [],
    warnings: [],
    errors: [],
  };

  const range = `${sheet.tab ?? SHOWROOM_DEFAULT_TAB}!A:J`;
  const values = await fetchSheetValues(token.google, sheet.spreadsheetId, range, signal);

  // Skip untouched sheets on the half-hourly poll (marker = content hash,
  // written only after a fully successful live push).
  const markerKey = `${MARKER_PREFIX}${sheet.spreadsheetId}`;
  const marker = await sha256Hex(JSON.stringify(values));
  if (!opts.force && !opts.dryRun) {
    const last = await env.SYNC_STATE.get(markerKey);
    if (last === marker) {
      summary.skippedUnchanged = true;
      return summary;
    }
  }

  const parsed = parseShowroomRows(values, sheet);
  summary.rows = parsed.orders.length;
  summary.warnings.push(...parsed.warnings);
  for (const w of parsed.warnings) console.warn(`[showroom-sync] ${w}`);

  // Companies first: the matched company's sales_rep_code becomes the deal's
  // sales_group (same field the SAP deal sync uses for rep codes), so it must
  // ride along in the upsert payload.
  const companies = await resolveCompanies(token.hubspot, parsed.orders, signal);

  // Unknown account numbers become NEW companies (name + account # from the
  // sheet). Dry runs only count what would be created.
  if (opts.dryRun) {
    const wouldCreate = new Set<string>();
    for (const o of parsed.orders) {
      if (o.accountNumber && o.accountName && !companies.get(o.accountNumber)) {
        wouldCreate.add(o.accountNumber);
      }
    }
    summary.companiesCreated = wouldCreate.size;
  } else {
    summary.companiesCreated = await createMissingCompanies(
      token.hubspot,
      parsed.orders,
      companies,
      signal,
      summary.errors,
    );
  }

  const companyFor = (o: ShowroomOrder): CompanyHit | null =>
    o.accountNumber ? (companies.get(o.accountNumber) ?? null) : null;
  const buildProps = (o: ShowroomOrder): Record<string, string> => {
    const props = showroomDealProperties(o);
    const repCode = companyFor(o)?.repCode;
    if (repCode) props.sales_group = repCode;
    return props;
  };

  for (const o of parsed.orders) {
    if (companyFor(o)) {
      summary.companyMatched++;
      if (companyFor(o)!.repCode) summary.repCodeMatched++;
    } else {
      summary.companyMisses.push({
        agencyKey: o.agencyKey,
        accountNumber: o.accountNumber,
        dealname: showroomDealProperties(o).dealname!,
        orderKey: o.orderKey,
      });
      if (!opts.dryRun) {
        console.warn(
          `[showroom-sync] ${sheet.agencyKey}: no company for account "${o.accountNumber}" (${o.orderKey})`,
        );
      }
    }
  }

  if (opts.dryRun) return summary;

  if (!parsed.orders.length) {
    await env.SYNC_STATE.put(markerKey, marker);
    return summary;
  }

  const { dealIdByKey, created, updated } = await upsertOrders(
    token.hubspot,
    parsed.orders,
    buildProps,
    signal,
    summary.errors,
  );
  summary.created = created;
  summary.updated = updated;

  // Associations: company -> deal, and deal -> Rep Code object (by the
  // company's sales_rep_code, mirroring the SAP-deal convention).
  const repCodeIds = await resolveRepCodeObjectIds(
    token.hubspot,
    [...companies.values()].flatMap((c) => (c?.repCode ? [c.repCode] : [])),
    signal,
  );
  const companyPairs: { fromId: string; toId: string }[] = [];
  const repCodePairs: { dealId: string; repCodeId: string }[] = [];
  for (const o of parsed.orders) {
    const dealId = dealIdByKey.get(o.orderKey);
    const company = companyFor(o);
    if (!dealId || !company) continue;
    companyPairs.push({ fromId: company.id, toId: dealId });
    const repCodeId = company.repCode ? repCodeIds.get(company.repCode) : null;
    if (repCodeId) repCodePairs.push({ dealId, repCodeId });
  }
  if (companyPairs.length) {
    await batchAssociate(token.hubspot, PATHS.companyToDeal, COMPANY_TO_DEAL_ASSOC, companyPairs, signal);
  }
  if (repCodePairs.length) {
    await associateRepCodes(token.hubspot, repCodePairs, signal, summary.warnings);
  }

  // Only mark the sheet done when every row landed.
  if (!summary.errors.length) await env.SYNC_STATE.put(markerKey, marker);
  return summary;
}

export async function runShowroomOrdersSync(
  env: Env,
  opts: ShowroomSyncOptions,
  signal: AbortSignal,
): Promise<ShowroomSyncSummary> {
  const startedAt = new Date().toISOString();
  if (!env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN is not configured");
  if (!googleSheetsConfigured(env)) throw new Error("GOOGLE_SA_KEY is not configured");

  let sheets = SHOWROOM_SHEETS;
  if (opts.agencyKeys?.length) {
    const wanted = new Set(opts.agencyKeys);
    sheets = SHOWROOM_SHEETS.filter((s) => wanted.has(s.agencyKey));
    const known = new Set(sheets.map((s) => s.agencyKey));
    const unknown = opts.agencyKeys.filter((k) => !known.has(k));
    if (unknown.length) throw new Error(`unknown agencyKeys: ${unknown.join(", ")}`);
  }

  const google = await getGoogleSheetsToken(env, signal);
  const hubspot = env.HUBSPOT_TOKEN;
  if (!opts.dryRun) await ensureShowroomDealProperties(hubspot, signal);

  const agencies: ShowroomAgencySummary[] = [];
  for (const sheet of sheets) {
    try {
      const s = await syncSheet(env, sheet, { google, hubspot }, opts, signal);
      agencies.push(s);
      if (!s.skippedUnchanged) {
        console.log(
          `[showroom-sync] ${s.agencyKey}: ${s.rows} rows, ${s.created} created, ${s.updated} updated, ` +
            `${s.companyMatched} matched (${s.repCodeMatched} w/ rep code), ${s.companiesCreated} companies created, ` +
            `${s.companyMisses.length} company misses, ${s.errors.length} errors`,
        );
      }
    } catch (e) {
      // Fail-soft per sheet: one broken/unshared sheet must not block the rest.
      const msg = e instanceof Error ? e.message : String(e);
      agencies.push({
        agencyKey: sheet.agencyKey,
        agencyName: sheet.agencyName,
        rows: 0,
        skippedUnchanged: false,
        created: 0,
        updated: 0,
        companyMatched: 0,
        repCodeMatched: 0,
        companiesCreated: 0,
        companyMisses: [],
        warnings: [],
        errors: [msg],
      });
      console.error(`[showroom-sync] ${sheet.agencyKey} failed: ${msg}`);
    }
  }

  const failed = agencies.filter((a) => a.errors.length);
  const summary: ShowroomSyncSummary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: !!opts.dryRun,
    ok: !failed.length,
    agencies,
  };

  if (failed.length && !opts.dryRun) {
    await notifySevere(env, {
      kind: "showroom",
      title: `showroom-orders sync: ${failed.length} agency sheet(s) failed`,
      detail: failed.map((a) => `${a.agencyKey}: ${a.errors[0]}`).join(" | ").slice(0, 500),
    });
  }
  if (!opts.dryRun) {
    await env.SYNC_STATE.put(LAST_RUN_KEY, JSON.stringify(summary));
  }
  return summary;
}

/** Read the last non-dry-run summary (the GET route + quick prod checks). */
export async function lastShowroomRun(env: Env): Promise<ShowroomSyncSummary | null> {
  const raw = await env.SYNC_STATE.get(LAST_RUN_KEY);
  return raw ? (JSON.parse(raw) as ShowroomSyncSummary) : null;
}
