-- =============================================================================
-- OA (international ERP) record staging
--
-- apps/oa-sync polls the OA REST API (oa.waclighting.com.cn, HMAC-per-request)
-- on a GitHub Actions cron: order/quote/project/customer lists, plus the order
-- detail endpoint where updateDate moved. One generic table — the four record
-- types share an identical lifecycle (pull → hash → push to HubSpot), and
-- raw_json IS the audit archive (the API is re-fetchable; no R2 copy, and the
-- file-oriented data_ingestions ledger deliberately does not apply here).
--
-- Only records shipping OUTSIDE China are pushed: the app's isChinaDestination
-- gate marks Chinese-domestic (or unknown-destination — fail closed) rows
-- push_status = 'skipped_domestic' and they never reach HubSpot.
--
-- Push idempotency lives in HubSpot upserts on OA-owned unique keys
-- (oa_quote_number / oa_account_number / oa_order_id / oa_line_key — never the
-- SAP-owned sap_quote_number / account_number_ / sales_order_id). pushed_hash
-- vs detail_hash decides re-push; the nullable key columns exist so the four
-- record types join in SQL for debugging.
--
-- Internal/admin read; service-role writes.
-- =============================================================================

create table if not exists public.oa_records (
  id uuid primary key default gen_random_uuid(),
  record_type text not null check (record_type in ('order', 'quote', 'project', 'customer')),
  oa_id text not null,               -- OA's own id for the record
  oa_update_date text,               -- verbatim OA updateDate (per-record high-water mark)
  detail_hash text,                  -- stable hash of raw_json (change detection)
  raw_json jsonb not null default '{}'::jsonb,  -- fullest payload we have (list row or detail)
  -- Cross-record join keys (nullable; populated where the payload carries them).
  oa_quote_number text,              -- quotation id, e.g. QT2025120014
  oa_account_number text,            -- customer code, e.g. 0001002342
  oa_project_id text,
  -- Push state.
  push_status text not null default 'pending'
    check (push_status in ('pending', 'pushed', 'failed', 'skipped_domestic')),
  push_error text,
  pushed_at timestamptz,
  pushed_hash text,                  -- detail_hash last successfully pushed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (record_type, oa_id)
);

create index if not exists oa_records_type_status_idx on public.oa_records (record_type, push_status);
create index if not exists oa_records_quote_idx on public.oa_records (oa_quote_number);
create index if not exists oa_records_account_idx on public.oa_records (oa_account_number);

alter table public.oa_records enable row level security;

drop policy if exists oa_records_select on public.oa_records;
create policy oa_records_select on public.oa_records
  for select using (public.is_active_internal_or_admin());
