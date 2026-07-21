-- =============================================================================
-- Thom Bot — response feedback (thumbs up / thumbs down + optional reason).
--
-- Every assistant answer on both surfaces can be rated. A feedback row
-- snapshots the rated question/answer pair (so ratings survive message
-- deletion and a dark public log bridge), keys back to thom_messages where an
-- id exists, and surfaces in the admin Analytics + Chats pages.
--
-- Dedup design (plan F1/F2): PostgREST's bare `ON CONFLICT (cols)` can only
-- resolve against a NON-PARTIAL unique index — partial unique indexes break
-- every upsert with "no unique or exclusion constraint matching the ON
-- CONFLICT specification" (see 0046: that exact mistake broke every
-- docs-ingest upsert). So instead of two partial unique indexes there is ONE
-- total `dedup_key` column, derived by the writers:
--   internal rows: 'msg:' || message_id
--   public rows:   'pub:' || public_session_key || ':' || client_turn_id
-- ALL writers upsert with onConflict: "dedup_key". Stable even if message_id
-- is later nulled by ON DELETE SET NULL.
--
-- Matched vs unverified (plan F3): a PUBLIC row with message_id IS NULL is
-- "unverified" — its snapshots are visitor-supplied probe text (the feedback
-- can land before the waitUntil turn log does). Unverified rows are badged in
-- analytics and excluded from the positive-rate tile. Matched public rows and
-- all internal rows are verified (snapshots came from DB rows).
--
-- RLS posture: admin-only select, service-role-only write (no
-- insert/update/delete policies at all) — exactly the transcript posture
-- (0044/0057). No anon path of any kind: the public worker never touches this
-- table directly; it rides the shared-secret log bridge.
--
-- VERIFY after applying:
--   [ ] anon `select` and anon `insert` on thom_feedback both DENY.
--   [ ] authenticated NON-admin select returns 0 rows.
--   [ ] PostgREST upsert with onConflict: "dedup_key" round-trips (insert,
--       then update via the same key) — exercise the 0046 failure mode, do
--       not assume it.
--   [ ] inserting `reason` on a rating = 1 row is rejected (F14 check).
--   [ ] `select * from thom_feedback_daily(30, null)` returns a full day spine.
-- =============================================================================

create table public.thom_feedback (
  id uuid primary key default gen_random_uuid(),
  -- 'internal' | 'public' — which surface the rating came from.
  surface text not null check (surface in ('internal', 'public')),
  -- ONE total unique dedup key (F1/F2) — see header. The only conflict arbiter.
  dedup_key text not null unique,
  -- Linkage, all nullable: internal rows carry message_id (+conversation_id,
  -- user_id); public rows carry public_session_key + client_turn_id
  -- (+site_key), and conversation_id/message_id only when the bridge could
  -- match them. message_id is a PLAIN nullable pointer with NO uniqueness
  -- (F1/F2) — public rows may ALSO set it on a bridge match; under a
  -- partial-unique design that would have collided, here it cannot.
  conversation_id uuid references public.thom_conversations(id) on delete set null,
  message_id uuid references public.thom_messages(id) on delete set null,
  user_id uuid references public.users(id) on delete set null,
  public_session_key text,
  client_turn_id text,
  site_key text,
  -- +1 = thumbs up, -1 = thumbs down.
  rating smallint not null check (rating in (1, -1)),
  -- Optional thumbs-down free text. Hard-capped (also enforced in zod), and
  -- structurally impossible on a thumbs-up (F14):
  reason text check (char_length(reason) <= 1000),
  check (rating = -1 or reason is null),
  -- Snapshot of the rated pair. Never null: ratings must survive message
  -- deletion (internal users can delete conversations; messages cascade) and
  -- a dark log bridge. Server/DB-sourced text may use the full cap; UNMATCHED
  -- public rows store client-supplied text capped at 16k by the bridge zod
  -- (F3/F12).
  question_text text not null check (char_length(question_text) <= 8000),
  answer_text text not null check (char_length(answer_text) <= 64000),
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Query indexes. message_id/conversation_id indexes may be partial — they are
-- never a conflict target (dedup_key is).
create index thom_feedback_created_idx
  on public.thom_feedback (created_at desc);
create index thom_feedback_surface_idx
  on public.thom_feedback (surface, created_at desc);
create index thom_feedback_message_idx
  on public.thom_feedback (message_id)
  where message_id is not null;
create index thom_feedback_conversation_idx
  on public.thom_feedback (conversation_id)
  where conversation_id is not null;

-- updated_at touch on vote changes (upsert flips), same pattern as
-- thom_conversations_touch (0044) — the function is generic, reuse it.
drop trigger if exists thom_feedback_touch_trigger on public.thom_feedback;
create trigger thom_feedback_touch_trigger
  before update on public.thom_feedback
  for each row execute function public.thom_conversations_touch();

-- -----------------------------------------------------------------------------
-- RLS: admin-only select (InitPlan form per 0055); NO insert/update/delete
-- policies — writes are service-role only.
-- -----------------------------------------------------------------------------
alter table public.thom_feedback enable row level security;

drop policy if exists thom_feedback_select on public.thom_feedback;
create policy thom_feedback_select on public.thom_feedback
  for select using ((select public.is_admin()));

-- -----------------------------------------------------------------------------
-- Daily feedback counts. SECURITY INVOKER (RLS applies — empty for
-- non-admins; the API route is admin-gated anyway). up/down count VERIFIED
-- rows only; unverified counts unmatched public rows (either rating) so the
-- positive-rate tile's denominator is honest (F3).
--
-- F7 best-effort dedupe: a visitor whose session expires and re-mints gets a
-- new public_session_key → a different dedup_key for the same on-screen turn,
-- so a re-vote after re-mint creates a second row. The widget keeps its
-- client_turn_id, so we count one public row per (client_turn_id, day) —
-- heuristic, not a guarantee (a "session-key family" is not reliably
-- reconstructible). Internal rows (client_turn_id null) fall back to their own
-- id and are never collapsed.
-- -----------------------------------------------------------------------------
create or replace function public.thom_feedback_daily(
  days int default 30,
  scope_filter text default null
)
returns table (day date, up bigint, down bigint, unverified bigint)
language sql
stable
security invoker
as $$
  with d as (
    select generate_series(
      (current_date - (days - 1)), current_date, interval '1 day'
    )::date as day
  ),
  f as (
    select distinct on (created_at::date, coalesce(client_turn_id, id::text))
      created_at::date as day, surface, message_id, rating
    from public.thom_feedback
    where created_at >= current_date - (days - 1)
      and (scope_filter is null or surface = scope_filter)
    order by created_at::date, coalesce(client_turn_id, id::text), created_at desc
  ),
  agg as (
    select day,
      count(*) filter (where rating = 1
                         and not (surface = 'public' and message_id is null)) as up,
      count(*) filter (where rating = -1
                         and not (surface = 'public' and message_id is null)) as down,
      count(*) filter (where surface = 'public' and message_id is null) as unverified
    from f
    group by 1
  )
  select d.day,
         coalesce(agg.up, 0),
         coalesce(agg.down, 0),
         coalesce(agg.unverified, 0)
  from d
  left join agg on agg.day = d.day
  order by d.day;
$$;

grant execute on function public.thom_feedback_daily(int, text) to authenticated;
