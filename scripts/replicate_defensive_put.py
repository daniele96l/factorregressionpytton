from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from defensive_put.config import REGIONS, RegionConfig
from defensive_put.data import (
    align_and_normalize,
    export_replication_json,
    fetch_risk_free_rate,
    fetch_yfinance_series,
    load_official_index,
)
from defensive_put.engine import run_simulation
from defensive_put.metrics import (
    compute_metrics_bundle,
    rolling_correlation,
    rolling_tracking_error,
)


def build_region(cfg: RegionConfig, parquet_path: Path, out_dir: Path) -> None:
    print(f"Building {cfg.key} ({cfg.name})...")

    underlying = fetch_yfinance_series((cfg.underlying_ticker,))
    etf = None
    try:
        etf = fetch_yfinance_series(cfg.etf_tickers)
    except RuntimeError as e:
        print(f"  Warning: ETF download failed: {e}")

    official = load_official_index(cfg.index_isin, parquet_path)
    risk_free = fetch_risk_free_rate(cfg.key)

    replicated = run_simulation(cfg, underlying, risk_free)

    raw = {"replicated": replicated, "official": official}
    if etf is not None:
        raw["etf"] = etf

    etf_start = pd.Timestamp(cfg.etf_launch)
    aligned_etf = align_and_normalize(raw, start=etf_start)
    aligned_full = align_and_normalize(raw)

    use = aligned_etf if aligned_etf else aligned_full
    if not use:
        raise RuntimeError(f"No overlapping data for {cfg.key}")

    rep = use["replicated"]
    off = use["official"]
    etf_s = use.get("etf")

    rf_daily = float(risk_free.reindex(rep.index).ffill().iloc[-1] / 100 / 252) if not risk_free.empty else 0.0
    metrics = compute_metrics_bundle(rep, off, etf_s, rf_daily)

    te_series = rolling_tracking_error(rep, etf_s if etf_s is not None else off)
    corr_series = rolling_correlation(rep, etf_s if etf_s is not None else off)

    meta = {
        "indexIsin": cfg.index_isin,
        "etfIsin": cfg.etf_isin,
        "name": cfg.name,
        "etfLaunch": cfg.etf_launch.isoformat(),
        "portfolioStart": cfg.portfolio_start.isoformat(),
        "methodology": "Solactive Defensive Put Write v1.2 (BS proxy, realized vol)",
        "caveats": [
            "Euro parameters inferred from US guideline where Euro PDF unavailable.",
            "Option marks use Black-Scholes with realized vol; exchange quotes not used.",
            "ETF synthetic replication adds TER (~0.21%) and swap tracking frictions.",
        ],
    }

    out_path = out_dir / f"{cfg.key}.json"
    export_replication_json(
        cfg.key, use, te_series, corr_series, metrics, out_path, meta
    )
    print(f"  Wrote {out_path} ({len(use['replicated'])} points)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Replicate Solactive Defensive Put indices")
    parser.add_argument("--region", choices=["eur", "usd", "both"], default="both")
    parser.add_argument(
        "--parquet",
        type=Path,
        default=ROOT / "solactive.parquet",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "solactive-ui" / "public" / "replication",
    )
    args = parser.parse_args()

    regions = list(REGIONS.values()) if args.region == "both" else [REGIONS[args.region]]
    for cfg in regions:
        build_region(cfg, args.parquet, args.out)


if __name__ == "__main__":
    main()
