"""Training-set assembly + model training across the snapshot grid.

Data-horizon reality (2 years of history, today mid-2026):
- Win-prob: snapshots 2025-01…2026-07; label = converts within 180d. Split by
  time: train ≤ TRAIN_END, isotonic calibration on (TRAIN_END, CALIB_END],
  honest test > CALIB_END.
- Company sales: only 2025 has a COMPLETE full-year target, so training and
  validation both live inside the 2025 snapshot set (forward-chained); 2026
  snapshots are score-only and judged at the total level in the backtest.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from .backtest import SNAPSHOT_GRID, realized_actuals
from .config import CONFIG
from .features.company import build_company_features
from .features.deal import build_deal_features
from .models.company_sales import train_company_sales
from .models.win_prob import WinProbModel, train_win_prob
from .snapshot import load_raw, prepare_deals, prepare_turnover

TRAIN_END = "2025-09-01"
CALIB_END = "2026-01-01"
CO_TRAIN_END = "2025-08-01"
CO_VALID_END = "2025-12-01"


def _ms(dt: datetime) -> float:
    return dt.timestamp() * 1000


def load_prepared():
    deals = load_raw("deals")
    lines = load_raw("line_items")
    assocs = load_raw("deal_company_assocs")
    companies = load_raw("companies")
    parents = load_raw("company_parents")
    turnover = prepare_turnover(load_raw("turnover_orders"))
    d_prep, li = prepare_deals(deals, lines, assocs)
    return d_prep, li, companies, parents, turnover


def build_deal_rows(d_prep, li, turnover, companies, grid=None, data_end_ms: float | None = None) -> pd.DataFrame:
    grid = grid or SNAPSHOT_GRID
    if data_end_ms is None:
        data_end_ms = float(turnover["billing_ms"].max())
    frames = []
    for dt in grid:
        X = build_deal_features(d_prep, li, turnover, companies, _ms(dt), data_end_ms=data_end_ms)
        X["snapshot"] = dt.strftime("%Y-%m-%d")
        frames.append(X)
        print(f"  deal rows {dt:%Y-%m}: {len(X):,} open deals ({int(X['labelable'].sum()):,} labelable)")
    rows = pd.concat(frames, ignore_index=True)
    out = CONFIG.data_dir / "training"
    out.mkdir(parents=True, exist_ok=True)
    rows.to_parquet(out / "deal_rows.parquet")
    return rows


def score_open_deal_ev(model: WinProbModel, X: pd.DataFrame) -> pd.DataFrame:
    """[account_key, ev, value] per open deal for the company-feature join."""
    p = model.predict(X)
    return pd.DataFrame(
        {
            "account_key": X["account_number"].astype("string").str.strip().str.lstrip("0"),
            "deal_id": X["hs_object_id"],
            "p_win": p,
            "value": X["value_at_d"].to_numpy(),
            "ev": p * X["value_at_d"].to_numpy(),
        }
    )


def build_company_rows(
    deal_rows: pd.DataFrame,
    win_model: WinProbModel,
    turnover,
    companies,
    parents,
    grid=None,
) -> pd.DataFrame:
    grid = grid or SNAPSHOT_GRID
    actuals = realized_actuals(turnover)
    frames = []
    for dt in grid:
        label = dt.strftime("%Y-%m-%d")
        dX = deal_rows[deal_rows["snapshot"] == label]
        ev = score_open_deal_ev(win_model, dX) if len(dX) else None
        actual = actuals[dt.year] if dt.year == 2025 else None  # complete years only
        X = build_company_features(turnover, companies, parents, ev, _ms(dt), actual_full_year=actual)
        X["snapshot"] = label
        frames.append(X.reset_index(names="parent"))
        print(f"  company rows {label}: {len(X):,} parents")
    rows = pd.concat(frames, ignore_index=True)
    out = CONFIG.data_dir / "training"
    out.mkdir(parents=True, exist_ok=True)
    rows.to_parquet(out / "company_rows.parquet")
    return rows


def run_training(reuse_deals: bool = False) -> None:
    print("loading prepared data…")
    d_prep, li, companies, parents, turnover = load_prepared()

    cache = CONFIG.data_dir / "training" / "deal_rows.parquet"
    if reuse_deals and cache.exists():
        print(f"reusing cached deal rows ({cache})")
        deal_rows = pd.read_parquet(cache)
    else:
        print("building deal rows…")
        deal_rows = build_deal_rows(d_prep, li, turnover, companies)

    print("training win-prob…")
    win = train_win_prob(deal_rows, TRAIN_END, CALIB_END)
    print(f"  win-prob: {win.meta}")

    print("building company rows…")
    company_rows = build_company_rows(deal_rows, win, turnover, companies, parents)

    print("training company-sales…")
    trainable = company_rows[company_rows["target_remaining"].notna()]
    co = train_company_sales(trainable, CO_TRAIN_END, CO_VALID_END)
    print(f"  company-sales: {co.meta}")

    model_dir = CONFIG.artifacts_dir / "models" / "latest"
    win.save(model_dir)
    co.save(model_dir)
    print(f"models -> {model_dir}")
