import { asString, field } from "./headers.js";
import type { ParseError, ParseResult } from "./types.js";

/**
 * Customer→parent parser for the SAP CUSTOMERS CSV (Imports/CUSTOMERS-*.csv on
 * the ExaVault SFTP). One row per customer account; the "Parent" column carries
 * the parent account number — SELF-referencing when the customer is its own
 * parent (top of its hierarchy), which we normalize to null (no association).
 *
 * The companion PARENTS-*.csv ("Parent Name" / "Parent Reference") is the
 * parent legend; its name embeds the account ("2000002 FERGUSON ENTERPRISES
 * INC"). We carry customer/parent display names so missing HubSpot companies
 * can be created with a proper name (per Davis 2026-07-07: create companies we
 * don't have; other customer fields already flow via the SAP→Worker push).
 */

export interface CustomerParentRow {
  /** Customer account number ("Customer Reference"). */
  account: string;
  /** "Customer Name" with the leading account number stripped. */
  customerName: string | null;
  /** Parent account number, or null when self-parented / blank. */
  parentAccount: string | null;
  /** Full upstream row for push-time access to the other columns. */
  raw: Record<string, unknown>;
}

/** "2000002 FERGUSON ENTERPRISES INC" → "FERGUSON ENTERPRISES INC". */
export function stripAccountPrefix(name: string, account?: string): string {
  const s = name.trim();
  if (account && s.startsWith(account)) return s.slice(account.length).trim();
  return s.replace(/^\d{6,}\s+/, "");
}

export function parseCustomerParents(
  rows: Record<string, unknown>[],
): ParseResult<CustomerParentRow> {
  const errors: ParseError[] = [];
  let duplicates = 0;
  let selfParented = 0;
  const byAccount = new Map<string, CustomerParentRow>();

  rows.forEach((raw, i) => {
    const rowIndex = i + 2; // header = row 1

    const account = asString(field(raw, "Customer Reference"));
    if (!account) {
      errors.push({ rowIndex, messages: ["missing Customer Reference"] });
      return;
    }

    const name = asString(field(raw, "Customer Name"));
    // SAP uses "-" as an empty-value placeholder.
    const parentRaw = asString(field(raw, "Parent"));
    let parentAccount: string | null = parentRaw && parentRaw !== "-" ? parentRaw : null;
    if (parentAccount === account) {
      parentAccount = null;
      selfParented++;
    }

    if (byAccount.has(account)) duplicates++;
    byAccount.set(account, {
      account,
      customerName: name ? stripAccountPrefix(name, account) : null,
      parentAccount,
      raw,
    });
  });

  return {
    valid: [...byAccount.values()],
    errors,
    stats: { rows: rows.length, duplicates, selfParented },
  };
}

export interface ParentRefRow {
  /** Parent account number ("Parent Reference"). */
  account: string;
  /** "Parent Name" with the leading account number stripped. */
  name: string | null;
}

/** Parse the PARENTS legend (account → display name). */
export function parseParentRefs(
  rows: Record<string, unknown>[],
): ParseResult<ParentRefRow> {
  const errors: ParseError[] = [];
  let duplicates = 0;
  const byAccount = new Map<string, ParentRefRow>();

  rows.forEach((raw, i) => {
    const rowIndex = i + 2;
    const account = asString(field(raw, "Parent Reference"));
    if (!account) {
      errors.push({ rowIndex, messages: ["missing Parent Reference"] });
      return;
    }
    const name = asString(field(raw, "Parent Name"));
    if (byAccount.has(account)) duplicates++;
    byAccount.set(account, {
      account,
      name: name ? stripAccountPrefix(name, account) : null,
    });
  });

  return {
    valid: [...byAccount.values()],
    errors,
    stats: { rows: rows.length, duplicates },
  };
}
