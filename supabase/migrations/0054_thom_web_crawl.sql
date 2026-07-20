-- =============================================================================
-- Thom Bot — website crawl foundations (plan step 2; INERT at rollout)
--
-- Three pieces, none of which change behavior until the crawl is enabled and
-- the tool layer passes a non-zero authority_weight:
--
--  1. kb_documents.authority — per-document authority tier for the hierarchy
--     model (WAC Group corporate 1.5 > main-brand corporate 1.2 > aiSpire
--     corporate 1.1 > marketing baseline 1.0 > news 0.9 > web product 0.8 >
--     resource/nav 0.7). Default 1.0 = neutral: every existing document keeps
--     exactly its current ranking.
--
--  2. crawl_frontier — the persisted URL frontier + per-URL PDP evidence for
--     the web crawl (source_system='web_crawl') and its pdp_urls/
--     product_documents reconciliation pass.
--
--  3. kb_search — recreated with a bounded, band-gated, ADDITIVE authority
--     bias. NOT a multiplier: fused RRF scores are rank-compressed (each
--     branch contributes 1/(60+rank), so the pool spans ~0.009–0.033 and
--     strong-vs-mediocre gaps are 1e-3..1e-4); a multiplicative factor in
--     [0.7,1.5] would inject a spread comparable to the entire relevance
--     signal and let a mid-relevance high-authority chunk beat the best
--     product answer. The additive bias instead:
--       - applies ONLY within the band (fused score >= authority_band *
--         pool max) — an off-topic corporate chunk mid-pool gets exactly 0;
--       - is scaled by authority_weight (lambda), default 0 = OFF, so this
--         migration provably changes no ordering;
--       - at the tool layer's lambda=0.004 the max positive bias is
--         0.004 * (1.5-1.0) = 0.002 — a near-tie breaker, never a leapfrog;
--       - clamps the negative delta at -0.3 so low tiers are nudged, not
--         buried.
--     Both knobs are function parameters, so post-launch tuning is a caller
--     config change, not another migration.
--
-- The old 6-parameter kb_search MUST be dropped (not replaced): CREATE OR
-- REPLACE with a different signature would create an overload, and a 6-argument
-- call would then be ambiguous between the old function and the new one's
-- defaults.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Per-document authority tier.
-- ---------------------------------------------------------------------------
alter table public.kb_documents
  add column if not exists authority real not null default 1.0;

-- ---------------------------------------------------------------------------
-- 2. crawl_frontier — one row per canonical URL the crawler has seen.
--
-- `url` is the canonicalized URL and the natural PK. `status` is the crawl
-- checkpoint (mirrors the docs-ingest status-as-checkpoint model): a re-run
-- picks up where the last one stopped. The discovered_* / model_codes /
-- resolved_* columns are the PDP evidence harvest that feeds the
-- reconciliation pass — populated at extract time so reconciliation needs no
-- second fetch. `region` attributes evidence on region-split catalogs
-- (wacarchitectural.com /na vs /int, whose specs and spec sheets are distinct
-- per region; schonbek.com international).
-- ---------------------------------------------------------------------------
create table if not exists public.crawl_frontier (
  url text primary key,
  host text not null,
  -- Site key from THOM_CRAWL_SITES ('wacgroup', 'waclighting', ...).
  site text not null,
  -- classify()'s verdict at discovery time (web_company, web_product, junk...).
  doc_type_guess text,
  status text not null default 'discovered'
    check (status in ('discovered', 'fetched', 'skipped', 'error', 'superseded')),
  http_status int,
  etag text,
  last_modified text,
  -- sha256 of the NORMALIZED main text (not raw bytes) — change detection.
  content_hash text,
  depth int not null default 0,
  last_crawled_at timestamptz,
  -- Regional catalog attribution ('na' | 'int' | null) — never merged across.
  region text,
  -- PDP evidence for reconciliation (plan E).
  discovered_slug text,
  discovered_spec_sheet_url text,
  model_codes text[],
  resolved_skus text[],
  resolved_family text,
  resolution_state text not null default 'unresolved'
    check (resolution_state in ('unresolved', 'one_sku', 'family', 'collision')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crawl_frontier_site_status_idx
  on public.crawl_frontier (site, status);
create index if not exists crawl_frontier_resolution_idx
  on public.crawl_frontier (resolution_state)
  where resolution_state <> 'unresolved';

create or replace function public.crawl_frontier_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists crawl_frontier_touch_trigger on public.crawl_frontier;
create trigger crawl_frontier_touch_trigger
  before update on public.crawl_frontier
  for each row execute function public.crawl_frontier_touch();

-- Internal operational data (crawl bookkeeping, unreleased evidence): readable
-- by active internal users/admins only; writes are service-role only (no write
-- policy, service role bypasses RLS) — same posture as pdp_urls (0026).
alter table public.crawl_frontier enable row level security;

drop policy if exists crawl_frontier_select on public.crawl_frontier;
create policy crawl_frontier_select on public.crawl_frontier
  for select using (public.is_active_internal_or_admin());

-- ---------------------------------------------------------------------------
-- 3. kb_search with band-gated additive authority bias.
--
-- The vec/lex/fused RRF core is byte-for-byte the 0043 logic (same per-branch
-- LIMITs, same k=60); only the final projection changes: join the parent doc
-- for `authority`, compute the pool max, and add the gated bias. SECURITY
-- INVOKER so RLS still applies — a public caller physically cannot pull
-- scope='internal' chunks regardless of arguments.
-- ---------------------------------------------------------------------------
drop function if exists public.kb_search(vector, text, text, text[], text, int);

create or replace function public.kb_search(
  query_embedding vector(1024),
  query_text text default null,
  scope_filter text default 'public',
  doc_types text[] default null,
  brand_filter text default null,
  match_count int default 8,
  authority_weight real default 0,
  authority_band real default 0.85
)
returns table (
  chunk_id uuid,
  document_id uuid,
  doc_type text,
  brand text,
  title text,
  url text,
  page int,
  content text,
  score real
)
language sql
stable
security invoker
as $$
  with vec as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
    from public.kb_chunks c
    join public.kb_documents d on d.id = c.document_id
    where d.status = 'active'
      and (scope_filter is null or c.scope::text = scope_filter)
      and (doc_types is null or c.doc_type = any (doc_types))
      and (brand_filter is null or c.brand = brand_filter)
    order by c.embedding <=> query_embedding
    limit greatest(match_count * 5, 50)
  ),
  lex as (
    select c.id,
           row_number() over (
             order by ts_rank(c.search_tsv, websearch_to_tsquery('english', query_text)) desc
           ) as rank
    from public.kb_chunks c
    join public.kb_documents d on d.id = c.document_id
    where query_text is not null and query_text <> ''
      and c.search_tsv @@ websearch_to_tsquery('english', query_text)
      and d.status = 'active'
      and (scope_filter is null or c.scope::text = scope_filter)
      and (doc_types is null or c.doc_type = any (doc_types))
      and (brand_filter is null or c.brand = brand_filter)
    order by ts_rank(c.search_tsv, websearch_to_tsquery('english', query_text)) desc
    limit greatest(match_count * 5, 50)
  ),
  fused as (
    select id, sum(1.0 / (60 + rank)) as score
    from (select id, rank from vec union all select id, rank from lex) r
    group by id
  ),
  pool as (
    select f.id, f.score, d.authority,
           max(f.score) over () as max_score
    from fused f
    join public.kb_chunks c on c.id = f.id
    join public.kb_documents d on d.id = c.document_id
  )
  select
    c.id, c.document_id, c.doc_type, c.brand, d.title, d.url, c.page, c.content,
    (p.score
       + case
           when authority_weight > 0
            and p.score >= authority_band * p.max_score
           then authority_weight * greatest(p.authority - 1.0, -0.3)
           else 0
         end
    )::real as score
  from pool p
  join public.kb_chunks c on c.id = p.id
  join public.kb_documents d on d.id = c.document_id
  order by score desc
  limit match_count;
$$;

grant execute on function
  public.kb_search(vector, text, text, text[], text, int, real, real)
  to anon, authenticated;
