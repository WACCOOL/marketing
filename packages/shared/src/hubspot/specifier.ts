/**
 * Specifier-association logic (pure) — absorbs the 5 "Associated Specifier N to
 * Opportunity" HubSpot workflows. A SAP quote can carry up to 5 specifiers, stored
 * on the Deal as flat `specifier_account_number_1..5` properties (see DEAL_FIELD_MAP
 * in mapping.ts). Each value identifies a Company that should be associated to the
 * Deal with the "Specifier" association label.
 *
 * This module is just the value-extraction + account-number forms; the resolution
 * cascade (account number → record id → Sugar account number) and the v4 label
 * association are HTTP, so they live in the API Worker (hubspotPush.ts) and
 * territory-sync (insideSales.ts) — but they share these helpers + tests.
 */

/** Display name of the company↔deal USER_DEFINED association label. */
export const SPECIFIER_LABEL = "Specifier";

/** The specifier slots a Deal can carry (specifier_account_number_1..5). */
export const SPECIFIER_SLOTS = [1, 2, 3, 4, 5] as const;

/**
 * The distinct, non-empty specifier account numbers on a record. Reads
 * `specifier_account_number_1..5` (identical names on the raw SAP payload and on a
 * HubSpot deal's `properties`), trims, drops blanks, and dedupes — so a deal that
 * lists the same specifier in two slots associates that company once.
 */
export function specifierAccountNumbers(props: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of SPECIFIER_SLOTS) {
    const raw = props[`specifier_account_number_${n}`];
    if (raw == null) continue;
    const v = String(raw).trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Account-number forms a HubSpot record may store for a given value: the value as
 * given, with leading zeros stripped, and (when numeric) zero-padded to 10. Lets a
 * lookup match whether SAP sent "0000123456", "123456", etc.
 */
export function accountForms(accountNumber: string): string[] {
  const forms = new Set<string>();
  const acct = accountNumber.trim();
  if (!acct) return [];
  forms.add(acct);
  const stripped = acct.replace(/^0+/, "");
  if (stripped) forms.add(stripped);
  if (/^\d+$/.test(stripped)) forms.add(stripped.padStart(10, "0"));
  return [...forms];
}
