"""HubSpot write path — gated. Order of operations (per the approved plan):
Gate 1 (backtest report approved) → property creation → --dry-run →
--sample spot-check (Gate 2) → full backfill (requires FORECAST_WRITE=1) →
daily cron.

Properties written:
- company `projected_sales_ml`  ("Projected Sales (ML)")
- deal    `ml_win_probability`  ("ML Win Probability", 0–1)
- deal    `ml_expected_value`   ("ML Expected Value")
"""

from __future__ import annotations

import time

import pandas as pd

from .config import CONFIG
from .extract.hubspot import HubSpot

BATCH = 100

COMPANY_PROPS = [
    {"name": "projected_sales_ml", "label": "Projected Sales (ML)", "groupName": "companyinformation"},
]
DEAL_PROPS = [
    {"name": "ml_win_probability", "label": "ML Win Probability", "groupName": "dealinformation"},
    {"name": "ml_expected_value", "label": "ML Expected Value", "groupName": "dealinformation"},
]


def ensure_properties(hs: HubSpot) -> None:
    for object_type, defs in (("companies", COMPANY_PROPS), ("deals", DEAL_PROPS)):
        have = hs.existing_properties(object_type)
        for d in defs:
            if d["name"] in have:
                continue
            hs.request(
                "POST",
                f"/crm/v3/properties/{object_type}",
                json={**d, "type": "number", "fieldType": "number"},
            )
            print(f"created {object_type} property {d['name']}")


def batch_update(hs: HubSpot, object_type: str, updates: list[dict]) -> int:
    ok = 0
    for i in range(0, len(updates), BATCH):
        chunk = updates[i : i + BATCH]
        r = hs.request(
            "POST", f"/crm/v3/objects/{object_type}/batch/update", json={"inputs": chunk}
        )
        ok += len(r.get("results", chunk))
        time.sleep(0.2)
    return ok


def build_company_updates(per_account: pd.DataFrame, companies: pd.DataFrame) -> list[dict]:
    """per_account: index account_key, column `forecast` → company batch inputs."""
    c = companies[["hs_object_id", "account_number_"]].dropna()
    key = c["account_number_"].astype("string").str.strip().str.lstrip("0")
    acct_to_id = pd.Series(c["hs_object_id"].astype(str).values, index=key).groupby(level=0).first()
    joined = per_account.join(acct_to_id.rename("company_hs_id"), how="inner")
    return [
        {"id": r.company_hs_id, "properties": {"projected_sales_ml": round(float(r.forecast), 2)}}
        for r in joined.itertuples()
    ]


def build_deal_updates(per_deal: pd.DataFrame) -> list[dict]:
    return [
        {
            "id": str(r.deal_id),
            "properties": {
                "ml_win_probability": round(float(r.p_win), 4),
                "ml_expected_value": round(float(r.ev), 2),
            },
        }
        for r in per_deal.itertuples()
    ]


def run_push(dry_run: bool, sample: int) -> None:
    score_dir = CONFIG.artifacts_dir / "score_latest"
    acc_path = score_dir / "per_account.parquet"
    deal_path = score_dir / "per_deal.parquet"
    if not acc_path.exists() or not deal_path.exists():
        raise SystemExit("no score output — run `wac-forecast score` first")
    per_account = pd.read_parquet(acc_path)
    per_deal = pd.read_parquet(deal_path)

    from .snapshot import load_raw

    companies = load_raw("companies")
    company_updates = build_company_updates(per_account, companies)
    deal_updates = build_deal_updates(per_deal)

    if sample:
        # Spot-check set = the LARGEST forecasts/EVs — recognizable accounts.
        company_updates = sorted(
            company_updates, key=lambda u: -u["properties"]["projected_sales_ml"]
        )[:sample]
        deal_updates = sorted(
            deal_updates, key=lambda u: -u["properties"]["ml_expected_value"]
        )[: sample * 4]

    print(f"prepared {len(company_updates):,} company + {len(deal_updates):,} deal updates")
    if dry_run:
        print("DRY RUN — first 5 of each:")
        for u in company_updates[:5]:
            print(" ", u)
        for u in deal_updates[:5]:
            print(" ", u)
        return

    if not sample and not CONFIG.write_enabled:
        raise SystemExit("full write requires FORECAST_WRITE=1 (Gate 2)")

    hs = HubSpot()
    ensure_properties(hs)
    n_c = batch_update(hs, "companies", company_updates)
    n_d = batch_update(hs, "deals", deal_updates)
    print(f"updated {n_c:,} companies, {n_d:,} deals")
