/**
 * Sanity-check replicated vs official index from parquet + cached market data.
 * Run: npm run verify-replication
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { REGION_CONFIG, resolveRegionConfig } from "../src/replicationConfig.js";
import { runSimulation } from "../src/replicationEngine.js";
import {
  alignRiskFreeToDates,
  alignVolToDates,
  ohlcToSeries,
  buildSettlementProxy,
} from "../src/marketData.js";
import { alignAndNormalize, computeMetricsBundle } from "../src/replicationMetrics.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const marketDir = join(__dir, "../public/market");
const parquetPath = join(__dir, "../../solactive.parquet");

function loadJson(name) {
  return JSON.parse(readFileSync(join(marketDir, name), "utf8"));
}

function loadRfFromCache(key) {
  const path = join(__dir, `../../defensive_put/cache/rf_${key}.csv`);
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const out = {};
    for (let i = 1; i < lines.length; i++) {
      const [date, val] = lines[i].split(",");
      const rate = parseFloat(val);
      if (date && Number.isFinite(rate)) out[date.slice(0, 10)] = rate;
    }
    if (Object.keys(out).length) return { ...out, _last: Object.values(out).at(-1) };
  } catch {
    /* fallback */
  }
  return { "2000-01-03": 2, _last: 2 };
}

async function loadOfficialSeries(isin) {
  const buf = readFileSync(parquetPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const file = { byteLength: ab.byteLength, slice: (s, e) => ab.slice(s, e) };
  const rows = await parquetReadObjects({ file, columns: ["date", isin], compressors });
  const points = [];
  const levels = {};
  for (const row of rows) {
    const v = row[isin];
    if (v == null || v === "" || !Number.isFinite(Number(v))) continue;
    const date = String(row.date).slice(0, 10);
    const level = Number(v);
    points.push({ date, level });
    levels[date] = level;
  }
  return { points, levels };
}

function loadUnderlying(ticker) {
  const base = ticker.replace(/[^a-z0-9]/gi, "_");
  const ohlc = loadJson(`${base}_ohlc.json`);
  const { close, open } = ohlcToSeries(ohlc);
  return { close, settlement: buildSettlementProxy(close, open) };
}

function loadVolIndex(tickers) {
  for (const sym of tickers) {
    try {
      const data = loadJson(`${sym.replace(/[^a-z0-9]/gi, "_")}.json`);
      if (Object.keys(data).length > 10) return data;
    } catch {
      /* next */
    }
  }
  return {};
}

async function verifyRegion(key) {
  const baseCfg = REGION_CONFIG[key];
  const underlying = loadUnderlying(baseCfg.underlyingTicker);
  const { points, levels: official } = await loadOfficialSeries(baseCfg.indexIsin);

  const uDates = Object.keys(underlying.close).sort();
  const cfg = resolveRegionConfig(baseCfg, points, uDates[0]);
  const rf = alignRiskFreeToDates(loadRfFromCache(key), uDates);
  const vol = alignVolToDates(loadVolIndex(baseCfg.volIndexTickers ?? []), uDates);
  const replicated = runSimulation(cfg, underlying.close, underlying.settlement, rf, vol);

  const aligned = alignAndNormalize({ replicated, official }, cfg.effectiveStart);
  if (!aligned?.dates?.length) throw new Error(`No overlap for ${key}`);

  const rep = Object.fromEntries(aligned.dates.map((d, i) => [d, aligned.replicated[i]]));
  const off = Object.fromEntries(aligned.dates.map((d, i) => [d, aligned.official[i]]));
  const m = computeMetricsBundle(rep, off);

  const repRange = [Math.min(...aligned.replicated), Math.max(...aligned.replicated)];
  const offRange = [Math.min(...aligned.official), Math.max(...aligned.official)];

  console.log(`\n=== ${key.toUpperCase()} ===`);
  console.log("inception:", cfg.inceptionCash, "start:", cfg.portfolioStart, "effective:", cfg.effectiveStart);
  console.log("points:", aligned.dates.length);
  console.log("rep range:", repRange.map((x) => x.toFixed(1)).join("–"));
  console.log("off range:", offRange.map((x) => x.toFixed(1)).join("–"));
  console.log(
    "ann return rep/off:",
    `${(m.replicated.annualizedReturn * 100).toFixed(2)}%`,
    `${(m.official.annualizedReturn * 100).toFixed(2)}%`,
  );
  console.log("sharpe rep/off:", m.replicated.sharpe.toFixed(2), m.official.sharpe.toFixed(2));
  console.log("maxDD rep/off:", `${(m.replicated.maxDrawdown * 100).toFixed(1)}%`, `${(m.official.maxDrawdown * 100).toFixed(1)}%`);
  console.log("level gap:", m.replication.levelGap.toFixed(2));
  console.log("correlation:", m.replication.correlation.toFixed(3));

  const corrOk = m.replication.correlation > 0.5;
  console.log("corr > 0.5:", corrOk);
  return { corrOk, finite: Number.isFinite(m.replication.correlation) };
}

let ok = true;
for (const key of ["usd", "eur"]) {
  const r = await verifyRegion(key);
  if (!r.finite) ok = false;
  if (!r.corrOk) console.warn(`  WARN: correlation below 0.5 for ${key}`);
}
process.exit(ok ? 0 : 1);
