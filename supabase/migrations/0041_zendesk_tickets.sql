-- =============================================================================
-- Zendesk <-> HubSpot ticket mirror (Quote Desk + generic group sync).
--
-- One row per Zendesk ticket the Worker mirrors into HubSpot. The Quote Desk
-- card creates quote tickets through the Worker (origin=card); tickets born in
-- Zendesk (email to quotes@ etc.) are adopted by the webhook/reconcile path
-- when they match a deal (deal-ID field or SAP quote number) or simply mirrored
-- for non-quote customer-facing groups (origin=adopted|backfill).
--
-- zendesk_ticket_comments records every public comment already mirrored as a
-- HubSpot Note, keyed by Zendesk's stable comment id — webhook retries and the
-- nightly reconcile are idempotent because of this table.
--
-- Internal/admin read; service role writes (same posture as 0037).
-- =============================================================================

create table if not exists public.zendesk_tickets (
  id uuid primary key default gen_random_uuid(),
  request_id uuid unique,                  -- Quote Desk card idempotency key (null for adopted/backfill)
  zendesk_ticket_id bigint not null unique,
  hubspot_ticket_id text unique,           -- null while ZENDESK_SYNC_WRITE is off (dark launch)
  zd_group_id bigint,                      -- Zendesk group (allowlisted via ZD_SYNC_GROUPS)
  deal_id text,                            -- HubSpot deal record id (quote tickets only)
  contact_id text,                         -- HubSpot contact associated to the ticket
  contact_created boolean not null default false, -- contact was created by this sync
  requester_email text,
  requester_email_fake boolean not null default false, -- Zendesk placeholder email; never matched/created a contact
  request_type text,                       -- new|revision|followup_change|custom|schonbek|international (card only)
  category text,                           -- Zendesk (Quotes) Category value
  zd_status text,                          -- new|open|pending|hold|solved|closed
  hs_stage text,                           -- HubSpot ticket pipeline stage last written
  quote_number text,                       -- SAP quote number (Zendesk field 1500004166021)
  followup_of bigint,                      -- via_followup_source_id lineage (closed-ticket follow-ups)
  origin text not null default 'card',     -- card | adopted | backfill
  last_event_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists zendesk_tickets_deal_idx on public.zendesk_tickets (deal_id);
create index if not exists zendesk_tickets_contact_idx on public.zendesk_tickets (contact_id);
create index if not exists zendesk_tickets_status_idx on public.zendesk_tickets (zd_status);
create index if not exists zendesk_tickets_group_idx on public.zendesk_tickets (zd_group_id);

create table if not exists public.zendesk_ticket_comments (
  zendesk_comment_id bigint primary key,
  zendesk_ticket_id bigint not null
    references public.zendesk_tickets (zendesk_ticket_id) on delete cascade,
  hubspot_note_id text,                    -- null while ZENDESK_SYNC_WRITE is off
  author text,
  created_at timestamptz not null default now()
);

create index if not exists zendesk_ticket_comments_ticket_idx
  on public.zendesk_ticket_comments (zendesk_ticket_id);

alter table public.zendesk_tickets enable row level security;
alter table public.zendesk_ticket_comments enable row level security;

drop policy if exists zendesk_tickets_select on public.zendesk_tickets;
create policy zendesk_tickets_select
  on public.zendesk_tickets
  for select using (public.is_active_internal_or_admin());

drop policy if exists zendesk_ticket_comments_select on public.zendesk_ticket_comments;
create policy zendesk_ticket_comments_select
  on public.zendesk_ticket_comments
  for select using (public.is_active_internal_or_admin());
