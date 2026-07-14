-- ML forecast run log (apps/forecast). One row per scoring run per method:
-- the total-year forecast + model/version metadata. Doubles as monitoring
-- history (forecast-vs-actual over time) and powers the >15% day-over-day
-- drift guardrail in the scheduled job.

create table if not exists public.forecast_runs (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  method text not null,                        -- 'ml' (baselines optional later)
  forecast_year int not null,
  total_forecast numeric not null,
  sum_companies numeric,                       -- pre-uplift Σ of company forecasts
  uplift_share numeric,                        -- new-customer share applied
  n_companies int,
  n_open_deals int,
  model_version text,                          -- e.g. models/2026-07/ R2 prefix
  metrics jsonb not null default '{}'::jsonb   -- free-form diagnostics
);

create index if not exists forecast_runs_run_at_idx
  on public.forecast_runs (method, run_at desc);

alter table public.forecast_runs enable row level security;

-- Server-side only (service role bypasses RLS). Authenticated app users may
-- read the history for a future dashboard tile.
drop policy if exists "forecast_runs_read" on public.forecast_runs;
create policy "forecast_runs_read" on public.forecast_runs
  for select to authenticated using (true);
