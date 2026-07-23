import { describe, expect, it } from "vitest";
import {
  TRAY_VISION_SYSTEM,
  TRAY_VISION_USER,
  applyContentApprove,
  applyContentSave,
  attachContentError,
  brandLikePattern,
  buildVoiceDeriveMessages,
  dedupSkus,
  deleteProductsPlan,
  parseTrayVisionName,
  pickVoiceProfile,
  resolveTrayMatch,
  trayAssignError,
} from "./descriptions.js";

describe("trayAssignError (tray reassignment guard)", () => {
  it("404s a missing image", () => {
    expect(trayAssignError(null, null)).toEqual({
      error: "image not found",
      status: 404,
    });
  });

  it("rejects non-tray images (xlsx renders, deck heroes)", () => {
    for (const slot of ["dweled_master", "mf_master", "schonbek_master", "dweled_pptx", "mf_pdf"]) {
      const res = trayAssignError({ slot }, { found: true, slot: "schonbek_master" });
      expect(res?.status).toBe(400);
    }
  });

  it("404s an unknown target product", () => {
    expect(
      trayAssignError({ slot: "schonbek_pdf" }, { found: false }),
    ).toEqual({ error: "product not found", status: 404 });
  });

  it("rejects cross-slot assignment onto non-Schonbek products", () => {
    for (const slot of ["dweled_master", "mf_master"]) {
      const res = trayAssignError(
        { slot: "schonbek_pdf" },
        { found: true, slot },
      );
      expect(res?.status).toBe(400);
      expect(res?.error).toContain("Schonbek master");
    }
  });

  it("allows assignment onto a Schonbek master product", () => {
    expect(
      trayAssignError(
        { slot: "schonbek_pdf" },
        { found: true, slot: "schonbek_master" },
      ),
    ).toBeNull();
  });

  it("allows unassignment (null target) of a tray image", () => {
    expect(trayAssignError({ slot: "schonbek_pdf" }, null)).toBeNull();
  });
});

describe("attachContentError (orphan attach guard)", () => {
  const orphan = { content_key: "dweled:zalta" };
  const emptyTarget = {
    status: "none",
    description_ai: null,
    description_final: null,
    meta_ai: null,
    meta_final: null,
    title_override: null,
  };

  it("404s a missing content row", () => {
    expect(attachContentError(null, false, null, null)).toEqual({
      error: "content row not found",
      status: 404,
    });
  });

  it("rejects moving copy that is still attached to a live product", () => {
    const res = attachContentError(orphan, true, { content_key: "dweled:x" }, null);
    expect(res).toMatchObject({ status: 400 });
  });

  it("404s an unknown target key", () => {
    const res = attachContentError(orphan, false, null, null);
    expect(res).toMatchObject({ status: 404 });
  });

  it("rejects attaching onto itself", () => {
    const res = attachContentError(
      orphan,
      false,
      { content_key: "dweled:zalta" },
      null,
    );
    expect(res).toMatchObject({ status: 400 });
  });

  it("rejects a target that already holds copy or review state", () => {
    for (const existing of [
      { ...emptyTarget, description_ai: "AI draft" },
      { ...emptyTarget, description_final: "edited" },
      { ...emptyTarget, meta_ai: "meta" },
      { ...emptyTarget, meta_final: "meta" },
      { ...emptyTarget, title_override: "T" },
      { ...emptyTarget, status: "generated" },
      { ...emptyTarget, status: "approved" },
    ]) {
      const res = attachContentError(
        orphan,
        false,
        { content_key: "dweled:nuvio" },
        existing,
      );
      expect(res).toMatchObject({ status: 409 });
    }
  });

  it("allows attach onto a bare product, replacing an empty placeholder row", () => {
    expect(
      attachContentError(orphan, false, { content_key: "dweled:nuvio" }, null),
    ).toEqual({ ok: true, replaceEmptyTarget: false });
    expect(
      attachContentError(
        orphan,
        false,
        { content_key: "dweled:nuvio" },
        emptyTarget,
      ),
    ).toEqual({ ok: true, replaceEmptyTarget: true });
  });
});

describe("applyContentSave (content PATCH field mapper)", () => {
  it("rejects an empty save", () => {
    expect(applyContentSave(null, {}).error).toBe("nothing to save");
  });

  it("trims a title override and folds blanks to null", () => {
    expect(applyContentSave(null, { title_override: "  Fictona Pendant  " }).fields)
      .toEqual({ title_override: "Fictona Pendant" });
    expect(applyContentSave(null, { title_override: "   " }).fields)
      .toEqual({ title_override: null });
    expect(applyContentSave(null, { title_override: null }).fields)
      .toEqual({ title_override: null });
  });

  it("a title override alone never moves the status", () => {
    for (const status of ["none", "generated", "in_review"] as const) {
      const { fields } = applyContentSave({ status }, { title_override: "T" });
      expect(fields.status).toBeUndefined();
    }
  });

  it("trims a name override, folds blanks to null, never moves the status", () => {
    expect(applyContentSave(null, { name_override: "  Velmora  " }).fields)
      .toEqual({ name_override: "Velmora" });
    expect(applyContentSave(null, { name_override: "   " }).fields)
      .toEqual({ name_override: null });
    for (const status of ["none", "generated", "in_review"] as const) {
      const { fields } = applyContentSave({ status }, { name_override: "N" });
      expect(fields.status).toBeUndefined();
    }
  });

  it("rejects a name override on an approved row (reopen first)", () => {
    const res = applyContentSave({ status: "approved" }, { name_override: "N" });
    expect(res.error).toContain("reopen");
    expect(res.fields).toEqual({});
  });

  it("an edited description bumps none/generated to in_review", () => {
    expect(
      applyContentSave({ status: "none" }, { description: "Hand-written." }).fields,
    ).toMatchObject({ description_final: "Hand-written.", status: "in_review" });
    expect(
      applyContentSave({ status: "generated" }, { meta: "Meta." }).fields,
    ).toMatchObject({ meta_final: "Meta.", status: "in_review" });
  });

  it("leaves the in_review status alone", () => {
    expect(
      applyContentSave({ status: "in_review" }, { description: "Edit." }).fields.status,
    ).toBeUndefined();
  });

  it("rejects EVERY edit on an approved row (reopen first) — Stage 3 QA", () => {
    for (const patch of [
      { description: "Edit." },
      { meta: "Meta." },
      { title_override: "Title" },
    ]) {
      const res = applyContentSave({ status: "approved" }, patch);
      expect(res.error).toContain("reopen");
      expect(res.fields).toEqual({});
    }
  });

  it("clearing a description does not bump the status", () => {
    const { fields } = applyContentSave({ status: "none" }, { description: null });
    expect(fields).toEqual({ description_final: null });
  });
});

describe("applyContentApprove (row-level approval)", () => {
  const row = (over: Partial<{
    status: "none" | "generated" | "in_review" | "approved";
    description_ai: string | null;
    description_final: string | null;
  }> = {}) => ({
    status: "generated" as const,
    description_ai: "AI draft.",
    description_final: null,
    ...over,
  });

  it("approves a row with an AI description", () => {
    const { fields, error } = applyContentApprove(row(), {});
    expect(error).toBeUndefined();
    expect(fields.status).toBe("approved");
  });

  it("requires a non-empty effective description (final ?? ai)", () => {
    expect(applyContentApprove(null, {}).error).toContain("nothing to approve");
    expect(
      applyContentApprove(row({ description_ai: null }), {}).error,
    ).toContain("nothing to approve");
    expect(
      applyContentApprove(
        row({ description_ai: null, description_final: "Edited." }),
        {},
      ).fields.status,
    ).toBe("approved");
  });

  it("folds edits passed along with the approval (approve-with-edits)", () => {
    const { fields } = applyContentApprove(row(), {
      description: "  Final text.  ",
      meta: "Meta text.",
      title_override: "T",
    });
    expect(fields).toEqual({
      description_final: "Final text.",
      meta_final: "Meta text.",
      title_override: "T",
      status: "approved",
    });
  });

  it("a blank description passed with approve blocks the approval", () => {
    expect(
      applyContentApprove(row(), { description: "   " }).error,
    ).toContain("nothing to approve");
  });

  it("rejects approve-with-edits on an already approved row (reopen lock)", () => {
    const approvedRow = row({ status: "approved" });
    for (const patch of [
      { description: "sneaked edit" },
      { meta: "sneaked meta" },
      { title_override: "sneaked title" },
    ]) {
      const res = applyContentApprove(approvedRow, patch);
      expect(res.error).toContain("reopen");
      expect(res.fields).toEqual({});
    }
  });

  it("a plain re-approve of an approved row stays a harmless no-op", () => {
    const { fields, error } = applyContentApprove(row({ status: "approved" }), {});
    expect(error).toBeUndefined();
    expect(fields).toEqual({ status: "approved" });
  });
});

describe("tray vision match (POST /tray/match pure parts)", () => {
  it("the prompt demands the name only, with a NONE escape hatch", () => {
    expect(TRAY_VISION_USER).toContain("ONLY the name");
    expect(TRAY_VISION_USER).toContain("NONE");
    expect(TRAY_VISION_USER).toContain("top-left");
    expect(TRAY_VISION_SYSTEM).toContain("WAC Group");
  });

  describe("parseTrayVisionName", () => {
    it("trims wrapping quotes and trailing punctuation", () => {
      expect(parseTrayVisionName('  "VELMORA"  ')).toBe("VELMORA");
      expect(parseTrayVisionName("Velmora.")).toBe("Velmora");
    });
    it("folds NONE and empty to null", () => {
      expect(parseTrayVisionName("NONE")).toBeNull();
      expect(parseTrayVisionName("none")).toBeNull();
      expect(parseTrayVisionName("   ")).toBeNull();
    });
    it("rejects chatty answers that cannot be a product name", () => {
      expect(
        parseTrayVisionName(
          "The product name printed near the top-left of this slide is VELMORA",
        ),
      ).toBeNull();
    });
  });

  describe("resolveTrayMatch", () => {
    const products = [
      { id: "p1", content_key: "beyond-2027:velmora", name: "VELMORA" },
      { id: "p2", content_key: "beyond-2027:briga", name: "BRIGA" },
      { id: "p3", content_key: "beyond-2027:brigg", name: "BRIGG" },
      { id: "p4", content_key: "sigfor-2027:41qf0303", name: "41QF0303" },
    ];

    it("case-fold exact match wins", () => {
      expect(resolveTrayMatch("Velmora", products)?.id).toBe("p1");
    });
    it("fuzzy (Levenshtein ≤2) matches spelling drift", () => {
      expect(resolveTrayMatch("VELMORE", products)?.id).toBe("p1");
    });
    it("ambiguous fuzzy hits stay unmatched (never guess)", () => {
      // BRIGA vs BRIGG are both ≤2 away from BRIGAA.
      expect(resolveTrayMatch("BRIGAA", products)).toBeNull();
    });
    it("no match returns null", () => {
      expect(resolveTrayMatch("ZORVIT", products)).toBeNull();
    });
  });
});

describe("deleteProductsPlan (POST /products/delete planner)", () => {
  const found = [
    { id: "a", slot: "dweled_master", content_key: "dweled:fictona" },
    { id: "b", slot: "dweled_master", content_key: "dweled:beamlet" },
    { id: "c", slot: "mf_master", content_key: "mf:glowlet" },
  ];

  it("404s when none of the requested ids exist (stale client state)", () => {
    expect(deleteProductsPlan(["x", "y"], [])).toEqual({
      error: "no matching products found",
      status: 404,
    });
  });

  it("groups doomed content keys per slot for the copy delete", () => {
    const plan = deleteProductsPlan(["a", "b", "c"], found);
    if ("error" in plan) throw new Error("expected a plan");
    expect(plan.missing).toBe(0);
    expect([...plan.keysBySlot.keys()].sort()).toEqual([
      "dweled_master",
      "mf_master",
    ]);
    expect(plan.keysBySlot.get("dweled_master")).toEqual([
      "dweled:fictona",
      "dweled:beamlet",
    ]);
    expect(plan.keysBySlot.get("mf_master")).toEqual(["mf:glowlet"]);
  });

  it("counts unknown ids as missing instead of failing the whole delete", () => {
    const plan = deleteProductsPlan(["a", "gone-1", "gone-2"], [found[0]!]);
    if ("error" in plan) throw new Error("expected a plan");
    expect(plan.missing).toBe(2);
    expect(plan.keysBySlot.get("dweled_master")).toEqual(["dweled:fictona"]);
  });
});

describe("pickVoiceProfile", () => {
  const profiles = [
    { brand: "WAC Lighting", collection: "Dweled" },
    { brand: "WAC Lighting", collection: "Limited" },
    { brand: "Schonbek", collection: "Beyond" },
  ];

  it("prefers the exact brand+collection match (case-insensitive)", () => {
    expect(pickVoiceProfile(profiles, "schonbek", "BEYOND")).toBe(profiles[2]);
    expect(pickVoiceProfile(profiles, "WAC Lighting", "Limited")).toBe(profiles[1]);
  });

  it("falls back to a same-brand profile in seed order", () => {
    expect(pickVoiceProfile(profiles, "WAC Lighting", "Unseen")).toBe(profiles[0]);
    expect(pickVoiceProfile(profiles, "Schonbek", "Forever")).toBe(profiles[2]);
  });

  it("returns null for an unknown brand", () => {
    expect(pickVoiceProfile(profiles, "Aispire", "Core")).toBeNull();
  });
});

describe("dedupSkus (voice reference PUT)", () => {
  it("drops case-insensitive duplicates, first occurrence wins", () => {
    expect(dedupSkus(["AA-1", "aa-1", "BB-2", "AA-1"])).toEqual(["AA-1", "BB-2"]);
  });
  it("passes a clean list through untouched", () => {
    expect(dedupSkus(["AA-1", "BB-2"])).toEqual(["AA-1", "BB-2"]);
  });
});

describe("brandLikePattern", () => {
  it("matches on the leading brand word", () => {
    expect(brandLikePattern("WAC Lighting")).toBe("%WAC%");
    expect(brandLikePattern("Modern Forms")).toBe("%Modern%");
    expect(brandLikePattern("Schonbek")).toBe("%Schonbek%");
  });
});

describe("buildVoiceDeriveMessages", () => {
  const refs = [
    { sku: "TEST-1", name: "Fictona", copy: "Soft light for quiet rooms." },
    { sku: "TEST-2", name: "Beamlet", copy: "x".repeat(5000) },
  ];
  it("includes every reference's copy, capped per reference", () => {
    const { user } = buildVoiceDeriveMessages("Schonbek", "Beyond", refs);
    expect(user).toContain("Fictona (TEST-1)");
    expect(user).toContain("Soft light for quiet rooms.");
    expect(user).toContain("Beamlet (TEST-2)");
    expect(user.length).toBeLessThan(3000); // 5000-char copy was capped
  });
  it("asks for ~120 words and bans em dashes and bare WAC", () => {
    const { system, user } = buildVoiceDeriveMessages("Schonbek", "Beyond", refs);
    expect(user).toContain("120 words");
    expect(user).toContain("Do not use em dashes");
    expect(user).toContain("WAC Group");
    expect(system).toContain("WAC Group");
    expect(system).not.toMatch(/—/);
  });
});
