-- =============================================================================
-- Product Detail Page (PDP) URL cache — replicates WIES Studio's pdp-resolver.
--
-- Each WAC Group brand site exposes search-by-identifier that resolves to the
-- canonical product page (waclighting.com/product/<slug>/). The products-sync
-- resolves a product's PDP slug by scraping the brand-site search for one of
-- its variant material numbers, then caches the result here so subsequent syncs
-- are zero-network (30-day TTL). Keyed by product PPID (= products.sku).
--
-- url = the final product_url pushed to HubSpot: the canonical /product/<slug>/
-- when a slug resolved, else the brand-site PPID-search fallback.
--
-- Internal/admin read; service-role writes.
-- =============================================================================

create table if not exists public.pdp_urls (
  sku text primary key,              -- product PPID (products.sku)
  brand text,                        -- canonical brand (WAC Lighting / Modern Forms / AiSpire / Schonbek)
  query text,                        -- the identifier that resolved the slug
  slug text,                         -- resolved PDP slug, or null when search found nothing
  url text not null,                 -- canonical PDP URL, or the PPID-search fallback
  resolved_at timestamptz not null default now()
);

create index if not exists pdp_urls_resolved_at_idx on public.pdp_urls (resolved_at);

alter table public.pdp_urls enable row level security;

drop policy if exists pdp_urls_select on public.pdp_urls;
create policy pdp_urls_select on public.pdp_urls
  for select using (public.is_active_internal_or_admin());
