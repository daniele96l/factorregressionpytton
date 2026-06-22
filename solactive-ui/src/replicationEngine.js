import {
  bsPutPrice,
  bsVega,
  clampIv,
  nearestStrike,
  optionSpread,
  realizedVol,
  solvePutIv,
} from "./blackScholes";
import { countTradingDays } from "./tradingCalendar";

function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function fridayOrPrior(d) {
  const x = new Date(d);
  while (x.getDay() !== 5) x.setDate(x.getDate() - 1);
  return x;
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function calendarDaysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

function targetExpiry(rollDay, calendarDays) {
  const t = new Date(rollDay);
  t.setDate(t.getDate() + calendarDays);
  return toDateStr(fridayOrPrior(t));
}

function listedFridayStrs(start, end) {
  const out = [];
  let d = fridayOrPrior(new Date(start));
  const endD = new Date(end);
  while (d <= endD) {
    out.push(toDateStr(d));
    d = new Date(d);
    d.setDate(d.getDate() + 7);
  }
  return out;
}

function pickExpiries(rollDayStr, calendarDays, nearMinDays, tradingDates) {
  const rollDay = parseDate(rollDayStr);
  const targetStr = targetExpiry(rollDay, calendarDays);
  const end = new Date(targetStr);
  end.setDate(end.getDate() + calendarDays);
  const start = new Date(rollDay);
  start.setDate(start.getDate() + 1);
  const fridays = listedFridayStrs(start, end);
  if (!fridays.length) return { near: targetStr, far: null, wNear: 1, wFar: 0 };

  const onOrAfter = fridays.filter((f) => f >= targetStr);
  if (onOrAfter.length) {
    const farStr = onOrAfter[0];
    if (farStr === targetStr) return { near: farStr, far: null, wNear: 1, wFar: 0 };
    const before = fridays.filter((f) => f < targetStr);
    if (!before.length) return { near: farStr, far: null, wNear: 1, wFar: 0 };

    const nearStr = before[before.length - 1];
    const ned = nearStr;
    const fed = farStr;
    const ted = targetStr;

    const denom = countTradingDays(rollDayStr, ned, tradingDates)
      - countTradingDays(rollDayStr, fed, tradingDates);
    if (denom <= 0) return { near: farStr, far: null, wNear: 1, wFar: 0 };

    const wNear = (countTradingDays(rollDayStr, ted, tradingDates)
      - countTradingDays(rollDayStr, fed, tradingDates)) / denom;
    const wFar = (countTradingDays(rollDayStr, ned, tradingDates)
      - countTradingDays(rollDayStr, ted, tradingDates)) / denom;

    if (calendarDaysBetween(rollDayStr, nearStr) < nearMinDays) {
      return { near: nearStr, far: farStr, wNear: 0, wFar: 1 };
    }

    return { near: nearStr, far: farStr, wNear, wFar };
  }
  return { near: fridays[fridays.length - 1], far: null, wNear: 1, wFar: 0 };
}

function feeRate(cfg, dateStr) {
  return dateStr >= cfg.amendmentDate ? cfg.feeRatePostAmend : cfg.feeRatePreAmend;
}

function daysBetweenStr(a, b) {
  return Math.max(calendarDaysBetween(a, b), 0);
}

/** First trading day on or after scheduled expiry (holiday Fridays miss exact date match). */
function snapExpiryToTradingDay(expiryStr, tradingDates) {
  const hit = tradingDates.find((d) => d >= expiryStr);
  return hit ?? expiryStr;
}

function putMarkVol(p, currentVol, cfg) {
  const indexVolAtEntry = p.indexVolAtEntry ?? p.vol;
  return clampIv(p.vol + (currentVol - indexVolAtEntry), cfg.ivMin, cfg.ivMax);
}

function markPutPrice(spot, p, dateStr, rate, markVol, cfg) {
  const days = daysBetweenStr(dateStr, p.expiry);
  const intrinsic = Math.max(p.strike - spot, 0);
  if (days <= 0) return intrinsic;
  const mid = bsPutPrice(spot, p.strike, days, rate, 0, markVol);
  const vega = bsVega(spot, p.strike, days, rate, 0, markVol);
  const spread = optionSpread(
    spot, markVol, vega,
    cfg.optionCostFloor, cfg.vegaRatioMin, cfg.vegaRatioScale, cfg.ivBarrier,
  );
  // Short puts: BS fallback marks at ask (mid + spread) when exchange quotes unavailable.
  if (cfg.markAtMid) return Math.max(intrinsic, mid);
  return Math.max(intrinsic, mid + spread);
}

function markPuts(puts, dateStr, spot, rate, currentVol, cfg) {
  let total = 0;
  for (const p of puts) {
    const mv = putMarkVol(p, currentVol, cfg);
    total += p.units * markPutPrice(spot, p, dateStr, rate, mv, cfg);
  }
  return total;
}

function volForDay(cfg, dateStr, volIndex, underlyingRets, purpose = "default") {
  const indexIv = volIndex?.[dateStr];
  const fromIndex = indexIv != null && indexIv > 0 ? indexIv / 100 : null;
  const fromRealized = realizedVol(
    underlyingRets,
    purpose === "mark" && cfg.volMarkLookback
      ? cfg.volMarkLookback
      : cfg.volLookback,
  );
  const policy = purpose === "roll"
    ? (cfg.volRollPolicy ?? cfg.volPolicy ?? "index")
    : (cfg.volMarkPolicy ?? cfg.volPolicy ?? "index");

  let vol;
  if (policy === "realized") {
    vol = fromRealized ?? fromIndex ?? cfg.ivMin;
  } else if (policy === "blendIndexRealized") {
    if (fromIndex != null && fromRealized != null) vol = 0.5 * (fromIndex + fromRealized);
    else vol = fromIndex ?? fromRealized ?? cfg.ivMin;
  } else if (policy === "maxIndexRealized") {
    if (fromIndex != null && fromRealized != null) vol = Math.max(fromIndex, fromRealized);
    else vol = fromIndex ?? fromRealized ?? cfg.ivMin;
  } else if (policy === "minIndexRealized") {
    if (fromIndex != null && fromRealized != null) vol = Math.min(fromIndex, fromRealized);
    else vol = fromIndex ?? fromRealized ?? cfg.ivMin;
  } else {
    vol = fromIndex ?? fromRealized ?? cfg.ivMin;
  }
  return clampIv(vol, cfg.ivMin, cfg.ivMax);
}

export function runSimulation(
  cfg,
  underlyingClose,
  underlyingSettlement,
  riskFreeSeries,
  volIndexSeries = {},
) {
  const tradingDates = Object.keys(underlyingClose).sort();
  let cash = cfg.inceptionCash;
  let puts = [];
  const out = {};
  const underlyingRets = [];
  let ipPrev = 0;
  let ipInception = 0;
  let prevClose = null;
  let prevSettle = null;
  let prevRate = (riskFreeSeries[tradingDates[0]] ?? riskFreeSeries._last ?? 2) / 100;

  for (const dateStr of tradingDates) {
    if (dateStr < cfg.portfolioStart) continue;

    const spot = underlyingClose[dateStr];
    if (!Number.isFinite(spot)) continue;

    const settle = underlyingSettlement[dateStr] ?? spot;

    if (prevClose != null && prevClose > 0) {
      underlyingRets.push(spot / prevClose - 1);
    }

    const rate = (riskFreeSeries[dateStr] ?? riskFreeSeries._last ?? 2) / 100;
    const vol = volForDay(cfg, dateStr, volIndexSeries, underlyingRets, "mark");

    const stillLive = [];
    for (const p of puts) {
      if (dateStr >= p.expiry) {
        cash += p.units * Math.max(p.strike - settle, 0);
      } else {
        stillLive.push(p);
      }
    }
    puts = stillLive;

    if (ipPrev > 0) {
      cash *= 1 + prevRate / 365;
      cash -= (ipPrev * feeRate(cfg, dateStr)) / 365;
    }

    let optMtm = markPuts(puts, dateStr, spot, rate, vol, cfg);
    const rollDay = parseDate(dateStr).getDay() === 5;

    if (rollDay && ipPrev > 0 && prevClose > 0) {
      const { near, far, wNear, wFar } = pickExpiries(
        dateStr,
        cfg.targetMaturityCalendarDays,
        cfg.nearExpiryMinCalendarDays,
        tradingDates,
      );
      const legs = [];
      if (wNear > 0) legs.push({ expiry: near, weight: wNear });
      if (far && wFar > 0) legs.push({ expiry: far, weight: wFar });
      if (!legs.length && near) legs.push({ expiry: near, weight: 1 });

      const strikeRef = prevSettle ?? settle;
      const rollSpot = settle;
      const rollVol = volForDay(cfg, dateStr, volIndexSeries, underlyingRets, "roll");
      for (const { expiry, weight } of legs) {
        if (weight <= 0) continue;
        const expiryTrading = snapExpiryToTradingDay(expiry, tradingDates);
        const strike = nearestStrike(cfg.targetStrikePct * strikeRef, cfg.strikeInterval);
        const days = Math.max(daysBetweenStr(dateStr, expiryTrading), 1);
        const px = bsPutPrice(rollSpot, strike, days, rate, 0, rollVol);
        const vega = bsVega(rollSpot, strike, days, rate, 0, rollVol);
        const spread = optionSpread(
          rollSpot, rollVol, vega,
          cfg.optionCostFloor, cfg.vegaRatioMin, cfg.vegaRatioScale, cfg.ivBarrier,
        );
        const premium = px - spread;
        if (premium / rollSpot < cfg.premiumFloor) continue;
        const units = cfg.allocation * weight * ipPrev / prevClose;
        const entryVol = solvePutIv(rollSpot, strike, days, rate, 0, px, cfg.ivMin, cfg.ivMax);
        cash -= units * premium;
        puts.push({
          expiry: expiryTrading,
          strike,
          units,
          vol: entryVol,
          indexVolAtEntry: rollVol,
        });
      }
      optMtm = markPuts(puts, dateStr, spot, rate, vol, cfg);
    }

    const ip = cash + optMtm;
    if (ipInception === 0) ipInception = ip;
    out[dateStr] = 100 * (ip / ipInception);
    ipPrev = ip;
    prevClose = spot;
    prevSettle = settle;
    prevRate = rate;
  }

  return out;
}
