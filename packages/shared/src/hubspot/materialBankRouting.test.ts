import { describe, expect, it } from "vitest";
import {
  decideMaterialBankRouting,
  leadFactsFromMaterialBank,
  materialBankProjectCategory,
} from "./materialBankRouting.js";
import { evaluateLeadOwnership } from "./leadOwnership.js";
import type { MaterialBankOrder } from "../ingest/materialBank.js";

function order(over: {
  practice?: string | null;
  title?: string | null;
  country?: string | null;
  state?: string | null;
  zip?: string | null;
  projectType?: string | null;
  projectName?: string | null;
  projectDescription?: string | null;
}): MaterialBankOrder {
  return {
    orderId: "MB-1",
    contact: {
      name: "A B",
      email: "a@b.com",
      phone: null,
      mobilePhone: null,
      preference: null,
      title: over.title ?? null,
    },
    company: { name: "Firm", practice: over.practice ?? null },
    address: {
      street1: null,
      city: null,
      state: over.state ?? null,
      zip: over.zip ?? null,
      country: over.country ?? null,
    },
    project: {
      name: over.projectName ?? null,
      description: over.projectDescription ?? null,
      phase: null,
      type: over.projectType ?? null,
      budgetRaw: null,
      completionMonth: null,
      completionYear: null,
    },
    lines: [],
  };
}

describe("materialBankProjectCategory", () => {
  it("classified HubSpot project_type wins", () => {
    const o = order({ projectType: "office remodel" }); // raw text says commercial
    expect(materialBankProjectCategory(o, "RESIDENTIAL - PRIVATE RESIDENCE")).toBe("residential");
    expect(materialBankProjectCategory(o, "HOSPITALITY - HOTEL")).toBe("hospitality");
    expect(materialBankProjectCategory(o, "RETAIL - CLOTHING")).toBe("commercial");
    expect(materialBankProjectCategory(o, "C0MMERCIAL - MILITARY")).toBe("commercial"); // enum typo
  });

  it("falls back to raw project text, hospitality outranking", () => {
    expect(materialBankProjectCategory(order({ projectType: "Single Family" }), null)).toBe("residential");
    expect(materialBankProjectCategory(order({ projectName: "Marriott lobby refresh", projectType: "Hotel" }), null)).toBe("hospitality");
    expect(
      materialBankProjectCategory(order({ projectDescription: "New office headquarters" }), null),
    ).toBe("commercial");
    expect(materialBankProjectCategory(order({}), null)).toBeNull();
    // "OTHER -" classification gives no signal
    expect(materialBankProjectCategory(order({}), "OTHER -")).toBeNull();
  });
});

describe("decideMaterialBankRouting", () => {
  it("project signal wins for designers — residential project → Kalin even for commercial firms", () => {
    expect(decideMaterialBankRouting("Commercial Interior Design", "residential").kind).toBe("kalin");
    expect(decideMaterialBankRouting("Residential Interior Design", "hospitality").kind).toBe("rudy");
    expect(decideMaterialBankRouting("Interior Designer", "commercial").kind).toBe("spec");
  });

  it("a hospitality project goes to Rudy for ANY practice — architects and specifiers included", () => {
    expect(decideMaterialBankRouting("Architecture", "hospitality").kind).toBe("rudy");
    expect(decideMaterialBankRouting("Lighting Designer", "hospitality").kind).toBe("rudy");
    expect(decideMaterialBankRouting(null, "hospitality").kind).toBe("rudy");
  });

  it("residential/commercial project signals do NOT hijack non-designers", () => {
    expect(decideMaterialBankRouting("Architecture", "residential").kind).toBe("tree");
    expect(decideMaterialBankRouting("Architecture", "commercial").kind).toBe("tree");
  });

  it.each([
    ["Residential Interior Design", "kalin"],
    ["Interior Designer - Residential", "kalin"],
    ["Commercial Interior Design", "spec"], // Rudy only via hospitality now
    ["Interior Design: Commercial", "spec"],
    ["Hospitality Interior Design", "rudy"],
  ])("no project signal: %s → %s", (practice, kind) => {
    expect(decideMaterialBankRouting(practice, null).kind).toBe(kind);
  });

  it("both labels or unlabeled designer → verify (unverifiable handled as Lana by the api layer)", () => {
    expect(decideMaterialBankRouting("Commercial & Residential Interior Design", null).kind).toBe("verify");
    expect(decideMaterialBankRouting("Interior Designer", null).kind).toBe("verify");
    expect(decideMaterialBankRouting("Interior Design Firm", null).kind).toBe("verify");
  });

  it.each(["Architecture", "Architect", "Other", "", null])(
    "non-designer practice %s → tree",
    (practice) => {
      expect(decideMaterialBankRouting(practice as string | null, null).kind).toBe("tree");
    },
  );
});

describe("leadFactsFromMaterialBank + tree hand-off", () => {
  it("blank country with a state/zip counts as North America", () => {
    const facts = leadFactsFromMaterialBank(order({ state: "TX", zip: "78701" }));
    expect(facts.location).toBe("United States");
    const decision = evaluateLeadOwnership(facts);
    expect(decision.path[0]).toBe("location:North America");
  });

  it("blank country AND address → Unknown → Lana", () => {
    const facts = leadFactsFromMaterialBank(order({}));
    const decision = evaluateLeadOwnership(facts);
    expect(decision.leaf).toMatchObject({ kind: "person", name: "Lana" });
  });

  it("architect practice walks the tree to the Specifier branch", () => {
    const facts = leadFactsFromMaterialBank(order({ practice: "Architect", state: "NY" }));
    const decision = evaluateLeadOwnership(facts);
    // brand is unknown for Material Bank → Specifier default (MF Spec channel)
    expect(decision.leaf).toMatchObject({ kind: "repCode", channel: "MF Spec" });
  });

  it("hospitality project carries into the tree's hospitalityFocus fact", () => {
    const facts = leadFactsFromMaterialBank(order({ state: "NY" }), "hospitality");
    expect(facts.hospitalityFocus).toBe("Hospitality");
    expect(leadFactsFromMaterialBank(order({}), "commercial").hospitalityFocus).toBeNull();
  });

  it("Canadian order routes to Lana", () => {
    const facts = leadFactsFromMaterialBank(order({ country: "Canada", practice: "Architect" }));
    const decision = evaluateLeadOwnership(facts);
    expect(decision.leaf).toMatchObject({ kind: "person", name: "Lana" });
  });
});
