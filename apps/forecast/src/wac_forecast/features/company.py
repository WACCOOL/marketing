"""Company-level features + remaining-year target at an as-of date D.

Grain: parent-rolled account (company_parents; accounts without a parent are
their own parent). Target (training): full-year realized sales − YTD at D.
Predictions distribute back to child accounts pro-rata by trailing-12m sales
when written to HubSpot.
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ..snapshot import turnover_through

DAY_MS = 86_400_000

CAT_FEATURES = ["company_type", "company_sub_type", "buying_group", "state_c", "brand_mix"]
NUM_FEATURES = [
    "ytd_sales_at_d", "trailing_3m", "trailing_6m", "trailing_12m", "prior_12_24m",
    "growth_slope", "order_count_12m", "active_months_12m", "recency_days",
    "order_p50", "order_p90", "open_deal_ev", "open_deal_value", "n_open_deals",
    "remaining_share", "month", "national_account_n",
]
ALL_FEATURES = CAT_FEATURES + NUM_FEATURES


def parent_map(company_parents: pd.DataFrame) -> pd.Series:
    """account_key → parent account_key (self when no parent)."""
    cp = company_parents.copy()
    child = cp["account"].astype("string").str.strip().str.lstrip("0")
    parent = cp["parent_account"].astype("string").str.strip().str.lstrip("0")
    m = pd.Series(parent.values, index=child)
    m = m[m.notna() & (m != "")]
    return m.groupby(level=0).first()


def to_parent(keys: pd.Series | pd.Index, pmap: pd.Series) -> pd.Series:
    k = pd.Series(pd.Index(keys).astype("string"), index=pd.RangeIndex(len(keys)))
    mapped = k.map(pmap)
    return mapped.fillna(k)


def seasonality_remaining_share(turnover: pd.DataFrame, as_of_ms: float) -> float:
    """Share of the PRIOR year's global sales that landed after this
    day-of-year — how much of the year is 'still to come' seasonally."""
    d = datetime.fromtimestamp(as_of_ms / 1000, tz=timezone.utc)
    prior_start = datetime(d.year - 1, 1, 1, tzinfo=timezone.utc).timestamp() * 1000
    prior_end = datetime(d.year, 1, 1, tzinfo=timezone.utc).timestamp() * 1000
    try:
        cut = datetime(d.year - 1, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000
    except ValueError:  # Feb 29
        cut = datetime(d.year - 1, 3, 1, tzinfo=timezone.utc).timestamp() * 1000
    t = turnover[(turnover["billing_ms"] >= prior_start) & (turnover["billing_ms"] < prior_end)]
    qty_ok = pd.to_numeric(t["quantity"], errors="coerce").fillna(0) != 0
    t = t[qty_ok]
    total = t["sales_n"].sum()
    late = t[t["billing_ms"] >= cut]["sales_n"].sum()
    return float(late / total) if total > 0 else 0.5


def build_company_features(
    turnover: pd.DataFrame,
    companies: pd.DataFrame,
    company_parents: pd.DataFrame,
    open_deal_ev: pd.DataFrame | None,
    as_of_ms: float,
    actual_full_year: pd.Series | None = None,
) -> pd.DataFrame:
    """Feature matrix per parent account at D. open_deal_ev: frame with
    [account_key, ev, value] from the win-prob model (may be None for the
    no-ML ablation). actual_full_year: per-account realized FY sales (training
    only) — target = actual − ytd, clipped at 0."""
    d = datetime.fromtimestamp(as_of_ms / 1000, tz=timezone.utc)
    year_start = datetime(d.year, 1, 1, tzinfo=timezone.utc).timestamp() * 1000
    pmap = parent_map(company_parents)

    t = turnover_through(turnover, as_of_ms).copy()
    t["parent"] = to_parent(t["account_key"], pmap).values

    def window(days: float) -> pd.Series:
        return t[t["billing_ms"] > as_of_ms - days * DAY_MS].groupby("parent")["sales_n"].sum()

    g = t.groupby("parent")
    t12 = t[t["billing_ms"] > as_of_ms - 365 * DAY_MS]
    g12 = t12.groupby("parent")
    order_sizes = t12.groupby(["parent", "billing_document"])["sales_n"].sum()

    X = pd.DataFrame(
        {
            "ytd_sales_at_d": t[t["billing_ms"] >= year_start].groupby("parent")["sales_n"].sum(),
            "trailing_3m": window(91),
            "trailing_6m": window(182),
            "trailing_12m": window(365),
            "prior_12_24m": t[
                (t["billing_ms"] > as_of_ms - 730 * DAY_MS) & (t["billing_ms"] <= as_of_ms - 365 * DAY_MS)
            ].groupby("parent")["sales_n"].sum(),
            "order_count_12m": g12["billing_document"].nunique(),
            "active_months_12m": g12["billing_ms"].apply(
                lambda s: pd.to_datetime(s, unit="ms", utc=True).dt.to_period("M").nunique()
            ),
            "last_order_ms": g["billing_ms"].max(),
            "order_p50": order_sizes.groupby(level=0).median(),
            "order_p90": order_sizes.groupby(level=0).quantile(0.9),
        }
    ).fillna(0.0)
    X["recency_days"] = ((as_of_ms - X["last_order_ms"]) / DAY_MS).clip(lower=0)
    X = X.drop(columns=["last_order_ms"])
    X["growth_slope"] = np.where(
        X["prior_12_24m"] > 0, X["trailing_12m"] / X["prior_12_24m"] - 1, 0.0
    )

    # Brand mix over trailing 12m (categorical: WAC / SCH / both).
    brands = t12.groupby(["parent", "brand"])["sales_n"].sum().unstack(fill_value=0.0)
    if len(brands):
        wac = brands.get("WAC", 0.0)
        sch = brands.get("SCH", 0.0)
        mix = pd.Series(
            np.where((wac > 0) & (sch > 0), "both", np.where(sch > 0, "SCH", "WAC")),
            index=brands.index,
        )
        X["brand_mix"] = mix.reindex(X.index).fillna("none")
    else:
        X["brand_mix"] = "none"

    # Company classification joined via account number, rolled to parent
    # (parent's own record wins; else the largest child's).
    c = companies[["account_number_", "company_type", "company_sub_type", "national_account", "state"]].copy()
    c["account_key"] = c["account_number_"].astype("string").str.strip().str.lstrip("0")
    c = c.dropna(subset=["account_key"]).drop_duplicates("account_key")
    c["parent"] = to_parent(c["account_key"], pmap).values
    c["is_self"] = c["account_key"] == c["parent"]
    c = c.sort_values("is_self", ascending=False).drop_duplicates("parent")
    c = c.set_index("parent")
    X = X.join(c[["company_type", "company_sub_type", "national_account", "state"]], how="left")
    X = X.rename(columns={"state": "state_c"})
    X["national_account_n"] = (
        X["national_account"].astype("string").str.lower().isin(["true", "yes", "1"]).astype(int)
    )
    X = X.drop(columns=["national_account"])

    if open_deal_ev is not None and len(open_deal_ev):
        ev = open_deal_ev.copy()
        ev["parent"] = to_parent(ev["account_key"], pmap).values
        agg = ev.groupby("parent").agg(
            open_deal_ev=("ev", "sum"), open_deal_value=("value", "sum"), n_open_deals=("ev", "size")
        )
        X = X.join(agg, how="left")
    for col in ("open_deal_ev", "open_deal_value", "n_open_deals"):
        X[col] = X[col].fillna(0.0) if col in X.columns else 0.0

    X["remaining_share"] = seasonality_remaining_share(turnover, as_of_ms)
    X["month"] = d.month

    if actual_full_year is not None:
        act = actual_full_year.copy()
        act.index = to_parent(act.index, pmap).values
        act = act.groupby(level=0).sum()
        X["target_remaining"] = (act.reindex(X.index).fillna(0.0) - X["ytd_sales_at_d"]).clip(lower=0)
    return X
