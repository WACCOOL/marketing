-- =============================================================================
-- Fix: post-sync spec-matview refreshes time out on the service role.
--
-- The product sync's post-success `refresh_product_spec_mat()` call (0064)
-- rides service_role's default ~8s statement_timeout and was observed failing
-- with 57014 on 2026-07-22 ("spec matview refresh failed (non-fatal, 8129ms)")
-- — leaving product_variant_spec_mat stale until a manual refresh. The 0064
-- header documented exactly this fallback: raise service_role's timeout only
-- (never anon's — anon keeps the tight default as a DoS guard).
--
--  1. service_role statement_timeout -> 120s. Applies to NEW connections;
--     PostgREST pools re-establish quickly, and the nightly sync (the caller
--     that matters) always gets fresh connections.
--  2. Refresh the matview NOW (this migration runs in a dashboard/postgres
--     session with no 8s cap), so the 0068 taxonomy columns populated by
--     today's product sync land in the fast copy immediately.
--
-- VERIFY after apply:
--   [PASS] select count(*) from product_variant_spec_mat where mounting_type is not null;  -- expect tens of thousands
--   [PASS] select class from product_variant_spec_mat where sku = '177' limit 1;           -- Pop-In => 'downlight'
--   [PASS] rpc product_spec_filter(p_mounting_type:'Recessed Downlights') returns rows as anon
-- =============================================================================

alter role service_role set statement_timeout = '120s';

refresh materialized view concurrently public.product_variant_spec_mat;
