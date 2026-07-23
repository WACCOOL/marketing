import { describe, expect, it } from "vitest";
import {
  applyContentSave,
  brandLikePattern,
  buildVoiceDeriveMessages,
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
    for (const status of ["none", "generated", "in_review", "approved"] as const) {
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

  it("leaves in_review/approved statuses alone", () => {
    expect(
      applyContentSave({ status: "in_review" }, { description: "Edit." }).fields.status,
    ).toBeUndefined();
    expect(
      applyContentSave({ status: "approved" }, { description: "Edit." }).fields.status,
    ).toBeUndefined();
  });

  it("clearing a description does not bump the status", () => {
    const { fields } = applyContentSave({ status: "none" }, { description: null });
    expect(fields).toEqual({ description_final: null });
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
