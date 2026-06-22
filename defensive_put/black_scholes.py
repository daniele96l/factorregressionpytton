import math

import numpy as np


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _tau_std(days: float) -> float:
    return max(days, 0) / 252.0


def _tau_cd(days: float) -> float:
    return max(days, 0) / 365.0


def forward_price(spot: float, rate: float, div_yield: float, days_to_expiry: float) -> float:
    t = _tau_cd(days_to_expiry)
    return spot * math.exp((rate - div_yield) * t)


def bs_put_price(
    spot: float,
    strike: float,
    days_to_expiry: float,
    rate: float,
    div_yield: float,
    vol: float,
) -> float:
    if days_to_expiry <= 0:
        return max(strike - spot, 0.0)
    if vol <= 0 or spot <= 0 or strike <= 0:
        return max(strike - spot, 0.0)

    t_std = _tau_std(days_to_expiry)
    t_cd = _tau_cd(days_to_expiry)
    fwd = forward_price(spot, rate, div_yield, days_to_expiry)
    sigma = vol
    d1 = (math.log(fwd / strike) + 0.5 * sigma**2 * t_std) / (sigma * math.sqrt(t_std))
    d2 = d1 - sigma * math.sqrt(t_std)
    return math.exp(-rate * t_cd) * (strike * _norm_cdf(-d2) - fwd * _norm_cdf(-d1))


def bs_vega(
    spot: float,
    strike: float,
    days_to_expiry: float,
    rate: float,
    div_yield: float,
    vol: float,
) -> float:
    if days_to_expiry <= 0 or vol <= 0:
        return 0.0
    t_std = _tau_std(days_to_expiry)
    t_cd = _tau_cd(days_to_expiry)
    fwd = forward_price(spot, rate, div_yield, days_to_expiry)
    d1 = (math.log(fwd / strike) + 0.5 * vol**2 * t_std) / (vol * math.sqrt(t_std))
    return spot * math.exp(-div_yield * t_cd) * _norm_pdf(d1) * math.sqrt(t_std)


def option_spread(
    spot: float,
    vol: float,
    vega: float,
    cost_floor: float,
    vega_ratio_min: float,
    vega_ratio_scale: float,
    iv_barrier: float,
) -> float:
    ratio = max(vega_ratio_min, vega_ratio_scale * vol / iv_barrier)
    return spot * max(cost_floor, ratio * vega / 100.0)


def nearest_strike(target: float, interval: float) -> float:
    if interval <= 0:
        return target
    n = round(target / interval)
    lower = n * interval
    upper = (n + 1) * interval
    if abs(target - lower) <= abs(upper - target):
        return lower
    return upper


def realized_vol(returns: np.ndarray, lookback: int) -> float:
    if len(returns) < 2:
        return 0.20
    window = returns[-lookback:] if len(returns) >= lookback else returns
    vol = float(np.std(window, ddof=1)) * math.sqrt(252)
    return float(np.clip(vol, 0.05, 0.80))
