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

import {
  companyStatusFromRiskCategory,
  computeInsideSalesFields,
  INSIDE_SALES_FIELDS,
  repCodeInactiveFromCompanyStatus,
  repCodeSyncProperties,
  resolveRepCodeSchema,
  type InsideSalesResolvers,
  type RepCodeSchema,
} from "@wac/shared";
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
  const props = ["inside_sales_rep", "sales_rep_code", "risk_category_description", "status", ...INSIDE_SALES_FIELDS].join(
    ",",
  );
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
      const desired: Record<string, string> = { ...isr.properties };
      // Company Status backstop — recompute from risk_category_description, replacing
      // the now-disabled "Set Company Status to Active or Inactive" workflow. The
      // real-time writer sets this on push; this is the daily catch-up/self-heal.
      const status = companyStatusFromRiskCategory(p.risk_category_description);
      if (status !== null) desired.status = status;
      const entries = Object.entries(desired);
      if (!entries.length) continue;
      const differs = entries.some(([k, v]) => String(p[k] ?? "") !== v);
      if (differs) pending.push({ id: String(c.id), properties: desired });
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

// --- Rep Code ← Agency Company sync + "Inactive" label (absorbs "Account # to Rep
// Code Syncing" + the inactive labeling). The real-time path is in the API Worker
// (`apps/api/src/hubspotPush.ts` pushCompany); this is the daily catch-up + initial
// backfill, keyed off each rep code's agency company (matched by account number). ---

/** The directional "Inactive" association label: `create` is the {target}→repcode
 * typeId used for batch create/labels-archive; `inverse` is the repcode→{target}
 * typeId seen when reading from the rep side (for diffing). null = not created in
 * HubSpot yet → labeling is a safe no-op. */
interface InactiveLabel {
  create: number;
  inverse: number | null;
}

async function resolveInactiveLabel(token: string, target: "deals" | "companies"): Promise<InactiveLabel | null> {
  const fwd = await hs(token, "GET", `/crm/v4/associations/${target}/${REP_OBJECT}/labels`);
  const fwdLabel = fwd.ok
    ? (fwd.data?.results ?? []).find((l: any) => String(l.label ?? "").trim().toLowerCase() === "inactive")
    : null;
  if (fwdLabel?.typeId == null) return null;
  const inv = await hs(token, "GET", `/crm/v4/associations/${REP_OBJECT}/${target}/labels`);
  // Pair the inverse typeId (repcode→target "Inactive Rep Code") by label text —
  // names come back null. Falls back to idempotent add/remove if it can't pair.
  const invLabel = inv.ok
    ? (inv.data?.results ?? []).find((l: any) => String(l.label ?? "").trim().toLowerCase().includes("inactive"))
    : null;
  return { create: Number(fwdLabel.typeId), inverse: invLabel?.typeId != null ? Number(invLabel.typeId) : null };
}

/** Read a rep code's associated deal/company ids + present association typeIds. */
async function readRepAssociations(
  token: string,
  repId: string,
  target: "deals" | "companies",
): Promise<{ toId: string; typeIds: number[] }[]> {
  const out: { toId: string; typeIds: number[] }[] = [];
  let after: string | undefined;
  do {
    const qs = `?limit=500${after ? `&after=${after}` : ""}`;
    const res = await hs(token, "GET", `/crm/v4/objects/${REP_OBJECT}/${repId}/associations/${target}${qs}`);
    if (!res.ok) break;
    for (const r of res.data?.results ?? []) {
      const toId = String(r.toObjectId ?? r.to?.id ?? "");
      const typeIds = (r.associationTypes ?? [])
        .map((t: any) => Number(t.typeId))
        .filter((n: number) => !Number.isNaN(n));
      if (toId) out.push({ toId, typeIds });
    }
    after = res.data?.paging?.next?.after;
  } while (after);
  return out;
}

/** Make the "Inactive" label on a rep code's target associations match its state.
 * Diff-only when the inverse typeId is known, else idempotent add-all/remove-all.
 * Additive create + label-only archive preserve other labels (e.g. "Current"). */
async function syncRepInactiveLabel(
  token: string,
  repId: string,
  target: "deals" | "companies",
  inactive: boolean,
  label: InactiveLabel,
  dryRun: boolean,
): Promise<{ added: number; removed: number; failures: number }> {
  const assocs = await readRepAssociations(token, repId, target);
  if (!assocs.length) return { added: 0, removed: 0, failures: 0 };
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const a of assocs) {
    const known = label.inverse != null;
    const has = known && a.typeIds.includes(label.inverse as number);
    if (inactive) {
      if (!known || !has) toAdd.push(a.toId);
    } else if (!known || has) {
      toRemove.push(a.toId);
    }
  }
  let failures = 0;
  const apply = async (op: "create" | "labels/archive", ids: string[]): Promise<void> => {
    if (dryRun) return;
    for (let i = 0; i < ids.length; i += UPDATE_BATCH) {
      const inputs = ids.slice(i, i + UPDATE_BATCH).map((toId) => ({
        from: { id: toId },
        to: { id: repId },
        types: [{ associationCategory: "USER_DEFINED", associationTypeId: label.create }],
      }));
      const res = await hs(token, "POST", `/crm/v4/associations/${target}/${REP_OBJECT}/batch/${op}`, { inputs });
      if (!res.ok) failures++;
    }
  };
  await apply("create", toAdd);
  await apply("labels/archive", toRemove);
  return { added: toAdd.length, removed: toRemove.length, failures };
}

export interface RepCodeSyncReconcileResult {
  scanned: number;
  fieldsUpdated: number;
  inactive: number;
  labelsAdded: number;
  labelsRemoved: number;
  failures: number;
  /** True when the "Inactive" label isn't set up in HubSpot (labeling skipped). */
  labelMissing: boolean;
}

/**
 * Walk every Rep Code; from its agency company (matched by `account` →
 * `account_number_`) sync Agency/City/Brands/Status/State (diff-only — NOT owner,
 * which stays with reconcileRepCodeOwners) and apply/remove the directional
 * "Inactive" label on its Deal/Company associations from the company's Status.
 * Idempotent; first run backfills. `dryRun` counts without writing.
 */
export async function reconcileRepCodeSync(opts: {
  token: string;
  dryRun: boolean;
  limit?: number;
}): Promise<RepCodeSyncReconcileResult> {
  const { token, dryRun, limit } = opts;
  const result: RepCodeSyncReconcileResult = {
    scanned: 0,
    fieldsUpdated: 0,
    inactive: 0,
    labelsAdded: 0,
    labelsRemoved: 0,
    failures: 0,
    labelMissing: false,
  };

  const propsRes = await hs(token, "GET", `/crm/v3/properties/${REP_OBJECT}`);
  const schema: RepCodeSchema | null =
    propsRes.ok && Array.isArray(propsRes.data?.results) ? resolveRepCodeSchema(propsRes.data.results) : null;
  if (!schema) console.warn("[rep-sync] could not load Rep Code property schema; field sync skipped");

  const labels: Record<"deals" | "companies", InactiveLabel | null> = {
    deals: await resolveInactiveLabel(token, "deals"),
    companies: await resolveInactiveLabel(token, "companies"),
  };
  result.labelMissing = !labels.deals && !labels.companies;
  if (result.labelMissing) {
    console.warn("[rep-sync] 'Inactive' association label not found — labeling is a no-op until it's created in HubSpot");
  }

  const companyCache = new Map<string, Record<string, string> | null>();
  const lookupAgency = async (account: string): Promise<Record<string, string> | null> => {
    if (companyCache.has(account)) return companyCache.get(account)!;
    let found: Record<string, string> | null = null;
    for (const form of accountForms(account)) {
      const r = await hs(
        token,
        "GET",
        `/crm/v3/objects/companies/${encodeURIComponent(form)}?idProperty=account_number_&properties=name,city,product_brand,status,state,inside_sales_rep_from_sap`,
      );
      if (r.ok && r.data?.properties) {
        found = r.data.properties;
        break;
      }
    }
    companyCache.set(account, found);
    return found;
  };

  const repProps = [
    "rep_code",
    "account",
    ...(schema ? [schema.agency, schema.city, schema.brands, schema.state, schema.status].filter((x): x is string => !!x) : []),
  ].join(",");

  let after: string | undefined;
  do {
    const qs = `?limit=100&properties=${repProps}${after ? `&after=${after}` : ""}`;
    const page = await hs(token, "GET", `/crm/v3/objects/${REP_OBJECT}${qs}`);
    if (!page.ok) throw new Error(`rep list ${page.status}: ${JSON.stringify(page.data).slice(0, 200)}`);
    for (const rep of page.data?.results ?? []) {
      result.scanned++;
      const account = String(rep.properties?.account ?? "").trim();
      if (!account) continue;
      const company = await lookupAgency(account);
      if (!company) continue;
      const rawStatus = String(company.status ?? "");
      const companyStatus: "true" | "false" | null =
        rawStatus === "false" ? "false" : rawStatus === "true" ? "true" : null;

      // Field sync (no owner — that stays with reconcileRepCodeOwners), diff-only.
      if (schema) {
        const desired = repCodeSyncProperties(
          {
            companyName: company.name,
            city: company.city,
            productBrand: company.product_brand,
            stateAbbr: company.state,
            companyStatus,
          },
          schema,
        );
        const patch: Record<string, string> = {};
        for (const [k, v] of Object.entries(desired)) {
          if (String(rep.properties?.[k] ?? "") !== v) patch[k] = v;
        }
        if (Object.keys(patch).length) {
          if (dryRun) {
            result.fieldsUpdated++;
          } else {
            const pr = await hs(token, "PATCH", `/crm/v3/objects/${REP_OBJECT}/${rep.id}`, { properties: patch });
            if (pr.ok) result.fieldsUpdated++;
            else result.failures++;
          }
        }
      }

      // Inactive label.
      const inactive = repCodeInactiveFromCompanyStatus(companyStatus);
      if (inactive !== null) {
        if (inactive) result.inactive++;
        for (const target of ["deals", "companies"] as const) {
          const label = labels[target];
          if (!label) continue;
          const r = await syncRepInactiveLabel(token, String(rep.id), target, inactive, label, dryRun);
          result.labelsAdded += r.added;
          result.labelsRemoved += r.removed;
          result.failures += r.failures;
        }
      }
    }
    after = page.data?.paging?.next?.after;
    if (limit && result.scanned >= limit) break;
  } while (after);

  return result;
}
