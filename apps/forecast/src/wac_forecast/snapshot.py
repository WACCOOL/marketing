"""Point-in-time reconstruction — the backtest crux.

Two deal-state views per as-of date D:

- "hs" view: what a HubSpot query at D would have returned (stage via
  closedate ≤ D). This is what the INCUMBENT quote-visibility method consumed,
  so its backtest replication must use it — including the SAP bulk
  rejection-sweep closedates on lost deals. Faithful replication, warts and all.
- "true" view: business reality for ML labels/features. Won when
  quote_conversion_date ≤ D; lost when EVERY line carries rejection_date ≤ D
  (deal lost-date = the max line rejection date, never closedate); open
  otherwise — an unresolved recent deal is open, not a loss.

Value-at-D ("true" view) = Σ line net_value over lines unrejected as of D,
falling back to max_amount, then amount, when a deal has no line values.
No post-D information may leak: trailing company features come from
turnover_orders with billing_date ≤ D only.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .config import CONFIG
from .constants import DEAL_STAGE_IDS

DAY_MS = 86_400_000


def _dt_to_ms(dt: pd.Series) -> pd.Series:
    arr = dt.to_numpy(dtype="datetime64[ns]").astype("int64").astype("float64")
    arr[dt.isna().to_numpy()] = np.nan
    return pd.Series(arr / 1e6, index=dt.index)


def to_ms(s: pd.Series) -> pd.Series:
    """HubSpot date strings (ISO or epoch-ms) → float epoch ms (NaN = missing)."""
    if s.dtype.kind in "if":
        return s.astype("float64")
    raw = s.astype("string")
    numeric = pd.to_numeric(raw, errors="coerce")
    dt = pd.to_datetime(raw.where(numeric.isna()), errors="coerce", utc=True, format="mixed")
    return numeric.astype("float64").fillna(_dt_to_ms(dt))


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")


def load_raw(name: str, columns: list[str] | None = None) -> pd.DataFrame:
    path = CONFIG.raw_dir / f"{name}.parquet"
    if not path.exists():
        raise SystemExit(f"missing {path.name} — run `wac-forecast extract` first")
    return pd.read_parquet(path, columns=columns)


def attribute_company(assocs: pd.DataFrame) -> pd.DataFrame:
    """deal_id → company_id per pickRollupCompanyId: unique primary (typeId 5),
    else the sole associated company, else none."""
    a = assocs[["deal_id", "company_id", "type_id"]].drop_duplicates()
    primary = a[a["type_id"] == 5].groupby("deal_id")["company_id"].agg(["nunique", "first"])
    prim_ok = primary[primary["nunique"] == 1]["first"]
    prim_multi = set(primary[primary["nunique"] > 1].index)
    sole = a.groupby("deal_id")["company_id"].agg(["nunique", "first"])
    sole_ok = sole[sole["nunique"] == 1]["first"]
    out = sole_ok.to_dict()
    out.update(prim_ok.to_dict())  # primary wins where present
    for d in prim_multi:
        out.pop(d, None)  # several primaries → unattributable (matches TS null)
    return pd.Series(out, name="company_id").rename_axis("deal_id").reset_index()


def prepare_deals(
    deals: pd.DataFrame, lines: pd.DataFrame, assocs: pd.DataFrame
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Normalize raw parquet into the per-deal / per-line snapshot inputs."""
    d = deals.copy()
    d["created_ms"] = to_ms(d["quote_creation_date"]).fillna(to_ms(d["createdate"]))
    d["closedate_ms"] = to_ms(d["closedate"])
    d["conv_ms"] = to_ms(d["quote_conversion_date"])
    d["amount_n"] = _num(d["amount"])
    d["max_amount_n"] = _num(d["max_amount"])
    d["won_today"] = d["dealstage"] == DEAL_STAGE_IDS["closedWon"]
    d["lost_today"] = d["dealstage"] == DEAL_STAGE_IDS["closedLost"]
    d["prequal_today"] = d["dealstage"] == DEAL_STAGE_IDS["prequal"]
    d["quote"] = d["sap_quote_number"].astype("string").str.strip()

    li = lines.copy()
    li["quote"] = li["sap_quote_number"].astype("string").str.strip()
    li["rej_ms"] = to_ms(li["rejection_date"])
    li["conv_ms"] = to_ms(li["quote_conversion_date"])
    li["net_value_n"] = _num(li["net_value"])

    per_quote = li.groupby("quote").agg(
        n_lines=("quote", "size"),
        # lost-at-D test: every line rejected by D ⇔ max(rej_ms, missing→+inf) ≤ D
        all_rej_ms=("rej_ms", lambda s: s.fillna(np.inf).max()),
        first_conv_ms=("conv_ms", "min"),
        line_value_total=("net_value_n", "sum"),
    )
    d = d.merge(per_quote, left_on="quote", right_index=True, how="left")
    d["all_rej_ms"] = d["all_rej_ms"].fillna(np.inf)
    # Deal-level conversion mirror can lag; earliest line conversion backs it up.
    d["won_ms"] = d[["conv_ms", "first_conv_ms"]].min(axis=1)

    attr = attribute_company(assocs)
    d = d.merge(attr, left_on="hs_object_id", right_on="deal_id", how="left").drop(columns=["deal_id"])
    return d, li


def deal_state_at(d: pd.DataFrame, as_of_ms: float, view: str) -> pd.DataFrame:
    """Deals created by D with status_at_d ∈ {open, won, lost} + value_at_d."""
    snap = d[d["created_ms"] <= as_of_ms].copy()
    if view == "hs":
        won = snap["won_today"] & (snap["closedate_ms"] <= as_of_ms)
        lost = snap["lost_today"] & (snap["closedate_ms"] <= as_of_ms)
    elif view == "true":
        won = snap["won_ms"] <= as_of_ms
        lost = (snap["all_rej_ms"] <= as_of_ms) & ~won
    else:
        raise ValueError(f"unknown view {view!r}")
    snap["status_at_d"] = np.where(won, "won", np.where(lost, "lost", "open"))
    return snap


def value_at(li: pd.DataFrame, d: pd.DataFrame, as_of_ms: float) -> pd.Series:
    """Σ line net_value over lines unrejected as of D, per quote; deals without
    line values fall back to max_amount then amount. Indexed like `d`."""
    alive = li[~(li["rej_ms"] <= as_of_ms)]
    per_quote = alive.groupby("quote")["net_value_n"].sum()
    v = d["quote"].map(per_quote)
    has_lines = d["quote"].map(li.groupby("quote").size()).notna()
    v = v.where(has_lines & v.notna() & (v > 0), np.nan)
    return v.fillna(d["max_amount_n"]).fillna(d["amount_n"]).fillna(0.0)


def turnover_through(turnover: pd.DataFrame, as_of_ms: float) -> pd.DataFrame:
    """Qty-carrying invoiced lines with billing_date ≤ D (split-rep qty-0
    secondary rows repeat discounted_sales and must not be summed)."""
    t = turnover
    if "billing_ms" not in t.columns:
        raise ValueError("call prepare_turnover first")
    qty = _num(t["quantity"]).fillna(0)
    return t[(qty != 0) & (t["billing_ms"] <= as_of_ms)]


def prepare_turnover(turnover: pd.DataFrame) -> pd.DataFrame:
    t = turnover.copy()
    t["billing_ms"] = _dt_to_ms(pd.to_datetime(t["billing_date"], errors="coerce", utc=True))
    t["sales_n"] = _num(t["discounted_sales"]).fillna(0.0)
    t["account_key"] = t["sold_to"].astype("string").str.strip().str.lstrip("0")
    return t
