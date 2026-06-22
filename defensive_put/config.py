from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class RegionConfig:
    key: str
    name: str
    index_isin: str
    etf_isin: str
    etf_tickers: tuple[str, ...]
    underlying_ticker: str
    strike_interval: float
    target_strike_pct: float
    target_maturity_weeks: int
    allocation: float
    initial_cash: float
    portfolio_start: date
    etf_launch: date
    fee_rate_pre_amend: float
    fee_rate_post_amend: float
    amendment_date: date
    option_cost_floor: float
    vega_ratio_min: float
    vega_ratio_scale: float
    iv_barrier: float
    premium_floor: float
    forward_tolerance: float
    vol_lookback: int = 21


EUR_CONFIG = RegionConfig(
    key="eur",
    name="Euro Equity Defensive Put Write",
    index_isin="DE000SL0AS77",
    etf_isin="IE00BLDGHT92",
    etf_tickers=("E50PW.SW", "UIQ4.DE"),
    underlying_ticker="^STOXX50E",
    strike_interval=50.0,
    target_strike_pct=0.97,
    target_maturity_weeks=4,
    allocation=-0.25,
    initial_cash=101.109582606393,
    portfolio_start=date(2002, 12, 30),
    etf_launch=date(2020, 7, 8),
    fee_rate_pre_amend=0.0027,
    fee_rate_post_amend=0.0022,
    amendment_date=date(2025, 6, 19),
    option_cost_floor=0.00025,
    vega_ratio_min=0.6,
    vega_ratio_scale=0.6,
    iv_barrier=0.16,
    premium_floor=0.0,
    forward_tolerance=0.05,
)

USD_CONFIG = RegionConfig(
    key="usd",
    name="US Equity Defensive Put Write",
    index_isin="DE000SL0AS51",
    etf_isin="IE00BLDGHF56",
    etf_tickers=("SPXPW.SW", "SPXPW.S"),
    underlying_ticker="^GSPC",
    strike_interval=5.0,
    target_strike_pct=0.97,
    target_maturity_weeks=4,
    allocation=-0.25,
    initial_cash=101.109582606393,
    portfolio_start=date(2019, 1, 18),
    etf_launch=date(2020, 7, 8),
    fee_rate_pre_amend=0.0027,
    fee_rate_post_amend=0.0022,
    amendment_date=date(2025, 6, 19),
    option_cost_floor=0.00025,
    vega_ratio_min=0.6,
    vega_ratio_scale=0.6,
    iv_barrier=0.16,
    premium_floor=0.0,
    forward_tolerance=0.05,
)

REGIONS = {"eur": EUR_CONFIG, "usd": USD_CONFIG}
