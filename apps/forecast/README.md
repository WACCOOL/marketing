# @wac/forecast — ML sales forecasting (third method)

Python app that builds the ML-based sales forecast alongside the two incumbent
methods (growth-rate and `projected_sales_quote_visibility`). Extraction →
point-in-time snapshots → backtest vs incumbents → (after approval) daily
scoring that writes `projected_sales_ml` (company) and `ml_win_probability` /
`ml_expected_value` (deal).

> **This repo is PUBLIC. Never commit anything under `data/` or `artifacts/`
> (gitignored), and never paste dollar figures, customer names, or extracted
> records into commits or PR bodies.**

## Setup

Requires [uv](https://docs.astral.sh/uv/) and OpenMP for LightGBM
(`brew install uv libomp`).

```bash
cd apps/forecast
# Optional but recommended on OneDrive checkouts: keep the venv off OneDrive
export UV_PROJECT_ENVIRONMENT="$HOME/.venvs/wac-forecast"
uv sync
```

Secrets: `apps/forecast/.env` (gitignored) with the same variable names the
Node apps / GitHub Actions use — see `.env.example`. If `.env` is absent,
config falls back to reading `apps/api/.dev.vars` locally, which already has
everything needed (`HUBSPOT_TOKEN`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `R2_*`).

## Commands

```bash
uv run wac-forecast extract            # pull HubSpot + Supabase → data/raw/*.parquet
uv run wac-forecast extract --only deals,line_items
uv run wac-forecast audit              # data-quality audit printout (row counts, coverage)
uv run wac-forecast snapshot --as-of 2025-06-01   # build one point-in-time snapshot
uv run wac-forecast backtest           # monthly snapshots × all methods × metrics
uv run wac-forecast train              # train win-prob + company-sales models
uv run wac-forecast score              # score current book with the latest artifacts
uv run wac-forecast push --dry-run     # HubSpot write path (gated; see below)
uv run pytest
```

## Write gates

`push` refuses to run without `--dry-run` or `--sample=N` until
`FORECAST_WRITE=1` is set — mirror of the sales-sync/stage-prob gating. The
production order is: Gate 1 (backtest report approved) → property creation →
`--dry-run` → `--sample` spot-check (Gate 2) → full backfill → daily cron.

## Layout

- `src/wac_forecast/extract/` — HubSpot (deals, line items, companies,
  deal↔company associations) and Supabase (turnover_orders, open_orders,
  rep codes, company_parents) pulls, cached as parquet in `data/raw/` with a
  `manifest.json`.
- `src/wac_forecast/snapshot.py` — as-of-date reconstruction. Lost-by-D is
  derived from line `rejection_date` (never `closedate`, which carries SAP's
  bulk rejection-entry cadence).
- `src/wac_forecast/baselines/` — Python ports of the two incumbent methods
  for apples-to-apples backtesting.
- `src/wac_forecast/models/` — LightGBM win-probability + company-sales.
- `data/`, `artifacts/` — local only, gitignored.
