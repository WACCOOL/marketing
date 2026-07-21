-- =============================================================================
-- Thom analytics v2 — surface filter + data-source usage.
--
-- 1. thom_top_queries / thom_top_products gain a scope_filter param
--    ('internal' | 'public' | null = both). Old 2-arg signatures DROPPED
--    (defaulted params would make the call ambiguous — same reasoning as the
--    0054 kb_search replacement). top_products also gains the conversations
--    join it needed for the filter.
--
-- 2. thom_source_usage — which data sources answers draw on: citation
--    doc_types (kind='doc': spec_sheet, manual, marketing, zendesk_article,
--    zendesk_ticket, web_*) and tool calls (kind='tool': search_products,
--    crm_*, get_photometrics, ...). The API maps these raw keys into friendly
--    buckets (PIM, HubSpot, Zendesk, website crawl, ...), so new doc types
--    need no migration.
--
-- Retention note: thom_conversations / thom_messages are never pruned — the
-- analytics window is only bounded by the `days` argument (UI currently
-- offers up to a year; longer ranges need no schema change).
-- =============================================================================

drop function if exists public.thom_top_queries(int, int);
create or replace function public.thom_top_queries(
  days int default 30,
  max_rows int default 200,
  scope_filter text default null
)
returns table (query text, hits bigint, public_hits bigint)
language sql
stable
security invoker
as $$
  select lower(tc->'input'->>'query') as query,
         count(*) as hits,
         count(*) filter (where c.scope = 'public') as public_hits
  from public.thom_messages m
  join public.thom_conversations c on c.id = m.conversation_id
  cross join lateral jsonb_array_elements(coalesce(m.tool_calls, '[]'::jsonb)) tc
  where m.created_at >= now() - make_interval(days => days)
    and (scope_filter is null or c.scope::text = scope_filter)
    and tc->>'name' in ('search_products', 'search_docs')
    and coalesce(tc->'input'->>'query', '') <> ''
  group by 1
  order by hits desc, query
  limit max_rows;
$$;

drop function if exists public.thom_top_products(int, int);
create or replace function public.thom_top_products(
  days int default 30,
  max_rows int default 50,
  scope_filter text default null
)
returns table (sku text, name text, hits bigint)
language sql
stable
security invoker
as $$
  select pc->>'sku' as sku,
         max(pc->>'name') as name,
         count(*) as hits
  from public.thom_messages m
  join public.thom_conversations c on c.id = m.conversation_id
  cross join lateral jsonb_array_elements(coalesce(m.product_cards, '[]'::jsonb)) pc
  where m.created_at >= now() - make_interval(days => days)
    and (scope_filter is null or c.scope::text = scope_filter)
    and coalesce(pc->>'sku', '') <> ''
  group by 1
  order by hits desc, sku
  limit max_rows;
$$;

create or replace function public.thom_source_usage(
  days int default 30,
  scope_filter text default null
)
returns table (kind text, key text, hits bigint)
language sql
stable
security invoker
as $$
  select 'doc'::text as kind, cit->>'doc_type' as key, count(*) as hits
  from public.thom_messages m
  join public.thom_conversations c on c.id = m.conversation_id
  cross join lateral jsonb_array_elements(coalesce(m.citations, '[]'::jsonb)) cit
  where m.created_at >= now() - make_interval(days => days)
    and (scope_filter is null or c.scope::text = scope_filter)
    and coalesce(cit->>'doc_type', '') <> ''
  group by 2
  union all
  select 'tool'::text, tc->>'name', count(*)
  from public.thom_messages m
  join public.thom_conversations c on c.id = m.conversation_id
  cross join lateral jsonb_array_elements(coalesce(m.tool_calls, '[]'::jsonb)) tc
  where m.created_at >= now() - make_interval(days => days)
    and (scope_filter is null or c.scope::text = scope_filter)
    and coalesce(tc->>'name', '') <> ''
  group by 2
  order by hits desc;
$$;

grant execute on function public.thom_top_queries(int, int, text) to authenticated;
grant execute on function public.thom_top_products(int, int, text) to authenticated;
grant execute on function public.thom_source_usage(int, text) to authenticated;
