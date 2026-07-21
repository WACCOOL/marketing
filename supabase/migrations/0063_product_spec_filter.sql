-- =============================================================================
-- Thom Bot — variant-grain spec surface + product_spec_filter RPC
-- (attribute-filter plan v2 — RECONCILED + Addendum 1 metric answers +
-- Addendum 2 unit-suffixed auxiliary lengths; ratified 2026-07-21).
--
-- NUMBERING (plan A5): the feedback plan RESERVED 0062; this migration is
-- 0063 even though 0062 has not landed in this branch yet — the reservation
-- holds so the two in-flight plans can never collide.
--
-- A user asked for vanity lights "no wider than 15 inches" and Thom returned
-- a 20-inch fixture: dimensions ride inside products.variants jsonb and no
-- tool could FILTER by a numeric attribute. This migration gives the catalog
-- a variant-grain numeric surface:
--
--  1. product_variant_spec_view — the BASE view (plan A6b): one row per
--     variant, the ONLY place jsonb_array_elements(variants) runs. Carries
--     guarded numeric dims (mm), the Addendum-2 wire length, per-variant
--     lumens/watts, parsed CCT/CRI/IP, the class CASE (moved here from 0060,
--     extended with wall + ceiling buckets), class-aware derived
--     width_in/depth_in/height_in, and window-computed product-level rollups.
--  2. product_spec_view — DROPPED and REBUILT as a one-row-per-SKU projection
--     of the base view. Same output columns, same names, same grants —
--     product_spec_rank (0059) keeps working unchanged, and the catalog now
--     does ONE variant expansion instead of two.
--  3. product_spec_filter(...) — the filter RPC behind the filter_products
--     tool: same-row conjunction at variant grain, filter-first + exact
--     semantic ordering, windowed honest counts (in_scope_total /
--     in_scope_screened / matched) on every row.
--  4. New parsers product_spec_parse_cct / product_spec_parse_ip /
--     product_spec_parse_dims — IMMUTABLE pure SQL like
--     product_spec_parse_num (0059), conservative to a fault, invoked via
--     `cross join lateral` ONCE per row (plan A6a — never the
--     `(fn(x)).a, (fn(x)).b` form, which re-executes per referenced field).
--
-- SECURITY — `security_invoker = on` on BOTH views is load-bearing (0059's
-- lesson): the photometrics lateral runs as the CALLER, so the 0048 scope RLS
-- applies (anon never sees internal-scoped IES lumens) and the 0052 column
-- whitelist caps what anon reads from products (variants, dimensions_mm and
-- embedding are whitelisted there, so the public surface works by
-- construction). Anon and internal filter results may DIFFER by photometrics
-- scope — correct and documented. The RPC is SECURITY INVOKER with a pinned
-- search_path and a clamped match_count.
--
-- PREDICATE SEMANTICS (plan A.3):
--  * Same-row conjunction at VARIANT grain: a variant qualifies when it
--    satisfies EVERY stated predicate on its own row; a product qualifies
--    when >= 1 variant qualifies. A NULL in a constrained attribute FAILS
--    that predicate — missing data excludes, it never passes as
--    "probably fine".
--  * Lumens/watts conjunction (plan A4/O2 ship-gate): evaluated on the
--    qualifying variant's OWN row where the variant carries a numeric value
--    (24% of non-accessory products do — concentrated exactly in the
--    multi-size vanity/linear families where it matters: Lightstick's 19 in
--    variant is 1,268 lm against a product-max of 6,342 lm). Where the
--    variant has no lumens the predicate falls back to product-level
--    lumens_max and the row is flagged lumens_source = 'product_level',
--    which the tool converts into a MANDATORY output sentence.
--  * CCT (plan A8/O7): requests arrive as p_cct_min_k/p_cct_max_k with
--    overlap semantics (a single kelvin = equal bounds). Selectable lists
--    ("2700K/3000K/3500K") parse to cct_values int[] and match by EXACT
--    MEMBERSHIP — a "2700K/5000K" selectable does NOT satisfy a 3000K
--    request. Containment/overlap applies ONLY to true ranges/tunables
--    ("1800K-3000K", "R, G, B, 2200K - 6500K").
--  * in_scope_screened (plan A9, pinned): a product is screened iff it has
--    >= 1 variant row that is non-null on EVERY constrained variant-grain
--    attribute AND non-null product-level values for every constrained
--    product-level predicate. Not "has any data"; not per-attribute counts
--    summed. Literal test in the verify block below.
--  * Ordering (plan A7): exact post-filter sort by
--    products.embedding <=> p_query_embedding over the FILTERED set. The
--    HNSW index is IRRELEVANT here and must not be "optimized" back in:
--    HNSW accelerates approximate top-K over the whole table; after hard
--    predicates the candidate set is small and an ANN scan would silently
--    drop qualifiers. Guard embedding is not null, nulls last, deterministic
--    fallback: distance -> ts_rank(p_query_text) -> name -> sku.
--
-- WIDTH/DEPTH/HEIGHT MAPPING (plan A.2 — class-aware, per variant row):
--  Sales Layer's axes are fixture-local: for bath bars zwidth_fix is the wall
--  PROTRUSION and zlength_fix the horizontal run (Slim 3554: W 2.6 in,
--  L 18/24 in). Filtering raw width would answer "no wider than 15 inches"
--  with 24-inch fixtures and reject 2.6-inch-deep ones. Therefore:
--   * width_in  = greatest(width, length, diameter) / 25.4 — the largest
--     horizontal extent (height is vertical). Per-foot rows use the
--     cross-section width ONLY (the recorded length is the REEL length —
--     audit max 30,480 mm = 100 ft).
--   * depth_in is CLASS-AWARE:
--       wall           -> least(width, length) — the wall projection, the
--                         ADA §307 question — but NULL when the face is
--                         round/square (least/greatest > 0.8, or
--                         width = length = diameter): there least-of-W/L is
--                         the FACE, not a projection.
--       ceiling / fan  -> height — the true drop from the ceiling.
--       all others     -> NULL; the tool says depth is not defined for that
--                         fixture type. Refusing beats inventing.
--   * height_in = height / 25.4.
--  Axis-swapped rows (Remi 3210-type: the 16-24 in run recorded in HEIGHT)
--  read as narrow-and-tall — correct if the bar is mounted vertically, which
--  is what those records describe. Counted, not eyeballed: see G.1 below.
--
-- CLASS CASE (single source of truth — moved from 0060's product_spec_view
-- into the BASE view; product_spec_view inherits it; no TS mirror by design):
--   per-foot   \y(tape|strip)\y|extrusion
--   fan        \yfans?\y
--   downlight  downlight|recessed
--   track      track|monopoint
--   outdoor    flood|wall ?pack|area light|landscape
--   wall       \y(bath|vanity|vanities|sconces?)\y|wall[- ]?(mount(ed)?|light|lamp|wash)   [NEW — plan O9]
--   ceiling    \y(flush|semi[- ]?flush)\y|ceiling                                          [NEW — needed by A1's
--              depth rule ("flush/ceiling/fan -> height"); adding it as a bucket keeps the
--              classification in ONE place instead of a second flush-mount regex in the
--              depth CASE]
--   linear     linear|suspended
--   decorative chandelier|pendant|multi[- ]?light
--   other      everything else
-- wall sits AFTER outdoor so wall packs stay outdoor; ceiling after wall so
-- "Bath & Vanity" never lands in ceiling. Vanities/sconces stop landing in
-- 'other' (the 0060 CASE had no wall bucket — plan O9).
--
-- DIAMETER PROVENANCE (plan A11 — documented consequence): the sync maps BOTH
-- zbodydia AND zcnpydia (canopy diameter) -> dimensions_mm.diameter,
-- first-match-wins (apps/api/src/saleslayer.ts VARIANT_DIM_FIELDS). For
-- variants where only the canopy diameter is populated, `diameter` is the
-- CANOPY, not the body. Live feed probe (2026-07-21): of 8,591
-- diameter-bearing raw variant rows, 7,803 are canopy-only (body dia absent)
-- vs 788 body — by class: decorative 3,268, wall 2,203, track 1,756,
-- ceiling 351, outdoor 90, other 79, linear 29, downlight 27. Bounding the
-- contamination of width_in = greatest(W, L, dia):
--   * ZERO canopy-only rows lack W/L entirely — width_in never rides on the
--     canopy alone;
--   * the canopy EXCEEDS max(W, L) (and so drives width_in) on 1,657 rows,
--     typically marginally (e.g. 5 in canopy vs 4.5 in body) — and
--     OVERSTATING width is the conservative direction for a max-width
--     filter: it can only exclude a fixture that would fit, never falsely
--     include one that doesn't.
--
-- ADDENDUM 2 — wire/cord length: the sync now captures zwire_length into
-- variants[].aux_lengths_mm.wire (mm) via the unit-REQUIRED parser in
-- @wac/shared (a bare number is ambiguous -> null). Build-gate audit of the
-- 298-field variant schema (66,840 feed rows, 2026-07-21): zwire_length is
-- the ONLY viable unit-suffixed aux-length field — 3,834 populated (5.7%):
-- `#"` x1,465, `# Feet` x1,183, `#'` x563, bare `#` x394 (dropped),
-- `# Inches` x204, `#in` x16, `#ft` x9. Audited siblings REJECTED for v1:
-- zsuspen_min/zsuspen_max are bare-number dominant (6,845/6,975 of ~7,000
-- rows carry no unit; only 38 `#"` rows each would survive a unit-required
-- parse) — deferred until their unit is declared upstream; zrunlength /
-- zvoltdrop are prose guidance; zdnrodinc is Yes/No; zrel_prod_* are SKUs.
-- wire_length_mm is NULL everywhere until the next product sync runs with
-- the new capture — the tool's honest-coverage line reports that truthfully.
--
-- -----------------------------------------------------------------------------
-- VERIFY AS ANON (anon key, no JWT — apps/api/src/thom/anonBoundary.test.ts):
--   [PASS] select * from product_variant_spec_view limit 5          -> rows
--   [PASS] select * from product_spec_view limit 5                  -> rows
--   [PASS] rpc product_spec_rank(metric:'lumens')                   -> rows,
--          identical shape to pre-0063 (one smoke call pre/post apply)
--   [PASS] rpc product_spec_filter(p_width_max_in:15,
--          p_class:'wall')                                          -> rows,
--          every q_width_max_in <= 15.0, counts populated
--   [DENY] for a SKU whose ONLY photometrics link has scope='internal',
--          anon's product_spec_filter output must show no IES-derived
--          lumens (lumens_source <> 'ies'-sourced product fallback) while an
--          internal user's may — anon/internal divergence here is CORRECT.
--   [DENY] rpc product_spec_filter(p_class:'sideways')              -> raises
--          (class whitelist)
--   [DENY] select raw_json from products                            -> denied
--
-- LATENCY GATE (plan A6): run AS ANON at apply time and RECORD the result:
--   explain analyze
--     select * from product_spec_filter(
--       p_width_max_in := 15, p_lumens_min := 1000, p_depth_max_in := 4,
--       p_query_text := 'vanity light', p_match_count := 10);
--   Budget: p95 < 2 s on the public surface. p95 > 2 s TRIGGERS
--   materialization of the base view (numbered gate, not an open-ended
--   deferral). Confirm the products/product_photometrics policy predicates
--   appear as InitPlans (0059 §3 rewrites), not per-row Filters.
--
-- PARSER LITERALS (run after apply; expected results inline):
--   select * from product_spec_parse_cct('3000K');
--     -> (3000, 3000, {3000}, false)
--   select * from product_spec_parse_cct('1800K-3000K');
--     -> (1800, 3000, null, false)          -- true range: containment path
--   select * from product_spec_parse_cct('2700K/3000K/3500K');
--     -> (2700, 3500, {2700,3000,3500}, true)
--   -- exact membership: 3000 matches, 2800 does NOT:
--   select 3000 = any(cct_values), 2800 = any(cct_values)
--     from product_spec_parse_cct('2700K/3000K/3500K');   -> (true, false)
--   -- the A8 case: a 2700K/5000K selectable must NOT satisfy a 3000K ask:
--   select exists (select 1 from unnest(cct_values) e where e between 3000 and 3000)
--     from product_spec_parse_cct('2700K/5000K');         -> false
--   select * from product_spec_parse_cct('2700K, 3000K, 3500K, 4000K');
--     -> (2700, 4000, {2700,3000,3500,4000}, true)
--   select * from product_spec_parse_cct('R, G, B, 2200K - 6500K');
--     -> (2200, 6500, null, false)
--   select * from product_spec_parse_cct('Amber');        -> (null, null, null, false)
--   select * from product_spec_parse_cct('Color Changing');-> (null, null, null, false)
--   select product_spec_parse_ip('IP65');                 -> 65
--   select product_spec_parse_ip('20');                   -> 20
--   select product_spec_parse_ip('No');                   -> null
--   select product_spec_parse_ip('Damp Location');        -> null
--   select product_spec_parse_num('90');                  -> 90   (CRI as-is)
--
-- DERIVED-DIMS LITERALS (Slim-shaped wall row; flush; round face; pendant;
-- per-foot reel):
--   select * from product_spec_parse_dims(66.04, 127, 457.2, null, 'wall', false);
--     -> width_in 18.0, depth_in 2.6, height_in 5.0        (thesis case)
--   select * from product_spec_parse_dims(304.8, 101.6, 304.8, null, 'ceiling', false);
--     -> width_in 12.0, depth_in 4.0 (the DROP, not least(W,L)), height_in 4.0
--   select * from product_spec_parse_dims(127, 127, 127, 127, 'wall', false);
--     -> depth_in null (round/square face guard)
--   select * from product_spec_parse_dims(120, 80, 300, null, 'decorative', false);
--     -> depth_in null (depth is not defined for a pendant)
--   select * from product_spec_parse_dims(8.13, 3, 30480, null, 'per-foot', true);
--     -> width_in 0.3 (cross-section; the 100 ft reel length EXCLUDED)
--
-- CONJUNCTION LITERAL (the O2 ship-gate — run post-apply against a
-- Lightstick-shaped product, e.g. the 19 in / 1,268 lm variant of a family
-- whose product-max is 6,342 lm):
--   select sku, lumens, lumens_source from product_spec_filter(
--     p_width_max_in := 20, p_lumens_min := 2000, p_query_text := 'lightstick');
--   -> the 19 in variant must NOT qualify: the variant's OWN lumens governs
--      where present (1,268 < 2,000), never the product max. The same call
--      against a product whose variants carry NO lumens falls back to
--      product-level lumens_max with lumens_source = 'product_level' (the
--      tool then emits the mandatory highest-output-configuration sentence).
--
-- IN_SCOPE_SCREENED LITERAL (plan A9 — the split-attribute fixture): two
-- variant rows, v1 width-only and v2 cct-only, are NOT screened for a
-- width+cct query (no single row carries both) and ARE screened for
-- width-only. The RPC's row_screened predicate, evaluated over literals:
--   with rows(width_in, cct_values, cct_min) as (values
--     (15.0::numeric, null::int[], null::int),      -- v1: width only
--     (null::numeric, '{3000}'::int[], 3000)        -- v2: cct only
--   )
--   select
--     bool_or(width_in is not null and (cct_values is not null or cct_min is not null))
--       as screened_width_and_cct,                  -- -> false
--     bool_or(width_in is not null) as screened_width_only   -- -> true
--   from rows;
--
-- G.1 SYSTEMATIC AXIS-SEMANTICS COUNTS (plan A12/O5 — replaces the v1
-- top-30 eyeball; computed 2026-07-21 against prod with this migration's
-- exact derivation logic, over ALL wall AND ceiling categories; re-run the
-- SQL below after apply and compare):
--   Class distribution (non-accessory products with >= 1 dimensioned
--   variant): decorative 1,117; wall 801; other 764; ceiling 262;
--   downlight 245; track 173; fan 73; outdoor 39; per-foot 26; linear 24.
--   (a) wall-class rows with derived depth > 6 in:      2,799 of 9,873
--       dimensioned wall rows (8,342 depth-defined; 1,531 NULLed by the
--       round/square-face guard). Spot-check shows the cluster is dominated
--       by extended-arm/tube wall mounts whose least(W,L) IS a genuine
--       projection (e.g. SKU 1148 "Tube Architectural 6in Extended Single
--       Wall Mount": W 158.75 mm, L 231.77 mm -> 6.3 in). Kept as a WATCH
--       number; anomaly clusters route to the H "axis healing upstream"
--       item, never to SQL heuristics.
--   (b) ceiling/fan rows where derived depth == diameter (face leaking into
--       depth): 6 of 2,687 — negligible.
--   (c) rows with height > 2x derived width (Remi-type vertical-mount vs
--       data-entry-swap candidates): 3,066 total, 1,850 in wall class.
--       Consistent with vertically-mounted bars; routed to H, not healed in
--       SQL.
--   Thesis case verified: SKU 3554 (Slim Bath & Vanity) classes as wall,
--   derived width_in 18.0 / depth_in 2.6 on the 18-inch variant.
--   Counting SQL (run post-apply):
--     select class, count(distinct sku) from product_variant_spec_view
--       where not is_accessory and width_in is not null group by 1;
--     select count(*) from product_variant_spec_view
--       where class = 'wall' and depth_in > 6;
--     select count(*) from product_variant_spec_view
--       where class in ('ceiling','fan') and height_mm = diameter_mm;
--     select count(*) from product_variant_spec_view
--       where height_in > 2 * width_in;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0a. CCT parser (plan A8/O7). Conservative: selectable lists -> cct_values
--     (exact membership); true ranges/tunables -> cct_min/cct_max only;
--     prose -> nulls. The "R, G, B, " prefix (RGBW tunables) is stripped
--     before shape-matching.
-- -----------------------------------------------------------------------------
create or replace function public.product_spec_parse_cct(raw text)
returns table (cct_min int, cct_max int, cct_values int[], cct_multi boolean)
language sql
immutable
as $$
  with s1 as (
    select regexp_replace(btrim(coalesce(raw, '')), '^R\s*,\s*G\s*,\s*B\s*,\s*', '', 'i') as s
  ),
  cls as (
    select
      s,
      s ~* '^\d{4}\s*K$' as is_single,
      s ~* '^\d{4}\s*K\s*-\s*\d{4}\s*K$' as is_range,
      s ~* '^\d{4}\s*K(\s*[/,]\s*\d{4}\s*K)+$' as is_list
    from s1
  ),
  vals as (
    select
      c.*,
      case when c.is_single or c.is_list then
        (select array_agg((regexp_replace(u.t, '\s*K\s*$', '', 'i'))::int order by u.ord)
         from unnest(regexp_split_to_array(c.s, '\s*[/,]\s*')) with ordinality u(t, ord))
      end as list
    from cls c
  )
  select
    case
      when v.is_single or v.is_range then (substring(v.s from '^(\d{4})'))::int
      when v.is_list then (select min(x) from unnest(v.list) x)
    end as cct_min,
    case
      when v.is_single then (substring(v.s from '^(\d{4})'))::int
      when v.is_range then (substring(v.s from '(\d{4})\s*K$'))::int
      when v.is_list then (select max(x) from unnest(v.list) x)
    end as cct_max,
    case when v.is_single or v.is_list then v.list end as cct_values,
    coalesce(v.is_list, false) as cct_multi
  from vals v
$$;

-- -----------------------------------------------------------------------------
-- 0b. IP parser. "IP65"/"65" -> 65; "No"-ish and prose ("Damp Location") ->
--     null — the ABSENCE of a rating is not a rating.
-- -----------------------------------------------------------------------------
create or replace function public.product_spec_parse_ip(raw text)
returns int
language sql
immutable
as $$
  select case
    when btrim(coalesce(raw, '')) ~* '^IP\s*\d{2}$'
      then (substring(btrim(raw) from '(\d{2})\s*$'))::int
    when btrim(coalesce(raw, '')) ~ '^\d{2}$'
      then btrim(raw)::int
  end
$$;

-- -----------------------------------------------------------------------------
-- 0c. Class-aware derived dimensions (plan A.2/A1/O4). Inputs are mm + the
--     class + the row's per-foot flag; outputs are user-facing INCHES
--     (round 1dp). See the header for the full mapping rationale.
-- -----------------------------------------------------------------------------
create or replace function public.product_spec_parse_dims(
  p_width_mm numeric,
  p_height_mm numeric,
  p_length_mm numeric,
  p_diameter_mm numeric,
  p_class text,
  p_per_ft boolean
)
returns table (width_in numeric, depth_in numeric, height_in numeric)
language sql
immutable
as $$
  with d as (
    select
      p_width_mm as w,
      p_height_mm as h,
      -- Per-foot rows: the recorded length is the REEL length (up to 100 ft)
      -- and is excluded from every derivation on that row (plan A10).
      case when p_per_ft then null else p_length_mm end as len,
      case when p_per_ft then null else p_diameter_mm end as dia
  )
  select
    round(
      (case when p_per_ft then d.w else greatest(d.w, d.len, d.dia) end) / 25.4,
      1
    ) as width_in,
    case
      when p_class = 'wall' then
        case
          when least(d.w, d.len) is null then null
          -- Round/square face guard: least-of-W/L there is the FACE, not the
          -- wall projection (least/greatest ignores nulls, so a single-axis
          -- row ratios to 1 and is NULLed too — conservative).
          when least(d.w, d.len) / greatest(d.w, d.len) > 0.8 then null
          when d.w = d.len and d.w = d.dia then null
          else round(least(d.w, d.len) / 25.4, 1)
        end
      when p_class in ('ceiling', 'fan') then round(d.h / 25.4, 1)
      else null
    end as depth_in,
    round(d.h / 25.4, 1) as height_in
  from d
$$;

-- -----------------------------------------------------------------------------
-- 1. product_variant_spec_view — the BASE (one variant expansion, ever).
--
-- Layering: r = expansion + raw/guarded reads + scalar parses; b = r + the
-- representative-IES lateral; outer = composite parsers via cross join
-- lateral (ONCE per row, plan A6a) + window-computed product-level rollups
-- (still the same single expansion — product_spec_view just collapses them).
-- LEFT JOIN lateral keeps zero-variant products as one all-null variant row
-- so product_spec_view's row set (and the rank RPC's denominators) are
-- unchanged from 0059/0060.
-- -----------------------------------------------------------------------------
create or replace view public.product_variant_spec_view
with (security_invoker = on) as
select
  b.sku,
  b.name,
  b.brand,
  b.category,
  b.class,
  b.is_accessory,
  b.variant_ord,
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
      -- Addendum 2: unit-parsed wire/cord length, synced into
      -- variants[].aux_lengths_mm.wire (mm) by saleslayer.ts.
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
    -- Representative IES metrics for the SKU (guarded casts, 0059 idiom).
    -- security_invoker composes: the 0048 scope RLS applies to the CALLER,
    -- so anon never sees internal-scoped IES data here.
    select
      case when (im.metrics ->> 'lumens') ~ '^\d+(\.\d+)?$'
           then round((im.metrics ->> 'lumens')::numeric, 0) end as lumens,
      case when (im.metrics ->> 'efficacy') ~ '^\d+(\.\d+)?$'
           then round((im.metrics ->> 'efficacy')::numeric, 1) end as efficacy
    from public.product_photometrics pp
    join public.ies_metrics im on im.id = pp.ies_metrics_id
    where pp.product_sku = r.sku
      and pp.is_representative
    limit 1
  ) ies on true
) b
cross join lateral public.product_spec_parse_cct(b.cct_desc) cct
cross join lateral public.product_spec_parse_dims(
  b.width_mm, b.height_mm, b.length_mm, b.diameter_mm, b.class, b.per_ft
) d
window w as (partition by b.sku);

grant select on public.product_variant_spec_view to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. product_spec_view — REBUILT on top of the base (plan A6b). Same output
--    columns, same names, same order, same grants as 0060;
--    product_spec_rank (0059) keeps working unchanged. DISTINCT collapses
--    the window-computed product-level columns to one row per SKU.
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
from public.product_variant_spec_view v;

grant select on public.product_spec_view to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. product_spec_filter — the filter RPC (plan A.3/A.4).
--
-- All predicate args carry a p_ prefix (plan A3: unprefixed names collide
-- with view columns inside PL/pgSQL and resolve silently). Dimension args
-- are INCHES (the tool converts the user's unit TS-side, plan O10); wire
-- args are inches too. When nothing matches, ONE all-null row still carries
-- the windowed counts so the tool can distinguish scope-zero from
-- constraint-zero and run the pinned relaxation protocol (plan A13/O11).
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
    select v.*
    from public.product_variant_spec_view v
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
    -- NO ANN shortcut — see the header.
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
