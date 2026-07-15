/**
 * Material Bank deal/contact owner routing (pure).
 *
 * Priority (per the 2026-07-15 routing change):
 *   0. (api layer) contact already has an owner other than Lana → that owner,
 *      always — beats every rule below.
 *   1. PROJECT signal (Material Bank orders carry project data leads don't):
 *      residential project → Kalin even when the firm does commercial work;
 *      hospitality project → Rudy; other commercial project → the spec rep
 *      covering the contact's ZIP.
 *   2. Practice label: residential-only firm → Kalin; commercial-only firm →
 *      spec (Rudy gets commercial ONLY via a hospitality signal); label
 *      mentions hospitality → Rudy.
 *   3. Both/unlabeled designers → crawl the firm's website and verify
 *      (residential → Kalin; hospitality → Rudy; commercial → spec);
 *      UNVERIFIABLE → Lana (manual triage).
 *   4. Non-designers → the standard lead-ownership tree.
 *
 * The api layer applies the contact-owner and national-account overrides and
 * turns the outcome into owner ids (this module stays IO-free, like
 * {@link ./leadOwnership}).
 */

import type { LeadFacts } from "./leadOwnership.js";
import { normalizeCompanyType } from "./leadOwnership.js";
import type { MaterialBankOrder } from "../ingest/materialBank.js";

/** What the order's own project data says the project is. */
export type MaterialBankProjectCategory = "residential" | "hospitality" | "commercial" | null;

const HOSPITALITY_RE = /hospitality|hotel|resort|casino|restaurant|assisted living|senior living/i;
const RESIDENTIAL_RE = /residential|single.?family|multi.?family|private residence|condo|apartment|townho(me|use)/i;
const COMMERCIAL_RE = /commercial|office|retail|healthcare|medical|education|school|university|institutional|workplace|civic|municipal/i;

/**
 * Categorize the PROJECT from the order's own fields (Material Bank's
 * ProjectType label, name, description) plus, when available, our classified
 * HubSpot `project_type` ("RESIDENTIAL - …", "HOSPITALITY - …", …). The
 * classified value is checked first (most reliable), then the raw text.
 * Hospitality outranks the other keywords wherever both appear.
 */
export function materialBankProjectCategory(
  order: MaterialBankOrder,
  classifiedProjectType?: string | null,
): MaterialBankProjectCategory {
  const classified = (classifiedProjectType ?? "").trim().toUpperCase();
  if (classified.startsWith("HOSPITALITY")) return "hospitality";
  if (classified.startsWith("RESIDENTIAL")) return "residential";
  if (
    classified.startsWith("COMMERCIAL") ||
    classified.startsWith("C0MMERCIAL") || // the real enum's typo'd military option
    classified.startsWith("RETAIL") ||
    classified.startsWith("COMMUNITY")
  ) {
    return "commercial";
  }

  const text = [order.project.type, order.project.name, order.project.description]
    .filter(Boolean)
    .join(" ");
  if (!text) return null;
  if (HOSPITALITY_RE.test(text)) return "hospitality";
  if (RESIDENTIAL_RE.test(text)) return "residential";
  if (COMMERCIAL_RE.test(text)) return "commercial";
  return null;
}

export type MaterialBankRouting =
  /** Fixed owner, decided by project/practice signals. */
  | { kind: "kalin" | "rudy" | "lana"; reason: string }
  /** Commercial, non-hospitality → the spec rep covering the contact's ZIP. */
  | { kind: "spec"; reason: string }
  /**
   * Designer whose focus needs website verification. The verdict maps
   * residential → Kalin, hospitality → Rudy, commercial → spec;
   * `unverifiable` (no site / model unsure) → Lana.
   */
  | { kind: "verify"; reason: string }
  /** Not a designer — walk the standard lead-ownership tree. */
  | { kind: "tree"; reason: string };

/**
 * Decide the routing mode from the order's project signal + practice label.
 * Matching is contains-based so label variants all resolve.
 */
export function decideMaterialBankRouting(
  practice: string | null | undefined,
  projectCategory: MaterialBankProjectCategory,
): MaterialBankRouting {
  const k = (practice ?? "").trim().toLowerCase();
  const residential = /residential/.test(k);
  const commercial = /commercial/.test(k);
  const isDesigner =
    residential || commercial || normalizeCompanyType(practice) === "Interior Designer";

  // 1. The project's own signal wins for designers — a residential project goes
  //    to Kalin even when the firm does commercial work.
  if (isDesigner && projectCategory) {
    if (projectCategory === "residential") {
      return { kind: "kalin", reason: `residential project (${projectCategory})` };
    }
    if (projectCategory === "hospitality") {
      return { kind: "rudy", reason: "hospitality project" };
    }
    return { kind: "spec", reason: "commercial (non-hospitality) project" };
  }

  // 2. Practice label.
  if (HOSPITALITY_RE.test(k)) return { kind: "rudy", reason: "practice labeled hospitality" };
  if (residential && commercial) {
    return { kind: "verify", reason: "practice labeled commercial+residential — verify via website" };
  }
  if (residential) return { kind: "kalin", reason: "practice labeled residential" };
  if (commercial) {
    return { kind: "spec", reason: "practice labeled commercial (non-hospitality) → spec" };
  }

  // 3. Designer with no residential/commercial label → verify.
  if (isDesigner) {
    return { kind: "verify", reason: "designer practice without focus label — verify via website" };
  }

  // 4. Everything else → the standard tree.
  return { kind: "tree", reason: k ? `practice "${k}" → lead tree` : "no practice → lead tree" };
}

/**
 * Derive {@link LeadFacts} for the standard tree from a Material Bank order.
 * Country is usually blank in the feed (US-centric) — a present state/zip counts
 * as North America so blank-country orders don't dead-end at Unknown→Lana.
 * Brand/productFocus are unknowable from the feed and left null (the tree's
 * defaults apply). hospitalityFocus carries the order's project signal so the
 * tree's commercial-designer branch stays consistent with the direct rules.
 */
export function leadFactsFromMaterialBank(
  order: MaterialBankOrder,
  projectCategory: MaterialBankProjectCategory = null,
): LeadFacts {
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
    hospitalityFocus: projectCategory === "hospitality" ? "Hospitality" : null,
  };
}
