import type { SupabaseClient } from "@supabase/supabase-js";
import {
  OA_DEAL_PIPELINE_LABEL,
  OA_ERP_SOURCE,
  OA_ORDERS_PIPELINE_LABEL,
  OA_STAGE_LABELS,
  UNIVERSAL_PIPELINE_ID,
  oaCompanyProps,
  oaDateToHubspotDate,
  oaDealProps,
  oaDestination,
  oaLineItems,
  oaOrderProps,
  oaStageForStatus,
  toNumber,
  type OaCustomer,
  type OaOrderDetail,
  type OaQuotation,
} from "@wac/shared";

/**
 * OA → HubSpot push.
 *
 * Deals: one per OA quotation, upserted portal-wide by the unique
 * `oa_quote_number` (deals may be moved between pipelines by humans — shared
 * domestic/international projects — so lookups NEVER filter by pipeline, and
 * pipeline/dealstage/closedate/erp_source are CREATE-only). New deals land in
 * the "International" pipeline, whose stages are cloned from the domestic
 * Universal pipeline so the two vocabularies can never drift.
 *
 * Orders: one per OA order in the "International Orders" pipeline, upserted by
 * unique `oa_order_id`. The SAP SO# goes in `oa_order_number` — deliberately
 * NOT `sales_order_id`, which is the domestic open-orders key.
 *
 * Companies: upserted by unique `oa_account_number` (never the SAP-owned
 * `account_number_`); `name` on create only. Only companies referenced by an
 * international (non-China-destination) quote/order are ever pushed.
 *
 * Associations: LineItem→Deal (20), Order→LineItem (513), Order→Company (934),
 * Deal→Company (discovered), Order→Deal (base + "International Order" label —
 * labeled pairs always ship WITH the base type; labeled-only creates silently
 * no-op, the showroom-orders gotcha).
 *
 * Machinery (hs/resolveIds/batchUpsert/batchAssociate/ensureLabel/ensureProps)
 * follows apps/turnover-sync/src/hubspot.ts.
 */

const HS = "https://api.hubapi.com";
const BATCH = 100;
const GROUP = "oa_international";
const GROUP_LABEL = "OA International";
const LINE_ITEM_TO_DEAL_TYPE = 20; // HUBSPOT_DEFINED line_items -> deals
const ORDER_TO_LINE_ITEM_TYPE = 513; // HUBSPOT_DEFINED orders -> line_items
const ORDER_TO_COMPANY_TYPE = 934; // HUBSPOT_DEFINED orders -> companies

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 6;
const MAX_NET_ATTEMPTS = 12;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      if (attempt >= MAX_NET_ATTEMPTS) throw e;
      const wait = Math.min(60_000, 1000 * 2 ** (attempt - 1));
      console.warn(`[oa-sync] ${path} network error (attempt ${attempt}/${MAX_NET_ATTEMPTS}), retrying in ${wait}ms: ${String(e).slice(0, 120)}`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        const after = Number(res.headers.get("retry-after"));
        const wait = after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1);
        console.warn(`[oa-sync] ${path} -> ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw new Error(`HubSpot ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }
}

// --- generic helpers ---------------------------------------------------------

type Props = Record<string, string | number>;

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
      if (!String(e).includes("207")) console.warn(`[oa-sync] ${obj} id resolve batch failed: ${String(e).slice(0, 120)}`);
    }
  }
  return map;
}

async function batchUpsert(
  token: string,
  obj: string,
  inputs: { idProperty: string; id: string; properties: Props }[],
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
  }
  return idByKey;
}

async function batchCreate(token: string, obj: string, inputs: { properties: Props }[], keyProp: string): Promise<Map<string, string>> {
  const idByKey = new Map<string, string>();
  for (let i = 0; i < inputs.length; i += BATCH) {
    const res = await hs<{ results: { id: string; properties: Record<string, string> }[] }>(
      token,
      `/crm/v3/objects/${obj}/batch/create`,
      { method: "POST", body: JSON.stringify({ inputs: inputs.slice(i, i + BATCH) }) },
    );
    for (const r of res.results) {
      const k = r.properties[keyProp];
      if (k) idByKey.set(k, r.id);
    }
  }
  return idByKey;
}

async function batchUpdate(token: string, obj: string, inputs: { id: string; properties: Props }[]): Promise<void> {
  for (let i = 0; i < inputs.length; i += BATCH) {
    await hs(token, `/crm/v3/objects/${obj}/batch/update`, {
      method: "POST",
      body: JSON.stringify({ inputs: inputs.slice(i, i + BATCH) }),
    });
  }
}

interface AssocType {
  typeId: number;
  category: "HUBSPOT_DEFINED" | "USER_DEFINED";
}

async function batchAssociate(token: string, fromObj: string, toObj: string, types: AssocType[], pairs: { from: string; to: string }[]): Promise<void> {
  if (types.length === 0 || pairs.length === 0) return;
  const uniq = [...new Map(pairs.map((p) => [`${p.from}:${p.to}`, p])).values()];
  for (let i = 0; i < uniq.length; i += BATCH) {
    const inputs = uniq.slice(i, i + BATCH).map((p) => ({
      from: { id: p.from },
      to: { id: p.to },
      types: types.map((t) => ({ associationCategory: t.category, associationTypeId: t.typeId })),
    }));
    try {
      await hs(token, `/crm/v4/associations/${fromObj}/${toObj}/batch/create`, { method: "POST", body: JSON.stringify({ inputs }) });
    } catch (e) {
      console.warn(`[oa-sync] associate ${fromObj}->${toObj} batch failed: ${String(e).slice(0, 160)}`);
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
      console.log(`[oa-sync] created ${fromObj}↔${toObj} association label "${label}" (type ${t.typeId})`);
      return { typeId: t.typeId, category: t.category ?? "USER_DEFINED" };
    }
  } catch (e) {
    console.warn(`[oa-sync] ${fromObj}↔${toObj} label "${label}" unavailable: ${String(e).slice(0, 160)}`);
  }
  return null;
}

// --- schema ------------------------------------------------------------------

interface PropDef {
  name: string;
  label: string;
  type: "string" | "number" | "date" | "bool" | "enum";
  unique?: boolean;
  options?: string[];
}

const DEAL_PROPS: PropDef[] = [
  { name: "oa_quote_number", label: "OA Quote Number", type: "string", unique: true },
  { name: "oa_project_status", label: "OA Project Status", type: "string" },
  { name: "oa_account_number", label: "OA Account Number", type: "string" },
  { name: "customer_name", label: "Customer Name", type: "string" },
  { name: "customer_coefficient", label: "Customer Coefficient", type: "number" },
  { name: "subtotal", label: "Subtotal", type: "number" },
  { name: "discount", label: "Discount", type: "number" },
  { name: "oa_prepayment", label: "Prepayment", type: "number" },
  { name: "oa_prepayment_percentage", label: "Prepayment Percentage", type: "number" },
  { name: "oa_balance_payment", label: "Balance Payment", type: "number" },
  { name: "oa_payment_terms", label: "Payment Terms (OA)", type: "string" },
  { name: "oa_shipment_terms", label: "Shipment Terms (OA)", type: "string" },
  { name: "oa_leadtime", label: "Lead Time (OA)", type: "string" },
  { name: "oa_quote_remarks", label: "Quote Remarks (OA)", type: "string" },
  { name: "oa_project_finished_date", label: "Project Finished Date (OA)", type: "date" },
  { name: "project_country", label: "Project Country", type: "string" },
  { name: "erp_source", label: "ERP Source", type: "enum", options: ["SAP", "OA"] },
];

const COMPANY_PROPS: PropDef[] = [
  { name: "oa_account_number", label: "OA Account Number", type: "string", unique: true },
  { name: "customer_coefficient", label: "Customer Coefficient", type: "number" },
  { name: "erp_source", label: "ERP Source", type: "enum", options: ["SAP", "OA"] },
];

const ORDER_PROPS: PropDef[] = [
  { name: "oa_order_id", label: "OA Order ID", type: "string", unique: true },
  { name: "oa_order_number", label: "OA Order Number (SAP SO#)", type: "string" },
  { name: "oa_quote_number", label: "OA Quote Number", type: "string" },
  { name: "oa_order_remark", label: "Order Remark (OA)", type: "string" },
  { name: "oa_order_discount", label: "Order Discount (OA)", type: "number" },
  { name: "oa_received_prepayment", label: "Received Prepayment (OA)", type: "bool" },
  { name: "oa_received_prepayment_amount", label: "Received Prepayment Amount (OA)", type: "number" },
  { name: "oa_received_balance_payment", label: "Received Balance Payment (OA)", type: "bool" },
  { name: "oa_received_balance_payment_amount", label: "Received Balance Payment Amount (OA)", type: "number" },
  { name: "expected_delivery_date", label: "Expected Delivery Date", type: "date" },
  { name: "customer_account", label: "Customer Account", type: "string" },
  { name: "customer_name", label: "Customer Name", type: "string" },
];

const LINE_PROPS: PropDef[] = [
  { name: "oa_line_key", label: "OA Quote + Line (key)", type: "string", unique: true },
  { name: "material_description", label: "Material Description", type: "string" },
  { name: "oa_customise_remark", label: "Customize Remark (OA)", type: "string" },
  { name: "oa_lamp_position", label: "Lamp Position (OA)", type: "string" },
];

async function ensureProps(token: string, obj: "deals" | "companies" | "orders" | "line_items", defs: PropDef[]): Promise<void> {
  try {
    await hs(token, `/crm/v3/properties/${obj}/groups`, {
      method: "POST",
      body: JSON.stringify({ name: GROUP, label: GROUP_LABEL }),
    });
  } catch (e) {
    if (!String(e).includes("409")) throw e;
  }
  const existing = await hs<{ results: { name: string }[] }>(token, `/crm/v3/properties/${obj}`);
  const have = new Set(existing.results.map((p) => p.name));
  for (const d of defs) {
    if (have.has(d.name)) continue;
    const hsType =
      d.type === "number"
        ? { type: "number", fieldType: "number" }
        : d.type === "date"
          ? { type: "date", fieldType: "date" }
          : d.type === "bool"
            ? {
                type: "enumeration",
                fieldType: "booleancheckbox",
                options: [
                  { label: "Yes", value: "true" },
                  { label: "No", value: "false" },
                ],
              }
            : d.type === "enum"
              ? {
                  type: "enumeration",
                  fieldType: "select",
                  options: (d.options ?? []).map((o) => ({ label: o, value: o })),
                }
              : { type: "string", fieldType: "text" };
    await hs(token, `/crm/v3/properties/${obj}`, {
      method: "POST",
      body: JSON.stringify({ name: d.name, label: d.label, groupName: GROUP, ...hsType, ...(d.unique ? { hasUniqueValue: true } : {}) }),
    });
    console.log(`[oa-sync] created ${obj} property ${d.name}`);
  }
}

// --- pipelines ---------------------------------------------------------------

interface HsPipeline {
  id: string;
  label: string;
  displayOrder?: number;
  stages: { id: string; label: string; displayOrder?: number; metadata?: Record<string, unknown> }[];
}

export interface OaPipelines {
  dealPipelineId: string;
  /** lowercased stage label -> stage id, within the International pipeline */
  dealStageIdByLabel: Map<string, string>;
  ordersPipelineId: string;
  ordersStageId: string;
}

/**
 * Discover-or-create both pipelines. The International DEAL pipeline is cloned
 * from the domestic Universal pipeline (labels, order, win probabilities) so
 * the mirrored-stage requirement holds by construction. Existing pipelines are
 * NEVER mutated — label drift only warns.
 */
export async function ensurePipelines(token: string, opts: { dryRun?: boolean } = {}): Promise<OaPipelines | null> {
  // Deals.
  const dealPipelines = await hs<{ results: HsPipeline[] }>(token, "/crm/v3/pipelines/deals");
  let intl =
    (process.env.OA_PIPELINE_ID && dealPipelines.results.find((p) => p.id === process.env.OA_PIPELINE_ID)) ||
    dealPipelines.results.find((p) => p.label.toLowerCase() === OA_DEAL_PIPELINE_LABEL.toLowerCase());
  if (!intl) {
    const universal = dealPipelines.results.find((p) => p.id === UNIVERSAL_PIPELINE_ID);
    if (!universal) throw new Error(`Universal deal pipeline ${UNIVERSAL_PIPELINE_ID} not found — cannot clone stages for "${OA_DEAL_PIPELINE_LABEL}"`);
    if (opts.dryRun) {
      console.log(`[oa-sync] DRY RUN — would create deal pipeline "${OA_DEAL_PIPELINE_LABEL}" cloning ${universal.stages.length} stages from "${universal.label}"`);
      return null;
    }
    intl = await hs<HsPipeline>(token, "/crm/v3/pipelines/deals", {
      method: "POST",
      body: JSON.stringify({
        label: OA_DEAL_PIPELINE_LABEL,
        displayOrder: (universal.displayOrder ?? 0) + 1,
        stages: universal.stages.map((s, i) => ({
          label: s.label,
          displayOrder: s.displayOrder ?? i,
          metadata: { probability: (s.metadata as { probability?: unknown } | undefined)?.probability ?? 0.5 },
        })),
      }),
    });
    console.log(`[oa-sync] created deal pipeline "${OA_DEAL_PIPELINE_LABEL}" (${intl.id}) cloned from Universal`);
  }
  const dealStageIdByLabel = new Map(intl.stages.map((s) => [s.label.toLowerCase(), s.id]));
  for (const label of Object.values(OA_STAGE_LABELS)) {
    if (!dealStageIdByLabel.has(label.toLowerCase())) {
      console.warn(`[oa-sync] WARNING: pipeline "${intl.label}" is missing mirrored stage "${label}" — statuses mapping there will fall back`);
    }
  }

  // Orders.
  const orderPipelines = await hs<{ results: HsPipeline[] }>(token, "/crm/v3/pipelines/orders");
  let intlOrders =
    (process.env.OA_ORDERS_PIPELINE_ID && orderPipelines.results.find((p) => p.id === process.env.OA_ORDERS_PIPELINE_ID)) ||
    orderPipelines.results.find((p) => p.label.toLowerCase() === OA_ORDERS_PIPELINE_LABEL.toLowerCase());
  if (!intlOrders) {
    if (opts.dryRun) {
      console.log(`[oa-sync] DRY RUN — would create orders pipeline "${OA_ORDERS_PIPELINE_LABEL}" with stage "Open"`);
      return null;
    }
    try {
      intlOrders = await hs<HsPipeline>(token, "/crm/v3/pipelines/orders", {
        method: "POST",
        body: JSON.stringify({
          label: OA_ORDERS_PIPELINE_LABEL,
          displayOrder: orderPipelines.results.length,
          stages: [{ label: "Open", displayOrder: 0, metadata: {} }],
        }),
      });
      console.log(`[oa-sync] created orders pipeline "${OA_ORDERS_PIPELINE_LABEL}" (${intlOrders.id})`);
    } catch (e) {
      throw new Error(
        `could not create orders pipeline "${OA_ORDERS_PIPELINE_LABEL}" (${String(e).slice(0, 200)}). ` +
          `Create it in HubSpot Settings → Objects → Orders, or set OA_ORDERS_PIPELINE_ID.`,
      );
    }
  }
  const ordersStage = intlOrders.stages[0];
  if (!ordersStage) throw new Error(`orders pipeline "${intlOrders.label}" has no stages`);

  return {
    dealPipelineId: intl.id,
    dealStageIdByLabel,
    ordersPipelineId: intlOrders.id,
    ordersStageId: process.env.OA_ORDERS_STAGE_ID ?? ordersStage.id,
  };
}

// --- staging model -----------------------------------------------------------

export interface OaStagedRow {
  record_type: "order" | "quote" | "project" | "customer";
  oa_id: string;
  raw_json: Record<string, unknown>;
  detail_hash: string | null;
  pushed_hash: string | null;
  push_status: string;
}

interface QuoteUnit {
  quoteId: string;
  quotation: OaQuotation;
  status: string | null;
  destination: "china" | "international" | "unknown";
  orderDetails: OaOrderDetail[];
  changed: boolean;
}

const asId = (v: unknown): string => String(v ?? "").trim();

/**
 * Join the four staged record types into per-quote units: the embedded
 * quotation from an order detail (documented, has productList + customer)
 * wins field conflicts; a standalone quote row supplies anything extra
 * (status, pre-order quotes with no order at all). Projects enrich
 * destination + status when the quote's own project block lacks them.
 */
export function buildQuoteUnits(rows: OaStagedRow[], opts: { force?: boolean } = {}): QuoteUnit[] {
  const changed = (r: OaStagedRow) => !!opts.force || r.detail_hash !== r.pushed_hash;

  const projectById = new Map<string, Record<string, unknown>>();
  const projectByName = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (r.record_type !== "project") continue;
    projectById.set(r.oa_id, r.raw_json);
    const name = asId((r.raw_json as { name?: unknown }).name);
    if (name) projectByName.set(name, r.raw_json);
  }

  interface Acc {
    quoteRow?: OaStagedRow;
    orderRows: OaStagedRow[];
  }
  const acc = new Map<string, Acc>();
  const of = (quoteId: string) => acc.get(quoteId) ?? acc.set(quoteId, { orderRows: [] }).get(quoteId)!;
  for (const r of rows) {
    if (r.record_type === "quote") {
      const id = asId((r.raw_json as { id?: unknown }).id) || r.oa_id;
      of(id).quoteRow = r;
    } else if (r.record_type === "order") {
      const d = r.raw_json as OaOrderDetail;
      const id = asId(d.quotation?.id ?? d.quotationId);
      if (id) of(id).orderRows.push(r);
      else console.warn(`[oa-sync] order ${r.oa_id} has no quotation id — skipped`);
    }
  }

  const units: QuoteUnit[] = [];
  for (const [quoteId, a] of acc) {
    const embedded = a.orderRows
      .map((r) => (r.raw_json as OaOrderDetail).quotation)
      .filter((q): q is OaQuotation => !!q)
      .find((q) => Array.isArray(q.productList));
    const quoteRowJson = a.quoteRow?.raw_json as OaQuotation | undefined;
    const quotation: OaQuotation = { ...(quoteRowJson ?? {}), ...(embedded ?? {}) };
    if (!quotation.id) quotation.id = quoteId;

    const project =
      projectById.get(asId(quotation.project?.id ?? (quotation as { projectId?: unknown }).projectId)) ??
      projectByName.get(asId(quotation.project?.name));
    const status = asId(quotation.status ?? quotation.project?.status ?? (project as { status?: unknown } | undefined)?.status) || null;
    const destination = oaDestination({
      country: asId(quotation.project?.country ?? (project as { country?: unknown } | undefined)?.country) || null,
      location: asId(quotation.project?.location ?? (project as { location?: unknown } | undefined)?.location) || null,
    });

    units.push({
      quoteId,
      quotation,
      status,
      destination,
      orderDetails: a.orderRows.map((r) => r.raw_json as OaOrderDetail),
      changed: (a.quoteRow ? changed(a.quoteRow) : false) || a.orderRows.some(changed),
    });
  }
  return units;
}

// --- push --------------------------------------------------------------------

export interface PushScope {
  dryRun?: boolean;
  force?: boolean;
  quoteIds?: Set<string>;
  orderIds?: Set<string>;
}

export interface PushSummary {
  deals: number;
  dealsCreated: number;
  orders: number;
  companies: number;
  lineItems: number;
  skippedDomestic: number;
  skippedUnknown: number;
}

export async function pushOaToHubspot(sb: SupabaseClient, token: string, scope: PushScope = {}): Promise<PushSummary> {
  // Load staging (ordered pagination — unordered OFFSET pages are unstable).
  const rows: OaStagedRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("oa_records")
      .select("record_type, oa_id, raw_json, detail_hash, pushed_hash, push_status")
      .order("record_type")
      .order("oa_id")
      .range(from, from + 999);
    if (error) throw new Error(`oa_records read failed: ${error.message}`);
    const page = (data ?? []) as OaStagedRow[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  console.log(`[oa-sync] push: ${rows.length} staged records`);

  const units = buildQuoteUnits(rows, { force: scope.force });
  const inScope = (u: QuoteUnit) =>
    (!scope.quoteIds || scope.quoteIds.has(u.quoteId)) &&
    (!scope.orderIds || u.orderDetails.some((d) => scope.orderIds!.has(asId(d.id))));
  const scoped = scope.quoteIds || scope.orderIds ? units.filter(inScope) : units;

  const international = scoped.filter((u) => u.destination === "international");
  const domestic = scoped.filter((u) => u.destination === "china");
  const unknown = scoped.filter((u) => u.destination === "unknown");
  const pushable = international.filter((u) => u.changed || scope.force || scope.quoteIds || scope.orderIds);
  console.log(
    `[oa-sync] quotes: ${units.length} total, ${scoped.length} in scope → ${international.length} international / ${domestic.length} china / ${unknown.length} unknown destination (both skipped, fail-closed) → ${pushable.length} to push`,
  );

  // Customers staged by account code, for company enrichment.
  const customerByCode = new Map<string, { row: OaStagedRow; payload: OaCustomer }>();
  for (const r of rows) {
    if (r.record_type !== "customer") continue;
    const payload = r.raw_json as OaCustomer;
    const code = asId(payload.code) || r.oa_id;
    if (code) customerByCode.set(code, { row: r, payload });
  }

  // Companies referenced by pushable international quotes (Chinese customers
  // are never created — they only enter via an international quote).
  const accounts = [...new Set(pushable.map((u) => asId(u.quotation.customer?.code)).filter(Boolean))];
  const companyProps = new Map<string, Props>();
  for (const a of accounts) {
    const staged = customerByCode.get(a);
    companyProps.set(a, staged ? oaCompanyProps(staged.payload) : oaCompanyProps(u_customer(pushable, a)));
  }

  const summary: PushSummary = {
    deals: 0,
    dealsCreated: 0,
    orders: 0,
    companies: accounts.length,
    lineItems: 0,
    skippedDomestic: domestic.length,
    skippedUnknown: unknown.length,
  };

  if (scope.dryRun) {
    const sample = pushable[0];
    console.log(`[oa-sync] DRY RUN — ${pushable.length} deals, ${pushable.flatMap((u) => u.orderDetails).length} orders, ${accounts.length} companies would push`);
    if (sample) {
      console.log("[oa-sync] DRY RUN — sample deal props:", JSON.stringify(oaDealProps(sample.quotation), null, 1));
      const det = sample.orderDetails[0];
      if (det) console.log("[oa-sync] DRY RUN — sample order props:", JSON.stringify(oaOrderProps(det), null, 1));
      console.log("[oa-sync] DRY RUN — sample lines:", JSON.stringify(oaLineItems(sample.quotation).slice(0, 2), null, 1));
    }
    if (domestic.length || unknown.length) {
      console.log(
        "[oa-sync] DRY RUN — skipped destinations sample:",
        [...domestic, ...unknown].slice(0, 10).map((u) => ({ quote: u.quoteId, dest: u.destination, country: u.quotation.project?.country ?? null, location: u.quotation.project?.location ?? null })),
      );
    }
    await ensurePipelines(token, { dryRun: true });
    await markSkipped(sb, [...domestic, ...unknown], { dryRun: true });
    return summary;
  }

  if (pushable.length === 0) {
    await markSkipped(sb, [...domestic, ...unknown], {});
    console.log("[oa-sync] nothing changed — push done.");
    return summary;
  }

  // Schema + pipelines + association types.
  await ensureProps(token, "deals", DEAL_PROPS);
  await ensureProps(token, "companies", COMPANY_PROPS);
  await ensureProps(token, "orders", ORDER_PROPS);
  await ensureProps(token, "line_items", LINE_PROPS);
  const pipelines = (await ensurePipelines(token))!;

  const orderDealLabels = await assocLabels(token, "orders", "deals");
  const orderDealBase: AssocType | null = orderDealLabels.find((l) => l.category === "HUBSPOT_DEFINED") ?? orderDealLabels[0] ?? null;
  const orderDealIntl = await ensureLabel(token, "orders", "deals", "International Order", "order_to_deal_international");
  const dealCompanyLabels = await assocLabels(token, "deals", "companies");
  const dealCompanyType: AssocType | null =
    dealCompanyLabels.find((l) => l.category === "HUBSPOT_DEFINED" && !l.label) ??
    dealCompanyLabels.find((l) => l.category === "HUBSPOT_DEFINED") ??
    dealCompanyLabels[0] ??
    null;

  // --- companies: create with name, update without (name is create-only) ----
  const existingCompanies = await resolveIds(token, "companies", "oa_account_number", accounts);
  const companyCreates = accounts
    .filter((a) => !existingCompanies.has(a))
    .map((a) => ({ properties: { ...companyProps.get(a)!, erp_source: OA_ERP_SOURCE } }));
  const companyUpdates = accounts
    .filter((a) => existingCompanies.has(a))
    .map((a) => {
      const { name: _name, ...props } = companyProps.get(a)!;
      return { id: existingCompanies.get(a)!.__id, properties: props };
    })
    .filter((u) => Object.keys(u.properties).length > 1); // >1: more than just the key
  const createdCompanies = companyCreates.length ? await batchCreate(token, "companies", companyCreates, "oa_account_number") : new Map<string, string>();
  if (companyUpdates.length) await batchUpdate(token, "companies", companyUpdates);
  const companyIdByAccount = new Map<string, string>();
  for (const a of accounts) {
    const id = existingCompanies.get(a)?.__id ?? createdCompanies.get(a);
    if (id) companyIdByAccount.set(a, id);
  }
  console.log(`[oa-sync] companies: ${createdCompanies.size} created, ${companyUpdates.length} updated (${accounts.length} referenced)`);

  // --- deals: resolve portal-wide, split create/update ----------------------
  const existingDeals = await resolveIds(token, "deals", "oa_quote_number", pushable.map((u) => u.quoteId), ["pipeline", "dealstage"]);
  const stageIdFor = (label: string): string | undefined => pipelines.dealStageIdByLabel.get(label.toLowerCase());

  const dealCreates: { properties: Props }[] = [];
  const dealUpdates: { id: string; properties: Props }[] = [];
  for (const u of pushable) {
    const props = oaDealProps(u.quotation);
    const existing = existingDeals.get(u.quoteId);
    if (existing) {
      dealUpdates.push({ id: existing.__id, properties: props });
      continue;
    }
    const ordered = u.orderDetails.length > 0;
    const stageLabel = ordered ? OA_STAGE_LABELS.buy : (oaStageForStatus(u.status) ?? OA_STAGE_LABELS.bid);
    const stageId = stageIdFor(stageLabel) ?? stageIdFor(OA_STAGE_LABELS.bid);
    const createProps: Props = {
      ...props,
      pipeline: pipelines.dealPipelineId,
      erp_source: OA_ERP_SOURCE,
    };
    if (stageId) createProps.dealstage = stageId;
    if (ordered) {
      const closeMs = u.orderDetails
        .map((d) => oaDateToHubspotDate(d.createDate))
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b)[0];
      if (closeMs !== undefined) createProps.closedate = closeMs;
    }
    dealCreates.push({ properties: createProps });
  }
  const createdDeals = dealCreates.length ? await batchCreate(token, "deals", dealCreates, "oa_quote_number") : new Map<string, string>();
  if (dealUpdates.length) await batchUpdate(token, "deals", dealUpdates);
  const dealIdByQuote = new Map<string, string>();
  for (const u of pushable) {
    const id = existingDeals.get(u.quoteId)?.__id ?? createdDeals.get(u.quoteId);
    if (id) dealIdByQuote.set(u.quoteId, id);
  }
  summary.deals = dealIdByQuote.size;
  summary.dealsCreated = createdDeals.size;
  console.log(`[oa-sync] deals: ${createdDeals.size} created, ${dealUpdates.length} updated`);

  // --- line items ------------------------------------------------------------
  const lineInputs = pushable.flatMap((u) =>
    oaLineItems(u.quotation).map((l) => ({ idProperty: "oa_line_key", id: l.key, properties: l.props, _quote: u.quoteId })),
  );
  const lineIdByKey = lineInputs.length
    ? await batchUpsert(token, "line_items", lineInputs.map(({ _quote, ...x }) => x))
    : new Map<string, string>();
  summary.lineItems = lineIdByKey.size;

  // Line → Deal.
  const lineDealPairs = lineInputs
    .map((l) => ({ from: lineIdByKey.get(l.id), to: dealIdByQuote.get(l._quote) }))
    .filter((p): p is { from: string; to: string } => !!p.from && !!p.to);
  await batchAssociate(token, "line_items", "deals", [{ typeId: LINE_ITEM_TO_DEAL_TYPE, category: "HUBSPOT_DEFINED" }], lineDealPairs);

  // --- orders ----------------------------------------------------------------
  const orderInputs = pushable.flatMap((u) =>
    u.orderDetails.map((d) => {
      const properties: Props = {
        ...oaOrderProps(d),
        hs_pipeline: pipelines.ordersPipelineId,
        hs_pipeline_stage: pipelines.ordersStageId,
      };
      const total = toNumber(u.quotation.discountTotalAmount ?? u.quotation.totalAmount);
      if (typeof total === "number") properties.hs_total_price = total;
      return { idProperty: "oa_order_id", id: asId(d.id), properties, _quote: u.quoteId };
    }),
  );
  const orderIdByOaId = orderInputs.length
    ? await batchUpsert(token, "orders", orderInputs.map(({ _quote, ...x }) => x))
    : new Map<string, string>();
  summary.orders = orderIdByOaId.size;

  // Order → Line Item (this quote's lines), Order → Company, Order → Deal.
  const orderLinePairs: { from: string; to: string }[] = [];
  const orderCompanyPairs: { from: string; to: string }[] = [];
  const orderDealPairs: { from: string; to: string }[] = [];
  const dealCompanyPairs: { from: string; to: string }[] = [];
  for (const u of pushable) {
    const dealId = dealIdByQuote.get(u.quoteId);
    const companyId = companyIdByAccount.get(asId(u.quotation.customer?.code));
    if (dealId && companyId) dealCompanyPairs.push({ from: dealId, to: companyId });
    const lineIds = oaLineItems(u.quotation)
      .map((l) => lineIdByKey.get(l.key))
      .filter((v): v is string => !!v);
    for (const d of u.orderDetails) {
      const orderId = orderIdByOaId.get(asId(d.id));
      if (!orderId) continue;
      for (const lid of lineIds) orderLinePairs.push({ from: orderId, to: lid });
      if (companyId) orderCompanyPairs.push({ from: orderId, to: companyId });
      if (dealId) orderDealPairs.push({ from: orderId, to: dealId });
    }
  }
  await batchAssociate(token, "orders", "line_items", [{ typeId: ORDER_TO_LINE_ITEM_TYPE, category: "HUBSPOT_DEFINED" }], orderLinePairs);
  await batchAssociate(token, "orders", "companies", [{ typeId: ORDER_TO_COMPANY_TYPE, category: "HUBSPOT_DEFINED" }], orderCompanyPairs);
  if (dealCompanyType) await batchAssociate(token, "deals", "companies", [dealCompanyType], dealCompanyPairs);
  const orderDealTypes: AssocType[] = [...(orderDealBase ? [orderDealBase] : []), ...(orderDealIntl ? [orderDealIntl] : [])];
  await batchAssociate(token, "orders", "deals", orderDealTypes, orderDealPairs);
  console.log(`[oa-sync] associations: ${lineDealPairs.length} line→deal, ${orderLinePairs.length} order→line, ${orderCompanyPairs.length} order→company, ${orderDealPairs.length} order→deal, ${dealCompanyPairs.length} deal→company`);

  // --- mark staging ----------------------------------------------------------
  await markSkipped(sb, [...domestic, ...unknown], {});
  const now = new Date().toISOString();
  // Quotes/orders that pushed are marked, and a referenced customer record
  // rides along; unreferenced customer/project rows stay pending (harmless —
  // the hash gate keeps them out of HubSpot traffic).
  const pushedKeys: { record_type: string; oa_id: string }[] = [];
  for (const u of pushable) {
    if (!dealIdByQuote.get(u.quoteId)) continue;
    pushedKeys.push({ record_type: "quote", oa_id: u.quoteId });
    for (const d of u.orderDetails) pushedKeys.push({ record_type: "order", oa_id: asId(d.id) });
    const code = asId(u.quotation.customer?.code);
    if (code && customerByCode.has(code)) pushedKeys.push({ record_type: "customer", oa_id: customerByCode.get(code)!.row.oa_id });
  }
  for (const k of pushedKeys) {
    const row = rows.find((r) => r.record_type === k.record_type && r.oa_id === k.oa_id);
    if (!row) continue;
    const { error } = await sb
      .from("oa_records")
      .update({ push_status: "pushed", push_error: null, pushed_at: now, pushed_hash: row.detail_hash, updated_at: now })
      .eq("record_type", k.record_type)
      .eq("oa_id", k.oa_id);
    if (error) console.warn(`[oa-sync] staging mark failed for ${k.record_type}/${k.oa_id}: ${error.message}`);
  }

  console.log(`[oa-sync] push done: ${summary.deals} deals (${summary.dealsCreated} new), ${summary.orders} orders, ${summary.lineItems} lines, ${accounts.length} companies`);
  return summary;
}

/** Minimal customer payload from the quote itself when no customer record is staged. */
function u_customer(units: QuoteUnit[], account: string): OaCustomer {
  for (const u of units) {
    const c = u.quotation.customer;
    if (c && asId(c.code) === account) return c;
  }
  return { code: account };
}

/** Mark china/unknown-destination quote+order rows skipped_domestic. */
async function markSkipped(sb: SupabaseClient, units: QuoteUnit[], opts: { dryRun?: boolean }): Promise<void> {
  if (opts.dryRun || units.length === 0) return;
  const now = new Date().toISOString();
  for (const u of units) {
    const reason = `destination=${u.destination}`;
    const keys = [
      { record_type: "quote", oa_id: u.quoteId },
      ...u.orderDetails.map((d) => ({ record_type: "order", oa_id: asId(d.id) })),
    ];
    for (const k of keys) {
      const { error } = await sb
        .from("oa_records")
        .update({ push_status: "skipped_domestic", push_error: reason, updated_at: now })
        .eq("record_type", k.record_type)
        .eq("oa_id", k.oa_id)
        .neq("push_status", "skipped_domestic");
      if (error) console.warn(`[oa-sync] skip mark failed for ${k.record_type}/${k.oa_id}: ${error.message}`);
    }
  }
}
