-- Per-user feature (menu-tab) access overrides.
--
-- A user's ROLE sets their default set of features (see DEFAULT_FEATURES in
-- packages/shared/src/features.ts). This table stores only the per-user
-- OVERRIDES on top of that default: a row means "for this user, pin this
-- feature on (allowed=true) or off (allowed=false)", overriding the role
-- default. Absence of a row = inherit the role default. Admins always have
-- every feature and are never gated by this table.
--
-- `feature` is plain text (validated in-app against the catalog) so new
-- features can be added without an enum migration.

create table if not exists public.user_features (
  user_id    uuid    not null references public.users(id) on delete cascade,
  feature    text    not null,
  allowed    boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, feature)
);

-- Lookups are always "all overrides for one user" (provisioning) or "all rows"
-- (admin list); the PK already covers the per-user case.
create index if not exists user_features_user_idx on public.user_features (user_id);

alter table public.user_features enable row level security;

-- Admins manage every row (reuse the is_admin() helper from 0003_rls.sql).
create policy user_features_admin_all on public.user_features
  for all using (public.is_admin()) with check (public.is_admin());

-- Users may read their own overrides (the API computes features server-side
-- via the service role, but this keeps direct reads safe and non-leaky).
create policy user_features_self_read on public.user_features
  for select using (auth.uid() = user_id);
