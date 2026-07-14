"""Per-deal features + win labels at an as-of date D (true view only —
no closedate anywhere near this file; see snapshot.py docstring).

Feature groups:
- deal shape: age, log value-at-D, line counts, line progress shares
- quote classification: project/opportunity/quote type, SAP stage-of-project,
  sales group, state, customization, specifier presence
- line mix: business-unit value shares, mean discount
- company context: type/sub-type, national account, trailing order history

Label (training only): converted within PIPELINE_FRESH_DAYS (180) of D.
Censoring: a row is labelable iff the window closes before the data horizon
OR the deal resolved (won/fully rejected) inside the window.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..constants import PIPELINE_FRESH_DAYS
from ..snapshot import deal_state_at, turnover_through, value_at

DAY_MS = 86_400_000
LABEL_WINDOW_MS = PIPELINE_FRESH_DAYS * DAY_MS

CAT_FEATURES = [
    "project_type", "opportunity_type", "quote_type", "stage_of_project",
    "sales_group", "state", "customization",
    "company_type", "company_sub_type",
]
NUM_FEATURES = [
    "age_days", "log_value", "n_lines", "share_lines_rejected", "share_lines_converted",
    "mean_discount", "n_specifiers", "month",
    "bu_share_top1", "bu_entropy",
    "co_trailing_12m_sales", "co_trailing_3m_sales", "co_order_recency_days",
    "co_order_count_12m", "co_active",
]
ALL_FEATURES = CAT_FEATURES + NUM_FEATURES


def line_progress(li: pd.DataFrame, as_of_ms: float) -> pd.DataFrame:
    """Per-quote line counts and progress shares as of D."""
    g = li.groupby("quote")
    total = g.size().rename("n_lines")
    rejected = li[li["rej_ms"] <= as_of_ms].groupby("quote").size().reindex(total.index, fill_value=0)
    converted = li[li["conv_ms"] <= as_of_ms].groupby("quote").size().reindex(total.index, fill_value=0)
    disc = pd.to_numeric(li["hs_discount_percentage"], errors="coerce")
    mean_disc = disc.groupby(li["quote"]).mean().reindex(total.index)
    out = pd.DataFrame(
        {
            "n_lines": total,
            "share_lines_rejected": rejected / total,
            "share_lines_converted": converted / total,
            "mean_discount": mean_disc,
        }
    )
    return out


def bu_mix(li: pd.DataFrame, as_of_ms: float) -> pd.DataFrame:
    """Business-unit value mix per quote over lines alive at D: top share +
    entropy (how concentrated the quote is)."""
    alive = li[~(li["rej_ms"] <= as_of_ms)].copy()
    alive["bu"] = alive["business_unit"].astype("string").fillna("(none)")
    v = alive.groupby(["quote", "bu"])["net_value_n"].sum().clip(lower=0)
    tot = v.groupby(level=0).sum()
    share = (v / tot).replace([np.inf, -np.inf], np.nan).dropna()
    top1 = share.groupby(level=0).max().rename("bu_share_top1")
    ent = (
        (-share * np.log(share.clip(lower=1e-12)))
        .groupby(level=0)
        .sum()
        .rename("bu_entropy")
    )
    return pd.concat([top1, ent], axis=1)


def company_history(turnover: pd.DataFrame, as_of_ms: float) -> pd.DataFrame:
    """Trailing order-history features per account_key at D."""
    t = turnover_through(turnover, as_of_ms)
    t12 = t[t["billing_ms"] > as_of_ms - 365 * DAY_MS]
    t3 = t[t["billing_ms"] > as_of_ms - 91 * DAY_MS]
    g12 = t12.groupby("account_key")
    out = pd.DataFrame(
        {
            "co_trailing_12m_sales": g12["sales_n"].sum(),
            "co_order_count_12m": g12["billing_document"].nunique(),
            "co_last_order_ms": g12["billing_ms"].max(),
        }
    )
    out["co_trailing_3m_sales"] = t3.groupby("account_key")["sales_n"].sum().reindex(out.index).fillna(0.0)
    out["co_order_recency_days"] = (as_of_ms - out["co_last_order_ms"]) / DAY_MS
    out["co_active"] = (out["co_order_recency_days"] < 92).astype(int)
    return out.drop(columns=["co_last_order_ms"])


def build_deal_features(
    d_prep: pd.DataFrame,
    li: pd.DataFrame,
    turnover: pd.DataFrame,
    as_of_ms: float,
    data_end_ms: float | None = None,
) -> pd.DataFrame:
    """Feature matrix over deals OPEN at D (true view). When data_end_ms is
    given, adds `label` (won within 180d) and `labelable`."""
    snap = deal_state_at(d_prep, as_of_ms, view="true")
    open_deals = snap[snap["status_at_d"] == "open"].copy()
    open_deals["value_at_d"] = value_at(li, open_deals, as_of_ms)

    X = open_deals[
        ["hs_object_id", "quote", "company_id", "account_number", "value_at_d",
         "won_ms", "all_rej_ms", "created_ms"]
        + [c for c in CAT_FEATURES if c in open_deals.columns]
    ].copy()
    X["age_days"] = (as_of_ms - X["created_ms"]) / DAY_MS
    X["log_value"] = np.log1p(X["value_at_d"].clip(lower=0))
    X["month"] = pd.Timestamp(as_of_ms, unit="ms", tz="UTC").month
    X["n_specifiers"] = sum(
        open_deals[f"specifier_type_{i}"].notna().astype(int)
        for i in range(1, 6)
        if f"specifier_type_{i}" in open_deals.columns
    )

    X = X.merge(line_progress(li, as_of_ms), left_on="quote", right_index=True, how="left")
    X = X.merge(bu_mix(li, as_of_ms), left_on="quote", right_index=True, how="left")

    hist = company_history(turnover, as_of_ms)
    acct = X["account_number"].astype("string").str.strip().str.lstrip("0")
    X = X.merge(hist, left_on=acct, right_index=True, how="left")
    for c in ("co_trailing_12m_sales", "co_trailing_3m_sales", "co_order_count_12m", "co_active"):
        X[c] = X[c].fillna(0.0)
    X["co_order_recency_days"] = X["co_order_recency_days"].fillna(9999.0)

    if data_end_ms is not None:
        horizon = as_of_ms + LABEL_WINDOW_MS
        won_in = X["won_ms"].le(horizon) & X["won_ms"].gt(as_of_ms)
        rejected_in = X["all_rej_ms"].le(horizon) & np.isfinite(X["all_rej_ms"])
        X["label"] = won_in.astype(int)
        X["labelable"] = (horizon <= data_end_ms) | won_in | rejected_in
    return X
