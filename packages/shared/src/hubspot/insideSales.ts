/**
 * Inside-Sales (ISR) resolution — the single deterministic replacement for the
 * old HubSpot workflow chain (a stale hardcoded AMT->name switch feeding a fuzzy
 * name->owner match feeding a rollup). The authoritative mapping is the
 * "Rep Code RSM ISR Mapping" sheet (Supabase `rep_codes`): amt_rep_code -> ISR
 * and rep_code -> ISR. Names are resolved to HubSpot owner ids by the caller; the
 * pure logic here only turns (amt code | rep code(s)) + owner maps into the exact
 * Company properties to write.
 *
 * Hybrid model (confirmed with the business):
 *  - Company HAS its own AMT code (`inside_sales_rep`, ~21.6k distributor/customer
 *    accounts): one ISR from amt -> owner.
 *  - Company has NO AMT but IS serviced by rep code(s) (~9.5k design/spec accounts,
 *    `sales_rep_code` can pack multiple like "OS, OSX"): one ISR per rep code.
 *
 * Writable fields (verified live): only `inside_sales_rep_from_sap` (single-select,
 * owner id) and `inside_sales_managers` (checkbox, owner ids joined by ";"). The
 * `inside_sales_manager_1` / `_2` properties are CALCULATED (readOnlyValue=true) —
 * HubSpot derives them from `inside_sales_managers`, so we must NOT set them (a
 * READ_ONLY_VALUE 400). We therefore write the single ISR (AMT path) or all ISRs
 * (rep-code path) into `inside_sales_managers`, and manager_1/_2 follow automatically.
 * "" clears a property. The Rep-Code-owner side (gated on the company itself being a
 * rep) is handled by the caller, not here.
 */

/** The writable Company ISR properties this module sets (manager_1/_2 are calculated). */
export const INSIDE_SALES_FIELDS = ["inside_sales_rep_from_sap", "inside_sales_managers"] as const;

/** Multi-value (checkbox) enum: HubSpot joins selected values with ";". */
export const INSIDE_SALES_MANAGERS_SEP = ";";

export interface InsideSalesResolvers {
  /** amt_rep_code (string) -> HubSpot owner id. */
  amtToOwner: Map<string, string>;
  /** rep_code (UPPERCASE) -> HubSpot owner id. */
  repCodeToOwner: Map<string, string>;
}

export interface InsideSalesResult {
  /** HubSpot Company properties to write (resolved sets + intentional ""-clears). */
  properties: Record<string, string>;
  /** Which branch produced the result. */
  path: "amt" | "rep_code" | "none";
  /** amt codes / rep codes that had no owner (for dashboard flagging). */
  unresolved: string[];
}

/**
 * Split a Company `sales_rep_code` value into distinct rep codes.
 * SAP/HubSpot packs multiples as "OS, OSX", "SC/SCX", "PLM/PLD", or space-separated
 * ("SDA SDX", "TLA TLX"). Rep codes never contain whitespace, so split on it too.
 */
export function parseRepCodes(salesRepCode: unknown): string[] {
  const raw = salesRepCode == null ? "" : String(salesRepCode);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,/;|]+/)) {
    const code = part.trim().toUpperCase();
    if (code && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

/**
 * Compute the Company ISR properties from its AMT code (preferred) or its rep
 * code(s). Returns only the properties to write; on a total resolution failure
 * (a known amt/rep code that maps to no owner) it writes NOTHING — never wipes
 * existing values on a lookup miss. `amtRepCode` is the Company's own
 * `inside_sales_rep` value; `salesRepCode` is its `sales_rep_code` value.
 */
export function computeInsideSalesFields(
  input: { amtRepCode?: unknown; salesRepCode?: unknown },
  resolvers: InsideSalesResolvers,
): InsideSalesResult {
  const amt = input.amtRepCode == null ? "" : String(input.amtRepCode).trim();
  const properties: Record<string, string> = {};
  const unresolved: string[] = [];

  // AMT path — the company has its own inside-sales code (one ISR).
  if (amt) {
    const owner = resolvers.amtToOwner.get(amt);
    if (!owner) return { properties, path: "amt", unresolved: [amt] };
    properties.inside_sales_rep_from_sap = owner;
    properties.inside_sales_managers = owner; // manager_1/_2 are calculated from this
    return { properties, path: "amt", unresolved };
  }

  // Rep-code path — no AMT; inherit ISR(s) from the servicing rep code(s).
  const codes = parseRepCodes(input.salesRepCode);
  if (!codes.length) return { properties, path: "none", unresolved };

  const owners: string[] = [];
  for (const code of codes) {
    const owner = resolvers.repCodeToOwner.get(code);
    if (!owner) {
      unresolved.push(code);
      continue;
    }
    if (!owners.includes(owner)) owners.push(owner);
  }
  if (!owners.length) return { properties, path: "rep_code", unresolved };

  properties.inside_sales_rep_from_sap = ""; // no AMT — clear the SAP-derived field
  // All servicing ISRs into the checkbox; manager_1/_2 are calculated from it.
  properties.inside_sales_managers = owners.join(INSIDE_SALES_MANAGERS_SEP);
  return { properties, path: "rep_code", unresolved };
}
