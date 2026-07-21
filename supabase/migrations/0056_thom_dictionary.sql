-- =============================================================================
-- Thom dictionary — protected terms for the public copy normalizer.
--
-- The public bubble upgrades any bare "WAC" token to "WAC Group" (copy rule).
-- Names that legitimately contain "WAC" — brands, product lines, the My WAC
-- app — must survive that rewrite. The code ships non-negotiable defaults
-- (DEFAULT_PROTECTED_TERMS in @wac/shared thom/publicFilter); this table holds
-- the marketing-team additions, editable from the marketing app's Thom Bot >
-- Dictionary page, no deploy needed. The public agent reads it with a 5-minute
-- in-isolate cache.
--
-- RLS: terms are public brand vocabulary and the PUBLIC worker (anon role)
-- must read them — world-readable SELECT. Writes go through the API Worker's
-- admin-gated route using the service role (no write policies here), same
-- posture as kb_documents.
-- =============================================================================

create table if not exists public.thom_dictionary (
  id uuid primary key default gen_random_uuid(),
  -- The exact, canonically-cased term to protect (e.g. 'My WAC', 'WAC Home').
  term text not null unique,
  -- Optional note shown in the admin UI ("the app", "smart home system").
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.thom_dictionary_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists thom_dictionary_touch_trigger on public.thom_dictionary;
create trigger thom_dictionary_touch_trigger
  before update on public.thom_dictionary
  for each row execute function public.thom_dictionary_touch();

alter table public.thom_dictionary enable row level security;

drop policy if exists thom_dictionary_select on public.thom_dictionary;
create policy thom_dictionary_select on public.thom_dictionary
  for select using (true);

-- Seed the two terms that prompted the table (also in the code defaults —
-- present here so the admin UI shows them as editable rows with their notes).
insert into public.thom_dictionary (term, note) values
  ('My WAC', 'The My WAC app. Never "My WAC Group".'),
  ('WAC Home', 'The WAC Home smart home system.')
on conflict (term) do nothing;
