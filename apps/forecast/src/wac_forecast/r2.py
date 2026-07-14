"""Model artifact storage in R2 (public repo — models never go to git).

Layout: forecast/models/<YYYY-MM>/<file> plus forecast/models/latest.txt
holding the current version prefix."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import boto3

from .config import CONFIG

MODEL_FILES = [
    "win_prob.txt", "win_prob_iso.json", "win_prob_meta.json",
    "company_sales.txt", "company_sales_meta.json",
]


def _client():
    CONFIG.require("r2_endpoint", "r2_access_key_id", "r2_secret_access_key")
    return boto3.client(
        "s3",
        endpoint_url=CONFIG.r2_endpoint,
        aws_access_key_id=CONFIG.r2_access_key_id,
        aws_secret_access_key=CONFIG.r2_secret_access_key,
        region_name="auto",
    )


def upload_models(local_dir: Path, version: str | None = None) -> str:
    version = version or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M")
    prefix = f"forecast/models/{version}"
    s3 = _client()
    for name in MODEL_FILES:
        path = local_dir / name
        if not path.exists():
            raise SystemExit(f"missing model file {path}")
        s3.upload_file(str(path), CONFIG.r2_bucket, f"{prefix}/{name}")
    s3.put_object(Bucket=CONFIG.r2_bucket, Key="forecast/models/latest.txt", Body=prefix.encode())
    print(f"uploaded models -> r2://{CONFIG.r2_bucket}/{prefix}")
    return prefix


def download_models(local_dir: Path) -> str:
    s3 = _client()
    prefix = (
        s3.get_object(Bucket=CONFIG.r2_bucket, Key="forecast/models/latest.txt")["Body"]
        .read()
        .decode()
        .strip()
    )
    local_dir.mkdir(parents=True, exist_ok=True)
    for name in MODEL_FILES:
        s3.download_file(CONFIG.r2_bucket, f"{prefix}/{name}", str(local_dir / name))
    print(f"downloaded models {prefix} -> {local_dir}")
    return prefix
