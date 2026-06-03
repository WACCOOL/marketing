-- =============================================================================
-- Phase 2a — Sales Layer products cache
--
-- A read-only local mirror of the Sales Layer PIM, refreshed daily by the API
-- Worker's scheduled handler (and on-demand by admins). Every active user can
-- read it; only the service-role sync writes to it (no insert/update/delete
-- policy is defined, so RLS denies writes to anon/authenticated roles while the
-- service role bypasses RLS entirely). Images are NOT hosted by us — we store
-- only the Sales Layer CDN (CloudFront) URLs.
--
-- A WAC "product" groups many orderable "variants" (finish/size/config). The
-- orderable SKU (matnr), most fixture dimensions, and many images live at the
-- VARIANT level, so each product row carries its variants inline as jsonb and
-- aggregates every image (product + variant) into image_urls.
-- =============================================================================

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  -- Sales Layer product reference (product_id). Stable conflict key for upserts.
  sku text not null unique,
  -- Sales Layer internal product ID, kept for cross-referencing variants/raw data.
  sl_id text,
  name text not null,
  category text,
  -- Representative fixture dimensions in millimetres: { width?, height?, depth?,
  -- diameter?, length? }. Per-variant dimensions live in `variants`.
  dimensions_mm jsonb not null default '{}'::jsonb,
  -- Every image URL for the product AND all its variants, de-duplicated.
  primary_image_url text,
  image_urls text[] not null default '{}',
  -- Inline variants: [{ variant_id, sku, finish, name, dimensions_mm, image_urls }]
  variants jsonb not null default '[]'::jsonb,
  -- Space-joined variant SKUs / finishes, folded into search_tsv so users can
  -- find a product by any of its model numbers.
  variant_search text,
  -- Full upstream product fields (named), so later phases can read more without
  -- a re-sync. Variant rows are stored in `variants`, not here, to bound size.
  raw_json jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);

create index if not exists products_category_idx on public.products (category);
create index if not exists products_synced_at_idx on public.products (synced_at);

-- -----------------------------------------------------------------------------
-- Full-text search over sku / name / category / variant model numbers (mirrors
-- the assets search setup in 0004_search.sql).
-- -----------------------------------------------------------------------------
alter table public.products
  add column if not exists search_tsv tsvector;

create or replace function public.products_search_tsv_update() returns trigger
language plpgsql as $$
begin
  new.search_tsv :=
    setweight(to_tsvector('english', coalesce(new.name, '')), 'A')
    || setweight(to_tsvector('english', coalesce(new.sku, '')), 'A')
    || setweight(to_tsvector('english', coalesce(new.variant_search, '')), 'B')
    || setweight(to_tsvector('english', coalesce(new.category, '')), 'C');
  return new;
end;
$$;

drop trigger if exists products_search_tsv_trigger on public.products;
create trigger products_search_tsv_trigger
  before insert or update of name, sku, category, variant_search on public.products
  for each row execute function public.products_search_tsv_update();

create index if not exists products_search_tsv_idx
  on public.products using gin (search_tsv);

-- -----------------------------------------------------------------------------
-- RLS: shared, read-only cache. Active users read; only service role writes.
-- -----------------------------------------------------------------------------
alter table public.products enable row level security;

drop policy if exists products_select on public.products;
create policy products_select on public.products
  for select using (public.is_active());
