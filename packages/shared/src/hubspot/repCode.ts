/**
 * Rep Code custom-object sync logic (pure) — absorbs the "Account # to Rep Code
 * Syncing" HubSpot workflow, which copies fields from a rep code's associated
 * "Rep Agency" company onto the Rep Code object, and feeds the inactive-label
 * decision.
 *
 * The Rep Code object's exact property internal names (for the labels "Agency",
 * "City", "Brands") and its `status` option values are NOT known statically, so we
 * resolve them from the live property schema (`GET /crm/v3/properties/2-41537429`)
 * via {@link resolveRepCodeSchema}. The HTTP lives in the API Worker and
 * territory-sync; this module is the field/decision logic so it has one home + tests.
 */

import { stateAbbrToName } from "./state.js";

/** Rep Code custom object type id. */
export const REP_CODE_OBJECT = "2-41537429";

/** Minimal view of a HubSpot property definition (`GET /crm/v3/properties/{obj}`). */
export interface HsPropertyDef {
  name: string;
  label?: string;
  options?: { label: string; value: string }[];
}

/**
 * Rep Code property internal names + `status` option values, resolved from the live
 * schema by the labels seen in the workflow ("Agency"/"City"/"Brands"/"State"/
 * "Status"). Anything unresolved is null → the caller skips that field rather than
 * writing to a guessed property.
 */
export interface RepCodeSchema {
  agency: string | null;
  city: string | null;
  brands: string | null;
  state: string | null;
  status: string | null;
  /** `status` option value whose label is "Active" / "Inactive". */
  statusActiveValue: string | null;
  statusInactiveValue: string | null;
}

/** Resolve property names by label, falling back to the obvious internal name when
 * that property actually exists (covers `state`/`status`, already confirmed). */
export function resolveRepCodeSchema(props: HsPropertyDef[]): RepCodeSchema {
  const byLabel = new Map<string, string>();
  const byName = new Map<string, HsPropertyDef>();
  for (const p of props) {
    if (p.label) byLabel.set(p.label.trim().toLowerCase(), p.name);
    byName.set(p.name, p);
  }
  const nameFor = (label: string, fallback: string): string | null =>
    byLabel.get(label.toLowerCase()) ?? (byName.has(fallback) ? fallback : null);

  const statusName = nameFor("Status", "status");
  const statusProp = statusName ? byName.get(statusName) : undefined;
  const optByLabel = (label: string): string | null =>
    statusProp?.options?.find((o) => o.label.trim().toLowerCase() === label.toLowerCase())?.value ?? null;

  return {
    agency: nameFor("Agency", "agency"),
    city: nameFor("City", "city"),
    brands: nameFor("Brands", "brands"),
    state: nameFor("State", "state"),
    status: statusName,
    statusActiveValue: optByLabel("Active"),
    statusInactiveValue: optByLabel("Inactive"),
  };
}

/** Agency-company fields used to populate the Rep Code (workflow B). */
export interface RepCodeSyncInputs {
  companyName?: unknown; // → Agency
  city?: unknown; // → City
  productBrand?: unknown; // → Brands
  stateAbbr?: unknown; // → state (2-letter → full name)
  /** Company `status` value ("true"=Active / "false"=Inactive), or null if unknown. */
  companyStatus?: "true" | "false" | null;
}

/**
 * Build the Rep Code property patch from the agency company's fields. Skips blanks
 * and unresolved property names; maps the 2-letter state to its full name and the
 * company status ("false"/"true") to the rep code's Inactive/Active option value.
 * Pure — diff against the rep code's current values before writing.
 */
export function repCodeSyncProperties(
  inputs: RepCodeSyncInputs,
  schema: RepCodeSchema,
): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (name: string | null, value: unknown): void => {
    if (!name || value === null || value === undefined) return;
    const s = String(value).trim();
    if (s) out[name] = s;
  };
  put(schema.agency, inputs.companyName);
  put(schema.city, inputs.city);
  put(schema.brands, inputs.productBrand);
  put(schema.state, stateAbbrToName(inputs.stateAbbr));
  if (inputs.companyStatus != null && schema.status) {
    const v = inputs.companyStatus === "false" ? schema.statusInactiveValue : schema.statusActiveValue;
    if (v) out[schema.status] = v;
  }
  return out;
}

/** True/false = the rep code's agency company is Inactive/Active; null = unknown
 * (no status this push) → leave the inactive label to the reconcile backstop. */
export function repCodeInactiveFromCompanyStatus(
  companyStatus: "true" | "false" | null | undefined,
): boolean | null {
  if (companyStatus === "false") return true;
  if (companyStatus === "true") return false;
  return null;
}
