/**
 * Marketing-event lead-ownership decision tree (pure, no runtime deps).
 *
 * A HubSpot workflow enrolls a marketing-event attendee (a contact) and posts to
 * the `/api/hubspot/event-lead` Worker webhook. The webhook fetches a few facts
 * (contact Location/Role/country, the associated company's sub-type, the campaign
 * brand) and calls {@link evaluateLeadOwnership}, which walks {@link LEAD_OWNERSHIP_TREE}
 * and returns a {@link LeadDecision}: a single *leaf* describing WHO owns the lead.
 *
 * This module is intentionally IO-free. It never resolves an owner id, reads a rep
 * code, or talks to HubSpot/Supabase — it only emits a leaf descriptor. The
 * `apps/api` layer turns that descriptor into an owner id (fixed person → owner,
 * or rep-code channel → that rep code's owner/RSM) and creates the Lead. Keeping
 * the tree pure makes the whole (large, frequently-tuned) mapping unit-testable and
 * keeps `@wac/shared` free of runtime dependencies.
 *
 * A leaf is one of three resolution modes:
 *   - `person`  — a fixed owner, resolved by name or email in the api layer.
 *   - `repCode` — read the contact's `rep_code_<channel>` property; `resolve:"owner"`
 *                 assigns the owner of that rep code, `resolve:"rsm"` assigns its
 *                 Regional Manager (RSM/TSM — e.g. Nick Castelucci / Dhane Wald).
 *   - `fallback`— nothing matched (or the rep-code property was blank); the api
 *                 layer assigns the global fallback owner (Lana).
 *
 * The `channel` strings on `repCode` leaves are exactly the keys of
 * {@link CHANNEL_TO_CONTACT_PROP} so the api layer can map channel → contact prop.
 *
 * NOTE: the value→branch alias maps below (locations, roles, company sub-types) are
 * seeded with a best-effort reading of the routing chart and the ~23 known
 * `company_sub_type` values. They are the knobs to confirm/tune; the tree STRUCTURE
 * and the leaf mapping are verified. Lines marked `TODO(confirm)` need a human pass.
 */

import { CHANNEL_TO_CONTACT_PROP } from "./contactRepCode.js";
import { normalizeBrand } from "../productinfo.js";

// ---------------------------------------------------------------------------
// Canonical dimensions
// ---------------------------------------------------------------------------

/** Where the contact is, from the contact Location property. */
export type Location = "Canada" | "International" | "North America" | "Unknown";

/**
 * Lead-routing brand. Unlike {@link normalizeBrand} (which folds "Modern Forms
 * Fans" into Modern Forms), routing must keep **MF Fans** distinct — it routes to
 * the WAC Fans channel in the showroom branch while plain Modern Forms/Schonbek go
 * elsewhere. WAC Architectural folds with WAC Lighting for routing.
 */
export type LeadBrand =
  | "WAC Lighting"
  | "WAC Architectural"
  | "Modern Forms"
  | "Schonbek"
  | "MF Fans";

/**
 * The North-America "Company Type" branch, derived from the associated company's
 * `company_sub_type`. Mirrors the routing chart's top-level company-type diamond.
 */
export type CompanyType =
  | "National Accounts"
  | "Specifier"
  | "Landscape"
  | "Integrator"
  | "E Retailer"
  | "Contractor/Builder"
  | "Showroom"
  | "Interior Designer"
  | "Hospitality"
  | "Other";

/** Contact Role (persona), used in the showroom/commercial sub-branch. */
export type Role = "Interior Designer" | "Contractor/Builder" | "Other";

// ---------------------------------------------------------------------------
// Leaf + tree types
// ---------------------------------------------------------------------------

export type Leaf =
  /**
   * Fixed owner. `name` → resolveOwnerByName; `email` → owner by email (intl).
   * `channel` (optional) names the rep-code channel whose rep "oversees" the
   * account, so the lead can still surface/associate that rep code even when it's
   * assigned to a fixed person (e.g. MF Designer → Kalin still shows MF Designer's code).
   */
  | { kind: "person"; name?: string; email?: string; label: string; channel?: string }
  /** Channel leaf: read `rep_code_<channel>`, assign its owner or its RSM. */
  | { kind: "repCode"; channel: string; resolve: "owner" | "rsm"; label: string }
  /** Nothing matched / blank rep code → global fallback owner (Lana). */
  | { kind: "fallback"; reason: string };

/** Dimensions the tree can switch on. */
export type SwitchKey = "location" | "brand" | "country" | "companyType" | "role";

export type LeadTreeNode =
  | { leaf: Leaf }
  | {
      switch: SwitchKey;
      /** Keys are CANONICAL values (already normalized). */
      cases: Record<string, LeadTreeNode>;
      /** Followed when no case matches (else → fallback leaf). */
      default?: LeadTreeNode;
    };

/** Raw inputs the api layer fetches and hands to the evaluator. */
export interface LeadFacts {
  /** Contact Location property (raw). */
  location: string | null;
  /** Contact country (raw) — for the International WAC-by-country routing. */
  country: string | null;
  /** Contact Role / persona property (raw). */
  role: string | null;
  /** Associated company `company_sub_type` (raw). */
  companySubType: string | null;
  /** Campaign brand (raw, from the payload). */
  brand: string | null;
}

export interface LeadDecision {
  leaf: Leaf;
  /** Breadcrumbs of the matched branch, for diagnostics/logging. */
  path: string[];
}

// ---------------------------------------------------------------------------
// Normalizers (value → canonical). Seeded; tune the alias maps to taste.
// ---------------------------------------------------------------------------

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/** Contact Location property value → canonical {@link Location}. */
export function normalizeLocation(raw: string | null | undefined): Location {
  const k = norm(raw);
  if (!k) return "Unknown";
  // TODO(confirm): exact Location property option values.
  if (/(^|\b)(ca|canada)(\b|$)/.test(k)) return "Canada";
  if (/(north america|united states|^us$|^usa$|america|domestic)/.test(k)) {
    return "North America";
  }
  if (/(international|intl|row|rest of world|export|global)/.test(k)) {
    return "International";
  }
  if (/(unknown|n\/a|none)/.test(k)) return "Unknown";
  // A bare country name that isn't US/Canada is treated as International.
  return "International";
}

/**
 * Campaign brand (raw) → {@link LeadBrand}, keeping MF Fans distinct. Delegates to
 * {@link normalizeBrand} for the rest; returns null when nothing matches.
 */
export function normalizeLeadBrand(raw: string | null | undefined): LeadBrand | null {
  const k = norm(raw);
  if (!k) return null;
  // MF Fans must NOT collapse into Modern Forms for routing.
  if (/\bfan/.test(k) && /(mf|modern forms)/.test(k)) return "MF Fans";
  if (k === "mf fans" || k === "modern forms fans" || k === "fans") return "MF Fans";
  const canonical = normalizeBrand(raw);
  if (canonical === "Aispire") return null; // TODO(confirm): Aispire routing.
  return (canonical as LeadBrand | null) ?? null;
}

/** Contact Role property value → canonical {@link Role}. */
export function normalizeRole(raw: string | null | undefined): Role {
  const k = norm(raw);
  // TODO(confirm): exact Role property option values.
  if (/(interior design|^id$|decorator|int\.? decor)/.test(k)) return "Interior Designer";
  if (/(contractor|builder|construction|electrician)/.test(k)) return "Contractor/Builder";
  return "Other";
}

/**
 * Company type → {@link CompanyType} branch. The api layer passes the clean
 * `company_sub_type_simplified` value when present (the 8-bucket taxonomy below),
 * else falls back to the legacy `company_sub_type`. Both vocabularies are mapped:
 * the simplified buckets cover the common path; the raw entries catch the finer
 * branches (E Retailer, Hospitality, Landscape, National Accounts) the simplified
 * field doesn't separate.
 */
const SUBTYPE_TO_COMPANY_TYPE: Record<string, CompanyType> = {
  // --- company_sub_type_simplified buckets ---
  "specifier (a&d / engineer / architect)": "Specifier",
  "dealer / showroom / retail": "Showroom",
  "interior designer / decorator": "Interior Designer",
  "contractor / builder": "Contractor/Builder",
  integrator: "Integrator",
  "distributor / wholesaler": "Contractor/Builder", // Distribution leaf
  reps: "Other",
  "internal / system / other": "Other",
  competitor: "Other",
  other: "Other",

  // --- legacy company_sub_type values (fallback / finer branches) ---
  "lighting designer": "Specifier",
  "lighting design": "Specifier",
  "m&e consultant": "Specifier",
  architect: "Specifier",
  engineer: "Specifier",
  integrators: "Integrator",
  "integrator rep": "Integrator",
  "internet retailer": "E Retailer",
  "egh-internet": "E Retailer",
  "egh-internet ret": "E Retailer",
  "showroom/internet": "E Retailer",
  "independent retailer": "E Retailer",
  "lighting showroom": "Showroom",
  "showroom-main retail": "Showroom",
  "elec. house w/ show": "Showroom",
  "interior designer": "Interior Designer",
  "designer/int. decor.": "Interior Designer",
  "building contractor": "Contractor/Builder",
  "elect. contractor": "Contractor/Builder",
  contractor: "Contractor/Builder",
  construction: "Contractor/Builder",
  developer: "Contractor/Builder",
  distributor: "Contractor/Builder",
  dealer: "Contractor/Builder",
  wholesale: "Contractor/Builder",
  "lighting supplier": "Contractor/Builder",
  "elec. house w/o show": "Contractor/Builder",
  "hospitality channel": "Hospitality",
  "contract hospitality account": "Hospitality",
  "resort consultant": "Hospitality",
  "landscape architect": "Landscape",
  "national accounts": "National Accounts",
};

/** company sub-type (simplified or legacy) → {@link CompanyType}; unknown → "Other". */
export function normalizeCompanyType(raw: string | null | undefined): CompanyType {
  const k = norm(raw);
  if (!k) return "Other";
  return SUBTYPE_TO_COMPANY_TYPE[k] ?? "Other";
}

// ---------------------------------------------------------------------------
// International WAC-by-country (WAC Architectural / WAC Lighting)
// ---------------------------------------------------------------------------

/** Normalized country → International spec owner email (WAC Arch / WAC Lighting). */
const COUNTRY_TO_INTL_OWNER_EMAIL: Record<string, string> = {
  "hong kong": "Wilson.Tson@waclighting.com",
  hk: "Wilson.Tson@waclighting.com",
  macao: "Wilson.Tson@waclighting.com",
  macau: "Wilson.Tson@waclighting.com",
  taiwan: "Wilson.Tson@waclighting.com",
  thailand: "Wijitporn.Y@waclighting.com",
  australia: "Rebekah.Thompson@waclighting.com",
  "new zealand": "Rebekah.Thompson@waclighting.com",
  indonesia: "Setia.Budi@waclighting.com",
  india: "Hemanth.Raju@waclighting.com",
  "sri lanka": "Hemanth.Raju@waclighting.com",
};

/** Rest-of-world default for the International WAC routing. */
const INTL_REST_OF_WORLD_EMAIL = "Betty.Luo@waclighting.com";

/** Country (raw) → the International WAC spec owner's email. */
export function intlWacOwnerEmail(country: string | null | undefined): string {
  return COUNTRY_TO_INTL_OWNER_EMAIL[norm(country)] ?? INTL_REST_OF_WORLD_EMAIL;
}

// ---------------------------------------------------------------------------
// Leaf builders
// ---------------------------------------------------------------------------

const person = (name: string, label?: string, channel?: string): LeadTreeNode => ({
  leaf: { kind: "person", name, label: label ?? name, ...(channel ? { channel } : {}) },
});
const channelOwner = (channel: string, label: string): LeadTreeNode => ({
  leaf: { kind: "repCode", channel, resolve: "owner", label },
});
const channelRsm = (channel: string, label: string): LeadTreeNode => ({
  leaf: { kind: "repCode", channel, resolve: "rsm", label },
});

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/** International, brand = WAC Architectural / WAC Lighting → by contact country. */
const INTL_WAC_BY_COUNTRY: LeadTreeNode = {
  leaf: { kind: "person", email: "__intl_wac__", label: "Intl WAC spec (by country)" },
};

/**
 * Interior-Designer brand split (shared by the "Interior Designer" company type
 * and the Showroom role=Interior Designer branch): MF/Schonbek → Kalin Scott
 * (MF Designer, fixed); WAC → Showroom channel owner; MF Fans → WAC Fans owner.
 */
const INTERIOR_DESIGNER_BRAND_NODE: LeadTreeNode = {
  switch: "brand",
  cases: {
    "Modern Forms": person("Kalin Scott", "MF Designer → Kalin Scott", "MF Designer"),
    Schonbek: person("Kalin Scott", "MF Designer → Kalin Scott", "MF Designer"),
    "WAC Lighting": channelOwner("WAC Showroom", "Showroom (WAC)"),
    "WAC Architectural": channelOwner("WAC Showroom", "Showroom (WAC)"),
    "MF Fans": channelOwner("WAC Fans", "MF Fans Showroom"),
  },
  default: { leaf: { kind: "fallback", reason: "designer brand gap" } },
};

/**
 * Showroom company type → switch on contact Role. Interior Designer splits by
 * brand (above); MF & Schonbek (non-designer showrooms) → the MF Showroom rep
 * code's RSM (Nick/Dhane); Contractor/Builder → Distribution.
 */
const SHOWROOM_ROLE_NODE: LeadTreeNode = {
  switch: "role",
  cases: {
    "Interior Designer": INTERIOR_DESIGNER_BRAND_NODE,
    "Contractor/Builder": channelOwner("WAC Showroom", "Distribution (Contractor/Builder)"),
    // Showrooms carrying MF & Schonbek → MF Showroom rep code's Regional Manager.
    Other: channelRsm("MF Showroom", "Showroom MF&Schonbek → RSM (Nick/Dhane)"),
  },
  default: channelRsm("MF Showroom", "Showroom MF&Schonbek → RSM (Nick/Dhane)"),
};

/** North America → company-type switch. */
const NORTH_AMERICA_NODE: LeadTreeNode = {
  switch: "companyType",
  cases: {
    "National Accounts": person("Sara Kruid", "National Accounts → Sara Kruid"),
    Specifier: {
      switch: "brand",
      cases: {
        "WAC Lighting": channelOwner("WAC Spec", "WAC Spec"),
        "WAC Architectural": channelOwner("WAC Spec", "WAC Spec"),
        "Modern Forms": channelOwner("MF Spec", "MF Spec"),
        Schonbek: channelOwner("MF Spec", "MF Spec"),
        "MF Fans": channelOwner("MF Spec", "MF Spec"),
      },
      default: channelOwner("MF Spec", "MF Spec"), // TODO(confirm) default brand
    },
    Landscape: channelOwner("WAC Landscape", "Green (Landscape)"),
    Integrator: channelOwner("Integration", "Integrator"),
    "E Retailer": person("Harry", "E Retailer → Harry"), // TODO(confirm) surname
    "Contractor/Builder": channelOwner("WAC Showroom", "Distribution (Contractor/Builder)"),
    Showroom: SHOWROOM_ROLE_NODE,
    "Interior Designer": INTERIOR_DESIGNER_BRAND_NODE,
    // Hospitality / FFE → Rudy Soni; the overseeing rep code is the Contract channel
    // for the brand (Contract WAC for WAC, Contract MF for MF/Schonbek).
    Hospitality: {
      switch: "brand",
      cases: {
        "WAC Lighting": person("Rudy Soni", "Hospitality → Rudy Soni", "Contract WAC"),
        "WAC Architectural": person("Rudy Soni", "Hospitality → Rudy Soni", "Contract WAC"),
        "Modern Forms": person("Rudy Soni", "Hospitality → Rudy Soni", "Contract MF"),
        Schonbek: person("Rudy Soni", "Hospitality → Rudy Soni", "Contract MF"),
        "MF Fans": person("Rudy Soni", "Hospitality → Rudy Soni", "Contract MF"),
      },
      default: person("Rudy Soni", "Hospitality → Rudy Soni", "Contract WAC"),
    },
  },
  default: { leaf: { kind: "fallback", reason: "unmapped company type" } },
};

/** International → brand switch. */
const INTERNATIONAL_NODE: LeadTreeNode = {
  switch: "brand",
  cases: {
    Schonbek: person("Angela Yost", "Intl Schonbek → Angela Yost"),
    "Modern Forms": person("Navita Phagoo", "Intl Modern Forms → Navita Phagoo"),
    "MF Fans": person("Navita Phagoo", "Intl MF Fans → Navita Phagoo"), // TODO(confirm)
    "WAC Lighting": INTL_WAC_BY_COUNTRY,
    "WAC Architectural": INTL_WAC_BY_COUNTRY,
  },
  // E. Distributor (or unmapped intl brand) → Distribution channel owner.
  default: channelOwner("WAC Showroom", "Intl E. Distributor → Distribution"),
};

export const LEAD_OWNERSHIP_TREE: LeadTreeNode = {
  switch: "location",
  cases: {
    Canada: person("Lana", "Canada → Lana"),
    Unknown: person("Lana", "Unknown → Lana"),
    International: INTERNATIONAL_NODE,
    "North America": NORTH_AMERICA_NODE,
  },
  default: { leaf: { kind: "fallback", reason: "unmapped location" } },
};

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/** Normalize a fact to the canonical value used as a `cases` key for `dim`. */
function canonicalFor(dim: SwitchKey, facts: LeadFacts): string {
  switch (dim) {
    case "location":
      return normalizeLocation(facts.location);
    case "brand":
      return normalizeLeadBrand(facts.brand) ?? "";
    case "country":
      return norm(facts.country);
    case "companyType":
      return normalizeCompanyType(facts.companySubType);
    case "role":
      return normalizeRole(facts.role);
  }
}

/**
 * Walk {@link LEAD_OWNERSHIP_TREE} for the given facts and return the matched
 * {@link Leaf} plus a breadcrumb `path`. Never throws: an unmatched switch with no
 * `default` yields a `fallback` leaf.
 *
 * The special intl-WAC leaf (`email === "__intl_wac__"`) is rewritten here to the
 * concrete owner email for the contact's country via {@link intlWacOwnerEmail}.
 */
export function evaluateLeadOwnership(
  facts: LeadFacts,
  tree: LeadTreeNode = LEAD_OWNERSHIP_TREE,
): LeadDecision {
  const path: string[] = [];
  let node: LeadTreeNode = tree;

  for (let guard = 0; guard < 64; guard++) {
    if ("leaf" in node) {
      return { leaf: resolveLeaf(node.leaf, facts), path };
    }
    const value = canonicalFor(node.switch, facts);
    path.push(`${node.switch}:${value || "∅"}`);
    const next = (value && node.cases[value]) || node.default;
    if (!next) {
      return {
        leaf: { kind: "fallback", reason: `no case for ${node.switch}=${value || "∅"}` },
        path,
      };
    }
    node = next;
  }
  return { leaf: { kind: "fallback", reason: "tree too deep" }, path };
}

/** Resolve a leaf's late-bound bits (the intl-WAC-by-country email). */
function resolveLeaf(leaf: Leaf, facts: LeadFacts): Leaf {
  if (leaf.kind === "person" && leaf.email === "__intl_wac__") {
    return { kind: "person", email: intlWacOwnerEmail(facts.country), label: leaf.label };
  }
  return leaf;
}

/** Stable identity for a leaf, for de-duping fanned-out brand branches. */
function leafKey(leaf: Leaf): string {
  if (leaf.kind === "person") return `person:${(leaf.name ?? leaf.email ?? "").toLowerCase()}:${leaf.channel ?? ""}`;
  if (leaf.kind === "repCode") return `repCode:${leaf.channel}:${leaf.resolve}`;
  return `fallback:${leaf.reason}`;
}

/**
 * Like {@link evaluateLeadOwnership} but FANS OUT at a brand switch when the brand
 * is unknown: instead of the single default leaf, it returns every distinct brand
 * branch's leaf (de-duped — e.g. Modern Forms & Schonbek both → Kalin collapses to
 * one). With a known brand, or no brand switch on the path, it returns a single
 * decision. The api layer assigns the lead to each resulting owner, so an unknown
 * brand produces multiple rep-code owners instead of a blind fallback.
 */
export function evaluateLeadOwnershipAll(
  facts: LeadFacts,
  tree: LeadTreeNode = LEAD_OWNERSHIP_TREE,
): LeadDecision[] {
  const collect = (node: LeadTreeNode, path: string[]): LeadDecision[] => {
    if ("leaf" in node) return [{ leaf: resolveLeaf(node.leaf, facts), path }];
    const value = canonicalFor(node.switch, facts);
    if (node.switch === "brand" && !value) {
      const entries = Object.entries(node.cases);
      if (entries.length) {
        const out: LeadDecision[] = [];
        const seen = new Set<string>();
        for (const [k, child] of entries) {
          for (const d of collect(child, [...path, `brand:${k}*`])) {
            const key = leafKey(d.leaf);
            if (!seen.has(key)) {
              seen.add(key);
              out.push(d);
            }
          }
        }
        return out;
      }
    }
    const next = (value && node.cases[value]) || node.default;
    if (!next) {
      return [
        {
          leaf: { kind: "fallback", reason: `no case for ${node.switch}=${value || "∅"}` },
          path: [...path, `${node.switch}:${value || "∅"}`],
        },
      ];
    }
    return collect(next, [...path, `${node.switch}:${value || "∅"}`]);
  };
  return collect(tree, []);
}

// ---------------------------------------------------------------------------
// Self-check helpers (used by tests)
// ---------------------------------------------------------------------------

/** Every distinct `repCode` channel referenced by the tree. */
export function treeChannels(tree: LeadTreeNode = LEAD_OWNERSHIP_TREE): string[] {
  const out = new Set<string>();
  const walk = (n: LeadTreeNode): void => {
    if ("leaf" in n) {
      if (n.leaf.kind === "repCode") out.add(n.leaf.channel);
      return;
    }
    for (const child of Object.values(n.cases)) walk(child);
    if (n.default) walk(n.default);
  };
  walk(tree);
  return [...out];
}

/** True iff every `repCode` channel in the tree is a known contact-prop channel. */
export function treeChannelsAreValid(tree: LeadTreeNode = LEAD_OWNERSHIP_TREE): boolean {
  return treeChannels(tree).every((c) => c in CHANNEL_TO_CONTACT_PROP);
}
