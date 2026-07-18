-- =============================================================================
-- Thom Bot — track systems + components (for the plan_layout track-BOM tool)
--
-- Seed data for the track bill-of-materials solver (@wac/shared solveTrackBom):
--   * track_systems    — one row per buildable track SYSTEM (H/J/L/W/X/FlexRail,
--                        line- or low-voltage), with its buildable channel
--                        segment lengths and electrical capacities.
--   * track_components  — the SKUs that make up a system (channel sections,
--                        heads, feeds, connectors, joiners, end caps,
--                        transformers), keyed by role.
--
-- TABLES + RLS ONLY. No seed rows here — a separate migration (0050) inserts
-- the actual system/component data. The plan_layout tool degrades gracefully
-- (generic parts list) while these tables are empty. Writes are service-role
-- only (no insert/update/delete policy) — same posture as the rest of the Thom
-- retrieval store (0043 / 0048).
-- =============================================================================

create table if not exists public.track_systems (
  key text primary key,
  label text not null,
  track_type text not null,           -- H|J|J2|L|W|X|FLEXRAIL
  voltage_class text not null,        -- line|low
  segment_lengths_ft numeric[] not null default '{}',
  circuit_va numeric,                 -- line-voltage circuit capacity
  feed_capacity_w numeric,            -- low-voltage feed/transformer capacity
  max_heads_per_run int,
  default_head_spacing_ft numeric,
  compatible_head_track_types text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.track_components (
  id uuid primary key default gen_random_uuid(),
  system_key text not null references public.track_systems(key) on delete cascade,
  role text not null,                 -- channel|head|feed|connector|joiner|endcap|transformer
  sku text not null,
  description text,
  segment_length_ft numeric,
  head_watts numeric,
  capacity_w numeric,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists track_components_system_idx on public.track_components (system_key);

alter table public.track_systems enable row level security;
alter table public.track_components enable row level security;

-- Read gate: internal/admin only (this is internal design-tooling reference
-- data). Service-role writes bypass RLS; no write policy is defined.
create policy track_systems_select on public.track_systems
  for select using (public.is_active_internal_or_admin());
create policy track_components_select on public.track_components
  for select using (public.is_active_internal_or_admin());
