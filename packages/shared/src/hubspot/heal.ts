/**
 * Pure SAP -> HubSpot dropdown self-healing, ported from the Deals Lambda's
 * validation-fix path. When HubSpot rejects an enumeration value it returns the
 * allowed-options list in the error message; we canonical/prefix-match the
 * incoming value to a valid option (no metadata GETs). No network / no Env, so
 * it's unit-testable and shared by the Worker push (apps/api).
 *
 * Phase 2 will layer persisted learned aliases + "hold instead of drop" on top;
 * this module faithfully reproduces today's behavior (normalize-or-drop) and
 * reports every action so the dashboard can show what happened.
 */

/**
 * Stable, readable key for a learned-alias `raw_value` (and its lookups): lower,
 * trimmed, whitespace-collapsed. SAP sends a given value consistently, so this is
 * enough to re-hit; the canonical/prefix matcher (canonicalize) is the fuzzier
 * fallback that seeds new aliases.
 */
export function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Normalize a label for comparison: trim, collapse whitespace, tidy slashes/parens. */
export function normalizeLabel(s: unknown): string {
  return String(s ?? "")
    .trim()
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .replace(/\s+\)/g, ")")
    .replace(/\(\s+/g, "(");
}

/** Canonical key: uppercased, alphanumerics only (so punctuation/spacing don't matter). */
export function canonicalize(s: unknown): string {
  return normalizeLabel(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Known one-off corrections for HubSpot options that contain literal typos.
 * Example: the real option value is "C0MMERCIAL - MILITARY" (a ZERO for the O).
 * Seeded from the Lambda; Phase 2 moves these into hubspot_value_mappings.
 */
export function applyKnownFixups(labelNorm: string): string {
  if (String(labelNorm).toUpperCase() === "COMMERCIAL - MILITARY") {
    return "C0MMERCIAL - MILITARY";
  }
  return labelNorm;
}

/**
 * Match an incoming value to one of HubSpot's allowed options. Conservative:
 * canonical-exact, then a UNIQUE prefix match (handles truncation), then a unique
 * reverse-prefix match. Returns the matched option (HubSpot's own string) or null.
 */
export function smartMatchToAllowedOptions(
  incoming: unknown,
  allowedOptions: string[],
): string | null {
  const canon = canonicalize(applyKnownFixups(normalizeLabel(incoming)));
  if (!canon) return null;

  const byCanon = new Map<string, string>();
  for (const opt of allowedOptions) {
    const c = canonicalize(applyKnownFixups(normalizeLabel(opt)));
    if (c) byCanon.set(c, opt);
  }
  const canonList = [...byCanon.keys()];

  // exact
  if (byCanon.has(canon)) return byCanon.get(canon)!;

  // unique prefix match (incoming is a prefix of exactly one option)
  const matches = canonList.filter((c) => c.startsWith(canon)).slice(0, 3);
  if (matches.length === 1) return byCanon.get(matches[0]!)!;

  // unique reverse-prefix (an option is a prefix of incoming)
  const reverse = canonList.filter((c) => canon.startsWith(c)).slice(0, 3);
  if (reverse.length === 1) return byCanon.get(reverse[0]!)!;

  return null;
}

/** Pull the list inside "... allowed options: [ A, B, C ]" from an error message. */
export function parseAllowedOptionsFromMessage(message: unknown): string[] | null {
  const s = String(message ?? "");
  const key = "allowed options:";
  const i = s.toLowerCase().indexOf(key);
  if (i < 0) return null;

  const from = s.slice(i + key.length).trim();
  const start = from.indexOf("[");
  const end = from.lastIndexOf("]");
  if (start < 0 || end < 0 || end <= start) return null;

  const inside = from.slice(start + 1, end).trim();
  if (!inside) return [];
  return inside.split(",").map((x) => x.trim()).filter(Boolean);
}

export interface InvalidPropertyItem {
  name?: string;
  propertyValue?: unknown;
  allowedOptions: string[] | null;
}

/** Extract the invalid-property items (name + allowed options) from a HubSpot error. */
export function extractInvalidPropertyItems(
  errorData: unknown,
): InvalidPropertyItem[] {
  const data = (errorData ?? {}) as { message?: unknown; errors?: unknown };
  const msg = typeof data.message === "string" ? data.message : "";
  const out: InvalidPropertyItem[] = [];

  const prefix = "Property values were not valid:";
  const idx = msg.indexOf(prefix);
  if (idx >= 0) {
    const jsonPart = msg.slice(idx + prefix.length).trim();
    const start = jsonPart.indexOf("[");
    if (start >= 0) {
      try {
        const arr = JSON.parse(jsonPart.slice(start)) as Array<{
          name?: string;
          propertyValue?: unknown;
          localizedErrorMessage?: string;
          message?: string;
        }>;
        for (const item of Array.isArray(arr) ? arr : []) {
          out.push({
            name: item?.name,
            propertyValue: item?.propertyValue,
            allowedOptions: parseAllowedOptionsFromMessage(
              item?.localizedErrorMessage || item?.message || "",
            ),
          });
        }
        return out;
      } catch {
        // fall through to the errors[] shape
      }
    }
  }

  const errs = Array.isArray(data.errors) ? (data.errors as Array<Record<string, unknown>>) : [];
  for (const e of errs) {
    const ctx = (e?.context ?? {}) as { name?: string; propertyName?: string };
    const name = ctx.name || ctx.propertyName || null;
    if (name) {
      out.push({ name, allowedOptions: parseAllowedOptionsFromMessage(e?.message ?? "") });
    }
  }
  return out;
}

/** True when a HubSpot error is a property-validation failure we can try to heal. */
export function isValidationError(errorData: unknown): boolean {
  const data = (errorData ?? {}) as { category?: unknown; message?: unknown };
  if (!data) return false;
  return (
    data.category === "VALIDATION_ERROR" ||
    (typeof data.message === "string" &&
      (data.message.includes("Property values were not valid") ||
        data.message.includes("Duplicate IDs found in batch input")))
  );
}

export interface FixAction {
  property: string;
  from?: string;
  to?: string;
  action: "normalized" | "dropped";
}

export interface HealResult {
  properties: Record<string, unknown>;
  actions: FixAction[];
  changed: boolean;
}

/**
 * Given a property bag and a HubSpot validation error, return a NEW bag with each
 * invalid enum value either normalized to a valid option (smart-match) or dropped,
 * plus the list of actions taken. Pure: the input bag is not mutated.
 */
export function healProperties(
  properties: Record<string, unknown>,
  errorData: unknown,
): HealResult {
  const next = { ...properties };
  const actions: FixAction[] = [];

  for (const item of extractInvalidPropertyItems(errorData)) {
    const propName = item.name;
    if (!propName || !(propName in next)) continue;
    const raw = String(next[propName] ?? "");

    if (Array.isArray(item.allowedOptions) && item.allowedOptions.length) {
      const mapped = smartMatchToAllowedOptions(raw, item.allowedOptions);
      if (mapped !== null) {
        next[propName] = mapped;
        actions.push({ property: propName, from: raw, to: mapped, action: "normalized" });
        continue;
      }
    }

    delete next[propName];
    actions.push({ property: propName, from: raw, action: "dropped" });
  }

  return { properties: next, actions, changed: actions.length > 0 };
}
