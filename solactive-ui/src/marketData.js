const YAHOO_SYMBOL = {
  "^GSPC": "^GSPC",
  "^STOXX50E": "^STOXX50E",
  "^VIX": "^VIX",
  "^V2TX": "^V2TX",
};

function cacheBase(symbol) {
  const ysym = YAHOO_SYMBOL[symbol] ?? symbol;
  return ysym.replace(/[^a-z0-9]/gi, "_");
}

function parseYahooOhlc(result) {
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const opens = quote.open ?? [];
  const closes = quote.close ?? [];
  const fallbackCloses = closes.length ? closes : adj;
  const ohlc = {};
  const close = {};
  for (let i = 0; i < timestamps.length; i++) {
    const c = fallbackCloses[i];
    if (c == null || !Number.isFinite(c)) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    const o = opens[i];
    ohlc[date] = { open: o != null && Number.isFinite(o) ? o : c, close: c };
    close[date] = c;
  }
  return { ohlc, close };
}

async function fetchYahooChart(symbol) {
  const period2 = Math.floor(Date.now() / 1000);
  const ysym = YAHOO_SYMBOL[symbol] ?? symbol;
  const cacheName = `/market/${cacheBase(symbol)}.json`;

  try {
    const cached = await fetch(cacheName);
    if (cached.ok) {
      const data = await cached.json();
      if (Object.keys(data).length > 10) return data;
    }
  } catch {
    /* live fetch below */
  }

  const url = `/api/yahoo/v8/finance/chart/${encodeURIComponent(ysym)}?period1=0&period2=${period2}&interval=1d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo chart failed for ${symbol} (${res.status})`);
  const text = await res.text();
  if (text.startsWith("Edge:") || text.startsWith("<!")) {
    throw new Error(`Yahoo unavailable for ${symbol}`);
  }
  const json = JSON.parse(text);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${symbol}`);

  const { close } = parseYahooOhlc(result);
  return close;
}

async function fetchYahooOhlc(symbol) {
  const base = cacheBase(symbol);
  const ohlcCache = `/market/${base}_ohlc.json`;

  try {
    const cached = await fetch(ohlcCache);
    if (cached.ok) {
      const data = await cached.json();
      if (Object.keys(data).length > 10) return data;
    }
  } catch {
    /* live fetch below */
  }

  const period2 = Math.floor(Date.now() / 1000);
  const ysym = YAHOO_SYMBOL[symbol] ?? symbol;
  const url = `/api/yahoo/v8/finance/chart/${encodeURIComponent(ysym)}?period1=0&period2=${period2}&interval=1d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo OHLC failed for ${symbol} (${res.status})`);
  const text = await res.text();
  if (text.startsWith("Edge:") || text.startsWith("<!")) {
    throw new Error(`Yahoo unavailable for ${symbol}`);
  }
  const json = JSON.parse(text);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${symbol}`);
  return parseYahooOhlc(result).ohlc;
}

export function ohlcToSeries(ohlc) {
  const close = {};
  const open = {};
  for (const [date, row] of Object.entries(ohlc)) {
    close[date] = row.close;
    open[date] = row.open ?? row.close;
  }
  return { close, open };
}

/** SPXSET proxy: open when available, else prior close. */
export function buildSettlementProxy(close, open) {
  const dates = Object.keys(close).sort();
  const settlement = {};
  let prevClose = null;
  for (const d of dates) {
    const c = close[d];
    if (!Number.isFinite(c)) continue;
    const o = open?.[d];
    settlement[d] = Number.isFinite(o) ? o : (prevClose ?? c);
    prevClose = c;
  }
  return settlement;
}

export async function fetchUnderlyingBundle(ticker) {
  const ohlc = await fetchYahooOhlc(ticker);
  const { close, open } = ohlcToSeries(ohlc);
  const settlement = buildSettlementProxy(close, open);
  return { close, open, settlement };
}

export async function fetchPriceSeries(tickers) {
  const list = Array.isArray(tickers) ? tickers : [tickers];
  let lastErr;
  for (const symbol of list) {
    try {
      const series = await fetchYahooChart(symbol);
      if (Object.keys(series).length > 10) return series;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`Could not fetch prices for ${list.join(", ")}`);
}

export async function fetchRiskFreeSeries(fredId) {
  try {
    const url = `/api/fred/graph/fredgraph.csv?id=${encodeURIComponent(fredId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FRED fetch failed (${res.status})`);
    const text = await res.text();
    const lines = text.trim().split("\n");
    const out = {};
    for (let i = 1; i < lines.length; i++) {
      const [date, val] = lines[i].split(",");
      const rate = parseFloat(val);
      if (date && Number.isFinite(rate)) out[date] = rate;
    }
    if (Object.keys(out).length) return fillBusinessDays(out);
  } catch {
    /* fallback below */
  }
  return fillBusinessDays({ "2000-01-03": 2 });
}

function fillBusinessDays(series) {
  const dates = Object.keys(series).sort();
  if (!dates.length) return { _last: 2 };
  const out = { ...series };
  let last = series[dates[0]];
  const start = new Date(dates[0]);
  const end = new Date(dates[dates.length - 1]);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const key = d.toISOString().slice(0, 10);
    if (out[key] != null) last = out[key];
    else out[key] = last;
  }
  out._last = last;
  return out;
}

export function alignVolToDates(volSeries, dateKeys) {
  if (!volSeries || !Object.keys(volSeries).length) return {};
  const sorted = Object.keys(volSeries).sort();
  let last = null;
  let j = 0;
  const out = {};
  for (const d of dateKeys) {
    while (j < sorted.length && sorted[j] <= d) {
      last = volSeries[sorted[j]];
      j++;
    }
    if (last != null) out[d] = last;
  }
  return out;
}

export function alignRiskFreeToDates(rfSeries, dateKeys) {
  const sortedRfDates = Object.keys(rfSeries)
    .filter((k) => k !== "_last")
    .sort();
  let last = rfSeries._last ?? 2;
  const out = {};
  let j = 0;
  for (const d of dateKeys) {
    while (j < sortedRfDates.length && sortedRfDates[j] <= d) {
      last = rfSeries[sortedRfDates[j]];
      j++;
    }
    out[d] = last;
  }
  return out;
}
