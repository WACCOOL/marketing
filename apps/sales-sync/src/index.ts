import * as XLSX from "xlsx";
import { computeSalesMetrics, lastFullMonth, parseSalesPivot, parseYtdReport } from "@wac/shared";
import { BATCH, ensureProperties, hs, updateCompanies } from "./hubspot.js";
import { runDealRollups } from "./dealRollups.js";

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
 * Sources, in precedence order:
 *   1. SALES_YTD_URL — the "YTD" report: EXACT same-period numbers per account
 *      (Sales / Sales PYTD per year), day-accurate. Preferred when present.
 *   2. SALES_WAC_URL / SALES_SCHONBEK_URL — month-bucket pivots, used only for
 *      accounts the YTD report doesn't cover. Growth here is measured on
 *      complete months only (the bucket containing the refresh date is partial).
 *
 * Freshness: these workbooks only change when their pivots are refreshed and
 * saved (see README.md for the scheduled Power Automate refresh). Each file's
 * OneDrive lastModifiedDateTime is checked; a file older than SALES_STALE_HOURS
 * (default 30) is skipped and the run exits non-zero so the failure is visible.
 *
 * Env: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, HUBSPOT_TOKEN,
 *      SALES_YTD_URL, SALES_WAC_URL, SALES_SCHONBEK_URL (omit to skip),
 *      SALES_STALE_HOURS (optional).
 *
 * --inspect dumps SALES_YTD_URL's sheet structure (no HubSpot writes).
 *
 * --deal-rollups runs a second, independent mode (HUBSPOT_TOKEN only — no
 * Graph/workbook env): closed-won deal value rolled up onto Companies as
 * YTD Won Deals / YTD Prior Year Deals / Prior Year Deals. See dealRollups.ts.
 * Flags: --dry-run, --limit=N (deals sampled).
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

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

interface DriveItemMeta {
  name?: string;
  lastModifiedDateTime?: string;
}

async function driveItemMeta(token: string, url: string): Promise<DriveItemMeta> {
  const r = await fetch(`${GRAPH}/shares/${shareId(url)}/driveItem?$select=name,lastModifiedDateTime`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`graph metadata ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as DriveItemMeta;
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

function readGrid(bytes: Uint8Array): unknown[][] {
  const wb = XLSX.read(bytes, { type: "array", dense: true });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  return sheet ? XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false }) : [];
}

/** The data is only as fresh as the workbook's last refresh+save — date it in ET. */
function etYearMonth(d: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month") };
}

// ── HubSpot ─────────────────────────────────────────────────
// hs / ensureProperties / updateCompanies live in hubspot.ts (shared with the
// --deal-rollups mode).

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

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const token = env("HUBSPOT_TOKEN");

  // One-off structure dump for a new source workbook (no HubSpot writes):
  // sheet names + leading rows so a parser can be written against the real shape.
  if (process.argv.includes("--inspect")) {
    const url = env("SALES_YTD_URL");
    const gtoken = await graphToken();
    const meta = await driveItemMeta(gtoken, url);
    console.log(`[inspect] ${meta.name ?? "?"} lastModified ${meta.lastModifiedDateTime ?? "?"}`);
    const wb = XLSX.read(await downloadSharedFile(gtoken, url), { type: "array", dense: true });
    for (const name of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, blankrows: false });
      console.log(`[inspect] sheet "${name}": ${grid.length} rows`);
      for (const row of grid.slice(0, 15)) console.log("[inspect]", JSON.stringify(row));
    }
    return;
  }

  if (process.argv.includes("--deal-rollups")) {
    const limitArg = process.argv.find((a) => a.startsWith("--limit="));
    const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
    await runDealRollups({ token, dryRun, limit: Number.isFinite(limit) && limit! > 0 ? limit : undefined });
    return;
  }

  const ytdUrl = process.env.SALES_YTD_URL;
  const brands = BRANDS.filter((b) => b.url);
  if (!ytdUrl && brands.length === 0)
    throw new Error("no sales file URLs configured (SALES_YTD_URL / SALES_WAC_URL / SALES_SCHONBEK_URL)");

  const staleHours = Number(process.env.SALES_STALE_HOURS || 30);
  const gtoken = await graphToken();
  const staleFiles: string[] = [];

  /** Download a source workbook — unless its last OneDrive save is too old to trust. */
  async function fetchFresh(label: string, url: string): Promise<{ grid: unknown[][]; asOf: Date } | null> {
    let meta: DriveItemMeta = {};
    try {
      meta = await driveItemMeta(gtoken, url);
    } catch (e) {
      console.warn(`[sales-sync] ${label}: metadata fetch failed (${String(e).slice(0, 120)}) — proceeding without a freshness check`);
    }
    const modified = meta.lastModifiedDateTime ? new Date(meta.lastModifiedDateTime) : undefined;
    const ageH = modified ? (Date.now() - modified.getTime()) / 3_600_000 : undefined;
    console.log(
      `[sales-sync] ${label} (${meta.name ?? "?"}): last refreshed ${meta.lastModifiedDateTime ?? "unknown"}` +
        (ageH != null ? ` (${ageH.toFixed(1)}h ago)` : ""),
    );
    if (ageH != null && ageH > staleHours) {
      console.error(
        `[sales-sync] ${label}: STALE — last refreshed ${ageH.toFixed(1)}h ago (limit ${staleHours}h). ` +
          `Skipping so stale numbers aren't pushed as fresh; check the scheduled refresh (apps/sales-sync/README.md).`,
      );
      staleFiles.push(label);
      return null;
    }
    return { grid: readGrid(await downloadSharedFile(gtoken, url)), asOf: modified ?? new Date() };
  }

  /** Ensure props exist, resolve accounts to companies, batch-update. */
  async function push(label: string, metricsByAccount: Map<string, Record<string, number>>, defs: { name: string; label: string }[]): Promise<void> {
    if (dryRun) {
      console.log(`[sales-sync] ${label} DRY RUN sample:`, [...metricsByAccount.entries()].slice(0, 3));
      return;
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
      `[sales-sync] ${label}: matched ${idByAccount.size}/${metricsByAccount.size} accounts, updated ${updated} ` +
        `(${defs.map((d) => d.name).join(", ")}).`,
    );
  }

  const ALL_DEFS = [
    { name: PROP_YTD, label: "YTD Sales" },
    { name: PROP_PREV, label: "Previous Year Sales" },
    { name: PROP_PRIOR_YTD, label: "Prior YTD Sales" },
    { name: PROP_YOY, label: "YTD Sales YoY %" },
  ];

  // 1) YTD report — exact same-period numbers; its accounts win over the pivots.
  const covered = new Set<string>();
  if (ytdUrl) {
    const f = await fetchFresh("YTD report", ytdUrl);
    if (f) {
      const { accounts, year, priorYear } = parseYtdReport(f.grid);
      console.log(`[sales-sync] YTD report: ${accounts.length} accounts, ${year ?? "?"} vs prior ${priorYear ?? "—"} (exact same-period numbers)`);
      if (accounts.length === 0 || !year) {
        console.warn("[sales-sync] YTD report: no account data — the pivot may not be saved; falling back to month pivots only.");
      } else {
        const metricsByAccount = new Map<string, Record<string, number>>();
        for (const a of accounts) {
          const props: Record<string, number> = { [PROP_YTD]: round2(a.ytd) };
          if (a.priorFull != null) props[PROP_PREV] = round2(a.priorFull);
          if (a.priorYtd != null) {
            props[PROP_PRIOR_YTD] = round2(a.priorYtd);
            if (a.priorYtd !== 0) props[PROP_YOY] = round1(((a.ytd - a.priorYtd) / a.priorYtd) * 100);
          }
          metricsByAccount.set(a.account, props);
          covered.add(a.account);
          covered.add(strip(a.account));
        }
        await push("YTD report", metricsByAccount, ALL_DEFS);
      }
    }
  }

  // 2) Month pivots — remaining accounts only. True YTD includes the latest
  // (possibly partial) bucket, but Prior YTD + YoY compare complete months
  // only, so a 3-day July never gets measured against a full prior July.
  for (const b of brands) {
    const f = await fetchFresh(b.key, b.url!);
    if (!f) continue;
    const { accounts, years, monthsByYear } = parseSalesPivot(f.grid);
    const cur = years[years.length - 1];
    const prev = cur ? String(Number(cur) - 1) : undefined;
    const latestMonth = cur ? Math.max(0, ...(monthsByYear[cur] ?? [])) : 0;
    const hasPrev = !!prev && years.includes(prev) && latestMonth > 0;
    const fullMonths = cur ? lastFullMonth(latestMonth, cur, etYearMonth(f.asOf)) : 0;
    console.log(
      `[sales-sync] ${b.key}: ${accounts.length} accounts, current ${cur ?? "?"} through M${latestMonth} ` +
        `(comparing through M${fullMonths}), years [${years.join(", ")}]` +
        (hasPrev ? "" : " — no prior year, YTD only"),
    );
    if (accounts.length === 0 || !cur || latestMonth === 0) {
      console.warn(`[sales-sync] ${b.key}: no account/month data — the file may not have its pivot saved; skipping.`);
      continue;
    }

    const metricsByAccount = new Map<string, Record<string, number>>();
    let alreadyCovered = 0;
    for (const a of accounts) {
      if (covered.has(a.account) || covered.has(strip(a.account))) {
        alreadyCovered++;
        continue;
      }
      const m = computeSalesMetrics(a.byYear, cur, hasPrev ? prev : undefined, latestMonth, fullMonths);
      const props: Record<string, number> = {};
      if (m.ytd != null) props[PROP_YTD] = m.ytd;
      if (m.priorFull != null) props[PROP_PREV] = m.priorFull;
      if (m.priorYtd != null) props[PROP_PRIOR_YTD] = m.priorYtd;
      if (m.yoyPct != null) props[PROP_YOY] = m.yoyPct;
      if (Object.keys(props).length) metricsByAccount.set(a.account, props);
    }
    if (alreadyCovered) console.log(`[sales-sync] ${b.key}: ${alreadyCovered} accounts already covered by the YTD report — skipped.`);
    if (metricsByAccount.size === 0) {
      console.log(`[sales-sync] ${b.key}: nothing left to update.`);
      continue;
    }
    await push(b.key, metricsByAccount, hasPrev ? ALL_DEFS : ALL_DEFS.slice(0, 1));
  }

  if (staleFiles.length) {
    console.error(
      `[sales-sync] FAILED: stale source file(s): ${staleFiles.join(", ")}. ` +
        `Refresh the pivot(s) in Excel (or fix the scheduled refresh) and re-run.`,
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
