"""Growth-rate method replication (confirmed by Davis 2026-07-13):

    forecast = previous_year_sales × (ytd_sales / prior_ytd_sales)

One GLOBAL growth rate ("we have a sales growth rate then we use that rate
against the prior years total") — per-company YTD ratios are catastrophically
unstable (credit memos leave near-zero prior-YTD denominators; observed
quadrillion-dollar forecasts). Live it runs on the Power-BI-fed company props;
historically those aren't stored, so the backtest reconstructs the same
quantities as-of-D from turnover_orders (billing_date ≤ D, qty-carrying rows
only). Per-company numbers apply the global rate to each company's prior-year
total.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from ..snapshot import turnover_through

DAY_MS = 86_400_000


def _year_ms(year: int) -> float:
    return datetime(year, 1, 1, tzinfo=timezone.utc).timestamp() * 1000


def sales_by_account(t: pd.DataFrame, from_ms: float, to_ms: float) -> pd.Series:
    """Σ discounted_sales per account_key over billing_date ∈ [from, to)."""
    win = t[(t["billing_ms"] >= from_ms) & (t["billing_ms"] < to_ms)]
    return win.groupby("account_key")["sales_n"].sum()


def growth_rate_forecast(turnover: pd.DataFrame, as_of_ms: float) -> pd.DataFrame:
    """Per-account full-year forecast at D + the global ratio used.

    Returns a frame indexed by account_key with columns
    [ytd, prior_ytd, prior_full, forecast]."""
    d = datetime.fromtimestamp(as_of_ms / 1000, tz=timezone.utc)
    year_start = _year_ms(d.year)
    prior_start = _year_ms(d.year - 1)
    t = turnover_through(turnover, as_of_ms)

    ytd = sales_by_account(t, year_start, as_of_ms + 1)
    # Same-day-last-year cutoff, whole day inclusive (mirrors priorYtdEndMs).
    prior_cut = (
        datetime(d.year - 1, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000 + DAY_MS
        if not (d.month == 2 and d.day == 29)
        else datetime(d.year - 1, 3, 1, tzinfo=timezone.utc).timestamp() * 1000
    )
    prior_ytd = sales_by_account(t, prior_start, prior_cut)
    prior_full = sales_by_account(t, prior_start, year_start)

    out = pd.DataFrame({"ytd": ytd, "prior_ytd": prior_ytd, "prior_full": prior_full}).fillna(0.0)
    global_ratio = (
        out["ytd"].sum() / out["prior_ytd"].sum() if out["prior_ytd"].sum() > 0 else 1.0
    )
    out["forecast"] = out["prior_full"] * global_ratio
    out.attrs["global_ratio"] = global_ratio
    return out
