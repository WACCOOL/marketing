-- =============================================================================
-- Turnover (invoiced orders) staging + customer parent-child staging
--
-- TURNOVER-*.csv files land ad hoc on the ExaVault SFTP (Integrations/Inbound);
-- apps/turnover-sync pulls, archives to R2, and stages here. One row per
-- (billing document, material, rep code): an invoice line credited to two reps
-- appears twice (secondary usually qty 0). Files are rolling windows — APPEND
-- semantics with idempotent upserts; there is deliberately NO close-on-missing
-- (an invoice absent from the next file is simply unchanged, unlike the
-- open_orders daily snapshot).
--
-- company_parents stages the Imports/CUSTOMERS-*.csv account→parent links
-- (self-parented rows normalized to null upstream); the push mirrors them as
-- native HubSpot parent/child Company associations.
--
-- Internal/admin read; service-role writes.
-- =============================================================================

create table if not exists public.turnover_orders (
  id uuid primary key default gen_random_uuid(),
  billing_document text not null,   -- invoice # (HubSpot Order key)
  material text not null,           -- SKU (line-level)
  rep_code text not null default '',-- rep credited on this line ('' when blank)
  -- Order-level (denormalized onto each line).
  sold_to text,                     -- customer account (numeric, or IR-/MF-prefixed)
  billing_date date,
  currency text,
  quotation_ref text,               -- SAP quote # -> Deal sap_quote_number (sparse)
  brand text not null default 'WAC',-- 'WAC' | 'SCH' (from the filename prefix)
  -- Line-level money/qty. discounted_sales = net (after-discount) invoiced value
  -- (the amount to total); ytd_total = cumulative YTD figure (context only).
  quantity numeric,
  ytd_total numeric,
  discounted_sales numeric,
  -- Full upstream row keyed by SAP header, for push-time access.
  raw_json jsonb not null default '{}'::jsonb,
  -- Provenance.
  source_file text not null,
  ingestion_id uuid not null references public.data_ingestions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (billing_document, material, rep_code)
);

create index if not exists turnover_orders_doc_idx on public.turnover_orders (billing_document);
create index if not exists turnover_orders_sold_to_idx on public.turnover_orders (sold_to);
create index if not exists turnover_orders_rep_idx on public.turnover_orders (rep_code);
create index if not exists turnover_orders_quote_idx on public.turnover_orders (quotation_ref);
create index if not exists turnover_orders_brand_idx on public.turnover_orders (brand);
create index if not exists turnover_orders_ingestion_idx on public.turnover_orders (ingestion_id);

alter table public.turnover_orders enable row level security;

drop policy if exists turnover_orders_select on public.turnover_orders;
create policy turnover_orders_select on public.turnover_orders
  for select using (public.is_active_internal_or_admin());

-- -----------------------------------------------------------------------------
-- Customer -> parent account links (from Imports/CUSTOMERS-*.csv; PARENTS-*.csv
-- supplies parent display names). parent_account null = top of its hierarchy.
-- -----------------------------------------------------------------------------
create table if not exists public.company_parents (
  id uuid primary key default gen_random_uuid(),
  account text not null unique,     -- customer account number
  customer_name text,               -- display name (account prefix stripped)
  parent_account text,              -- parent account number (null = self/top)
  parent_name text,                 -- from the PARENTS legend, when known
  raw_json jsonb not null default '{}'::jsonb,
  source_file text not null,
  ingestion_id uuid not null references public.data_ingestions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists company_parents_parent_idx on public.company_parents (parent_account);

alter table public.company_parents enable row level security;

drop policy if exists company_parents_select on public.company_parents;
create policy company_parents_select on public.company_parents
  for select using (public.is_active_internal_or_admin());
