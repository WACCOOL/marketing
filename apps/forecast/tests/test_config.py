from wac_forecast.config import Config
from wac_forecast.constants import DEAL_STAGE_IDS, UNIVERSAL_PIPELINE_ID


def test_stage_ids_shape():
    assert UNIVERSAL_PIPELINE_ID == "723098519"
    assert set(DEAL_STAGE_IDS) == {
        "prequal", "planning", "db", "bidding", "awarded", "closedWon", "closedLost",
    }


def test_config_defaults(monkeypatch):
    monkeypatch.delenv("FORECAST_WRITE", raising=False)
    assert Config().write_enabled is False
