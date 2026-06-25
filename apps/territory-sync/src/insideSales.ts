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
    if (res.status === 429 && attempt < 6) {
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
