-- =============================================================================
-- Thom Bot — public (anon) column-scoped read of the catalog tables
--
-- The PUBLIC Thom worker reads Supabase as the ANON role (the public bubble has
-- no Supabase user). Before this migration the anon role could reach *none* of
-- the catalog it needs:
--   * products         — RLS `is_active()` (0008) returns 0 rows to anon.
--   * pdp_urls          — RLS `is_active_internal_or_admin()` (0026) blocks anon.
--   * track_systems     — RLS `is_active_internal_or_admin()` (0049) blocks anon.
--   * track_components   /
-- So the SECURITY INVOKER `product_semantic_search` RPC returned 0 rows for
-- anon, and get_product / get_family / plan_layout were dead on the public bot.
--
-- WHY A COLUMN GRANT, NOT JUST A ROW POLICY.
-- RLS filters ROWS; it cannot drop COLUMNS. `products.raw_json` is the full
-- internal Sales Layer PIM record (`stripImages(mapRow(...))` in
-- apps/api/src/saleslayer.ts) — internal-only. `variant_search` and `sl_id` are
-- likewise internal bookkeeping. A plain `using(true)` row policy would expose
-- every column to anon. So we REVOKE the table-wide SELECT that Supabase
-- auto-granted anon when the table was created (0008), then GRANT SELECT on an
-- explicit non-sensitive column WHITELIST. The column grant caps what any anon
-- SELECT can physically return; the permissive row policy then lets the rows
-- through. Two independent gates.
--
-- NOTE: at 0008 Supabase's default privileges granted anon SELECT on ALL
-- products columns (verified: an anon `select=raw_json` returns HTTP 200, i.e.
-- a column-privilege pass, not 42501 — RLS alone was hiding the rows). The
-- REVOKE below closes that latent grant.
--
-- ROLE TARGETING: every policy is `to anon` and the grant is `to anon`, so the
-- authenticated + service_role paths (and the internal SECURITY INVOKER callers)
-- are entirely untouched. Internal users keep reading via the 0008/0026/0049
-- policies; the service role bypasses RLS.
--
-- WHITELIST (products) — every column verified to exist:
--   id, sku, name          (0008)   brand      (0010)
--   category, dimensions_mm (0008)   ies_url    (0014)
--   primary_image_url,image_urls,variants,search_tsv (0008)
--   family, is_accessory   (0017)   embedding  (0043)
-- NEVER granted: raw_json, variant_search, sl_id (0008), synced_at (bookkeeping).
--
-- NOT TOUCHED HERE (already correct):
--   * kb_documents / kb_chunks / product_documents (0043) and
--     product_photometrics / ies_metrics (0048) — already anon-safe via their
--     scope='public' gate. product_semantic_search / kb_search already GRANT
--     EXECUTE to anon (0043).
--   * pricing (0021) — `is_admin()` only, MUST stay closed to anon.
--
-- -----------------------------------------------------------------------------
-- VERIFY AS ANON (anon key, no JWT — e.g. apps/api/src/thom/anonBoundary.test.ts):
--   [PASS] select id,sku,name,brand,category,primary_image_url,variants,ies_url,
--          family,is_accessory,dimensions_mm,image_urls from products  -> rows
--   [PASS] rpc product_semantic_search(...)                             -> rows
--   [PASS] rpc kb_search(scope_filter:'public', ...)                    -> rows
--   [PASS] select * from pdp_urls / track_systems / track_components    -> rows
--   [PASS] select * from product_photometrics / ies_metrics             -> rows
--   [DENY] select raw_json | variant_search | sl_id from products
--          -> permission denied for column
--   [DENY] select * from pricing                                        -> 0/denied
--   [DENY] kb_chunks where scope='internal'                             -> 0 rows
-- =============================================================================

-- -----------------------------------------------------------------------------
-- products — revoke the auto-granted table-wide SELECT, re-grant a whitelist.
-- -----------------------------------------------------------------------------
revoke select on public.products from anon;

grant select (
  id,
  sku,
  name,
  brand,
  category,
  family,
  is_accessory,
  dimensions_mm,
  primary_image_url,
  image_urls,
  ies_url,
  variants,
  embedding,
  search_tsv
) on public.products to anon;

-- Permissive anon row policy. The column grant above is what actually caps
-- which columns return; this just lets anon see the rows. Scoped `to anon` so
-- the existing `products_select` (is_active) policy for authenticated users is
-- untouched.
drop policy if exists products_public_read on public.products;
create policy products_public_read on public.products
  for select to anon using (true);

-- -----------------------------------------------------------------------------
-- pdp_urls — all columns are public-safe (brand / query / slug / url), so no
-- column restriction is needed; a permissive anon row policy suffices.
-- -----------------------------------------------------------------------------
drop policy if exists pdp_urls_public_read on public.pdp_urls;
create policy pdp_urls_public_read on public.pdp_urls
  for select to anon using (true);

-- -----------------------------------------------------------------------------
-- track_systems / track_components — public design-tooling reference data for
-- the plan_layout track-BOM tool. All columns are public-safe.
-- -----------------------------------------------------------------------------
drop policy if exists track_systems_public_read on public.track_systems;
create policy track_systems_public_read on public.track_systems
  for select to anon using (true);

drop policy if exists track_components_public_read on public.track_components;
create policy track_components_public_read on public.track_components
  for select to anon using (true);
