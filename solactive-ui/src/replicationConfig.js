/** Solactive Defensive Put Write v1.2 — shared guideline parameters. */
export const GUIDELINE = {
  targetStrikePct: 0.97,
  targetMaturityCalendarDays: 28,
  allocation: -0.25,
  nearExpiryMinCalendarDays: 7,
  feeRatePreAmend: 0.0027,
  feeRatePostAmend: 0.0022,
  amendmentDate: "2025-06-19",
  optionCostFloor: 0.00025,
  vegaRatioMin: 0.6,
  vegaRatioScale: 0.6,
  ivBarrier: 0.16,
  premiumFloor: 0,
  volLookback: 21,
  ivMin: 0.005,
  ivMax: 5.0,
};

export const REGION_CONFIG = {
  eur: {
    key: "eur",
    name: "Euro Equity Defensive Put Write",
    indexIsin: "DE000SL0AS77",
    underlyingTicker: "^STOXX50E",
    volIndexTickers: ["^V2TX", "^VSTOXX"],
    fredId: "IR3TIB01EZM156N",
    strikeInterval: 50,
    volRollPolicy: "realized",
    volMarkPolicy: "realized",
    ...GUIDELINE,
  },
  usd: {
    key: "usd",
    name: "US Equity Defensive Put Write",
    indexIsin: "DE000SL0AS51",
    underlyingTicker: "^GSPC",
    volIndexTickers: ["^VIX"],
    fredId: "DTB3",
    strikeInterval: 5,
    volRollPolicy: "realized",
    volMarkPolicy: "realized",
    ...GUIDELINE,
    volLookback: 63,
  },
};

export const REPLICATION_CAVEATS = [
  "Underlying closes use Yahoo price index (unadjusted), not total-return adjusted.",
  "Strike and expiry settlement use Yahoo open as SPXSET proxy (not official SPXSET).",
  "Option marks: Black-Scholes ask-side (mid + spread) with entry IV and parallel index-vol surface shift.",
  "Friday rolls price new puts at opening settlement (SPXSET proxy), marks at daily close.",
  "Expiries settle on the first trading day on or after the scheduled Friday (holiday adjustment).",
  "Euro parameters inferred from US Solactive guideline v1.2.",
  "Index inception level and start date taken from solactive.parquet.",
  "Roll and mark vol use realized underlying vol (not VIX/V2TX) for BS premium and marking — 63-day US, 21-day EUR.",
  "No historical CBOE/Eurex option settlement prices — replication is approximate.",
];

/** Merge parquet-derived inception with static region params. */
export function resolveRegionConfig(baseCfg, officialPoints, firstUnderlyingDate) {
  const sorted = [...officialPoints]
    .filter((p) => p.level != null && Number.isFinite(p.level))
    .sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0];
  if (!first) throw new Error(`No official levels for ${baseCfg.indexIsin}`);

  const portfolioStart = first.date;
  const inceptionCash = first.level;
  const effectiveStart = [portfolioStart, firstUnderlyingDate].sort().at(-1);

  return {
    ...baseCfg,
    portfolioStart,
    inceptionCash,
    effectiveStart,
  };
}
