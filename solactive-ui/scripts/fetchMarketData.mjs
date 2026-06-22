#!/usr/bin/env node
/**
 * Cache underlying OHLC + vol index series to public/market/ for offline use.
 * Run: npm run fetch-market
 */
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dir, "../public/market");

const UNDERLYINGS = ["^GSPC", "^STOXX50E"];
/** Try each symbol until one returns data (region-specific lists in replicationConfig). */
const VOL_SYMBOL_GROUPS = [
  ["^VIX"],
  ["^V2TX", "^VSTOXX"],
];

async function yahooOhlc(symbol) {
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=${period2}&interval=1d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${symbol}: ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const quote = r?.indicators?.quote?.[0] ?? {};
  const adj = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
  const opens = quote.open ?? [];
  const closes = quote.close ?? [];
  const fallbackCloses = closes.length ? closes : adj;
  const ohlc = {};
  const closeOnly = {};
  for (let i = 0; i < ts.length; i++) {
    const close = fallbackCloses[i];
    if (close == null || !Number.isFinite(close)) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    const open = opens[i];
    ohlc[date] = {
      open: open != null && Number.isFinite(open) ? open : close,
      close,
    };
    closeOnly[date] = close;
  }
  return { ohlc, closeOnly };
}

async function yahooClose(symbol) {
  const { closeOnly } = await yahooOhlc(symbol);
  return closeOnly;
}

mkdirSync(outDir, { recursive: true });

for (const sym of UNDERLYINGS) {
  try {
    const { ohlc, closeOnly } = await yahooOhlc(sym);
    const base = sym.replace(/[^a-z0-9]/gi, "_");
    writeFileSync(join(outDir, `${base}_ohlc.json`), JSON.stringify(ohlc));
    writeFileSync(join(outDir, `${base}.json`), JSON.stringify(closeOnly));
    console.log("wrote", base, Object.keys(ohlc).length, "OHLC points");
  } catch (e) {
    console.warn("skip", sym, e.message);
  }
}

for (const group of VOL_SYMBOL_GROUPS) {
  for (const sym of group) {
    try {
      const data = await yahooClose(sym);
      const file = join(outDir, `${sym.replace(/[^a-z0-9]/gi, "_")}.json`);
      writeFileSync(file, JSON.stringify(data));
      console.log("wrote", file, Object.keys(data).length, "points");
      break;
    } catch (e) {
      console.warn("skip", sym, e.message);
    }
  }
}
