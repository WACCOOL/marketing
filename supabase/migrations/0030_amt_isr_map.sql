-- =============================================================================
-- AMT Rep Code → Inside Sales Person roster (Inside-Sales ISR sync)
--
-- The "Rep Code RSM ISR Mapping" tab only carries the AMT codes that are tied to
-- a field rep code (~17). But SAP assigns ~50+ AMT codes to companies — the rest
-- belong to inside-sales people not tied to a field rep (e.g. 441 = Christina Yin,
-- 1,362 companies). A new "AMT ISR Mapping" tab in the Contract Master Sheet lists
-- EVERY AMT Rep Code → Inside Sales Person; this table stages it so both the API
-- Worker push and the territory-sync reconcile can resolve any AMT code → owner.
--
-- Single-file snapshot (same as rep_codes): upsert then prune rows not from the
-- latest ingestion. Internal/admin read; service role writes.
-- =============================================================================

create table if not exists public.amt_isr_map (
  amt_rep_code text primary key,
  inside_sales_person text not null,  -- full "First Last" → resolved to a HubSpot owner
  ingestion_id uuid references public.data_ingestions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists amt_isr_map_ingestion_idx on public.amt_isr_map (ingestion_id);

alter table public.amt_isr_map enable row level security;

drop policy if exists amt_isr_map_select on public.amt_isr_map;
create policy amt_isr_map_select on public.amt_isr_map
  for select using (public.is_active_internal_or_admin());
