-- =============================================================================
-- PRD §8 — PPT Generator: admin-uploaded .pptx templates.
--
-- One row per branded template. The .pptx itself lives in R2 at `r2_key`
-- (templates/{id}.pptx); `layout_map` maps the canonical deck layout names
-- (title, title_content, two_column, image_full, image_caption, table,
-- section — see packages/shared/src/ppt.ts) to the template's own slide-layout
-- names, seeded from the generator's introspection heuristic and editable by
-- admins in the mapping UI. Re-uploading a template bumps `version` so asset
-- metadata can pin which revision produced a deck.
-- =============================================================================

create table if not exists public.ppt_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  brand text,
  r2_key text not null,
  version integer not null default 1,
  layout_map jsonb not null default '{}',
  uploaded_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- RLS: every active user can pick a template; only admins manage them.
-- -----------------------------------------------------------------------------
alter table public.ppt_templates enable row level security;

drop policy if exists ppt_templates_select on public.ppt_templates;
create policy ppt_templates_select on public.ppt_templates
  for select using (public.is_active());

drop policy if exists ppt_templates_admin_all on public.ppt_templates;
create policy ppt_templates_admin_all on public.ppt_templates
  for all using (public.is_admin()) with check (public.is_admin());
