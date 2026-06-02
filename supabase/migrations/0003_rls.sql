-- =============================================================================
-- Row-Level Security — enforces §2 of the PRD at the data layer
--
-- Internal users: read any row with org_visibility='internal'.
-- Reps:           read only own rows or rows shared via asset_shares.
-- Admins:         read all.
-- Pending reps:   may read but not write (status='pending' check).
-- =============================================================================

alter table public.users               enable row level security;
alter table public.approved_domains    enable row level security;
alter table public.assets              enable row level security;
alter table public.asset_files         enable row level security;
alter table public.asset_shares        enable row level security;
alter table public.short_links         enable row level security;
alter table public.short_link_scans    enable row level security;
alter table public.utm_vocab           enable row level security;
alter table public.hubspot_campaigns   enable row level security;

-- Helper functions ------------------------------------------------------------

create or replace function public.is_active_internal_or_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and u.status = 'active'
      and (u.role = 'internal' or u.role = 'admin')
  );
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin' and u.status = 'active'
  );
$$;

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.status = 'active'
  );
$$;

-- users -----------------------------------------------------------------------
drop policy if exists users_self_read on public.users;
create policy users_self_read on public.users
  for select using (auth.uid() = id or public.is_admin());

drop policy if exists users_admin_update on public.users;
create policy users_admin_update on public.users
  for update using (public.is_admin()) with check (public.is_admin());

-- approved_domains: admin only -------------------------------------------------
drop policy if exists approved_domains_admin on public.approved_domains;
create policy approved_domains_admin on public.approved_domains
  for all using (public.is_admin()) with check (public.is_admin());

-- assets ----------------------------------------------------------------------
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets
  for select using (
    -- owner
    owner_id = auth.uid()
    -- internal/admin sees internal-visibility rows
    or (org_visibility = 'internal' and public.is_active_internal_or_admin())
    -- rep with an explicit share
    or exists (
      select 1 from public.asset_shares s
      where s.asset_id = id and s.user_id = auth.uid()
    )
  );

drop policy if exists assets_insert on public.assets;
create policy assets_insert on public.assets
  for insert with check (
    auth.uid() = owner_id and public.is_active()
  );

drop policy if exists assets_update on public.assets;
create policy assets_update on public.assets
  for update using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists assets_delete on public.assets;
create policy assets_delete on public.assets
  for delete using (owner_id = auth.uid() or public.is_admin());

-- asset_files: inherit asset visibility ---------------------------------------
drop policy if exists asset_files_select on public.asset_files;
create policy asset_files_select on public.asset_files
  for select using (
    exists (
      select 1 from public.assets a
      where a.id = asset_id
        and (
          a.owner_id = auth.uid()
          or (a.org_visibility = 'internal' and public.is_active_internal_or_admin())
          or exists (
            select 1 from public.asset_shares s
            where s.asset_id = a.id and s.user_id = auth.uid()
          )
        )
    )
  );

drop policy if exists asset_files_modify on public.asset_files;
create policy asset_files_modify on public.asset_files
  for all using (
    exists (
      select 1 from public.assets a
      where a.id = asset_id
        and (a.owner_id = auth.uid() or public.is_admin())
    )
  ) with check (
    exists (
      select 1 from public.assets a
      where a.id = asset_id
        and (a.owner_id = auth.uid() or public.is_admin())
    )
  );

-- asset_shares ----------------------------------------------------------------
drop policy if exists asset_shares_read on public.asset_shares;
create policy asset_shares_read on public.asset_shares
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from public.assets a
      where a.id = asset_id and a.owner_id = auth.uid()
    )
    or public.is_admin()
  );

drop policy if exists asset_shares_write on public.asset_shares;
create policy asset_shares_write on public.asset_shares
  for all using (
    exists (
      select 1 from public.assets a
      where a.id = asset_id and (a.owner_id = auth.uid() or public.is_admin())
    )
  ) with check (
    exists (
      select 1 from public.assets a
      where a.id = asset_id and (a.owner_id = auth.uid() or public.is_admin())
    )
  );

-- short_links -----------------------------------------------------------------
drop policy if exists short_links_select on public.short_links;
create policy short_links_select on public.short_links
  for select using (
    owner_id = auth.uid()
    or public.is_active_internal_or_admin()
  );

drop policy if exists short_links_insert on public.short_links;
create policy short_links_insert on public.short_links
  for insert with check (
    owner_id = auth.uid() and public.is_active()
  );

drop policy if exists short_links_update on public.short_links;
create policy short_links_update on public.short_links
  for update using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists short_links_delete on public.short_links;
create policy short_links_delete on public.short_links
  for delete using (owner_id = auth.uid() or public.is_admin());

-- short_link_scans: admin only via the API; redirect Worker uses service role
drop policy if exists short_link_scans_admin on public.short_link_scans;
create policy short_link_scans_admin on public.short_link_scans
  for select using (public.is_admin());

-- utm_vocab: anyone signed in may read; only `content` is insertable, and only
-- by an active user.
drop policy if exists utm_vocab_select on public.utm_vocab;
create policy utm_vocab_select on public.utm_vocab
  for select using (public.is_active());

drop policy if exists utm_vocab_insert_content on public.utm_vocab;
create policy utm_vocab_insert_content on public.utm_vocab
  for insert with check (type = 'content' and public.is_active());

drop policy if exists utm_vocab_admin_other on public.utm_vocab;
create policy utm_vocab_admin_other on public.utm_vocab
  for all using (public.is_admin()) with check (public.is_admin());

-- hubspot_campaigns: read for any active user
drop policy if exists hubspot_campaigns_select on public.hubspot_campaigns;
create policy hubspot_campaigns_select on public.hubspot_campaigns
  for select using (public.is_active());
