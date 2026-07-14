"""ML scoring at an as-of date: per-deal P(win)/EV, per-parent company
forecast, and the composed total (Σ parents + new-customer uplift).

Used by the backtest (historical D) and the production `score` command
(D = now). The uplift term covers sales landing on accounts with NO turnover
history at D — the company model can't see them; their share is measured on
the last complete year at the same month position.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from .features.company import build_company_features
from .features.deal import build_deal_features
from .models.company_sales import CompanySalesModel
from .models.win_prob import WinProbModel
from .train import score_open_deal_ev


def _ms(dt: datetime) -> float:
    return dt.timestamp() * 1000


def new_customer_share(turnover: pd.DataFrame, ref_year: int, month: int) -> float:
    """Share of ref_year's full-year sales from accounts with zero sales
    through the same month position of ref_year (billing grain, qty rows)."""
    start = _ms(datetime(ref_year, 1, 1, tzinfo=timezone.utc))
    end = _ms(datetime(ref_year + 1, 1, 1, tzinfo=timezone.utc))
    cut = _ms(datetime(ref_year, month, 1, tzinfo=timezone.utc))
    qty_ok = pd.to_numeric(turnover["quantity"], errors="coerce").fillna(0) != 0
    t = turnover[qty_ok & turnover["billing_ms"].notna()]
    fy = t[(t["billing_ms"] >= start) & (t["billing_ms"] < end)]
    seen_before_cut = set(t[t["billing_ms"] < cut]["account_key"])
    total = fy["sales_n"].sum()
    if total <= 0:
        return 0.0
    new = fy[~fy["account_key"].isin(seen_before_cut)]["sales_n"].sum()
    return float(new / total)


def ml_forecast_at(
    dt: datetime,
    win: WinProbModel,
    co: CompanySalesModel,
    d_prep: pd.DataFrame,
    li: pd.DataFrame,
    turnover: pd.DataFrame,
    companies: pd.DataFrame,
    parents: pd.DataFrame,
    uplift_ref_year: int = 2025,
) -> dict:
    D = _ms(dt)
    deal_X = build_deal_features(d_prep, li, turnover, D)
    ev = score_open_deal_ev(win, deal_X) if len(deal_X) else None

    co_X = build_company_features(turnover, companies, parents, ev, D)
    remaining = co.predict_remaining(co_X)
    per_parent = pd.DataFrame(
        {
            "ytd": co_X["ytd_sales_at_d"],
            "remaining_pred": remaining,
            "forecast": co_X["ytd_sales_at_d"] + remaining,
        },
        index=co_X.index,
    )

    uplift = new_customer_share(turnover, uplift_ref_year, dt.month)
    total = float(per_parent["forecast"].sum()) / max(1e-9, 1 - uplift)
    return {
        "per_parent": per_parent,
        "per_deal": ev,
        "total": total,
        "uplift_share": uplift,
        "sum_parents": float(per_parent["forecast"].sum()),
    }
