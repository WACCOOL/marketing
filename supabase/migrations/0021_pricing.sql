-- =============================================================================
-- Marketing data ingestion — Pricing staging table (Phase 2)
--
-- Normalized rows from the four WAC price-book workbooks (C1/D1/D6/D7), which
-- are SAP price-list exports sharing one schema:
--   Sales org. | Price list type | Material | Amount | Unit | Valid From | Valid to
-- One row per (variant, sku). The ingest consumer upserts a file's rows then
-- prunes that variant's older rows (per-variant full replace), so uploading one
-- price book never disturbs another. Destination (later): HubSpot Products
-- price-book properties.
--
-- Pricing is sensitive (contract/dealer pricing), so reads are ADMIN-ONLY; only
-- the service-role consumer writes (no insert/update/delete policy).
-- =============================================================================

create table if not exists public.pricing (
  id uuid primary key default gen_random_uuid(),
  variant text not null,                 -- price book: c1 | d1 | d6 | d7
  sku text not null,                     -- Material (orderable SKU)
  price numeric,                         -- Amount
  currency text not null default 'USD',  -- Unit
  valid_from date,                       -- Valid From
  valid_to date,                         -- Valid to (9999-12-31 = open-ended)
  sales_org text,                        -- Sales org. (constant 2000)
  ingestion_id uuid not null references public.data_ingestions(id),
  created_at timestamptz not null default now(),
  unique (variant, sku)
);

create index if not exists pricing_sku_idx on public.pricing (sku);
create index if not exists pricing_variant_idx on public.pricing (variant);

-- -----------------------------------------------------------------------------
-- RLS: admin-only reads (sensitive pricing); service role writes (bypasses RLS).
-- -----------------------------------------------------------------------------
alter table public.pricing enable row level security;

drop policy if exists pricing_select on public.pricing;
create policy pricing_select on public.pricing
  for select using (public.is_admin());
