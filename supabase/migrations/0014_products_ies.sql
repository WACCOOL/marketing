-- =============================================================================
-- Phase 3 — Product IES photometry URL
--
-- WAC fixtures ship an IES photometric file (the manufacturer's true light
-- distribution) in the Sales Layer PIM. The 3D App-Shot studio render uses it
-- (composite.py's add_ies_light) so the fixture throws its real spill into the
-- room. We store only the Sales Layer CDN URL (we never host the .ies file); the
-- render-worker fetches it at render time. Null until the next sync populates it,
-- and fixtures without an IES fall back to lamp + synthetic-fill lighting.
-- =============================================================================

alter table public.products
  add column if not exists ies_url text;
