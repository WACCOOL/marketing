-- =============================================================================
-- Thom Bot — PDP accessory harvest crawl evidence (compat plan v2.1 Phase 2/§D)
--
-- Phase 2 harvests the two live-sampled PDP accessory sections (PL4):
--   * waclighting.com  "Components"       (h3#components + .product-belt links)
--   * modernforms.com  "Curated For You"  (.thumbnail-section a.product-link)
-- into per-PDP SLUG lists, resolved to SKUs at reconcile time by inverting
-- pdp_urls, and written to product_accessories with source_system='web_crawl'.
--
-- product_accessories itself needs NO change: 0061 was designed for exactly
-- this (source_system provenance in the unique key, source_field labeling,
-- nullable related_product_sku for unresolved refs, synced_at for the
-- source-scoped prune). What IS missing is a place to LAND the harvest:
-- crawl_frontier (0054) carries the PDP evidence set "populated at extract
-- time so reconciliation needs no second fetch", and accessory slugs were not
-- part of that set. This column completes it — same lifecycle as model_codes.
-- =============================================================================

alter table public.crawl_frontier
  add column if not exists accessory_slugs text[];
