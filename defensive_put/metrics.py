import math
from typing import Any

import numpy as np
import pandas as pd


def daily_returns(levels: pd.Series) -> pd.Series:
    return levels.pct_change().dropna()


def annualized_return(levels: pd.Series) -> float:
    r = daily_returns(levels)
    if r.empty:
        return 0.0
    total = float((1 + r).prod())
    years = len(r) / 252.0
    if years <= 0 or total <= 0:
        return 0.0
    return total ** (1 / years) - 1


def sharpe_ratio(levels: pd.Series, rf_daily: float = 0.0) -> float:
    r = daily_returns(levels)
    if len(r) < 2:
        return 0.0
    excess = r - rf_daily
    std = float(excess.std(ddof=1))
    if std == 0:
        return 0.0
    return float(excess.mean() / std * math.sqrt(252))


def max_drawdown(levels: pd.Series) -> float:
    if levels.empty:
        return 0.0
    peak = levels.cummax()
    dd = (peak - levels) / peak
    return float(dd.max())


def tracking_error(levels_a: pd.Series, levels_b: pd.Series) -> float:
    ra = daily_returns(levels_a)
    rb = daily_returns(levels_b)
    aligned = pd.concat([ra, rb], axis=1, join="inner").dropna()
    if len(aligned) < 2:
        return 0.0
    diff = aligned.iloc[:, 0] - aligned.iloc[:, 1]
    return float(diff.std(ddof=1) * math.sqrt(252))


def rolling_tracking_error(
    levels_a: pd.Series, levels_b: pd.Series, window: int = 63
) -> pd.Series:
    ra = daily_returns(levels_a)
    rb = daily_returns(levels_b)
    aligned = pd.concat([ra, rb], axis=1, join="inner").dropna()
    if aligned.empty:
        return pd.Series(dtype=float)
    diff = aligned.iloc[:, 0] - aligned.iloc[:, 1]
    return diff.rolling(window).std(ddof=1) * math.sqrt(252)


def rolling_correlation(
    levels_a: pd.Series, levels_b: pd.Series, window: int = 63
) -> pd.Series:
    ra = daily_returns(levels_a)
    rb = daily_returns(levels_b)
    aligned = pd.concat([ra, rb], axis=1, join="inner").dropna()
    if aligned.empty:
        return pd.Series(dtype=float)
    return aligned.iloc[:, 0].rolling(window).corr(aligned.iloc[:, 1])


def compute_metrics_bundle(
    replicated: pd.Series,
    official: pd.Series,
    etf: pd.Series | None,
    rf_daily: float = 0.0,
) -> dict[str, Any]:
    def row(name: str, s: pd.Series) -> dict[str, float]:
        return {
            "annualizedReturn": annualized_return(s),
            "sharpe": sharpe_ratio(s, rf_daily),
            "maxDrawdown": max_drawdown(s),
        }

    out: dict[str, Any] = {
        "replicated": row("replicated", replicated),
        "official": row("official", official),
    }
    if etf is not None and not etf.dropna().empty:
        out["etf"] = row("etf", etf)
        out["trackingError"] = {
            "replicatedVsEtf": tracking_error(replicated, etf),
            "officialVsEtf": tracking_error(official, etf),
            "replicatedVsOfficial": tracking_error(replicated, official),
        }
    else:
        out["trackingError"] = {
            "replicatedVsOfficial": tracking_error(replicated, official),
        }
    return out
