import { loadParquetBuffer, readIsinSeries } from "./parquet";
import { REGION_CONFIG, REPLICATION_CAVEATS, resolveRegionConfig } from "./replicationConfig";
import { runSimulation } from "./replicationEngine";
import {
  alignRiskFreeToDates,
  alignVolToDates,
  fetchPriceSeries,
  fetchRiskFreeSeries,
  fetchUnderlyingBundle,
} from "./marketData";
import {
  alignAndNormalize,
  computeMetricsBundle,
  rollingCorrelation,
  rollingTrackingError,
} from "./replicationMetrics";

const CACHE = new Map();

function seriesToMap(points, valueKey = "index") {
  const out = {};
  for (const p of points) out[p.date] = p[valueKey];
  return out;
}

async function loadVolIndex(tickers = []) {
  for (const sym of tickers) {
    try {
      const series = await fetchPriceSeries(sym);
      if (Object.keys(series).length > 10) return series;
    } catch {
      /* try next ticker */
    }
  }
  return {};
}

export async function loadReplicationData(region) {
  const key = region.toLowerCase();
  CACHE.delete(key);

  const baseCfg = REGION_CONFIG[key];
  if (!baseCfg) throw new Error(`Unknown region: ${region}`);

  const [underlying, rfRaw, parquet] = await Promise.all([
    fetchUnderlyingBundle(baseCfg.underlyingTicker),
    fetchRiskFreeSeries(baseCfg.fredId),
    loadParquetBuffer("/solactive.parquet"),
  ]);

  const volIndex = await loadVolIndex(baseCfg.volIndexTickers ?? []);

  const officialPoints = await readIsinSeries(parquet.file, baseCfg.indexIsin);
  const official = seriesToMap(officialPoints, "level");

  const uDates = Object.keys(underlying.close).sort();
  const firstUnderlying = uDates[0];
  if (!firstUnderlying) throw new Error("No underlying price data");

  const cfg = resolveRegionConfig(baseCfg, officialPoints, firstUnderlying);
  const rf = alignRiskFreeToDates(rfRaw, uDates);
  const vol = alignVolToDates(volIndex, uDates);
  const replicated = runSimulation(
    cfg,
    underlying.close,
    underlying.settlement,
    rf,
    vol,
  );

  const aligned = alignAndNormalize(
    { replicated, official },
    cfg.effectiveStart,
  );
  if (!aligned?.dates?.length) throw new Error("No overlapping replicated vs official data");

  const repLevels = Object.fromEntries(
    aligned.dates.map((d, i) => [d, aligned.replicated[i]]),
  );
  const offLevels = Object.fromEntries(
    aligned.dates.map((d, i) => [d, aligned.official[i]]),
  );

  const teRoll = rollingTrackingError(repLevels, offLevels);
  const corrRoll = rollingCorrelation(repLevels, offLevels);
  const metrics = computeMetricsBundle(repLevels, offLevels);

  const points = aligned.dates.map((date, i) => ({
    date,
    ts: new Date(date).getTime(),
    replicated: aligned.replicated[i],
    official: aligned.official[i],
    gap: aligned.replicated[i] - aligned.official[i],
    rollingTe: teRoll[date] ?? 0,
    rollingCorr: corrRoll[date] ?? 0,
  }));

  const payload = {
    region: key,
    meta: {
      indexIsin: cfg.indexIsin,
      name: cfg.name,
      portfolioStart: cfg.portfolioStart,
      inceptionCash: cfg.inceptionCash,
      effectiveStart: cfg.effectiveStart,
      methodology: "Solactive Defensive Put Write v1.2",
      caveats: REPLICATION_CAVEATS,
    },
    dates: aligned.dates,
    metrics,
    points,
  };

  CACHE.set(key, payload);
  return payload;
}
