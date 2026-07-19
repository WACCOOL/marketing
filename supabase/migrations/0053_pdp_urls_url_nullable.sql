-- =============================================================================
-- pdp_urls.url — allow NULL for unresolved products.
--
-- The resolver used to store a brand-site `?s=<query>` search URL whenever it
-- could not resolve a canonical /product/<slug>/ page. Those searches key on
-- internal numeric SKUs that the brand sites don't index, so they were dead
-- links (surfaced as broken "View product" links until a read-time guard hid
-- them). The resolver now derives model codes from asset filenames and, when
-- nothing resolves, stores url = NULL instead of a dead search URL — the
-- products-sync then keeps its image fallback for those products.
--
-- This drops the NOT NULL constraint so those null rows can be written. It must
-- be applied BEFORE the resolver runs with the new code. RLS is unchanged.
-- =============================================================================

alter table public.pdp_urls alter column url drop not null;
