"""Gate-1 backtest report: HTML tables comparing the three methods on
identical snapshots. Written to artifacts/backtest_report.html (local only —
contains dollar figures; never commit)."""

from __future__ import annotations

import pandas as pd

from .backtest import account_company_map, realized_actuals
from .config import CONFIG
from .features.company import parent_map, to_parent
from .metrics import company_metrics, deal_metrics, decile_table, reliability_table
from .snapshot import load_raw, prepare_turnover

STYLE = """
<style>
body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; max-width: 1100px; }
table { border-collapse: collapse; margin: 1rem 0; font-size: 13px; }
th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: right; }
th { background: #f0f0f0; } td:first-child, th:first-child { text-align: left; }
h2 { margin-top: 2.5rem; } .note { color: #555; font-size: 13px; }
</style>
"""


def _fmt_money(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    for c in out.columns:
        if out[c].dtype.kind == "f" and out[c].abs().max() > 1000:
            out[c] = out[c].map(lambda v: f"{v:,.0f}")
    return out


def build_report() -> None:
    out_dir = CONFIG.artifacts_dir / "backtest"
    summary = pd.read_parquet(out_dir / "summary.parquet")

    # Total-level signed % error per method per snapshot.
    tot = summary[["as_of", "year", "actual_full_year", "growth_total", "qv_total_global"]].copy()
    if "ml_total" in summary.columns:
        tot["ml_total"] = summary["ml_total"]
    for m in [c for c in ("growth_total", "qv_total_global", "ml_total") if c in tot.columns]:
        tot[m.replace("_total", "").replace("_global", "") + "_err_pct"] = (
            (tot[m] - tot["actual_full_year"]) / tot["actual_full_year"] * 100
        ).round(1)

    sections = [f"<h1>ML Forecast Backtest — Gate 1</h1>{STYLE}"]
    sections.append(
        "<p class=note>Snapshot grid: first-of-month. 2025 rows score against realized FY-2025; "
        "2026 rows against 2026 actuals to date (partial — treat as directional). "
        "All three methods computed on identical point-in-time reconstructions; "
        "the incumbent quote-visibility replication uses its own closedate semantics, warts and all.</p>"
    )
    sections.append("<h2>Total-year forecasts vs actual</h2>")
    sections.append(_fmt_money(tot).to_html(index=False))

    # Company-level metrics on completed-year snapshots (2025).
    turnover = prepare_turnover(load_raw("turnover_orders"))
    parents = load_raw("company_parents")
    companies = load_raw("companies")
    actuals = realized_actuals(turnover)
    pmap = parent_map(parents)
    acct_map = account_company_map(companies)
    act25 = actuals[2025].copy()
    act25.index = to_parent(act25.index, pmap).values
    act25 = act25.groupby(level=0).sum()

    rows = []
    for label in summary[summary["year"] == 2025]["as_of"]:
        # growth (account grain → parent)
        gr = pd.read_parquet(out_dir / f"growth_{label}.parquet")
        gr_parent = gr["forecast"].copy()
        gr_parent.index = to_parent(gr_parent.index, pmap).values
        gr_parent = gr_parent.groupby(level=0).sum()
        rows.append({"as_of": label, "method": "growth", **company_metrics(gr_parent, act25)})

        # quote-visibility (companyId grain → account via companies → parent)
        qv_path = out_dir / f"qv_{label}.parquet"
        if qv_path.exists():
            qv = pd.read_parquet(qv_path)["projected_sales_quote_visibility"]
            cid_to_acct = pd.Series(
                companies["account_number_"].astype("string").str.strip().str.lstrip("0").values,
                index=companies["hs_object_id"].astype(str),
            )
            qv.index = qv.index.astype(str).map(cid_to_acct)
            qv = qv[qv.index.notna()]
            qv.index = to_parent(qv.index, pmap).values
            qv = qv.groupby(level=0).sum()
            rows.append({"as_of": label, "method": "quote_visibility", **company_metrics(qv, act25)})

        ml_path = out_dir / f"ml_{label}.parquet"
        if ml_path.exists():
            ml = pd.read_parquet(ml_path)["forecast"]
            rows.append({"as_of": label, "method": "ml", **company_metrics(ml, act25)})

    per_co = pd.DataFrame(rows)
    sections.append("<h2>Per-company accuracy (2025 snapshots vs realized FY-2025, parent grain)</h2>")
    sections.append(
        "<p class=note><b>Leakage caveat:</b> the company model TRAINED on snapshots "
        "≤ 2025-08 and validated on 2025-09…12, and every 2025 snapshot shares the same "
        "FY-2025 target — so 2025 rows are optimistic for ML (Jan–Aug in-sample; Sep–Dec "
        "validation). Only one complete year exists; the honest ML evidence is the "
        "deal-level 2026 test slice below plus the 2026 total trajectory. Growth/QV need "
        "no such caveat (formula methods). QV per-company is a quote-channel visibility "
        "number rather than a per-company sales forecast — its poor WAPE here reflects "
        "that scope mismatch as much as inaccuracy.</p>"
    )
    sections.append(
        per_co.pivot_table(index="as_of", columns="method").round(2).to_html()
    )

    # Deal-level: honest test slice.
    deal_rows_path = CONFIG.data_dir / "training" / "deal_rows.parquet"
    if deal_rows_path.exists():
        from .models.win_prob import WinProbModel

        dr = pd.read_parquet(deal_rows_path)
        test = dr[(dr["snapshot"] > "2026-01-01") & dr["labelable"]]
        if len(test):
            win = WinProbModel.load(CONFIG.artifacts_dir / "models" / "latest")
            p = win.predict(test)
            sections.append("<h2>Deal win-probability (test slice: snapshots after 2026-01)</h2>")
            sections.append(pd.DataFrame([deal_metrics(p, test["label"].to_numpy())]).round(4).to_html(index=False))
            sections.append("<h3>Reliability</h3>")
            sections.append(reliability_table(p, test["label"].to_numpy()).round(3).to_html())

    # Decile calibration for the latest completed-year snapshot.
    label = "2025-06-01"
    ml_path = out_dir / f"ml_{label}.parquet"
    if ml_path.exists():
        ml = pd.read_parquet(ml_path)["forecast"]
        sections.append(f"<h2>ML decile calibration ({label} vs FY-2025)</h2>")
        sections.append(_fmt_money(decile_table(ml, act25)).to_html())

    out = CONFIG.artifacts_dir / "backtest_report.html"
    out.write_text("\n".join(sections))
    print(f"report -> {out}")
