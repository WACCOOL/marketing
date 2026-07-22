-- =============================================================================
-- Thom Bot — plane 3 (deals by category) capture-forward staging
-- (docs/thom-category-sales-plan.md §C, CS14 semantics; ships with 0065 —
-- 0064 was taken by an in-flight spec-view materialization fix, so the
-- category-sales pair lands as 0065 + 0066).
--
-- deal_quote_lines mirrors the SAP quote lines the Worker push already parses
-- (payload.products in apps/api/src/hubspotPush.ts) so a later category rollup
-- can answer "how much downlight business is in the pipeline" without walking
-- HubSpot per question. CAPTURE-FORWARD only: rows exist for quotes SAP touches
-- post-deploy; history arrives via the documented deals-first weekly walk
-- (plan §C option c — a follow-on script, deliberately not built yet).
--
-- CS14 semantics (pinned):
--   * PK = quote_product_name — the portal's line-item idProperty
--     (packages/shared/src/hubspot/mapping.ts), the same key the push itself
--     upserts by. Deal key = sap_quote_number.
--   * An empty or missing payload.products is a NO-OP — NEVER a delete. SAP
--     payload shapes vary by transaction type; an absent array must not be
--     read as "this quote now has no lines". Line removal happens only through
--     the weekly walk's reconciliation, deliberately, with counts logged (the
--     HubSpot-line-items-zeroed lesson: SAP zeroes, never deletes — neither
--     do we).
--
-- Conventions for the eventual plane-3 rollup (pinned from memory, §C):
--   * qty-0 quote lines (~42%) are intentional quote text — excluded from
--     unit/mix math (same filter as plane 1's qty<>0 rule, different reason).
--   * Dollar totals stay at DEAL grain: open/won = amount, lost = max_amount
--     WITH amount fallback (lostValue(), dealRollups.ts — CS9). Line values
--     are attribution WEIGHTS only; when a deal's lines are all zeroed the
--     tool reports mix only and says value attribution is unavailable.
--
-- Internal/admin read (InitPlan form per CS1); service-role writes only.
-- =============================================================================

create table if not exists public.deal_quote_lines (
  -- The portal line-item idProperty — globally unique per SAP quote line.
  quote_product_name text primary key,
  -- Deal key (deals upsert by idProperty sap_quote_number).
  sap_quote_number text not null,
  quote_line text,
  -- SKU (SAP material__ -> HubSpot hs_sku). Variant-grain, joins the same
  -- product_variant_map as planes 1/2.
  material text,
  material_description text,
  quantity numeric,
  unit_price numeric,
  -- Extended line net value (unit_price x qty), the push's own derivation —
  -- the durable record of what each line was worth (header net value is
  -- zeroed by SAP on rejection/conversion).
  net_value numeric,
  currency text,
  -- Full source line for later columns without a migration.
  raw_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deal_quote_lines_quote_idx
  on public.deal_quote_lines (sap_quote_number);
create index if not exists deal_quote_lines_material_idx
  on public.deal_quote_lines (material);

alter table public.deal_quote_lines enable row level security;

-- Internal/admin read, already in the 0055/CS1 InitPlan form. No
-- insert/update/delete policy: only the service role writes (the push runs on
-- the service client).
drop policy if exists deal_quote_lines_select on public.deal_quote_lines;
create policy deal_quote_lines_select on public.deal_quote_lines
  for select using ((select public.is_active_internal_or_admin()));
