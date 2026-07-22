-- =============================================================================
-- Thom Bot — materialize the spec surface (0063's A6 latency gate FIRED).
--
-- NUMBERING: this migration takes 0064. The (unratified) category-sales plan
-- doc (docs/thom-category-sales-plan.md) also refers to "0064" for its own
-- future migration — that plan will renumber; this file wins the slot.
--
-- WHY: the 0063 `product_spec_filter` RPC times out (57014) even as service
-- role (~8 s statement cap). The base `product_variant_spec_view` expands
-- ~37k variant rows out of products.variants jsonb and runs several regex
-- parsers (parse_num x4, parse_cct, parse_ip, parse_dims) plus the
-- photometrics lateral PER QUERY — too expensive to recompute per request.
-- The ratified attribute-filter plan pre-approved exactly this fix (A6:
-- "p95 > 2 s TRIGGERS materialization of the base view — a numbered gate,
-- not an open-ended deferral").
--
-- WHAT:
--  1. product_variant_spec_mat — MATERIALIZED copy of 0063's base view
--     select, with the photometrics lateral restricted to scope = 'public'
--     (see SECURITY below), plus a `variant_key` column (variant_ord with
--     nulls collapsed to 0) so a plain-column UNIQUE index can back
--     `refresh ... concurrently`.
--  2. Unique + predicate btree indexes on the matview.
--  3. product_spec_filter recreated on the matview (same signature, same
--     semantics); product_spec_view (the rank view, 0059's product_spec_rank
--     reads it) rebuilt on the matview so ranking gets the same speedup.
--  4. refresh_product_spec_mat() — SECURITY DEFINER, service_role-only —
--     called by the product sync (apps/api/src/saleslayer.ts) after every
--     successful catalog sync.
--
-- The PLAIN view product_variant_spec_view is KEPT and untouched: get_product
-- reads it per-SKU (the sku predicate pushes into the window partition key,
-- so single-SKU reads are cheap) and it remains the scope-accurate,
-- always-fresh surface for internal callers who need the internal IES edge.
--
-- CRITICAL SECURITY NOTE — MATVIEWS HAVE NO RLS AND NO INVOKER SEMANTICS.
-- 0063's plain views leaned on `security_invoker = on`: the photometrics
-- lateral ran as the CALLER, so 0048's scope RLS hid internal-scoped IES rows
-- from anon. A materialized view is a TABLE snapshot: its defining query runs
-- as the matview OWNER (postgres, RLS bypassed) at refresh time, and readers
-- see whatever was materialized, RLS-free. Therefore the matview may contain
-- ONLY anon-safe data. Audit of 0063's base select (copied below verbatim
-- except as noted):
--   * products columns read: exactly sku, name, brand, category,
--     is_accessory, variants. ALL are on the 0052 anon column whitelist.
--     raw_json / variant_search / sl_id are never touched.
--   * product_photometrics/ies_metrics: the ONE change from 0063's select —
--     the lateral now hard-codes `pp.scope = 'public'`, reproducing 0048's
--     anon gate IN THE QUERY since RLS can no longer do it. ies_metrics rows
--     are unscoped metric bundles (0048: the link owns the scope) and are
--     anon-readable already.
--   * No other relations are read.
-- CONSEQUENCE (accepted + documented): INTERNAL users lose the
-- internal-scoped-IES edge in FILTER and RANK results — a product whose only
-- photometrics link is scope='internal' shows no IES-derived lumens for
-- anyone on those surfaces. Anon results are UNCHANGED (they never saw those
-- rows). get_product still reads the plain view, so per-product internal IES
-- display is unaffected. Also: previously an authenticated-but-inactive user
-- got 0 rows from the spec views (0008 is_active() RLS on products); the
-- matview grant lets any authenticated key read it. Not a leak — the same
-- data is fully readable by bare anon — but noted.
--
-- STALENESS: a matview only changes on REFRESH. The product sync calls
-- refresh_product_spec_mat() as a post-success, best-effort step (same idiom
-- as doc/accessory capture — failure never fails the sync), so the filter
-- surface is at most one catalog sync behind the products table, plus
-- whatever drifts between syncs (nothing else writes products.variants).
-- If the refresh RPC itself ever hits 57014 through PostgREST, that is the
-- role-level statement_timeout on the service path; run the refresh from a
-- longer-lived context instead (SQL editor / pg_cron, which run as postgres)
-- or raise the timeout for service_role only — do NOT loosen anon.
-- `refresh ... concurrently` needs the unique index below and keeps readers
-- unblocked during the swap; the migration itself creates the matview
-- populated (WITH DATA), so the first concurrent refresh is legal.
--
-- -----------------------------------------------------------------------------
-- VERIFY AS ANON (anon key, no JWT — apps/api/src/thom/anonBoundary.test.ts):
--   [PASS] select * from product_variant_spec_mat limit 5           -> rows
--   [PASS] rpc product_spec_filter(p_width_max_in:15, p_class:'wall')
--          -> rows, every q_width_max_in <= 15.0, counts populated,
--          completes WELL under 2 s (this is the A6 gate re-run; record the
--          explain analyze timing at apply):
--            explain analyze
--              select * from product_spec_filter(
--                p_width_max_in := 15, p_lumens_min := 1000,
--                p_depth_max_in := 4, p_query_text := 'vanity light',
--                p_match_count := 10);
--   [PASS] rpc product_spec_rank(metric:'lumens')                   -> rows,
--          same shape as pre-0064 (product_spec_view now reads the matview)
--   [PASS] select * from product_spec_view limit 5                  -> rows
--   [DENY] rpc refresh_product_spec_mat()                           -> 42501
--          permission denied (anon AND authenticated; service_role only)
--   [DENY] select raw_json from products                            -> denied
--          (0052 — unchanged, listed to re-pin the boundary)
-- Also verify the matview carries NO internal-scoped IES data: for a SKU
-- whose ONLY photometrics link has scope='internal',
--   select lumens_source from product_variant_spec_mat where sku = :sku;
-- must NOT be 'ies' (the plain product_variant_spec_view MAY say 'ies' for an
-- internal caller — that divergence is the documented trade).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The materialized base. Definition = 0063's product_variant_spec_view
--    select with EXACTLY TWO changes, both flagged inline:
--      [MAT-1] variant_key column (nulls-collapsed variant_ord) for the
--              UNIQUE index `refresh concurrently` requires (plain columns
--              only, all rows unique; zero-variant products keep their single
--              all-null variant row as (sku, 0) — `with ordinality` starts at
--              1, so 0 can never collide with a real variant).
--      [MAT-2] pp.scope = 'public' in the photometrics lateral (see the
--              security note above).
-- -----------------------------------------------------------------------------
drop materialized view if exists public.product_variant_spec_mat;

create materialized view public.product_variant_spec_mat as
select
  b.sku,
  b.name,
  b.brand,
  b.category,
  b.class,
  b.is_accessory,
  b.variant_ord,
  coalesce(b.variant_ord, 0) as variant_key,  -- [MAT-1]
  b.variant_sku,
  b.finish,
  b.width_mm,
  b.height_mm,
  b.length_mm,
  b.diameter_mm,
  b.wire_length_mm,
  b.per_ft,
  b.variant_lumens,
  b.variant_watts,
  b.cct_desc,
  cct.cct_min,
  cct.cct_max,
  cct.cct_values,
  cct.cct_multi,
  b.cri,
  b.ip,
  d.width_in,
  d.depth_in,
  d.height_in,
  -- Product-level rollups (0059 semantics, window-computed over the SKU):
  greatest(max(b.variant_lumens) over w, b.ies_lumens) as lumens_max,
  min(b.variant_lumens) over w as lumens_min,
  case
    when max(b.variant_lumens) over w is null and b.ies_lumens is null then null
    when b.ies_lumens is not null
     and (max(b.variant_lumens) over w is null or b.ies_lumens >= max(b.variant_lumens) over w)
      then 'ies'
    else 'sales_layer'
  end as lumens_source,
  max(b.variant_watts) over w as watts_max,
  min(b.variant_watts) over w as watts_min,
  max(b.watts_per_ft) over w as watts_per_ft_max,
  coalesce(bool_or(b.per_ft) over w, false) as per_ft_any,
  case
    when coalesce(bool_or(b.per_ft) over w, false) then null
    else coalesce(b.ies_efficacy, max(b.eff_row) over w)
  end as efficacy,
  count(b.variant_ord) over w as variant_count
from (
  select
    r.*,
    -- Per-variant conjunction values: per-foot rows are EXCLUDED (a tape
    -- lumens/watts string is per-foot or per-reel — never a fixture total).
    case when r.per_ft then null else r.lumens_num end as variant_lumens,
    case when r.per_ft then null else r.watts_num end as variant_watts,
    case when r.per_ft then r.watts_num end as watts_per_ft,
    case
      when not r.per_ft and r.watts_num > 0 and r.lumens_num is not null
        then round(r.lumens_num / r.watts_num, 1)
    end as eff_row,
    ies.lumens as ies_lumens,
    ies.efficacy as ies_efficacy
  from (
    select
      p.sku,
      p.name,
      p.brand,
      p.category,
      case
        when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* '\y(tape|strip)\y|extrusion' then 'per-foot'
        when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* '\yfans?\y' then 'fan'
        when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'downlight|recessed' then 'downlight'
        when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'track|monopoint' then 'track'
        when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'flood|wall ?pack|area light|landscape' then 'outdoor'
        when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* '\y(bath|vanity|vanities|sconces?)\y|wall[- ]?(mount(ed)?|light|lamp|wash)' then 'wall'
        when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* '\y(flush|semi[- ]?flush)\y|ceiling' then 'ceiling'
        when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'linear|suspended' then 'linear'
        when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'chandelier|pendant|multi[- ]?light' then 'decorative'
        else 'other'
      end as class,
      coalesce(p.is_accessory, false) as is_accessory,
      v.ord as variant_ord,
      nullif(btrim(coalesce(v.val ->> 'sku', '')), '') as variant_sku,
      nullif(btrim(coalesce(v.val ->> 'finish', '')), '') as finish,
      case when (v.val -> 'dimensions_mm' ->> 'width') ~ '^\d+(\.\d+)?$'
           then (v.val -> 'dimensions_mm' ->> 'width')::numeric end as width_mm,
      case when (v.val -> 'dimensions_mm' ->> 'height') ~ '^\d+(\.\d+)?$'
           then (v.val -> 'dimensions_mm' ->> 'height')::numeric end as height_mm,
      case when (v.val -> 'dimensions_mm' ->> 'length') ~ '^\d+(\.\d+)?$'
           then (v.val -> 'dimensions_mm' ->> 'length')::numeric end as length_mm,
      case when (v.val -> 'dimensions_mm' ->> 'diameter') ~ '^\d+(\.\d+)?$'
           then (v.val -> 'dimensions_mm' ->> 'diameter')::numeric end as diameter_mm,
      case when (v.val -> 'aux_lengths_mm' ->> 'wire') ~ '^\d+(\.\d+)?$'
           then (v.val -> 'aux_lengths_mm' ->> 'wire')::numeric end as wire_length_mm,
      coalesce((v.val ->> 'watts') ~* '/ft|per foot', false)
        or coalesce((v.val ->> 'lumens') ~* '/ft|per foot', false) as per_ft,
      public.product_spec_parse_num(v.val ->> 'watts') as watts_num,
      public.product_spec_parse_num(v.val ->> 'lumens') as lumens_num,
      v.val ->> 'cct_desc' as cct_desc,
      public.product_spec_parse_num(v.val ->> 'cri')::int as cri,
      public.product_spec_parse_ip(v.val ->> 'ip_rating') as ip
    from public.products p
    left join lateral jsonb_array_elements(
      case when jsonb_typeof(p.variants) = 'array' then p.variants else '[]'::jsonb end
    ) with ordinality as v(val, ord) on true
  ) r
  left join lateral (
    -- Representative PUBLIC-scoped IES metrics for the SKU. [MAT-2]: the
    -- refresh runs as the matview owner (RLS bypassed), so 0048's anon scope
    -- gate is reproduced literally — internal-scoped links MUST NOT be
    -- materialized (see the security note in the header).
    select
      case when (im.metrics ->> 'lumens') ~ '^\d+(\.\d+)?$'
           then round((im.metrics ->> 'lumens')::numeric, 0) end as lumens,
      case when (im.metrics ->> 'efficacy') ~ '^\d+(\.\d+)?$'
           then round((im.metrics ->> 'efficacy')::numeric, 1) end as efficacy
    from public.product_photometrics pp
    join public.ies_metrics im on im.id = pp.ies_metrics_id
    where pp.product_sku = r.sku
      and pp.is_representative
      and pp.scope = 'public'
    limit 1
  ) ies on true
) b
cross join lateral public.product_spec_parse_cct(b.cct_desc) cct
cross join lateral public.product_spec_parse_dims(
  b.width_mm, b.height_mm, b.length_mm, b.diameter_mm, b.class, b.per_ft
) d
window w as (partition by b.sku)
with data;

-- Anon-safe by construction (header audit), so the 0063 view grants carry over.
grant select on public.product_variant_spec_mat to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Indexes.
--    * The UNIQUE plain-column index is what legalizes
--      `refresh materialized view concurrently` (docs: at least one unique
--      index using only column names, covering all rows).
--    * The predicate btrees mirror the RPC's WHERE/scope columns. At ~37k
--      rows a seq scan is already milliseconds — these are belt-and-braces
--      for the scope filters and any future direct PostgREST reads; the real
--      win of this migration is not recomputing the jsonb expansion + regex
--      parsers per query.
-- -----------------------------------------------------------------------------
create unique index product_variant_spec_mat_sku_variant_key
  on public.product_variant_spec_mat (sku, variant_key);

create index product_variant_spec_mat_class     on public.product_variant_spec_mat (class);
create index product_variant_spec_mat_brand     on public.product_variant_spec_mat (brand);
create index product_variant_spec_mat_category  on public.product_variant_spec_mat (category);
create index product_variant_spec_mat_width_in  on public.product_variant_spec_mat (width_in);
create index product_variant_spec_mat_depth_in  on public.product_variant_spec_mat (depth_in);
create index product_variant_spec_mat_height_in on public.product_variant_spec_mat (height_in);
create index product_variant_spec_mat_v_lumens  on public.product_variant_spec_mat (variant_lumens);
create index product_variant_spec_mat_lumens    on public.product_variant_spec_mat (lumens_max);
create index product_variant_spec_mat_v_watts   on public.product_variant_spec_mat (variant_watts);
create index product_variant_spec_mat_watts     on public.product_variant_spec_mat (watts_max);
create index product_variant_spec_mat_cri       on public.product_variant_spec_mat (cri);
create index product_variant_spec_mat_ip        on public.product_variant_spec_mat (ip);
create index product_variant_spec_mat_per_ft    on public.product_variant_spec_mat (per_ft);

-- -----------------------------------------------------------------------------
-- 3a. product_spec_view — rebuilt on the matview (same output columns, names,
--     order, grants as 0063; product_spec_rank keeps working unchanged and
--     now rides the materialization). security_invoker is kept so access is
--     checked against the CALLER's matview grant, not the view owner's.
-- -----------------------------------------------------------------------------
drop view if exists public.product_spec_view;
create view public.product_spec_view
with (security_invoker = on) as
select distinct
  v.sku,
  v.name,
  v.brand,
  v.category,
  v.class,
  v.is_accessory,
  v.lumens_max,
  v.lumens_min,
  v.lumens_source,
  v.watts_max,
  v.watts_min,
  v.watts_per_ft_max,
  v.per_ft_any as per_ft,
  v.efficacy,
  v.variant_count
from public.product_variant_spec_mat v;

grant select on public.product_spec_view to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3b. product_spec_filter — recreated on the matview. Signature, return shape,
--     predicate semantics, ordering, counts: IDENTICAL to 0063 (see that
--     header for the full spec); the ONLY change is the scope CTE's FROM.
--     `create or replace` keeps the existing anon/authenticated EXECUTE
--     grants; they are re-stated below anyway for self-containedness.
-- -----------------------------------------------------------------------------
create or replace function public.product_spec_filter(
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
  p_query_embedding vector(1024) default null,
  p_query_text text default null,
  p_match_count int default 10
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
    -- regardless of data availability (in_scope_total's denominator).
    -- 0064: reads the MATERIALIZED base — anon-safe by construction; the
    -- products join below (embedding) still runs as the invoker under 0052.
    select v.*
    from public.product_variant_spec_mat v
    where not v.is_accessory
      and (p_brand is null or v.brand = p_brand)
      and (p_category is null or v.category = p_category)
      and (p_class is null or v.class = p_class)
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
  text, text, text,
  vector, text, int
) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. refresh_product_spec_mat — SECURITY DEFINER (the matview owner refreshes;
--    callers only need EXECUTE), pinned search_path, service_role ONLY. The
--    product sync (apps/api/src/saleslayer.ts) invokes it after every
--    successful catalog sync, best-effort. CONCURRENTLY keeps anon reads
--    unblocked mid-refresh (backed by the unique index in §2).
-- -----------------------------------------------------------------------------
create or replace function public.refresh_product_spec_mat()
returns void
language sql
security definer
set search_path = public
as 'refresh materialized view concurrently public.product_variant_spec_mat';

revoke all on function public.refresh_product_spec_mat() from public;
revoke all on function public.refresh_product_spec_mat() from anon, authenticated;
grant execute on function public.refresh_product_spec_mat() to service_role;
