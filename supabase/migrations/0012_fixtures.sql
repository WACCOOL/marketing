-- =============================================================================
-- Phase 1 — Scalable fixture pipeline: the fixtures registry
--
-- A SKU-keyed index of the studio .blend files mirrored to R2 (one row per
-- fixture). The bulk uploader (apps/fixture-sync) writes this with the service
-- role; every active user reads it so the web app can browse + render ANY
-- mirrored fixture. RLS mirrors public.products (0008_products.sql): a select
-- policy for active users, no write policy so only the service role writes.
--
-- The .blend lives in R2 at `model_key`; the resolver presigns it on demand.
-- IES photometry is NOT stored here — it comes from the Sales Layer products
-- record (PIM) at resolve time, when present.
-- =============================================================================

create table if not exists public.fixtures (
  id uuid primary key default gen_random_uuid(),
  -- Fixture SKU, derived from the .blend filename (lowercased). Stable conflict
  -- key for the uploader's upserts and the key the resolver/picker look up.
  sku text not null unique,
  -- R2 object key of the .blend, mirroring the source-relative path
  -- (e.g. `fixtures/2026/<brand>/<file>.blend`). The resolver presigns this.
  model_key text not null,
  -- R2 ETag + byte size of the uploaded object, so the uploader can skip
  -- unchanged files on re-runs and a later worker cache can key by version.
  model_etag text,
  model_bytes bigint,
  -- Absolute source path the file was ingested from (audit / re-ingest).
  source_path text,
  -- Parsed version from the legacy `..._v{NNN}` naming, when present.
  source_version integer,
  -- Whether the source filename was marked `_pub` (published).
  is_pub boolean not null default false,
  ingested_at timestamptz not null default now(),
  -- Optional per-SKU overrides. When null, the resolver derives mount/type from
  -- the products catalog and pose/coverage from mount-based presets. Hero
  -- pieces can pin exact values here later (override-authoring is a later phase).
  pose jsonb,
  coverage real,
  mount text,
  fixture_type text
);

create index if not exists fixtures_ingested_at_idx on public.fixtures (ingested_at);

-- -----------------------------------------------------------------------------
-- RLS: shared, read-only registry. Active users read; only the service role
-- (which bypasses RLS) writes — so no insert/update/delete policy is defined.
-- -----------------------------------------------------------------------------
alter table public.fixtures enable row level security;

drop policy if exists fixtures_select on public.fixtures;
create policy fixtures_select on public.fixtures
  for select using (public.is_active());
