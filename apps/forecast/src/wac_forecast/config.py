"""Env + path configuration.

Variable NAMES match the Node apps and the GitHub Actions secrets so the
scheduled job needs zero new secrets. Locally, `apps/forecast/.env` wins;
if it doesn't exist we fall back to `apps/api/.dev.vars` (dotenv format),
which already carries HUBSPOT_TOKEN / SUPABASE_* / R2_* for dev.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

APP_DIR = Path(__file__).resolve().parents[2]  # apps/forecast
REPO_ROOT = APP_DIR.parents[1]


def _load_env() -> None:
    local = APP_DIR / ".env"
    if local.exists():
        load_dotenv(local)
    # Fallback for local dev: the API worker's dev vars (never present in CI).
    dev_vars = REPO_ROOT / "apps" / "api" / ".dev.vars"
    if dev_vars.exists():
        load_dotenv(dev_vars)  # does not override vars already set


_load_env()


def _dir(env_name: str, default: Path) -> Path:
    p = Path(os.environ.get(env_name, "") or default)
    p.mkdir(parents=True, exist_ok=True)
    return p


@dataclass(frozen=True)
class Config:
    hubspot_token: str = field(default_factory=lambda: os.environ.get("HUBSPOT_TOKEN", ""))
    supabase_url: str = field(default_factory=lambda: os.environ.get("SUPABASE_URL", ""))
    supabase_service_role_key: str = field(
        default_factory=lambda: os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    )
    r2_endpoint: str = field(default_factory=lambda: os.environ.get("R2_ENDPOINT", ""))
    r2_access_key_id: str = field(default_factory=lambda: os.environ.get("R2_ACCESS_KEY_ID", ""))
    r2_secret_access_key: str = field(
        default_factory=lambda: os.environ.get("R2_SECRET_ACCESS_KEY", "")
    )
    r2_bucket: str = field(
        default_factory=lambda: os.environ.get("R2_BUCKET", "wac-marketing-assets")
    )
    write_enabled: bool = field(
        default_factory=lambda: os.environ.get("FORECAST_WRITE", "0") == "1"
    )

    @property
    def data_dir(self) -> Path:
        return _dir("WAC_FORECAST_DATA_DIR", APP_DIR / "data")

    @property
    def raw_dir(self) -> Path:
        p = self.data_dir / "raw"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def artifacts_dir(self) -> Path:
        return _dir("WAC_FORECAST_ARTIFACTS_DIR", APP_DIR / "artifacts")

    def require(self, *names: str) -> None:
        missing = [n for n in names if not getattr(self, n)]
        if missing:
            raise SystemExit(
                f"missing required env vars: {', '.join(missing)} "
                f"(set them in apps/forecast/.env — see .env.example)"
            )


CONFIG = Config()
