-- =============================================================================
-- Marketing data ingestion — Open Orders staging (line-item grain)
--
-- The daily SAP "Open Orders Master" export is one row per order line. We stage
-- it at (SO, POSNR) grain: a lean set of typed/queryable columns plus the full
-- 44-column row in raw_json (so the HubSpot push can map every field without a
-- column-per-field migration, like products.raw_json).
--
-- Full daily snapshot: the consumer upserts every line (is_open=true,
-- last_seen_ingestion_id=this), then marks any line NOT in today's file
-- is_open=false (fulfilled or cancelled — reason unknown; the row is kept as
-- history). Destination (next stage): HubSpot Orders + Line Items.
--
-- Internal/admin read; service-role writes.
-- =============================================================================

create table if not exists public.open_orders (
  id uuid primary key default gen_random_uuid(),
  so text not null,                 -- Sales Order number (order key)
  posnr text not null,              -- line item position (line key)
  -- Order-level (denormalized onto each line).
  po_number text,
  po_date date,
  customer_account text,            -- matches a HubSpot Company by account number
  customer_name text,
  sales_group text,                 -- rep code (joins to rep_codes / the Rep Code object)
  amt_rep text,                     -- AMT rep -> HubSpot owner
  sales_territory text,
  business_unit text,
  -- Line-level.
  material text,                    -- SKU
  order_qty numeric,
  net_price numeric,
  line_net_value numeric,
  back_order_qty numeric,
  -- Full upstream row (all 44 columns) for the HubSpot push / later columns.
  raw_json jsonb not null default '{}'::jsonb,
  -- Snapshot bookkeeping.
  is_open boolean not null default true,
  ingestion_id uuid not null references public.data_ingestions(id),
  last_seen_ingestion_id uuid not null references public.data_ingestions(id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (so, posnr)
);

create index if not exists open_orders_so_idx on public.open_orders (so);
create index if not exists open_orders_customer_idx on public.open_orders (customer_account);
create index if not exists open_orders_sales_group_idx on public.open_orders (sales_group);
create index if not exists open_orders_material_idx on public.open_orders (material);
create index if not exists open_orders_is_open_idx on public.open_orders (is_open);

-- -----------------------------------------------------------------------------
-- RLS: internal/admin read; service role writes (no insert/update/delete policy).
-- -----------------------------------------------------------------------------
alter table public.open_orders enable row level security;

drop policy if exists open_orders_select on public.open_orders;
create policy open_orders_select on public.open_orders
  for select using (public.is_active_internal_or_admin());
