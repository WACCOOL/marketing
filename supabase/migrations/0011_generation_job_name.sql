-- =============================================================================
-- Phase 2 — Generation job name
--
-- Adds a human-readable label to generation_jobs so the Asset Library can show
-- queued/running renders before the produced asset exists. Until now the name
-- only rode the Cloudflare Queue message; a queued/running row had nothing to
-- display. Nullable for back-compat with rows inserted before this migration.
-- =============================================================================

alter table public.generation_jobs
  add column if not exists name text;
