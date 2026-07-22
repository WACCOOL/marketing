-- =============================================================================
-- Thom Bot — dimming-compatibility structured store
-- (docs/thom-dimming-compat-plan.md v2 — RECONCILED, ratified; ledger DC1–DC15)
--
-- NUMBERING NOTE: the plan text says 0064, but at build time 0064 is the
-- in-flight spec-view materialization fix and the parallel category-sales
-- build shipped TWO migrations (0065_category_sales.sql +
-- 0066_deal_quote_lines.sql) — this migration therefore takes 0067. Apply
-- AFTER 0064–0066 land (coordinate ordering with Davis).
--
-- Three tables, all in the 0048/0061 posture: NO foreign key to products (a
-- prunable, denormalized cache keyed by text — DC15: 0048 verified to match
-- this no-FK/service-write posture), OPEN READ (`for select using (true)` —
-- every row derives from dimming-compatibility charts publicly linked on brand
-- PDPs; there are no internal rows; do NOT reintroduce the bare per-row
-- is_active_*() form that caused the 0055 statement-timeout incident), and
-- SERVICE-ROLE-ONLY writes (no insert/update/delete policy exists). Covered by
-- the anon-boundary test (apps/api/src/thom/anonBoundary.test.ts).
--
-- Under open-read RLS, anon CAN read needs_review/superseded report rows —
-- which is exactly why both dimming tools filter dimming_reports.status =
-- 'active' explicitly in their queries (DC14; tested in shared dimmingTools
-- tests). Only the REPORT carries status; rows are active iff their report is.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- dimming_reports — one row per extraction UNIT: a loose PDF, or one PDF entry
-- inside a dim_report zip. Identified by the sha256 of the entry bytes
-- (`content_hash`), the idempotency key — a re-shipped zip with one changed
-- member re-extracts only that member. Byte-identical zip entries dedupe to ONE
-- unit carrying every path in `zip_entry_path` (DC4 — the Tube_Cube zip really
-- contains byte-identical entries under contradictory folder names).
-- -----------------------------------------------------------------------------
create table if not exists public.dimming_reports (
  id uuid primary key default gen_random_uuid(),
  -- Provenance pointer to the captured kb_documents row (no FK by design).
  kb_document_id uuid,
  -- Canonical source URL of the FILE the unit came from (CloudFront / derived
  -- brand-site URL); the same for every unit of one zip.
  source_url text,
  -- All zip entry paths whose bytes hashed to this unit; null for loose PDFs.
  zip_entry_path text[],
  -- sha256 of the PDF unit bytes — the per-unit idempotency key.
  content_hash text not null unique,
  -- The chart's own ID ("WAC-S2" 2025-era). NULLABLE: 2018-era PDF bodies
  -- carry only "ID V0" (DC9) — when absent it is derived from the zip entry
  -- filename and `report_code_derived` is true.
  report_code text,
  report_code_derived boolean not null default false,
  product_family text,
  -- The SKU(s) the chart says were physically tested.
  skus_tested text[] not null default '{}',
  -- Verbatim related-model wildcard patterns from the chart header
  -- (`DS-CD05-*`), plus their normalized LIKE forms (U+2010 -> '-', uppercase,
  -- '*' -> '%') used for pattern-primary product binding (DC4).
  related_model_patterns text[] not null default '{}',
  related_model_likes text[] not null default '{}',
  control_types text[] not null default '{}',
  test_voltage_range text,
  -- Free-text header notes; captures the 2025-era firmware line ("CPU SCM:
  -- 03.56 ...") — for VENTRIX the chart's validity is firmware-scoped (DC12).
  test_notes text,
  extraction_version int not null default 1,
  -- The extracting model id (DC11 — extraction_version does not capture model
  -- identity; the cost/quality audit needs it).
  model text,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'needs_review', 'failed', 'superseded')),
  verified_at timestamptz,
  last_error text,
  synced_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists dimming_reports_kb_doc_idx
  on public.dimming_reports (kb_document_id);
create index if not exists dimming_reports_status_idx
  on public.dimming_reports (status);

-- -----------------------------------------------------------------------------
-- dimming_report_products — report <-> catalog linkage. ALL rows are written at
-- EXTRACTION time, never at capture (DC4): units do not exist until extraction
-- runs. `pattern` rows (resolved from related_model_likes / skus_tested against
-- products.sku + variant SKUs) are the PRIMARY binding — zip folder names and
-- filename wattages are provably untrustworthy. `field` rows are permitted ONLY
-- for loose single-PDF sources where file identity = unit identity; a
-- multi-unit zip NEVER fans a file-level product link to its units. Links are
-- rewritten per product on each extraction run.
-- -----------------------------------------------------------------------------
create table if not exists public.dimming_report_products (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  product_sku text not null,
  link_kind text not null check (link_kind in ('field', 'pattern')),
  created_at timestamptz not null default now(),
  unique (report_id, product_sku, link_kind)
);

create index if not exists dimming_report_products_sku_idx
  on public.dimming_report_products (product_sku);

-- -----------------------------------------------------------------------------
-- dimming_compat_rows — one row per tested dimmer line on a unit's chart.
--
-- `mode_qualifier` (DC2) is the per-row (ELV)/(TRIAC) parenthetical parsed from
-- the model/series cell and is NOT section membership: both `Adorne Touch
-- (ELV)` and `Adorne Touch (TRIAC)` sit under the Adaptive section in the real
-- charts. It is stored BESIDE the section-derived `phase_type`, and it is
-- stripped BEFORE `dimmer_model_norm` is built (otherwise space collapse fuses
-- `ADTP703TU (ELV)` into a garbage key).
--
-- `status` is DERIVED IN CODE, never by the model (DC1): a null low_end_pct
-- can NEVER derive tested_compatible — `tested_issue` is the conservative
-- fourth status for null-low-end rows outside the known non-function list.
-- `test_voltage` is text, not numeric — `120-277` exists (DC12).
-- -----------------------------------------------------------------------------
create table if not exists public.dimming_compat_rows (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  manufacturer text not null,
  dimmer_series text,
  -- Display form, parenthetical intact ("Adorne Touch (ELV)").
  dimmer_model text not null,
  mode_qualifier text check (mode_qualifier in ('elv', 'triac')),
  -- Match key: qualifier stripped, U+2010 fixed, spaces/periods dropped,
  -- uppercased.
  dimmer_model_norm text not null,
  -- 2025-era "Mfr. Related Models" column: verbatim + normalized
  -- (slash-expanded `AYCL-153P/253P` -> both models; bare '-' placeholders
  -- dropped, DC8).
  related_dimmer_models text[] not null default '{}',
  related_dimmer_models_norm text[] not null default '{}',
  phase_type text not null
    check (phase_type in ('adaptive', 'elv', 'triac', 'zero_to_ten_v', 'other')),
  test_voltage text,
  low_end_pct numeric,
  status text not null
    check (status in ('tested_compatible', 'not_recommended', 'not_compatible', 'tested_issue')),
  comments text not null default '',
  extraction_version int not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists dimming_compat_rows_report_idx
  on public.dimming_compat_rows (report_id);
create index if not exists dimming_compat_rows_model_idx
  on public.dimming_compat_rows (dimmer_model_norm);

-- No pg_trgm (not installed; DC15) — fuzzy dimmer matching is TS-side over a
-- broad ilike prefilter, which is simpler, testable in @wac/shared, and adds no
-- extension surface at ~10^4 rows.

-- -----------------------------------------------------------------------------
-- RLS: open read, service-role-only writes (no write policy at all).
-- -----------------------------------------------------------------------------
alter table public.dimming_reports enable row level security;
alter table public.dimming_report_products enable row level security;
alter table public.dimming_compat_rows enable row level security;

create policy dimming_reports_select on public.dimming_reports
  for select using (true);
create policy dimming_report_products_select on public.dimming_report_products
  for select using (true);
create policy dimming_compat_rows_select on public.dimming_compat_rows
  for select using (true);

-- =============================================================================
-- Verify block (0052 idiom) — run as ANON after applying:
--   PASS: select * from dimming_reports limit 1;
--   PASS: select * from dimming_report_products limit 1;
--   PASS: select * from dimming_compat_rows limit 1;
--   DENY: insert into dimming_reports (content_hash) values ('probe');
--   DENY: insert into dimming_report_products (report_id, product_sku, link_kind)
--         values (gen_random_uuid(), 'probe', 'pattern');
--   DENY: insert into dimming_compat_rows (report_id, manufacturer,
--         dimmer_model, dimmer_model_norm, phase_type, status)
--         values (gen_random_uuid(), 'x', 'x', 'X', 'other', 'tested_issue');
--   Unique-hash conflict: inserting two units with the same content_hash (as
--   service role) must raise 23505 on dimming_reports_content_hash_key.
-- Record the sample-run row counts here after the --sample 10 gate (G.3).
-- =============================================================================
