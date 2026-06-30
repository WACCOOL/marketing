-- =============================================================================
-- National-account domains — fast email-domain → "is this a National Account?"
-- lookup for the marketing-event lead-ownership webhook.
--
-- The lead-ownership webhook (POST /api/hubspot/event-lead) must, before anything
-- else, route a contact to Sara Kruid when their company is a National Account.
-- A HubSpot company carries that as the `national_account` (bool) property, but
-- the webhook only has the contact's email — so we mirror the *primary domains* of
-- every national-account company here and match on the email's domain.
--
-- Populated by a Worker sync (apps/api/src/nationalAccounts.ts) that reads HubSpot
-- companies where `national_account = true` and upserts their normalized domain.
-- Full-replace snapshot: the sync prunes rows older than its run. Internal/admin
-- read; service role writes (no write policy → RLS denies anon/authenticated).
-- =============================================================================

create table if not exists public.national_account_domains (
  domain text primary key,            -- normalized primary domain (lowercased, no scheme/www/path)
  company_id text not null,           -- HubSpot company record id (source of truth)
  company_name text,
  synced_at timestamptz not null default now()
);

create index if not exists national_account_domains_company_idx
  on public.national_account_domains (company_id);

create index if not exists national_account_domains_synced_idx
  on public.national_account_domains (synced_at);

alter table public.national_account_domains enable row level security;

drop policy if exists national_account_domains_select on public.national_account_domains;
create policy national_account_domains_select on public.national_account_domains
  for select using (public.is_active_internal_or_admin());
