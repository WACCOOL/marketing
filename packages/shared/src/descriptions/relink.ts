/**
 * Descriptions — re-import diff + model-base auto-relink (plan §3.6, decision 4).
 *
 * Commit is two-phase: dryRun runs the relink FIRST, then reports
 * {new, updated, removed, orphaned} so the UI can confirm destructive
 * removals. Marketing renames pre-launch names constantly, so a content row
 * whose content_key vanished is re-attached when exactly ONE new product
 * shares a model base with its old product. Content with edited/approved text
 * is NEVER deleted — it is orphaned and surfaced for manual attach.
 */

export interface DiffProduct {
  content_key: string;
  name: string | null;
  model_bases: string[];
}

export interface DiffContentRow {
  content_key: string;
  /**
   * True when the row holds human work worth preserving: edited/approved
   * status or any *_final / title_override text.
   */
  edited: boolean;
}

export interface CommitDiff {
  /** New products (key not present before). */
  added: { content_key: string; name: string | null }[];
  /** Keys present in both old and new (attributes refresh in place). */
  updated: string[];
  /** Content rows re-keyed by unique model-base intersection (rename case). */
  relinks: { from: string; to: string }[];
  /** Old products truly gone (after relink) — drives the UI confirm. */
  removed: { content_key: string; name: string | null }[];
  /** Content keys kept (edited text) despite their product disappearing. */
  orphaned: string[];
  /** Stale content rows with no human work — safe to delete on commit. */
  deletableContentKeys: string[];
}

export function computeCommitDiff(
  oldProducts: readonly DiffProduct[],
  newProducts: readonly DiffProduct[],
  content: readonly DiffContentRow[],
): CommitDiff {
  const oldByKey = new Map(oldProducts.map((p) => [p.content_key, p]));
  const newKeys = new Set(newProducts.map((p) => p.content_key));
  const contentByKey = new Map(content.map((c) => [c.content_key, c]));

  const added = newProducts
    .filter((p) => !oldByKey.has(p.content_key))
    .map((p) => ({ content_key: p.content_key, name: p.name }));
  const updated = newProducts
    .map((p) => p.content_key)
    .filter((k) => oldByKey.has(k));

  // Index NEW products by model base for the relink pass. Only products that
  // are actually new can be relink targets (an `updated` key keeps its own
  // content row).
  const newByBase = new Map<string, DiffProduct[]>();
  for (const p of newProducts) {
    if (oldByKey.has(p.content_key)) continue;
    for (const base of p.model_bases) {
      const key = base.toUpperCase();
      const list = newByBase.get(key) ?? [];
      list.push(p);
      newByBase.set(key, list);
    }
  }

  const staleOldKeys = oldProducts
    .map((p) => p.content_key)
    .filter((k) => !newKeys.has(k));

  const relinks: { from: string; to: string }[] = [];
  const claimedTargets = new Set<string>();
  const relinkedFrom = new Set<string>();

  // Relink BEFORE computing removed: a stale content row whose old product
  // shares model bases with exactly one new product is a rename, not a loss.
  for (const from of staleOldKeys) {
    if (!contentByKey.has(from)) continue; // nothing to carry over
    const oldProduct = oldByKey.get(from)!;
    const candidates = new Map<string, DiffProduct>();
    for (const base of oldProduct.model_bases) {
      for (const p of newByBase.get(base.toUpperCase()) ?? []) {
        candidates.set(p.content_key, p);
      }
    }
    if (candidates.size !== 1) continue; // ambiguous or none → unmatched
    const target = [...candidates.values()][0]!;
    if (contentByKey.has(target.content_key)) continue; // target already has content
    if (claimedTargets.has(target.content_key)) continue; // one relink per target
    claimedTargets.add(target.content_key);
    relinkedFrom.add(from);
    relinks.push({ from, to: target.content_key });
  }

  const removed = staleOldKeys
    .filter((k) => !relinkedFrom.has(k))
    .map((k) => ({ content_key: k, name: oldByKey.get(k)!.name }));

  const orphaned: string[] = [];
  const deletableContentKeys: string[] = [];
  for (const { content_key } of removed) {
    const row = contentByKey.get(content_key);
    if (!row) continue;
    if (row.edited) orphaned.push(content_key);
    else deletableContentKeys.push(content_key);
  }

  return { added, updated, relinks, removed, orphaned, deletableContentKeys };
}

/** Whether a content row holds human work worth preserving across imports. */
export function contentRowEdited(row: {
  status: string;
  description_final: string | null;
  meta_final: string | null;
  title_override: string | null;
}): boolean {
  return (
    row.status === "in_review" ||
    row.status === "approved" ||
    !!row.description_final ||
    !!row.meta_final ||
    !!row.title_override
  );
}
