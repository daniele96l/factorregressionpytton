from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import pandas as pd

from defensive_put.black_scholes import (
    bs_put_price,
    bs_vega,
    nearest_strike,
    option_spread,
    realized_vol,
)
from defensive_put.config import RegionConfig


@dataclass
class LivePut:
    expiry: date
    strike: float
    units: float


def _friday_or_prior(d: date) -> date:
    while d.weekday() != 4:
        d -= timedelta(days=1)
    return d


def _target_expiry(roll_day: date, weeks: int) -> date:
    return _friday_or_prior(roll_day + timedelta(weeks=weeks))


def _listed_fridays(start: date, end: date) -> list[date]:
    out: list[date] = []
    d = _friday_or_prior(start)
    while d <= end:
        out.append(d)
        d += timedelta(weeks=1)
    return out


def _pick_expiries(roll_day: date, weeks: int) -> tuple[date, date | None, float, float]:
    target = _target_expiry(roll_day, weeks)
    fridays = _listed_fridays(roll_day + timedelta(days=1), target + timedelta(weeks=8))
    if not fridays:
        return target, None, 1.0, 0.0

    on_or_after = [f for f in fridays if f >= target]
    if on_or_after:
        near = on_or_after[0]
        if near == target:
            return near, None, 1.0, 0.0
        before = [f for f in fridays if f < target]
        if not before:
            return near, None, 1.0, 0.0
        far = near
        near = before[-1]
        tau_near = (near - roll_day).days
        tau_far = (far - roll_day).days
        tau_tgt = (target - roll_day).days
        w_far = (tau_tgt - tau_near) / max(tau_far - tau_near, 1)
        return near, far, 1.0 - w_far, w_far

    return fridays[-1], None, 1.0, 0.0


def _fee_rate(cfg: RegionConfig, d: date) -> float:
    return cfg.fee_rate_post_amend if d >= cfg.amendment_date else cfg.fee_rate_pre_amend


def _mark_puts(puts: list[LivePut], d: date, spot: float, rate: float, vol: float) -> float:
    total = 0.0
    for p in puts:
        days = max((p.expiry - d).days, 0)
        px = bs_put_price(spot, p.strike, days, rate, 0.0, vol)
        total += p.units * px
    return total


def run_simulation(
    cfg: RegionConfig,
    underlying: pd.Series,
    risk_free: pd.Series,
) -> pd.Series:
    u = underlying.dropna().sort_index()
    rf = risk_free.reindex(u.index).ffill().bfill().fillna(2.0) / 100.0

    cash = cfg.initial_cash
    puts: list[LivePut] = []
    ip_levels: list[float] = []
    out_dates: list[date] = []
    daily_rets: list[float] = []
    ip_prev = 0.0
    ip_inception = 0.0

    for i, (ts, spot) in enumerate(u.items()):
        d = pd.Timestamp(ts).date()
        if d < cfg.portfolio_start:
            continue

        rate = float(rf.iloc[i])
        vol = realized_vol(np.array(daily_rets), cfg.vol_lookback) if len(daily_rets) >= 2 else 0.20

        still_live: list[LivePut] = []
        for p in puts:
            if p.expiry == d:
                cash += p.units * max(p.strike - spot, 0.0)
            else:
                still_live.append(p)
        puts = still_live

        opt_mtm = _mark_puts(puts, d, spot, rate, vol)
        ip_before_roll = cash + opt_mtm

        if d.weekday() == 4:
            near, far, w_near, w_far = _pick_expiries(d, cfg.target_maturity_weeks)
            legs = [(near, w_near)]
            if far is not None:
                legs.append((far, w_far))

            for expiry, weight in legs:
                strike = nearest_strike(cfg.target_strike_pct * spot, cfg.strike_interval)
                days = max((expiry - d).days, 1)
                px = bs_put_price(spot, strike, days, rate, 0.0, vol)
                vega = bs_vega(spot, strike, days, rate, 0.0, vol)
                spread = option_spread(
                    spot, vol, vega,
                    cfg.option_cost_floor, cfg.vega_ratio_min,
                    cfg.vega_ratio_scale, cfg.iv_barrier,
                )
                premium = px - spread
                if premium / spot < cfg.premium_floor:
                    continue
                ref_ip = ip_before_roll if ip_before_roll > 0 else cash
                units = cfg.allocation * weight * ref_ip / spot
                cash -= units * premium
                puts.append(LivePut(expiry=expiry, strike=strike, units=units))

            opt_mtm = _mark_puts(puts, d, spot, rate, vol)

        if ip_prev > 0:
            cash += cash * rate / 365.0
            cash -= ip_prev * _fee_rate(cfg, d) / 365.0
            opt_mtm = _mark_puts(puts, d, spot, rate, vol)

        ip = cash + opt_mtm
        if ip_inception == 0:
            ip_inception = ip
        if ip_prev > 0:
            daily_rets.append(ip / ip_prev - 1.0)

        out_dates.append(d)
        ip_levels.append(100.0 * ip / ip_inception)
        ip_prev = ip

    if not out_dates:
        return pd.Series(dtype=float)
    return pd.Series(ip_levels, index=pd.to_datetime(out_dates), name="replicated")
