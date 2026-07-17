-- =============================================================================
-- Thom Bot — conversation logging
--
-- Every turn on both surfaces is logged: what was asked, which tools ran, what
-- came back, and what it cost. This is the substrate for the Phase 3 analytics
-- (top questions, deflection, unanswered) and for the cost tuning that the
-- "as cheap as possible without compromising quality" goal depends on.
--
-- IMPORTANT — data classification: internal transcripts will contain HubSpot
-- CRM and financial tool results (deal amounts, company revenue, orders) and
-- PII-redacted support-ticket text. These tables are therefore INTERNAL-READ
-- ONLY. Public-surface rows (user_id null, scope 'public') are logged here too,
-- but the public bubble never reads them back — it keeps session history
-- client-side, so no anon select policy exists.
--
-- Writes are service-role only (the chat route); no insert/update/delete policy
-- is defined, matching the posture of the other server-written tables.
-- =============================================================================

create table if not exists public.thom_conversations (
  id uuid primary key default gen_random_uuid(),
  scope public.thom_scope not null,
  -- Null for the public bubble (no Supabase user).
  user_id uuid references public.users(id) on delete set null,
  -- 'internal' | 'widget' — which front-end opened the conversation.
  surface text not null,
  -- Public bubble only: which embedding site this came from.
  site_key text,
  -- Short generated label for the history list.
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists thom_conversations_user_idx
  on public.thom_conversations (user_id, created_at desc);
create index if not exists thom_conversations_scope_idx
  on public.thom_conversations (scope, created_at desc);

create or replace function public.thom_conversations_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists thom_conversations_touch_trigger on public.thom_conversations;
create trigger thom_conversations_touch_trigger
  before update on public.thom_conversations
  for each row execute function public.thom_conversations_touch();

-- -----------------------------------------------------------------------------
-- thom_messages — one row per turn element (user / assistant / tool).
--
-- The token columns are not bookkeeping for its own sake: prompt caching is the
-- single biggest cost lever in this design, and cache_read_tokens vs
-- cache_write_tokens is the only way to prove the cache is actually hitting
-- rather than silently re-billing the full system prompt every turn.
-- -----------------------------------------------------------------------------
create table if not exists public.thom_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null
    references public.thom_conversations(id) on delete cascade,
  -- 'user' | 'assistant' | 'tool'
  role text not null,
  content text,
  -- Claude tool_use blocks issued this turn.
  tool_calls jsonb,
  -- Corresponding tool_result payloads (may contain CRM data — see header).
  tool_results jsonb,
  -- Structured [{document_id, title, doc_type, page, url}] rendered as source chips.
  citations jsonb,
  -- Structured ProductCard[] rendered as rich cards.
  product_cards jsonb,
  model text,
  input_tokens int,
  output_tokens int,
  -- Prompt-cache accounting (Anthropic returns both).
  cache_read_tokens int,
  cache_write_tokens int,
  created_at timestamptz not null default now()
);

create index if not exists thom_messages_conversation_idx
  on public.thom_messages (conversation_id, created_at);

-- -----------------------------------------------------------------------------
-- RLS: internal-read only, service-role write. See the header — these
-- transcripts carry CRM/financial results, so there is deliberately no
-- scope='public' read escape hatch here (unlike kb_* in 0043).
-- -----------------------------------------------------------------------------
alter table public.thom_conversations enable row level security;
alter table public.thom_messages enable row level security;

drop policy if exists thom_conversations_select on public.thom_conversations;
create policy thom_conversations_select on public.thom_conversations
  for select using (public.is_active_internal_or_admin());

drop policy if exists thom_messages_select on public.thom_messages;
create policy thom_messages_select on public.thom_messages
  for select using (public.is_active_internal_or_admin());
