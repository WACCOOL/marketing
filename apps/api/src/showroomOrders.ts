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

/* --------------------------- rep-code association --------------------------- */

/**
 * The deal <-> Rep Code (2-41537429) association type, resolved once per worker
 * lifetime; created (label "Rep Code") if the portal doesn't have one yet, the
 * same bootstrap open-orders-sync used for orders<->rep-code. null = unavailable
 * (schema scope missing) -> rep-code association silently skips, everything else
 * still syncs.
 */
let dealRepCodeAssoc: { typeId: number; category: "HUBSPOT_DEFINED" | "USER_DEFINED" } | null | undefined;
async function getDealRepCodeAssocType(
  token: string,
  signal: AbortSignal,
): Promise<{ typeId: number; category: "HUBSPOT_DEFINED" | "USER_DEFINED" } | null> {
  if (dealRepCodeAssoc !== undefined) return dealRepCodeAssoc;
  const labelsPath = `/crm/v4/associations/0-3/${REP_OBJECT}/labels`;
  const existing = await hs(token, "GET", labelsPath, undefined, signal);
  const first = existing.ok ? existing.data?.results?.[0] : null;
  if (first?.typeId != null) {
    dealRepCodeAssoc = {
      typeId: Number(first.typeId),
      category: first.category === "HUBSPOT_DEFINED" ? "HUBSPOT_DEFINED" : "USER_DEFINED",
    };
    return dealRepCodeAssoc;
  }
  const created = await hs(
    token,
    "POST",
    labelsPath,
    { label: "Rep Code", name: "deal_to_rep_code" },
    signal,
  );
  const t = created.ok ? created.data?.results?.[0]?.typeId : null;
  dealRepCodeAssoc = t != null ? { typeId: Number(t), category: "USER_DEFINED" } : null;
  if (dealRepCodeAssoc) console.log(`[showroom-sync] created deal<->rep-code association type ${t}`);
  else console.warn(`[showroom-sync] deal<->rep-code association unavailable (${created.status}) — skipping`);
  return dealRepCodeAssoc;
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
  const repCodePairs: { fromId: string; toId: string }[] = [];
  for (const o of parsed.orders) {
    const dealId = dealIdByKey.get(o.orderKey);
    const company = companyFor(o);
    if (!dealId || !company) continue;
    companyPairs.push({ fromId: company.id, toId: dealId });
    const repCodeId = company.repCode ? repCodeIds.get(company.repCode) : null;
    if (repCodeId) repCodePairs.push({ fromId: dealId, toId: repCodeId });
  }
  if (companyPairs.length) {
    await batchAssociate(token.hubspot, PATHS.companyToDeal, COMPANY_TO_DEAL_ASSOC, companyPairs, signal);
  }
  if (repCodePairs.length) {
    const assocType = await getDealRepCodeAssocType(token.hubspot, signal);
    if (assocType) {
      await batchAssociate(
        token.hubspot,
        `/crm/v4/associations/0-3/${REP_OBJECT}/batch/create`,
        assocType.typeId,
        repCodePairs,
        signal,
        assocType.category,
      );
    }
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
            `${s.companyMatched} matched (${s.repCodeMatched} w/ rep code), ${s.companyMisses.length} company misses, ${s.errors.length} errors`,
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
