import { z } from "zod";

/**
 * UTM assembly + validation.
 *
 * This module is the single source of truth for building tagged URLs. It is
 * intentionally pure: no I/O, no DOM, no Worker types — so it runs identically
 * in the browser, in the API Worker, and in unit tests.
 *
 * It is also explicitly designed to make the bugs we have seen in the current
 * manual sheets impossible:
 *   - stray `?&` after the path                      ->  "?" or "&" picked correctly
 *   - missing `&` before utm_content                 ->  params join with "&"
 *   - drifting/incremented campaign ids (_2026/_2027) ->  campaign value comes from
 *                                                          the HubSpot dropdown, never
 *                                                          hand-typed; this module
 *                                                          rejects bare strings that
 *                                                          look like they were edited.
 */

export interface UtmFields {
  /** utm_source — required, from controlled vocab */
  source: string;
  /** utm_medium — required, from controlled vocab */
  medium: string;
  /** utm_campaign — required, encoded HubSpot value e.g. "39174698_hd_expo_2026" */
  campaign: string;
  /** utm_content — optional, from controlled vocab or user-added */
  content?: string;
}

export interface BuildOptions {
  /** Set true to keep an already-present #hash on the destination URL. Default true. */
  preserveHash?: boolean;
}

const FIELD_TO_PARAM: Record<keyof UtmFields, string> = {
  source: "utm_source",
  medium: "utm_medium",
  campaign: "utm_campaign",
  content: "utm_content",
};

// Param order matches both the PRD's reference sheets and HubSpot's own convention.
const PARAM_ORDER: Array<keyof UtmFields> = [
  "source",
  "medium",
  "campaign",
  "content",
];

export class UtmAssemblyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "UtmAssemblyError";
  }
}

/**
 * Validate the encoded campaign value. We require the `{hubspotId}_{slug}`
 * shape so that hand-typed strings (and especially the "incrementing 2026 ->
 * 2027 -> 2028" bug we have seen) get rejected at the boundary.
 *
 * The id segment accepts either form HubSpot has used:
 *   - a UUID, returned by the Marketing Campaigns v3 API
 *     (e.g. "edb9b6c3-d2e2-4ca8-8396-832262aed0d4_hd_expo_2026")
 *   - a legacy numeric id, used by the dev seed data
 *     (e.g. "39174698_hd_expo_2026")
 * The UUID never contains an underscore, so the first `_` is always the
 * unambiguous boundary between id and slug.
 */
const HUBSPOT_ID_RE =
  "(?:\\d{4,}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const CAMPAIGN_VALUE_RE = new RegExp(
  `^${HUBSPOT_ID_RE}_[a-z0-9][a-z0-9_]*[a-z0-9]$`,
);

const utmTokenSchema = (label: string) =>
  z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .refine((v) => !/\s/.test(v), `${label} must not contain whitespace`)
    .refine(
      (v) => !/[?&=#]/.test(v),
      `${label} must not contain URL control chars (? & = #)`,
    );

export const UtmFieldsSchema = z
  .object({
    source: utmTokenSchema("utm_source"),
    medium: utmTokenSchema("utm_medium"),
    campaign: z
      .string({ required_error: "utm_campaign is required" })
      .trim()
      .regex(
        CAMPAIGN_VALUE_RE,
        "utm_campaign must be the encoded HubSpot value (e.g. 39174698_hd_expo_2026) — pick from the campaign dropdown",
      ),
    content: utmTokenSchema("utm_content").optional(),
  })
  .strict();

/**
 * Build a fully-tagged URL from a destination + UTM fields.
 * Throws `UtmAssemblyError` if inputs are invalid.
 */
export function buildTaggedUrl(
  destination: string,
  fields: UtmFields,
  opts: BuildOptions = {},
): string {
  const { preserveHash = true } = opts;

  if (typeof destination !== "string" || destination.trim().length === 0) {
    throw new UtmAssemblyError("Destination URL is required", "no_destination");
  }

  let url: URL;
  try {
    url = new URL(destination.trim());
  } catch {
    throw new UtmAssemblyError(
      `Destination is not a valid absolute URL: ${destination}`,
      "invalid_destination",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UtmAssemblyError(
      `Destination must use http(s) — got ${url.protocol}`,
      "invalid_protocol",
    );
  }

  const parsed = UtmFieldsSchema.safeParse(fields);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new UtmAssemblyError(
      first ? first.message : "Invalid UTM fields",
      "invalid_fields",
    );
  }

  // Strip any pre-existing utm_* params so we cannot end up with duplicates.
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_")) url.searchParams.delete(key);
  }

  // URL.searchParams handles ? vs & joining, encoding, and ordering for us, so
  // the historical "?&utm_source" and "...2026utm_content=aia" bugs are
  // impossible by construction.
  for (const field of PARAM_ORDER) {
    const value = parsed.data[field];
    if (value === undefined || value === "") continue;
    url.searchParams.append(FIELD_TO_PARAM[field], value);
  }

  if (!preserveHash) url.hash = "";

  return url.toString();
}

/**
 * Sanity-check an already-built URL. Returns the list of problems found.
 * Used as a belt-and-suspenders check before persisting.
 */
export function auditTaggedUrl(taggedUrl: string): string[] {
  const problems: string[] = [];

  // Anything we built ourselves must round-trip through URL cleanly.
  let url: URL;
  try {
    url = new URL(taggedUrl);
  } catch {
    return ["Not a valid URL"];
  }

  if (taggedUrl.includes("?&")) {
    problems.push("Found '?&' (stray ampersand after question mark)");
  }
  if (/&&/.test(taggedUrl)) {
    problems.push("Found '&&' (empty parameter)");
  }
  // The historical bug "...campaign=..._2026utm_content=aia" — utm_content right
  // up against the campaign value with no separator.
  if (/utm_campaign=[^&#]*utm_(source|medium|content)=/.test(taggedUrl)) {
    problems.push("utm_content/source/medium glued onto utm_campaign value");
  }

  const required = ["utm_source", "utm_medium", "utm_campaign"];
  for (const p of required) {
    if (!url.searchParams.has(p)) problems.push(`Missing ${p}`);
  }
  for (const p of [...url.searchParams.keys()]) {
    if (p.startsWith("utm_")) {
      const values = url.searchParams.getAll(p);
      if (values.length > 1) problems.push(`Duplicate ${p}`);
      if (values.some((v) => v === "")) problems.push(`Empty ${p}`);
    }
  }

  return problems;
}

/** Convenience: validate fields without building the URL. */
export function validateUtmFields(fields: unknown):
  | { ok: true; fields: UtmFields }
  | { ok: false; errors: string[] } {
  const parsed = UtmFieldsSchema.safeParse(fields);
  if (parsed.success) return { ok: true, fields: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
}

export interface ParsedTaggedUrl {
  /** The original URL with all utm_* params stripped (hash + non-utm query preserved). */
  destination: string;
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
}

/**
 * Inverse of `buildTaggedUrl`: split a tagged URL back into its base destination
 * and UTM fields. Tolerant — never throws; if the URL is unparseable we return
 * the input as-is with no extracted fields. Used by the UTM & QR view to
 * display per-column UTM values from the canonical `destination_url` and to
 * pre-populate the inline edit dropdowns.
 */
export function parseTaggedUrl(input: string): ParsedTaggedUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { destination: input };
  }

  const out: ParsedTaggedUrl = { destination: "" };
  const get = (k: string) => {
    const v = url.searchParams.get(k);
    return v === null || v === "" ? undefined : v;
  };
  out.source = get("utm_source");
  out.medium = get("utm_medium");
  out.campaign = get("utm_campaign");
  out.content = get("utm_content");

  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_")) url.searchParams.delete(key);
  }
  out.destination = url.toString();
  return out;
}
