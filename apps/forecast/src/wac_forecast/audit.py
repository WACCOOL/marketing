"""Data-quality audit over the parquet cache. Console-only — figures stay
local (public repo). Checks the M0 gate items:

- row counts + date coverage per entity
- turnover split-rep duplication (qty-0 secondary rows) magnitude
- lost-deal amount coverage by close-year cohort (PR #144 reconstruction)
- turnover sold_to ↔ HubSpot company account match rate
- line ↔ deal key join rate (quote_product_name prefix vs sap_quote_number)
"""

from __future__ import annotations

import json

import pandas as pd

from .config import CONFIG
from .constants import DEAL_STAGE_IDS, STAGE_LABELS


def _load(name: str, columns: list[str] | None = None) -> pd.DataFrame:
    path = CONFIG.raw_dir / f"{name}.parquet"
    if not path.exists():
        raise SystemExit(f"missing {path.name} — run `wac-forecast extract` first")
    return pd.read_parquet(path, columns=columns)


def _dates(s: pd.Series) -> str:
    d = pd.to_datetime(s, errors="coerce", utc=True, format="mixed").dropna()
    return f"{d.min():%Y-%m-%d} → {d.max():%Y-%m-%d}" if len(d) else "n/a"


def run_audit() -> None:
    manifest = json.loads((CONFIG.raw_dir / "manifest.json").read_text())
    print("== row counts ==")
    for name, meta in manifest.items():
        print(f"  {name:22s} {meta['rows']:>10,}  pulled {meta['pulled_at']}")

    deals = _load("deals")
    lines = _load("line_items")
    companies = _load("companies")
    turnover = _load("turnover_orders")

    print("\n== date coverage ==")
    print(f"  deals.quote_creation_date   {_dates(deals['quote_creation_date'])}")
    print(f"  deals.closedate             {_dates(deals['closedate'])}")
    print(f"  lines.rejection_date        {_dates(lines['rejection_date'])}")
    print(f"  lines.quote_conversion_date {_dates(lines['quote_conversion_date'])}")
    print(f"  turnover.billing_date       {_dates(turnover['billing_date'])}")

    print("\n== turnover split-rep duplication ==")
    qty = pd.to_numeric(turnover["quantity"], errors="coerce").fillna(0)
    val = pd.to_numeric(turnover["discounted_sales"], errors="coerce").fillna(0)
    zero_qty = (qty == 0) & (val != 0)
    print(f"  qty-0 value-carrying rows: {zero_qty.sum():,} of {len(turnover):,} "
          f"({zero_qty.mean() * 100:.1f}%) — excluded when summing sales")

    print("\n== lost-deal amount coverage by close-year (PR #144 check) ==")
    lost = deals[deals["dealstage"] == DEAL_STAGE_IDS["closedLost"]].copy()
    lost["close_year"] = pd.to_datetime(lost["closedate"], errors="coerce", utc=True, format="mixed").dt.year
    lost["amt"] = pd.to_numeric(lost["amount"], errors="coerce").fillna(0)
    for year, grp in lost.groupby("close_year", dropna=True):
        nonzero = (grp["amt"] > 0).mean() * 100
        print(f"  {int(year)}: {len(grp):>6,} lost deals, {nonzero:5.1f}% with amount > 0")
    print("  (lost closedate = SAP entry cadence — cohorts here are entry-year, not loss-year)")

    print("\n== join rates ==")
    deal_quotes = set(deals["sap_quote_number"].dropna().astype(str))
    line_quotes = lines["sap_quote_number"].dropna().astype(str)
    line_match = line_quotes.isin(deal_quotes).mean() * 100
    print(f"  line→deal (quote key):      {line_match:.1f}% of {len(line_quotes):,} lines")

    accounts = set(companies["account_number_"].dropna().astype(str).str.lstrip("0"))
    sold_to = turnover["sold_to"].dropna().astype(str).str.lstrip("0")
    t_match = sold_to.isin(accounts).mean() * 100
    print(f"  turnover→company (account): {t_match:.1f}% of {len(sold_to):,} order lines")

    acct_by_deal = deals["account_number"].dropna().astype(str).str.lstrip("0")
    d_match = acct_by_deal.isin(accounts).mean() * 100
    print(f"  deal→company (account):     {d_match:.1f}% of {len(acct_by_deal):,} deals")

    print("\n== sanity: stage mix ==")
    stage = deals["dealstage"].map(STAGE_LABELS).fillna("unknown-stage")
    print(stage.value_counts().to_string())
