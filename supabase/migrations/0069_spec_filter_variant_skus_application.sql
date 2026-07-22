-- =============================================================================
-- Thom Bot — real variant SKUs + application hard-filter in product_spec_filter
-- (spec-tool output defects, Davis 2026-07-22).
--
-- ORDERING (STRICT — reconciled after 0068 merged, PR #237): apply 0069
-- AFTER 0068. 0068 (mounting-type classification) recreated
-- product_spec_filter as a 24-argument function WITH `p_mounting_type`; this
-- migration drops THAT signature and recreates the FINAL UNION function:
-- all of 0068's arguments INCLUDING p_mounting_type (its scope predicate is
-- copied verbatim from 0068 §5a) PLUS this migration's
-- `p_application_patterns text[]` argument and `qualifying_variant_skus`
-- output column. Post-apply, the pg_proc overload count for
-- product_spec_filter MUST be exactly 1 (check in the verify block below).
--
-- SCOPE NOTE: this migration remains RPC-only —
--   * It does NOT touch product_variant_spec_view, product_variant_spec_mat,
--     product_spec_view, product_spec_rank, or any index — no matview
--     recreate, and NO matview refresh is required after applying this file.
--     The `variant_sku` column this migration depends on ALREADY EXISTS in
--     the 0063 base view and the 0064/0068 matview
--     (`nullif(btrim(coalesce(v.val ->> 'sku', '')), '')`), and the
--     `mounting_type` column its p_mounting_type predicate reads ships in
--     0068's matview recreate — hence the strict apply order.
--
-- WHY (two Davis-reported output defects + one scope addition):
--  1. filter_products answered "Turbo Bath & Vanity Light — SKU 822". 822 is
--     the internal PPID (products.sku), NOT an orderable part number; real
--     SKUs are variant-level (WS-180414-30-BN). The RPC already returns ONE
--     example_variant_sku (the min-width qualifying row's); the tool needs
--     the full (small) set of qualifying variant SKUs to present real part
--     numbers, so the RPC now also returns `qualifying_variant_skus` — the
--     qualifying variants' own SKU strings, ordered by width then variant
--     ordinal, capped at 6 (the [1:6] slice; QUALIFYING_SKU_CAP mirrors it in
--     packages/shared/src/thom/tools.ts). Rendering rules (PPID never labeled
--     "SKU", markdown product links) are TS-side in tools.ts/prompts.ts.
--  2. "vanity lights no wider than 15 inches" surfaced step/wall sconces:
--     the application term only fed semantic ORDERING, so adjacent fixture
--     types leak in once true matches run out. New optional
--     `p_application_patterns text[]`: when set, the scope CTE hard-filters
--     to rows where name ILIKE any pattern OR category ILIKE any pattern.
--     The TOOL layer owns the term→patterns synonym mapping (e.g. vanity →
--     {%vanit%,%bath%}) — SQL stays dumb. The predicate lives in the scope
--     CTE, so ALL windowed counts (in_scope_total / in_scope_screened /
--     matched) respect it: results outside the application are never
--     returned and never counted.
--
-- SECURITY: unchanged from 0064/0068. Same SECURITY INVOKER + pinned search_path +
-- clamped match_count; same grants (anon + authenticated). Variant SKU strings
-- are anon-safe by construction: they already ride inside products.variants,
-- which is on the 0052 anon column whitelist, and `variant_sku` is already an
-- anon-granted column of product_variant_spec_mat. The application patterns
-- are only ever compared via parameterized ILIKE — never concatenated into SQL.
--
-- -----------------------------------------------------------------------------
-- VERIFY AS ANON (anon key, no JWT) after apply:
--   [PASS] rpc product_spec_filter(p_width_max_in:15, p_class:'wall')
--          -> rows; every non-null-sku row carries example_variant_sku and
--          qualifying_variant_skus (length <= 6, first element =
--          example_variant_sku when the min-width pick has a sku).
--   [PASS] rpc product_spec_filter(p_width_max_in:15,
--          p_application_patterns:'{"%vanit%","%bath%"}')
--          -> every row's name or category matches vanit/bath (ILIKE);
--          in_scope_total SHRINKS vs the same call without patterns (the
--          filter is scope-level, not post-hoc).
--   [PASS] rpc product_spec_filter(p_width_max_in:15,
--          p_application_patterns:'{"%zzz-no-such-application%"}')
--          -> exactly one all-null row with in_scope_total = 0 (scope-zero,
--          the tool's honest-empty path).
--   [PASS] rpc product_spec_filter(p_mounting_type:'Recessed Downlights',
--          p_width_max_in:6) -> mounting-type predicate still works exactly
--          as in 0068 (kept verbatim), composed with the new args.
--   [DENY] rpc product_spec_filter(p_class:'sideways') -> raises (whitelist,
--          unchanged).
--   Overload check (must return EXACTLY 1 — both prior signatures are gone):
--     select count(*) from pg_proc p
--       join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public' and p.proname = 'product_spec_filter';
--
-- POST-APPLY: nothing else. No matview refresh (the matview is untouched by
-- this file; 0068's own post-apply steps cover its matview recreate).
-- =============================================================================

-- The return type changes, so `create or replace` is illegal: drop 0068's
-- 24-argument signature (the expected live one — strict order: 0069 after
-- 0068). The 0064 23-argument drop is kept as belt-and-braces so a stale
-- overload can never linger and 300 PostgREST rpc calls on ambiguity.
drop function if exists public.product_spec_filter(
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric,
  numeric, numeric, numeric, numeric, numeric,
  int, int, int, int,
  text, text, text, text,
  vector, text, int
);
drop function if exists public.product_spec_filter(
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric,
  numeric, numeric, numeric, numeric, numeric,
  int, int, int, int,
  text, text, text,
  vector, text, int
);

create function public.product_spec_filter(
  p_width_max_in numeric default null,
  p_width_min_in numeric default null,
  p_depth_max_in numeric default null,
  p_depth_min_in numeric default null,
  p_height_max_in numeric default null,
  p_height_min_in numeric default null,
  p_wire_min_in numeric default null,
  p_wire_max_in numeric default null,
  p_lumens_min numeric default null,
  p_lumens_max numeric default null,
  p_watts_max numeric default null,
  p_watts_min numeric default null,
  p_efficacy_min numeric default null,
  p_cct_min_k int default null,
  p_cct_max_k int default null,
  p_cri_min int default null,
  p_ip_min int default null,
  p_brand text default null,
  p_category text default null,
  p_class text default null,
  -- 0068: authoritative Sales Layer mounting-type facet (kept verbatim).
  p_mounting_type text default null,
  p_query_embedding vector(1024) default null,
  p_query_text text default null,
  p_match_count int default 10,
  -- 0069: application hard-filter — ILIKE patterns OR'd over name/category;
  -- the tool layer maps the user's application term to patterns.
  p_application_patterns text[] default null
)
returns table (
  sku text,
  name text,
  brand text,
  category text,
  class text,
  per_ft boolean,
  qualifying_variants bigint,
  variant_count_with_dims bigint,
  example_variant_sku text,
  -- 0069: the qualifying variants' OWN orderable SKU strings, width-then-
  -- ordinal order, capped at 6 ([1:6] below; TS mirror QUALIFYING_SKU_CAP).
  qualifying_variant_skus text[],
  q_width_min_in numeric,
  q_width_max_in numeric,
  q_depth_min_in numeric,
  q_depth_max_in numeric,
  q_height_min_in numeric,
  q_height_max_in numeric,
  ex_width_in numeric,
  ex_depth_in numeric,
  ex_height_in numeric,
  ex_width_mm numeric,
  ex_height_mm numeric,
  ex_length_mm numeric,
  ex_diameter_mm numeric,
  ex_wire_length_mm numeric,
  cct_summary text,
  cri int,
  ip int,
  lumens numeric,
  lumens_source text,
  score double precision,
  in_scope_total bigint,
  in_scope_screened bigint,
  matched bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  -- Whitelists + clamps (never arbitrary text near the query).
  if p_class is not null and p_class not in
    ('per-foot','fan','downlight','track','outdoor','wall','ceiling','linear','decorative','other')
  then
    raise exception 'product_spec_filter: unknown class %', p_class;
  end if;
  p_match_count := least(greatest(coalesce(p_match_count, 10), 1), 25);

  return query
  with scope as (
    -- Filter scope: non-accessory variant rows matching brand/category/class,
    -- the 0068 mounting-type facet (predicate verbatim from 0068 §5a), AND
    -- (0069) the application patterns — all regardless of data availability
    -- (in_scope_total's denominator), so the windowed counts respect both
    -- hard-filters by construction.
    select v.*
    from public.product_variant_spec_mat v
    where not v.is_accessory
      and (p_brand is null or v.brand = p_brand)
      and (p_category is null or v.category = p_category)
      and (p_class is null or v.class = p_class)
      and (p_mounting_type is null or lower(v.mounting_type) = lower(p_mounting_type))
      and (p_application_patterns is null
           or exists (
                select 1 from unnest(p_application_patterns) pat
                where v.name ilike pat or v.category ilike pat))
  ),
  evald as (
    select
      s.*,
      count(*) filter (where s.width_in is not null)
        over (partition by s.sku) as dims_variant_count,
      coalesce(s.variant_lumens, s.lumens_max) as eff_lumens,
      case
        when s.variant_lumens is not null then 'variant'
        when s.lumens_max is not null then 'product_level'
      end as eff_lumens_source,
      -- SCREENED (plan A9, pinned): this row is non-null on EVERY constrained
      -- variant-grain attribute (lumens/watts count their product-level
      -- fallback; efficacy is product-level).
      (
        ((p_width_max_in is null and p_width_min_in is null) or s.width_in is not null)
        and ((p_depth_max_in is null and p_depth_min_in is null) or s.depth_in is not null)
        and ((p_height_max_in is null and p_height_min_in is null) or s.height_in is not null)
        and ((p_wire_min_in is null and p_wire_max_in is null) or s.wire_length_mm is not null)
        and ((p_lumens_min is null and p_lumens_max is null)
             or coalesce(s.variant_lumens, s.lumens_max) is not null)
        and ((p_watts_max is null and p_watts_min is null)
             or coalesce(s.variant_watts, s.watts_max) is not null)
        and (p_efficacy_min is null or s.efficacy is not null)
        and ((p_cct_min_k is null and p_cct_max_k is null)
             or s.cct_values is not null or s.cct_min is not null)
        and (p_cri_min is null or s.cri is not null)
        and (p_ip_min is null or s.ip is not null)
      ) as row_screened,
      -- QUALIFIES: same-row conjunction; a NULL in a constrained attribute
      -- fails the predicate (`is true` collapses null -> false).
      (
        (p_width_max_in is null or s.width_in <= p_width_max_in)
        and (p_width_min_in is null or s.width_in >= p_width_min_in)
        and (p_depth_max_in is null or s.depth_in <= p_depth_max_in)
        and (p_depth_min_in is null or s.depth_in >= p_depth_min_in)
        and (p_height_max_in is null or s.height_in <= p_height_max_in)
        and (p_height_min_in is null or s.height_in >= p_height_min_in)
        and (p_wire_min_in is null or round(s.wire_length_mm / 25.4, 1) >= p_wire_min_in)
        and (p_wire_max_in is null or round(s.wire_length_mm / 25.4, 1) <= p_wire_max_in)
        and (p_lumens_min is null or coalesce(s.variant_lumens, s.lumens_max) >= p_lumens_min)
        and (p_lumens_max is null or coalesce(s.variant_lumens, s.lumens_max) <= p_lumens_max)
        and (p_watts_max is null or coalesce(s.variant_watts, s.watts_max) <= p_watts_max)
        and (p_watts_min is null or coalesce(s.variant_watts, s.watts_max) >= p_watts_min)
        and (p_efficacy_min is null or s.efficacy >= p_efficacy_min)
        and (
          (p_cct_min_k is null and p_cct_max_k is null)
          -- Selectable lists (and singles): EXACT MEMBERSHIP in the band.
          or (s.cct_values is not null and exists (
                select 1 from unnest(s.cct_values) e
                where e >= coalesce(p_cct_min_k, e)
                  and e <= coalesce(p_cct_max_k, e)))
          -- True ranges/tunables ONLY: band overlap.
          or (s.cct_values is null and s.cct_min is not null
              and s.cct_min <= coalesce(p_cct_max_k, s.cct_min)
              and s.cct_max >= coalesce(p_cct_min_k, s.cct_max))
        )
        and (p_cri_min is null or s.cri >= p_cri_min)
        and (p_ip_min is null or s.ip >= p_ip_min)
      ) is true as row_qualifies
    from scope s
  ),
  counts as (
    select
      count(distinct e.sku) as total_n,
      count(distinct e.sku) filter (where e.row_screened) as screened_n,
      count(distinct e.sku) filter (where e.row_qualifies) as matched_n
    from evald e
  ),
  qual as (
    select e.* from evald e where e.row_qualifies
  ),
  rolled as (
    select
      q.sku as r_sku,
      count(*) as qualifying_variants,
      -- 0069: the qualifying variants' OWN SKUs (real part numbers), same
      -- ordering as the example pick (width, then variant ordinal), capped
      -- at 6 so a 40-finish family never floods the tool output.
      (array_agg(q.variant_sku order by q.width_in asc nulls last, q.variant_ord asc nulls last)
         filter (where q.variant_sku is not null))[1:6] as q_variant_skus,
      min(q.width_in) as qw_min,
      max(q.width_in) as qw_max,
      min(q.depth_in) as qd_min,
      max(q.depth_in) as qd_max,
      min(q.height_in) as qh_min,
      max(q.height_in) as qh_max
    from qual q
    group by q.sku
  ),
  pick as (
    -- Example variant: the smallest qualifying width (deterministic).
    select distinct on (q.sku) q.*
    from qual q
    order by q.sku, q.width_in asc nulls last, q.variant_ord asc nulls last
  )
  (
    select
      k.sku,
      k.name,
      k.brand,
      k.category,
      k.class,
      k.per_ft,
      r.qualifying_variants,
      k.dims_variant_count,
      k.variant_sku,
      r.q_variant_skus,
      r.qw_min, r.qw_max, r.qd_min, r.qd_max, r.qh_min, r.qh_max,
      k.width_in, k.depth_in, k.height_in,
      k.width_mm, k.height_mm, k.length_mm, k.diameter_mm,
      k.wire_length_mm,
      k.cct_desc,
      k.cri,
      k.ip,
      k.eff_lumens,
      k.eff_lumens_source,
      (case when p_query_embedding is not null and pr.embedding is not null
            then pr.embedding <=> p_query_embedding end)::double precision,
      c.total_n, c.screened_n, c.matched_n
    from pick k
    join rolled r on r.r_sku = k.sku
    left join public.products pr on pr.sku = k.sku
    cross join counts c
    -- Exact post-filter sort (plan A7): distance -> ts_rank -> name -> sku.
    -- NO ANN shortcut — see the 0063 header.
    order by
      case when p_query_embedding is not null and pr.embedding is not null
           then pr.embedding <=> p_query_embedding end asc nulls last,
      case when p_query_text is not null
           then ts_rank(
                  to_tsvector('english', coalesce(k.name, '') || ' ' || coalesce(k.category, '')),
                  plainto_tsquery('english', p_query_text)) end desc nulls last,
      k.name asc,
      k.sku asc
    limit p_match_count
  )
  union all
  -- Zero-match counts row: the tool still needs in_scope_total /
  -- in_scope_screened to run the pinned relaxation protocol honestly.
  select
    null::text, null::text, null::text, null::text, null::text,
    null::boolean,
    null::bigint, null::bigint, null::text,
    null::text[],
    null::numeric, null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
    null::numeric, null::numeric, null::numeric,
    null::numeric, null::numeric, null::numeric, null::numeric,
    null::numeric,
    null::text, null::int, null::int,
    null::numeric, null::text,
    null::double precision,
    c.total_n, c.screened_n, c.matched_n
  from counts c
  where c.matched_n = 0;
end;
$$;

grant execute on function public.product_spec_filter(
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric,
  numeric, numeric, numeric, numeric, numeric,
  int, int, int, int,
  text, text, text, text,
  vector, text, int,
  text[]
) to anon, authenticated;
