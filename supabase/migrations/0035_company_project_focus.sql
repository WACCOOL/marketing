-- =============================================================================
-- Interior-designer project-focus classification — audit log.
--
-- Mirrors company_sub_type_classifications (migration 0032) for the parallel
-- "residential vs commercial" classifier that fills the company `project_focus`
-- multi-select for interior designers (POST /api/hubspot/classify-project-focus,
-- the backfill, and the just-in-time call from the event-lead webhook). One row per
-- company, upserted on every attempt; used for dedup + cost/coverage reporting.
--
-- No candidate table — the classifier's output is a fixed two-class set
-- (Residential / Commercial). Internal/admin read; service role writes.
-- =============================================================================

create table if not exists public.company_project_focus_classifications (
  company_id text primary key,         -- HubSpot company record id
  result text,                         -- written value, e.g. "Residential" / "Residential;Commercial"
  confidence numeric,                  -- model self-reported confidence 0..1 (null when defaulted)
  model text,                          -- model id used
  source text,                         -- 'webhook' | 'backfill' | 'manual' | 'event-lead'
  status text,                         -- classified | defaulted | already_set | skipped_not_designer | skipped | error
  wrote boolean not null default false,-- did we PATCH HubSpot?
  prompt_tokens int,
  output_tokens int,
  inputs_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists company_project_focus_classifications_status_idx
  on public.company_project_focus_classifications (status);
create index if not exists company_project_focus_classifications_updated_idx
  on public.company_project_focus_classifications (updated_at);

alter table public.company_project_focus_classifications enable row level security;

drop policy if exists company_project_focus_classifications_select
  on public.company_project_focus_classifications;
create policy company_project_focus_classifications_select
  on public.company_project_focus_classifications
  for select using (public.is_active_internal_or_admin());
