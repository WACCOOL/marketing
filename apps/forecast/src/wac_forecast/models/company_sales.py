"""Company-level annual-sales model: LightGBM Tweedie on remaining-year sales
at the parent-rolled grain. Forecast(full year) = YTD-at-D + prediction.

Same time-split discipline as win_prob: rows keyed by snapshot date, split by
time. Tweedie handles the zero-inflated, right-skewed remaining-sales target.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from ..features.company import ALL_FEATURES, CAT_FEATURES


def _prep(X: pd.DataFrame) -> pd.DataFrame:
    out = X[ALL_FEATURES].copy()
    for c in CAT_FEATURES:
        out[c] = out[c].astype("string").fillna("(missing)").astype("category")
    return out


@dataclass
class CompanySalesModel:
    booster: lgb.Booster
    categories: dict[str, list[str]]
    meta: dict

    def predict_remaining(self, X: pd.DataFrame) -> np.ndarray:
        P = _prep(X)
        for c in CAT_FEATURES:
            P[c] = P[c].cat.set_categories(self.categories[c])
        return np.clip(self.booster.predict(P), 0, None)

    def save(self, dir_: Path) -> None:
        dir_.mkdir(parents=True, exist_ok=True)
        self.booster.save_model(str(dir_ / "company_sales.txt"))
        (dir_ / "company_sales_meta.json").write_text(
            json.dumps({**self.meta, "categories": self.categories})
        )

    @classmethod
    def load(cls, dir_: Path) -> "CompanySalesModel":
        booster = lgb.Booster(model_file=str(dir_ / "company_sales.txt"))
        meta = json.loads((dir_ / "company_sales_meta.json").read_text())
        cats = meta.pop("categories")
        return cls(booster, cats, meta)


def train_company_sales(
    rows: pd.DataFrame,
    train_end: str,
    valid_end: str,
    params: dict | None = None,
) -> CompanySalesModel:
    """rows: company-feature rows with `snapshot` and `target_remaining`.
    Only snapshots whose full-year actual is COMPLETE may be used (the caller
    filters — e.g. 2025 snapshots once 2025 closed; 2026 snapshots are
    score-only until 2027)."""
    tr = rows[rows["snapshot"] <= train_end]
    va = rows[(rows["snapshot"] > train_end) & (rows["snapshot"] <= valid_end)]
    if len(tr) == 0 or len(va) == 0:
        raise ValueError(f"empty split: train={len(tr)} valid={len(va)}")

    Xtr = _prep(tr)
    categories = {c: list(Xtr[c].cat.categories) for c in CAT_FEATURES}
    Xva = _prep(va)
    for c in CAT_FEATURES:
        Xva[c] = Xva[c].cat.set_categories(categories[c])

    p = {
        "objective": "tweedie",
        "tweedie_variance_power": 1.3,
        "metric": "mae",
        "learning_rate": 0.05,
        "num_leaves": 63,
        "min_data_in_leaf": 50,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "verbosity": -1,
        "seed": 42,
        **(params or {}),
    }
    dtr = lgb.Dataset(Xtr, label=tr["target_remaining"], categorical_feature=CAT_FEATURES)
    dva = lgb.Dataset(Xva, label=va["target_remaining"], reference=dtr)
    booster = lgb.train(
        p, dtr, num_boost_round=3000, valid_sets=[dva],
        callbacks=[lgb.early_stopping(150, verbose=False)],
    )
    meta = {
        "train_end": train_end,
        "valid_end": valid_end,
        "n_train": int(len(tr)),
        "n_valid": int(len(va)),
        "best_iteration": booster.best_iteration,
    }
    return CompanySalesModel(booster, categories, meta)
