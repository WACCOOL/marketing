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

    hubspot_wanted = wanted & {"deals", "line_items", "companies", "deal_company_assocs"}
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
def train() -> None:
    """Train win-prob + company-sales models."""
    from .train import run_training

    run_training()


@main.command()
def report() -> None:
    """Build the Gate-1 backtest report (artifacts/backtest_report.html)."""
    from .report import build_report

    build_report()


@main.command()
def score() -> None:
    """Score the current book with the latest artifacts (M3/M4)."""
    raise SystemExit("score: not implemented yet (M3)")


@main.command()
@click.option("--dry-run", is_flag=True)
@click.option("--sample", type=int, default=0)
def push(dry_run: bool, sample: int) -> None:
    """Write forecasts to HubSpot — gated behind Gates 1 & 2 (M3)."""
    if not dry_run and not sample and not CONFIG.write_enabled:
        raise SystemExit("push: refusing full write without FORECAST_WRITE=1 (Gate 2)")
    raise SystemExit("push: not implemented yet (M3)")


if __name__ == "__main__":
    main()
