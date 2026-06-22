import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { REGION_CONFIG, resolveRegionConfig } from "../src/replicationConfig.js";
import { runSimulation } from "../src/replicationEngine.js";
import { alignRiskFreeToDates, alignVolToDates, ohlcToSeries, buildSettlementProxy } from "../src/marketData.js";
import { alignAndNormalize, computeMetricsBundle } from "../src/replicationMetrics.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const marketDir = join(__dir, "../public/market");
const loadJson = (n) => JSON.parse(readFileSync(join(marketDir, n), "utf8"));

async function official(isin) {
  const buf = readFileSync(join(__dir, "../../solactive.parquet"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const file = { byteLength: ab.byteLength, slice: (s, e) => ab.slice(s, e) };
  const rows = await parquetReadObjects({ file, columns: ["date", isin], compressors });
  return Object.fromEntries(rows.filter((r) => r[isin] != null).map((r) => [String(r.date).slice(0, 10), Number(r[isin])]));
}

function metrics(rep, off, start) {
  const a = alignAndNormalize({ replicated: rep, official: off }, start);
  const repL = Object.fromEntries(a.dates.map((d, i) => [d, a.replicated[i]]));
  const offL = Object.fromEntries(a.dates.map((d, i) => [d, a.official[i]]));
  const m = computeMetricsBundle(repL, offL);
  const sample = (d) => {
    const i = a.dates.indexOf(d);
    return i >= 0 ? a.replicated[i] / a.official[i] : null;
  };
  return {
    corr: m.replication.correlation,
    gap: m.replication.levelGap,
    ann: m.replicated.annualizedReturn,
    offAnn: m.official.annualizedReturn,
    r2007: sample("2007-10-01"),
    r2015: sample("2015-01-02"),
    r2024: sample("2024-01-02"),
  };
}

function rf() {
  const lines = readFileSync(join(__dir, "../../defensive_put/cache/rf_usd.csv"), "utf8").trim().split("\n");
  const out = { _last: 2 };
  for (let i = 1; i < lines.length; i++) { const [d, v] = lines[i].split(","); out[d.slice(0, 10)] = parseFloat(v); }
  return out;
}

const off = await official(REGION_CONFIG.usd.indexIsin);
const points = Object.entries(off).map(([date, level]) => ({ date, level }));
const ohlc = loadJson("_GSPC_ohlc.json");
const { close, open } = ohlcToSeries(ohlc);
const settlement = buildSettlementProxy(close, open);
const uDates = Object.keys(close).sort();
const cfg0 = resolveRegionConfig(REGION_CONFIG.usd, points, uDates[0]);
const rfA = alignRiskFreeToDates(rf(), uDates);
const vix = alignVolToDates(loadJson("_VIX.json"), uDates);

const variants = [
  { name: "realized lb21", roll: "realized", mark: "realized" },
  { name: "realized lb42", roll: "realized", mark: "realized", lb: 42 },
  { name: "realized lb63", roll: "realized", mark: "realized", lb: 63 },
  { name: "lb42 mark mid", roll: "realized", mark: "realized", lb: 42, markAtMid: true },
  { name: "lb42 lb mark 35", roll: "realized", mark: "realized", lb: 42, markLb: 35 },
];

console.log("=== US tuning ===");
for (const v of variants) {
  const cfg = {
    ...cfg0,
    volRollPolicy: v.roll,
    volMarkPolicy: v.mark,
    ...(v.lb ? { volLookback: v.lb } : {}),
    ...(v.markLb ? { volMarkLookback: v.markLb } : {}),
    ...(v.markAtMid ? { markAtMid: true } : {}),
  };
  const rep = runSimulation(cfg, close, settlement, rfA, vix);
  const s = metrics(rep, off, cfg0.effectiveStart);
  console.log(
    v.name.padEnd(28),
    `corr ${s.corr.toFixed(3)}`,
    `gap ${s.gap.toFixed(0)}`,
    `ann ${(s.ann * 100).toFixed(2)}`,
    `07 ${s.r2007?.toFixed(3)}`,
    `15 ${s.r2015?.toFixed(3)}`,
    `24 ${s.r2024?.toFixed(3)}`,
  );
}
