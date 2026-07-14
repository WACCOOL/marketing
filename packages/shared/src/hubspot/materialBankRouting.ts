/**
 * Material Bank deal/contact owner routing (pure).
 *
 * Material Bank sample orders come with company information (CompanyPractice)
 * that ordinary leads don't have, so the interior-designer split can be decided
 * up front instead of relying on the company `project_focus` classifier:
 *
 *   - practice labeled residential (only)            → Kalin Scott
 *   - practice labeled commercial (only)             → Rudy Soni
 *   - labeled BOTH commercial and residential        → crawl the firm's website
 *     and verify (both-labeled firms are often actually residential → Kalin);
 *     verified commercial or unverifiable (no site)  → Rudy
 *   - designer with NO residential/commercial label  → verify; unverifiable
 *     defaults to residential/Kalin (the lead tree's designer default)
 *   - anything else                                  → the standard lead-ownership
 *     tree ({@link evaluateLeadOwnership}); rep-code leaves are resolved from the
 *     contact ZIP in the api layer; unresolvable → Lana (global fallback)
 *
 * The api layer applies the national-account override BEFORE this decision and
 * turns the outcome into owner ids (this module stays IO-free, like
 * {@link ./leadOwnership}).
 */

import type { LeadFacts } from "./leadOwnership.js";
import { normalizeCompanyType } from "./leadOwnership.js";
import type { MaterialBankOrder } from "../ingest/materialBank.js";

export type MaterialBankRouting =
  /** Fixed owner, decided by the practice label alone. */
  | { kind: "kalin" | "rudy"; reason: string }
  /**
   * Interior designer whose residential-vs-commercial focus needs website
   * verification. `unverifiable` is who gets it when no site can be found or
   * the classifier abstains.
   */
  | { kind: "verify"; unverifiable: "kalin" | "rudy"; reason: string }
  /** Not a designer — walk the standard lead-ownership tree. */
  | { kind: "tree"; reason: string };

/**
 * Decide the routing mode from the Material Bank CompanyPractice label.
 * Matching is contains-based so label variants ("Residential Interior Design",
 * "Interior Designer - Commercial & Residential") all resolve.
 */
export function decideMaterialBankRouting(
  practice: string | null | undefined,
): MaterialBankRouting {
  const k = (practice ?? "").trim().toLowerCase();
  const residential = /residential/.test(k);
  const commercial = /commercial/.test(k);

  if (residential && commercial) {
    return {
      kind: "verify",
      unverifiable: "rudy",
      reason: "practice labeled commercial+residential — verify via website",
    };
  }
  if (residential) return { kind: "kalin", reason: "practice labeled residential" };
  if (commercial) return { kind: "rudy", reason: "practice labeled commercial" };

  if (normalizeCompanyType(practice) === "Interior Designer") {
    return {
      kind: "verify",
      unverifiable: "kalin",
      reason: "designer practice without residential/commercial label — verify via website",
    };
  }
  return { kind: "tree", reason: k ? `practice "${k}" → lead tree` : "no practice → lead tree" };
}

/**
 * Derive {@link LeadFacts} for the standard tree from a Material Bank order.
 * Country is usually blank in the feed (US-centric) — a present state/zip counts
 * as North America so blank-country orders don't dead-end at Unknown→Lana.
 * Brand/productFocus are unknowable from the feed and left null (the tree's
 * defaults apply).
 */
export function leadFactsFromMaterialBank(order: MaterialBankOrder): LeadFacts {
  const country = order.address.country?.trim() || null;
  const location =
    country ?? (order.address.state || order.address.zip ? "United States" : null);
  return {
    location,
    country,
    role: order.contact.title,
    companySubType: order.company.practice,
    brand: null,
    projectFocus: order.company.practice,
    productFocus: null,
  };
}
