-- =============================================================================
-- Event-lead processing outcomes — one row per contact (last outcome wins).
--
-- The event-lead webhook now enqueues onto the wac-event-leads Cloudflare Queue
-- (serial consumer, retries, DLQ) instead of processing in the request; the
-- consumer records each contact's outcome here so "why didn't X get a lead?"
-- is a query, not log archaeology. Internal/admin read; service role writes.
-- =============================================================================

create table if not exists public.event_lead_outcomes (
  contact_id text primary key,        -- HubSpot contact record id
  campaign text,                      -- resolved campaign name ("" when none)
  status text,                        -- done | skipped_competitor | skipped_existing | no_owner | error
  lead_type text,                     -- NEW_BUSINESS | RE_ATTEMPTING
  lead_count int not null default 0,  -- leads created this run
  leads jsonb,                        -- [{leadId, ownerId, ownerSource, label}]
  deduped_existing int not null default 0, -- owners skipped (already had a lead for this campaign)
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_lead_outcomes_status_idx
  on public.event_lead_outcomes (status);
create index if not exists event_lead_outcomes_updated_idx
  on public.event_lead_outcomes (updated_at);

alter table public.event_lead_outcomes enable row level security;

drop policy if exists event_lead_outcomes_select on public.event_lead_outcomes;
create policy event_lead_outcomes_select
  on public.event_lead_outcomes
  for select using (public.is_active_internal_or_admin());
