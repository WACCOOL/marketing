"""Snapshot reconstruction: censoring and view semantics on synthetic deals."""

import numpy as np
import pandas as pd
import pytest

from wac_forecast.constants import DEAL_STAGE_IDS
from wac_forecast.snapshot import (
    attribute_company,
    deal_state_at,
    prepare_deals,
    prepare_turnover,
    to_ms,
    turnover_through,
    value_at,
)

MS = lambda s: pd.Timestamp(s, tz="UTC").value / 1e6  # noqa: E731

D = MS("2025-06-01")


def _deals():
    return pd.DataFrame(
        {
            "hs_object_id": ["1", "2", "3", "4", "5"],
            "sap_quote_number": ["q1", "q2", "q3", "q4", "q5"],
            "quote_creation_date": [
                "2025-01-10", "2025-02-01", "2025-03-01", "2025-04-01", "2025-07-01",
            ],
            "createdate": ["2025-01-10"] * 5,
            "closedate": [
                "2025-05-01",   # won before D
                "2026-01-15",   # SAP sweep-lost AFTER D (was open at D in hs view)
                None,            # open
                "2025-05-20",   # lost before D (hs view)
                "2025-08-01",
            ],
            "quote_conversion_date": ["2025-04-28", None, None, None, None],
            "dealstage": [
                DEAL_STAGE_IDS["closedWon"],
                DEAL_STAGE_IDS["closedLost"],
                DEAL_STAGE_IDS["bidding"],
                DEAL_STAGE_IDS["closedLost"],
                DEAL_STAGE_IDS["closedWon"],
            ],
            "amount": ["100", "0", "300", "50", "500"],
            "max_amount": ["100", "250", "300", "80", "500"],
        }
    )


def _lines():
    return pd.DataFrame(
        {
            "sap_quote_number": ["q1", "q2", "q2", "q3", "q3", "q4"],
            "quote_product_name": ["q1-10", "q2-10", "q2-20", "q3-10", "q3-20", "q4-10"],
            "rejection_date": [None, "2025-03-15", "2025-05-10", "2025-04-01", None, "2025-05-18"],
            "quote_conversion_date": ["2025-04-28", None, None, None, None, None],
            "net_value": ["100", "150", "100", "120", "180", "80"],
        }
    )


def _assocs():
    return pd.DataFrame(
        {
            "deal_id": ["1", "2", "2", "3", "4", "5", "5"],
            "company_id": ["c1", "c2", "c9", "c3", "c4", "c5", "c6"],
            "type_id": [5, 5, 3, 3, 5, 3, 3],
        }
    )


@pytest.fixture
def prepared():
    return prepare_deals(_deals(), _lines(), _assocs())


def test_attribution(prepared):
    d, _ = prepared
    got = d.set_index("hs_object_id")["company_id"]
    assert got["1"] == "c1"          # primary
    assert got["2"] == "c2"          # primary wins over the label assoc
    assert got["3"] == "c3"          # sole company, no primary
    assert pd.isna(got["5"])         # two companies, no primary → unattributable


def test_true_view_censoring(prepared):
    d, _ = prepared
    snap = deal_state_at(d, D, view="true").set_index("hs_object_id")
    assert "5" not in snap.index                     # created after D
    assert snap.loc["1", "status_at_d"] == "won"     # conversion before D
    # q2: both lines rejected by D (03-15, 05-10) → lost in the TRUE view
    assert snap.loc["2", "status_at_d"] == "lost"
    # q3: only one of two lines rejected → still open (never a loss by default)
    assert snap.loc["3", "status_at_d"] == "open"
    assert snap.loc["4", "status_at_d"] == "lost"


def test_hs_view_uses_closedate(prepared):
    d, _ = prepared
    snap = deal_state_at(d, D, view="hs").set_index("hs_object_id")
    # q2's sweep closedate is 2026 → a HubSpot query at D saw it OPEN
    assert snap.loc["2", "status_at_d"] == "open"
    assert snap.loc["4", "status_at_d"] == "lost"
    assert snap.loc["1", "status_at_d"] == "won"


def test_value_at_uses_unrejected_lines(prepared):
    d, li = prepared
    v = value_at(li, d, D).to_dict()
    idx = {r["hs_object_id"]: i for i, r in d.iterrows()}
    assert v[idx["q1"] if "q1" in idx else 0] == 100          # q1: single live line
    # q2 at D: line 10 rejected 03-15, line 20 rejected 05-10 → no live lines →
    # falls back to max_amount 250 (never the decayed amount 0)
    assert v[1] == 250
    # q3: line 10 rejected, line 20 alive → 180
    assert v[2] == 180
    # q4: sole line rejected by D → fallback max_amount 80
    assert v[3] == 80
    # q5: no lines at all → fallback max_amount 500
    assert v[4] == 500


def test_turnover_filtering():
    t = prepare_turnover(
        pd.DataFrame(
            {
                "billing_date": ["2025-01-15", "2025-07-02", "2025-03-01"],
                "quantity": [2, 3, 0],   # qty-0 = split-rep secondary row
                "discounted_sales": [100.0, 200.0, 100.0],
                "sold_to": ["0001234", "1234", "0009"],
            }
        )
    )
    got = turnover_through(t, D)
    assert got["sales_n"].sum() == 100.0            # post-D and qty-0 rows excluded
    assert set(t["account_key"]) == {"1234", "9"}   # leading zeros stripped


def test_to_ms_mixed_formats():
    s = pd.Series(["2025-06-01", "1748736000000", None, "2025-06-01T12:30:00Z"])
    got = to_ms(s)
    assert got[0] == MS("2025-06-01")
    assert got[1] == 1748736000000.0
    assert np.isnan(got[2])
    assert got[3] == MS("2025-06-01T12:30:00")
