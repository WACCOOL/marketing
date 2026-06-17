-- =============================================================================
-- Marketing data ingestion — Territory / Rep Codes staging (Phase 3a)
--
-- The Territory workbook (Contract Master Sheet.xlsx) has two tabs we parse:
--   1. "Territory Master Sheet"      — 40,918 zips x 10 channel columns; each cell
--                                       is a rep code. Unpivoted to long form in
--                                       rep_code_zips (the reporting dataset + the
--                                       source of each rep's zip list).
--   2. "Rep Code RSM ISR Mapping"    — per rep code: District, RSM/TSM, Sales
--                                       District Code, ISR, AMT Rep Code → rep_codes.
--
-- rep_codes holds one row per rep code (the UNION of both tabs — a rep code may
-- have zips but no mapping, or vice versa). Destination (Phase 3b): the HubSpot
-- Rep Codes custom object (zips + attributes; ISR→owner, RSM/TSM→Regional Manager).
--
-- Territory is a single-file snapshot: the consumer upserts then prunes rows not
-- from the latest ingestion (full replace). Internal/admin read; service role writes.
-- =============================================================================

-- Unpivoted long form: one row per (zip, channel) -> rep code.
create table if not exists public.rep_code_zips (
  id uuid primary key default gen_random_uuid(),
  rep_code text not null,
  zip text not null,
  channel text not null,        -- e.g. "WAC Showroom", "MF Spec", "Integration"
  ingestion_id uuid not null references public.data_ingestions(id),
  created_at timestamptz not null default now(),
  unique (zip, channel)         -- each zip has one rep code per channel
);

create index if not exists rep_code_zips_rep_code_idx on public.rep_code_zips (rep_code);
create index if not exists rep_code_zips_zip_idx on public.rep_code_zips (zip);

-- One row per rep code (union of the two tabs).
create table if not exists public.rep_codes (
  rep_code text primary key,
  -- From the RSM/ISR mapping tab (null when a rep code only appears in the matrix).
  district text,
  rsm_tsm text,                 -- RSM/TSM -> HubSpot "Territory / Regional Manager" user
  sales_district_code text,
  isr text,                     -- Inside Sales Rep -> HubSpot record owner
  amt_rep_code text,
  -- Aggregated from the matrix.
  channels text[] not null default '{}',
  zip_count int not null default 0,
  ingestion_id uuid not null references public.data_ingestions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rep_codes_ingestion_idx on public.rep_codes (ingestion_id);

-- -----------------------------------------------------------------------------
-- RLS: internal/admin read (internal ops data); service role writes (no
-- insert/update/delete policy, so RLS denies writes to anon/authenticated).
-- -----------------------------------------------------------------------------
alter table public.rep_code_zips enable row level security;
alter table public.rep_codes enable row level security;

drop policy if exists rep_code_zips_select on public.rep_code_zips;
create policy rep_code_zips_select on public.rep_code_zips
  for select using (public.is_active_internal_or_admin());

drop policy if exists rep_codes_select on public.rep_codes;
create policy rep_codes_select on public.rep_codes
  for select using (public.is_active_internal_or_admin());
