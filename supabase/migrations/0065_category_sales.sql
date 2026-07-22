-- =============================================================================
-- Thom Bot — category sales rollups (docs/thom-category-sales-plan.md, v2
-- RECONCILED, ratified; CS1–CS17 ledger resolutions encoded below).
--
-- MIGRATION NUMBER: the plan reserved 0064, but 0064 was taken by an in-flight
-- spec-view materialization fix while this build was underway — this migration
-- ships as 0065 (same CS13 numbering discipline: re-check `ls
-- supabase/migrations` AND applied-state in the dashboard before applying).
--
-- What this migration does:
--   1. CS1 — rewrites the three bare per-row select policies (turnover_orders
--      0038:55, open_orders 0025:60, data_ingestions 0019:76) into the 0055
--      InitPlan form. Same names, same semantics, zero caller-visible change.
--   2. CS8 — adds the load-bearing (billing_date, brand) index on
--      turnover_orders. billing_date LEADS, pinned: a brand-leading index
--      cannot serve the common unfiltered window scan.
--   3. A.1 — product_variant_map: variant SKU -> parent product resolution
--      (materials are variant SKUs, essentially never the parent PPID).
--   4. A.2 — thom_line_value(): IMMUTABLE SQL mirror of lineValue()
--      (apps/turnover-sync/src/hubspot.ts) with the groupOrders.test.ts parity
--      literals asserted below (TS<->SQL parity, CS15/§E.3).
--   5. A.3 — thom_sales_by_category() rollup RPC (planes invoiced + backlog;
--      pipeline raises until stage 2) and thom_sales_freshness().
--   6. A.6 — SECURITY INVOKER everywhere; grants to authenticated ONLY (and
--      explicit revokes from anon/public — a view has its own ACL, 0059's
--      lesson). The real wall is RLS: internal Thom queries run as the USER.
--
-- G.1 GATE (run at apply time, flag still OFF — record counts and rates ONLY,
-- never dollar figures; the repo is public, CS15). The exact queries are in the
-- verify block at the end of this file. Record results here:
--   [ ] coverage by brand by year (lines + value %):        (pending G.1)
--   [ ] disagreeing-parent collision share of window value:  (pending G.1 —
--       CS16: distinct-on survives ONLY below 0.1%; at/above, route collisions
--       to (unclassified) instead)
--   [ ] non-USD line/value share:                            (pending G.1)
--   [ ] explain analyze YTD rollup AS AUTHENTICATED JWT:     (pending G.1 —
--       must show turnover_orders_billing_brand_idx + the InitPlan hoist on
--       all three rewritten policies; service role proves nothing, CS1)
--   [ ] RLS probe as a non-internal user -> zero rows:       (pending G.1)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. CS1 — RLS InitPlan rewrites. Bare per-row is_active_internal_or_admin()
-- calls re-evaluate the function per row on a 339k-row YTD scan; wrapping it in
-- a scalar sub-select hoists it into an InitPlan evaluated once per statement
-- (the 0055 form). Same policy names, same semantics.
-- -----------------------------------------------------------------------------

drop policy if exists turnover_orders_select on public.turnover_orders;
create policy turnover_orders_select on public.turnover_orders
  for select using ((select public.is_active_internal_or_admin()));

drop policy if exists open_orders_select on public.open_orders;
create policy open_orders_select on public.open_orders
  for select using ((select public.is_active_internal_or_admin()));

drop policy if exists data_ingestions_select on public.data_ingestions;
create policy data_ingestions_select on public.data_ingestions
  for select using ((select public.is_active_internal_or_admin()));

-- -----------------------------------------------------------------------------
-- 2. CS8 — the window-scan index. billing_date LEADS (pinned): date-leading
-- serves BOTH the unfiltered window scan ("sales of downlights this month"
-- spans both files) and the brand-filtered one (brand as an index filter
-- suffix); brand-leading cannot serve the unfiltered range scan without a
-- skip-scan Postgres doesn't do. The audit's eq.billing_date probes timed out
-- on prod without any date index. (0025 already indexes open_orders.is_open —
-- adequate for the 7.7k-row backlog snapshot.)
-- -----------------------------------------------------------------------------

create index if not exists turnover_orders_billing_brand_idx
  on public.turnover_orders (billing_date, brand);

-- -----------------------------------------------------------------------------
-- 3. A.1 — variant -> product resolution map. One row per variant SKU expanded
-- from products.variants (~75k rows over ~4.4k products — a plain view
-- hash-joins fine; NO materialization in v1, G.1 re-checks with explain
-- analyze). Parent PPIDs are ALSO emitted as rows so the rare direct-PPID
-- material still resolves. Keys normalize through upper(btrim(..)) — the
-- normalizeSkuKey convention (packages/shared/src/accessories/parse.ts); both
-- sides of every lookup normalize identically.
--
-- CS16 collision rule: duplicate variant keys break deterministically via
-- `distinct on (variant_key) ... order by variant_key, product_sku`. This
-- survives ONLY if G.1 measures disagreeing-parent collisions (same key,
-- parents differing in brand/category/family/class) at < 0.1% of window value;
-- at or above the threshold, exclude colliding keys from resolution so they
-- route to (unclassified) — an honest bucket beats a deterministic-but-
-- arbitrary attribution. The threshold is encoded in the G.1 gate query below.
-- -----------------------------------------------------------------------------

drop view if exists public.product_variant_map;
create view public.product_variant_map
with (security_invoker = on) as
select distinct on (variant_key)
  variant_key,
  product_sku,
  brand,
  category,
  family,
  is_accessory
from (
  -- Variant SKUs.
  select
    upper(btrim(v.val ->> 'sku')) as variant_key,
    p.sku as product_sku,
    p.brand,
    p.category,
    p.family,
    coalesce(p.is_accessory, false) as is_accessory
  from public.products p
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(p.variants) = 'array' then p.variants else '[]'::jsonb end
  ) as v(val)
  where nullif(btrim(coalesce(v.val ->> 'sku', '')), '') is not null
  union all
  -- Parent PPIDs as their own rows (rare direct-PPID materials).
  select
    upper(btrim(p.sku)),
    p.sku,
    p.brand,
    p.category,
    p.family,
    coalesce(p.is_accessory, false)
  from public.products p
  where nullif(btrim(coalesce(p.sku, '')), '') is not null
) expanded
order by variant_key, product_sku;

revoke all on public.product_variant_map from public, anon;
grant select on public.product_variant_map to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. A.2 — value semantics: the SQL mirror of lineValue()
-- (apps/turnover-sync/src/hubspot.ts:408 — `discounted_sales` unless 0, else
-- `ytd_total`; channel-dependent, confirmed to the cent against Power BI
-- 2026-07-09). The groupOrders.test.ts literals are asserted in the verify
-- block; a comment beside lineValue() points back here so neither side drifts
-- alone (§E.3).
-- -----------------------------------------------------------------------------

create or replace function public.thom_line_value(ds numeric, ytd numeric)
returns numeric
language sql
immutable
as $$
  select case when coalesce(ds, 0) <> 0 then ds else coalesce(ytd, 0) end
$$;

revoke all on function public.thom_line_value(numeric, numeric) from public, anon;
grant execute on function public.thom_line_value(numeric, numeric) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Catalog-brand label map (CS3): normalizes Sales Layer brand codes to display
-- names so `p_catalog_brand` filters (and group_by='brand' keys) speak the
-- names users use. Values already in display form pass through unchanged.
-- G.1 enumerates `select distinct brand from products` and extends this map
-- before the flag flips (the plan's "exact map enumerated at build" step —
-- recorded here as codes-seen-only, per the repo-public rule).
-- -----------------------------------------------------------------------------

create or replace function public.thom_catalog_brand_label(p_brand text)
returns text
language sql
immutable
as $$
  select case upper(btrim(coalesce(p_brand, '')))
    when '' then null
    when 'WAC' then 'WAC Lighting'
    when 'WAC LIGHTING' then 'WAC Lighting'
    when 'WAC ARCHITECTURAL' then 'WAC Architectural'
    when 'MOF' then 'Modern Forms'
    when 'MFF' then 'Modern Forms'
    when 'MODERN FORMS' then 'Modern Forms'
    when 'SBK' then 'Schonbek'
    when 'SCHONBEK' then 'Schonbek'
    when 'SIGNATURE' then 'Schonbek Signature'
    when 'SCHONBEK SIGNATURE' then 'Schonbek Signature'
    when 'BEYOND' then 'Schonbek Beyond'
    when 'SCHONBEK BEYOND' then 'Schonbek Beyond'
    when 'FOREVER' then 'Schonbek Forever'
    when 'SCHONBEK FOREVER' then 'Schonbek Forever'
    when 'AISPIRE' then 'aiSpire'
    else btrim(p_brand)
  end
$$;

revoke all on function public.thom_catalog_brand_label(text) from public, anon;
grant execute on function public.thom_catalog_brand_label(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. A.3 — the rollup RPC. SECURITY INVOKER (the DB itself enforces
-- internal/admin through the rewritten RLS policies — posture ratified, CS1),
-- pinned search_path, p_-prefixed args (the 0063 ambiguity lesson), group_by
-- whitelisted, p_top_n clamped (default 10, cap 25).
--
-- TWO brand parameters, never one (CS3):
--   p_file_brand    — 'WAC' | 'SCH': turnover_orders.brand, i.e. which SAP
--                     turnover FILE the line came from (data provenance).
--   p_catalog_brand — the RESOLVED catalog brand (display name via
--                     thom_catalog_brand_label), filtered post-join.
--
-- Planes:
--   invoiced — turnover_orders in [p_date_from, p_date_to]; USD only (CS2:
--              non-USD share returned, never converted — no FX rates exist);
--              qty <> 0 (the groupOrders() split-credit dedup rule, verified
--              live on 24 sampled pairs); value via thom_line_value().
--   backlog  — open_orders where is_open. Snapshot: date args raise (a
--              BACKSTOP — the TS layer translates, CS17). No p_file_brand:
--              business_unit is prod-verified product-line codes with zero SCH
--              values -> the backlog is WAC-family only (CS4); the tool says
--              so in every answer.
--   pipeline — stage 2 (deal_quote_lines mirror); raises until it ships.
--
-- Returns ONE jsonb document (groups + window-wide denominators + non-USD
-- share + per-year coverage) rather than a row set: the CS7 denominators must
-- travel with EVERY response and cannot be dropped per-row by a partial read —
-- a single document makes the omission impossible for the tool to express.
-- Coverage denominators are WINDOW-WIDE: computed after p_file_brand but
-- BEFORE any category/class/family/catalog-brand filter, so a class-filtered
-- answer still shows what share of the whole window resolved. Windows crossing
-- a calendar-year boundary get a per-year coverage breakdown (coverage swings
-- ~96% -> ~57% of value across years in the audit samples).
--
-- Negative lines (returns/credits) stay in: outputs are NET.
-- Units split per CS10: units_each (each-goods) vs units_ft (per-foot classes,
-- printed as feet or suppressed — never bare "units" alongside each-goods).
-- order_count is per-group and NOT additive across rows (CS11).
-- Unresolved materials land in the (unclassified) bucket (A.5) — returned
-- first-class (null when an attribute filter is active; coverage still
-- reports the unresolved share window-wide either way).
-- -----------------------------------------------------------------------------

create or replace function public.thom_sales_by_category(
  p_plane text default 'invoiced',
  p_date_from date default null,
  p_date_to date default null,
  p_group_by text default 'category',
  p_file_brand text default null,
  p_catalog_brand text default null,
  p_class text default null,
  p_category text default null,
  p_family text default null,
  p_top_n int default 10
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_top int := least(greatest(coalesce(p_top_n, 10), 1), 25);
  v_filtered boolean := (p_catalog_brand is not null or p_class is not null
                         or p_category is not null or p_family is not null);
  v_result jsonb;
begin
  if p_plane is null or p_plane not in ('invoiced', 'backlog', 'pipeline') then
    raise exception 'thom_sales_by_category: unknown plane %', coalesce(p_plane, '(null)');
  end if;
  if p_plane = 'pipeline' then
    raise exception 'thom_sales_by_category: plane pipeline is not yet available (stage 2 — the deal_quote_lines mirror)';
  end if;
  if p_group_by is null or p_group_by not in ('category', 'class', 'family', 'brand', 'product') then
    raise exception 'thom_sales_by_category: unknown group_by %', coalesce(p_group_by, '(null)');
  end if;
  if p_file_brand is not null and p_file_brand not in ('WAC', 'SCH') then
    raise exception 'thom_sales_by_category: p_file_brand must be WAC or SCH (SAP file provenance)';
  end if;
  if p_class is not null and p_class not in
    ('per-foot', 'fan', 'downlight', 'track', 'outdoor', 'wall', 'ceiling', 'linear', 'decorative', 'other')
  then
    raise exception 'thom_sales_by_category: unknown class %', p_class;
  end if;

  if p_plane = 'backlog' then
    -- CS17 backstop: the TS layer silently DROPS window args for backlog and
    -- explains explicitly-dated requests in plain English; this raise should
    -- never fire in practice.
    if p_date_from is not null or p_date_to is not null then
      raise exception 'thom_sales_by_category: backlog is a point-in-time snapshot — it has no date dimension';
    end if;
    -- CS4: open_orders has no brand column; business_unit is product-line
    -- codes with zero SCH values. The backlog is WAC-family only.
    if p_file_brand is not null then
      raise exception 'thom_sales_by_category: backlog has no file brand — it covers WAC-family orders only';
    end if;

    with base as materialized (
      select
        o.so,
        upper(btrim(coalesce(o.material, ''))) as mkey,
        coalesce(o.order_qty, 0) as quantity,
        coalesce(o.line_net_value, 0) as line_value
      from public.open_orders o
      where o.is_open
    ),
    joined as materialized (
      select
        b.*,
        m.product_sku,
        m.category,
        m.family,
        public.thom_catalog_brand_label(m.brand) as catalog_brand,
        s.class,
        s.name,
        coalesce(s.per_ft, false) as per_ft
      from base b
      left join public.product_variant_map m on m.variant_key = b.mkey
      left join public.product_spec_view s on s.sku = m.product_sku
    ),
    filtered as (
      select * from joined
      where product_sku is not null
        and (p_catalog_brand is null or lower(catalog_brand) = lower(p_catalog_brand))
        and (p_class is null or class = p_class)
        and (p_category is null or lower(category) = lower(p_category))
        and (p_family is null or lower(family) = lower(p_family))
    ),
    grouped as (
      select
        case p_group_by
          when 'category' then coalesce(category, '(none)')
          when 'class' then coalesce(class, '(none)')
          when 'family' then coalesce(family, '(none)')
          when 'brand' then coalesce(catalog_brand, '(none)')
          else product_sku
        end as group_key,
        max(case when p_group_by = 'product' then name end) as group_label,
        sum(line_value) as net_value,
        sum(quantity) filter (where not per_ft) as units_each,
        sum(quantity) filter (where per_ft) as units_ft,
        count(*) as line_count,
        count(distinct so) as order_count
      from filtered
      group by 1
    )
    select jsonb_build_object(
      'plane', 'backlog',
      'group_by', p_group_by,
      'groups', coalesce((
        select jsonb_agg(g order by g.net_value desc)
        from (select * from grouped order by net_value desc nulls last limit v_top) g
      ), '[]'::jsonb),
      'group_count_total', (select count(*) from grouped),
      'unclassified', case when v_filtered then null else (
        select jsonb_build_object(
          'net_value', coalesce(sum(line_value), 0),
          'units', coalesce(sum(quantity), 0),
          'line_count', count(*),
          'order_count', count(distinct so))
        from joined where product_sku is null
      ) end,
      'coverage', (
        select jsonb_build_object(
          'line_count', count(*),
          'resolved_line_count', count(*) filter (where product_sku is not null),
          'resolved_line_pct', case when count(*) = 0 then null
            else round(100.0 * (count(*) filter (where product_sku is not null)) / count(*), 1) end,
          'total_value', coalesce(sum(line_value), 0),
          'resolved_value', coalesce(sum(line_value) filter (where product_sku is not null), 0),
          'resolved_value_pct', case when coalesce(sum(abs(line_value)), 0) = 0 then null
            else round(100.0 * coalesce(sum(abs(line_value)) filter (where product_sku is not null), 0)
                       / sum(abs(line_value)), 1) end,
          'by_year', null)
        from joined
      ),
      'non_usd', jsonb_build_object('line_count', 0, 'value', 0, 'line_pct', 0, 'value_pct', 0)
    ) into v_result;

    return v_result;
  end if;

  -- plane = 'invoiced' -------------------------------------------------------
  if p_date_from is null or p_date_to is null then
    raise exception 'thom_sales_by_category: invoiced needs p_date_from and p_date_to';
  end if;
  if p_date_to < p_date_from then
    raise exception 'thom_sales_by_category: p_date_to is before p_date_from';
  end if;
  -- CS1 window bound: explicit ranges cap at ~2 years (731 days); the monthly
  -- pre-aggregate that would unlock deep history is deferred (§G).
  if (p_date_to - p_date_from) > 731 then
    raise exception 'thom_sales_by_category: window exceeds the ~2-year cap — narrow the window';
  end if;

  with base as materialized (
    select
      t.billing_document,
      t.billing_date,
      upper(btrim(t.material)) as mkey,
      coalesce(t.quantity, 0) as quantity,
      t.currency,
      public.thom_line_value(t.discounted_sales, t.ytd_total) as line_value
    from public.turnover_orders t
    where t.billing_date between p_date_from and p_date_to
      and (p_file_brand is null or t.brand = p_file_brand)
      -- groupOrders() split-credit dedup: qty-0 rows are secondary-rep
      -- duplicates / rebate / text lines — summing them double-counts.
      and coalesce(t.quantity, 0) <> 0
  ),
  usd as materialized (
    select * from base where currency = 'USD'
  ),
  joined as materialized (
    select
      u.*,
      m.product_sku,
      m.category,
      m.family,
      public.thom_catalog_brand_label(m.brand) as catalog_brand,
      s.class,
      s.name,
      coalesce(s.per_ft, false) as per_ft
    from usd u
    left join public.product_variant_map m on m.variant_key = u.mkey
    left join public.product_spec_view s on s.sku = m.product_sku
  ),
  filtered as (
    select * from joined
    where product_sku is not null
      and (p_catalog_brand is null or lower(catalog_brand) = lower(p_catalog_brand))
      and (p_class is null or class = p_class)
      and (p_category is null or lower(category) = lower(p_category))
      and (p_family is null or lower(family) = lower(p_family))
  ),
  grouped as (
    select
      case p_group_by
        when 'category' then coalesce(category, '(none)')
        when 'class' then coalesce(class, '(none)')
        when 'family' then coalesce(family, '(none)')
        when 'brand' then coalesce(catalog_brand, '(none)')
        else product_sku
      end as group_key,
      max(case when p_group_by = 'product' then name end) as group_label,
      sum(line_value) as net_value,
      sum(quantity) filter (where not per_ft) as units_each,
      sum(quantity) filter (where per_ft) as units_ft,
      count(*) as line_count,
      count(distinct billing_document) as order_count
    from filtered
    group by 1
  )
  select jsonb_build_object(
    'plane', 'invoiced',
    'group_by', p_group_by,
    'date_from', p_date_from,
    'date_to', p_date_to,
    'groups', coalesce((
      select jsonb_agg(g order by g.net_value desc)
      from (select * from grouped order by net_value desc nulls last limit v_top) g
    ), '[]'::jsonb),
    'group_count_total', (select count(*) from grouped),
    'unclassified', case when v_filtered then null else (
      select jsonb_build_object(
        'net_value', coalesce(sum(line_value), 0),
        'units', coalesce(sum(quantity), 0),
        'line_count', count(*),
        'order_count', count(distinct billing_document))
      from joined where product_sku is null
    ) end,
    -- CS7: WINDOW-WIDE denominators (post p_file_brand, pre attribute filters).
    'coverage', (
      select jsonb_build_object(
        'line_count', count(*),
        'resolved_line_count', count(*) filter (where product_sku is not null),
        'resolved_line_pct', case when count(*) = 0 then null
          else round(100.0 * (count(*) filter (where product_sku is not null)) / count(*), 1) end,
        'total_value', coalesce(sum(line_value), 0),
        'resolved_value', coalesce(sum(line_value) filter (where product_sku is not null), 0),
        -- Value coverage over ABS values: returns/credits must not cancel
        -- resolved value against unresolved and fake a >100% or negative rate.
        'resolved_value_pct', case when coalesce(sum(abs(line_value)), 0) = 0 then null
          else round(100.0 * coalesce(sum(abs(line_value)) filter (where product_sku is not null), 0)
                     / sum(abs(line_value)), 1) end,
        'by_year', case when extract(year from p_date_from) = extract(year from p_date_to) then null else (
          select jsonb_agg(y order by y.year)
          from (
            select
              extract(year from billing_date)::int as year,
              count(*) as line_count,
              count(*) filter (where product_sku is not null) as resolved_line_count,
              case when count(*) = 0 then null
                else round(100.0 * (count(*) filter (where product_sku is not null)) / count(*), 1) end
                as resolved_line_pct,
              case when coalesce(sum(abs(line_value)), 0) = 0 then null
                else round(100.0 * coalesce(sum(abs(line_value)) filter (where product_sku is not null), 0)
                           / sum(abs(line_value)), 1) end
                as resolved_value_pct
            from joined
            group by 1
          ) y
        ) end)
      from joined
    ),
    -- CS2: the excluded non-USD share (we never convert — no FX rates exist).
    'non_usd', (
      select jsonb_build_object(
        'line_count', (select count(*) from base where currency is distinct from 'USD'),
        'value', (select coalesce(sum(line_value), 0) from base where currency is distinct from 'USD'),
        'line_pct', case when (select count(*) from base) = 0 then 0
          else round(100.0 * (select count(*) from base where currency is distinct from 'USD')
                     / (select count(*) from base), 1) end,
        'value_pct', case when (select coalesce(sum(abs(line_value)), 0) from base) = 0 then 0
          else round(100.0 * (select coalesce(sum(abs(line_value)), 0) from base where currency is distinct from 'USD')
                     / (select sum(abs(line_value)) from base), 1) end)
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.thom_sales_by_category(
  text, date, date, text, text, text, text, text, text, int
) from public, anon;
grant execute on function public.thom_sales_by_category(
  text, date, date, text, text, text, text, text, text, int
) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Freshness companion: ONE place computes the "as of" facts; the tool never
-- invents them. invoiced = latest succeeded turnover ingest + max(billing_date)
-- (fast under the new index; turnover_orders.updated_at is unindexed and a
-- 1.76M-row max would seq-scan, so the ingest row carries the sync recency).
-- backlog = latest succeeded open-orders ingest + snapshot recency over the
-- ~7.7k open rows.
-- -----------------------------------------------------------------------------

create or replace function public.thom_sales_freshness(p_plane text default 'invoiced')
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v jsonb;
begin
  if p_plane is null or p_plane not in ('invoiced', 'backlog') then
    raise exception 'thom_sales_freshness: unknown plane %', coalesce(p_plane, '(null)');
  end if;

  if p_plane = 'invoiced' then
    select jsonb_build_object(
      'plane', 'invoiced',
      'last_ingest_at', (
        select coalesce(di.finished_at, di.created_at)
        from public.data_ingestions di
        where di.source = 'turnover' and di.status = 'succeeded'
        order by di.created_at desc
        limit 1
      ),
      'max_billing_date', (select max(billing_date) from public.turnover_orders)
    ) into v;
  else
    select jsonb_build_object(
      'plane', 'backlog',
      'last_ingest_at', (
        select coalesce(di.finished_at, di.created_at)
        from public.data_ingestions di
        where di.source = 'open-orders' and di.status = 'succeeded'
        order by di.created_at desc
        limit 1
      ),
      'snapshot_at', (select max(updated_at) from public.open_orders where is_open),
      'open_line_count', (select count(*) from public.open_orders where is_open)
    ) into v;
  end if;

  return v;
end;
$$;

revoke all on function public.thom_sales_freshness(text) from public, anon;
grant execute on function public.thom_sales_freshness(text) to authenticated, service_role;

-- =============================================================================
-- VERIFY (house style — run at apply time; record counts/rates only, CS15)
-- =============================================================================

-- E.3 / A.2 — TS<->SQL value-parity literals (the groupOrders.test.ts cases).
-- These EXECUTE at apply time; a drifted mirror fails the migration.
do $$
begin
  assert public.thom_line_value(62.25, 622.2) = 62.25, 'thom_line_value: ds wins when nonzero';
  assert public.thom_line_value(0, 203) = 203, 'thom_line_value: ytd fallback when ds = 0';
  assert public.thom_line_value(null, 203) = 203, 'thom_line_value: ytd fallback when ds is null';
  assert public.thom_line_value(0, null) = 0, 'thom_line_value: 0 when both empty';
  assert public.thom_catalog_brand_label('WAC') = 'WAC Lighting', 'brand label: WAC';
  assert public.thom_catalog_brand_label('MOF') = 'Modern Forms', 'brand label: MOF';
  assert public.thom_catalog_brand_label('AISPIRE') = 'aiSpire', 'brand label: AISPIRE';
  assert public.thom_catalog_brand_label('Modern Forms') = 'Modern Forms', 'brand label: passthrough';
  assert public.thom_catalog_brand_label('') is null, 'brand label: blank -> null';
end $$;

-- G.1 gate queries (run manually at apply time, flag OFF; record counts and
-- rates ONLY in the header above — no dollar figures, the repo is public):
--
-- (a) Exact coverage by file brand by year (lines + value shares):
--   with j as (
--     select t.brand, extract(year from t.billing_date)::int as yr,
--            public.thom_line_value(t.discounted_sales, t.ytd_total) as v,
--            (m.product_sku is not null) as resolved
--     from public.turnover_orders t
--     left join public.product_variant_map m
--       on m.variant_key = upper(btrim(t.material))
--     where t.currency = 'USD' and coalesce(t.quantity, 0) <> 0)
--   select brand, yr,
--          count(*) as lines,
--          round(100.0 * count(*) filter (where resolved) / count(*), 1) as line_pct,
--          round(100.0 * sum(abs(v)) filter (where resolved) / nullif(sum(abs(v)), 0), 1) as value_pct
--   from j group by 1, 2 order by 1, 2;
--   -- STOP AND RECONCILE if WAC-recent lands materially below the sampled
--   -- 92% lines / 96% value before any tool ships (plan §F G.1).
--
-- (b) CS16 disagreeing-parent collision share vs the 0.1%-of-value threshold:
--   with dup as (
--     select upper(btrim(v.val ->> 'sku')) as variant_key
--     from public.products p
--     cross join lateral jsonb_array_elements(
--       case when jsonb_typeof(p.variants) = 'array' then p.variants else '[]'::jsonb end) v(val)
--     where nullif(btrim(coalesce(v.val ->> 'sku', '')), '') is not null
--     group by 1
--     having count(distinct (p.brand, p.category, p.family)) > 1)
--   select round(100.0 * coalesce(sum(abs(public.thom_line_value(t.discounted_sales, t.ytd_total)))
--            filter (where d.variant_key is not null), 0)
--          / nullif(sum(abs(public.thom_line_value(t.discounted_sales, t.ytd_total))), 0), 3)
--            as colliding_value_pct
--   from public.turnover_orders t
--   left join dup d on d.variant_key = upper(btrim(t.material))
--   where t.billing_date >= date_trunc('year', current_date)
--     and t.currency = 'USD' and coalesce(t.quantity, 0) <> 0;
--   -- >= 0.1%: replace distinct-on with collision-exclusion (CS16) before
--   -- the flag flips.
--
-- (c) Non-USD share (CS2):
--   select round(100.0 * count(*) filter (where currency is distinct from 'USD') / count(*), 2) as line_pct
--   from public.turnover_orders
--   where billing_date >= date_trunc('year', current_date) and coalesce(quantity, 0) <> 0;
--
-- (d) explain analyze of a YTD rollup AS AN AUTHENTICATED JWT (never service
--     role — it bypasses RLS and proves nothing about the InitPlan hoist):
--   set role authenticated;
--   set request.jwt.claims to '{"sub":"<an internal user uuid>","role":"authenticated"}';
--   explain analyze
--     select * from public.thom_sales_by_category(
--       'invoiced', date_trunc('year', current_date)::date, current_date, 'category');
--   -- Must show turnover_orders_billing_brand_idx AND InitPlan (one
--   -- is_active_internal_or_admin() evaluation) on all three rewritten
--   -- policies. reset role; afterwards.
--
-- (e) RLS probe as a NON-internal authenticated user -> zero rows / zero-total
--     jsonb (the tool renders that as "no access", never "$0 sales").
