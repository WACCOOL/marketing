import { describe, expect, it } from "vitest";
import {
  applyContentApprove,
  applyContentSave,
  brandLikePattern,
  buildVoiceDeriveMessages,
  dedupSkus,
  pickVoiceProfile,
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
