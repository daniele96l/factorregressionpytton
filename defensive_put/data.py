from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / "defensive_put" / "cache"
PARQUET_PATH = ROOT / "solactive.parquet"


def _cache_path(name: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / name


def fetch_yfinance_series(tickers: tuple[str, ...], column: str = "Close") -> pd.Series:
    import yfinance as yf

    for ticker in tickers:
        try:
            df = yf.download(ticker, period="max", auto_adjust=True, progress=False)
            if df.empty:
                continue
            if isinstance(df.columns, pd.MultiIndex):
                if column in df.columns.get_level_values(0):
                    s = df[column].iloc[:, 0]
                else:
                    s = df.iloc[:, 0]
            else:
                s = df[column] if column in df.columns else df.iloc[:, 0]
            s = s.squeeze().dropna()
            if isinstance(s, (int, float)):
                continue
            s.index = pd.to_datetime(s.index).tz_localize(None)
            if len(s) > 10:
                return s.sort_index()
        except Exception:
            continue
    raise RuntimeError(f"Could not download price data for {tickers}")


def fetch_risk_free_rate(region: str) -> pd.Series:
    cache = _cache_path(f"rf_{region}.csv")
    if cache.exists():
        df = pd.read_csv(cache, index_col=0, parse_dates=True)
        col = "rate" if "rate" in df.columns else df.columns[0]
        return df[col].sort_index()

    import io
    import urllib.request

    fred_id = "DTB3" if region == "usd" else "IR3TIB01EZM156N"
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={fred_id}"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
        df = pd.read_csv(io.StringIO(raw), parse_dates=["DATE"], index_col="DATE")
        col = df.columns[0]
        s = pd.to_numeric(df[col], errors="coerce").dropna()
        s.index = pd.to_datetime(s.index).tz_localize(None)
        s = s.sort_index().resample("B").ffill()
        out = pd.DataFrame({"rate": s})
        out.to_csv(cache)
        return out["rate"]
    except Exception:
        pass

    import yfinance as yf

    ticker = "^IRX"
    df = yf.download(ticker, period="max", auto_adjust=True, progress=False)
    if df.empty:
        idx = pd.date_range("2000-01-01", periods=5000, freq="B")
        s = pd.Series(2.0, index=idx)
    else:
        col = "Close" if "Close" in df.columns else df.columns[0]
        s = df[col].squeeze()
        if isinstance(s, (int, float)):
            idx = pd.date_range("2000-01-01", periods=5000, freq="B")
            s = pd.Series(float(s), index=idx)
        else:
            s = s.dropna()
            s.index = pd.to_datetime(s.index).tz_localize(None)
    out = pd.DataFrame({"rate": s})
    out.to_csv(cache)
    return out["rate"].sort_index()


def load_official_index(isin: str, parquet_path: Path | None = None) -> pd.Series:
    path = parquet_path or PARQUET_PATH
    if not path.exists():
        raise FileNotFoundError(f"Parquet not found: {path}")

    table = pq.read_table(path, columns=["date", isin])
    df = table.to_pandas()
    df["date"] = pd.to_datetime(df["date"])
    s = df.set_index("date")[isin].dropna()
    s.index = s.index.tz_localize(None)
    return s.sort_index()


def align_and_normalize(
    series: dict[str, pd.Series],
    start: pd.Timestamp | None = None,
) -> dict[str, pd.Series]:
    frames = {k: v.dropna() for k, v in series.items() if v is not None and not v.dropna().empty}
    if not frames:
        return {}

    combined = pd.concat(frames, axis=1, join="inner").dropna()
    if combined.empty:
        combined = pd.concat(frames, axis=1, join="outer").ffill().dropna(how="all")
    if start is not None:
        combined = combined[combined.index >= start]
    if combined.empty:
        return {}

    first_idx = combined.index[0]
    out: dict[str, pd.Series] = {}
    for col in combined.columns:
        base = float(combined.loc[first_idx, col])
        if base and base != 0:
            out[col] = 100.0 * combined[col] / base
    return out


def export_replication_json(
    region_key: str,
    aligned: dict[str, pd.Series],
    rolling_te: pd.Series,
    rolling_corr: pd.Series,
    metrics: dict,
    output_path: Path,
    meta: dict,
) -> None:
    idx = next(iter(aligned.values())).index if aligned else pd.DatetimeIndex([])
    payload = {
        "region": region_key,
        "meta": meta,
        "dates": [d.strftime("%Y-%m-%d") for d in idx],
        "replicated": aligned.get("replicated", pd.Series()).tolist(),
        "official": aligned.get("official", pd.Series()).tolist(),
        "etf": aligned.get("etf", pd.Series()).tolist() if "etf" in aligned else [],
        "rollingTe": rolling_te.reindex(idx).fillna(0).tolist(),
        "rollingCorr": rolling_corr.reindex(idx).fillna(0).tolist(),
        "metrics": metrics,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
