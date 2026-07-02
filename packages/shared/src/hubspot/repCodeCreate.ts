/**
 * Auto-creation of missing Rep Code records from SAP pushes — the pure half.
 *
 * When a SAP company (`sales_rep_code`) or deal (`sales_group`) references a rep
 * code with no Rep Code record in HubSpot, the Worker creates the record, links
 * it to the triggering company/deal, and opens a review TASK. This module owns
 * the decisions that don't need I/O: which raw values are safe to create records
 * from, what the new record's properties are, and what the review task says.
 */

/**
 * Rep codes are short uppercase alpha(numeric) tokens ("OS", "OSX", "SDA",
 * "TLA"). The leading letter rejects numeric AMT codes ("441") and junk like
 * "0"; min length 2 rejects single-char noise; max 8 is headroom over the
 * observed 2–3 chars.
 */
const REP_CODE_SHAPE = /^[A-Z][A-Z0-9]{1,7}$/;

/** Placeholder-ish values that pass the shape test but must never become records. */
const REP_CODE_DENYLIST = new Set(["NA", "NONE", "NULL", "TBD", "TEST", "HOUSE", "UNKNOWN"]);

/**
 * Conservative gate for auto-creating a Rep Code record from a raw SAP value.
 * Returns the trimmed/uppercased code, or null when the value shouldn't spawn a
 * record (empty, numeric AMT code, placeholder, free text). False negatives are
 * surfaced by the caller as dashboard skips, so an oddly-shaped-but-real code is
 * visible rather than silently lost.
 */
export function normalizeRepCodeForCreate(raw: unknown): string | null {
  const code = raw == null ? "" : String(raw).trim().toUpperCase();
  if (!code || !REP_CODE_SHAPE.test(code) || REP_CODE_DENYLIST.has(code)) return null;
  return code;
}

/** Properties for the new Rep Code record: the code, plus an owner when one resolved. */
export function buildRepCodeCreateProperties(
  code: string,
  ownerId?: string | null,
): Record<string, string> {
  const properties: Record<string, string> = { rep_code: code };
  if (ownerId) properties.hubspot_owner_id = ownerId;
  return properties;
}

export interface RepCodeTaskInput {
  repCode: string;
  /** What triggered the create: a SAP company/deal push, or the backfill scan. */
  sourceType: "company" | "deal" | "backfill";
  /** Human-readable handle: account # / quote # — or, for backfill, the usage summary. */
  sourceLabel: string;
  /** Whether an ISR owner was resolved and set on the new record. */
  ownerSet: boolean;
}

/** Subject + body for the review task attached to an auto-created Rep Code. */
export function buildRepCodeTaskContent(input: RepCodeTaskInput): { subject: string; body: string } {
  const subject = `Review auto-created Rep Code "${input.repCode}" (SAP sync)`;
  const trigger =
    input.sourceType === "backfill"
      ? `A backfill scan found ${input.sourceLabel} referencing rep code "${input.repCode}", ` +
        `which had no Rep Code record in HubSpot. The record was created automatically and ` +
        `the referencing records were associated.`
      : `The SAP → HubSpot sync received ${
          input.sourceType === "company" ? `account ${input.sourceLabel}` : `quote ${input.sourceLabel}`
        } referencing rep code "${input.repCode}", ` +
        `which had no Rep Code record in HubSpot. The record was created automatically and ` +
        `associated to the triggering ${input.sourceType}.`;
  const body = [
    trigger,
    input.ownerSet
      ? "An owner (ISR) was resolved from the territory mapping and set on the record."
      : "No owner (ISR) could be resolved — the record is unowned.",
    "Follow-ups: fill in Agency, Region, and Account #; verify the owner; " +
      "confirm this is a real rep code (delete the record if it's bad SAP data).",
  ].join("\n\n");
  return { subject, body };
}
