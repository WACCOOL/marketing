-- =============================================================================
-- Company sub-type auto-classification (LLM-assisted)
--
-- A HubSpot workflow enrolls a Company when `company_sub_type` is unknown and
-- calls POST /api/hubspot/classify-company. The Worker reads the company, asks
-- Gemini to pick the best-fitting sub-type from a CURATED candidate list, and
-- writes it back — only when the value is blank (never overwrites). These two
-- tables back that flow:
--
--   company_sub_type_candidates       — the curated set the model may choose from,
--                                        AUTO-DERIVED from values actually in use on
--                                        companies (junk/typo options filtered out).
--                                        Refreshed by the territory-sync candidate
--                                        builder; the Worker reads enabled rows.
--   company_sub_type_classifications  — one row per company we've attempted, with
--                                        the chosen value, confidence, model, and
--                                        token counts. Used to (a) measure ACTUAL
--                                        spend from a sample, (b) skip already-tried
--                                        companies in the backfill, (c) dedup rapid
--                                        duplicate webhooks, (d) debug.
--
-- Internal/admin read (same predicate as the other hubspot_* / sync tables);
-- the service role bypasses RLS for writes.
-- =============================================================================

create table if not exists public.company_sub_type_candidates (
  value text primary key,             -- exact HubSpot option value the model may emit
  label text not null default '',
  count int not null default 0,       -- # companies currently using this value (frequency)
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.company_sub_type_classifications (
  company_id text primary key,        -- HubSpot company record id (hs_object_id)
  result text,                        -- chosen/proposed sub-type (null when none)
  confidence numeric,                 -- model self-reported confidence 0..1
  model text,                         -- model id used
  source text,                        -- 'webhook' | 'backfill' | 'manual'
  status text,                        -- classified | no_confident_match | already_set | no_data | skipped | error
  wrote boolean not null default false,-- did we PATCH HubSpot?
  prompt_tokens int,                  -- gemini usageMetadata.promptTokenCount
  output_tokens int,                  -- gemini usageMetadata.candidatesTokenCount
  inputs_hash text,                   -- cheap hash of the classified inputs (debug)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists company_sub_type_classifications_status_idx
  on public.company_sub_type_classifications (status);
create index if not exists company_sub_type_classifications_updated_idx
  on public.company_sub_type_classifications (updated_at);

alter table public.company_sub_type_candidates enable row level security;
alter table public.company_sub_type_classifications enable row level security;

drop policy if exists company_sub_type_candidates_select on public.company_sub_type_candidates;
create policy company_sub_type_candidates_select on public.company_sub_type_candidates
  for select using (public.is_active_internal_or_admin());

drop policy if exists company_sub_type_classifications_select on public.company_sub_type_classifications;
create policy company_sub_type_classifications_select on public.company_sub_type_classifications
  for select using (public.is_active_internal_or_admin());
