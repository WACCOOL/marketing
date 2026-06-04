-- =============================================================================
-- Phase 2 — Product brand
--
-- Products are grouped under WAC sub-brands (Schonbek, Modern Forms, WAC
-- Lighting, WAC Landscape, ...). The Sales Layer sync now extracts a brand and
-- stores it here so users can search/filter by brand (e.g. "Schonbek"), which
-- previously returned nothing because brand wasn't captured or indexed.
-- =============================================================================

alter table public.products
  add column if not exists brand text;

create index if not exists products_brand_idx on public.products (brand);

-- Fold brand into the product search vector at top weight (alongside name/sku),
-- so brand terms rank as primary matches.
create or replace function public.products_search_tsv_update() returns trigger
language plpgsql as $$
begin
  new.search_tsv :=
    setweight(to_tsvector('english', coalesce(new.name, '')), 'A')
    || setweight(to_tsvector('english', coalesce(new.brand, '')), 'A')
    || setweight(to_tsvector('english', coalesce(new.sku, '')), 'A')
    || setweight(to_tsvector('english', coalesce(new.variant_search, '')), 'B')
    || setweight(to_tsvector('english', coalesce(new.category, '')), 'C');
  return new;
end;
$$;

drop trigger if exists products_search_tsv_trigger on public.products;
create trigger products_search_tsv_trigger
  before insert or update of name, sku, category, variant_search, brand
    on public.products
  for each row execute function public.products_search_tsv_update();

-- Re-stamp the search vector on existing rows (brand stays null until the next
-- Sales Layer sync, which upserts it).
update public.products set name = name;

-- -----------------------------------------------------------------------------
-- Distinct brand list for the picker facet. SECURITY INVOKER so it runs under
-- the caller's role and respects the products RLS (active users only).
-- -----------------------------------------------------------------------------
create or replace function public.product_brands()
  returns setof text
  language sql
  stable
  security invoker
as $$
  select distinct brand
  from public.products
  where brand is not null and brand <> ''
  order by brand;
$$;

grant execute on function public.product_brands() to anon, authenticated;
