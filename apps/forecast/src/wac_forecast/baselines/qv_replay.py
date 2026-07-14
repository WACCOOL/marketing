"""Replay the incumbent quote-visibility method at a historical as-of date.

Mirrors runDealRollups (apps/sales-sync/src/dealRollups.ts) sweep-for-sweep,
but sources deal state from the point-in-time snapshot ("hs" view — closedate
semantics, exactly what the live job's HubSpot queries would have returned)
and global sales figures from turnover_orders instead of the Power-BI props
(which keep no history).

Known replication approximations (documented for the backtest report):
- preQualified is today's stage for still-open deals (stage history is too
  short to know a deal's stage at D) — same information the live job embeds
  at query time.
- Deal `amount` is today's value. Post-PR-#144 lost amounts are reconstructed
  line sums, so today's amount ≈ the amount live saw at D.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from ..snapshot import deal_state_at
from . import quote_visibility as qv
from .growth_rate import sales_by_account


def _rows(df: pd.DataFrame, fields: dict[str, str]) -> list[dict]:
    out = df[list(fields.values())].rename(columns={v: k for k, v in fields.items()})
    recs = out.to_dict("records")
    for r in recs:
        for k, v in r.items():
            if pd.isna(v):
                r[k] = None
    return recs


def quote_visibility_at(d_prep: pd.DataFrame, turnover: pd.DataFrame, as_of_ms: float) -> dict:
    w = qv.deal_rollup_windows(as_of_ms)
    snap = deal_state_at(d_prep, as_of_ms, view="hs").copy()
    snap["companyId"] = snap["company_id"]

    year = datetime.fromtimestamp(as_of_ms / 1000, tz=timezone.utc).year
    two_years_back = qv.date_utc(year - 2, 0, 1)

    won_all = snap[snap["status_at_d"] == "won"]
    lost_all = snap[snap["status_at_d"] == "lost"]
    open_all = snap[snap["status_at_d"] == "open"]

    fields_won = {"companyId": "companyId", "closedateMs": "closedate_ms",
                  "createdateMs": "created_ms", "amount": "amount_n"}
    fields_lost = {**fields_won, "maxAmount": "max_amount_n"}

    won = _rows(won_all[won_all["closedate_ms"] >= w["priorStartMs"]], fields_won)
    lost = _rows(lost_all[lost_all["closedate_ms"] >= as_of_ms - 365 * qv.DAY_MS], fields_lost)
    # Live sweep: dealstage NOT_IN (won, lost, prequal). Stage-at-D is
    # unknowable; exclude deals that are open-and-prequal TODAY.
    open_df = open_all[~(open_all["prequal_today"] & ~open_all["won_today"] & ~open_all["lost_today"])]
    open_df = open_df[(open_df["created_ms"] >= w["pipelineFreshFloorMs"])
                      & (open_df["created_ms"] < w["pipelineCreateCeilingMs"])]
    open_rows = _rows(open_df, {"companyId": "companyId", "createdateMs": "created_ms", "amount": "amount_n"})

    # Creation cohorts: closure facts truncated to D (post-D closes were open).
    cohort_src = snap[(snap["created_ms"] >= two_years_back) & (snap["created_ms"] < w["ytdStartMs"])]
    prior_cohort = _rows(
        cohort_src.assign(
            won_at_d=lambda x: x["status_at_d"] == "won",
            prequal_at_d=lambda x: x["prequal_today"] & (x["status_at_d"] == "open"),
        ),
        {"createdateMs": "created_ms", "closedateMs": "closedate_ms",
         "won": "won_at_d", "preQualified": "prequal_at_d",
         "amount": "amount_n", "maxAmount": "max_amount_n"},
    )
    for r in prior_cohort:  # a post-D closedate was not yet known at D
        if r["closedateMs"] is not None and r["closedateMs"] > as_of_ms:
            r["closedateMs"] = None
            r["won"] = False
    this_cohort_df = snap[snap["created_ms"] >= w["ytdStartMs"]]
    this_cohort = _rows(this_cohort_df, {"companyId": "companyId", "createdateMs": "created_ms",
                                         "amount": "amount_n", "maxAmount": "max_amount_n"})

    # Global rates — turnover replaces the Power-BI props.
    ytd_sales = sales_by_account(turnover, w["ytdStartMs"], as_of_ms + 1).sum()
    prior_fy_sales = sales_by_account(turnover, w["priorStartMs"], w["priorYearEndMs"]).sum()
    prior_fy_wins = sum(
        (r["amount"] or 0) for r in won
        if r["closedateMs"] is not None and w["priorStartMs"] <= r["closedateMs"] < w["priorYearEndMs"]
    )
    visibility_rate = prior_fy_wins / prior_fy_sales if prior_fy_sales > 0 and prior_fy_wins > 0 else None

    snapshot_ms = w["priorYtdEndMs"] - qv.DAY_MS
    yield_res = qv.pipeline_in_year_yield(prior_cohort, snapshot_ms, w["priorYearEndMs"])

    seasonality = qv.creation_seasonality(prior_cohort, year - 1)
    this_count = sum(
        1 for r in this_cohort
        if r["createdateMs"] is not None and w["ytdStartMs"] <= r["createdateMs"] <= as_of_ms
    )
    prior_count = sum(
        1 for r in prior_cohort
        if r["createdateMs"] is not None and w["priorStartMs"] <= r["createdateMs"] < w["priorYtdEndMs"]
    )
    yoy = this_count / prior_count if prior_count > 0 and this_count > 0 else 1.0
    future_creation = qv.expected_future_creation_wins(seasonality, as_of_ms, yoy)

    creation_value = {}
    total_creation = 0.0
    for r in this_cohort:
        v = qv.lost_value({"maxAmount": r["maxAmount"], "amount": r["amount"]}) or 0
        if v <= 0:
            continue
        total_creation += v
        cid = r["companyId"]
        if cid is not None:
            creation_value[cid] = creation_value.get(cid, 0.0) + v
    creation_by_company = (
        {c: v / total_creation * future_creation for c, v in creation_value.items()}
        if total_creation > 0 and future_creation > 0
        else {}
    )

    attributed = {
        "won": [r for r in won if r["companyId"] is not None],
        "lost": [r for r in lost if r["companyId"] is not None],
        "open": [r for r in open_rows if r["companyId"] is not None],
        "creationByCompany": creation_by_company,
    }
    rates = {"pipelineYield": yield_res["yield"], "visibilityRate": visibility_rate}
    per_company = qv.aggregate_extended_rollups(attributed, w, rates)

    # Global projection INCLUDING unattributed deals (total-forecast comparison
    # should not drop value merely because a deal lacks a primary company).
    ytd_won_global = sum(
        (r["amount"] or 0) for r in won
        if r["closedateMs"] is not None and w["ytdStartMs"] <= r["closedateMs"] <= as_of_ms
    )
    pipeline_global = sum(
        (r["amount"] or 0) * (yield_res["yield"] or 0)
        for r in open_rows
        if r["createdateMs"] is not None
        and w["pipelineFreshFloorMs"] <= r["createdateMs"] < w["pipelineCreateCeilingMs"]
    )
    global_total = (
        (ytd_won_global + pipeline_global + future_creation) / visibility_rate
        if visibility_rate
        else 0.0
    )

    return {
        "per_company": per_company,
        "global_total": global_total,
        "rates": {
            "visibilityRate": visibility_rate,
            "pipelineYield": yield_res["yield"],
            "yoyFactor": yoy,
            "futureCreationGlobal": future_creation,
            "ytdWonGlobal": ytd_won_global,
            "ytdSales": float(ytd_sales),
            "priorFySales": float(prior_fy_sales),
            "priorFyWins": prior_fy_wins,
        },
    }
