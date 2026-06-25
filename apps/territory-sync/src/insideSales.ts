/**
 * Inside-Sales (ISR) reconciliation — the sheet-change sweep (Phase 2) and the
 * one-time backfill (Phase 3). Same routine: it walks HubSpot companies, recomputes
 * each one's ISR fields from the synced rep-code mapping via the shared
 * `computeInsideSalesFields`, and writes only the diffs (idempotent — a clean run
 * makes zero writes). A second bounded pass fixes Rep Code object owners via the
 * account join (covers rep codes missing from the sheet, whose agency company's AMT
 * still resolves an ISR). The real-time per-company path lives in the API Worker
 * (`apps/api/src/hubspotPush.ts`); this is the catch-up for quiet/existing accounts.
 */

import { computeInsideSalesFields, INSIDE_SALES_FIELDS, type InsideSalesResolvers } from "@wac/shared";
import type { OwnerResolver } from "./hubspot.js";

const BASE = "https://api.hubapi.com";
const REP_OBJECT = "2-41537429";
const UPDATE_BATCH = 100;

/** Minimal rep-code row needed to build the resolvers (from the parse or the table). */
export interface RepIsrRow {
  repCode: string | null;
  amtRepCode: string | null;
  isr: string | null;
}

/** A row from the "AMT ISR Mapping" tab / `amt_isr_map` table. */
export interface AmtIsrRow {
  amtRepCode: string | null;
  insideSalesPerson: string | null;
}

interface HsRes {
  ok: boolean;
  status: number;
  data: any;
}

async function hs(token: string, method: string, path: string, body?: unknown): Promise<HsRes> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // Retry on rate-limit AND transient 5xx (502/503/504) — long paginated scans
    // occasionally hit a Cloudflare/HubSpot bad-gateway; don't abort the whole run.
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const ra = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, ra > 0 ? ra * 1000 : Math.min(10_000, 500 * 2 ** attempt)));
      continue;
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  }
}

/** Account-number forms a HubSpot record may store (raw / stripped / zero-padded). */
function accountForms(accountNumber: string): string[] {
  const acct = accountNumber.trim();
  if (!acct) return [];
  const forms = new Set<string>([acct]);
  const stripped = acct.replace(/^0+/, "");
  if (stripped) forms.add(stripped);
  if (/^\d+$/.test(stripped)) forms.add(stripped.padStart(10, "0"));
  return [...forms];
}

/**
 * Build the amt->owner and rep_code->owner maps. `amtToOwner` is sourced PRIMARILY
 * from the complete "AMT ISR Mapping" tab (`amtIsr`); the rep-code sheet's
 * amt->isr (majority on conflict) only fills any AMT code the tab omits.
 * `repCodeToOwner` comes from the rep-code sheet (rep_code -> isr).
 */
export function buildInsideSalesResolvers(
  repRows: RepIsrRow[],
  amtIsr: AmtIsrRow[],
  owner: OwnerResolver,
): InsideSalesResolvers {
  const amtToOwner = new Map<string, string>();
  const repCodeToOwner = new Map<string, string>();

  // rep_code -> owner (from the Rep Code RSM ISR Mapping tab)
  for (const r of repRows) {
    const isr = (r.isr ?? "").trim();
    const rc = (r.repCode ?? "").trim().toUpperCase();
    if (isr && rc) {
      const id = owner.resolveOwner(isr);
      if (id) repCodeToOwner.set(rc, id);
    }
  }

  // amt -> owner: PRIMARY source is the complete AMT ISR Mapping tab.
  for (const a of amtIsr) {
    const amt = (a.amtRepCode ?? "").trim();
    const person = (a.insideSalesPerson ?? "").trim();
    if (!amt || !person) continue;
    const id = owner.resolveOwner(person);
    if (id) amtToOwner.set(amt, id);
    else console.warn(`[inside-sales] AMT ${amt}: "${person}" is not a HubSpot owner`);
  }

  // Fallback: rep-sheet amt->isr (majority) for any AMT code the tab didn't cover.
  const amtIsrCounts = new Map<string, Map<string, number>>();
  for (const r of repRows) {
    const isr = (r.isr ?? "").trim();
    const amt = (r.amtRepCode ?? "").trim();
    if (!isr || !amt || amtToOwner.has(amt)) continue;
    const counts = amtIsrCounts.get(amt) ?? new Map<string, number>();
    counts.set(isr, (counts.get(isr) ?? 0) + 1);
    amtIsrCounts.set(amt, counts);
  }
  for (const [amt, counts] of amtIsrCounts) {
    let best = "";
    let bestN = -1;
    for (const [isr, n] of counts) {
      if (n > bestN) {
        best = isr;
        bestN = n;
      }
    }
    const id = owner.resolveOwner(best);
    if (id) amtToOwner.set(amt, id);
  }

  return { amtToOwner, repCodeToOwner };
}

export interface CompanyReconcileResult {
  scanned: number;
  updated: number;
  /** Unresolved AMT/rep codes with how many companies each affects, desc. */
  unresolved: { code: string; companies: number }[];
}

/**
 * Walk every company; recompute its ISR fields; batch-update the ones that differ.
 * Uses the paginated list endpoint (no 10k search cap). `dryRun` counts diffs
 * without writing. The first real run is the one-time backfill; later runs are the
 * sheet-change sweep (idempotent — only changed records are written).
 */
export async function reconcileCompanyInsideSales(opts: {
  token: string;
  resolvers: InsideSalesResolvers;
  dryRun: boolean;
  limit?: number;
}): Promise<CompanyReconcileResult> {
  const { token, resolvers, dryRun, limit } = opts;
  const props = ["inside_sales_rep", "sales_rep_code", ...INSIDE_SALES_FIELDS].join(",");
  const unresolved = new Map<string, number>(); // code -> # companies affected
  let scanned = 0;
  let updated = 0;
  let after: string | undefined;
  const pending: { id: string; properties: Record<string, string> }[] = [];

  const flush = async () => {
    if (!pending.length) return;
    if (!dryRun) {
      for (let i = 0; i < pending.length; i += UPDATE_BATCH) {
        const inputs = pending.slice(i, i + UPDATE_BATCH);
        const res = await hs(token, "POST", "/crm/v3/objects/companies/batch/update", { inputs });
        if (!res.ok) {
          throw new Error(`company batch/update ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
        }
      }
    }
    updated += pending.length;
    pending.length = 0;
  };

  do {
    const qs = `?limit=100&properties=${props}${after ? `&after=${after}` : ""}`;
    const res = await hs(token, "GET", `/crm/v3/objects/companies${qs}`);
    if (!res.ok) throw new Error(`companies list ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    for (const c of res.data?.results ?? []) {
      scanned++;
      const p = c.properties ?? {};
      const isr = computeInsideSalesFields(
        { amtRepCode: p.inside_sales_rep, salesRepCode: p.sales_rep_code },
        resolvers,
      );
      for (const u of isr.unresolved) unresolved.set(u, (unresolved.get(u) ?? 0) + 1);
      const entries = Object.entries(isr.properties);
      if (!entries.length) continue;
      const differs = entries.some(([k, v]) => String(p[k] ?? "") !== v);
      if (differs) pending.push({ id: String(c.id), properties: isr.properties });
      if (pending.length >= UPDATE_BATCH) await flush();
    }
    after = res.data?.paging?.next?.after;
    if (limit && scanned >= limit) break;
  } while (after);
  await flush();

  const unresolvedSorted = [...unresolved.entries()]
    .map(([code, companies]) => ({ code, companies }))
    .sort((a, b) => b.companies - a.companies);
  return { scanned, updated, unresolved: unresolvedSorted };
}

export interface ManagersRollupResult {
  scanned: number;
  updated: number;
}

/**
 * One-time corrective: align `inside_sales_managers` to the rollup of the CALCULATED
 * `inside_sales_manager_1`/`_2` (the rep-code ISRs) — undoing an earlier overwrite
 * and matching what workflow 1745459869 maintains going forward. Sets managers =
 * the distinct set of manager_1/_2 wherever it differs (clearing it when the company
 * has no rep-code managers). Order-insensitive comparison (managers is a checkbox).
 */
export async function reconcileManagersRollup(opts: {
  token: string;
  dryRun: boolean;
  limit?: number;
}): Promise<ManagersRollupResult> {
  const { token, dryRun, limit } = opts;
  const props = "inside_sales_manager_1,inside_sales_manager_2,inside_sales_managers";
  let scanned = 0;
  let updated = 0;
  let after: string | undefined;
  const pending: { id: string; properties: { inside_sales_managers: string } }[] = [];

  const flush = async () => {
    if (!pending.length) return;
    if (!dryRun) {
      for (let i = 0; i < pending.length; i += UPDATE_BATCH) {
        const inputs = pending.slice(i, i + UPDATE_BATCH);
        const res = await hs(token, "POST", "/crm/v3/objects/companies/batch/update", { inputs });
        if (!res.ok) {
          throw new Error(`managers rollup batch/update ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
        }
      }
    }
    updated += pending.length;
    pending.length = 0;
  };

  do {
    const qs = `?limit=100&properties=${props}${after ? `&after=${after}` : ""}`;
    const res = await hs(token, "GET", `/crm/v3/objects/companies${qs}`);
    if (!res.ok) throw new Error(`companies list ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    for (const c of res.data?.results ?? []) {
      scanned++;
      const p = c.properties ?? {};
      const m1 = String(p.inside_sales_manager_1 ?? "").trim();
      const m2 = String(p.inside_sales_manager_2 ?? "").trim();
      const rollup = [...new Set([m1, m2].filter(Boolean))];
      const current = new Set(
        String(p.inside_sales_managers ?? "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const same = current.size === rollup.length && rollup.every((x) => current.has(x));
      if (!same) {
        pending.push({ id: String(c.id), properties: { inside_sales_managers: rollup.join(";") } });
      }
      if (pending.length >= UPDATE_BATCH) await flush();
    }
    after = res.data?.paging?.next?.after;
    if (limit && scanned >= limit) break;
  } while (after);
  await flush();

  return { scanned, updated };
}

export interface RepOwnerReconcileResult {
  scanned: number;
  updated: number;
  /** Rep codes whose ISR came from the agency company's AMT (not the sheet). */
  augmented: number;
}

/**
 * Pass over Rep Code objects that does two jobs at once:
 *  1. Determine each rep code's ISR owner — sheet first (`rep_code`->ISR), else
 *     from its agency company's AMT code (the rep's `account` -> the Company with
 *     that `account_number_` -> its `inside_sales_rep` AMT -> owner). This is the
 *     "copy the ISR from the rep's company to the rep code" step, and it covers
 *     rep codes that aren't in the sheet mapping.
 *  2. AUGMENT `resolvers.repCodeToOwner` in place with those derived owners, so the
 *     company pass can then resolve the no-AMT design/spec accounts serviced by
 *     those previously-unmapped rep codes.
 * Also writes the owner back onto the Rep Code object when it differs (skipped on
 * dry-run). Never wipes an owner on a lookup miss. Run BEFORE the company pass.
 */
export async function reconcileRepCodeOwners(opts: {
  token: string;
  resolvers: InsideSalesResolvers;
  dryRun: boolean;
}): Promise<RepOwnerReconcileResult> {
  const { token, resolvers, dryRun } = opts;
  let scanned = 0;
  let updated = 0;
  let augmented = 0;
  let after: string | undefined;
  const pending: { id: string; properties: { hubspot_owner_id: string } }[] = [];
  const amtByAccount = new Map<string, string>(); // memoize company lookups

  const flush = async () => {
    if (!pending.length) return;
    if (!dryRun) {
      for (let i = 0; i < pending.length; i += UPDATE_BATCH) {
        const inputs = pending.slice(i, i + UPDATE_BATCH);
        const res = await hs(token, "POST", `/crm/v3/objects/${REP_OBJECT}/batch/update`, { inputs });
        if (!res.ok) {
          throw new Error(`rep batch/update ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
        }
      }
    }
    updated += pending.length;
    pending.length = 0;
  };

  const companyAmt = async (account: string): Promise<string> => {
    if (amtByAccount.has(account)) return amtByAccount.get(account)!;
    let amt = "";
    for (const form of accountForms(account)) {
      const res = await hs(
        token,
        "GET",
        `/crm/v3/objects/companies/${encodeURIComponent(form)}?idProperty=account_number_&properties=inside_sales_rep`,
      );
      if (res.ok && res.data?.properties) {
        amt = String(res.data.properties.inside_sales_rep ?? "").trim();
        if (amt) break;
      }
    }
    amtByAccount.set(account, amt);
    return amt;
  };

  do {
    const qs = `?limit=100&properties=rep_code,account,hubspot_owner_id${after ? `&after=${after}` : ""}`;
    const res = await hs(token, "GET", `/crm/v3/objects/${REP_OBJECT}${qs}`);
    if (!res.ok) throw new Error(`rep list ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    for (const rep of res.data?.results ?? []) {
      scanned++;
      const repCode = String(rep.properties?.rep_code ?? "").trim().toUpperCase();
      const account = String(rep.properties?.account ?? "").trim();
      const current = String(rep.properties?.hubspot_owner_id ?? "");

      // ISR owner: sheet first, else the agency company's AMT.
      let desired = repCode ? resolvers.repCodeToOwner.get(repCode) : undefined;
      if (!desired && account) {
        const amt = await companyAmt(account);
        if (amt) {
          const o = resolvers.amtToOwner.get(amt);
          if (o) {
            desired = o;
            augmented++;
          }
        }
      }
      if (!desired) continue;

      // Augment the company resolver so no-AMT accounts on this rep code resolve.
      if (repCode && !resolvers.repCodeToOwner.has(repCode)) resolvers.repCodeToOwner.set(repCode, desired);

      if (current === desired) continue;
      pending.push({ id: String(rep.id), properties: { hubspot_owner_id: desired } });
      if (pending.length >= UPDATE_BATCH) await flush();
    }
    after = res.data?.paging?.next?.after;
  } while (after);
  await flush();

  return { scanned, updated, augmented };
}

export interface DealOwnerReconcileResult {
  scanned: number;
  updated: number;
  /** Closed (won/lost) deals skipped — never re-owned. */
  skippedClosed: number;
  /** Active deals whose rep code (sales_group) didn't resolve to an owner, desc. */
  unresolved: { code: string; deals: number }[];
}

/**
 * Walk every Deal; for ACTIVE deals (HubSpot calculated `hs_is_closed` !== true, i.e.
 * not closed-won/closed-lost), set `hubspot_owner_id` to the owner of the deal's rep
 * code — keyed off `sales_group` (= the deal's Current-labeled rep code) via
 * `resolvers.repCodeToOwner`. Diff-only (a clean run writes nothing) and never wipes
 * an owner when the rep code is unresolved. Uses the paginated list endpoint (no 10k
 * search cap, like the company pass). Run AFTER `reconcileRepCodeOwners` so the
 * resolver is augmented. First run is the one-time backfill; later runs are the
 * sheet-change sweep + self-heal.
 */
export async function reconcileDealOwners(opts: {
  token: string;
  resolvers: InsideSalesResolvers;
  dryRun: boolean;
  limit?: number;
}): Promise<DealOwnerReconcileResult> {
  const { token, resolvers, dryRun, limit } = opts;
  const unresolved = new Map<string, number>(); // rep code -> # active deals affected
  let scanned = 0;
  let updated = 0;
  let skippedClosed = 0;
  let after: string | undefined;
  const pending: { id: string; properties: { hubspot_owner_id: string } }[] = [];

  const flush = async () => {
    if (!pending.length) return;
    if (!dryRun) {
      for (let i = 0; i < pending.length; i += UPDATE_BATCH) {
        const inputs = pending.slice(i, i + UPDATE_BATCH);
        const res = await hs(token, "POST", "/crm/v3/objects/0-3/batch/update", { inputs });
        if (!res.ok) {
          throw new Error(`deal batch/update ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
        }
      }
    }
    updated += pending.length;
    pending.length = 0;
  };

  do {
    const qs = `?limit=100&properties=sales_group,hubspot_owner_id,hs_is_closed${after ? `&after=${after}` : ""}`;
    const res = await hs(token, "GET", `/crm/v3/objects/0-3${qs}`);
    if (!res.ok) throw new Error(`deals list ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    for (const d of res.data?.results ?? []) {
      scanned++;
      const p = d.properties ?? {};
      if (String(p.hs_is_closed ?? "") === "true") {
        skippedClosed++;
        continue; // closed-won / closed-lost — never re-owned
      }
      const repCode = String(p.sales_group ?? "").trim().toUpperCase();
      if (!repCode) continue;
      const desired = resolvers.repCodeToOwner.get(repCode);
      if (!desired) {
        unresolved.set(repCode, (unresolved.get(repCode) ?? 0) + 1);
        continue; // no owner for this rep code — leave the deal owner as-is
      }
      if (String(p.hubspot_owner_id ?? "") === desired) continue;
      pending.push({ id: String(d.id), properties: { hubspot_owner_id: desired } });
      if (pending.length >= UPDATE_BATCH) await flush();
    }
    after = res.data?.paging?.next?.after;
    if (limit && scanned >= limit) break;
  } while (after);
  await flush();

  const unresolvedSorted = [...unresolved.entries()]
    .map(([code, deals]) => ({ code, deals }))
    .sort((a, b) => b.deals - a.deals);
  return { scanned, updated, skippedClosed, unresolved: unresolvedSorted };
}
