-- =============================================================================
-- Marketing data ingestion — Phase 1: the data_ingestions audit/control table
--
-- Every file that lands in the R2 inbox (ingest/{source}/...) gets one row here.
-- The API's POST /api/ingest endpoint inserts a `received` row (service role),
-- stores the object in R2, and enqueues a wac-ingest message; the queue consumer
-- flips the row to processing -> succeeded/failed and records parse/upsert
-- counts. Per-source staging tables (open_orders, rep_codes, pricing — added in
-- later phases) back-link to this table via ingestion_id, so snapshot
-- reconciliation can be expressed as "rows from the latest succeeded ingestion
-- are live."
--
-- Modeled on 0009_generation_jobs.sql. This is internal-ops data (not
-- user-owned): active internal/admin users read it; only the service role
-- writes it (no insert/update/delete policy, exactly like 0008_products.sql).
-- =============================================================================

do $$ begin
  create type public.ingestion_status as enum (
    'received', 'queued', 'processing', 'succeeded', 'failed', 'skipped'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.data_ingestions (
  id uuid primary key default gen_random_uuid(),
  -- SourceDescriptor.key from packages/shared/src/ingest/registry.ts.
  source text not null,
  -- Variant key for multi-file sources (e.g. pricing price books); else null.
  variant text,
  status public.ingestion_status not null default 'received',

  -- Provenance --------------------------------------------------------------
  -- R2 object key: ingest/{source}/{yyyy}/{mm}/{dd}/{id}__{name}.{ext}.
  r2_key text not null,
  original_name text,
  content_type text,
  byte_size bigint,
  -- 'power-automate' for the shared-token path, else the uploader's email.
  delivered_by text,

  -- Processing results (populated by the queue consumer) --------------------
  row_count int,
  inserted_count int,
  updated_count int,
  -- Snapshot sources: rows closed/pruned because they vanished from this file.
  closed_count int,
  error_count int,
  -- Sample of row-level errors: [{ rowIndex, messages[] }].
  errors_json jsonb,
  -- Parser stats (unpivot counts, blanks, etc.).
  stats_json jsonb,
  -- Top-level failure reason (e.g. file missing, parse threw, enqueue failed).
  error text,

  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists data_ingestions_source_idx on public.data_ingestions (source);
create index if not exists data_ingestions_status_idx on public.data_ingestions (status);
create index if not exists data_ingestions_created_idx on public.data_ingestions (created_at desc);

-- -----------------------------------------------------------------------------
-- RLS: shared, read-only-to-users audit log. Active internal/admin users read;
-- only the service role writes (the ingest endpoint and queue consumer use the
-- service-role client, which bypasses RLS). No insert/update/delete policy is
-- defined, so RLS denies writes to anon/authenticated roles — mirrors products.
-- -----------------------------------------------------------------------------
alter table public.data_ingestions enable row level security;

drop policy if exists data_ingestions_select on public.data_ingestions;
create policy data_ingestions_select on public.data_ingestions
  for select using (public.is_active_internal_or_admin());
