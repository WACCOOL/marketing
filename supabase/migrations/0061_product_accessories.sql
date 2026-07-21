-- =============================================================================
-- Thom Bot — product accessory / component / replacement-part references
--
-- The Sales Layer export carries explicit compatibility data the product sync
-- used to drop on the floor (docs/thom-product-compatibility-plan.md, v2.1):
--   * product-level `zmataccess` / `zmataccesstyp2` — comma-joined parent
--     PPIDs of confirmed accessories (track heads → track accessories,
--     housings → trims, Solorail → its transformer);
--   * product-level `zacc1/zacc2(_1.._10)` / `zcomp1..10` — AiSpire
--     accessory/component CODE lists (zacc2 CONTINUES zacc1: one overflow
--     list with weakly slot-typed positions, NOT two groups) and
--     `matnracc1..3,5` accessory material numbers;
--   * VARIANT-level `zacc1_N` (accessory SKU) + `zacc2_N` (its PAIRED human
--     label — Modern Forms fans: "F-RCBT-WT" / "Bluetooth Remote Control"),
--     `matnracc1..5` (orderable replacement-part SKUs) and `zcomp1..3`.
--
-- One row per (owning product, raw referenced code, kind, source). The raw
-- code is stored as exported in `related_sku`; when it resolves to a catalog
-- product (directly a PPID, or a variant SKU whose parent we know) the parent
-- PPID lands in `related_product_sku` — null means unresolved (the feed is a
-- superset of the synced catalog, so refs may target non-synced products).
-- "Resolved" is simply `related_product_sku is not null` (no separate column).
--
-- `position` is the global slot index (zacc1_1..10 → 1–10, zacc2_1..10 →
-- 11–20; list index for comma-joined fields). Ordering is NOT display-ranked —
-- promise nothing about it.
--
-- Like kb_documents / product_photometrics there is intentionally NO foreign
-- key to products: this is a prunable, denormalized cache keyed by SKU text,
-- rewritten by the product sync (prune = source-scoped `synced_at < stamp`,
-- behind a mass-delete guard in the writer). Writes are service-role only (no
-- insert/update/delete policy). Reads are open (`using (true)`, the 0048
-- posture): every row is derived from the public product feed, there are no
-- internal-scoped rows, and the bare per-row is_active_*() form is the
-- diagnosed 0055 statement-timeout incident — do not reintroduce it here.
-- Covered by the anon-boundary test (apps/api/src/thom/anonBoundary.test.ts).
-- =============================================================================

create table if not exists public.product_accessories (
  id uuid primary key default gen_random_uuid(),
  -- Owning product PPID (products.sku).
  product_sku text not null,
  -- Raw referenced code exactly as exported (PPID, variant SKU, or an
  -- unresolvable material number).
  related_sku text not null,
  -- Resolved parent PPID (products.sku) or null when unresolved.
  related_product_sku text,
  kind text not null check (kind in ('accessory', 'component', 'replacement_part')),
  -- Paired human label when the source carries one (variant zacc2_N — Modern
  -- Forms fans). Never a second code row.
  label text,
  source_system text not null default 'sales_layer',
  -- Which connector column the ref came from (zmataccess | zmataccesstyp2 |
  -- zacc1_3 | zcomp2 | matnracc1 | ...). Open text, validated in the writer.
  source_field text,
  -- Global slot index; see header. Quoted: POSITION is a reserved word.
  "position" int,
  -- Stamped by the sync run that (re)wrote the row; drives the source-scoped
  -- prune of rows the feed no longer carries.
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (product_sku, related_sku, kind, source_system)
);

-- Reverse-fit lookups ("what does LENS-16-AMB fit?"): by raw code and by
-- resolved parent PPID. Forward lookups ride the unique constraint's
-- (product_sku, ...) prefix.
create index if not exists product_accessories_related_sku_idx
  on public.product_accessories (related_sku);
create index if not exists product_accessories_related_product_sku_idx
  on public.product_accessories (related_product_sku);

alter table public.product_accessories enable row level security;

-- Open read (anon included — the public Thom bubble reads as anon); writes are
-- service-role only because no write policy exists.
create policy product_accessories_select on public.product_accessories
  for select using (true);
