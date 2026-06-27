import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Open Orders → HubSpot push. Reads the current open snapshot from the
 * `open_orders` staging table and upserts HubSpot Orders + Line Items:
 *
 *   - One Order per SO (idProperty = sales_order_id), placed in the Open Orders
 *     pipeline / Open stage, owner = the AMT Rep resolved to a HubSpot user.
 *   - One Line Item per (SO, Material) (idProperty = so_material) — a material
 *     appears once per order, so SO+Material is the stable line key.
 *   - Associations: Line Item → Order, Order → Company (by account number),
 *     Order → Rep Code object (by Sales Group).
 *
 * Idempotent: ensures every property / the line key / the Order↔RepCode
 * association type exists, then batch-UPSERTS. Non-destructive (no deletes).
 */

const HS = "https://api.hubapi.com";
const REP_CODE_OBJECT = "2-41537429";
const OPEN_ORDERS_PIPELINE = "909519998";
const OPEN_STAGE = "1380187574";
const ORDER_TO_LINE_ITEM_TYPE = 513; // HUBSPOT_DEFINED orders -> line_items
const ORDER_TO_COMPANY_TYPE = 934; // HUBSPOT_DEFINED orders -> companies
const BATCH = 100;

type Obj = "orders" | "line_items";
interface FieldDef {
  prop: string;
  /** Staging column, or { raw } SAP header (whitespace-tolerant). */
  src: string | { raw: string };
  type: "string" | "number" | "date";
  create?: boolean;
}

// Order-level fields (one value per SO; if a field varies across an SO's lines
// the last line wins). `create` = property does not exist yet on the object.
const ORDER_FIELDS: FieldDef[] = [
  { prop: "po_number", src: "po_number", type: "string" },
  { prop: "po_date", src: "po_date", type: "date" },
  { prop: "customer_account", src: "customer_account", type: "string" },
  { prop: "customer_name", src: "customer_name", type: "string" },
  { prop: "created_by", src: { raw: "Created By" }, type: "string" },
  { prop: "amt_rep", src: "amt_rep", type: "string" },
  { prop: "shpt", src: { raw: "ShPt" }, type: "number" },
  { prop: "order_reason", src: { raw: "Order Reason" }, type: "string" },
  { prop: "assigned_to", src: { raw: "Assigned To" }, type: "string" },
  { prop: "delivery_block", src: { raw: "Delivery Block" }, type: "string" },
  { prop: "delivery_number", src: { raw: "Delivery No" }, type: "number" },
  { prop: "date_of_delivery", src: { raw: "Delivery Date" }, type: "date" },
  { prop: "complete_dlv", src: { raw: "Complete Dlv" }, type: "string" },
  { prop: "credit_rep", src: { raw: "Credit Rep" }, type: "string", create: true },
  { prop: "credit_status", src: { raw: "Credit Status" }, type: "string", create: true },
  // Risk code + its two legend meanings are enumeration (dropdown) props managed
  // by ensureRiskEnums — NOT the generic text `create` path. All three carry the
  // CODE as the value; they differ only in option label (code / desc / meaning).
  { prop: "risk_code", src: { raw: "Risk Code" }, type: "string" },
  { prop: "risk_code_description", src: { raw: "Risk Code" }, type: "string" },
  { prop: "risk_code_meaning", src: { raw: "Risk Code" }, type: "string" },
  { prop: "sales_group", src: "sales_group", type: "string", create: true },
  { prop: "sales_territory", src: "sales_territory", type: "string", create: true },
  { prop: "purchasing_group", src: { raw: "Purchasing Group" }, type: "string", create: true },
  { prop: "scm_partner", src: { raw: "SCM Partner" }, type: "string", create: true },
];

const LINE_FIELDS: FieldDef[] = [
  { prop: "material__", src: "material", type: "string" },
  { prop: "quantity", src: "order_qty", type: "number" },
  { prop: "price", src: "net_price", type: "number" },
  { prop: "business_unit", src: "business_unit", type: "string" },
  { prop: "product_group_description", src: { raw: "Product Group" }, type: "string" },
  { prop: "posnr", src: "posnr", type: "number", create: true },
  { prop: "line_net_value", src: "line_net_value", type: "number", create: true },
  { prop: "item_category", src: { raw: "ItCa" }, type: "string", create: true },
  { prop: "rejection_description", src: { raw: "Rejection Desc" }, type: "string", create: true },
  { prop: "reason", src: { raw: "Reason" }, type: "string", create: true },
  { prop: "responsible_party", src: { raw: "Responsible Party" }, type: "string", create: true },
  { prop: "order_confirmation_date", src: { raw: "Order Confirmation Date" }, type: "date", create: true },
  { prop: "order_confirmation_qty", src: { raw: "Order Confirmation Qty" }, type: "number", create: true },
  { prop: "back_order_date", src: { raw: "Back Order Date" }, type: "date", create: true },
  { prop: "back_order_qty", src: "back_order_qty", type: "number", create: true },
  { prop: "allocated", src: { raw: "Allocated" }, type: "number", create: true },
  { prop: "same_plant_atp", src: { raw: "Same Plant ATP" }, type: "number", create: true },
  { prop: "same_plant_available", src: { raw: "Same Plant Available" }, type: "number", create: true },
  { prop: "cross_plant_atp", src: { raw: "Cross Plant ATP" }, type: "number", create: true },
  { prop: "cross_plant_available", src: { raw: "Cross Plant Available" }, type: "number", create: true },
  { prop: "cross_plant_max_atp", src: { raw: "Cross Plant Max ATP" }, type: "number", create: true },
  { prop: "cross_plant_max_available", src: { raw: "Cross Plant Max Available" }, type: "number", create: true },
  { prop: "intro_code", src: { raw: "Intro Code" }, type: "string", create: true },
];

interface OpenOrderDbRow {
  so: string;
  posnr: string;
  material: string | null;
  customer_account: string | null;
  sales_group: string | null;
  amt_rep: string | null;
  [k: string]: unknown;
  raw_json: Record<string, unknown>;
}

async function hs<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HS}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HubSpot ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/** Whitespace/case-tolerant raw_json lookup (SAP headers carry stray spaces). */
function rawField(raw: Record<string, unknown>, header: string): unknown {
  if (header in raw) return raw[header];
  const t = header.trim().toLowerCase();
  for (const k of Object.keys(raw)) if (k.trim().toLowerCase() === t) return raw[k];
  return undefined;
}

function coerce(v: unknown, type: FieldDef["type"]): string | number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (type === "number") {
    const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "date") {
    // HubSpot date props accept YYYY-MM-DD. Handle ISO strings (the jsonb
    // round-trip), Date objects, and other parseable date strings alike.
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  return s || undefined;
}

function valueFor(row: OpenOrderDbRow, def: FieldDef): string | number | undefined {
  const raw = typeof def.src === "string" ? row[def.src] : rawField(row.raw_json ?? {}, def.src.raw);
  return coerce(raw, def.type);
}

/** Order property bag for one SO (sans owner, which is resolved at push time). */
export function buildOrderProperties(r: OpenOrderDbRow): Record<string, string | number> {
  // hs_order_name = the SO; hs_total_price is added by the caller (it needs the
  // order's full line set to sum).
  const properties: Record<string, string | number> = { sales_order_id: r.so, hs_order_name: r.so };
  for (const d of ORDER_FIELDS) {
    const v = valueFor(r, d);
    if (v !== undefined) properties[d.prop] = v;
  }
  properties["hs_pipeline"] = OPEN_ORDERS_PIPELINE;
  properties["hs_pipeline_stage"] = OPEN_STAGE;
  return properties;
}

/** Line Item property bag for one (SO, POSNR). The key is SO+POSNR — the true
 * unique line key; SO+Material is NOT unique (a material can recur across an
 * order's lines). */
export function buildLineProperties(r: OpenOrderDbRow): Record<string, string | number> {
  const properties: Record<string, string | number> = {
    so_posnr: `${r.so}-${r.posnr}`,
    name: r.material || `${r.so}-${r.posnr}`,
  };
  for (const d of LINE_FIELDS) {
    const v = valueFor(r, d);
    if (v !== undefined) properties[d.prop] = v;
  }
  return properties;
}

// --- Risk Code dropdowns -----------------------------------------------------
// `risk_code` and its legend meanings are exposed as three enumeration props on
// the Order. Each record stores the CODE as the value on all three; HubSpot just
// renders a different option LABEL per prop (the code / its Code Description / its
// Meaning). Options are synced from the `open_order_risk_codes` legend each run,
// additively, so a new code in the sheet auto-adds an option and never breaks the
// push on an unknown enum value.

const RISK_ENUM_PROPS = ["risk_code", "risk_code_description", "risk_code_meaning"] as const;
type RiskEnumProp = (typeof RISK_ENUM_PROPS)[number];
type RiskOptionSet = Record<RiskEnumProp, HsOption[]>;

interface HsOption {
  label: string;
  value: string;
  displayOrder?: number;
  hidden?: boolean;
}
interface RiskLegendEntry {
  description: string | null;
  meaning: string | null;
}
type RiskLegend = Map<string, RiskLegendEntry>;

/** Load the code -> {description, meaning} legend (best-effort; an empty map just
 * means dropdowns fall back to showing the bare code). */
async function loadRiskLegend(sb: SupabaseClient): Promise<RiskLegend> {
  const legend: RiskLegend = new Map();
  const { data, error } = await sb
    .from("open_order_risk_codes")
    .select("code, code_description, meaning");
  if (error) {
    console.warn(`[open-orders-sync] risk legend load failed (continuing): ${error.message}`);
    return legend;
  }
  for (const r of (data ?? []) as { code: string; code_description: string | null; meaning: string | null }[]) {
    const code = String(r.code).trim();
    if (code) legend.set(code, { description: r.code_description ?? null, meaning: r.meaning ?? null });
  }
  return legend;
}

/** HubSpot wants unique option labels within a property; on a collision (two codes
 * sharing a Meaning) suffix the code so both remain distinct. Values are already
 * unique (one option per code). */
function dedupeLabels(opts: { label: string; value: string }[]): HsOption[] {
  const used = new Set<string>();
  return opts.map((o, i) => {
    let label = o.label;
    if (used.has(label)) label = `${o.label} (${o.value})`;
    while (used.has(label)) label = `${label}.`;
    used.add(label);
    return { label, value: o.value, displayOrder: i, hidden: false };
  });
}

/** Build the three desired option lists from the union of legend codes and codes
 * actually present in the snapshot (so every pushed value has an option). */
function buildRiskOptions(codes: Iterable<string>, legend: RiskLegend): RiskOptionSet {
  const sorted = [...new Set(codes)].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return {
    risk_code: dedupeLabels(sorted.map((c) => ({ label: c, value: c }))),
    risk_code_description: dedupeLabels(sorted.map((c) => ({ label: legend.get(c)?.description || c, value: c }))),
    risk_code_meaning: dedupeLabels(
      sorted.map((c) => {
        const e = legend.get(c);
        return { label: e?.meaning || e?.description || c, value: c };
      }),
    ),
  };
}

/** Merge desired options over the current ones, additively: desired labels/order
 * win, current-only values are kept (so records on old codes don't break). Returns
 * null when nothing changed (skip the PATCH). */
function mergeOptions(current: { label: string; value: string }[], desired: HsOption[]): HsOption[] | null {
  const haveValues = new Set(desired.map((o) => o.value));
  const merged: HsOption[] = [...desired];
  for (const c of current) {
    if (!haveValues.has(c.value)) merged.push({ label: c.label, value: c.value, displayOrder: merged.length, hidden: false });
  }
  const curLabelByValue = new Map(current.map((o) => [o.value, o.label]));
  let changed = merged.length !== current.length;
  if (!changed) {
    for (const o of merged) {
      if (curLabelByValue.get(o.value) !== o.label) {
        changed = true;
        break;
      }
    }
  }
  return changed ? merged : null;
}

/** Create/migrate one enumeration prop to the desired options. Handles the
 * text -> enumeration migration (HubSpot can't change `type` in place → delete +
 * recreate) and additive option updates once it's an enum. */
async function ensureRiskEnum(
  token: string,
  prop: string,
  desired: HsOption[],
  existing: { name: string; type?: string }[],
): Promise<void> {
  const create = () =>
    hs(token, "/crm/v3/properties/orders", {
      method: "POST",
      body: JSON.stringify({
        name: prop,
        label: labelFor(prop),
        groupName: "open_orders",
        type: "enumeration",
        fieldType: "select",
        options: desired,
      }),
    });

  const found = existing.find((p) => p.name === prop);
  if (!found) {
    await create();
    console.log(`[open-orders-sync] created orders enum ${prop} (${desired.length} options)`);
    return;
  }
  if (found.type !== "enumeration") {
    await hs(token, `/crm/v3/properties/orders/${prop}`, { method: "DELETE" });
    await create();
    console.log(`[open-orders-sync] migrated orders.${prop} ${found.type} -> enumeration (${desired.length} options)`);
    return;
  }
  // Already an enum — sync options additively.
  const cur = await hs<{ options?: { label: string; value: string }[] }>(token, `/crm/v3/properties/orders/${prop}`);
  const merged = mergeOptions(cur.options ?? [], desired);
  if (merged) {
    await hs(token, `/crm/v3/properties/orders/${prop}`, { method: "PATCH", body: JSON.stringify({ options: merged }) });
    console.log(`[open-orders-sync] updated orders.${prop} options (${merged.length})`);
  }
}

/** Ensure all three risk-code dropdowns exist with up-to-date options. */
async function ensureRiskEnums(token: string, riskOptions: RiskOptionSet): Promise<void> {
  const existing = await hs<{ results: { name: string; type?: string }[] }>(token, "/crm/v3/properties/orders");
  for (const prop of RISK_ENUM_PROPS) {
    await ensureRiskEnum(token, prop, riskOptions[prop], existing.results);
  }
}

/** Create the property group, line key, missing props, and the rep-code
 * association type — all idempotent (409 = already exists). */
async function ensureSchema(token: string, riskOptions: RiskOptionSet): Promise<{ repCodeTypeId: number | null }> {
  // Property group on both objects.
  for (const obj of ["orders", "line_items"] as Obj[]) {
    try {
      await hs(token, `/crm/v3/properties/${obj}/groups`, {
        method: "POST",
        body: JSON.stringify({ name: "open_orders", label: "Open Orders (SAP)" }),
      });
    } catch (e) {
      if (!String(e).includes("409")) throw e;
    }
  }
  const ensureProps = async (obj: Obj, defs: FieldDef[]) => {
    const existing = await hs<{ results: { name: string }[] }>(token, `/crm/v3/properties/${obj}`);
    const have = new Set(existing.results.map((p) => p.name));
    for (const d of defs) {
      if (!d.create || have.has(d.prop)) continue;
      const hsType = d.type === "number" ? { type: "number", fieldType: "number" } : d.type === "date" ? { type: "date", fieldType: "date" } : { type: "string", fieldType: "text" };
      await hs(token, `/crm/v3/properties/${obj}`, {
        method: "POST",
        body: JSON.stringify({ name: d.prop, label: labelFor(d.prop), groupName: "open_orders", ...hsType }),
      });
      console.log(`[open-orders-sync] created ${obj} property ${d.prop}`);
    }
  };
  await ensureProps("orders", ORDER_FIELDS);
  await ensureProps("line_items", LINE_FIELDS);

  // Risk Code dropdowns (create/migrate to enumeration + sync legend options).
  await ensureRiskEnums(token, riskOptions);

  // Line key: unique so_posnr (SO + line position) on line items.
  const liProps = await hs<{ results: { name: string; hasUniqueValue?: boolean }[] }>(token, "/crm/v3/properties/line_items");
  if (!liProps.results.some((p) => p.name === "so_posnr")) {
    await hs(token, "/crm/v3/properties/line_items", {
      method: "POST",
      body: JSON.stringify({
        name: "so_posnr",
        label: "SO + Line (key)",
        type: "string",
        fieldType: "text",
        groupName: "open_orders",
        hasUniqueValue: true,
      }),
    });
    console.log("[open-orders-sync] created line_items unique key so_posnr");
  }

  // Order ↔ Rep Code association type (none exists yet).
  let repCodeTypeId: number | null = null;
  try {
    const labels = await hs<{ results: { typeId: number }[] }>(token, `/crm/v4/associations/orders/${REP_CODE_OBJECT}/labels`);
    if (labels.results[0]) {
      repCodeTypeId = labels.results[0].typeId;
    } else {
      const created = await hs<{ results: { typeId: number }[] }>(token, `/crm/v4/associations/orders/${REP_CODE_OBJECT}/labels`, {
        method: "POST",
        body: JSON.stringify({ label: "Rep Code", name: "order_to_rep_code" }),
      });
      repCodeTypeId = created.results?.[0]?.typeId ?? null;
      console.log(`[open-orders-sync] created Order↔RepCode association type ${repCodeTypeId}`);
    }
  } catch (e) {
    console.warn(`[open-orders-sync] Order↔RepCode association unavailable (skipping): ${String(e).slice(0, 160)}`);
  }
  return { repCodeTypeId };
}

function labelFor(prop: string): string {
  return prop.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/Atp/g, "ATP").replace(/Scm/g, "SCM");
}

/** Resolve "First Last" AMT-rep names → HubSpot owner ids. */
async function ownerMap(token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let after: string | undefined;
  do {
    const page = await hs<{ results: { id: string; firstName?: string; lastName?: string }[]; paging?: { next?: { after?: string } } }>(
      token,
      `/crm/v3/owners?limit=100${after ? `&after=${after}` : ""}`,
    );
    for (const o of page.results) {
      const name = `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim().toLowerCase();
      if (name) map.set(name, o.id);
    }
    after = page.paging?.next?.after;
  } while (after);
  return map;
}

/** Batch-read object ids by a unique idProperty (account number / rep code). */
async function resolveIds(token: string, obj: string, idProperty: string, values: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < values.length; i += BATCH) {
    const inputs = values.slice(i, i + BATCH).map((v) => ({ id: v }));
    try {
      const res = await hs<{ results: { id: string; properties: Record<string, string> }[] }>(
        token,
        `/crm/v3/objects/${obj}/batch/read`,
        { method: "POST", body: JSON.stringify({ idProperty, properties: [idProperty], inputs }) },
      );
      for (const r of res.results) {
        const key = r.properties[idProperty];
        if (key) map.set(key, r.id);
      }
    } catch (e) {
      // A batch where NONE match returns 207 with errors; that's fine — skip.
      if (!String(e).includes("207")) console.warn(`[open-orders-sync] ${obj} id resolve batch failed: ${String(e).slice(0, 120)}`);
    }
  }
  return map;
}

/** Resolve rep codes → their HubSpot id + channel in one read (channel goes on
 * the order; id drives the Order↔RepCode association). */
async function resolveRepInfo(token: string, repCodes: string[]): Promise<Map<string, { id: string; channel?: string }>> {
  const map = new Map<string, { id: string; channel?: string }>();
  for (let i = 0; i < repCodes.length; i += BATCH) {
    const inputs = repCodes.slice(i, i + BATCH).map((v) => ({ id: v }));
    try {
      const res = await hs<{ results: { id: string; properties: Record<string, string> }[] }>(
        token,
        `/crm/v3/objects/${REP_CODE_OBJECT}/batch/read`,
        { method: "POST", body: JSON.stringify({ idProperty: "rep_code", properties: ["rep_code", "channel"], inputs }) },
      );
      for (const r of res.results) {
        const key = r.properties["rep_code"];
        if (key) map.set(key, { id: r.id, channel: r.properties["channel"] || undefined });
      }
    } catch (e) {
      if (!String(e).includes("207")) console.warn(`[open-orders-sync] rep code resolve batch failed: ${String(e).slice(0, 120)}`);
    }
  }
  return map;
}

async function batchUpsert(token: string, obj: Obj, inputs: { idProperty: string; id: string; properties: Record<string, string | number> }[]): Promise<Map<string, string>> {
  const idByKey = new Map<string, string>(); // upsert key value -> HubSpot id
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
    if ((i / BATCH) % 10 === 0) console.log(`[open-orders-sync] upserted ${obj} ~${Math.min(i + BATCH, inputs.length)}/${inputs.length}`);
  }
  return idByKey;
}

async function batchAssociate(token: string, fromObj: string, toObj: string, typeId: number, category: "HUBSPOT_DEFINED" | "USER_DEFINED", pairs: { from: string; to: string }[]): Promise<void> {
  for (let i = 0; i < pairs.length; i += BATCH) {
    const inputs = pairs.slice(i, i + BATCH).map((p) => ({
      from: { id: p.from },
      to: { id: p.to },
      types: [{ associationCategory: category, associationTypeId: typeId }],
    }));
    try {
      await hs(token, `/crm/v4/associations/${fromObj}/${toObj}/batch/create`, { method: "POST", body: JSON.stringify({ inputs }) });
    } catch (e) {
      console.warn(`[open-orders-sync] associate ${fromObj}->${toObj} batch failed: ${String(e).slice(0, 160)}`);
    }
  }
}

export async function syncOpenOrdersToHubspot(
  sb: SupabaseClient,
  token: string,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  // Current open snapshot.
  const rows: OpenOrderDbRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("open_orders").select("*").eq("is_open", true).range(from, from + 999);
    if (error) throw new Error(`open_orders read failed: ${error.message}`);
    const page = (data ?? []) as OpenOrderDbRow[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  console.log(`[open-orders-sync] HubSpot push: ${rows.length} open line rows`);
  if (rows.length === 0) return;

  // Risk Code dropdowns: load the code -> meaning legend and build the three
  // option sets from the union of legend codes and codes present in the snapshot
  // (so every value we push has a matching option — no "invalid enum" failures).
  const legend = await loadRiskLegend(sb);
  const dataCodes = new Set<string>();
  for (const r of rows) {
    const c = coerce(rawField(r.raw_json ?? {}, "Risk Code"), "string");
    if (typeof c === "string" && c) dataCodes.add(c);
  }
  const riskOptions = buildRiskOptions([...legend.keys(), ...dataCodes], legend);

  // Group by SO for orders (last line wins for order-level fields).
  const orderBySo = new Map<string, OpenOrderDbRow>();
  for (const r of rows) orderBySo.set(r.so, r);

  // Order total = sum of its line totals (SAP Line Net Value).
  const totalBySo = new Map<string, number>();
  for (const r of rows) {
    const v = Number(r.line_net_value);
    if (Number.isFinite(v)) totalBySo.set(r.so, (totalBySo.get(r.so) ?? 0) + v);
  }

  // Resolve owners + rep-code info (id + channel) up front. The order's channel
  // is its rep code's (Sales Group) channel — copied straight from the Rep Code
  // object, same option set on both. The rep id also drives the association.
  const owners = opts.dryRun ? new Map<string, string>() : await ownerMap(token);
  const ownerFor = (name: string | null) => (name ? owners.get(name.trim().toLowerCase()) : undefined);
  const groups = [...new Set([...orderBySo.values()].map((r) => r.sales_group).filter(Boolean) as string[])];
  const repInfo = await resolveRepInfo(token, groups);

  // Build order upsert inputs.
  let channelSet = 0;
  const orderInputs = [...orderBySo.values()].map((r) => {
    const properties = buildOrderProperties(r);
    const total = totalBySo.get(r.so);
    if (total !== undefined) properties["hs_total_price"] = Math.round(total * 100) / 100;
    const oid = ownerFor(r.amt_rep);
    if (oid) properties["hubspot_owner_id"] = oid;
    const channel = r.sales_group ? repInfo.get(r.sales_group)?.channel : undefined;
    if (channel) {
      properties["channel"] = channel;
      channelSet++;
    }
    return { idProperty: "sales_order_id", id: r.so, properties };
  });
  console.log(`[open-orders-sync] channel set on ${channelSet}/${orderInputs.length} orders (from rep code)`);

  // Build line upsert inputs (one per SO+POSNR), deduped by key so a batch never
  // carries a duplicate id (staging is already unique on (so, posnr)).
  const lineByKey = new Map<
    string,
    { idProperty: string; id: string; _so: string; properties: Record<string, string | number> }
  >();
  for (const r of rows) {
    const key = `${r.so}-${r.posnr}`;
    lineByKey.set(key, { idProperty: "so_posnr", id: key, _so: r.so, properties: buildLineProperties(r) });
  }
  const lineInputs = [...lineByKey.values()];

  if (opts.dryRun) {
    console.log(`[open-orders-sync] DRY RUN: ${orderInputs.length} orders, ${lineInputs.length} line items`);
    console.log("[open-orders-sync] sample order:", JSON.stringify(orderInputs[0], null, 1));
    console.log("[open-orders-sync] sample line:", JSON.stringify(lineInputs[0], null, 1));
    for (const p of RISK_ENUM_PROPS) {
      console.log(`[open-orders-sync] DRY RUN ${p}: ${riskOptions[p].length} options (sample):`, riskOptions[p].slice(0, 3));
    }
    return;
  }

  const { repCodeTypeId } = await ensureSchema(token, riskOptions);

  // Upsert orders, then line items.
  const orderIdBySo = await batchUpsert(token, "orders", orderInputs);
  const lineIdByKey = await batchUpsert(
    token,
    "line_items",
    lineInputs.map(({ _so, ...x }) => x),
  );

  // Associations.
  // Line Item -> Order.
  const liToOrder: { from: string; to: string }[] = [];
  for (const li of lineInputs) {
    const oid = orderIdBySo.get(li._so);
    const lid = lineIdByKey.get(li.id);
    if (oid && lid) liToOrder.push({ from: oid, to: lid });
  }
  await batchAssociate(token, "orders", "line_items", ORDER_TO_LINE_ITEM_TYPE, "HUBSPOT_DEFINED", liToOrder);

  // Order -> Company (by account number). Companies store the SAP account
  // inconsistently — some zero-padded ("0002011239"), some stripped
  // ("2011239") — so resolve by BOTH forms.
  const strip = (a: string) => a.replace(/^0+/, "") || a;
  const accounts = [...new Set([...orderBySo.values()].map((r) => r.customer_account).filter(Boolean) as string[])];
  const candidates = [...new Set(accounts.flatMap((a) => [a, strip(a)]))];
  const companyByAccount = await resolveIds(token, "companies", "account_number_", candidates);
  const companyFor = (a: string) => companyByAccount.get(a) ?? companyByAccount.get(strip(a));
  const orderToCompany: { from: string; to: string }[] = [];
  for (const r of orderBySo.values()) {
    const oid = orderIdBySo.get(r.so);
    const cid = r.customer_account ? companyFor(r.customer_account) : undefined;
    if (oid && cid) orderToCompany.push({ from: oid, to: cid });
  }
  await batchAssociate(token, "orders", "companies", ORDER_TO_COMPANY_TYPE, "HUBSPOT_DEFINED", orderToCompany);
  console.log(`[open-orders-sync] Order→Company: ${orderToCompany.length}/${orderBySo.size} matched by account number`);

  // Order -> Rep Code (by Sales Group; reuses repInfo resolved above).
  if (repCodeTypeId != null) {
    const orderToRep: { from: string; to: string }[] = [];
    for (const r of orderBySo.values()) {
      const oid = orderIdBySo.get(r.so);
      const rid = r.sales_group ? repInfo.get(r.sales_group)?.id : undefined;
      if (oid && rid) orderToRep.push({ from: oid, to: rid });
    }
    await batchAssociate(token, "orders", REP_CODE_OBJECT, repCodeTypeId, "USER_DEFINED", orderToRep);
    console.log(`[open-orders-sync] Order→RepCode: ${orderToRep.length}/${orderBySo.size} matched by Sales Group`);
  }

  console.log(
    `[open-orders-sync] HubSpot push done: ${orderIdBySo.size} orders, ${lineIdByKey.size} line items, ${liToOrder.length} line→order links`,
  );
}
