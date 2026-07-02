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
import { PATHS, batchAssociate, hs, lookupCompanyId } from "./hubspotPush.js";

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
      properties: showroomDealProperties(o),
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

/** Resolve each distinct account number to a Company id (accountForms cascade). */
async function resolveCompanies(
  token: string,
  orders: ShowroomOrder[],
  signal: AbortSignal,
): Promise<Map<string, string | null>> {
  const byAccount = new Map<string, string | null>();
  for (const order of orders) {
    const acct = order.accountNumber;
    if (!acct || byAccount.has(acct)) continue;
    let id: string | null = null;
    for (const form of accountForms(acct)) {
      id = await lookupCompanyId(token, form, signal);
      if (id) break;
    }
    byAccount.set(acct, id);
  }
  return byAccount;
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

  if (opts.dryRun) {
    // Still resolve companies so the dry run reports the match rate.
    const companies = await resolveCompanies(token.hubspot, parsed.orders, signal);
    for (const o of parsed.orders) {
      if (!o.accountNumber || !companies.get(o.accountNumber)) {
        summary.companyMisses.push({
          agencyKey: o.agencyKey,
          accountNumber: o.accountNumber,
          dealname: showroomDealProperties(o).dealname!,
          orderKey: o.orderKey,
        });
      } else {
        summary.companyMatched++;
      }
    }
    return summary;
  }

  if (!parsed.orders.length) {
    await env.SYNC_STATE.put(markerKey, marker);
    return summary;
  }

  const { dealIdByKey, created, updated } = await upsertOrders(
    token.hubspot,
    parsed.orders,
    signal,
    summary.errors,
  );
  summary.created = created;
  summary.updated = updated;

  const companies = await resolveCompanies(token.hubspot, parsed.orders, signal);
  const pairs: { fromId: string; toId: string }[] = [];
  for (const o of parsed.orders) {
    const dealId = dealIdByKey.get(o.orderKey);
    const companyId = o.accountNumber ? companies.get(o.accountNumber) : null;
    if (dealId && companyId) {
      pairs.push({ fromId: companyId, toId: dealId });
      summary.companyMatched++;
    } else if (dealId) {
      summary.companyMisses.push({
        agencyKey: o.agencyKey,
        accountNumber: o.accountNumber,
        dealname: showroomDealProperties(o).dealname!,
        orderKey: o.orderKey,
      });
      console.warn(
        `[showroom-sync] ${sheet.agencyKey}: no company for account "${o.accountNumber}" (${o.orderKey})`,
      );
    }
  }
  if (pairs.length) {
    await batchAssociate(token.hubspot, PATHS.companyToDeal, COMPANY_TO_DEAL_ASSOC, pairs, signal);
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
            `${s.companyMatched} matched, ${s.companyMisses.length} company misses, ${s.errors.length} errors`,
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
