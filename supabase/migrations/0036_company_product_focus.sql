-- =============================================================================
-- Company product-focus (decorative vs functional) classification — audit log.
--
-- Mirrors company_project_focus_classifications (0035) for the classifier that fills
-- the company `product_focus` multi-select on Showroom/Distributor companies
-- (POST /api/hubspot/classify-product-focus, the backfill, and the event-lead
-- just-in-time). Decorative → showroom/MF·Schonbek; Functional → distributor/WAC.
-- Internal/admin read; service role writes.
-- =============================================================================

create table if not exists public.company_product_focus_classifications (
  company_id text primary key,         -- HubSpot company record id
  result text,                         -- written value, e.g. "Functional" / "Functional;Decorative"
  confidence numeric,                  -- model self-reported confidence 0..1 (null when override/defaulted)
  model text,
  source text,                         -- 'webhook' | 'backfill' | 'manual' | 'event-lead'
  status text,                         -- classified | override | defaulted | already_set | skipped_not_applicable | skipped | error
  wrote boolean not null default false,
  prompt_tokens int,
  output_tokens int,
  inputs_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists company_product_focus_classifications_status_idx
  on public.company_product_focus_classifications (status);
create index if not exists company_product_focus_classifications_updated_idx
  on public.company_product_focus_classifications (updated_at);

alter table public.company_product_focus_classifications enable row level security;

drop policy if exists company_product_focus_classifications_select
  on public.company_product_focus_classifications;
create policy company_product_focus_classifications_select
  on public.company_product_focus_classifications
  for select using (public.is_active_internal_or_admin());
