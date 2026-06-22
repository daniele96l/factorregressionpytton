function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return sign * y;
}

function tauStd(days) {
  return Math.max(days, 0) / 252;
}

function tauCd(days) {
  return Math.max(days, 0) / 365;
}

export function forwardPrice(spot, rate, divYield, daysToExpiry) {
  return spot * Math.exp((rate - divYield) * tauCd(daysToExpiry));
}

export function bsPutPrice(spot, strike, daysToExpiry, rate, divYield, vol) {
  if (daysToExpiry <= 0) return Math.max(strike - spot, 0);
  if (vol <= 0 || spot <= 0 || strike <= 0) return Math.max(strike - spot, 0);

  const tStd = tauStd(daysToExpiry);
  const tCd = tauCd(daysToExpiry);
  const fwd = forwardPrice(spot, rate, divYield, daysToExpiry);
  const d1 = (Math.log(fwd / strike) + 0.5 * vol * vol * tStd) / (vol * Math.sqrt(tStd));
  const d2 = d1 - vol * Math.sqrt(tStd);
  return Math.exp(-rate * tCd) * (strike * normCdf(-d2) - fwd * normCdf(-d1));
}

export function bsVega(spot, strike, daysToExpiry, rate, divYield, vol) {
  if (daysToExpiry <= 0 || vol <= 0) return 0;
  const tStd = tauStd(daysToExpiry);
  const tCd = tauCd(daysToExpiry);
  const fwd = forwardPrice(spot, rate, divYield, daysToExpiry);
  const d1 = (Math.log(fwd / strike) + 0.5 * vol * vol * tStd) / (vol * Math.sqrt(tStd));
  return spot * Math.exp(-divYield * tCd) * normPdf(d1) * Math.sqrt(tStd);
}

export function optionSpread(spot, vol, vega, costFloor, vegaRatioMin, vegaRatioScale, ivBarrier) {
  const ratio = Math.max(vegaRatioMin, (vegaRatioScale * vol) / ivBarrier);
  return spot * Math.max(costFloor, (ratio * vega) / (100 * spot));
}

export function nearestStrike(target, interval) {
  if (interval <= 0) return target;
  const n = Math.round(target / interval);
  const lower = n * interval;
  const upper = (n + 1) * interval;
  return Math.abs(target - lower) <= Math.abs(upper - target) ? lower : upper;
}

export function realizedVol(returns, lookback) {
  if (!returns.length) return null;
  const window = returns.length >= lookback ? returns.slice(-lookback) : returns;
  if (window.length < 2) return null;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(window.length - 1, 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

export function clampIv(vol, ivMin, ivMax) {
  return Math.min(ivMax, Math.max(ivMin, vol));
}

/** Bisection implied vol; bounded per guideline (0.5% – 500%). */
export function solvePutIv(spot, strike, daysToExpiry, rate, divYield, targetPrice, ivMin, ivMax) {
  const intrinsic = Math.max(strike - spot, 0);
  if (targetPrice <= intrinsic + 1e-8) return ivMin;
  let lo = ivMin;
  let hi = ivMax;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPutPrice(spot, strike, daysToExpiry, rate, divYield, mid);
    if (p > targetPrice) hi = mid;
    else lo = mid;
  }
  return clampIv((lo + hi) / 2, ivMin, ivMax);
}
