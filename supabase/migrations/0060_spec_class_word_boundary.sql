-- =============================================================================
-- Fix: product_spec_view class bucket — word-boundary the tape/strip match.
--
-- G.1 verification against prod caught "TAPER" (a Modern Forms pendant) and
-- any name containing tape/strip as a SUBSTRING being bucketed 'per-foot'
-- (0059's regex used bare `tape|strip`). Word-boundary both tokens;
-- `extrusion` stays unanchored (no false-positive surface). Everything else
-- in the view is byte-identical to 0059 — this is create-or-replace of the
-- same definition with ONE regex changed. See 0059 for the full design notes,
-- security model (security_invoker = on IS load-bearing), and VERIFY-AS-ANON
-- checklist; re-run the [PASS] view/rank checks after applying.
-- =============================================================================
create or replace view public.product_spec_view
with (security_invoker = on) as
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
    when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'linear|suspended' then 'linear'
    when coalesce(p.name, '') || ' ' || coalesce(p.category, '') ~* 'chandelier|pendant|multi[- ]?light' then 'decorative'
    else 'other'
  end as class,
  coalesce(p.is_accessory, false) as is_accessory,
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

-- create-or-replace preserves the view's ACL, but re-assert for safety.
grant select on public.product_spec_view to anon, authenticated;
