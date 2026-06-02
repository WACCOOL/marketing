-- =============================================================================
-- Full-text search column + trigger on public.assets
-- =============================================================================

alter table public.assets
  add column if not exists search_tsv tsvector;

create or replace function public.assets_search_tsv_update() returns trigger
language plpgsql as $$
begin
  new.search_tsv :=
    setweight(to_tsvector('english', coalesce(new.name, '')), 'A')
    || setweight(to_tsvector('english', array_to_string(new.tags, ' ')), 'B')
    || setweight(to_tsvector('english', coalesce(new.metadata_json::text, '')), 'C');
  return new;
end;
$$;

drop trigger if exists assets_search_tsv_trigger on public.assets;
create trigger assets_search_tsv_trigger
  before insert or update of name, tags, metadata_json on public.assets
  for each row execute function public.assets_search_tsv_update();

create index if not exists assets_search_tsv_idx
  on public.assets using gin (search_tsv);

-- Backfill for existing rows.
update public.assets set name = name where search_tsv is null;
