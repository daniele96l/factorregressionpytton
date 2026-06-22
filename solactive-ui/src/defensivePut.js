export const DEFENSIVE_PUT_ISINS = [
  {
    isin: "DE000SL0AS77",
    name: "Euro Equity Defensive Put Write",
    etf: "IE00BLDGHT92",
    etfTickers: ["E50PW.SW"],
  },
  {
    isin: "DE000SL0AS51",
    name: "US Equity Defensive Put Write",
    etf: "IE00BLDGHF56",
    etfTickers: ["SPXPW.SW"],
  },
];

const defensiveSet = new Set(DEFENSIVE_PUT_ISINS.map((x) => x.isin));

export function getDefensivePutMeta(isin) {
  return DEFENSIVE_PUT_ISINS.find((x) => x.isin === isin);
}

export function sortIsinsWithPriority(allIsins) {
  const priority = DEFENSIVE_PUT_ISINS.map((x) => x.isin).filter((isin) => allIsins.includes(isin));
  const rest = allIsins.filter((isin) => !defensiveSet.has(isin));
  return [...priority, ...rest];
}

export function pickDefaultIsin(allIsins) {
  for (const item of DEFENSIVE_PUT_ISINS) {
    if (allIsins.includes(item.isin)) return item.isin;
  }
  return allIsins[0] ?? "";
}

export function formatIsinLabel(isin) {
  const meta = getDefensivePutMeta(isin);
  if (meta) return `${isin} — ${meta.name}`;
  return isin;
}
