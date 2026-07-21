-- =============================================================================
-- Fix: public (anon) kb_search statement timeout — RLS InitPlan form.
--
-- The 0043 SELECT policies call public.is_active_internal_or_admin() as a
-- bare per-ROW predicate. For the anon role that forces the planner to
-- evaluate a plpgsql function against every candidate row and blocks the
-- HNSW/GIN index paths inside kb_search's branches; once the corpus grew past
-- ~250k chunks (web crawl + Zendesk re-extraction, 2026-07-20), anon calls
-- began exceeding the statement timeout (57014) — the public bubble's
-- search_docs failed while service-role calls (RLS bypassed) stayed fast.
--
-- Standard fix: wrap the function in a scalar sub-select so it becomes an
-- InitPlan evaluated ONCE per statement. Semantics are identical (the
-- function reads only auth state, constant within a statement); the row
-- predicate collapses to `scope = 'public' or <constant>` and the indexes
-- are usable again. Same change on all three 0043 tables.
-- =============================================================================

drop policy if exists kb_documents_select on public.kb_documents;
create policy kb_documents_select on public.kb_documents
  for select using (
    scope = 'public' or (select public.is_active_internal_or_admin())
  );

drop policy if exists kb_chunks_select on public.kb_chunks;
create policy kb_chunks_select on public.kb_chunks
  for select using (
    scope = 'public' or (select public.is_active_internal_or_admin())
  );

drop policy if exists product_documents_select on public.product_documents;
create policy product_documents_select on public.product_documents
  for select using (
    scope = 'public' or (select public.is_active_internal_or_admin())
  );
