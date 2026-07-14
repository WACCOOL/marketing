-- =============================================================================
-- Material Bank sync outcomes — one row per Material Bank order (last outcome
-- wins). The apps/material-bank-sync CLI pulls XML order files from Material
-- Bank's SFTP and POSTs each order to /api/hubspot/material-bank/sync; the
-- Worker records the outcome here so "why did order X do Y?" is a query, not
-- log archaeology (same pattern as event_lead_outcomes). Internal/admin read;
-- service role writes.
-- =============================================================================

create table if not exists public.material_bank_outcomes (
  order_id text primary key,           -- Material Bank ORDERID
  status text,                         -- created | updated | unchanged | skipped_sap | error
  deal_id text,                        -- HubSpot deal record id
  contact_id text,                     -- HubSpot contact record id
  contact_created boolean not null default false,
  owner_id text,                       -- routed HubSpot owner id
  owner_source text,                   -- routing breadcrumb (designer label / tree path / national account)
  matched_by text,                     -- order_id | name_address_contact | null (created fresh)
  project_type text,                   -- Gemini-classified deal project_type (null = abstained)
  line_items_created int not null default 0,
  contact_owner_action text,           -- set | skipped_existing | skipped_no_contact | skipped_no_owner
  actions jsonb,                       -- { filledProps, fixActions } from the heal loop
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists material_bank_outcomes_status_idx
  on public.material_bank_outcomes (status);
create index if not exists material_bank_outcomes_updated_idx
  on public.material_bank_outcomes (updated_at);

alter table public.material_bank_outcomes enable row level security;

drop policy if exists material_bank_outcomes_select on public.material_bank_outcomes;
create policy material_bank_outcomes_select
  on public.material_bank_outcomes
  for select using (public.is_active_internal_or_admin());
