"""Backtest harness: monthly snapshots × methods × metrics.

Snapshot grid: first-of-month 2025-01 … 2026-07 (2024 is warm-up). Each
snapshot produces per-method full-year total forecasts and per-company
forecasts; actuals come from turnover_orders. Results land in
artifacts/backtest/ (gitignored) for the report step.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from .baselines.growth_rate import growth_rate_forecast, sales_by_account
from .baselines.qv_replay import quote_visibility_at
from .config import CONFIG
from .snapshot import load_raw, prepare_deals, prepare_turnover

SNAPSHOT_GRID = [
    datetime(y, m, 1, tzinfo=timezone.utc)
    for y, months in ((2025, range(1, 13)), (2026, range(1, 8)))
    for m in months
]


def _ms(dt: datetime) -> float:
    return dt.timestamp() * 1000


def account_company_map(companies: pd.DataFrame) -> pd.Series:
    """account_key → HubSpot company id (for joining turnover-grain forecasts
    to company-grain forecasts)."""
    c = companies[["hs_object_id", "account_number_"]].dropna()
    key = c["account_number_"].astype("string").str.strip().str.lstrip("0")
    return pd.Series(c["hs_object_id"].values, index=key).groupby(level=0).first()


def realized_actuals(turnover: pd.DataFrame) -> dict[int, pd.Series]:
    """Per-account realized sales per calendar year (qty-carrying rows)."""
    out: dict[int, pd.Series] = {}
    for year in (2024, 2025, 2026):
        start = _ms(datetime(year, 1, 1, tzinfo=timezone.utc))
        end = _ms(datetime(year + 1, 1, 1, tzinfo=timezone.utc))
        t = turnover[turnover["billing_ms"].notna()]
        qty_ok = pd.to_numeric(t["quantity"], errors="coerce").fillna(0) != 0
        win = t[qty_ok & (t["billing_ms"] >= start) & (t["billing_ms"] < end)]
        out[year] = win.groupby("account_key")["sales_n"].sum()
    return out


def run_backtest(grid: list[datetime] | None = None) -> pd.DataFrame:
    grid = grid or SNAPSHOT_GRID
    print("loading raw parquet…")
    deals = load_raw("deals")
    lines = load_raw("line_items")
    assocs = load_raw("deal_company_assocs")
    companies = load_raw("companies")
    turnover = prepare_turnover(load_raw("turnover_orders"))

    d_prep, _li = prepare_deals(deals, lines, assocs)
    actuals = realized_actuals(turnover)
    acct_map = account_company_map(companies)

    out_dir = CONFIG.artifacts_dir / "backtest"
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = []
    for dt in grid:
        D = _ms(dt)
        label = dt.strftime("%Y-%m-%d")
        year = dt.year
        actual_total = float(actuals[year].sum())

        gr = growth_rate_forecast(turnover, D)
        qvr = quote_visibility_at(d_prep, turnover, D)

        qv_company = pd.DataFrame.from_dict(qvr["per_company"], orient="index")
        qv_total_companies = float(qv_company["projected_sales_quote_visibility"].sum()) if len(qv_company) else 0.0

        rows.append(
            {
                "as_of": label,
                "year": year,
                "actual_full_year": actual_total,
                "growth_total": float(gr["forecast"].sum()),
                "qv_total_global": qvr["global_total"],
                "qv_total_companies": qv_total_companies,
                **{f"qv_{k}": v for k, v in qvr["rates"].items()},
            }
        )

        # Persist per-company frames for metric computation / the report.
        gr.assign(company_id=gr.index.map(acct_map)).to_parquet(out_dir / f"growth_{label}.parquet")
        if len(qv_company):
            qv_company.rename_axis("company_id").to_parquet(out_dir / f"qv_{label}.parquet")
        print(
            f"  {label}: actual FY ${actual_total:,.0f} | growth ${rows[-1]['growth_total']:,.0f} "
            f"| QV ${qvr['global_total']:,.0f} (vis {qvr['rates']['visibilityRate'] and qvr['rates']['visibilityRate']*100:.2f}%, "
            f"yield {qvr['rates']['pipelineYield'] and qvr['rates']['pipelineYield']*100:.2f}%)"
        )

    summary = pd.DataFrame(rows)
    summary.to_parquet(out_dir / "summary.parquet")
    summary.to_csv(out_dir / "summary.csv", index=False)
    print(f"summary -> {out_dir / 'summary.csv'}")
    return summary
