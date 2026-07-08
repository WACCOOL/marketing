import type { SupabaseClient } from "@supabase/supabase-js";
import { turnoverLineKey } from "@wac/shared";

/**
 * Turnover → HubSpot push.
 *
 * Orders: one per billing document (invoice), upserted by the unique
 * `billing_document` property into the "Invoiced Orders" pipeline (the renamed
 * idle pipeline — discovered by label, env-overridable). Owner + channel come
 * from the PRIMARY rep's Rep Code record (the rep on qty-carrying lines;
 * split-credit secondary reps get a "Secondary Rep" association label instead).
 * hs_total_price sums Discounted Sales over qty-carrying lines only, so a
 * secondary row that repeats the primary's value can never double-count.
 *
 * Line Items: one per (billing document, material, rep), upserted by the unique
 * `bd_line_key` property. Reuses the shared material__/quantity/price props so
 * invoiced and open line items share HubSpot columns.
 *
 * Associations: Line→Order (513), Order→Company by Sold-to account (934),
 * Order→Rep Code labeled Primary/Secondary, Order→Deal by Quotation Ref →
 * sap_quote_number (type discovered/created at runtime). Sold-to accounts with
 * no HubSpot company get one CREATED (bare account number, name when known) so
 * no order is left unassociated — per Davis 2026-07-08.
 *
 * Also here: the customer parent-child push (native company parent/child
 * associations from company_parents staging; missing companies are CREATED
 * the same way per Davis 2026-07-07) and --verify-coverage reporting.
 *
 * Machinery (hs/coerce/batchUpsert/batchAssociate/resolveIds) follows
 * apps/open-orders-sync/src/hubspot.ts.
 */

const HS = "https://api.hubapi.com";
const REP_CODE_OBJECT = "2-41537429";
const ORDER_TO_LINE_ITEM_TYPE = 513; // HUBSPOT_DEFINED orders -> line_items
const ORDER_TO_COMPANY_TYPE = 934; // HUBSPOT_DEFINED orders -> companies
const BATCH = 100;
const GROUP = "invoiced_orders";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HubSpot fetch with retry — transient 5xx/429 (and network drops) are
 * inevitable across the tens of thousands of calls a backfill makes, and one
 * must not kill a multi-hour run. Exponential backoff, honoring Retry-After. */
async function hs<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${HS}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          ...(init?.headers ?? {}),
        },
      });
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw e;
      console.warn(`[turnover-sync] ${path} network error (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${String(e).slice(0, 120)}`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        const after = Number(res.headers.get("retry-after"));
        const wait = after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1);
        console.warn(`[turnover-sync] ${path} -> ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw new Error(`HubSpot ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }
}

export interface TurnoverDbRow {
  billing_document: string;
  material: string;
  rep_code: string;
  sold_to: string | null;
  billing_date: string | null;
  currency: string | null;
  quotation_ref: string | null;
  brand: string;
  quantity: number | null;
  ytd_total: number | null;
  discounted_sales: number | null;
  /** Present in the table but not fetched by the push (unused, heavy). */
  raw_json?: Record<string, unknown>;
}

interface CompanyParentDbRow {
  account: string;
  customer_name: string | null;
  parent_account: string | null;
  parent_name: string | null;
}

// --- generic helpers ---------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Batch-read object ids by a unique idProperty. 207 (nothing matched) is fine. */
async function resolveIds(token: string, obj: string, idProperty: string, values: string[], extraProps: string[] = []): Promise<Map<string, Record<string, string> & { __id: string }>> {
  const map = new Map<string, Record<string, string> & { __id: string }>();
  const uniq = [...new Set(values.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += BATCH) {
    const inputs = uniq.slice(i, i + BATCH).map((v) => ({ id: v }));
    try {
      const res = await hs<{ results: { id: string; properties: Record<string, string> }[] }>(
        token,
        `/crm/v3/objects/${obj}/batch/read`,
        { method: "POST", body: JSON.stringify({ idProperty, properties: [idProperty, ...extraProps], inputs }) },
      );
      for (const r of res.results) {
        const key = r.properties[idProperty];
        if (key) map.set(key, { ...r.properties, __id: r.id });
      }
    } catch (e) {
      if (!String(e).includes("207")) console.warn(`[turnover-sync] ${obj} id resolve batch failed: ${String(e).slice(0, 120)}`);
    }
  }
  return map;
}

async function batchUpsert(
  token: string,
  obj: "orders" | "line_items",
  inputs: { idProperty: string; id: string; properties: Record<string, string | number> }[],
): Promise<Map<string, string>> {
  const idByKey = new Map<string, string>();
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const keyProp = batch[0]!.idProperty;
    const res = await hs<{ results?: { id: string; properties: Record<string, string> }[] }>(
      token,
      `/crm/v3/objects/${obj}/batch/upsert`,
      { method: "POST", body: JSON.stringify({ inputs: batch }) },
    );
    for (const r of res.results ?? []) {
      const k = r.properties[keyProp];
      if (k) idByKey.set(k, r.id);
    }
    if ((i / BATCH) % 10 === 0) console.log(`[turnover-sync] upserted ${obj} ~${Math.min(i + BATCH, inputs.length)}/${inputs.length}`);
  }
  return idByKey;
}

interface AssocType {
  typeId: number;
  category: "HUBSPOT_DEFINED" | "USER_DEFINED";
}

async function batchAssociate(token: string, fromObj: string, toObj: string, types: AssocType[], pairs: { from: string; to: string }[]): Promise<void> {
  if (types.length === 0 || pairs.length === 0) return;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const inputs = pairs.slice(i, i + BATCH).map((p) => ({
      from: { id: p.from },
      to: { id: p.to },
      types: types.map((t) => ({ associationCategory: t.category, associationTypeId: t.typeId })),
    }));
    try {
      await hs(token, `/crm/v4/associations/${fromObj}/${toObj}/batch/create`, { method: "POST", body: JSON.stringify({ inputs }) });
    } catch (e) {
      console.warn(`[turnover-sync] associate ${fromObj}->${toObj} batch failed: ${String(e).slice(0, 160)}`);
    }
  }
}

interface HsLabel {
  typeId: number;
  label: string | null;
  category: "HUBSPOT_DEFINED" | "USER_DEFINED";
}

async function assocLabels(token: string, fromObj: string, toObj: string): Promise<HsLabel[]> {
  const res = await hs<{ results: HsLabel[] }>(token, `/crm/v4/associations/${fromObj}/${toObj}/labels`);
  return res.results ?? [];
}

/** Find a label by (case-insensitive) name, creating it when absent. */
async function ensureLabel(token: string, fromObj: string, toObj: string, label: string, name: string): Promise<AssocType | null> {
  try {
    const existing = await assocLabels(token, fromObj, toObj);
    const hit = existing.find((l) => (l.label ?? "").toLowerCase() === label.toLowerCase());
    if (hit) return { typeId: hit.typeId, category: hit.category };
    const created = await hs<{ results: { typeId: number; category?: HsLabel["category"] }[] }>(
      token,
      `/crm/v4/associations/${fromObj}/${toObj}/labels`,
      { method: "POST", body: JSON.stringify({ label, name }) },
    );
    const t = created.results?.[0];
    if (t) {
      console.log(`[turnover-sync] created ${fromObj}↔${toObj} association label "${label}" (type ${t.typeId})`);
      return { typeId: t.typeId, category: t.category ?? "USER_DEFINED" };
    }
  } catch (e) {
    console.warn(`[turnover-sync] ${fromObj}↔${toObj} label "${label}" unavailable: ${String(e).slice(0, 160)}`);
  }
  return null;
}

// --- account matching (companies store SAP accounts padded OR stripped) -------

const stripZeros = (a: string) => a.replace(/^0+/, "") || a;
const padded = (a: string) => (/^\d+$/.test(a) ? a.padStart(10, "0") : a);
const accountForms = (a: string) => [...new Set([a, stripZeros(a), padded(a)])];

async function resolveCompanies(token: string, accounts: string[]): Promise<Map<string, { id: string; name?: string }>> {
  const candidates = [...new Set(accounts.flatMap(accountForms))];
  const byForm = await resolveIds(token, "companies", "account_number_", candidates, ["name"]);
  const map = new Map<string, { id: string; name?: string }>();
  for (const a of accounts) {
    for (const form of accountForms(a)) {
      const hit = byForm.get(form);
      if (hit) {
        map.set(a, { id: hit.__id, name: hit["name"] });
        break;
      }
    }
  }
  return map;
}

/** Create companies for SAP accounts missing in HubSpot — a bare company with
 * just the account number beats an unassociated order (per Davis 2026-07-08);
 * a name is set when one is known. Returns account → created company id. */
async function createCompanies(token: string, accounts: string[], nameByAccount: Map<string, string>): Promise<Map<string, string>> {
  const createdByAccount = new Map<string, string>();
  const uniq = [...new Set(accounts.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += BATCH) {
    const inputs = uniq.slice(i, i + BATCH).map((a) => {
      const name = nameByAccount.get(a);
      return { properties: { account_number_: a, ...(name ? { name } : {}) } };
    });
    try {
      const res = await hs<{ results: { id: string; properties: Record<string, string> }[] }>(
        token,
        "/crm/v3/objects/companies/batch/create",
        { method: "POST", body: JSON.stringify({ inputs }) },
      );
      for (const r of res.results) {
        const acct = r.properties["account_number_"];
        if (acct) createdByAccount.set(acct, r.id);
      }
    } catch (e) {
      console.warn(`[turnover-sync] company create batch failed: ${String(e).slice(0, 160)}`);
    }
  }
  return createdByAccount;
}

/** account → customer display name, from the staged CUSTOMERS file. */
async function loadCustomerNames(sb: SupabaseClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("company_parents").select("account, customer_name").order("account").range(from, from + 999);
    if (error) {
      console.warn(`[turnover-sync] customer names load failed (continuing): ${error.message}`);
      return map;
    }
    const page = (data ?? []) as { account: string; customer_name: string | null }[];
    for (const r of page) if (r.customer_name) map.set(r.account, r.customer_name);
    if (page.length < 1000) break;
  }
  return map;
}

/** Rep Code `region` is an enumeration — map internal values to display labels
 * so the order's sales_territory reads like the UI. */
async function regionLabels(token: string): Promise<Map<string, string>> {
  try {
    const res = await hs<{ options?: { label: string; value: string }[] }>(token, `/crm/v3/properties/${REP_CODE_OBJECT}/region`);
    return new Map((res.options ?? []).map((o) => [o.value, o.label]));
  } catch (e) {
    console.warn(`[turnover-sync] region options load failed (continuing): ${String(e).slice(0, 120)}`);
    return new Map();
  }
}

// --- pipeline ------------------------------------------------------------------

async function resolvePipeline(token: string): Promise<{ pipelineId: string; stageId: string }> {
  const envPipeline = process.env.TURNOVER_PIPELINE_ID;
  const envStage = process.env.TURNOVER_STAGE_ID;
  if (envPipeline && envStage) return { pipelineId: envPipeline, stageId: envStage };

  const res = await hs<{ results: { id: string; label: string; stages: { id: string; label: string }[] }[] }>(
    token,
    "/crm/v3/pipelines/orders",
  );
  const pipeline = res.results.find((p) => p.label.toLowerCase().includes("invoiced"));
  if (!pipeline) {
    throw new Error(
      `no Orders pipeline with "Invoiced" in its label (found: ${res.results.map((p) => `"${p.label}"`).join(", ")}). ` +
        `Rename the idle Order Pipeline to "Invoiced Orders" in HubSpot Settings → Objects → Orders, ` +
        `or set TURNOVER_PIPELINE_ID + TURNOVER_STAGE_ID.`,
    );
  }
  const stage = pipeline.stages.find((s) => s.label.toLowerCase().includes("invoiced")) ?? pipeline.stages[0];
  if (!stage) throw new Error(`pipeline "${pipeline.label}" has no stages`);
  return { pipelineId: pipeline.id, stageId: stage.id };
}

// --- schema ----------------------------------------------------------------------

interface PropDef {
  name: string;
  label: string;
  type: "string" | "number" | "date";
  unique?: boolean;
}

const ORDER_PROPS: PropDef[] = [
  { name: "billing_document", label: "Billing Document (Invoice #)", type: "string", unique: true },
  { name: "billing_date", label: "Billing Date", type: "date" },
  { name: "brand", label: "Brand", type: "string" },
  { name: "quotation_ref", label: "Quotation Ref", type: "string" },
  { name: "rep_codes", label: "Rep Codes", type: "string" },
];

const LINE_PROPS: PropDef[] = [
  { name: "bd_line_key", label: "Invoice + Line (key)", type: "string", unique: true },
  { name: "discounted_sales", label: "Discounted Sales", type: "number" },
  { name: "ytd_total", label: "YTD Total", type: "number" },
  { name: "rep_code", label: "Rep Code", type: "string" },
];

async function ensureProps(token: string, obj: "orders" | "line_items", defs: PropDef[]): Promise<void> {
  try {
    await hs(token, `/crm/v3/properties/${obj}/groups`, {
      method: "POST",
      body: JSON.stringify({ name: GROUP, label: "Invoiced Orders (SAP)" }),
    });
  } catch (e) {
    if (!String(e).includes("409")) throw e;
  }
  const existing = await hs<{ results: { name: string }[] }>(token, `/crm/v3/properties/${obj}`);
  const have = new Set(existing.results.map((p) => p.name));
  for (const d of defs) {
    if (have.has(d.name)) continue;
    const hsType = d.type === "number" ? { type: "number", fieldType: "number" } : d.type === "date" ? { type: "date", fieldType: "date" } : { type: "string", fieldType: "text" };
    await hs(token, `/crm/v3/properties/${obj}`, {
      method: "POST",
      body: JSON.stringify({ name: d.name, label: d.label, groupName: GROUP, ...hsType, ...(d.unique ? { hasUniqueValue: true } : {}) }),
    });
    console.log(`[turnover-sync] created ${obj} property ${d.name}`);
  }
}

// --- orders push ------------------------------------------------------------------

interface OrderGroup {
  billingDocument: string;
  lines: TurnoverDbRow[];
  primaryRep: string | null;
  secondaryReps: string[];
  quoteRefs: string[];
  total: number;
}

/** Group staged lines into orders and pick each order's primary rep (the rep
 * with the largest |Discounted Sales| across qty-carrying lines; a rep with any
 * qty-carrying line beats one with none). */
export function groupOrders(rows: TurnoverDbRow[]): OrderGroup[] {
  const byDoc = new Map<string, TurnoverDbRow[]>();
  for (const r of rows) {
    (byDoc.get(r.billing_document) ?? byDoc.set(r.billing_document, []).get(r.billing_document)!).push(r);
  }
  const groups: OrderGroup[] = [];
  for (const [billingDocument, lines] of byDoc) {
    const weight = new Map<string, number>(); // rep -> |value| over qty-carrying lines
    const reps = new Set<string>();
    let total = 0;
    const quoteRefs = new Set<string>();
    for (const l of lines) {
      if (l.rep_code) reps.add(l.rep_code);
      if (l.quotation_ref) quoteRefs.add(l.quotation_ref);
      const qty = l.quantity ?? 0;
      if (qty !== 0) {
        total += l.discounted_sales ?? 0;
        if (l.rep_code) {
          weight.set(l.rep_code, (weight.get(l.rep_code) ?? 0) + Math.abs(l.discounted_sales ?? 0));
        }
      }
    }
    let primaryRep: string | null = null;
    for (const [rep, w] of weight) {
      if (primaryRep === null || w > (weight.get(primaryRep) ?? -1)) primaryRep = rep;
    }
    if (primaryRep === null) primaryRep = lines.find((l) => l.rep_code)?.rep_code ?? null;
    groups.push({
      billingDocument,
      lines,
      primaryRep,
      secondaryReps: [...reps].filter((r) => r !== primaryRep),
      quoteRefs: [...quoteRefs],
      total: round2(total),
    });
  }
  return groups;
}

export async function pushTurnoverToHubspot(
  sb: SupabaseClient,
  token: string,
  opts: { dryRun?: boolean; billingDocs?: Set<string> } = {},
): Promise<void> {
  // Load staging (optionally scoped to this run's touched billing documents).
  // Pagination MUST be ordered: separate unordered OFFSET queries do not see
  // stable page boundaries (synchronized seq scans), which silently drops and
  // duplicates rows once the table is big — caught during the 2024+ backfill
  // (74,871 of 111,578 docs loaded). Ordering by the unique staging key
  // (billing_document, material, rep_code) rides its index. A scoped push
  // reads server-side with chunked .in() so the daily run never pages the
  // whole table (millions of rows post-backfill).
  const COLS =
    "billing_document, material, rep_code, sold_to, billing_date, currency, quotation_ref, brand, quantity, ytd_total, discounted_sales";
  const rows: TurnoverDbRow[] = [];
  const scope = opts.billingDocs ? [...opts.billingDocs] : null;
  if (scope) {
    for (let i = 0; i < scope.length; i += 200) {
      const chunk = scope.slice(i, i + 200);
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb
          .from("turnover_orders")
          .select(COLS)
          .in("billing_document", chunk)
          .order("billing_document")
          .order("material")
          .order("rep_code")
          .range(from, from + 999);
        if (error) throw new Error(`turnover_orders read failed: ${error.message}`);
        const page = (data ?? []) as TurnoverDbRow[];
        rows.push(...page);
        if (page.length < 1000) break;
      }
    }
  } else {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("turnover_orders")
        .select(COLS)
        .order("billing_document")
        .order("material")
        .order("rep_code")
        .range(from, from + 999);
      if (error) throw new Error(`turnover_orders read failed: ${error.message}`);
      const page = (data ?? []) as TurnoverDbRow[];
      rows.push(...page);
      if (page.length < 1000) break;
    }
  }
  console.log(`[turnover-sync] HubSpot push: ${rows.length} staged lines${opts.billingDocs ? ` (scoped to ${opts.billingDocs.size} billing docs)` : ""}`);
  if (rows.length === 0) return;

  const orders = groupOrders(rows);
  const { pipelineId, stageId } = await resolvePipeline(token);
  console.log(`[turnover-sync] pipeline ${pipelineId} / stage ${stageId}`);

  // Rep Code records: id + channel + region + owner (ISR) for primary-rep credit.
  const allReps = [...new Set(rows.map((r) => r.rep_code).filter(Boolean))];
  const repInfo = await resolveIds(token, REP_CODE_OBJECT, "rep_code", allReps, ["channel", "region", "hubspot_owner_id"]);
  const regionLabel = await regionLabels(token);

  // Customer names: staged CUSTOMERS file first, matched HubSpot company second.
  const customerNames = await loadCustomerNames(sb);
  const accounts = [...new Set(orders.map((o) => o.lines[0]!.sold_to).filter(Boolean) as string[])];
  const companyByAccount = await resolveCompanies(token, accounts);
  const missingAccounts = accounts.filter((a) => !companyByAccount.has(a));

  // Order payloads.
  const orderInputs = orders.map((o) => {
    const last = o.lines[o.lines.length - 1]!;
    const properties: Record<string, string | number> = {
      billing_document: o.billingDocument,
      // The invoice # doubles as the order's Sales Order ID (per Davis) — SAP
      // billing-document and SO number ranges are disjoint, so this can't
      // collide with the open-orders records keyed on the same property.
      sales_order_id: o.billingDocument,
      hs_order_name: o.billingDocument,
      hs_pipeline: pipelineId,
      hs_pipeline_stage: stageId,
      hs_total_price: o.total,
      brand: last.brand,
    };
    if (last.billing_date) properties["billing_date"] = last.billing_date;
    if (last.currency) properties["hs_currency_code"] = last.currency;
    if (last.sold_to) {
      properties["customer_account"] = last.sold_to;
      const name = customerNames.get(last.sold_to) ?? companyByAccount.get(last.sold_to)?.name;
      if (name) properties["customer_name"] = name;
    }
    if (o.quoteRefs.length > 0) properties["quotation_ref"] = o.quoteRefs.join(", ");
    const reps = [o.primaryRep, ...o.secondaryReps].filter(Boolean) as string[];
    if (reps.length > 0) properties["rep_codes"] = reps.join(", ");
    if (o.primaryRep) {
      properties["sales_group"] = o.primaryRep;
      const info = repInfo.get(o.primaryRep);
      if (info?.channel) properties["channel"] = info.channel;
      if (info?.region) properties["sales_territory"] = regionLabel.get(info.region) ?? info.region;
      if (info?.hubspot_owner_id) properties["hubspot_owner_id"] = info.hubspot_owner_id;
    }
    return { idProperty: "billing_document", id: o.billingDocument, properties };
  });

  // Line payloads (unit price derived only when a real qty exists).
  const lineInputs = rows.map((r) => {
    const key = `${r.billing_document}-${turnoverLineKey({ material: r.material, repCode: r.rep_code })}`;
    const properties: Record<string, string | number> = {
      bd_line_key: key,
      name: r.material,
      material__: r.material,
    };
    if (r.quantity !== null) properties["quantity"] = r.quantity;
    if (r.discounted_sales !== null) properties["discounted_sales"] = r.discounted_sales;
    if (r.ytd_total !== null) properties["ytd_total"] = r.ytd_total;
    if (r.rep_code) properties["rep_code"] = r.rep_code;
    if (r.quantity && r.discounted_sales !== null) {
      // HubSpot rejects negative line-item prices (INVALID_PRICE). Opposite-sign
      // qty/sales rows (rebates) keep their true value in discounted_sales.
      const price = round2(r.discounted_sales / r.quantity);
      if (price >= 0) properties["price"] = price;
    }
    return { idProperty: "bd_line_key", id: key, properties, _doc: r.billing_document };
  });

  const ownersSet = orderInputs.filter((o) => o.properties["hubspot_owner_id"]).length;
  const channelsSet = orderInputs.filter((o) => o.properties["channel"]).length;
  console.log(`[turnover-sync] ${orders.length} orders (${ownersSet} owners, ${channelsSet} channels from rep codes), ${lineInputs.length} line items`);

  if (opts.dryRun) {
    console.log("[turnover-sync] DRY RUN — sample order:", JSON.stringify(orderInputs[0], null, 1));
    console.log("[turnover-sync] DRY RUN — sample line:", JSON.stringify(lineInputs[0], null, 1));
    const multiRep = orders.filter((o) => o.secondaryReps.length > 0);
    console.log(`[turnover-sync] DRY RUN — ${multiRep.length} split-rep orders, e.g.:`, multiRep.slice(0, 3).map((o) => ({ doc: o.billingDocument, primary: o.primaryRep, secondary: o.secondaryReps })));
    console.log(`[turnover-sync] DRY RUN — ${missingAccounts.length}/${accounts.length} Sold-to accounts missing in HubSpot (would be created), sample:`, missingAccounts.slice(0, 10));
    return;
  }

  await ensureProps(token, "orders", ORDER_PROPS);
  await ensureProps(token, "line_items", LINE_PROPS);

  // Association types. The base Order↔RepCode type was created by
  // open-orders-sync ("Rep Code"); Primary/Secondary labels are ours. A labeled
  // pair is always sent WITH the base type — labeled-only creates can silently
  // no-op (see the showroom-orders gotcha).
  const repBase = (await assocLabels(token, "orders", REP_CODE_OBJECT))[0] ?? null;
  const repPrimary = await ensureLabel(token, "orders", REP_CODE_OBJECT, "Primary Rep", "order_rep_primary");
  const repSecondary = await ensureLabel(token, "orders", REP_CODE_OBJECT, "Secondary Rep", "order_rep_secondary");
  const dealLabels = await assocLabels(token, "orders", "deals");
  const dealType: AssocType | null =
    dealLabels.find((l) => l.category === "HUBSPOT_DEFINED") ??
    dealLabels[0] ??
    (await ensureLabel(token, "orders", "deals", "Invoiced", "order_to_deal_invoiced"));

  // Upserts.
  const orderIdByDoc = await batchUpsert(token, "orders", orderInputs);
  const lineIdByKey = await batchUpsert(token, "line_items", lineInputs.map(({ _doc, ...x }) => x));

  // Line → Order.
  const liPairs = lineInputs
    .map((l) => ({ from: orderIdByDoc.get(l._doc), to: lineIdByKey.get(l.id) }))
    .filter((p): p is { from: string; to: string } => !!p.from && !!p.to);
  await batchAssociate(token, "orders", "line_items", [{ typeId: ORDER_TO_LINE_ITEM_TYPE, category: "HUBSPOT_DEFINED" }], liPairs);

  // Sold-to accounts with no HubSpot company get one created (bare account
  // number, name when the customers feed knows it) so no order is orphaned —
  // per Davis 2026-07-08, deliberate for the daily sync and backfill alike.
  if (missingAccounts.length > 0) {
    const created = await createCompanies(token, missingAccounts, customerNames);
    for (const [a, id] of created) companyByAccount.set(a, { id });
    console.log(`[turnover-sync] created ${created.size}/${missingAccounts.length} missing Sold-to companies`);
  }

  // Order → Company (Sold-to; companyByAccount resolved above).
  const companyPairs = orders
    .map((o) => ({ from: orderIdByDoc.get(o.billingDocument), to: o.lines[0]!.sold_to ? companyByAccount.get(o.lines[0]!.sold_to!)?.id : undefined }))
    .filter((p): p is { from: string; to: string } => !!p.from && !!p.to);
  await batchAssociate(token, "orders", "companies", [{ typeId: ORDER_TO_COMPANY_TYPE, category: "HUBSPOT_DEFINED" }], companyPairs);
  console.log(`[turnover-sync] Order→Company: ${companyPairs.length}/${orders.length} matched by Sold-to account`);

  // Order → Rep Code, labeled by role.
  const primaryPairs: { from: string; to: string }[] = [];
  const secondaryPairs: { from: string; to: string }[] = [];
  for (const o of orders) {
    const oid = orderIdByDoc.get(o.billingDocument);
    if (!oid) continue;
    const pid = o.primaryRep ? repInfo.get(o.primaryRep)?.__id : undefined;
    if (pid) primaryPairs.push({ from: oid, to: pid });
    for (const rep of o.secondaryReps) {
      const rid = repInfo.get(rep)?.__id;
      if (rid) secondaryPairs.push({ from: oid, to: rid });
    }
  }
  const withBase = (t: AssocType | null): AssocType[] => [...(repBase ? [{ typeId: repBase.typeId, category: repBase.category }] : []), ...(t ? [t] : [])];
  await batchAssociate(token, "orders", REP_CODE_OBJECT, withBase(repPrimary), primaryPairs);
  await batchAssociate(token, "orders", REP_CODE_OBJECT, withBase(repSecondary), secondaryPairs);
  console.log(`[turnover-sync] Order→RepCode: ${primaryPairs.length} primary, ${secondaryPairs.length} secondary`);

  // Order → Deal (Quotation Ref → sap_quote_number). Sparse and allowed to lag.
  const allRefs = [...new Set(orders.flatMap((o) => o.quoteRefs))];
  const dealByRef = await resolveIds(token, "deals", "sap_quote_number", allRefs);
  const dealPairs: { from: string; to: string }[] = [];
  let unmatchedRefs = 0;
  for (const o of orders) {
    const oid = orderIdByDoc.get(o.billingDocument);
    if (!oid) continue;
    for (const ref of o.quoteRefs) {
      const did = dealByRef.get(ref)?.__id;
      if (did) dealPairs.push({ from: oid, to: did });
      else unmatchedRefs++;
    }
  }
  if (dealType) await batchAssociate(token, "orders", "deals", [dealType], dealPairs);
  console.log(`[turnover-sync] Order→Deal: ${dealPairs.length} associated, ${unmatchedRefs} quote refs unmatched (retried next push)`);

  console.log(`[turnover-sync] push done: ${orderIdByDoc.size} orders, ${lineIdByKey.size} line items`);
}

// --- company parent-child ---------------------------------------------------------

export async function pushCompanyParents(
  sb: SupabaseClient,
  token: string,
  opts: { dryRun?: boolean; accounts?: Set<string> } = {},
): Promise<void> {
  const rows: CompanyParentDbRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("company_parents").select("account, customer_name, parent_account, parent_name").order("account").range(from, from + 999);
    if (error) throw new Error(`company_parents read failed: ${error.message}`);
    const page = (data ?? []) as CompanyParentDbRow[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const links = rows.filter((r) => r.parent_account && (!opts.accounts || opts.accounts.has(r.account)));
  console.log(`[turnover-sync] parent-child: ${rows.length} customers staged, ${links.length} with a parent`);
  if (links.length === 0) return;

  const accounts = [...new Set([...links.map((l) => l.account), ...links.map((l) => l.parent_account!)])];
  const companyByAccount = await resolveCompanies(token, accounts);
  const missing = accounts.filter((a) => !companyByAccount.has(a));

  // Names for creatable missing companies (child name from the customers file,
  // parent name from the PARENTS legend or its own customer row).
  const nameByAccount = new Map<string, string>();
  for (const r of rows) {
    if (r.customer_name) nameByAccount.set(r.account, r.customer_name);
    if (r.parent_account && r.parent_name && !nameByAccount.has(r.parent_account)) nameByAccount.set(r.parent_account, r.parent_name);
  }
  if (opts.dryRun) {
    const named = missing.filter((a) => nameByAccount.has(a));
    console.log(`[turnover-sync] DRY RUN parent-child: ${missing.length} accounts missing in HubSpot (${named.length} with names, rest created bare), sample:`, missing.slice(0, 10));
    return;
  }

  // Create ALL missing companies (name when known, else bare account number) —
  // per Davis 2026-07-07/08.
  if (missing.length > 0) {
    const created = await createCompanies(token, missing, nameByAccount);
    for (const [a, id] of created) companyByAccount.set(a, { id });
    console.log(`[turnover-sync] created ${created.size}/${missing.length} missing companies`);
  }

  // Native parent/child company association types, discovered not hardcoded.
  const labels = await assocLabels(token, "companies", "companies");
  const childToParent = labels.find((l) => (l.label ?? "").toLowerCase().includes("parent") && l.category === "HUBSPOT_DEFINED");
  if (!childToParent) {
    throw new Error(`no HUBSPOT_DEFINED parent company↔company association found (labels: ${labels.map((l) => `${l.typeId}:"${l.label}"`).join(", ")})`);
  }

  const pairs = links
    .map((l) => ({ from: companyByAccount.get(l.account)?.id, to: companyByAccount.get(l.parent_account!)?.id }))
    .filter((p): p is { from: string; to: string } => !!p.from && !!p.to && p.from !== p.to);
  await batchAssociate(token, "companies", "companies", [{ typeId: childToParent.typeId, category: childToParent.category }], pairs);
  console.log(
    `[turnover-sync] parent-child: ${pairs.length}/${links.length} associations created (child→parent type ${childToParent.typeId} "${childToParent.label}")`,
  );
}

// --- coverage verification ----------------------------------------------------------

export async function verifyCoverage(sb: SupabaseClient, token: string): Promise<void> {
  const soldTo = new Set<string>();
  const materials = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("turnover_orders").select("sold_to, material").order("billing_document").order("material").order("rep_code").range(from, from + 999);
    if (error) throw new Error(`turnover_orders read failed: ${error.message}`);
    const page = (data ?? []) as { sold_to: string | null; material: string }[];
    for (const r of page) {
      if (r.sold_to) soldTo.add(r.sold_to);
      materials.add(r.material);
    }
    if (page.length < 1000) break;
  }
  const parentAccounts = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("company_parents").select("account, parent_account").order("account").range(from, from + 999);
    if (error) throw new Error(`company_parents read failed: ${error.message}`);
    const page = (data ?? []) as { account: string; parent_account: string | null }[];
    for (const r of page) {
      parentAccounts.add(r.account);
      if (r.parent_account) parentAccounts.add(r.parent_account);
    }
    if (page.length < 1000) break;
  }

  const companies = await resolveCompanies(token, [...soldTo]);
  const missingSoldTo = [...soldTo].filter((a) => !companies.has(a));
  console.log(`[coverage] turnover Sold-to accounts: ${soldTo.size} distinct, ${missingSoldTo.length} missing in HubSpot Companies`);
  if (missingSoldTo.length) console.log(`[coverage]   sample missing:`, missingSoldTo.slice(0, 15));

  if (parentAccounts.size > 0) {
    const parentCompanies = await resolveCompanies(token, [...parentAccounts]);
    const missingParents = [...parentAccounts].filter((a) => !parentCompanies.has(a));
    console.log(`[coverage] customers-file accounts: ${parentAccounts.size} distinct, ${missingParents.length} missing in HubSpot Companies`);
    if (missingParents.length) console.log(`[coverage]   sample missing:`, missingParents.slice(0, 15));
  }

  const products = await resolveIds(token, "products", "hs_sku", [...materials]);
  const missingMaterials = [...materials].filter((m) => !products.has(m));
  console.log(`[coverage] materials: ${materials.size} distinct, ${missingMaterials.length} missing in HubSpot Products (hs_sku)`);
  if (missingMaterials.length) console.log(`[coverage]   sample missing:`, missingMaterials.slice(0, 15));
}
