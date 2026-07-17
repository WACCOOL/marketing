-- =============================================================================
-- Marketing custom content — a first-class Thom Bot knowledge source
--
-- Marketing authors curated overviews, positioning, and FAQs (product / brand /
-- system) in an in-app admin page. Each row is a markdown document that is
-- projected into the Thom RAG store (kb_documents + kb_chunks, migration 0043)
-- on save: chunked, embedded (Workers AI bge-m3), and retrieved via kb_search
-- alongside spec sheets and manuals.
--
-- This is the AUTHORING system-of-record; kb_documents/kb_chunks are the
-- derived retrieval index (source_system='marketing_admin', external_id = this
-- row's id). Deleting a row here cascades to its kb_chunks via the projected
-- kb_documents row.
--
-- `scope` reuses the 0043 thom_scope enum — the SAME security boundary between
-- the internal bot and the public bubble. A 'public' row is authored
-- deliberately (the admin UI defaults to 'internal'); everything not meant for
-- the open web MUST stay 'internal'. RLS on kb_documents/kb_chunks (0043) is
-- what actually gates retrieval; this scope is copied onto the projected rows.
--
-- Distinct from product_content (0015), which is per-SKU field-keyed PIM copy.
-- This is free-form long-form marketing prose, not tied to a single SKU.
-- =============================================================================

-- draft: authored but not yet a live retrieval source (its chunks are removed /
-- never inserted). published: projected into kb_documents/kb_chunks as 'active'.
do $$ begin
  create type public.marketing_content_status as enum ('draft', 'published');
exception when duplicate_object then null; end $$;

create table if not exists public.marketing_content (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  -- Optional brand association (WAC Lighting / Modern Forms / Schonbek / AiSpire)
  -- — denormalized onto kb_chunks so retrieval can brand-filter.
  brand text,
  -- Retrieval visibility. Defaults to internal; 'public' is a deliberate choice
  -- in the admin UI. Reuses the 0043 enum so the two scopes can never diverge.
  scope public.thom_scope not null default 'internal',
  -- Free-text sub-classification for the marketing doc_type (e.g. 'overview',
  -- 'positioning', 'faq') — validated at the API layer, no migration to extend.
  doc_subtype text,
  -- Authored markdown.
  body text not null,
  -- sha256 of body — the projection idempotency key (unchanged body => no
  -- re-embed). Written by the projection helper.
  content_hash text,
  status public.marketing_content_status not null default 'draft',
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_content_status_idx
  on public.marketing_content (status);
create index if not exists marketing_content_brand_idx
  on public.marketing_content (brand);

-- updated_at touch trigger (same pattern as product_content, 0015).
create or replace function public.marketing_content_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists marketing_content_touch_trigger on public.marketing_content;
create trigger marketing_content_touch_trigger
  before update on public.marketing_content
  for each row execute function public.marketing_content_touch();

-- -----------------------------------------------------------------------------
-- RLS: internal marketing data. Active internal users and admins read and write;
-- reps have no access. Deletes are admin-only so a curated knowledge source
-- can't be dropped casually. Same posture as product_content (0015).
--
-- kb_documents / kb_chunks stay service-role-write (0043) — the API projects
-- into them with the service client; no policy change here.
-- -----------------------------------------------------------------------------
alter table public.marketing_content enable row level security;

drop policy if exists marketing_content_select on public.marketing_content;
create policy marketing_content_select on public.marketing_content
  for select using (public.is_active_internal_or_admin());

drop policy if exists marketing_content_insert on public.marketing_content;
create policy marketing_content_insert on public.marketing_content
  for insert with check (public.is_active_internal_or_admin());

drop policy if exists marketing_content_update on public.marketing_content;
create policy marketing_content_update on public.marketing_content
  for update using (public.is_active_internal_or_admin())
  with check (public.is_active_internal_or_admin());

drop policy if exists marketing_content_delete on public.marketing_content;
create policy marketing_content_delete on public.marketing_content
  for delete using (public.is_admin());
