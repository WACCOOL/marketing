-- =============================================================================
-- SAP -> HubSpot durable sync — Phase 1: capture + review dashboard tables
--
-- Two AWS Lambdas (Deals/Quotes and Companies) push SAP data to HubSpot. They
-- now ALSO forward each raw payload + the outcome of their push to the API
-- Worker, which stores everything here so we have a durable audit trail, can see
-- which dropdown/enum fields keep failing, and (in Phase 2) replay anything.
--
-- `hubspot_sync_records` is one row per DISTINCT payload (deduped by an
-- idempotency_key = SHA-256 of the raw body, so Lambda async retries and
-- identical re-sends collapse instead of duplicating). `hubspot_sync_field_issues`
-- normalizes per-field problems (dropped/normalized dropdowns, unmapped fields,
-- association skips) so the dashboard's "which fields cause the most problems"
-- summary is a cheap GROUP BY.
--
-- Modeled on 0019_data_ingestions.sql: internal-ops data (not user-owned),
-- active internal/admin users read it; only the service role writes it (no
-- insert/update/delete policy, exactly like data_ingestions / products).
-- =============================================================================

do $$ begin
  create type public.hubspot_sync_status as enum (
    'captured', 'received', 'pushing', 'succeeded', 'partial', 'held',
    'failed', 'skipped'
  );
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- hubspot_sync_records — one row per distinct submitted payload.
-- -----------------------------------------------------------------------------
create table if not exists public.hubspot_sync_records (
  id uuid primary key default gen_random_uuid(),

  -- SHA-256 of the raw payload bytes, computed by the Lambda and sent with both
  -- the capture and result calls. UNIQUE so retries / identical re-sends upsert.
  idempotency_key text not null unique,

  -- 'deals' (quote -> Deal + Line Items) | 'companies'.
  object_type text not null,
  status public.hubspot_sync_status not null default 'captured',

  -- SAP-stable id used as the HubSpot upsert key: sap_quote_number (deals) or
  -- account_number_ (companies). Audit/grouping only — not unique (re-sends).
  dedup_key text,

  -- R2 object key: hubspot-sync/{object}/{yyyy}/{mm}/{dd}/{idem}__{dedup}.json.
  r2_key text not null,
  payload_bytes bigint,
  -- 'sap-lambda' for the token path; 'replay'/'excel' for Phase-2 backfills.
  delivered_by text,
  source text not null default 'lambda',

  -- From quote_last_changed_date where present (deals); the out-of-order guard
  -- in Phase 2. Companies carry no change-date, so this stays null for them.
  sap_changed_at timestamptz,

  -- What the Lambda's own push returned (Phase 1: the Lambda still pushes).
  lambda_result_json jsonb,
  lambda_error text,
  lambda_status int,

  -- Count of field_issues for this record (set, not incremented — see the
  -- result endpoint: it replaces issues so retries don't double-count).
  problem_count int not null default 0,
  -- How many times this exact payload was received (retries / identical sends).
  receipt_count int not null default 1,
  last_seen_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists hubspot_sync_records_object_idx
  on public.hubspot_sync_records (object_type, created_at desc);
create index if not exists hubspot_sync_records_status_idx
  on public.hubspot_sync_records (status);
create index if not exists hubspot_sync_records_dedup_idx
  on public.hubspot_sync_records (dedup_key, created_at desc);
create index if not exists hubspot_sync_records_created_idx
  on public.hubspot_sync_records (created_at desc);

-- -----------------------------------------------------------------------------
-- hubspot_sync_field_issues — normalized per-field problems (powers the
-- Errors + Summary dashboard tabs). object_type here describes where the field
-- lives (a 'deals' record can carry 'line_items' issues), which may differ from
-- the parent record's object_type.
-- -----------------------------------------------------------------------------
create table if not exists public.hubspot_sync_field_issues (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null
    references public.hubspot_sync_records (id) on delete cascade,

  object_type text not null,          -- 'deals' | 'line_items' | 'companies'
  property text not null,             -- HubSpot/SAP property the problem is on
  raw_value text,                     -- the incoming value that caused it

  -- enum_mismatch | unmapped_field | missing_required | assoc_not_found |
  -- rate_limit | hubspot_5xx | network | other
  category text not null,
  -- dropped | normalized | invalid | held | unmapped | assoc_missing
  action text,
  mapped_to text,                     -- for normalized: the value it became
  reason text,

  created_at timestamptz not null default now()
);

create index if not exists hubspot_field_issues_record_idx
  on public.hubspot_sync_field_issues (record_id);
create index if not exists hubspot_field_issues_object_prop_idx
  on public.hubspot_sync_field_issues (object_type, property);
create index if not exists hubspot_field_issues_prop_value_idx
  on public.hubspot_sync_field_issues (property, raw_value);
create index if not exists hubspot_field_issues_category_idx
  on public.hubspot_sync_field_issues (category);
create index if not exists hubspot_field_issues_created_idx
  on public.hubspot_sync_field_issues (created_at desc);

-- -----------------------------------------------------------------------------
-- Summary views (the "which fields cause the most problems" aggregates). These
-- are security_invoker so RLS on the base tables applies to the caller — a stray
-- PostgREST query from a rep can't read around the policy via the view.
-- -----------------------------------------------------------------------------
create or replace view public.hubspot_field_problem_counts
  with (security_invoker = true) as
  select object_type, property, category, count(*)::bigint as n
  from public.hubspot_sync_field_issues
  group by object_type, property, category;

create or replace view public.hubspot_value_problem_counts
  with (security_invoker = true) as
  select object_type, property, raw_value, count(*)::bigint as n
  from public.hubspot_sync_field_issues
  group by object_type, property, raw_value;

create or replace view public.hubspot_record_status_counts
  with (security_invoker = true) as
  select object_type, status, count(*)::bigint as n
  from public.hubspot_sync_records
  group by object_type, status;

create or replace view public.hubspot_problem_daily
  with (security_invoker = true) as
  select object_type,
         date_trunc('day', created_at)::date as day,
         count(*)::bigint as n
  from public.hubspot_sync_field_issues
  group by object_type, date_trunc('day', created_at)::date;

-- -----------------------------------------------------------------------------
-- RLS: shared read-only-to-users ops data. Active internal/admin users read;
-- only the service role writes (the capture/result endpoints and cron use the
-- service-role client, which bypasses RLS). No write policy is defined.
-- -----------------------------------------------------------------------------
alter table public.hubspot_sync_records enable row level security;
alter table public.hubspot_sync_field_issues enable row level security;

drop policy if exists hubspot_sync_records_select on public.hubspot_sync_records;
create policy hubspot_sync_records_select on public.hubspot_sync_records
  for select using (public.is_active_internal_or_admin());

drop policy if exists hubspot_field_issues_select on public.hubspot_sync_field_issues;
create policy hubspot_field_issues_select on public.hubspot_sync_field_issues
  for select using (public.is_active_internal_or_admin());
