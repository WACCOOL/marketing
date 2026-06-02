-- =============================================================================
-- Fix: infinite recursion in RLS policies for `assets` (and `asset_files`)
--
-- Root cause: assets_select did `EXISTS (… asset_shares …)` and
-- asset_shares_read did `EXISTS (… assets …)` — two RLS-protected tables
-- mutually referencing each other through inline subqueries. Postgres
-- re-applies RLS on every nested table read, so the two policies recursed.
--
-- Fix: route every cross-table check through a SECURITY DEFINER helper
-- function, which bypasses RLS internally and breaks the cycle.
-- =============================================================================

create or replace function public.user_owns_asset(p_asset_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.assets a
    where a.id = p_asset_id and a.owner_id = auth.uid()
  );
$$;

create or replace function public.user_has_share(p_asset_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.asset_shares s
    where s.asset_id = p_asset_id and s.user_id = auth.uid()
  );
$$;

create or replace function public.user_can_read_asset(p_asset_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.assets a
    where a.id = p_asset_id
      and (
        a.owner_id = auth.uid()
        or (a.org_visibility = 'internal' and public.is_active_internal_or_admin())
        or exists (
          select 1 from public.asset_shares s
          where s.asset_id = a.id and s.user_id = auth.uid()
        )
      )
  );
$$;

-- assets ----------------------------------------------------------------------
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets
  for select using (
    owner_id = auth.uid()
    or (org_visibility = 'internal' and public.is_active_internal_or_admin())
    or public.user_has_share(id)
  );

-- asset_files -----------------------------------------------------------------
drop policy if exists asset_files_select on public.asset_files;
create policy asset_files_select on public.asset_files
  for select using (public.user_can_read_asset(asset_id));

drop policy if exists asset_files_modify on public.asset_files;
create policy asset_files_modify on public.asset_files
  for all using (public.user_owns_asset(asset_id) or public.is_admin())
  with check (public.user_owns_asset(asset_id) or public.is_admin());

-- asset_shares ----------------------------------------------------------------
drop policy if exists asset_shares_read on public.asset_shares;
create policy asset_shares_read on public.asset_shares
  for select using (
    user_id = auth.uid()
    or public.user_owns_asset(asset_id)
    or public.is_admin()
  );

drop policy if exists asset_shares_write on public.asset_shares;
create policy asset_shares_write on public.asset_shares
  for all using (public.user_owns_asset(asset_id) or public.is_admin())
  with check (public.user_owns_asset(asset_id) or public.is_admin());
