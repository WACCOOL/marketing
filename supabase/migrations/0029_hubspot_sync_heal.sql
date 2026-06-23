-- =============================================================================
-- SAP -> HubSpot self-healing — Phase 2b: learned dropdown mappings + cached
-- HubSpot option lists.
--
-- The Worker push smart-matches dropdown values that don't match a HubSpot
-- enumeration option (e.g. SAP sends "COMMERCIAL - MILITARY" but the option is
-- "C0MMERCIAL - MILITARY"). It now PERSISTS each correction here so the same SAP
-- value is auto-applied next time without even a failed round-trip, and caches
-- HubSpot's current option lists (refreshed daily) so it can validate + correct
-- BEFORE pushing. The system never creates a new HubSpot option on its own — a
-- truly-unknown value is dropped + flagged for a human to add in HubSpot.
--
-- Same conventions as 0027_hubspot_sync.sql: internal-ops data, service-role
-- writes only (no insert/update/delete policy), active internal/admin read.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- hubspot_value_mappings — the learned aliases ("this SAP value -> that option").
-- -----------------------------------------------------------------------------
create table if not exists public.hubspot_value_mappings (
  id uuid primary key default gen_random_uuid(),

  object_type text not null,           -- 'deals' | 'line_items' | 'companies'
  property text not null,              -- HubSpot enumeration property internal name
  raw_value text not null,             -- normalized incoming value (heal.norm)
  canonical_option text not null,      -- the valid HubSpot option it maps to

  source text not null default 'auto', -- 'auto' (smart-matched) | 'seed' | 'manual'
  hit_count int not null default 1,    -- how often this alias has been applied
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One alias per (object, property, raw value); ON CONFLICT lets a later match
  -- bump hit_count / a human override the canonical_option.
  unique (object_type, property, raw_value)
);

create index if not exists hubspot_value_mappings_lookup_idx
  on public.hubspot_value_mappings (object_type, property);

-- -----------------------------------------------------------------------------
-- hubspot_property_options — cached HubSpot enumeration options, refreshed daily
-- so the push can validate/correct values proactively (no per-push metadata GET).
-- -----------------------------------------------------------------------------
create table if not exists public.hubspot_property_options (
  object_type text not null,           -- 'deals' | 'line_items' | 'companies'
  property text not null,              -- enumeration property internal name
  field_type text,                     -- 'enumeration' (only enums are cached)
  options_json jsonb not null,         -- [{label, value}] straight from /properties
  refreshed_at timestamptz not null default now(),

  primary key (object_type, property)
);

-- -----------------------------------------------------------------------------
-- RLS: read-only to active internal/admin users; only the service role writes
-- (the push, the daily cron, and the heal layer use the service-role client).
-- -----------------------------------------------------------------------------
alter table public.hubspot_value_mappings enable row level security;
alter table public.hubspot_property_options enable row level security;

drop policy if exists hubspot_value_mappings_select on public.hubspot_value_mappings;
create policy hubspot_value_mappings_select on public.hubspot_value_mappings
  for select using (public.is_active_internal_or_admin());

drop policy if exists hubspot_property_options_select on public.hubspot_property_options;
create policy hubspot_property_options_select on public.hubspot_property_options
  for select using (public.is_active_internal_or_admin());
