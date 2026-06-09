-- =============================================================================
-- Phase 1 — fixtures registry: support multiple "scenes" per fixture
--
-- Some studio files are named `{sku}_scn{NNN}.blend` (e.g. bl123607-bk_scn010,
-- _scn020, _scn030): the SAME fixture authored in several scene setups. We keep
-- ALL of them and expose them as selectable options within one fixture, instead
-- of collapsing to a single .blend per SKU.
--
-- So the unique key moves from `sku` to `fixture_key` (one row per .blend, e.g.
-- `bl123607-bk_scn030` or `ws270619-wv-ab`), and `sku` becomes the base product
-- SKU (no longer unique — shared by a fixture's scenes) used for catalog lookup.
-- `scene` holds the parsed scene number when present.
-- =============================================================================

alter table public.fixtures
  add column if not exists fixture_key text,
  add column if not exists scene text;

-- Backfill the new key from the old unique sku (no-op on an empty table).
update public.fixtures set fixture_key = sku where fixture_key is null;

alter table public.fixtures alter column fixture_key set not null;

-- sku is no longer unique (a fixture's scenes share it); fixture_key is.
alter table public.fixtures drop constraint if exists fixtures_sku_key;
create unique index if not exists fixtures_fixture_key_idx
  on public.fixtures (fixture_key);
create index if not exists fixtures_sku_idx on public.fixtures (sku);
