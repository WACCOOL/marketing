"""Per-deal win-probability model: LightGBM binary classifier + isotonic
calibration on a held-out later time slice. EV = P(win) × value-at-D.

Training rows come from multiple monthly snapshots; the same deal appears at
several ages (that's intentional — the model learns P(win in next 180d | open
at age a)). Split is BY TIME (snapshot date), never random, to respect the
forecasting setting.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

from ..features.deal import ALL_FEATURES, CAT_FEATURES


def _prep(X: pd.DataFrame) -> pd.DataFrame:
    out = X[ALL_FEATURES].copy()
    for c in CAT_FEATURES:
        out[c] = out[c].astype("string").fillna("(missing)").astype("category")
    return out


@dataclass
class WinProbModel:
    booster: lgb.Booster
    calibrator: IsotonicRegression
    categories: dict[str, list[str]]
    meta: dict

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        P = _prep(X)
        for c in CAT_FEATURES:  # align category sets with training
            P[c] = P[c].cat.set_categories(self.categories[c])
        raw = self.booster.predict(P)
        return self.calibrator.predict(raw)

    def save(self, dir_: Path) -> None:
        dir_.mkdir(parents=True, exist_ok=True)
        self.booster.save_model(str(dir_ / "win_prob.txt"))
        iso = {
            "X": self.calibrator.X_thresholds_.tolist(),
            "y": self.calibrator.y_thresholds_.tolist(),
        }
        (dir_ / "win_prob_iso.json").write_text(json.dumps(iso))
        (dir_ / "win_prob_meta.json").write_text(
            json.dumps({**self.meta, "categories": self.categories})
        )

    @classmethod
    def load(cls, dir_: Path) -> "WinProbModel":
        booster = lgb.Booster(model_file=str(dir_ / "win_prob.txt"))
        iso_raw = json.loads((dir_ / "win_prob_iso.json").read_text())
        iso = IsotonicRegression(out_of_bounds="clip")
        iso.fit(iso_raw["X"], iso_raw["y"])
        meta = json.loads((dir_ / "win_prob_meta.json").read_text())
        cats = meta.pop("categories")
        return cls(booster, iso, cats, meta)


def train_win_prob(
    rows: pd.DataFrame,
    train_end: str,
    calib_end: str,
    params: dict | None = None,
) -> WinProbModel:
    """rows: labeled deal-feature rows with `snapshot` (YYYY-MM-DD), `label`,
    `labelable`. Train on snapshot ≤ train_end, calibrate on
    (train_end, calib_end]."""
    usable = rows[rows["labelable"]].copy()
    tr = usable[usable["snapshot"] <= train_end]
    ca = usable[(usable["snapshot"] > train_end) & (usable["snapshot"] <= calib_end)]
    if len(tr) == 0 or len(ca) == 0:
        raise ValueError(f"empty split: train={len(tr)} calib={len(ca)}")

    Xtr = _prep(tr)
    categories = {c: list(Xtr[c].cat.categories) for c in CAT_FEATURES}
    Xca = _prep(ca)
    for c in CAT_FEATURES:
        Xca[c] = Xca[c].cat.set_categories(categories[c])

    p = {
        "objective": "binary",
        "metric": "auc",
        "learning_rate": 0.05,
        "num_leaves": 63,
        "min_data_in_leaf": 100,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "verbosity": -1,
        "seed": 42,
        **(params or {}),
    }
    dtr = lgb.Dataset(Xtr, label=tr["label"], categorical_feature=CAT_FEATURES)
    dca = lgb.Dataset(Xca, label=ca["label"], reference=dtr)
    booster = lgb.train(
        p, dtr, num_boost_round=2000, valid_sets=[dca],
        callbacks=[lgb.early_stopping(100, verbose=False)],
    )

    raw_ca = booster.predict(Xca)
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(raw_ca, ca["label"].to_numpy())

    meta = {
        "train_end": train_end,
        "calib_end": calib_end,
        "n_train": int(len(tr)),
        "n_calib": int(len(ca)),
        "base_rate_train": float(tr["label"].mean()),
        "best_iteration": booster.best_iteration,
    }
    return WinProbModel(booster, iso, categories, meta)
