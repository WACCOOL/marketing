/**
 * Descriptions — xlsx drawing-anchor → PPID-group mapping (plan Stage 2).
 *
 * The browser extracts drawing anchors ({sheet, row, imageId}) from the
 * workbook zip; parseMasterWorkbook exposes each group's contiguous sheet-row
 * span. An anchor whose from-row falls inside a span belongs to that group
 * (verified against the real workbooks: every product render anchors inside
 * its group's rows). Anchors outside every span (logos, header art, images
 * floating in gap rows) come back unassigned and surface as warnings.
 */

import type { GroupRowSpan } from "./parseMaster.js";

export interface DrawingAnchor {
  sheet: string;
  /** 0-based sheet row of the anchor's from-cell. */
  row: number;
  /** 0-based column of the from-cell (kept for stable sort order). */
  col: number;
  /** Extractor-local media id (e.g. the zip media path). */
  imageId: string;
}

export interface AnchorAssignment {
  anchor: DrawingAnchor;
  /** The owning group, or null when the anchor sits outside every span. */
  content_key: string | null;
}

/**
 * Assign each anchor to the group whose row span contains it. Assignments
 * keep the input order; callers derive per-group sort order from
 * (row, col) of the anchor.
 */
export function mapAnchorsToGroups(
  anchors: readonly DrawingAnchor[],
  spans: readonly GroupRowSpan[],
): AnchorAssignment[] {
  const bySheet = new Map<string, GroupRowSpan[]>();
  for (const span of spans) {
    const list = bySheet.get(span.sheet) ?? [];
    list.push(span);
    bySheet.set(span.sheet, list);
  }
  for (const list of bySheet.values()) {
    list.sort((a, b) => a.startRow - b.startRow);
  }

  return anchors.map((anchor) => {
    const list = bySheet.get(anchor.sheet) ?? [];
    const hit = list.find(
      (s) => anchor.row >= s.startRow && anchor.row <= s.endRow,
    );
    return { anchor, content_key: hit ? hit.content_key : null };
  });
}
