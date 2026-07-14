"""Backtest metrics: total-level, company-level, deal-level."""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import brier_score_loss, roc_auc_score


def signed_pct_error(forecast: float, actual: float) -> float | None:
    return (forecast - actual) / actual * 100 if actual else None


def company_metrics(forecast: pd.Series, actual: pd.Series, top_n: int = 200) -> dict:
    """Align on the union of companies (missing = 0)."""
    idx = forecast.index.union(actual.index)
    f = forecast.reindex(idx).fillna(0.0)
    a = actual.reindex(idx).fillna(0.0)
    err = (f - a).abs()
    wape = float(err.sum() / a.sum() * 100) if a.sum() else None
    top = a.sort_values(ascending=False).head(top_n).index
    mape_top = float(((f[top] - a[top]).abs() / a[top]).replace([np.inf], np.nan).dropna().mean() * 100)
    both = pd.DataFrame({"f": f, "a": a})
    both = both[(both["f"] > 0) | (both["a"] > 0)]
    spearman = float(both["f"].rank().corr(both["a"].rank())) if len(both) > 2 else None
    return {"wape": wape, f"mape_top{top_n}": mape_top, "spearman": spearman, "n": int(len(both))}


def decile_table(forecast: pd.Series, actual: pd.Series) -> pd.DataFrame:
    idx = forecast.index.union(actual.index)
    f = forecast.reindex(idx).fillna(0.0)
    a = actual.reindex(idx).fillna(0.0)
    df = pd.DataFrame({"f": f, "a": a}).sort_values("f", ascending=False)
    df["decile"] = pd.qcut(df["f"].rank(method="first", ascending=False), 10, labels=range(1, 11))
    return df.groupby("decile", observed=True).agg(
        forecast=("f", "sum"), actual=("a", "sum"), n=("f", "size")
    ).assign(ratio=lambda x: x["forecast"] / x["actual"].replace(0, np.nan))


def deal_metrics(p: np.ndarray, y: np.ndarray) -> dict:
    if len(np.unique(y)) < 2:
        return {"auc": None, "brier": None, "base_rate": float(np.mean(y)), "n": int(len(y))}
    return {
        "auc": float(roc_auc_score(y, p)),
        "brier": float(brier_score_loss(y, p)),
        "base_rate": float(np.mean(y)),
        "avg_p": float(np.mean(p)),
        "n": int(len(y)),
    }


def reliability_table(p: np.ndarray, y: np.ndarray, bins: int = 10) -> pd.DataFrame:
    df = pd.DataFrame({"p": p, "y": y})
    df["bin"] = pd.cut(df["p"], np.linspace(0, 1, bins + 1), include_lowest=True)
    return df.groupby("bin", observed=True).agg(
        predicted=("p", "mean"), observed=("y", "mean"), n=("y", "size")
    )
