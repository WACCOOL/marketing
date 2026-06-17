-- =============================================================================
-- UTM source -> medium mapping
--
-- Constrains which utm_medium values the UTM Builder offers for a given
-- utm_source. The canonical rule (from the spec): a social-network source
-- (youtube, tiktok, linkedin, facebook, instagram, x) should only offer
-- organic_social / paid_social.
--
-- Semantics: a source with NO rows here is *unconstrained* — the builder offers
-- the full medium vocab. So every existing, unmapped source keeps its current
-- behaviour; only the social channels are constrained by the seed below.
--
-- Admins manage these rows (and the source/medium vocab itself) from the
-- "Sources & Mediums" tab under UTM & QR.
-- =============================================================================

create table if not exists public.utm_source_medium (
  source text not null,
  medium text not null,
  created_at timestamptz not null default now(),
  primary key (source, medium)
);

alter table public.utm_source_medium enable row level security;

-- Any active user may read the mapping (the builder needs it); only admins write.
drop policy if exists utm_source_medium_select on public.utm_source_medium;
create policy utm_source_medium_select on public.utm_source_medium
  for select using (public.is_active());

drop policy if exists utm_source_medium_admin_write on public.utm_source_medium;
create policy utm_source_medium_admin_write on public.utm_source_medium
  for all using (public.is_admin()) with check (public.is_admin());

-- Seed the one mapping the spec calls out: social-network sources offer only
-- organic_social / paid_social. Every other existing source is left unmapped
-- (=> full medium list), so current behaviour is unchanged.
insert into public.utm_source_medium (source, medium)
select s.source, m.medium
from (values ('youtube'), ('tiktok'), ('linkedin'), ('facebook'), ('instagram'), ('x'))
       as s(source)
cross join (values ('organic_social'), ('paid_social')) as m(medium)
on conflict (source, medium) do nothing;
