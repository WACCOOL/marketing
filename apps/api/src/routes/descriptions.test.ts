import { describe, expect, it } from "vitest";
import { trayAssignError } from "./descriptions.js";

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
