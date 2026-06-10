-- =============================================================================
-- Phase 2 — Product Information (romance copy, SEO, normalization)
--
-- `product_content` is the App DB system-of-record for AI-generated / cleaned
-- product content (PRD §6): one row per (product_sku, field). The PIM stays
-- read-only; hand-off is via CSV export until the Sales Layer write-back
-- milestone. Deliberately NO foreign key to products(sku): the products table
-- is a prunable cache refreshed from Sales Layer, and approved content must
-- survive a re-sync.
--
-- Fields are open-ended text (romance_copy, seo_title, seo_meta_description,
-- cct, later lumens/beam_angle/...) — validated at the API layer so adding an
-- attribute doesn't need a migration.
-- =============================================================================

do $$ begin
  create type public.product_content_status as enum
    ('none', 'generated', 'in_review', 'approved');
exception when duplicate_object then null; end $$;

create table if not exists public.product_content (
  id uuid primary key default gen_random_uuid(),
  product_sku text not null,
  field text not null,
  -- Value currently in the PIM (romance copy) or the raw attribute value
  -- (normalization) — retained for traceability/side-by-side review.
  existing_value text,
  -- AI-generated copy, or the canonical normalized value proposal.
  ai_value text,
  -- The reviewed/confirmed value; what export/write-back ships.
  approved_value text,
  status public.product_content_status not null default 'none',
  -- Normalization: the raw value couldn't be confidently parsed and needs
  -- manual resolution (never silently mangled, never bulk-approved).
  flagged boolean not null default false,
  -- Short machine/human note, e.g. the parse-failure reason.
  note text,
  reviewed_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_sku, field)
);

create index if not exists product_content_sku_idx
  on public.product_content (product_sku);
create index if not exists product_content_field_status_idx
  on public.product_content (field, status);
create index if not exists product_content_flagged_idx
  on public.product_content (field) where flagged;

create or replace function public.product_content_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists product_content_touch_trigger on public.product_content;
create trigger product_content_touch_trigger
  before update on public.product_content
  for each row execute function public.product_content_touch();

-- -----------------------------------------------------------------------------
-- RLS: product content is internal marketing data. Active internal users and
-- admins read and write; reps have no access (their asset visibility is scoped
-- via asset_shares, but product enrichment is an internal-only workflow).
-- Deletes are admin-only so approved system-of-record values can't be dropped
-- casually.
-- -----------------------------------------------------------------------------
alter table public.product_content enable row level security;

drop policy if exists product_content_select on public.product_content;
create policy product_content_select on public.product_content
  for select using (public.is_active_internal_or_admin());

drop policy if exists product_content_insert on public.product_content;
create policy product_content_insert on public.product_content
  for insert with check (public.is_active_internal_or_admin());

drop policy if exists product_content_update on public.product_content;
create policy product_content_update on public.product_content
  for update using (public.is_active_internal_or_admin())
  with check (public.is_active_internal_or_admin());

drop policy if exists product_content_delete on public.product_content;
create policy product_content_delete on public.product_content
  for delete using (public.is_admin());
