-- =============================================================================
-- Thom Bot — spec view + rank-by-spec RPC (lighting-expert plan, Prong A)
--
-- Thom answered "what's the highest lumen light" by crowning a 1,033 lm track
-- head, because lumens/watts are STRINGS inside products.variants jsonb and no
-- tool could sort or filter by a number. This migration gives the catalog a
-- numeric spec surface:
--
--  1. product_spec_view — one row per SKU with conservatively-parsed numeric
--     spec aggregates (lumens/watts/efficacy, per-foot watts) merged from the
--     Sales Layer variant strings and the representative IES metrics, plus a
--     coarse `class` bucket for class-grouped ranking.
--  2. product_spec_rank(...) — the rank RPC behind the rank_products_by_spec
--     tool: metric-whitelisted, accessory-excluded, class-grouped top-3 or a
--     flat top-N, with windowed in-scope counts so the tool can state an
--     HONEST coverage denominator (only ~57% of products carry output data).
--  3. InitPlan rewrites of the pre-0055 policies this view walks
--     (products_select from 0008, product_photometrics_select from 0048) —
--     same statement-timeout diagnosis 0055 fixed for the 0043 tables.
--  4. A partial unique index on kb_documents(content_hash) backing the
--     admin-upload duplicate check (Prong C, race-free 409).
--
-- SECURITY — `security_invoker = on` IS THE LOAD-BEARING PROPERTY. A default
-- view runs as its OWNER (postgres, which bypasses RLS) and would leak
-- internal-scoped product_photometrics rows (0048's scope gate) into anon rank
-- results. With invoker semantics the view's photometrics join runs as the
-- caller: anon sees only scope='public' links and the 0052-whitelisted
-- products columns; internal users legitimately see more. Anon and internal
-- ranks may therefore DIFFER — that is correct and documented (plan A13/R16b).
--
-- PARSING RULES (deliberately conservative — plan A6/A8/R5a/R5b/R5c):
--  * De-comma ONLY thousands-separator shapes `^\d{1,3}(,\d{3})+$` ("1,033").
--    Any other comma-bearing string (multi-value "1500,2000", "12W,14W,16W")
--    is UNPARSEABLE — never de-comma'd into "15002000".
--  * Otherwise accept `^\d+(\.\d+)?$` after trimming one trailing lm/w unit
--    token, case-insensitive ("450 LM", "12W", "9.5 w").
--  * Everything else — "#N/A", ranges "10-15W", prose — parses to NULL.
--  * per_ft = the variant's watts or lumens string matches /\/ft|per foot/i.
--    Per-foot rows contribute watts_per_ft_max ONLY: their lumens are
--    EXCLUDED from lumens_max/lumens_min (nothing marks per-foot vs per-reel
--    lumens, so per-foot lumens ranking is deferred until the G.1 tape-SKU
--    semantics check — plan R5b).
--  * Efficacy is computed PER VARIANT, only where the SAME variant supplies
--    both parsed watts and lumens; never cross-variant division, and never
--    for per-foot rows (plan A8/R5a). IES efficacy is preferred when present.
--  * lumens_max = GREATEST(Sales Layer max, representative IES lumens), with
--    `lumens_source` recording which won ('ies' / 'sales_layer'). "IES always
--    wins" was rejected: the representative file is one optic, often not the
--    max-output variant (plan R5c).
--
-- CLASS BUCKETS (CASE/regex over name+category, first match wins — the order
-- below is deliberate and documented; G.1 eyeballs the distribution):
--   per-foot   tape | strip | extrusion            (per-foot accent product)
--   fan        \yfans?\y                           (ceiling/smart fans)
--   downlight  downlight | recessed
--   track      track | monopoint
--   outdoor    flood | wall ?pack | area light | landscape
--   linear     linear | suspended
--   decorative chandelier | pendant | multi-light  (large DECORATIVE totals,
--                                                   not "high output")
--   other      everything else
-- per-foot is first so outdoor/landscape tape stays per-foot; downlight
-- before track so recessed products don't fall through; a TS mirror of this
-- regex was considered and rejected for v1 (drift risk > test value — R4).
--
-- -----------------------------------------------------------------------------
-- VERIFY AS ANON (anon key, no JWT — e.g. apps/api/src/thom/anonBoundary.test.ts):
--   [PASS] select * from product_spec_view limit 5                    -> rows
--   [PASS] rpc product_spec_rank(metric:'lumens')                     -> rows,
--          grouped top-3 per class, in_scope_ranked <= in_scope_total
--   [PASS] rpc product_spec_rank(metric:'watts', per_ft_filter:true)  -> rows
--   [DENY] internal-scoped product_photometrics rows must NOT contribute to
--          anon rank results: for a SKU whose ONLY photometrics link has
--          scope='internal', anon's product_spec_view row must show
--          lumens_source <> 'ies' (or null) while an internal user's row may
--          show 'ies' — anon/internal rank divergence here is CORRECT.
--   [DENY] rpc product_spec_rank(metric:'sku')      -> raises (whitelist)
--   [DENY] select raw_json from products            -> permission denied (0052)
-- Also run `explain analyze select * from product_spec_rank('lumens')` AS ANON
-- and confirm the products/product_photometrics policy predicates show as an
-- InitPlan (evaluated once), not a per-row Filter — that is what section 3
-- below buys, on the same diagnosed path 0055 fixed.
--
-- G.1 counting SQL (run before enabling THOM_SPEC_RANK): parse coverage by
-- lumens_source, per_ft counts, class distribution + top-5 per class by eye,
-- and the A6 literal cases ("1,033" -> 1033; "1500,2000" -> null; "#N/A" ->
-- null; "12W/ft" -> per_ft watts 12).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Conservative numeric parser for Sales Layer spec strings.
--
-- Steps: trim; strip one trailing per-foot token (/ft, per foot); strip one
-- trailing unit token (lm, w); then EITHER a thousands-separator shape
-- (de-comma'd) OR a plain number. Anything else — multi-value lists, ranges,
-- "#N/A", prose — is null. IMMUTABLE + pure SQL so the planner can inline it.
-- -----------------------------------------------------------------------------
create or replace function public.product_spec_parse_num(raw text)
returns numeric
language sql
immutable
as $$
  with s1 as (
    select regexp_replace(btrim(coalesce(raw, '')), '\s*(/\s*ft|per\s+foot)\s*$', '', 'i') as s
  ),
  s2 as (
    select regexp_replace(s, '\s*(lm|w)\s*$', '', 'i') as s from s1
  )
  select case
    when s ~ '^\d{1,3}(,\d{3})+$' then replace(s, ',', '')::numeric
    when s ~ '^\d+(\.\d+)?$' then s::numeric
    else null
  end
  from s2
$$;

-- -----------------------------------------------------------------------------
-- 1. product_spec_view — one row per SKU.
--
-- security_invoker = on: the photometrics lateral runs as the CALLER, so the
-- 0048 scope RLS applies (anon never sees internal-scoped IES data) and the
-- 0052 column whitelist caps what anon can read from products. See header.
-- -----------------------------------------------------------------------------
create or replace view public.product_spec_view
with (security_invoker = on) as
select
  p.sku,
  p.name,
  p.brand,
  p.category,
  case
    when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'tape|strip|extrusion' then 'per-foot'
    when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* '\yfans?\y' then 'fan'
    when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'downlight|recessed' then 'downlight'
    when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'track|monopoint' then 'track'
    when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'flood|wall ?pack|area light|landscape' then 'outdoor'
    when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'linear|suspended' then 'linear'
    when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'chandelier|pendant|multi[- ]?light' then 'decorative'
    else 'other'
  end as class,
  coalesce(p.is_accessory, false) as is_accessory,
  -- GREATEST ignores nulls: SL-max vs representative-IES lumens, best wins.
  greatest(sl.lumens_max, ies.lumens) as lumens_max,
  sl.lumens_min,
  case
    when sl.lumens_max is null and ies.lumens is null then null
    when ies.lumens is not null and (sl.lumens_max is null or ies.lumens >= sl.lumens_max) then 'ies'
    else 'sales_layer'
  end as lumens_source,
  sl.watts_max,
  sl.watts_min,
  sl.watts_per_ft_max,
  coalesce(sl.per_ft, false) as per_ft,
  -- Never an efficacy for per-foot rows (R5a); IES preferred over the
  -- per-variant Sales Layer figure.
  case when coalesce(sl.per_ft, false) then null else coalesce(ies.efficacy, sl.efficacy_max) end as efficacy,
  coalesce(sl.variant_count, 0) as variant_count
from public.products p
left join lateral (
  select
    max(x.lumens_num) filter (where not x.per_ft) as lumens_max,
    min(x.lumens_num) filter (where not x.per_ft) as lumens_min,
    max(x.watts_num) filter (where not x.per_ft) as watts_max,
    min(x.watts_num) filter (where not x.per_ft) as watts_min,
    max(x.watts_num) filter (where x.per_ft) as watts_per_ft_max,
    bool_or(x.per_ft) as per_ft,
    -- Per-variant efficacy: only where ONE variant supplies both numbers.
    max(case
      when not x.per_ft and x.watts_num > 0 and x.lumens_num is not null
      then round(x.lumens_num / x.watts_num, 1)
    end) as efficacy_max,
    count(*) as variant_count
  from (
    select
      coalesce((v ->> 'watts') ~* '/ft|per foot', false)
        or coalesce((v ->> 'lumens') ~* '/ft|per foot', false) as per_ft,
      public.product_spec_parse_num(v ->> 'watts') as watts_num,
      public.product_spec_parse_num(v ->> 'lumens') as lumens_num
    from jsonb_array_elements(
      case when jsonb_typeof(p.variants) = 'array' then p.variants else '[]'::jsonb end
    ) as v
  ) x
) sl on true
left join lateral (
  -- Representative IES metrics for the SKU. Guarded casts: a malformed
  -- metrics value must yield null, never break the whole view.
  select
    case when (im.metrics ->> 'lumens') ~ '^\d+(\.\d+)?$'
         then round((im.metrics ->> 'lumens')::numeric, 0) end as lumens,
    case when (im.metrics ->> 'efficacy') ~ '^\d+(\.\d+)?$'
         then round((im.metrics ->> 'efficacy')::numeric, 1) end as efficacy
  from public.product_photometrics pp
  join public.ies_metrics im on im.id = pp.ies_metrics_id
  where pp.product_sku = p.sku
    and pp.is_representative
  limit 1
) ies on true;

grant select on public.product_spec_view to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. product_spec_rank — the rank RPC.
--
-- SECURITY INVOKER (RLS + the invoker view apply to the caller), pinned
-- search_path, metric/dir whitelists. Excludes accessories; only rows where
-- the requested metric is non-null rank (A7). grouped=true returns the top-3
-- per class (so a 40-light chandelier can never crowd out the flood/wallpack
-- classes — R4); grouped=false is a flat top-N keeping the class column.
-- per_ft_filter=true ranks per-foot (tape/strip) products by watts/ft only.
--
-- Every row carries the WINDOWED coverage counts (A9/R14):
--   in_scope_ranked — products in the filter scope WITH the metric present;
--   in_scope_total  — products in the filter scope regardless of metric
--                     availability.
-- so the tool can state the honest denominator ("ranked among N of M ...").
-- -----------------------------------------------------------------------------
create or replace function public.product_spec_rank(
  metric text,
  dir text default 'desc',
  brand_filter text default null,
  category_filter text default null,
  class_filter text default null,
  per_ft_filter boolean default false,
  grouped boolean default true,
  match_count int default 10
)
returns table (
  sku text,
  name text,
  brand text,
  category text,
  class text,
  metric_value numeric,
  lumens_source text,
  per_ft boolean,
  class_rank int,
  in_scope_ranked bigint,
  in_scope_total bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  -- Input validation: whitelists (the metric picks a column — never allow
  -- arbitrary text anywhere near the query) and a clamped row cap.
  if metric not in ('lumens', 'watts', 'efficacy') then
    raise exception 'product_spec_rank: metric must be one of lumens, watts, efficacy';
  end if;
  if dir not in ('asc', 'desc') then
    raise exception 'product_spec_rank: dir must be asc or desc';
  end if;
  match_count := least(greatest(coalesce(match_count, 10), 1), 25);

  return query
  with scope as (
    -- The FILTER scope: non-accessory products matching the filters,
    -- regardless of metric availability (in_scope_total's denominator).
    -- per_ft_filter=true narrows to per-foot rows and ranks watts/ft.
    select
      v.sku, v.name, v.brand, v.category, v.class, v.lumens_source, v.per_ft,
      case
        when per_ft_filter then v.watts_per_ft_max
        when metric = 'lumens' then v.lumens_max
        when metric = 'watts' then v.watts_max
        else v.efficacy
      end as metric_value
    from public.product_spec_view v
    where not v.is_accessory
      and (brand_filter is null or v.brand = brand_filter)
      and (category_filter is null or v.category = category_filter)
      and (class_filter is null or v.class = class_filter)
      and (not per_ft_filter or v.per_ft)
  ),
  counts as (
    select
      count(*) filter (where s.metric_value is not null) as ranked_n,
      count(*) as total_n
    from scope s
  ),
  ranked as (
    select
      s.*,
      row_number() over (
        partition by (case when grouped then s.class end)
        order by
          case when dir = 'desc' then s.metric_value end desc nulls last,
          case when dir = 'asc' then s.metric_value end asc nulls last,
          s.sku
      )::int as rnk
    from scope s
    where s.metric_value is not null
  )
  select
    r.sku, r.name, r.brand, r.category, r.class,
    r.metric_value, r.lumens_source, r.per_ft, r.rnk,
    c.ranked_n, c.total_n
  from ranked r
  cross join counts c
  where r.rnk <= case when grouped then 3 else match_count end
  order by
    case when grouped then r.class end,
    r.rnk;
end;
$$;

grant execute on function
  public.product_spec_rank(text, text, text, text, text, boolean, boolean, int)
  to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. InitPlan rewrites for the pre-0055 policies this view walks (plan A4).
--
-- 0055 fixed only the 0043 tables; the spec view's anon scans hit the SAME
-- diagnosed path through products (0008's bare is_active()) and
-- product_photometrics (0048's bare is_active_internal_or_admin()). Wrapping
-- the function in a scalar sub-select makes it an InitPlan evaluated ONCE per
-- statement instead of per row; semantics are identical (the functions read
-- only auth state, constant within a statement).
--
-- ies_metrics_select (0048) is `using (true)` — no per-row function call, so
-- it is deliberately NOT touched.
-- -----------------------------------------------------------------------------
drop policy if exists products_select on public.products;
create policy products_select on public.products
  for select using ((select public.is_active()));

drop policy if exists product_photometrics_select on public.product_photometrics;
create policy product_photometrics_select on public.product_photometrics
  for select using (
    scope = 'public' or (select public.is_active_internal_or_admin())
  );

-- -----------------------------------------------------------------------------
-- 4. Admin-upload dedup index (plan A12 — backs Prong C's duplicate 409).
--
-- Partial UNIQUE on content_hash for admin uploads that aren't superseded:
-- covers 'pending_extract' too, so the duplicate check is race-free at insert
-- time (an insert-conflict, not a read-then-write). Scoped to
-- source_system='admin_upload' so the existing pipelines (sales_layer,
-- zendesk, web_crawl, app), which may legitimately share hashes across
-- external_ids, are untouched.
-- -----------------------------------------------------------------------------
create unique index if not exists kb_documents_admin_upload_hash_uniq
  on public.kb_documents (content_hash)
  where source_system = 'admin_upload' and status <> 'superseded';
