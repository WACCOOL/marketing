"""wac-forecast CLI. Order of operations: extract → audit → snapshot →
backtest → train → score → push (gated)."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import click
import pandas as pd

from .config import CONFIG

ENTITIES = [
    "deals",
    "line_items",
    "companies",
    "deal_company_assocs",
    "orders",
    "turnover_orders",
    "open_orders",
    "rep_codes",
    "rep_code_zips",
    "company_parents",
]


@click.group()
def main() -> None:
    pass


def _write(name: str, df: pd.DataFrame, manifest: dict) -> None:
    path = CONFIG.raw_dir / f"{name}.parquet"
    df.to_parquet(path, index=False)
    manifest[name] = {
        "rows": int(len(df)),
        "pulled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    print(f"  {name}: {len(df):,} rows -> {path.name}")


@main.command()
@click.option("--only", help="comma-separated subset of: " + ",".join(ENTITIES))
def extract(only: str | None) -> None:
    """Pull HubSpot + Supabase into data/raw/*.parquet."""
    wanted = set(only.split(",")) if only else set(ENTITIES)
    unknown = wanted - set(ENTITIES)
    if unknown:
        raise click.UsageError(f"unknown entities: {sorted(unknown)}")

    manifest_path = CONFIG.raw_dir / "manifest.json"
    manifest: dict = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    hubspot_wanted = wanted & {"deals", "line_items", "companies", "deal_company_assocs", "orders"}
    if hubspot_wanted:
        from .extract.hubspot import HubSpot

        hs = HubSpot()
        if "deals" in wanted:
            print("extracting deals…")
            _write("deals", hs.extract_deals(), manifest)
        if "line_items" in wanted:
            print("extracting line_items…")
            _write("line_items", hs.extract_line_items(), manifest)
        if "companies" in wanted:
            print("extracting companies…")
            _write("companies", hs.extract_companies(), manifest)
        if "orders" in wanted:
            print("extracting orders (invoiced, ~1.1M — slow)…")
            _write("orders", hs.extract_orders(), manifest)
        if "deal_company_assocs" in wanted:
            deals_path = CONFIG.raw_dir / "deals.parquet"
            if not deals_path.exists():
                raise click.UsageError("deal_company_assocs needs deals.parquet — extract deals first")
            deal_ids = pd.read_parquet(deals_path, columns=["hs_object_id"])["hs_object_id"].tolist()
            print(f"extracting deal_company_assocs for {len(deal_ids):,} deals…")
            _write("deal_company_assocs", hs.extract_deal_company_assocs(deal_ids), manifest)

    supabase_wanted = wanted & {"turnover_orders", "open_orders", "rep_codes", "rep_code_zips", "company_parents"}
    if supabase_wanted:
        from .extract import supabase_db as sb

        db = sb.client()
        pulls = {
            "turnover_orders": sb.extract_turnover_orders,
            "open_orders": sb.extract_open_orders,
            "rep_codes": sb.extract_rep_codes,
            "rep_code_zips": sb.extract_rep_code_zips,
            "company_parents": sb.extract_company_parents,
        }
        for name, fn in pulls.items():
            if name in wanted:
                print(f"extracting {name}…")
                _write(name, fn(db), manifest)

    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"manifest -> {manifest_path}")


@main.command()
def audit() -> None:
    """Data-quality audit over the parquet cache (no network)."""
    from .audit import run_audit

    run_audit()


@main.command()
@click.option("--as-of", "as_of", required=True, help="YYYY-MM-DD")
def snapshot(as_of: str) -> None:
    """Build one point-in-time snapshot (M1)."""
    raise SystemExit("snapshot: not implemented yet (M1)")


@main.command()
@click.option("--ml", is_flag=True, help="include the ML method (needs trained models)")
def backtest(ml: bool) -> None:
    """Monthly snapshots × all methods × metrics."""
    from .backtest import run_backtest

    run_backtest(include_ml=ml)


@main.command()
@click.option("--reuse-deals", is_flag=True, help="reuse cached deal_rows.parquet")
def train(reuse_deals: bool) -> None:
    """Train win-prob + company-sales models."""
    from .train import run_training

    run_training(reuse_deals=reuse_deals)


@main.command()
def report() -> None:
    """Build the Gate-1 backtest report (artifacts/backtest_report.html)."""
    from .report import build_report

    build_report()


@main.command()
def score() -> None:
    """Score the current book with the latest models -> artifacts/score_latest."""
    from datetime import datetime, timezone

    from .features.company import parent_map
    from .models.company_sales import CompanySalesModel
    from .models.win_prob import WinProbModel
    from .scoring import distribute_to_accounts, ml_forecast_at
    from .train import load_prepared

    model_dir = CONFIG.artifacts_dir / "models" / "latest"
    win = WinProbModel.load(model_dir)
    co = CompanySalesModel.load(model_dir)
    d_prep, li, companies, parents, turnover = load_prepared()

    now = datetime.now(timezone.utc)
    ml = ml_forecast_at(now, win, co, d_prep, li, turnover, companies, parents)
    per_account = distribute_to_accounts(
        ml["per_parent"], turnover, parent_map(parents), now.timestamp() * 1000
    )

    out = CONFIG.artifacts_dir / "score_latest"
    out.mkdir(parents=True, exist_ok=True)
    ml["per_parent"].to_parquet(out / "per_parent.parquet")
    per_account.to_parquet(out / "per_account.parquet")
    ml["per_deal"].to_parquet(out / "per_deal.parquet")
    print(
        f"scored {len(ml['per_deal']):,} open deals, {len(ml['per_parent']):,} parents; "
        f"total-year forecast ${ml['total']:,.0f} "
        f"(sum of companies ${ml['sum_parents']:,.0f}, uplift {ml['uplift_share']*100:.1f}%)"
    )
    print(f"artifacts -> {out}")

    # forecast_runs log + drift guardrail (skipped when Supabase creds absent;
    # a missing table — migration not yet applied — warns instead of failing
    # so local scoring keeps working, but the drift guardrail then can't run).
    if CONFIG.supabase_url and CONFIG.supabase_service_role_key:
        from .extract.supabase_db import client as sb_client

        db = sb_client()
        try:
            db.table("forecast_runs").select("id").limit(1).execute()
        except Exception as e:  # noqa: BLE001
            print(f"[warn] forecast_runs unavailable ({e}); skipping run log + drift check")
            return
        prev = (
            db.table("forecast_runs")
            .select("total_forecast,run_at")
            .eq("method", "ml")
            .eq("forecast_year", now.year)
            .order("run_at", desc=True)
            .limit(1)
            .execute()
            .data
        )
        db.table("forecast_runs").insert(
            {
                "method": "ml",
                "forecast_year": now.year,
                "total_forecast": round(ml["total"], 2),
                "sum_companies": round(ml["sum_parents"], 2),
                "uplift_share": round(ml["uplift_share"], 4),
                "n_companies": int(len(ml["per_parent"])),
                "n_open_deals": int(len(ml["per_deal"])),
                "model_version": win.meta.get("train_end", "unknown"),
            }
        ).execute()
        if prev:
            prev_total = float(prev[0]["total_forecast"])
            if prev_total > 0:
                move = abs(ml["total"] - prev_total) / prev_total
                print(f"day-over-day total move: {move*100:.1f}%")
                if move > 0.15:
                    raise SystemExit(
                        f"drift guardrail: total moved {move*100:.1f}% vs last run "
                        f"— refusing to proceed (investigate before pushing)"
                    )


@main.command()
@click.option("--dry-run", is_flag=True)
@click.option("--sample", type=int, default=0)
def push(dry_run: bool, sample: int) -> None:
    """Write forecasts to HubSpot — gated behind Gates 1 & 2."""
    from .hubspot_write import run_push

    run_push(dry_run=dry_run, sample=sample)


@main.command("models-upload")
def models_upload() -> None:
    """Upload artifacts/models/latest to R2 and point latest.txt at it."""
    from .r2 import upload_models

    upload_models(CONFIG.artifacts_dir / "models" / "latest")


@main.command("models-download")
def models_download() -> None:
    """Download the current R2 model version into artifacts/models/latest."""
    from .r2 import download_models

    download_models(CONFIG.artifacts_dir / "models" / "latest")


if __name__ == "__main__":
    main()
