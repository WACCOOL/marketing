-- =============================================================================
-- Thom Bot — mounting-type-first product classification (zmntyp) + taxonomy
-- filters.
--
-- THE FAILURE (Davis-reported, real): the spec views' `class` bucket
-- (0059 -> 0060 -> 0063/0064) derives from a name/category regex, and the
-- `downlight` branch is `~* 'downlight|recessed'` — which matches GROUND-
-- RECESSED landscape fixtures. "Downlight sales" reports therefore included
-- 2-Inch In-Ground and other landscape products. Name matching cannot fix
-- this: "recessed" is genuinely how both indoor downlight trims and in-ground
-- landscape fixtures are described.
--
-- THE FIX (audited live against the Sales Layer feed, 2026-07-22): the PIM
-- carries product-level taxonomy fields that the sync never persisted as
-- columns — they lived only inside products.raw_json, which is NOT
-- anon-readable (0052) and must never be read from invoker views:
--   zmntyp   — mounting type, 4,389/4,390 coverage. Vocabulary + counts:
--              Hanging Lighting 799, Wall Lighting 797, Ceiling Lighting 655,
--              Recessed Downlights 509, Recessed Lighting 377,
--              Track Lighting 333, Accessories 252, Landscape Lighting 234,
--              Ceiling Fans 135, VENTRIX 112 (brand junk — the sync remaps
--              those rows to zprdtyp), Task & Cove (+ Task & Cove Lighting)
--              ~101, Display Lighting 39, Fan Accessories 18,
--              Inground Lighting 6.
--   zprdtyp  — product type (4,389), zprdstyp — subtype (4,387),
--   zinout   — Indoor/Outdoor (only 2,165 — a SECONDARY signal).
-- Verified: Pop-In + Aether trims -> 'Recessed Downlights'; the in-ground
-- landscape fixtures -> 'Landscape Lighting' / 'Inground Lighting'.
--
-- WHAT THIS MIGRATION DOES:
--   1. products gains four text columns: product_type, product_subtype,
--      mounting_type, indoor_outdoor (mapped by apps/api/src/saleslayer.ts
--      productTaxonomy(), cleanText'd like name/brand/family).
--   2. Extends the 0052 anon column whitelist with the four columns — they
--      are non-sensitive catalog taxonomy (the same facts already print on
--      public PDPs), NOT internal bookkeeping like raw_json/sl_id.
--   3. product_spec_class() — a NEW IMMUTABLE SQL function holding the class
--      derivation, mounting-type-FIRST with the pre-0068 name/category regex
--      chain as the fallback. 0064 kept the CASE as duplicated text in the
--      matview and the plain view with a "must stay identical" note; hoisting
--      it into one function makes the two surfaces share the definition BY
--      CONSTRUCTION (the same idiom as the product_spec_parse_* functions,
--      which the planner inlines) and lets the migration EXECUTE the
--      Pop-In / In-Ground / VENTRIX literals as asserts below.
--   4. product_variant_spec_mat (0064) and product_variant_spec_view (0063)
--      rebuilt on product_spec_class(), each carrying mounting_type +
--      product_type as first-class columns; product_spec_view rebuilt on the
--      matview with the same two columns appended after category.
--      The matview select stays 0064's text verbatim except: the class CASE
--      is now the shared function, and mounting_type/product_type ride
--      through. [MAT-1] variant_key and [MAT-2] pp.scope='public' unchanged
--      — the 0064 security audit holds: the two new columns are on the anon
--      whitelist (§2), so the matview remains anon-safe by construction.
--   5. product_spec_filter + product_spec_rank recreated with a mounting-type
--      filter arg (SIGNATURE CHANGE — the old signatures are DROPPED first so
--      PostgREST never sees two overloads).
--   6. thom_sales_by_category (0065) recreated with p_mounting_type +
--      p_product_type filters and 'mounting_type' / 'product_type' group_by
--      options (same drop-first signature discipline; grants re-stated:
--      authenticated + service_role only, never anon).
--
-- CLASS DERIVATION (mounting-type-first; the pinned mapping):
--   per-foot leads, as in 0059/0063: tape/strip is per-foot REGARDLESS of
--     mounting type; 'Task & Cove%' rows join it only when tape-ish (the
--     name regex stays as the guard — undercabinet task BARS are each-goods).
--   'Recessed Downlights'                             -> downlight
--   'Recessed Lighting' (no landscape/in-ground/well
--     context in name+category)                       -> downlight
--   'Recessed Lighting' (landscape/in-ground context) -> outdoor
--   'Landscape Lighting' / 'Inground Lighting'        -> outdoor
--   'Track Lighting'                                  -> track
--   'Ceiling Fans' / 'Fan Accessories'                -> fan
--     (Fan Accessories rows are is_accessory=true via the sync's zmntyp
--     /accessor/i rule, so the RPCs' not-is_accessory scope already excludes
--     them; the class value is cosmetic there and 'fan' is the honest bucket)
--   'Hanging Lighting'                                -> decorative
--   'Wall Lighting' + Outdoor (zinout OR the outdoor
--     name regex, since zinout covers only ~half)     -> outdoor
--   'Wall Lighting' otherwise                         -> wall
--   'Ceiling Lighting'                                -> ceiling
--   anything else — null, 'Accessories', 'Display Lighting', brand junk
--   that escaped the sync remap — FALLS BACK to the pre-0068 name/category
--   regex chain VERBATIM, so rows without mounting data classify exactly as
--   before (zero regression pre-sync).
--   KNOWN RECLASSIFICATIONS (accepted): linear suspensions whose zmntyp is
--   'Hanging Lighting' move linear -> decorative; wall-regex products whose
--   zmntyp is 'Ceiling Lighting' move to ceiling. Mounting data wins.
--
-- !! POST-APPLY: RUN A PRODUCTS SYNC !!
-- The four columns are NULL for every row until the next Sales Layer product
-- sync runs (POST /api/products/sync or the cron). Until then the class CASE
-- falls through to the regex fallback everywhere — behavior is IDENTICAL to
-- pre-0068, nothing regresses; the fix simply isn't active yet. The sync's
-- post-success refresh_product_spec_mat() call re-materializes the matview
-- with the populated columns (the matview is created WITH DATA below, which
-- is its refresh at apply time).
--
-- -----------------------------------------------------------------------------
-- VERIFY AS ANON (anon key, no JWT — apps/api/src/thom/anonBoundary.test.ts):
--   [PASS] select sku,mounting_type,product_type,product_subtype,
--          indoor_outdoor from products limit 5                      -> rows
--   [PASS] select * from product_variant_spec_mat limit 5            -> rows,
--          now carrying mounting_type + product_type
--   [PASS] rpc product_spec_filter(p_mounting_type:'Recessed Downlights')
--          + a numeric arg                                           -> rows
--   [PASS] rpc product_spec_rank(metric:'lumens',
--          mounting_type_filter:'Track Lighting')                    -> rows
--   [DENY] select raw_json from products    -> permission denied (0052 pin)
--   [DENY] rpc thom_sales_by_category(...)  -> denied for anon (0065 pin)
--
-- VERIFY AFTER THE FIRST POST-0068 PRODUCTS SYNC (the thesis cases):
--   -- The Davis failure: NO landscape/in-ground products in class downlight.
--   select sku, name, mounting_type, class from product_spec_view
--     where class = 'downlight'
--       and (mounting_type in ('Landscape Lighting','Inground Lighting')
--            or name ~* 'in-?ground');                       -- -> 0 rows
--   -- Pop-In / Aether trims are downlights:
--   select class, mounting_type from product_spec_view
--     where name ~* 'pop-?in|aether' and not is_accessory;   -- -> downlight
--   -- In-ground landscape products are outdoor:
--   select class from product_spec_view
--     where mounting_type in ('Landscape Lighting','Inground Lighting');
--                                                             -- -> outdoor
--   -- VENTRIX rows carry zprdtyp (never the literal brand) in mounting_type:
--   select count(*) from products where mounting_type ilike 'ventrix';
--                                                             -- -> 0
--   -- Class distribution sanity vs the zmntyp counts in the header:
--   select class, count(distinct sku) from product_spec_view group by 1;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The taxonomy columns. Text, nullable — populated by the next product
--    sync; NULL means "regex fallback", exactly the pre-0068 behavior.
-- -----------------------------------------------------------------------------
alter table public.products
  add column if not exists product_type text,
  add column if not exists product_subtype text,
  add column if not exists mounting_type text,
  add column if not exists indoor_outdoor text;

-- -----------------------------------------------------------------------------
-- 2. Extend the 0052 anon column whitelist. Same grant style as 0052:
--    an explicit column-list SELECT grant to anon (the table-wide SELECT was
--    revoked there and stays revoked; raw_json / variant_search / sl_id /
--    synced_at remain NEVER-granted). These four are public catalog taxonomy
--    — the invoker spec view below reads them as the caller, so anon needs
--    the column grant for the plain-view path (the matview is a snapshot and
--    carries its own grant).
-- -----------------------------------------------------------------------------
grant select (product_type, product_subtype, mounting_type, indoor_outdoor)
  on public.products to anon;

-- -----------------------------------------------------------------------------
-- 3. product_spec_class — THE class derivation, in one place. IMMUTABLE pure
--    SQL (product_spec_parse_* idiom) so both the matview and the plain view
--    inline the SAME definition; changing the classification is now a
--    create-or-replace of this function + a matview refresh, never a
--    two-view text edit. Mounting-type-first; regex fallback verbatim from
--    0063/0064 (which extended 0060's CASE with wall + ceiling).
-- -----------------------------------------------------------------------------
create or replace function public.product_spec_class(
  p_name text,
  p_category text,
  p_mounting_type text,
  p_indoor_outdoor text
)
returns text
language sql
immutable
as $$
  with t as (
    select
      coalesce(p_name, '') || ' ' || coalesce(p_category, '') as nc,
      btrim(coalesce(p_mounting_type, '')) as mt,
      btrim(coalesce(p_indoor_outdoor, '')) as io
  )
  select case
    -- Per-foot FIRST (0059/0063 order preserved): tape/strip is per-foot
    -- regardless of mounting type; Task & Cove rows join only when tape-ish.
    when nc ~* '\y(tape|strip)\y|extrusion'
      or (mt ilike 'Task & Cove%' and nc ~* '\y(tape|strip|cove)\y|extrusion')
      then 'per-foot'
    -- MOUNTING-TYPE-FIRST (0068): products.mounting_type = Sales Layer zmntyp.
    when mt = 'Recessed Downlights' then 'downlight'
    when mt = 'Recessed Lighting' then
      case when nc ~* 'landscape|in[- ]?ground|\ywell\y' then 'outdoor'
           else 'downlight' end
    when mt in ('Landscape Lighting', 'Inground Lighting') then 'outdoor'
    when mt = 'Track Lighting' then 'track'
    when mt in ('Ceiling Fans', 'Fan Accessories') then 'fan'
    when mt = 'Hanging Lighting' then 'decorative'
    when mt = 'Wall Lighting' then
      -- zinout covers only ~half the catalog, so the outdoor name regex
      -- backstops it (wall packs must never land in 'wall').
      case when io = 'Outdoor'
             or nc ~* 'flood|wall ?pack|area light|landscape'
           then 'outdoor' else 'wall' end
    when mt = 'Ceiling Lighting' then 'ceiling'
    -- FALLBACK — mounting_type null / 'Accessories' / 'Display Lighting' /
    -- brand junk: the pre-0068 name/category regex chain, VERBATIM.
    when nc ~* '\yfans?\y' then 'fan'
    when nc ~* 'downlight|recessed' then 'downlight'
    when nc ~* 'track|monopoint' then 'track'
    when nc ~* 'flood|wall ?pack|area light|landscape' then 'outdoor'
    when nc ~* '\y(bath|vanity|vanities|sconces?)\y|wall[- ]?(mount(ed)?|light|lamp|wash)' then 'wall'
    when nc ~* '\y(flush|semi[- ]?flush)\y|ceiling' then 'ceiling'
    when nc ~* 'linear|suspended' then 'linear'
    when nc ~* 'chandelier|pendant|multi[- ]?light' then 'decorative'
    else 'other'
  end
  from t
$$;

-- Anon executes this INSIDE the invoker view (product_variant_spec_view runs
-- as the caller), so the default PUBLIC execute must hold — stated explicitly
-- rather than relied on (it reads only its arguments; no data access).
grant execute on function public.product_spec_class(text, text, text, text)
  to anon, authenticated;

-- Executing literals — the thesis cases run AT APPLY TIME; a drifted CASE
-- fails the migration (the 0065 thom_line_value idiom).
do $$
begin
  -- THE Davis failure shape: ground-recessed landscape products must never
  -- class as downlights once mounting data is present.
  assert public.product_spec_class(
      '2in In-Ground', 'Landscape', 'Landscape Lighting', 'Outdoor') = 'outdoor',
    'in-ground landscape (zmntyp Landscape Lighting) must be outdoor, not downlight';
  assert public.product_spec_class(
      '2in Inground Luminaire', 'Landscape', 'Inground Lighting', 'Outdoor') = 'outdoor',
    'Inground Lighting must be outdoor';
  -- 'Recessed Lighting' splits on landscape context:
  assert public.product_spec_class(
      'Ground Recessed Well Light', 'Landscape Lighting', 'Recessed Lighting', 'Outdoor') = 'outdoor',
    'landscape-context Recessed Lighting must be outdoor';
  assert public.product_spec_class(
      'Aether Atomic Square Trim', 'Recessed Lighting', 'Recessed Lighting', null) = 'downlight',
    'indoor Recessed Lighting must be downlight';
  -- Pop-In / Aether trims (verified zmntyp 'Recessed Downlights'):
  assert public.product_spec_class(
      'Pop-In 4in Round Trim', 'Recessed Downlights', 'Recessed Downlights', 'Indoor') = 'downlight',
    'Recessed Downlights must be downlight';
  -- VENTRIX defense-in-depth: the sync remaps zmntyp->zprdtyp, but if the
  -- literal brand ever lands anyway it must fall back to the regex chain:
  assert public.product_spec_class(
      'VENTRIX 1in Adjustable Beam', 'Track Systems', 'VENTRIX', null) = 'track',
    'unrecognized zmntyp (VENTRIX) must fall back to the name/category regex';
  -- Null mounting type = the pre-0068 regex, unchanged (nothing regresses
  -- before the post-apply sync populates the columns):
  assert public.product_spec_class(
      'Slim Bath & Vanity Light', 'Bath & Vanity Lights', null, null) = 'wall',
    'null zmntyp must classify exactly as pre-0068 (wall via regex)';
  assert public.product_spec_class(
      '2-Inch In-Ground Recessed', 'Landscape Accessories', null, null) = 'downlight',
    'null zmntyp keeps the KNOWN pre-0068 misclass (regex fallback is verbatim)';
  -- Tape stays per-foot regardless of mounting type:
  assert public.product_spec_class(
      'InvisiLED Pro Tape Light', 'Task & Cove Lighting', 'Task & Cove Lighting', 'Indoor') = 'per-foot',
    'tape is per-foot regardless of zmntyp';
  -- Task & Cove NON-tape (undercabinet task bar) is NOT forced per-foot:
  assert public.product_spec_class(
      'CCT Selectable Light Bar', 'Under Cabinet', 'Task & Cove Lighting', 'Indoor') <> 'per-foot',
    'Task & Cove each-goods must not be forced per-foot';
  -- Wall Lighting splits by indoor/outdoor (regex backstop included):
  assert public.product_spec_class(
      'Tube Architectural Wall Mount', 'Wall Lighting', 'Wall Lighting', 'Outdoor') = 'outdoor',
    'outdoor Wall Lighting must be outdoor';
  assert public.product_spec_class(
      'Slim Sconce', 'Wall Lighting', 'Wall Lighting', 'Indoor') = 'wall',
    'indoor Wall Lighting must be wall';
  assert public.product_spec_class(
      'Endurance Wall Pack', 'Wall Lighting', 'Wall Lighting', null) = 'outdoor',
    'wall packs stay outdoor even without zinout (regex backstop)';
  -- The remaining direct mappings:
  assert public.product_spec_class('X', 'Y', 'Track Lighting', null) = 'track', 'track';
  assert public.product_spec_class('X', 'Y', 'Ceiling Fans', null) = 'fan', 'fan';
  assert public.product_spec_class('X', 'Y', 'Fan Accessories', null) = 'fan', 'fan acc';
  assert public.product_spec_class('X', 'Y', 'Hanging Lighting', null) = 'decorative', 'hanging';
  assert public.product_spec_class('X', 'Y', 'Ceiling Lighting', null) = 'ceiling', 'ceiling';
  assert public.product_spec_class('X', 'Y', 'Accessories', null) = 'other', 'accessories -> regex fallback';
end $$;

-- -----------------------------------------------------------------------------
-- 4a. Rebuild the MATERIALIZED base (0064 §1, verbatim except: the class CASE
--     is now product_spec_class(), and mounting_type / product_type ride
--     through as columns after category). product_spec_view depends on it, so
--     it drops first and is rebuilt in 4c. [MAT-1]/[MAT-2] unchanged; the
--     0064 security audit holds (all products columns read here are on the
--     0052+0068 anon whitelist; the photometrics lateral stays scope='public').
-- -----------------------------------------------------------------------------
drop view if exists public.product_spec_view;
drop materialized view if exists public.product_variant_spec_mat;

create materialized view public.product_variant_spec_mat as
select
  b.sku,
  b.name,
  b.brand,
  b.category,
  b.mounting_type,
  b.product_type,
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
      p.mounting_type,
      p.product_type,
      -- 0068: the ONE classification source (mounting-type-first, regex
      -- fallback). Shared with product_variant_spec_view by construction.
      public.product_spec_class(p.name, p.category, p.mounting_type, p.indoor_outdoor) as class,
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
    -- materialized (see the 0064 security note).
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
-- WITH DATA is the apply-time refresh; the product sync's post-success
-- refresh_product_spec_mat() (0064 §4, unchanged) re-materializes once the
-- taxonomy columns are populated.

grant select on public.product_variant_spec_mat to anon, authenticated;

-- Indexes (0064 §2 + a mounting_type btree for the new filter predicate).
create unique index product_variant_spec_mat_sku_variant_key
  on public.product_variant_spec_mat (sku, variant_key);

create index product_variant_spec_mat_class     on public.product_variant_spec_mat (class);
create index product_variant_spec_mat_mnt_type  on public.product_variant_spec_mat (mounting_type);
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
-- 4b. Rebuild the PLAIN view (0063 §1, verbatim except the shared class
--     function + the two taxonomy passthrough columns). Kept for the same
--     reasons as 0064: get_product reads it per-SKU (cheap, always fresh,
--     scope-accurate — the photometrics lateral runs as the CALLER, so the
--     internal IES edge survives here). Dropped first because the new
--     columns land mid-list (create or replace only appends).
-- -----------------------------------------------------------------------------
drop view if exists public.product_variant_spec_view;
create view public.product_variant_spec_view
with (security_invoker = on) as
select
  b.sku,
  b.name,
  b.brand,
  b.category,
  b.mounting_type,
  b.product_type,
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
      p.mounting_type,
      p.product_type,
      -- 0068: the ONE classification source — same function as the matview.
      public.product_spec_class(p.name, p.category, p.mounting_type, p.indoor_outdoor) as class,
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
-- 4c. product_spec_view — rebuilt on the matview (0064 §3a) with
--     mounting_type + product_type appended after category so
--     thom_sales_by_category can group/filter on them. security_invoker kept.
-- -----------------------------------------------------------------------------
create view public.product_spec_view
with (security_invoker = on) as
select distinct
  v.sku,
  v.name,
  v.brand,
  v.category,
  v.mounting_type,
  v.product_type,
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
-- 5a. product_spec_filter — recreated with p_mounting_type. SIGNATURE CHANGE:
--     the 0063/0064 signature is dropped FIRST (create or replace with a new
--     arg list would create an OVERLOAD and PostgREST rpc calls would 300 on
--     ambiguity). Everything else is 0064 §3b verbatim; the mounting-type
--     predicate is a case-insensitive equality (the tool schema enumerates
--     the exact vocabulary, lower() is belt-and-braces for router casing).
-- -----------------------------------------------------------------------------
drop function if exists public.product_spec_filter(
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric,
  numeric, numeric, numeric, numeric, numeric,
  int, int, int, int,
  text, text, text,
  vector, text, int);

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
  p_mounting_type text default null,
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
    -- Filter scope: non-accessory variant rows matching brand/category/class/
    -- mounting type, regardless of data availability (in_scope_total's
    -- denominator). Reads the MATERIALIZED base (0064) — anon-safe by
    -- construction; the products join below (embedding) still runs as the
    -- invoker under 0052.
    select v.*
    from public.product_variant_spec_mat v
    where not v.is_accessory
      and (p_brand is null or v.brand = p_brand)
      and (p_category is null or v.category = p_category)
      and (p_class is null or v.class = p_class)
      and (p_mounting_type is null or lower(v.mounting_type) = lower(p_mounting_type))
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
  text, text, text, text,
  vector, text, int
) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5b. product_spec_rank — recreated with mounting_type_filter (same drop-first
--     signature discipline). Body is 0059 §2 verbatim plus the one predicate;
--     it reads product_spec_view, which now rides the matview (0064) and
--     carries mounting_type.
-- -----------------------------------------------------------------------------
drop function if exists public.product_spec_rank(
  text, text, text, text, text, boolean, boolean, int);

create function public.product_spec_rank(
  metric text,
  dir text default 'desc',
  brand_filter text default null,
  category_filter text default null,
  class_filter text default null,
  mounting_type_filter text default null,
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
      and (mounting_type_filter is null or lower(v.mounting_type) = lower(mounting_type_filter))
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
  public.product_spec_rank(text, text, text, text, text, text, boolean, boolean, int)
  to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. thom_sales_by_category — recreated with p_mounting_type / p_product_type
--    filters and 'mounting_type' / 'product_type' group_by options (the
--    category-sales rollup, 0065 §5; drop-first signature discipline). The
--    two new facets ride the product_spec_view join that already supplies
--    class. Everything else — planes, coverage denominators, non-USD share,
--    unclassified bucket, jsonb document shape — is 0065 verbatim.
--    NOTE: mounting_type groups return '(none)' for every row until the
--    post-apply products sync populates the columns AND the matview refresh
--    runs (the sync does both).
-- -----------------------------------------------------------------------------
drop function if exists public.thom_sales_by_category(
  text, date, date, text, text, text, text, text, text, int);

create function public.thom_sales_by_category(
  p_plane text default 'invoiced',
  p_date_from date default null,
  p_date_to date default null,
  p_group_by text default 'category',
  p_file_brand text default null,
  p_catalog_brand text default null,
  p_class text default null,
  p_category text default null,
  p_family text default null,
  p_mounting_type text default null,
  p_product_type text default null,
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
                         or p_category is not null or p_family is not null
                         or p_mounting_type is not null or p_product_type is not null);
  v_result jsonb;
begin
  if p_plane is null or p_plane not in ('invoiced', 'backlog', 'pipeline') then
    raise exception 'thom_sales_by_category: unknown plane %', coalesce(p_plane, '(null)');
  end if;
  if p_plane = 'pipeline' then
    raise exception 'thom_sales_by_category: plane pipeline is not yet available (stage 2 — the deal_quote_lines mirror)';
  end if;
  if p_group_by is null or p_group_by not in
    ('category', 'class', 'family', 'brand', 'product', 'mounting_type', 'product_type')
  then
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
        s.mounting_type,
        s.product_type,
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
        and (p_mounting_type is null or lower(mounting_type) = lower(p_mounting_type))
        and (p_product_type is null or lower(product_type) = lower(p_product_type))
    ),
    grouped as (
      select
        case p_group_by
          when 'category' then coalesce(category, '(none)')
          when 'class' then coalesce(class, '(none)')
          when 'family' then coalesce(family, '(none)')
          when 'brand' then coalesce(catalog_brand, '(none)')
          when 'mounting_type' then coalesce(mounting_type, '(none)')
          when 'product_type' then coalesce(product_type, '(none)')
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
      s.mounting_type,
      s.product_type,
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
      and (p_mounting_type is null or lower(mounting_type) = lower(p_mounting_type))
      and (p_product_type is null or lower(product_type) = lower(p_product_type))
  ),
  grouped as (
    select
      case p_group_by
        when 'category' then coalesce(category, '(none)')
        when 'class' then coalesce(class, '(none)')
        when 'family' then coalesce(family, '(none)')
        when 'brand' then coalesce(catalog_brand, '(none)')
        when 'mounting_type' then coalesce(mounting_type, '(none)')
        when 'product_type' then coalesce(product_type, '(none)')
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

-- A.6 posture (0065): authenticated + service_role ONLY; never anon.
revoke all on function public.thom_sales_by_category(
  text, date, date, text, text, text, text, text, text, text, text, int
) from public, anon;
grant execute on function public.thom_sales_by_category(
  text, date, date, text, text, text, text, text, text, text, text, int
) to authenticated, service_role;
