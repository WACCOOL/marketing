import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildRepCodeCreateProperties,
  buildRepCodeTaskContent,
  normalizeRepCodeForCreate,
  parseRepCodes,
} from "@wac/shared";
import { buildOwnerResolver } from "./hubspot.js";
import {
  buildInsideSalesResolvers,
  hs,
  readRepAssociations,
  REP_OBJECT,
  type AmtIsrRow,
  type RepIsrRow,
} from "./insideSales.js";

/**
 * One-time backfill for the missing-Rep-Code auto-create feature (hubspotPush.ts):
 * scan EVERY company (`sales_rep_code`) and deal (`sales_group`), and for each
 * referenced rep code
 *   1. CREATE the Rep Code record when none exists (owner: territory-sheet
 *      rep_code -> ISR map, falling back to a referencing company's
 *      `inside_sales_rep_from_sap`), and
 *   2. ASSOCIATE every referencing company/deal that has NO association to it —
 *      pre-existing codes included (the real-time path leaves those to the
 *      HubSpot workflows, but historic records may have missed their trigger).
 * Deals get the unlabeled base type PLUS the "Current" label sent together —
 * creating with only the labeled type returns 201 but attaches nothing
 * (verified live 2026-07-02). A record already associated under ANY label
 * (e.g. "Previous") is left alone.
 * One review TASK per CREATED code. Run `--dry-run` first for the counts.
 */

const BATCH = 100;
const ALERT_OWNER_DEFAULT = "davis.rothenberg@waclighting.com";

export interface RepCodeBackfillResult {
  companiesScanned: number;
  dealsScanned: number;
  repCodesExisting: number;
  codesReferenced: number;
  invalid: { value: string; companies: number; deals: number }[];
  created: { code: string; owner: boolean }[];
  createFailures: string[];
  companyAssocsMissing: number;
  dealAssocsMissing: number;
  companyAssocsCreated: number;
  dealAssocsCreated: number;
  assocFailures: string[];
  tasksCreated: number;
  taskFailures: string[];
  /** code -> missing-association counts, for the dry-run report. */
  gapByCode: { code: string; companies: number; deals: number; exists: boolean }[];
}

interface AssocTypeRef {
  typeId: number;
  category: "HUBSPOT_DEFINED" | "USER_DEFINED";
}

/** The unlabeled base type + (deals) the "Current" label — sent together. */
async function getRepLinkTypes(
  token: string,
  from: "deals" | "companies",
): Promise<AssocTypeRef[] | null> {
  const res = await hs(token, "GET", `/crm/v4/associations/${from}/${REP_OBJECT}/labels`);
  const rows = ((res.ok ? res.data?.results : null) ?? []) as {
    typeId?: number;
    label?: string | null;
    category?: string;
  }[];
  const ref = (t: { typeId?: number; category?: string }): AssocTypeRef => ({
    typeId: Number(t.typeId),
    category: t.category === "HUBSPOT_DEFINED" ? "HUBSPOT_DEFINED" : "USER_DEFINED",
  });
  const unlabeled = rows.find((t) => t.typeId != null && t.label == null);
  const current =
    from === "deals"
      ? rows.find((t) => t.typeId != null && String(t.label ?? "").trim().toLowerCase() === "current")
      : undefined;
  const picked = [unlabeled, current].filter((t) => t != null).map(ref);
  return picked.length ? picked : null;
}

/** Page every Rep Code record into a CODE -> record-id map. */
async function loadRepCodeIds(token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let after: string | undefined;
  do {
    const qs = `?limit=100&properties=rep_code${after ? `&after=${after}` : ""}`;
    const res = await hs(token, "GET", `/crm/v3/objects/${REP_OBJECT}${qs}`);
    if (!res.ok) throw new Error(`rep-code list ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    for (const r of res.data?.results ?? []) {
      const code = String(r.properties?.rep_code ?? "").trim().toUpperCase();
      if (code && !map.has(code)) map.set(code, String(r.id));
    }
    after = res.data?.paging?.next?.after;
  } while (after);
  return map;
}

export async function backfillRepCodes(opts: {
  sb: SupabaseClient;
  token: string;
  dryRun: boolean;
  limit?: number;
  alertOwnerEmail?: string;
}): Promise<RepCodeBackfillResult> {
  const { sb, token, dryRun, limit } = opts;
  const result: RepCodeBackfillResult = {
    companiesScanned: 0,
    dealsScanned: 0,
    repCodesExisting: 0,
    codesReferenced: 0,
    invalid: [],
    created: [],
    createFailures: [],
    companyAssocsMissing: 0,
    dealAssocsMissing: 0,
    companyAssocsCreated: 0,
    dealAssocsCreated: 0,
    assocFailures: [],
    tasksCreated: 0,
    taskFailures: [],
    gapByCode: [],
  };

  // 1. Existing Rep Code universe.
  const repIds = await loadRepCodeIds(token);
  result.repCodesExisting = repIds.size;
  console.log(`[rep-backfill] ${repIds.size} Rep Code records in HubSpot`);

  // 2. Owner resolvers (same sources as the reconcile modes).
  const { data: repData, error: repErr } = await sb.from("rep_codes").select("rep_code, amt_rep_code, isr");
  if (repErr) throw new Error(`rep_codes load failed: ${repErr.message}`);
  const repRows: RepIsrRow[] = (repData ?? []).map((r: any) => ({
    repCode: r.rep_code,
    amtRepCode: r.amt_rep_code,
    isr: r.isr,
  }));
  const { data: amtData, error: amtErr } = await sb.from("amt_isr_map").select("amt_rep_code, inside_sales_person");
  if (amtErr) throw new Error(`amt_isr_map load failed: ${amtErr.message}`);
  const amtRows: AmtIsrRow[] = (amtData ?? []).map((r: any) => ({
    amtRepCode: r.amt_rep_code,
    insideSalesPerson: r.inside_sales_person,
  }));
  const resolvers = buildInsideSalesResolvers(repRows, amtRows, await buildOwnerResolver(token));

  // 3. Scan companies: code -> referencing company ids (+ ISR fallback owner).
  const companiesByCode = new Map<string, string[]>();
  const companyIsrByCode = new Map<string, string>();
  {
    let after: string | undefined;
    do {
      const qs =
        `?limit=100&properties=sales_rep_code,inside_sales_rep_from_sap` + (after ? `&after=${after}` : "");
      const res = await hs(token, "GET", `/crm/v3/objects/companies${qs}`);
      if (!res.ok) throw new Error(`companies list ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
      for (const c of res.data?.results ?? []) {
        result.companiesScanned++;
        const p = c.properties ?? {};
        for (const code of parseRepCodes(p.sales_rep_code)) {
          let list = companiesByCode.get(code);
          if (!list) companiesByCode.set(code, (list = []));
          list.push(String(c.id));
          const isr = String(p.inside_sales_rep_from_sap ?? "").trim();
          if (isr && !companyIsrByCode.has(code)) companyIsrByCode.set(code, isr);
        }
      }
      after = res.data?.paging?.next?.after;
      if (result.companiesScanned % 20_000 < 100) {
        console.log(`[rep-backfill] companies scanned: ${result.companiesScanned}`);
      }
      if (limit && result.companiesScanned >= limit) break;
    } while (after);
  }
  console.log(
    `[rep-backfill] ${result.companiesScanned} companies scanned; ${companiesByCode.size} distinct codes referenced`,
  );

  // 4. Scan deals: code -> referencing deal ids.
  const dealsByCode = new Map<string, string[]>();
  {
    let after: string | undefined;
    do {
      const qs = `?limit=100&properties=sales_group${after ? `&after=${after}` : ""}`;
      const res = await hs(token, "GET", `/crm/v3/objects/0-3${qs}`);
      if (!res.ok) throw new Error(`deals list ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
      for (const d of res.data?.results ?? []) {
        result.dealsScanned++;
        // Multi-code values ("CRL, CRX", "TLA TLX") occur on deals too — split
        // exactly like the company scan and the Worker's real-time path do.
        for (const code of parseRepCodes(d.properties?.sales_group)) {
          let list = dealsByCode.get(code);
          if (!list) dealsByCode.set(code, (list = []));
          list.push(String(d.id));
        }
      }
      after = res.data?.paging?.next?.after;
      if (result.dealsScanned % 20_000 < 100) {
        console.log(`[rep-backfill] deals scanned: ${result.dealsScanned}`);
      }
      if (limit && result.dealsScanned >= limit) break;
    } while (after);
  }
  console.log(
    `[rep-backfill] ${result.dealsScanned} deals scanned; ${dealsByCode.size} distinct codes referenced`,
  );

  // 5. Partition referenced codes: existing / creatable / invalid.
  const referenced = new Set<string>([...companiesByCode.keys(), ...dealsByCode.keys()]);
  result.codesReferenced = referenced.size;
  const toCreate: { code: string; owner: string | undefined }[] = [];
  for (const code of [...referenced].sort()) {
    if (repIds.has(code)) continue;
    const normalized = normalizeRepCodeForCreate(code);
    if (!normalized) {
      result.invalid.push({
        value: code,
        companies: companiesByCode.get(code)?.length ?? 0,
        deals: dealsByCode.get(code)?.length ?? 0,
      });
      continue;
    }
    const owner = resolvers.repCodeToOwner.get(normalized) ?? companyIsrByCode.get(normalized);
    toCreate.push({ code: normalized, owner });
  }

  // 6. Create the missing records (batch upsert by rep_code — idempotent).
  if (!dryRun && toCreate.length) {
    for (let i = 0; i < toCreate.length; i += BATCH) {
      const slice = toCreate.slice(i, i + BATCH);
      const res = await hs(token, "POST", `/crm/v3/objects/${REP_OBJECT}/batch/upsert`, {
        inputs: slice.map((c) => ({
          idProperty: "rep_code",
          id: c.code,
          properties: buildRepCodeCreateProperties(c.code, c.owner),
        })),
      });
      if (!res.ok) {
        result.createFailures.push(`rep-code upsert batch failed (${res.status})`);
        continue;
      }
      for (const r of res.data?.results ?? []) {
        const code = String(r.properties?.rep_code ?? "").trim().toUpperCase();
        if (code && r.id) repIds.set(code, String(r.id));
      }
    }
    for (const c of toCreate) {
      if (repIds.has(c.code)) result.created.push({ code: c.code, owner: Boolean(c.owner) });
      else result.createFailures.push(`rep code "${c.code}" missing from upsert response`);
    }
  } else if (dryRun) {
    result.created = toCreate.map((c) => ({ code: c.code, owner: Boolean(c.owner) }));
  }

  // 7. Association diff for every referenced code that (now) has a record —
  //    pre-existing codes included. ANY existing association (any label) counts.
  const companyTypes = await getRepLinkTypes(token, "companies");
  const dealTypes = await getRepLinkTypes(token, "deals");
  if (!companyTypes) result.assocFailures.push("no company<->rep-code association types resolvable");
  if (!dealTypes) result.assocFailures.push("no deal<->rep-code association types resolvable");

  const companyPairs: { fromId: string; repId: string }[] = [];
  const dealPairs: { fromId: string; repId: string }[] = [];
  for (const code of [...referenced].sort()) {
    const repId = repIds.get(code);
    if (!repId) continue; // invalid or create-failed — already reported
    const wantCompanies = companiesByCode.get(code) ?? [];
    const wantDeals = dealsByCode.get(code) ?? [];
    let missCompanies = 0;
    let missDeals = 0;
    if (wantCompanies.length && companyTypes) {
      const have = new Set((await readRepAssociations(token, repId, "companies")).map((a) => a.toId));
      for (const id of wantCompanies) {
        if (!have.has(id)) {
          companyPairs.push({ fromId: id, repId });
          missCompanies++;
        }
      }
    }
    if (wantDeals.length && dealTypes) {
      const have = new Set((await readRepAssociations(token, repId, "deals")).map((a) => a.toId));
      for (const id of wantDeals) {
        if (!have.has(id)) {
          dealPairs.push({ fromId: id, repId });
          missDeals++;
        }
      }
    }
    if (missCompanies || missDeals) {
      result.gapByCode.push({
        code,
        companies: missCompanies,
        deals: missDeals,
        exists: !result.created.some((c) => c.code === code),
      });
    }
  }
  result.companyAssocsMissing = companyPairs.length;
  result.dealAssocsMissing = dealPairs.length;

  // 8. Create the missing associations (base [+ Current] together; verify counts —
  //    a 201 with fewer results than inputs is a silent no-op, seen live).
  const createAssocs = async (
    from: "companies" | "deals",
    types: AssocTypeRef[],
    pairs: { fromId: string; repId: string }[],
  ): Promise<number> => {
    let created = 0;
    for (let i = 0; i < pairs.length; i += BATCH) {
      const slice = pairs.slice(i, i + BATCH);
      const res = await hs(token, "POST", `/crm/v4/associations/${from}/${REP_OBJECT}/batch/create`, {
        inputs: slice.map((p) => ({
          types: types.map((t) => ({ associationCategory: t.category, associationTypeId: t.typeId })),
          from: { id: p.fromId },
          to: { id: p.repId },
        })),
      });
      const n = ((res.ok ? res.data?.results : null) ?? []).length;
      created += n;
      if (!res.ok || n < slice.length) {
        result.assocFailures.push(
          `${from} association batch: expected ${slice.length}, created ${n} (status ${res.status})`,
        );
      }
    }
    return created;
  };
  if (!dryRun) {
    if (companyTypes) result.companyAssocsCreated = await createAssocs("companies", companyTypes, companyPairs);
    if (dealTypes) result.dealAssocsCreated = await createAssocs("deals", dealTypes, dealPairs);
  }

  // 9. One review task per CREATED code.
  if (!dryRun && result.created.length) {
    let ownerId: string | null = null;
    const email = (opts.alertOwnerEmail || ALERT_OWNER_DEFAULT).trim();
    const or = await hs(token, "GET", `/crm/v3/owners/?email=${encodeURIComponent(email)}&limit=1`);
    const oid = or.ok ? or.data?.results?.[0]?.id : null;
    ownerId = oid != null ? String(oid) : null;
    if (!ownerId) result.taskFailures.push(`owner lookup for ${email} failed — tasks created unassigned`);

    for (const c of result.created) {
      const repId = repIds.get(c.code);
      if (!repId) continue;
      const nCompanies = companiesByCode.get(c.code)?.length ?? 0;
      const nDeals = dealsByCode.get(c.code)?.length ?? 0;
      const { subject, body } = buildRepCodeTaskContent({
        repCode: c.code,
        sourceType: "backfill",
        sourceLabel: `${nCompanies} compan${nCompanies === 1 ? "y" : "ies"} and ${nDeals} deal${nDeals === 1 ? "" : "s"}`,
        ownerSet: c.owner,
      });
      const tr = await hs(token, "POST", "/crm/v3/objects/tasks", {
        properties: {
          hs_task_subject: subject,
          hs_task_body: body,
          hs_timestamp: String(Date.now()),
          hs_task_status: "NOT_STARTED",
          hs_task_type: "TODO",
          ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
        },
      });
      const taskId = tr.ok && tr.data?.id != null ? String(tr.data.id) : "";
      if (!taskId) {
        result.taskFailures.push(`task for "${c.code}" failed (${tr.status})`);
        continue;
      }
      result.tasksCreated++;
      const ar = await hs(token, "PUT", `/crm/v4/objects/tasks/${taskId}/associations/default/${REP_OBJECT}/${repId}`);
      if (!ar.ok) result.taskFailures.push(`task ${taskId} -> rep "${c.code}" association failed (${ar.status})`);
    }
  }

  return result;
}
