-- =============================================================================
-- Thom Bot — IES photometrics store
--
-- Precomputed photometric metrics for product IES files, so Thom can answer
-- beam/field-angle, coverage (footcandles on a surface), spacing, UGR/glare,
-- BUG and efficacy questions on a specific SKU without live parsing.
--
-- Two tables, mirroring the kb_documents / product_documents idiom (0043):
--   * ies_metrics — one row per DISTINCT IES file content (deduped by the
--     sha256 of the raw bytes). The parsed + computed metric bundle lives in
--     `metrics` jsonb. Content-addressed so many SKUs / optics that share the
--     same photometry reuse one row.
--   * product_photometrics — the SKU ↔ ies_metrics link (many optics per SKU),
--     with exactly one is_representative row per SKU.
--
-- Like kb_documents, there is intentionally NO foreign key to products: this is
-- a prunable, denormalized cache keyed by SKU text, populated out-of-band by
-- apps/photometrics-sync. Writes are service-role only (no insert/update/delete
-- policy) — same posture as the rest of the Thom retrieval store.
-- =============================================================================

create table if not exists public.ies_metrics (
  id uuid primary key default gen_random_uuid(),
  content_hash text not null unique,
  inner_filename text,
  source_zip_url text,
  metrics jsonb not null,
  warnings jsonb not null default '[]'::jsonb,
  parser_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ies_metrics_hash_idx on public.ies_metrics (content_hash);

create table if not exists public.product_photometrics (
  id uuid primary key default gen_random_uuid(),
  product_sku text not null,
  ies_metrics_id uuid not null references public.ies_metrics(id) on delete cascade,
  ies_url text not null,
  is_representative boolean not null default false,
  match_confidence real,
  scope public.thom_scope not null default 'public',
  created_at timestamptz not null default now(),
  unique (product_sku, ies_metrics_id)
);
create index if not exists product_photometrics_sku_idx on public.product_photometrics (product_sku);
-- At most one representative optic per SKU.
create unique index if not exists product_photometrics_repr_uniq
  on public.product_photometrics (product_sku) where is_representative;

alter table public.ies_metrics enable row level security;
alter table public.product_photometrics enable row level security;

-- Photometrics links inherit the same public/internal scope gate as
-- product_documents: public rows are readable by anon (the public bubble),
-- internal rows require an active internal/admin user.
create policy product_photometrics_select on public.product_photometrics
  for select using (scope = 'public' or public.is_active_internal_or_admin());

-- ies_metrics carry no scope of their own (they're just deduped metric bundles;
-- the SKU link owns the scope), so they're readable for any linked row.
create policy ies_metrics_select on public.ies_metrics for select using (true);
