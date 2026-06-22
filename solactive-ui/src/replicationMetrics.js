function dailyReturns(levels) {
  const dates = Object.keys(levels).sort();
  const rets = {};
  for (let i = 1; i < dates.length; i++) {
    const prev = levels[dates[i - 1]];
    const cur = levels[dates[i]];
    if (prev > 0) rets[dates[i]] = cur / prev - 1;
  }
  return rets;
}

function levelsFromNormalized(dates, values) {
  const out = {};
  dates.forEach((d, i) => {
    if (values[i] != null && Number.isFinite(values[i])) out[d] = values[i];
  });
  return out;
}

export function annualizedReturn(levels) {
  const dates = Object.keys(levels).sort();
  if (dates.length < 2) return 0;
  const rets = dailyReturns(levels);
  const r = Object.values(rets);
  const total = r.reduce((p, x) => p * (1 + x), 1);
  const years = r.length / 252;
  return years > 0 && total > 0 ? total ** (1 / years) - 1 : 0;
}

export function sharpeRatio(levels, rfDaily = 0) {
  const rets = Object.values(dailyReturns(levels));
  if (rets.length < 2) return 0;
  const excess = rets.map((r) => r - rfDaily);
  const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const variance = excess.reduce((s, r) => s + (r - mean) ** 2, 0) / (excess.length - 1);
  const std = Math.sqrt(variance);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252);
}

export function maxDrawdown(levels) {
  const dates = Object.keys(levels).sort();
  let peak = -Infinity;
  let maxDd = 0;
  for (const d of dates) {
    const v = levels[d];
    peak = Math.max(peak, v);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak);
  }
  return maxDd;
}

export function trackingError(levelsA, levelsB) {
  const ra = dailyReturns(levelsA);
  const rb = dailyReturns(levelsB);
  const dates = Object.keys(ra).filter((d) => rb[d] != null);
  if (dates.length < 2) return 0;
  const diff = dates.map((d) => ra[d] - rb[d]);
  const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
  const variance = diff.reduce((s, x) => s + (x - mean) ** 2, 0) / (diff.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

export function rollingTrackingError(levelsA, levelsB, window = 63) {
  const ra = dailyReturns(levelsA);
  const rb = dailyReturns(levelsB);
  const dates = Object.keys(ra).filter((d) => rb[d] != null).sort();
  const out = {};
  for (let i = 0; i < dates.length; i++) {
    const slice = dates.slice(Math.max(0, i - window + 1), i + 1);
    if (slice.length < 2) {
      out[dates[i]] = 0;
      continue;
    }
    const diff = slice.map((d) => ra[d] - rb[d]);
    const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
    const variance = diff.reduce((s, x) => s + (x - mean) ** 2, 0) / (diff.length - 1);
    out[dates[i]] = Math.sqrt(variance) * Math.sqrt(252);
  }
  return out;
}

export function rollingCorrelation(levelsA, levelsB, window = 63) {
  const ra = dailyReturns(levelsA);
  const rb = dailyReturns(levelsB);
  const dates = Object.keys(ra).filter((d) => rb[d] != null).sort();
  const out = {};
  for (let i = 0; i < dates.length; i++) {
    const slice = dates.slice(Math.max(0, i - window + 1), i + 1);
    if (slice.length < 2) {
      out[dates[i]] = 0;
      continue;
    }
    const xs = slice.map((d) => ra[d]);
    const ys = slice.map((d) => rb[d]);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let j = 0; j < xs.length; j++) {
      const a = xs[j] - mx;
      const b = ys[j] - my;
      num += a * b;
      dx += a * a;
      dy += b * b;
    }
    const den = Math.sqrt(dx * dy);
    out[dates[i]] = den === 0 ? 0 : num / den;
  }
  return out;
}

export function fullSampleCorrelation(levelsA, levelsB) {
  const ra = dailyReturns(levelsA);
  const rb = dailyReturns(levelsB);
  const dates = Object.keys(ra).filter((d) => rb[d] != null).sort();
  if (dates.length < 2) return 0;
  const xs = dates.map((d) => ra[d]);
  const ys = dates.map((d) => rb[d]);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

export function computeMetricsBundle(replicated, official, rfDaily = 0) {
  const row = (s) => ({
    annualizedReturn: annualizedReturn(s),
    sharpe: sharpeRatio(s, rfDaily),
    maxDrawdown: maxDrawdown(s),
  });

  const rep = row(replicated);
  const off = row(official);
  const te = trackingError(replicated, official);
  const dates = Object.keys(replicated).sort();
  const lastDate = dates[dates.length - 1];
  const fullCorr = fullSampleCorrelation(replicated, official);

  return {
    replicated: rep,
    official: off,
    replication: {
      trackingError: te,
      correlation: fullCorr,
      levelGap: (replicated[lastDate] ?? 0) - (official[lastDate] ?? 0),
    },
  };
}

export function alignAndNormalize(seriesMap, startDate) {
  const keys = Object.keys(seriesMap).filter((k) => seriesMap[k]);
  const allDates = new Set();
  for (const k of keys) {
    Object.keys(seriesMap[k]).forEach((d) => allDates.add(d));
  }
  let dates = [...allDates].sort();
  if (startDate) dates = dates.filter((d) => d >= startDate);

  dates = dates.filter((d) => keys.every((k) => seriesMap[k][d] != null));
  if (!dates.length) return null;

  const base = {};
  for (const k of keys) base[k] = seriesMap[k][dates[0]];

  const normalized = { dates: [] };
  for (const k of keys) normalized[k] = [];

  for (const d of dates) {
    normalized.dates.push(d);
    for (const k of keys) {
      normalized[k].push((100 * seriesMap[k][d]) / base[k]);
    }
  }

  return normalized;
}

export function pct(x, digits = 2) {
  if (x == null || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function num(x, digits = 2) {
  if (x == null || Number.isNaN(x)) return "—";
  return Number(x).toFixed(digits);
}

export function formatMetricValue(metric, value) {
  if (value == null || Number.isNaN(value)) return "—";
  if (metric === "Sharpe") return num(value);
  return pct(value);
}

export function metricRows(metrics) {
  if (!metrics) return [];
  const labels = {
    annualizedReturn: "Ann. return",
    sharpe: "Sharpe",
    maxDrawdown: "Max drawdown",
  };
  const rows = [];
  for (const [key, label] of Object.entries(labels)) {
    rows.push({
      metric: label,
      replicated: metrics.replicated?.[key],
      official: metrics.official?.[key],
    });
  }
  if (metrics.replication) {
    rows.push({
      metric: "Tracking error (ann.)",
      replicated: metrics.replication.trackingError,
      official: "—",
      replicationOnly: true,
    });
    rows.push({
      metric: "Correlation (full sample)",
      replicated: metrics.replication.correlation,
      official: "—",
      isCorrelation: true,
      replicationOnly: true,
    });
    rows.push({
      metric: "Level gap (index pts)",
      replicated: metrics.replication.levelGap,
      official: "—",
      isGap: true,
      replicationOnly: true,
    });
  }
  return rows;
}

export { levelsFromNormalized };
