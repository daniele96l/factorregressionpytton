/** Count scheduled trading days in (from, to] using an exchange calendar proxy. */
export function countTradingDays(fromStr, toStr, tradingDates) {
  if (!fromStr || !toStr || !tradingDates?.length) return 0;
  if (toStr <= fromStr) return 0;
  let n = 0;
  for (const d of tradingDates) {
    if (d > fromStr && d <= toStr) n++;
  }
  return n;
}
