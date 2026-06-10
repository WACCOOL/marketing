-- =============================================================================
-- Phase 2 — Product Information keyed at the PPID level
--
-- Product pages live at the PPID (Sales Layer product) level, not the orderable
-- SKU (variant/matnr) level, so romance copy and SEO attach to the PPID. The
-- old `product_sku` column actually held the Sales Layer product_id — which IS
-- the PPID (it mirrors the upstream `zppid` field) — so this is a rename plus
-- a new `sku` dimension for normalization, which runs at BOTH levels:
--   sku = ''      → product/PPID-level row (e.g. the CCT roll-up of variants)
--   sku = <matnr> → variant/SKU-level row
-- ('' rather than NULL so the plain unique constraint dedupes product rows.)
-- =============================================================================

alter table public.product_content
  rename column product_sku to ppid;

alter table public.product_content
  add column if not exists sku text not null default '';

-- Re-key the uniqueness to (ppid, sku, field).
alter table public.product_content
  drop constraint if exists product_content_product_sku_field_key;
alter table public.product_content
  add constraint product_content_ppid_sku_field_key unique (ppid, sku, field);

drop index if exists product_content_sku_idx;
create index if not exists product_content_ppid_idx
  on public.product_content (ppid);
