import type { ParseError, ParseResult } from "./types.js";

/**
 * Material Bank order-feed parser (pure).
 *
 * Material Bank drops XML files on its SFTP (`/Outbound/`, ISO-8859-1). The CLI
 * (apps/material-bank-sync) decodes + XML-parses the file (fast-xml-parser) and
 * hands the resulting object tree here; this module owns every shape hazard so
 * the mapping is unit-testable without any XML/SFTP dependency.
 *
 * Feed shape (from the retired Make.com scenario's mappings): `root.row[]` is one
 * element per sample ORDER; each carries the contact/company/address scalars and
 * a nested `row[]` of SKU line rows. The project fields (ProjectName, budget,
 * completion month/year, …) have been observed at BOTH levels depending on the
 * export, so scalars are looked up on the order element first and then inside
 * its nested rows ({@link pick}).
 *
 * XML parsers also collapse a single child element to a bare object (no array)
 * and wrap repeated leaf values in arrays — {@link asArray}/{@link firstText}
 * normalize both.
 */

export interface MaterialBankLine {
  /** SKU — becomes the line item's name/hs_sku. */
  sku: string;
  /** QTYORIGINAL; null when missing/unparseable. */
  quantity: number | null;
  /** Color — becomes the line item description. */
  color: string | null;
}

export interface MaterialBankOrder {
  /** ORDERID — the dedupe key (HubSpot deal `material_bank_order_id`). */
  orderId: string;
  contact: {
    /** Full name as provided ("First Last…"). */
    name: string | null;
    email: string | null;
    phone: string | null;
    mobilePhone: string | null;
    /** CONTACTPREFERENCE (e.g. Email/Phone). */
    preference: string | null;
    /** Job title. */
    title: string | null;
  };
  company: {
    name: string | null;
    /** CompanyPractice — drives the designer routing (residential/commercial). */
    practice: string | null;
  };
  address: {
    street1: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
  };
  project: {
    name: string | null;
    description: string | null;
    phase: string | null;
    /** Material Bank's own project-type label (context for the classifier). */
    type: string | null;
    /** Free-text budget ("$50k-$100k", "over $1M") — see {@link parseBudgetAmount}. */
    budgetRaw: string | null;
    /** ExpectedProjectCompletionMonth — name ("January"), abbreviation, or number. */
    completionMonth: string | null;
    completionYear: string | null;
  };
  lines: MaterialBankLine[];
}

/** Normalize an XML-parsed value that may be a single node or a repeated list. */
export function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * First non-empty text of an XML-parsed leaf: unwraps arrays, `#text` wrappers,
 * numbers. Returns null for missing/blank.
 */
export function firstText(v: unknown): string | null {
  for (const item of Array.isArray(v) ? v : [v]) {
    if (item == null) continue;
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      const s = String(item).trim();
      if (s) return s;
      continue;
    }
    if (typeof item === "object") {
      const text = (item as Record<string, unknown>)["#text"];
      if (text != null) {
        const s = String(text).trim();
        if (s) return s;
      }
    }
  }
  return null;
}

/**
 * Look a field up on the order element, then (fields drift between levels across
 * Material Bank exports) inside its nested line rows.
 */
function pick(order: Record<string, unknown>, field: string): string | null {
  const own = firstText(order[field]);
  if (own != null) return own;
  for (const line of asArray(order["row"])) {
    if (line && typeof line === "object") {
      const v = firstText((line as Record<string, unknown>)[field]);
      if (v != null) return v;
    }
  }
  return null;
}

/** The order elements of a parsed Material Bank document (tolerates a missing root). */
export function materialBankOrderElements(doc: unknown): Record<string, unknown>[] {
  if (!doc || typeof doc !== "object") return [];
  const root = (doc as Record<string, unknown>)["root"] ?? doc;
  if (!root || typeof root !== "object") return [];
  return asArray((root as Record<string, unknown>)["row"]).filter(
    (r): r is Record<string, unknown> => !!r && typeof r === "object",
  );
}

/** Parse a whole XML-parsed Material Bank document into typed orders. */
export function parseMaterialBank(doc: unknown): ParseResult<MaterialBankOrder> {
  const errors: ParseError[] = [];
  let duplicates = 0;
  let lineRows = 0;
  // One order per ORDERID — later occurrence merges missing lines (same order
  // split across elements has been observed in multi-project samples).
  const byId = new Map<string, MaterialBankOrder>();

  materialBankOrderElements(doc).forEach((el, i) => {
    const rowIndex = i + 1;
    const orderId = pick(el, "ORDERID");
    if (!orderId) {
      errors.push({ rowIndex, messages: ["missing ORDERID"] });
      return;
    }

    const lines: MaterialBankLine[] = [];
    for (const raw of asArray(el["row"])) {
      if (!raw || typeof raw !== "object") continue;
      const line = raw as Record<string, unknown>;
      const sku = firstText(line["SKU"]);
      if (!sku) continue; // nested rows without a SKU are project-detail rows
      lineRows++;
      const qtyRaw = firstText(line["QTYORIGINAL"]);
      const qty = qtyRaw != null ? Number(qtyRaw.replace(/,/g, "")) : NaN;
      lines.push({
        sku,
        quantity: Number.isFinite(qty) ? qty : null,
        color: firstText(line["Color"]),
      });
    }

    const order: MaterialBankOrder = {
      orderId,
      contact: {
        name: pick(el, "CONTACT1NAME"),
        email: pick(el, "CONTACT1EMAIL")?.toLowerCase() ?? null,
        phone: pick(el, "CONTACT1PHONE"),
        mobilePhone: pick(el, "MOBILEPHONE"),
        preference: pick(el, "CONTACTPREFERENCE"),
        title: pick(el, "Title"),
      },
      company: {
        name: pick(el, "Company"),
        practice: pick(el, "CompanyPractice"),
      },
      address: {
        street1: pick(el, "STREET1"),
        city: pick(el, "City"),
        state: pick(el, "State"),
        zip: pick(el, "Zip"),
        country: pick(el, "Country"),
      },
      project: {
        name: pick(el, "ProjectName"),
        description: pick(el, "ProjectDescription"),
        phase: pick(el, "ProjectPhase"),
        type: pick(el, "ProjectType"),
        budgetRaw: pick(el, "ProjectBudget"),
        completionMonth: pick(el, "ExpectedProjectCompletionMonth"),
        completionYear: pick(el, "ExpectedProjectCompletionYear"),
      },
      lines,
    };

    const existing = byId.get(orderId);
    if (existing) {
      duplicates++;
      const seen = new Set(existing.lines.map((l) => `${l.sku}~${l.color ?? ""}`));
      for (const l of order.lines) {
        if (!seen.has(`${l.sku}~${l.color ?? ""}`)) existing.lines.push(l);
      }
    } else {
      byId.set(orderId, order);
    }
  });

  return {
    valid: [...byId.values()],
    errors,
    stats: { orders: byId.size, duplicates, lineRows },
  };
}

/**
 * Free-text project budget → dollar amount (ported from the Make.com scenario):
 * "over $1M"/"$500k+"/">$2m" → the floor; "$50k-$100k"/"$1M to $2M" → midpoint;
 * plain values pass through. k/m suffixes, "$", commas, parens tolerated.
 * Returns null when nothing numeric is found.
 */
export function parseBudgetAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = String(raw)
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .replace(/[–—]/g, "-")
    .trim();
  if (!s) return null;

  const token = (t: string): number | null => {
    const m = t.replace(/\$/g, "").trim().match(/(\d+(\.\d+)?)(\s*[km])?/i);
    if (!m) return null;
    let n = parseFloat(m[1]!);
    const suffix = (m[3] ?? "").trim().toLowerCase();
    if (suffix === "k") n *= 1_000;
    if (suffix === "m") n *= 1_000_000;
    return Math.round(n);
  };

  if (s.includes(">") || s.includes("over") || s.includes("+")) return token(s);

  if (s.includes("-") || s.includes(" to ")) {
    const parts = (s.includes(" to ") ? s.split(" to ") : s.split("-")).map((p) => p.trim());
    const a = token(parts[0] ?? "");
    const b = token(parts[1] ?? "");
    if (a != null && b != null) return Math.round((a + b) / 2);
  }

  return token(s);
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Expected completion (month name/abbrev/number + year) → HubSpot DATE value:
 * midnight-UTC ms of the 1st of that month. `estimated_onsite_date` is a
 * date-typed property (see DEAL_DATE_FIELDS in ../hubspot/mapping.ts), so the
 * midnight anchor is correct here — the noon-UTC convention applies only to
 * datetime properties like closedate.
 */
export function completionDateMs(
  month: string | null | undefined,
  year: string | null | undefined,
): number | null {
  const y = parseInt(String(year ?? "").trim(), 10);
  const mRaw = String(month ?? "").trim().toLowerCase();
  if (!mRaw || !Number.isFinite(y) || y < 1970 || y > 2200) return null;
  let m: number | undefined;
  if (/^\d{1,2}$/.test(mRaw)) {
    m = Math.max(1, Math.min(12, parseInt(mRaw, 10))) - 1;
  } else {
    m = MONTHS[mRaw] ?? MONTHS[mRaw.slice(0, 3)];
  }
  if (m === undefined) return null;
  return Date.UTC(y, m, 1);
}

/** Deal description block, mirroring the Make.com scenario's layout. */
export function buildDealDescription(order: MaterialBankOrder): string {
  const parts: string[] = [];
  if (order.project.description) parts.push(order.project.description);
  if (order.project.phase) parts.push(`Project Phase: ${order.project.phase}`);
  const company: string[] = [];
  if (order.company.name) company.push(`Company: ${order.company.name}`);
  if (order.company.practice) company.push(`Company Practice: ${order.company.practice}`);
  if (company.length) parts.push(company.join("\n"));
  return parts.join("\n\n");
}

/** "STREET1, City, State Zip, Country" with missing pieces elided. */
export function fullProjectAddress(order: MaterialBankOrder): string {
  const a = order.address;
  const stateZip = [a.state, a.zip].filter(Boolean).join(" ");
  return [a.street1, a.city, stateZip, a.country].filter(Boolean).join(", ");
}
