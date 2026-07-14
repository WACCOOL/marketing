import { describe, expect, it } from "vitest";
import {
  decideMaterialBankRouting,
  leadFactsFromMaterialBank,
} from "./materialBankRouting.js";
import { evaluateLeadOwnership } from "./leadOwnership.js";
import type { MaterialBankOrder } from "../ingest/materialBank.js";

describe("decideMaterialBankRouting", () => {
  it.each([
    ["Residential Interior Design", "kalin"],
    ["Interior Designer - Residential", "kalin"],
    ["residential", "kalin"],
    ["Commercial Interior Design", "rudy"],
    ["Interior Design: Commercial", "rudy"],
  ])("%s → %s", (practice, kind) => {
    expect(decideMaterialBankRouting(practice).kind).toBe(kind);
  });

  it("both labels → verify, unverifiable defaults to Rudy", () => {
    const d = decideMaterialBankRouting("Commercial & Residential Interior Design");
    expect(d).toMatchObject({ kind: "verify", unverifiable: "rudy" });
  });

  it("unlabeled designer → verify, unverifiable defaults to Kalin (residential default)", () => {
    const d = decideMaterialBankRouting("Interior Designer");
    expect(d).toMatchObject({ kind: "verify", unverifiable: "kalin" });
    expect(decideMaterialBankRouting("Interior Design Firm")).toMatchObject({
      kind: "verify",
      unverifiable: "kalin",
    });
  });

  it.each(["Architecture", "Architect", "Other", "", null])(
    "non-designer practice %s → tree",
    (practice) => {
      expect(decideMaterialBankRouting(practice as string | null).kind).toBe("tree");
    },
  );

  // "residential" appears inside other practice words? Guard the obvious ones.
  it("does not misread architecture practices with residential in the name", () => {
    // still a routing question, but a *labeled* one — residential architecture
    // firms should reach Kalin only via the residential label, which is intended
    expect(decideMaterialBankRouting("Residential Architecture").kind).toBe("kalin");
  });
});

function order(over: {
  practice?: string | null;
  title?: string | null;
  country?: string | null;
  state?: string | null;
  zip?: string | null;
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
      name: null,
      description: null,
      phase: null,
      type: null,
      budgetRaw: null,
      completionMonth: null,
      completionYear: null,
    },
    lines: [],
  };
}

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

  it("Canadian order routes to Lana", () => {
    const facts = leadFactsFromMaterialBank(order({ country: "Canada", practice: "Architect" }));
    const decision = evaluateLeadOwnership(facts);
    expect(decision.leaf).toMatchObject({ kind: "person", name: "Lana" });
  });
});
