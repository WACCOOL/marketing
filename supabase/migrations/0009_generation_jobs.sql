-- =============================================================================
-- Phase 2b — Async generation jobs
--
-- Tracks the lifecycle of a heavy generation request (Application Image, PPT,
-- Layout). The API Worker inserts a `queued` row under the caller's JWT (RLS),
-- enqueues a Cloudflare Queue message, and the generation Container flips the
-- row to running -> succeeded/failed and links the produced asset. Status
-- writes from the Container use the service role (bypasses RLS); the failure
-- finalizer in the queue consumer also uses the service role.
--
-- `tool` reuses the existing public.asset_tool enum so the job, the produced
-- asset, and the shared ToolSchema all trace back to one source of truth.
-- =============================================================================

do $$ begin
  create type public.generation_job_status as enum (
    'queued', 'running', 'succeeded', 'failed'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Owner is required for RLS: the produced asset_id is unknown until the job
  -- finishes, so we can't lean on asset ownership for read scoping.
  owner_id uuid not null references public.users(id) on delete cascade,
  -- Null until the Container creates the asset on success.
  asset_id uuid references public.assets(id) on delete set null,
  tool public.asset_tool not null,
  status public.generation_job_status not null default 'queued',
  params_json jsonb not null default '{}'::jsonb,
  result_json jsonb,
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists generation_jobs_owner_idx on public.generation_jobs (owner_id);
create index if not exists generation_jobs_status_idx on public.generation_jobs (status);

-- -----------------------------------------------------------------------------
-- RLS: mirrors short_links — owner (or active internal/admin) reads; only the
-- owner inserts their own queued jobs; owner/admin may update/delete. The
-- Container's status writes run as the service role, which bypasses RLS.
-- -----------------------------------------------------------------------------
alter table public.generation_jobs enable row level security;

drop policy if exists generation_jobs_select on public.generation_jobs;
create policy generation_jobs_select on public.generation_jobs
  for select using (
    owner_id = auth.uid()
    or public.is_active_internal_or_admin()
  );

drop policy if exists generation_jobs_insert on public.generation_jobs;
create policy generation_jobs_insert on public.generation_jobs
  for insert with check (
    owner_id = auth.uid() and public.is_active()
  );

drop policy if exists generation_jobs_update on public.generation_jobs;
create policy generation_jobs_update on public.generation_jobs
  for update using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists generation_jobs_delete on public.generation_jobs;
create policy generation_jobs_delete on public.generation_jobs
  for delete using (owner_id = auth.uid() or public.is_admin());
