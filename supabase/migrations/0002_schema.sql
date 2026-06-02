-- =============================================================================
-- WAC Marketing — Phase 1 schema
-- =============================================================================

-- Approved corporate email domains for auto-internal provisioning.
create table if not exists public.approved_domains (
  domain text primary key
);

-- Users mirror table. The PK matches auth.users.id so RLS joins work.
do $$ begin
  create type public.user_role as enum ('internal', 'rep', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.user_status as enum ('active', 'pending');
exception when duplicate_object then null; end $$;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role public.user_role not null default 'rep',
  status public.user_status not null default 'pending',
  created_at timestamptz not null default now()
);

-- Assets
do $$ begin
  create type public.asset_tool as enum ('utm', 'qr', 'appimage', 'ppt', 'layout');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.asset_visibility as enum ('internal', 'private');
exception when duplicate_object then null; end $$;

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id) on delete cascade,
  tool public.asset_tool not null,
  name text not null,
  org_visibility public.asset_visibility not null default 'internal',
  tags text[] not null default '{}',
  metadata_json jsonb not null default '{}'::jsonb,
  parent_asset_id uuid references public.assets(id) on delete set null,
  version int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists assets_owner_idx on public.assets(owner_id);
create index if not exists assets_tool_idx on public.assets(tool);
create index if not exists assets_parent_idx on public.assets(parent_asset_id);
create index if not exists assets_tags_idx on public.assets using gin (tags);

-- Asset files: one row per format (svg/png/url/xlsx…)
create table if not exists public.asset_files (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  format text not null,
  r2_key text not null,
  bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (asset_id, format)
);
create index if not exists asset_files_asset_idx on public.asset_files(asset_id);

-- Explicit rep grants
create table if not exists public.asset_shares (
  asset_id uuid not null references public.assets(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  granted_by uuid references public.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (asset_id, user_id)
);

-- Short links — the editable QR target.
create table if not exists public.short_links (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  destination_url text not null,
  owner_id uuid not null references public.users(id) on delete cascade,
  scan_count bigint not null default 0,
  last_scanned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists short_links_owner_idx on public.short_links(owner_id);

-- Scan log for analytics (lightweight — we'll likely roll up later).
create table if not exists public.short_link_scans (
  id bigserial primary key,
  slug text not null,
  user_agent text,
  referrer text,
  scanned_at timestamptz not null default now()
);
create index if not exists short_link_scans_slug_idx on public.short_link_scans(slug);

-- Governed UTM vocab. `content` is the only user-extendable category.
do $$ begin
  create type public.utm_vocab_type as enum ('source', 'medium', 'content');
exception when duplicate_object then null; end $$;

create table if not exists public.utm_vocab (
  id uuid primary key default gen_random_uuid(),
  type public.utm_vocab_type not null,
  value text not null,
  created_at timestamptz not null default now(),
  unique (type, value)
);

-- HubSpot campaign cache. Populated by seed in dev; live sync replaces it later.
create table if not exists public.hubspot_campaigns (
  hubspot_id text not null,
  slug text not null,
  name text not null,
  synced_at timestamptz not null default now(),
  primary key (hubspot_id, slug)
);

-- Increment-scan RPC used by the redirect Worker inside ctx.waitUntil().
-- Doing it as a SQL function lets us update both columns atomically AND
-- insert the scan log row in a single round-trip.
create or replace function public.increment_scan(
  p_slug text,
  p_user_agent text,
  p_referrer text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.short_links
     set scan_count = scan_count + 1,
         last_scanned_at = now()
   where slug = p_slug;

  insert into public.short_link_scans (slug, user_agent, referrer)
  values (p_slug, p_user_agent, p_referrer);
end;
$$;
revoke all on function public.increment_scan(text, text, text) from public;
grant execute on function public.increment_scan(text, text, text) to service_role;
