// =============================================================================
// Product accessory / component / replacement-part reference parsing.
//
// Pure helpers behind the Sales Layer sync's product_accessories capture
// (docs/thom-product-compatibility-plan.md, v2.1 §A + the G.0 audit addendum).
// The sync collects RAW refs at map time from the mapped connector rows (the
// collectDocs idiom — raw_json strips arrays, so it is not a reliable source),
// then resolves + dedupes them post-loop once the full product map and the
// RAW pre-filter variant index exist.
//
// Field families (G.0-audited; everything else is empty in the feed):
//  * product `zmataccess` / `zmataccesstyp2` — comma-joined parent PPIDs
//    (confirmed accessories; 100% resolve to products.sku in the audit).
//  * product `zacc1/zacc2` + `zacc1_1..10` / `zacc2_1..10` — AiSpire CODE
//    lists; zacc2 CONTINUES zacc1 (one overflow list, weakly slot-typed
//    global positions: zacc1_N → N, zacc2_N → 10+N). "0" and N/A are empty
//    slots, skipped.
//  * product `zcomp1..10` — AiSpire component codes.
//  * product `matnracc1..3,5` — accessory material numbers (matnracc4 is
//    empty everywhere and skipped).
//  * variant `zacc1_N` — accessory SKU with `zacc2_N` as its PAIRED human
//    label (Modern Forms fans). The label is captured on the `label` column
//    and NEVER as a second code row.
//  * variant `matnracc1..5` — orderable replacement-part SKUs
//    (kind 'replacement_part').
//  * variant `zcomp1..3` — component codes.
// =============================================================================

export type AccessoryKind = "accessory" | "component" | "replacement_part";

/** A ref as collected at map time — no owner, no resolution yet. */
export interface RawAccessoryRef {
  /** Raw referenced code exactly as exported. */
  related_sku: string;
  kind: AccessoryKind;
  /** Paired human label (variant zacc2_N), when the source carries one. */
  label: string | null;
  /** The connector column the ref came from (exact, e.g. "zacc1_3"). */
  source_field: string;
  /** Global slot index (see header). Null when the source has no slot. */
  position: number | null;
}

/** A resolved ref, ready for the product_accessories upsert. */
export interface AccessoryRef extends RawAccessoryRef {
  /** Owning product PPID. */
  product_sku: string;
  /** Resolved parent PPID, or null when the code targets nothing we synced. */
  related_product_sku: string | null;
}

/** Trim/uppercase normalization for SKU/code identity comparisons. Resolution
 *  is identity, not visibility — both sides of every lookup go through this. */
export function normalizeSkuKey(v: string): string {
  return v.trim().toUpperCase();
}

/** Clean one exported code cell: trim, drop empty / "0" / N/A placeholders
 *  (PL6: those are empty slots, not codes). Returns the raw trimmed code. */
export function cleanAccessoryCode(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  if (!s || s === "0" || /^n\/?a$/i.test(s)) return null;
  return s;
}

/** Clean a paired human label (variant zacc2_N): trim, drop empty / "0" / N/A;
 *  case preserved (it is display text, not a code). */
export function cleanAccessoryLabel(v: unknown): string | null {
  return cleanAccessoryCode(v);
}

/** Split a comma-joined code list (zmataccess "528, 530,531") into cleaned
 *  codes, preserving order; empty/placeholder segments dropped. */
export function splitCodeList(v: unknown): string[] {
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  if (!s.trim()) return [];
  return s
    .split(",")
    .map((part) => cleanAccessoryCode(part))
    .filter((c): c is string => c !== null);
}

/** Global slot position for the zacc continuation list: zacc1_N → N,
 *  zacc2_N → 10+N (one overflow list, per PL6 — ordering promises nothing). */
export function zaccSlotPosition(family: 1 | 2, n: number): number {
  return family === 1 ? n : 10 + n;
}

/**
 * Collect the raw accessory refs from one mapped PRODUCT row.
 * zmataccess/zmataccesstyp2 are parent-PPID lists; zacc/zcomp/matnracc are
 * AiSpire-style code lists. Kind: zcomp* → component, everything else at
 * product level → accessory.
 */
export function collectProductAccessoryRefs(
  p: Record<string, unknown>,
): RawAccessoryRef[] {
  const out: RawAccessoryRef[] = [];

  // Comma-joined parent PPIDs; position = 1-based list index.
  for (const field of ["zmataccess", "zmataccesstyp2"]) {
    splitCodeList(p[field]).forEach((code, i) => {
      out.push({ related_sku: code, kind: "accessory", label: null, source_field: field, position: i + 1 });
    });
  }

  // zacc continuation list: bare zacc1/zacc2 (no slot) + zacc1_1..10 /
  // zacc2_1..10 (global slots 1–20). Comma-joined cells split defensively,
  // sharing the slot's position.
  for (const fam of [1, 2] as const) {
    for (const code of splitCodeList(p[`zacc${fam}`])) {
      out.push({ related_sku: code, kind: "accessory", label: null, source_field: `zacc${fam}`, position: null });
    }
    for (let n = 1; n <= 10; n++) {
      const field = `zacc${fam}_${n}`;
      for (const code of splitCodeList(p[field])) {
        out.push({ related_sku: code, kind: "accessory", label: null, source_field: field, position: zaccSlotPosition(fam, n) });
      }
    }
  }

  // zcomp1..10 → components.
  for (let n = 1; n <= 10; n++) {
    const field = `zcomp${n}`;
    for (const code of splitCodeList(p[field])) {
      out.push({ related_sku: code, kind: "component", label: null, source_field: field, position: n });
    }
  }

  // matnracc1..3,5 (matnracc4 empty everywhere — deliberately skipped).
  for (const n of [1, 2, 3, 5]) {
    const field = `matnracc${n}`;
    for (const code of splitCodeList(p[field])) {
      out.push({ related_sku: code, kind: "accessory", label: null, source_field: field, position: n });
    }
  }

  return out;
}

/**
 * Collect the raw accessory refs from one mapped VARIANT row. Variant
 * semantics DIFFER from product level:
 *  * zacc1_N is an accessory SKU whose PAIRED human label is zacc2_N
 *    (Modern Forms fans) — zacc2_N is captured as `label`, never as a code;
 *  * matnracc1..5 are orderable replacement-part SKUs → 'replacement_part';
 *  * zcomp1..3 → 'component'.
 * Bare variant zacc1/zacc2, zacc1_6/_7, zacc2_* beyond labels, and matnracc6
 * are empty everywhere in the feed (G.0) and not read.
 */
export function collectVariantAccessoryRefs(
  v: Record<string, unknown>,
): RawAccessoryRef[] {
  const out: RawAccessoryRef[] = [];

  // MFF accessory SKU + paired label pairs.
  for (let n = 1; n <= 5; n++) {
    const code = cleanAccessoryCode(v[`zacc1_${n}`]);
    if (!code) continue;
    out.push({
      related_sku: code,
      kind: "accessory",
      label: cleanAccessoryLabel(v[`zacc2_${n}`]),
      source_field: `zacc1_${n}`,
      position: n,
    });
  }

  // Replacement parts.
  for (let n = 1; n <= 5; n++) {
    const field = `matnracc${n}`;
    for (const code of splitCodeList(v[field])) {
      out.push({ related_sku: code, kind: "replacement_part", label: null, source_field: field, position: n });
    }
  }

  // Components (marginal: ~10 LIM variants — captured cheaply).
  for (let n = 1; n <= 3; n++) {
    const field = `zcomp${n}`;
    for (const code of splitCodeList(v[field])) {
      out.push({ related_sku: code, kind: "component", label: null, source_field: field, position: n });
    }
  }

  return out;
}

/**
 * Resolve raw refs for one owning product against the catalog:
 *  * zmataccess/zmataccesstyp2 values are parent PPIDs → the product map
 *    first (variant index as a harmless fallback);
 *  * everything else is a variant-SKU-ish code → the variant index first
 *    (built from the RAW pre-filter variant lists: zusage N/P variants are
 *    dropped from products.variants but resolution is identity, not
 *    visibility), product map as fallback.
 * The raw code is stored regardless of resolution (AA7).
 *
 * @param productByNorm normalized products.sku → canonical products.sku
 * @param variantParentByNorm normalized variant SKU → parent products.sku
 */
export function resolveAccessoryRefs(
  productSku: string,
  raw: readonly RawAccessoryRef[],
  productByNorm: ReadonlyMap<string, string>,
  variantParentByNorm: ReadonlyMap<string, string>,
): AccessoryRef[] {
  return raw.map((r) => {
    const key = normalizeSkuKey(r.related_sku);
    const productHit = productByNorm.get(key) ?? null;
    const variantHit = variantParentByNorm.get(key) ?? null;
    const isPpidField = r.source_field.startsWith("zmataccess");
    const related_product_sku = isPpidField
      ? productHit ?? variantHit
      : variantHit ?? productHit;
    return { ...r, product_sku: productSku, related_product_sku };
  });
}

/**
 * In-payload dedup on the upsert's conflict key (product_sku, related_sku,
 * kind — source_system is constant), the linkSeen idiom: first occurrence
 * wins, except that a later ref carrying a label or a resolution upgrades a
 * kept row that lacks one (a variant pair may repeat a product-level code
 * with better data).
 */
export function dedupeAccessoryRefs(refs: readonly AccessoryRef[]): AccessoryRef[] {
  const byKey = new Map<string, AccessoryRef>();
  for (const r of refs) {
    const key = `${r.product_sku}\u0000${r.related_sku}\u0000${r.kind}`;
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, { ...r });
      continue;
    }
    if (!kept.label && r.label) kept.label = r.label;
    if (!kept.related_product_sku && r.related_product_sku) {
      kept.related_product_sku = r.related_product_sku;
    }
  }
  return [...byKey.values()];
}

/** Below this fraction of the previous row count, a capture is "collapsed
 *  toward zero" and the prune is suspect (connector-regen wipe hazard). */
export const ACCESSORY_PRUNE_COLLAPSE_RATIO = 0.1;

/**
 * Mass-delete guard for the accessory prune (PL7, same philosophy as the
 * zero-variants guard): when this run captured almost nothing compared to
 * what the table already holds, AND products that previously carried refs are
 * still in the feed, the collapse smells like a connector mid-regeneration —
 * abort the prune (and warn) rather than wiping the reference data. A genuine
 * shrink (previously-referenced products actually gone from the feed) prunes
 * normally.
 *
 * @param captured refs captured this run (post-dedupe)
 * @param previous rows currently in product_accessories for this source
 * @param previousProductSkus sample of product_sku values currently in the
 *   table (a bounded sample is fine — the signal is "still in the feed?")
 * @param feedSkus every product SKU present in this run's feed
 */
export function accessoryPruneDecision(opts: {
  captured: number;
  previous: number;
  previousProductSkus: readonly string[];
  feedSkus: ReadonlySet<string>;
}): { prune: boolean; warn: string | null } {
  const { captured, previous, previousProductSkus, feedSkus } = opts;
  if (previous <= 0) return { prune: true, warn: null };
  const collapsed = captured < previous * ACCESSORY_PRUNE_COLLAPSE_RATIO;
  if (!collapsed) return { prune: true, warn: null };
  const norm = new Set([...feedSkus].map(normalizeSkuKey));
  const stillInFeed = previousProductSkus.filter((s) => norm.has(normalizeSkuKey(s))).length;
  if (stillInFeed === 0) return { prune: true, warn: null };
  return {
    prune: false,
    warn:
      `accessory prune ABORTED: captured ${captured} refs vs ${previous} existing rows ` +
      `while ${stillInFeed}/${previousProductSkus.length} previously-referenced products are still in the feed ` +
      `(connector likely mid-regeneration) — keeping existing rows`,
  };
}
