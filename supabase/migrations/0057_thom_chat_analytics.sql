-- =============================================================================
-- Thom chat viewer + analytics (admin features).
--
-- 1. thom_conversations.public_session_key — groups the PUBLIC bubble's turns
--    into conversations. The public worker holds no service key (by design),
--    so it POSTs completed turns to the API worker's shared-secret log route;
--    the key is a SHA-256 hash of the visitor's short-lived session token
--    (never the token itself).
--
-- 2. RLS tightened to OWN-OR-ADMIN. 0044 allowed any active internal user to
--    read ALL transcripts; viewing other people's chats is now an admin-only
--    feature (Davis 2026-07-21), and internal transcripts can carry CRM tool
--    results. Own-history reads keep working (user_id = auth.uid()); the
--    public bubble rows (user_id null) become admin-only. InitPlan form
--    throughout (see 0055).
--
-- 3. Analytics RPCs — SECURITY INVOKER so RLS applies (an admin JWT sees
--    everything, anyone else only their own rows; the API route is
--    admin-gated anyway):
--      thom_chat_daily(days)         — per-day conversations/questions split
--                                      by surface + distinct internal users.
--      thom_top_queries(days, max)   — what people SEARCH for (search_products
--                                      / search_docs tool-call inputs).
--      thom_top_products(days, max)  — which products surface (product cards).
-- =============================================================================

alter table public.thom_conversations
  add column if not exists public_session_key text;

create index if not exists thom_conversations_session_idx
  on public.thom_conversations (public_session_key, created_at desc)
  where public_session_key is not null;

drop policy if exists thom_conversations_select on public.thom_conversations;
create policy thom_conversations_select on public.thom_conversations
  for select using (
    user_id = (select auth.uid()) or (select public.is_admin())
  );

drop policy if exists thom_messages_select on public.thom_messages;
create policy thom_messages_select on public.thom_messages
  for select using (
    exists (
      select 1 from public.thom_conversations c
      where c.id = conversation_id
        and (c.user_id = (select auth.uid()) or (select public.is_admin()))
    )
  );

-- -----------------------------------------------------------------------------
-- Daily usage. Conversations are bucketed by their creation day; questions
-- (user-role messages) by the message's day.
-- -----------------------------------------------------------------------------
create or replace function public.thom_chat_daily(days int default 30)
returns table (
  day date,
  internal_conversations bigint,
  public_conversations bigint,
  internal_questions bigint,
  public_questions bigint,
  internal_users bigint
)
language sql
stable
security invoker
as $$
  with d as (
    select generate_series(
      (current_date - (days - 1)), current_date, interval '1 day'
    )::date as day
  ),
  convs as (
    select created_at::date as day,
           count(*) filter (where scope = 'internal') as internal_conversations,
           count(*) filter (where scope = 'public') as public_conversations,
           count(distinct user_id) filter (where scope = 'internal') as internal_users
    from public.thom_conversations
    where created_at >= current_date - (days - 1)
    group by 1
  ),
  msgs as (
    select m.created_at::date as day,
           count(*) filter (where c.scope = 'internal') as internal_questions,
           count(*) filter (where c.scope = 'public') as public_questions
    from public.thom_messages m
    join public.thom_conversations c on c.id = m.conversation_id
    where m.role = 'user'
      and m.created_at >= current_date - (days - 1)
    group by 1
  )
  select d.day,
         coalesce(convs.internal_conversations, 0),
         coalesce(convs.public_conversations, 0),
         coalesce(msgs.internal_questions, 0),
         coalesce(msgs.public_questions, 0),
         coalesce(convs.internal_users, 0)
  from d
  left join convs on convs.day = d.day
  left join msgs on msgs.day = d.day
  order by d.day;
$$;

-- -----------------------------------------------------------------------------
-- What people search for: the query inputs of search_products / search_docs
-- tool calls, lowercased, with per-surface counts.
-- -----------------------------------------------------------------------------
create or replace function public.thom_top_queries(days int default 30, max_rows int default 200)
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
    and tc->>'name' in ('search_products', 'search_docs')
    and coalesce(tc->'input'->>'query', '') <> ''
  group by 1
  order by hits desc, query
  limit max_rows;
$$;

-- -----------------------------------------------------------------------------
-- Which products surface in answers (the rendered product cards).
-- -----------------------------------------------------------------------------
create or replace function public.thom_top_products(days int default 30, max_rows int default 50)
returns table (sku text, name text, hits bigint)
language sql
stable
security invoker
as $$
  select pc->>'sku' as sku,
         max(pc->>'name') as name,
         count(*) as hits
  from public.thom_messages m
  cross join lateral jsonb_array_elements(coalesce(m.product_cards, '[]'::jsonb)) pc
  where m.created_at >= now() - make_interval(days => days)
    and coalesce(pc->>'sku', '') <> ''
  group by 1
  order by hits desc, sku
  limit max_rows;
$$;

grant execute on function public.thom_chat_daily(int) to authenticated;
grant execute on function public.thom_top_queries(int, int) to authenticated;
grant execute on function public.thom_top_products(int, int) to authenticated;
