-- =============================================================================
-- Open Orders — Customer Risk Codes legend (code -> meaning)
--
-- The daily SAP "Open Orders Master" workbook carries a "Customer Risk Codes"
-- tab mapping each risk code to a concise Code Description and a longer Meaning
-- (policy text). The open-orders parser upserts that legend here so the HubSpot
-- push (which runs decoupled from the parse, reading only Supabase) can render
-- the codes as dropdown labels on the Order: value = the code, label = meaning.
--
-- Non-destructive: codes are upserted on (code); stale codes are kept as
-- harmless history. Internal/admin read; service-role writes.
-- =============================================================================

create table if not exists public.open_order_risk_codes (
  code text primary key,            -- SAP Risk Code (e.g. "102", "COD"), trimmed
  code_description text,            -- concise label (e.g. "Poor Payer")
  meaning text,                     -- longer policy text (may be null)
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- RLS: internal/admin read; service role writes (no insert/update/delete policy).
-- -----------------------------------------------------------------------------
alter table public.open_order_risk_codes enable row level security;

drop policy if exists open_order_risk_codes_select on public.open_order_risk_codes;
create policy open_order_risk_codes_select on public.open_order_risk_codes
  for select using (public.is_active_internal_or_admin());
