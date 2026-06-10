-- =============================================================================
-- Phase 2 — Family grouping + accessory filtering
--
-- `family` mirrors the PIM's zzfamily (e.g. CALLIOPE groups 4 PPIDs) so
-- Product Info can group/summarize at the family level. `is_accessory` is
-- computed at sync time from zmntyp/zzfixture/zprdtyp/name so connectors,
-- channels, and other accessories can be hidden from the Product Info
-- workflows by default (they don't need romance copy, SEO, or normalization).
-- Both are populated by the next Sales Layer sync.
-- =============================================================================

alter table public.products
  add column if not exists family text,
  add column if not exists is_accessory boolean not null default false;

create index if not exists products_family_idx on public.products (family);
create index if not exists products_is_accessory_idx
  on public.products (is_accessory);
