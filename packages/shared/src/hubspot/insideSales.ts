/**
 * Inside-Sales (ISR) resolution — the single deterministic replacement for the
 * old HubSpot workflow chain (a stale hardcoded AMT->name switch feeding a fuzzy
 * name->owner match feeding a rollup). The authoritative mapping is the
 * "Rep Code RSM ISR Mapping" sheet (Supabase `rep_codes`): amt_rep_code -> ISR
 * and rep_code -> ISR. Names are resolved to HubSpot owner ids by the caller; the
 * pure logic here only turns (amt code | rep code(s)) + owner maps into the exact
 * Company properties to write.
 *
 * The field model (verified live):
 *  - `inside_sales_rep_from_sap` (writable) = the account's OWN ISR, from its AMT
 *    code (`inside_sales_rep`). THIS is the only company field this module sets.
 *  - `inside_sales_manager_1`/`_2` (CALCULATED, readOnlyValue=true) = the company's
 *    REP-CODE association owner(s) — a different concept (the rep agency's ISR).
 *    HubSpot derives them from the rep code owner we maintain elsewhere; setting
 *    them returns READ_ONLY_VALUE. We never touch them.
 *  - `inside_sales_managers` (writable) = the rollup of manager_1/_2, maintained by
 *    the rep-code workflow (1745459869). NOT the AMT ISR — we never write it here.
 *
 * So this module resolves the AMT code to an owner and writes only
 * `inside_sales_rep_from_sap`. The rep-code owner side (which drives manager_1/_2)
 * is the caller's job. Writes NOTHING on an unresolved/absent AMT (never wipes).
 */

/** The Company ISR property this module sets (the rep-agency fields are not ours). */
export const INSIDE_SALES_FIELDS = ["inside_sales_rep_from_sap"] as const;

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
 * Compute the Company ISR property to write from the company's AMT code. ONLY
 * `inside_sales_rep_from_sap` (the account's own SAP/AMT inside-sales person) is
 * ours to set. The rep-agency side — `inside_sales_manager_1`/`_2` (CALCULATED
 * from the company's rep-code owner) and `inside_sales_managers` (their rollup,
 * maintained by the rep-code workflow) — is handled entirely by the rep-code
 * mechanism, not here. Writes NOTHING on an unresolved AMT (never wipes), and
 * NOTHING for a no-AMT company (its ISR lives in the calculated manager fields).
 */
export function computeInsideSalesFields(
  input: { amtRepCode?: unknown; salesRepCode?: unknown },
  resolvers: InsideSalesResolvers,
): InsideSalesResult {
  const amt = input.amtRepCode == null ? "" : String(input.amtRepCode).trim();
  const properties: Record<string, string> = {};
  if (!amt) return { properties, path: "none", unresolved: [] };
  const owner = resolvers.amtToOwner.get(amt);
  if (!owner) return { properties, path: "amt", unresolved: [amt] };
  properties.inside_sales_rep_from_sap = owner;
  return { properties, path: "amt", unresolved: [] };
}
