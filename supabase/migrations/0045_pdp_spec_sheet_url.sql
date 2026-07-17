-- =============================================================================
-- Spec-sheet URL on the PDP cache — Thom Bot spec-sheet coverage.
-- Many products have NO static spec-sheet PDF in Sales Layer; the brand sites
-- generate those on demand. The products-sync PDP resolver (apps/products-sync/
-- src/pdp.ts) already re-derives WIES Studio's method to find the canonical
-- product page; this column stores the spec-sheet URL it also resolves there
-- (tier 2: scraped from the PDP; tier 3: brand template). Thom's ingest reads
-- it to fetch + extract + embed the spec sheet for products the static Sales
-- Layer `specsheet_pdf` (captured in kb_documents by the saleslayer doc capture)
-- doesn't cover. Nullable; populated only when the resolver's PDP_SPEC_SHEETS
-- path is enabled. Same RLS as the rest of pdp_urls (internal/admin read).
-- =============================================================================

alter table public.pdp_urls
  add column if not exists spec_sheet_url text;
