import { readFileSync } from "fs";
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

const ohlc = JSON.parse(readFileSync("./public/market/_GSPC_ohlc.json", "utf8"));
const { close, open } = ohlcToSeries(ohlc);
const settlement = buildSettlementProxy(close, open);
const vol = alignVolToDates(JSON.parse(readFileSync("./public/market/_VIX.json", "utf8")), Object.keys(close).sort());
const rf = alignRiskFreeToDates({ "2000-01-03": 2, _last: 2 }, Object.keys(close).sort());

const buf = readFileSync("../solactive.parquet");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const file = { byteLength: ab.byteLength, slice: (s, e) => ab.slice(s, e) };
const isin = "DE000SL0AS51";
const rows = await parquetReadObjects({ file, columns: ["date", isin], compressors });
const points = rows.filter((r) => r[isin] != null).map((r) => ({
  date: String(r.date).slice(0, 10),
  level: Number(r[isin]),
}));
const cfg = resolveRegionConfig(REGION_CONFIG.usd, points, Object.keys(close).sort()[0]);
const rep = runSimulation(cfg, close, settlement, rf, vol);

const samples = ["2007-10-01", "2008-09-15", "2009-03-09", "2015-01-02", "2020-03-23", "2024-01-02"];
const off = Object.fromEntries(points.map((p) => [p.date, p.level]));
const baseOff = off[cfg.portfolioStart];
const baseRep = rep[cfg.portfolioStart] ?? 100;

console.log("portfolioStart", cfg.portfolioStart, "inceptionCash", cfg.inceptionCash);
for (const d of samples) {
  const o = off[d];
  const r = rep[d];
  if (o == null || r == null) continue;
  const oNorm = (o / baseOff) * 100;
  console.log(d, { officialNorm: oNorm.toFixed(1), repNorm: r.toFixed(1), offRaw: o.toFixed(2) });
}
