import * as XLSX from "xlsx";
import { parseSalesPivot, sumThroughMonth, type SalesParseResult } from "@wac/shared";

/**
 * Sales sync — push YTD sales ($) per customer account onto HubSpot Companies.
 *
 * Source: the "WAC Sales" / "Schonbek Sales" workbooks in OneDrive — Excel
 * PivotTables over a Power BI dataset (Sales $ by Customer Account). We download
 * each via Microsoft Graph (the file's sharing URL, app-only, Sites.Read.All —
 * no extra scope needed), read the displayed pivot, and update a per-brand sales
 * property on the matching Company (by account number, padded OR stripped — the
 * SAP account is stored both ways in HubSpot). Daily.
 *
 * NOT order data — this is aggregated sales, so it enriches Companies, not the
 * Orders object. Existing Companies only: no company is created from sales data.
 *
 * Env: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, HUBSPOT_TOKEN,
 *      SALES_WAC_URL, SALES_SCHONBEK_URL (omit a URL to skip that brand).
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const HS = "https://api.hubapi.com";
const BATCH = 100;

interface Brand {
  key: string;
  url: string | undefined;
}
// One company sells exactly one brand (a separate account per brand+location),
// so all brands write the SAME, brand-neutral Company fields — each to its own
// (non-overlapping) accounts.
const BRANDS: Brand[] = [
  { key: "WAC", url: process.env.SALES_WAC_URL },
  { key: "Schonbek", url: process.env.SALES_SCHONBEK_URL },
];
const PROP_YTD = "ytd_sales"; // current year, through the latest month with data
const PROP_PREV = "previous_year_sales"; // full prior year
const PROP_PRIOR_YTD = "prior_ytd_sales"; // prior year, SAME period (through that month)
const PROP_YOY = "ytd_sales_yoy_pct"; // (YTD − prior YTD) / prior YTD × 100

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// ── Microsoft Graph ─────────────────────────────────────────
async function graphToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: env("MS_CLIENT_ID"),
    client_secret: env("MS_CLIENT_SECRET"),
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const r = await fetch(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`, {
    method: "POST",
    body,
  });
  if (!r.ok) throw new Error(`graph token ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

/** Encode a sharing URL into the Graph /shares token (u!<base64url>). */
function shareId(url: string): string {
  return "u!" + Buffer.from(url).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
}

async function downloadSharedFile(token: string, url: string): Promise<Uint8Array> {
  // /driveItem/content 302-redirects to a pre-authed CDN URL; fetch follows it
  // (undici drops the Authorization header on the cross-origin hop).
  const content = await fetch(`${GRAPH}/shares/${shareId(url)}/driveItem/content`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!content.ok) throw new Error(`graph download ${content.status}: ${(await content.text()).slice(0, 200)}`);
  return new Uint8Array(await content.arrayBuffer());
}

function parseWorkbook(bytes: Uint8Array): SalesParseResult {
  const wb = XLSX.read(bytes, { type: "array", dense: true });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) return { accounts: [], years: [], monthsByYear: {} };
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
  return parseSalesPivot(grid);
}

// ── HubSpot ─────────────────────────────────────────────────
async function hs<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HS}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HubSpot ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function ensureProperties(token: string, defs: { name: string; label: string }[]): Promise<void> {
  const existing = await hs<{ results: { name: string }[] }>(token, "/crm/v3/properties/companies");
  const have = new Set(existing.results.map((p) => p.name));
  for (const d of defs) {
    if (have.has(d.name)) continue;
    await hs(token, "/crm/v3/properties/companies", {
      method: "POST",
      body: JSON.stringify({ name: d.name, label: d.label, type: "number", fieldType: "number", groupName: "companyinformation" }),
    });
    console.log(`[sales-sync] created company property ${d.name}`);
  }
}

const strip = (a: string) => a.replace(/^0+/, "") || a;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Resolve account numbers (padded + stripped) to company ids. */
async function resolveCompanies(token: string, accounts: string[]): Promise<Map<string, string>> {
  const candidates = [...new Set(accounts.flatMap((a) => [a, strip(a)]))];
  const byCandidate = new Map<string, string>();
  for (let i = 0; i < candidates.length; i += BATCH) {
    const inputs = candidates.slice(i, i + BATCH).map((id) => ({ id }));
    try {
      const r = await hs<{ results: { id: string; properties: Record<string, string> }[] }>(
        token,
        "/crm/v3/objects/companies/batch/read",
        { method: "POST", body: JSON.stringify({ idProperty: "account_number_", properties: ["account_number_"], inputs }) },
      );
      for (const c of r.results) {
        const k = c.properties["account_number_"];
        if (k) byCandidate.set(k, c.id);
      }
    } catch (e) {
      if (!String(e).includes("207")) console.warn(`[sales-sync] company resolve batch failed: ${String(e).slice(0, 120)}`);
    }
  }
  const map = new Map<string, string>();
  for (const a of accounts) {
    const id = byCandidate.get(a) ?? byCandidate.get(strip(a));
    if (id) map.set(a, id);
  }
  return map;
}

async function updateCompanies(token: string, byId: Map<string, Record<string, number>>): Promise<number> {
  const inputs = [...byId.entries()].map(([id, properties]) => ({ id, properties }));
  let ok = 0;
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const r = await hs<{ results?: unknown[] }>(token, "/crm/v3/objects/companies/batch/update", {
      method: "POST",
      body: JSON.stringify({ inputs: batch }),
    });
    ok += r.results?.length ?? batch.length;
  }
  return ok;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const token = env("HUBSPOT_TOKEN");
  const brands = BRANDS.filter((b) => b.url);
  if (brands.length === 0) throw new Error("no sales file URLs configured (SALES_WAC_URL / SALES_SCHONBEK_URL)");

  const gtoken = await graphToken();
  for (const b of brands) {
    const bytes = await downloadSharedFile(gtoken, b.url!);
    const { accounts, years, monthsByYear } = parseWorkbook(bytes);
    const cur = years[years.length - 1];
    const prev = cur ? String(Number(cur) - 1) : undefined;
    const latestMonth = cur ? Math.max(0, ...(monthsByYear[cur] ?? [])) : 0;
    const hasPrev = !!prev && years.includes(prev) && latestMonth > 0;
    console.log(
      `[sales-sync] ${b.key}: ${bytes.length} bytes, ${accounts.length} accounts, current ${cur ?? "?"} through M${latestMonth}, years [${years.join(", ")}]` +
        (hasPrev ? "" : " — no prior year, YTD only"),
    );
    if (accounts.length === 0 || !cur || latestMonth === 0) {
      console.warn(`[sales-sync] ${b.key}: no account/month data — the file may not have its pivot saved; skipping.`);
      continue;
    }

    // YTD = current year through latest month; Prior YTD = prior year SAME
    // period; Previous Year = full prior year; YoY % = (YTD − Prior YTD)/Prior.
    const metricsByAccount = new Map<string, Record<string, number>>();
    for (const a of accounts) {
      const props: Record<string, number> = {};
      const ytd = sumThroughMonth(a.byYear[cur], latestMonth);
      if (ytd != null) props[PROP_YTD] = round2(ytd);
      if (hasPrev) {
        const priorYtd = sumThroughMonth(a.byYear[prev!], latestMonth);
        const priorFull = sumThroughMonth(a.byYear[prev!], 12);
        if (priorFull != null) props[PROP_PREV] = round2(priorFull);
        if (priorYtd != null) {
          props[PROP_PRIOR_YTD] = round2(priorYtd);
          if (ytd != null && priorYtd !== 0) props[PROP_YOY] = round1(((ytd - priorYtd) / priorYtd) * 100);
        }
      }
      if (Object.keys(props).length) metricsByAccount.set(a.account, props);
    }

    if (dryRun) {
      console.log(`[sales-sync] ${b.key} DRY RUN sample:`, [...metricsByAccount.entries()].slice(0, 3));
      continue;
    }

    const defs = [{ name: PROP_YTD, label: "YTD Sales" }];
    if (hasPrev) {
      defs.push(
        { name: PROP_PREV, label: "Previous Year Sales" },
        { name: PROP_PRIOR_YTD, label: "Prior YTD Sales" },
        { name: PROP_YOY, label: "YTD Sales YoY %" },
      );
    }
    await ensureProperties(token, defs);
    const idByAccount = await resolveCompanies(token, [...metricsByAccount.keys()]);
    const byId = new Map<string, Record<string, number>>();
    for (const [acct, props] of metricsByAccount) {
      const id = idByAccount.get(acct);
      if (id) byId.set(id, props);
    }
    const updated = await updateCompanies(token, byId);
    console.log(
      `[sales-sync] ${b.key}: matched ${idByAccount.size}/${metricsByAccount.size} accounts, updated ${updated} ` +
        `(${defs.map((d) => d.name).join(", ")}).`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
