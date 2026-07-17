-- 0046_product_documents_conflict_index.sql
--
-- Fix the doc-ingestion pipeline. Both writers of product_documents —
-- apps/docs-ingest (syncPdpSpecSheets) and apps/api/src/saleslayer.ts
-- (captureDocs) — upsert with onConflict "document_id,product_sku". That maps to
-- a bare `ON CONFLICT (document_id, product_sku)`, which Postgres can only
-- resolve against a NON-partial unique index on exactly those columns.
--
-- 0043 created that index as a PARTIAL index (`where product_sku is not null`),
-- and PostgREST has no way to attach the predicate to the conflict target, so
-- every upsert fails with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- which aborts the whole docs-ingest run before any extraction happens.
--
-- product_sku is always set on those writes (spec sheets/manuals are keyed to a
-- SKU), so a plain unique index is correct and is a valid conflict arbiter. The
-- family-level partial index (product_documents_doc_family_uniq, for rows where
-- product_sku is null) is left untouched.
--
-- Safe to recreate: product_documents is written only by the two upserts above
-- and has no rows yet at the time of this migration.

drop index if exists public.product_documents_doc_sku_uniq;

create unique index if not exists product_documents_doc_sku_uniq
  on public.product_documents (document_id, product_sku);
