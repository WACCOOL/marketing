import { describe, expect, it } from "vitest";
import {
  computeCommitDiff,
  contentRowEdited,
  countPreservedContent,
  type DiffContentRow,
  type DiffProduct,
} from "./relink.js";

const p = (key: string, name: string | null, bases: string[]): DiffProduct => ({
  content_key: key,
  name,
  model_bases: bases,
});
const c = (key: string, edited = false): DiffContentRow => ({
  content_key: key,
  edited,
});

describe("computeCommitDiff", () => {
  const oldProducts = [
    p("dweled:zalta", "ZALTA", ["WSW990726", "WSW990732"]),
    p("dweled:kiglo", "KIGLO", ["WSW770916", "WSW770924", "PDW770916"]),
  ];

  it("reports added / updated / removed for a plain diff", () => {
    const diff = computeCommitDiff(
      oldProducts,
      [
        p("dweled:zalta", "ZALTA", ["WSW990726"]),
        p("dweled:nuvio", "NUVIO", ["PDW555510"]),
      ],
      [],
    );
    expect(diff.updated).toEqual(["dweled:zalta"]);
    expect(diff.added).toEqual([{ content_key: "dweled:nuvio", name: "NUVIO" }]);
    expect(diff.removed).toEqual([{ content_key: "dweled:kiglo", name: "KIGLO" }]);
    expect(diff.relinks).toEqual([]);
    expect(diff.orphaned).toEqual([]);
    expect(diff.deletableContentKeys).toEqual([]);
  });

  it("re-importing the identical file is a no-op diff", () => {
    const diff = computeCommitDiff(oldProducts, oldProducts, [
      c("dweled:zalta", true),
    ]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.relinks).toEqual([]);
    expect(diff.updated).toHaveLength(2);
  });

  it("relinks a renamed product by unique model-base intersection BEFORE computing removed", () => {
    // Marketing renamed ZALTA → ZELTA: same models, new content_key.
    const diff = computeCommitDiff(
      oldProducts,
      [
        p("dweled:zelta", "ZELTA", ["WSW990726", "WSW990732"]),
        p("dweled:kiglo", "KIGLO", ["WSW770916"]),
      ],
      [c("dweled:zalta", true)],
    );
    expect(diff.relinks).toEqual([{ from: "dweled:zalta", to: "dweled:zelta" }]);
    // The rename is NOT a removal — nothing to confirm, nothing orphaned.
    expect(diff.removed).toEqual([]);
    expect(diff.orphaned).toEqual([]);
    expect(diff.deletableContentKeys).toEqual([]);
  });

  it("ambiguous base intersection (2+ candidates) leaves the row unmatched", () => {
    const diff = computeCommitDiff(
      [p("dweled:kiglo", "KIGLO", ["WSW770916", "WSW770924"])],
      [
        p("dweled:kiglo-a", "KIGLO A", ["WSW770916"]),
        p("dweled:kiglo-b", "KIGLO B", ["WSW770924"]),
      ],
      [c("dweled:kiglo", true)],
    );
    expect(diff.relinks).toEqual([]);
    expect(diff.removed.map((r) => r.content_key)).toEqual(["dweled:kiglo"]);
    expect(diff.orphaned).toEqual(["dweled:kiglo"]); // edited → kept
  });

  it("never relinks onto a key that already has a content row", () => {
    const diff = computeCommitDiff(
      [p("dweled:old", "OLD", ["WSW111111"])],
      [p("dweled:new", "NEW", ["WSW111111"])],
      [c("dweled:old", true), c("dweled:new", false)],
    );
    expect(diff.relinks).toEqual([]);
    expect(diff.orphaned).toEqual(["dweled:old"]);
  });

  it("splits stale content into orphaned (edited) vs deletable (untouched drafts)", () => {
    const diff = computeCommitDiff(
      oldProducts,
      [p("dweled:nuvio", "NUVIO", ["PDW555510"])],
      [c("dweled:zalta", true), c("dweled:kiglo", false)],
    );
    expect(diff.removed.map((r) => r.content_key).sort()).toEqual([
      "dweled:kiglo",
      "dweled:zalta",
    ]);
    expect(diff.orphaned).toEqual(["dweled:zalta"]);
    expect(diff.deletableContentKeys).toEqual(["dweled:kiglo"]);
  });

  it("stale products without content rows still count as removed (for the confirm)", () => {
    const diff = computeCommitDiff(oldProducts, [], []);
    expect(diff.removed).toHaveLength(2);
    expect(diff.orphaned).toEqual([]);
    expect(diff.deletableContentKeys).toEqual([]);
  });

  it("only one relink may claim a given target", () => {
    // Two old products share a base with ONE new product: each sees exactly
    // one candidate, but the target can only absorb one content row.
    const diff = computeCommitDiff(
      [
        p("dweled:a", "A", ["WSW222222"]),
        p("dweled:b", "B", ["WSW222222"]),
      ],
      [p("dweled:merged", "MERGED", ["WSW222222"])],
      [c("dweled:a", true), c("dweled:b", true)],
    );
    expect(diff.relinks).toHaveLength(1);
    expect(diff.orphaned).toHaveLength(1);
  });
});

describe("countPreservedContent", () => {
  it("counts copy-bearing rows that survive in place plus relinked rows", () => {
    const kept = countPreservedContent(
      {
        updated: ["dweled:zalta", "dweled:kiglo"],
        relinks: [{ from: "dweled:old", to: "dweled:new" }],
      },
      [
        { content_key: "dweled:zalta", hasCopy: true }, // survives in place
        { content_key: "dweled:kiglo", hasCopy: false }, // no copy → not counted
        { content_key: "dweled:old", hasCopy: true }, // carried by relink
        { content_key: "dweled:gone", hasCopy: true }, // orphaned → not kept
      ],
    );
    expect(kept).toBe(2);
  });

  it("is zero with no content or no survivors", () => {
    expect(countPreservedContent({ updated: [], relinks: [] }, [])).toBe(0);
    expect(
      countPreservedContent({ updated: ["a"], relinks: [] }, [
        { content_key: "b", hasCopy: true },
      ]),
    ).toBe(0);
  });
});

describe("contentRowEdited", () => {
  const base = {
    status: "generated",
    description_final: null,
    meta_final: null,
    title_override: null,
  };
  it("detects human work via status or final/override text", () => {
    expect(contentRowEdited(base)).toBe(false);
    expect(contentRowEdited({ ...base, status: "none" })).toBe(false);
    expect(contentRowEdited({ ...base, status: "approved" })).toBe(true);
    expect(contentRowEdited({ ...base, status: "in_review" })).toBe(true);
    expect(contentRowEdited({ ...base, description_final: "text" })).toBe(true);
    expect(contentRowEdited({ ...base, meta_final: "m" })).toBe(true);
    expect(contentRowEdited({ ...base, title_override: "t" })).toBe(true);
  });
});
